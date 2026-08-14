package net.porthole.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The client and server are separate codebases over one wire format, so this is where
 * drift would show up. Failures here are the difference between the app working and it
 * showing an empty session list with no error.
 */
class ProtocolTest {

    @Test
    fun `reads a welcome and its session list`() {
        val e = parseControl(
            """{"t":"welcome","v":1,"clientId":"c1","role":"control","label":"phone",
               "caps":{"create":false},
               "sessions":[{"id":"s1","label":"AX10","cwd":"E:\\p","alive":true,"viewers":2,
                            "cols":100,"rows":30,"attention":null,"exitCode":null}]}"""
        ) as PanelEvent.Welcome

        assertEquals("control", e.role)
        assertEquals("phone", e.label)
        assertEquals(false, e.canCreate)
        assertEquals(1, e.sessions.size)
        assertEquals("AX10", e.sessions[0].label)
        assertEquals(2, e.sessions[0].viewers)
        assertEquals(false, e.sessions[0].needsAttention)
    }

    @Test
    fun `treats a present attention object as needing attention`() {
        val e = parseControl(
            """{"t":"sessions","sessions":[{"id":"s1","label":"x","cwd":"","alive":true,
               "viewers":1,"cols":80,"rows":24,"attention":{"kind":"needs-input","text":"waiting"}}]}"""
        ) as PanelEvent.Sessions
        assertTrue(e.sessions[0].needsAttention)
    }

    @Test
    fun `reads an attach with its ordinal`() {
        val e = parseControl("""{"t":"attached","sessionId":"s1","ordinal":0}""") as PanelEvent.Attached
        assertEquals(0, e.ordinal)
        assertEquals("s1", e.sessionId)
    }

    @Test
    fun `reads a snapshot with geometry`() {
        val e = parseControl(
            """{"t":"snapshot","sessionId":"s1","cols":110,"rows":32,"data":"\u001b[1mhi\u001b[0m"}"""
        ) as PanelEvent.Snapshot
        assertEquals(110, e.cols)
        assertTrue(e.data.contains("hi"))
    }

    @Test
    fun `reads an attention frame, which is what wakes the phone`() {
        val e = parseControl(
            """{"t":"attention","sessionId":"s1","kind":"needs-input","text":"Claude is waiting for you"}"""
        ) as PanelEvent.Attention
        assertEquals("needs-input", e.kind)
        assertEquals("Claude is waiting for you", e.text)
    }

    @Test
    fun `reads a denial so the ui can explain why typing did nothing`() {
        val e = parseControl("""{"t":"denied","sessionId":"s1","reason":"role"}""") as PanelEvent.Denied
        assertEquals("role", e.reason)
    }

    @Test
    fun `reads presence including who holds the helm`() {
        val e = parseControl(
            """{"t":"presence","sessionId":"s1","helm":"c2",
               "viewers":[{"id":"c1","label":"phone","role":"control"},{"id":"c2","label":"desk","role":"admin"}]}"""
        ) as PanelEvent.Presence
        assertEquals(2, e.viewers.size)
        assertEquals("c2", e.helm)
    }

    @Test
    fun `a null helm means nobody is driving`() {
        val e = parseControl("""{"t":"presence","sessionId":"s1","helm":null,"viewers":[]}""") as PanelEvent.Presence
        assertNull(e.helm)
    }

    @Test
    fun `ignores a message type it has never heard of`() {
        // A newer server must not take the connection down.
        assertNull(parseControl("""{"t":"something-from-the-future","x":1}"""))
    }

    @Test
    fun `survives malformed json rather than throwing`() {
        assertNull(parseControl("{ this is not json"))
        assertNull(parseControl(""))
        assertNull(parseControl("[]"))
    }

    @Test
    fun `escapes control characters in outbound input`() {
        // Terminal input is escape sequences and control bytes. Hand-rolled quoting
        // would produce invalid JSON the moment somebody pressed the escape key.
        val line = Outbound.input("s1", "\u001b[A\r\n\"quoted\"")
        assertTrue("must escape ESC", line.contains("\\u001b"))
        assertTrue("must escape CR", line.contains("\\r"))
        assertTrue("must escape quotes", line.contains("\\\""))
        // And the result must still parse as JSON.
        assertTrue(kotlinx.serialization.json.Json.parseToJsonElement(line) is kotlinx.serialization.json.JsonObject)
    }

    @Test
    fun `hello declares the protocol version the server expects`() {
        assertTrue(Outbound.hello(80, 24, true).contains("\"v\":1"))
        assertTrue(Outbound.hello(80, 24, false).contains("\"wantsResize\":false"))
    }
}
