package net.porthole.store

import java.net.URI

/**
 * A pairing payload read off a camera, which makes it the most exposed input the app
 * has. Every failure mode returns null rather than throwing, because this runs inside a
 * scanner callback where an exception would take the camera down mid-frame.
 *
 * Deliberately parsed with java.net.URI rather than android.net.Uri, so the same code
 * runs under plain JVM unit tests instead of against a stub that returns nulls.
 */
data class PairingInfo(
    val host: String,
    val port: Int,
    val code: String,
    val name: String?,
) {
    /**
     * Plain HTTP: a tailnet is already WireGuard end to end, and demanding a
     * certificate before the app works at all is the friction this removes. If the
     * panel is fronted by `tailscale serve`, pair against that name and this is https.
     */
    val baseUrl: String get() = "http://$host:$port"
}

fun parsePairingUri(raw: String?): PairingInfo? {
    if (raw.isNullOrBlank()) return null

    val uri = try {
        URI(raw)
    } catch (_: Exception) {
        return null
    }

    if (!"porthole".equals(uri.scheme, ignoreCase = true)) return null
    if (!"pair".equals(uri.host, ignoreCase = true)) return null

    val query = uri.rawQuery ?: return null
    val params = HashMap<String, String>()
    for (part in query.split('&')) {
        val eq = part.indexOf('=')
        if (eq <= 0) continue
        val key = part.substring(0, eq)
        val value = part.substring(eq + 1)
        params[key] = try {
            java.net.URLDecoder.decode(value, "UTF-8")
        } catch (_: Exception) {
            value
        }
    }

    val host = params["h"]?.takeIf { it.isNotBlank() } ?: return null
    val code = params["c"]?.takeIf { it.isNotBlank() } ?: return null
    val port = params["p"]?.toIntOrNull() ?: return null
    if (port !in 1..65535) return null

    return PairingInfo(host = host, port = port, code = code, name = params["n"])
}
