package net.porthole.net

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

/** Protocol v1, as documented on the server side in src/ws.js. */
const val PROTOCOL_VERSION = 1

data class SessionInfo(
    val id: String,
    val label: String,
    val cwd: String,
    val alive: Boolean,
    val viewers: Int,
    val cols: Int,
    val rows: Int,
    val needsAttention: Boolean,
    val exitCode: Int?,
)

data class Viewer(val id: String, val label: String, val role: String)

sealed interface PanelEvent {
    data class Welcome(
        val clientId: String,
        val role: String,
        val label: String,
        val sessions: List<SessionInfo>,
        val canCreate: Boolean,
    ) : PanelEvent

    data class Sessions(val sessions: List<SessionInfo>) : PanelEvent
    data class Attached(val sessionId: String, val ordinal: Int) : PanelEvent
    data class Snapshot(val sessionId: String, val cols: Int, val rows: Int, val data: String) : PanelEvent
    data class Sized(val sessionId: String, val cols: Int, val rows: Int, val by: String?) : PanelEvent
    data class Attention(val sessionId: String, val kind: String, val text: String) : PanelEvent
    data class Presence(val sessionId: String, val viewers: List<Viewer>, val helm: String?) : PanelEvent
    data class Denied(val sessionId: String, val reason: String) : PanelEvent
    data class Exited(val sessionId: String, val code: Int) : PanelEvent
    data class Failure(val code: String, val message: String) : PanelEvent
    data class Output(val ordinal: Int, val text: String) : PanelEvent
    data object Pong : PanelEvent
}

private val json = Json { ignoreUnknownKeys = true; isLenient = true }

private fun JsonObject.str(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull

private fun JsonObject.int(key: String, fallback: Int = 0): Int =
    this[key]?.jsonPrimitive?.intOrNull ?: fallback

private fun JsonObject.bool(key: String, fallback: Boolean = false): Boolean =
    this[key]?.jsonPrimitive?.booleanOrNull ?: fallback

private fun sessionsFrom(obj: JsonObject): List<SessionInfo> =
    obj["sessions"]?.jsonArray?.mapNotNull { element ->
        val s = element as? JsonObject ?: return@mapNotNull null
        SessionInfo(
            id = s.str("id") ?: return@mapNotNull null,
            label = s.str("label") ?: "session",
            cwd = s.str("cwd") ?: "",
            alive = s.bool("alive"),
            viewers = s.int("viewers"),
            cols = s.int("cols", 80),
            rows = s.int("rows", 24),
            // The server sends an object here, or null. Presence of the object is the signal.
            needsAttention = s["attention"] != null && s["attention"] !is JsonNull,
            exitCode = s["exitCode"]?.jsonPrimitive?.intOrNull,
        )
    } ?: emptyList()

/**
 * Parse a JSON control frame.
 *
 * Returns null for anything unrecognised rather than throwing. A server newer than this
 * app will send message types it has never heard of, and the correct response to that is
 * to carry on, not to drop the connection.
 */
fun parseControl(text: String): PanelEvent? {
    val obj = try {
        json.parseToJsonElement(text) as? JsonObject ?: return null
    } catch (_: Exception) {
        return null
    }

    return when (obj.str("t")) {
        "welcome" -> PanelEvent.Welcome(
            clientId = obj.str("clientId") ?: "",
            role = obj.str("role") ?: "view",
            label = obj.str("label") ?: "",
            sessions = sessionsFrom(obj),
            canCreate = (obj["caps"] as? JsonObject)?.bool("create") ?: false,
        )

        "sessions" -> PanelEvent.Sessions(sessionsFrom(obj))

        "attached" -> PanelEvent.Attached(
            sessionId = obj.str("sessionId") ?: return null,
            ordinal = obj.int("ordinal", -1).takeIf { it >= 0 } ?: return null,
        )

        "snapshot" -> PanelEvent.Snapshot(
            sessionId = obj.str("sessionId") ?: return null,
            cols = obj.int("cols", 80),
            rows = obj.int("rows", 24),
            data = obj.str("data") ?: "",
        )

        "sized" -> PanelEvent.Sized(
            sessionId = obj.str("sessionId") ?: return null,
            cols = obj.int("cols", 80),
            rows = obj.int("rows", 24),
            by = obj.str("by"),
        )

        "attention" -> PanelEvent.Attention(
            sessionId = obj.str("sessionId") ?: return null,
            kind = obj.str("kind") ?: "needs-input",
            text = obj.str("text") ?: "Claude is waiting for you",
        )

        "presence" -> PanelEvent.Presence(
            sessionId = obj.str("sessionId") ?: return null,
            viewers = obj["viewers"]?.jsonArray?.mapNotNull {
                val v = it as? JsonObject ?: return@mapNotNull null
                Viewer(v.str("id") ?: "", v.str("label") ?: "", v.str("role") ?: "view")
            } ?: emptyList(),
            helm = obj.str("helm"),
        )

        "denied" -> PanelEvent.Denied(
            sessionId = obj.str("sessionId") ?: "",
            reason = obj.str("reason") ?: "unknown",
        )

        "exit" -> PanelEvent.Exited(
            sessionId = obj.str("sessionId") ?: return null,
            code = obj.int("code", -1),
        )

        "error" -> PanelEvent.Failure(obj.str("code") ?: "error", obj.str("message") ?: "")

        "pong" -> PanelEvent.Pong

        else -> null
    }
}

/** Outbound frames. Kept as builders so the wire shape lives in one place. */
object Outbound {
    fun hello(cols: Int, rows: Int, wantsResize: Boolean): String =
        """{"v":$PROTOCOL_VERSION,"t":"hello","client":{"kind":"android","cols":$cols,"rows":$rows,"wantsResize":$wantsResize}}"""

    fun attach(sessionId: String): String =
        """{"v":$PROTOCOL_VERSION,"t":"attach","sessionId":${quote(sessionId)}}"""

    fun detach(sessionId: String): String =
        """{"v":$PROTOCOL_VERSION,"t":"detach","sessionId":${quote(sessionId)}}"""

    fun input(sessionId: String, data: String): String =
        """{"v":$PROTOCOL_VERSION,"t":"input","sessionId":${quote(sessionId)},"data":${quote(data)}}"""

    fun resize(sessionId: String, cols: Int, rows: Int): String =
        """{"v":$PROTOCOL_VERSION,"t":"resize","sessionId":${quote(sessionId)},"cols":$cols,"rows":$rows}"""

    fun helm(sessionId: String, claim: Boolean): String =
        """{"v":$PROTOCOL_VERSION,"t":"${if (claim) "claimHelm" else "releaseHelm"}","sessionId":${quote(sessionId)}}"""

    fun clearAttention(sessionId: String): String =
        """{"v":$PROTOCOL_VERSION,"t":"clearAttention","sessionId":${quote(sessionId)}}"""

    fun ping(): String = """{"v":$PROTOCOL_VERSION,"t":"ping"}"""

    /**
     * Terminal input is arbitrary text including escape sequences and control
     * characters, so it must be escaped by a real JSON encoder rather than by hand.
     */
    private fun quote(s: String): String = JsonPrimitive(s).toString()
}
