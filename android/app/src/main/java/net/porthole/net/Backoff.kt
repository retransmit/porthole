package net.porthole.net

import kotlin.math.min

/**
 * Reconnect delays. A phone loses its connection constantly, moving between wifi and
 * mobile data or simply having the screen turned off, so this has to recover quickly
 * from a blip without hammering the radio when the panel is genuinely down.
 */
class Backoff(
    private val initialMs: Long = 500,
    private val maxMs: Long = 15_000,
    private val factor: Double = 1.7,
) {
    private var current = initialMs

    fun next(): Long {
        val delay = current
        current = min((current * factor).toLong(), maxMs)
        return delay
    }

    /** Called on a successful connection, so a later blip starts short again. */
    fun reset() {
        current = initialMs
    }
}
