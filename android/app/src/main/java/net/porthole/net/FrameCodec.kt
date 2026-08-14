package net.porthole.net

import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction

/**
 * Decodes the panel's binary terminal frames: `[ordinal, ...utf8 bytes]`.
 *
 * The ordinal is a small per-connection number assigned when a session is attached,
 * which keeps a 36 character session uuid off every chunk of a hot stream.
 *
 * The subtle part is the payload. The server chunks on byte boundaries with no regard
 * for character boundaries, so a three byte box-drawing character routinely arrives
 * split across two frames. Decoding each frame on its own would emit replacement
 * characters straight through Claude's interface, so an incomplete tail is held back
 * until the bytes that finish it turn up. State is per ordinal, because two sessions
 * interleave on one socket.
 */
class FrameCodec {

    data class Decoded(val ordinal: Int, val text: String)

    private val pending = HashMap<Int, ByteArray>()

    fun decode(frame: ByteArray): Decoded? {
        if (frame.isEmpty()) return null

        // Byte is signed in Kotlin, so ordinals above 127 need masking.
        val ordinal = frame[0].toInt() and 0xFF
        val payload = frame.copyOfRange(1, frame.size)

        val carried = pending[ordinal] ?: ByteArray(0)
        val combined = if (carried.isEmpty()) payload else carried + payload

        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPLACE)
            .onUnmappableCharacter(CodingErrorAction.REPLACE)

        val input = ByteBuffer.wrap(combined)
        val output = CharBuffer.allocate(combined.size + 1)

        // endOfInput = false, so a truncated sequence underflows and stays in the buffer
        // rather than being replaced with U+FFFD.
        decoder.decode(input, output, false)
        output.flip()

        pending[ordinal] = if (input.hasRemaining()) {
            ByteArray(input.remaining()).also { input.get(it) }
        } else {
            ByteArray(0)
        }

        return Decoded(ordinal, output.toString())
    }

    /** Drop any half-finished character for an ordinal that is being reattached. */
    fun forget(ordinal: Int) {
        pending.remove(ordinal)
    }

    fun forgetAll() {
        pending.clear()
    }
}
