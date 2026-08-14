package net.porthole.net

import net.porthole.store.Panel
import net.porthole.store.PairingInfo
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

/**
 * One connection to one panel.
 *
 * Authenticates with a bearer header rather than a cookie. That is not incidental: the
 * server refuses a handshake that carries no Origin unless it presents a bearer token,
 * precisely because a browser page cannot set that header and therefore cannot mount a
 * cross-site hijack. A native client sending no Origin and a bearer token is the shape
 * that rule was written to admit.
 */
class PanelClient(
    private val panel: Panel,
    private val onEvent: (PanelEvent) -> Unit,
    private val onConnectionChange: (Boolean) -> Unit = {},
) {
    private val http = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private val codec = FrameCodec()
    private val backoff = Backoff()

    @Volatile private var socket: WebSocket? = null
    @Volatile private var wantConnection = false
    private val ordinals = HashMap<Int, String>()

    fun connect() {
        wantConnection = true
        open()
    }

    private fun open() {
        if (!wantConnection) return
        val request = Request.Builder()
            .url(panel.socketUrl)
            .header("Authorization", "Bearer ${panel.token}")
            .build()

        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                backoff.reset()
                onConnectionChange(true)
            }

            override fun onMessage(ws: WebSocket, text: String) {
                val event = parseControl(text) ?: return
                if (event is PanelEvent.Attached) {
                    // A reattached ordinal may carry a stale half character.
                    codec.forget(event.ordinal)
                    ordinals[event.ordinal] = event.sessionId
                }
                onEvent(event)
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                val decoded = codec.decode(bytes.toByteArray()) ?: return
                if (decoded.text.isEmpty()) return
                onEvent(PanelEvent.Output(decoded.ordinal, decoded.text))
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                onConnectionChange(false)
                scheduleRetry()
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                onConnectionChange(false)
                scheduleRetry()
            }
        })
    }

    private fun scheduleRetry() {
        if (!wantConnection) return
        val delay = backoff.next()
        Thread {
            try {
                Thread.sleep(delay)
            } catch (_: InterruptedException) {
                return@Thread
            }
            open()
        }.start()
    }

    fun sessionFor(ordinal: Int): String? = ordinals[ordinal]

    fun send(frame: String) {
        socket?.send(frame)
    }

    fun disconnect() {
        wantConnection = false
        socket?.close(1000, "closing")
        socket = null
        codec.forgetAll()
        ordinals.clear()
        onConnectionChange(false)
    }
}

/** A past conversation the panel offers to resume. */
data class HistoryEntry(
    val sessionId: String,
    val title: String,
    val cwd: String?,
    val lastActivityAt: Long,
    val resumable: Boolean,
    val likelyLive: Boolean,
)

private val restClient by lazy {
    OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).build()
}

private fun authed(panel: Panel, url: String) =
    Request.Builder().url(url).header("Authorization", "Bearer ${panel.token}")

/**
 * Past conversations, newest first.
 *
 * A session started by hand in a terminal cannot be adopted by the panel, so resuming
 * from its transcript is the only way to reach it from a phone at all. That makes this
 * list the difference between the app driving whatever happens to be running and the
 * app reaching everything you have worked on.
 */
fun fetchHistory(panel: Panel, limit: Int = 40): List<HistoryEntry> = try {
    restClient.newCall(authed(panel, "${panel.baseUrl}/api/history?limit=$limit").get().build())
        .execute().use { response ->
            if (!response.isSuccessful) return emptyList()
            val obj = Json.parseToJsonElement(response.body?.string().orEmpty()) as JsonObject
            obj["sessions"]?.jsonArray?.mapNotNull { element ->
                val s = element as? JsonObject ?: return@mapNotNull null
                HistoryEntry(
                    sessionId = s["sessionId"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                    title = s["title"]?.jsonPrimitive?.contentOrNull ?: "(untitled)",
                    cwd = s["cwd"]?.jsonPrimitive?.contentOrNull,
                    lastActivityAt = s["lastActivityAt"]?.jsonPrimitive?.content?.toDoubleOrNull()?.toLong() ?: 0L,
                    resumable = s["resumable"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: false,
                    likelyLive = s["likelyLive"]?.jsonPrimitive?.content?.toBooleanStrictOrNull() ?: false,
                )
            } ?: emptyList()
        }
} catch (_: Exception) {
    emptyList()
}

/**
 * Start a session, optionally resuming a past conversation.
 *
 * The panel answers 409 when the conversation looks like it is already open somewhere
 * else, because resuming it would run a second process appending to the same transcript.
 * That refusal is surfaced rather than swallowed, with `force` left to the caller.
 */
fun startSession(
    panel: Panel,
    cwd: String,
    label: String,
    resumeId: String? = null,
    force: Boolean = false,
): Result<String> = try {
    val payload = buildString {
        append("""{"cwd":""").append(JsonPrimitive(cwd))
        append(""","label":""").append(JsonPrimitive(label))
        if (resumeId != null) append(""","resumeId":""").append(JsonPrimitive(resumeId))
        if (force) append(""","force":true""")
        append("}")
    }

    restClient.newCall(
        authed(panel, "${panel.baseUrl}/api/sessions")
            .post(payload.toRequestBody("application/json".toMediaType()))
            .build()
    ).execute().use { response ->
        val text = response.body?.string().orEmpty()
        val obj = runCatching { Json.parseToJsonElement(text) as JsonObject }.getOrNull()
        if (response.isSuccessful) {
            val id = (obj?.get("session") as? JsonObject)?.get("id")?.jsonPrimitive?.contentOrNull
            if (id != null) Result.success(id)
            else Result.failure(IllegalStateException("the panel did not return a session"))
        } else {
            val code = obj?.get("code")?.jsonPrimitive?.contentOrNull
            val message = obj?.get("error")?.jsonPrimitive?.contentOrNull ?: "could not start it (${response.code})"
            Result.failure(if (code == "already-live") AlreadyLive(message) else IllegalStateException(message))
        }
    }
} catch (e: Exception) {
    Result.failure(e)
}

/** Distinct type so the UI can offer to force rather than just reporting a failure. */
class AlreadyLive(message: String) : Exception(message)

/**
 * Exchange a one-time pairing code for a real token.
 *
 * This is the only unauthenticated call the app makes, and the only moment the code is
 * worth anything. The server marks it spent before issuing the token, so a code
 * photographed off a screen after the fact buys nothing.
 */
fun claimPairing(info: PairingInfo): Result<Panel> {
    val client = OkHttpClient.Builder()
        .callTimeout(15, TimeUnit.SECONDS)
        .build()

    val body = """{"code":${JsonPrimitive(info.code)}}"""
        .toRequestBody("application/json".toMediaType())

    val request = Request.Builder()
        .url("${info.baseUrl}/api/pair/claim")
        .post(body)
        .build()

    return try {
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val message = runCatching {
                    (Json.parseToJsonElement(text) as JsonObject)["error"]?.jsonPrimitive?.contentOrNull
                }.getOrNull() ?: "pairing failed (${response.code})"
                return Result.failure(IllegalStateException(message))
            }

            val obj = Json.parseToJsonElement(text) as JsonObject
            val token = obj["token"]?.jsonPrimitive?.contentOrNull
                ?: return Result.failure(IllegalStateException("the panel did not return a token"))

            Result.success(
                Panel(
                    id = java.util.UUID.randomUUID().toString(),
                    name = info.name ?: info.host,
                    host = info.host,
                    port = info.port,
                    token = token,
                    role = obj["role"]?.jsonPrimitive?.contentOrNull ?: "control",
                )
            )
        }
    } catch (e: Exception) {
        Result.failure(e)
    }
}
