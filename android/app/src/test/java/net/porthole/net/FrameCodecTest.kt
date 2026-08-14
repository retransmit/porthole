package net.porthole.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Terminal output arrives as `[ordinal, ...utf8 bytes]`. The server chunks on byte
 * boundaries with no regard for character boundaries, so a multi-byte character can and
 * does land half in one frame and half in the next. Decoding each frame independently
 * would render replacement characters through Claude's box drawing.
 */
class FrameCodecTest {

    private fun frame(ordinal: Int, text: String): ByteArray =
        byteArrayOf(ordinal.toByte()) + text.toByteArray(Charsets.UTF_8)

    @Test
    fun `decodes a plain ascii frame`() {
        val out = FrameCodec().decode(frame(0, "hello"))
        assertEquals(0, out?.ordinal)
        assertEquals("hello", out?.text)
    }

    @Test
    fun `decodes a multi-byte character that fits in one frame`() {
        val out = FrameCodec().decode(frame(0, "╭─── Claude"))
        assertEquals("╭─── Claude", out?.text)
    }

    @Test
    fun `reassembles a multi-byte character split across two frames`() {
        val codec = FrameCodec()
        // U+256D is three bytes in UTF-8. Cut it after the first byte.
        val bytes = "╭ok".toByteArray(Charsets.UTF_8)
        val first = byteArrayOf(0) + bytes.copyOfRange(0, 1)
        val second = byteArrayOf(0) + bytes.copyOfRange(1, bytes.size)

        val a = codec.decode(first)
        val b = codec.decode(second)

        assertEquals("", a?.text, )
        assertEquals("╭ok", b?.text)
    }

    @Test
    fun `holds an incomplete tail until the rest arrives`() {
        val codec = FrameCodec()
        val bytes = "ab╮".toByteArray(Charsets.UTF_8)
        val head = byteArrayOf(0) + bytes.copyOfRange(0, 3) // "ab" plus one byte of the box char
        val tail = byteArrayOf(0) + bytes.copyOfRange(3, bytes.size)

        assertEquals("ab", codec.decode(head)?.text)
        assertEquals("╮", codec.decode(tail)?.text)
    }

    @Test
    fun `keeps separate ordinals from corrupting each other`() {
        val codec = FrameCodec()
        val split = "╯".toByteArray(Charsets.UTF_8)

        // Start a partial sequence on ordinal 0, then a complete one on ordinal 1.
        codec.decode(byteArrayOf(0) + split.copyOfRange(0, 1))
        assertEquals("done", codec.decode(frame(1, "done"))?.text)
        // Ordinal 0 must still be able to finish its own character.
        assertEquals("╯", codec.decode(byteArrayOf(0) + split.copyOfRange(1, split.size))?.text)
    }

    @Test
    fun `returns null for an empty frame that carries no ordinal`() {
        assertNull(FrameCodec().decode(ByteArray(0)))
    }

    @Test
    fun `returns empty text for an ordinal with no payload`() {
        assertEquals("", FrameCodec().decode(byteArrayOf(3))?.text)
    }

    @Test
    fun `reads ordinals above 127 without sign extension`() {
        // Byte is signed in Kotlin, so ordinal 200 arrives as -56 unless masked.
        val out = FrameCodec().decode(byteArrayOf(200.toByte()) + "x".toByteArray())
        assertEquals(200, out?.ordinal)
    }

    @Test
    fun `forgetting an ordinal drops its pending bytes`() {
        val codec = FrameCodec()
        val split = "╰".toByteArray(Charsets.UTF_8)
        codec.decode(byteArrayOf(0) + split.copyOfRange(0, 1))
        codec.forget(0)
        // The stale first byte must not be prepended to whatever comes next.
        assertEquals("hi", codec.decode(frame(0, "hi"))?.text)
    }
}
