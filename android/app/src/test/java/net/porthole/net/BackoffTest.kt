package net.porthole.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BackoffTest {

    @Test
    fun `starts at the initial delay`() {
        assertEquals(500L, Backoff(initialMs = 500).next())
    }

    @Test
    fun `grows on each failure`() {
        val b = Backoff(initialMs = 500, factor = 2.0)
        assertEquals(500L, b.next())
        assertEquals(1000L, b.next())
        assertEquals(2000L, b.next())
    }

    @Test
    fun `stops growing at the ceiling`() {
        val b = Backoff(initialMs = 1000, factor = 10.0, maxMs = 5000)
        b.next()
        b.next()
        assertEquals(5000L, b.next())
        assertEquals(5000L, b.next())
    }

    @Test
    fun `a success resets it, so a brief drop does not leave long delays`() {
        val b = Backoff(initialMs = 500, factor = 2.0)
        b.next(); b.next(); b.next()
        b.reset()
        assertEquals(500L, b.next())
    }

    @Test
    fun `never returns a delay that would spin the radio`() {
        val b = Backoff(initialMs = 500)
        repeat(20) { assertTrue("delay must stay positive", b.next() >= 100L) }
    }
}
