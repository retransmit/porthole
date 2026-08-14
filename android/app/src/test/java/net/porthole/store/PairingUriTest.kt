package net.porthole.store

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * This parses a value read off a camera, so it is the app's most exposed input. It must
 * refuse anything malformed rather than throwing inside the scanner callback.
 */
class PairingUriTest {

    @Test
    fun `parses a well formed pairing uri`() {
        val p = parsePairingUri("porthole://pair?h=dexel.tailfe839d.ts.net&p=7317&c=ABCD-EFGH-JKLM&n=dexel")
        assertEquals("dexel.tailfe839d.ts.net", p?.host)
        assertEquals(7317, p?.port)
        assertEquals("ABCD-EFGH-JKLM", p?.code)
        assertEquals("dexel", p?.name)
    }

    @Test
    fun `a missing name is allowed`() {
        val p = parsePairingUri("porthole://pair?h=host&p=7317&c=ABCD")
        assertEquals("host", p?.host)
        assertNull(p?.name)
    }

    @Test
    fun `refuses a different scheme, so a hostile qr cannot redirect us`() {
        assertNull(parsePairingUri("https://evil.example/pair?h=host&p=7317&c=ABCD"))
    }

    @Test
    fun `refuses the right scheme with the wrong action`() {
        assertNull(parsePairingUri("porthole://wipe?h=host&p=7317&c=ABCD"))
    }

    @Test
    fun `refuses a uri with no code`() {
        assertNull(parsePairingUri("porthole://pair?h=host&p=7317"))
    }

    @Test
    fun `refuses a uri with no host`() {
        assertNull(parsePairingUri("porthole://pair?p=7317&c=ABCD"))
    }

    @Test
    fun `refuses a non numeric port`() {
        assertNull(parsePairingUri("porthole://pair?h=host&p=notaport&c=ABCD"))
    }

    @Test
    fun `refuses a port outside the valid range`() {
        assertNull(parsePairingUri("porthole://pair?h=host&p=0&c=ABCD"))
        assertNull(parsePairingUri("porthole://pair?h=host&p=99999&c=ABCD"))
    }

    @Test
    fun `refuses arbitrary text without throwing`() {
        assertNull(parsePairingUri("not a uri at all"))
        assertNull(parsePairingUri(""))
        assertNull(parsePairingUri("porthole://"))
    }

    @Test
    fun `builds the base url the app will talk to`() {
        val p = parsePairingUri("porthole://pair?h=dexel.ts.net&p=7317&c=ABCD")!!
        assertEquals("http://dexel.ts.net:7317", p.baseUrl)
    }
}
