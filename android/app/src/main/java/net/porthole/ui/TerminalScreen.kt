package net.porthole.ui

import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.serialization.json.JsonPrimitive
import net.porthole.net.Outbound
import net.porthole.net.PanelEvent
import net.porthole.service.PanelBus

/** Keys a terminal needs that a soft keyboard will not give you. */
private val KEYS = listOf(
    "esc" to "\u001b",
    "tab" to "\t",
    "↑" to "\u001b[A",
    "↓" to "\u001b[B",
    "⇧tab" to "\u001b[Z",
    "^C" to "\u0003",
    "/" to "/",
    "⏎" to "\r",
)

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun TerminalScreen(sessionId: String, onBack: () -> Unit) {
    val sessions by PanelBus.sessions.collectAsState()
    val helm by PanelBus.helm.collectAsState()
    val clientId by PanelBus.clientId.collectAsState()
    val role by PanelBus.role.collectAsState()

    val session = sessions.firstOrNull { it.id == sessionId }
    val canType = role != "view"
    var webView by remember { mutableStateOf<WebView?>(null) }
    var prompt by remember { mutableStateOf("") }
    // loadUrl is asynchronous, so window.Porthole does not exist for the first moments
    // of this screen's life. Calling into it before then throws a ReferenceError inside
    // the WebView and the output is lost silently. The page signals when it is ready.
    var pageReady by remember { mutableStateOf(false) }

    fun send(frame: String) = PanelBus.client?.send(frame)
    fun type(data: String) = send(Outbound.input(sessionId, data))

    // Attaching tells the server to start streaming this session to us, and detaching on
    // the way out keeps the viewer count honest for everyone else.
    DisposableEffect(sessionId) {
        PanelBus.attached.value = sessionId
        send(Outbound.attach(sessionId))
        onDispose {
            send(Outbound.detach(sessionId))
            PanelBus.attached.value = null
        }
    }

    // A fresh screen is painted from a snapshot, never from replayed history. Anything
    // that arrived while the page was still loading is covered by that snapshot, which
    // is why dropping it until ready costs nothing.
    LaunchedEffect(webView, sessionId, pageReady) {
        if (!pageReady) return@LaunchedEffect
        val view = webView ?: return@LaunchedEffect
        PanelBus.snapshots.collect { snap ->
            if (snap.sessionId != sessionId) return@collect
            view.evaluateJavascript("Porthole.reset(); Porthole.write(${JsonPrimitive(snap.data)});", null)
        }
    }

    LaunchedEffect(webView, sessionId, pageReady) {
        if (!pageReady) return@LaunchedEffect
        val view = webView ?: return@LaunchedEffect
        PanelBus.output.collect { out ->
            if (PanelBus.client?.sessionFor(out.ordinal) != sessionId) return@collect
            view.evaluateJavascript("Porthole.write(${JsonPrimitive(out.text)});", null)
        }
    }

    Column(Modifier.fillMaxSize().background(Hull.hull)) {

        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = onBack) { Text("‹ Sessions", color = Hull.fathom, fontSize = 13.sp) }
            Spacer(Modifier.weight(1f))
            Text(
                session?.label ?: "session",
                color = Hull.foam,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
            )
        }

        // The porthole rim, carried over from the web panel.
        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 6.dp)
                .clip(RoundedCornerShape(10.dp))
                .border(1.dp, if (session?.needsAttention == true) Hull.port else Hull.brassDim, RoundedCornerShape(10.dp))
                .background(androidx.compose.ui.graphics.Color(0xFF0A1013))
        ) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { context ->
                    WebView(context).apply {
                        // Without explicit params a WebView defaults to WRAP_CONTENT. It
                        // then wraps an empty page to zero height, so the page's own
                        // height:100% resolves against a zero viewport and stays zero
                        // forever. The terminal renders correctly into a container
                        // nobody can see.
                        layoutParams = android.view.ViewGroup.LayoutParams(
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.allowFileAccess = false
                        settings.allowContentAccess = false
                        setBackgroundColor(0xFF0A1013.toInt())

                        addJavascriptInterface(object {
                            @JavascriptInterface
                            fun input(data: String) {
                                if (canType) type(data)
                            }

                            @JavascriptInterface
                            fun resized(cols: Int, rows: Int) {
                                // Only claim the size when nobody else is watching. With a
                                // desktop attached, a phone taking over would squeeze the
                                // session down to its own width.
                                val alone = (PanelBus.sessions.value
                                    .firstOrNull { it.id == sessionId }?.viewers ?: 1) <= 1
                                PanelBus.client?.send(Outbound.hello(cols, rows, wantsResize = alone))
                                if (alone) PanelBus.client?.send(Outbound.resize(sessionId, cols, rows))
                            }

                            @JavascriptInterface
                            fun ready(cols: Int, rows: Int) {
                                // Runs on a WebView JS thread, so hop to the main thread
                                // before touching Compose state.
                                webView?.post {
                                    pageReady = true
                                    // Ask for a fresh screen now that there is somewhere
                                    // to paint it.
                                    PanelBus.client?.send(Outbound.attach(sessionId))
                                }
                            }
                        }, "Bridge")

                        loadUrl("file:///android_asset/terminal.html")
                        webView = this
                    }
                },
            )
        }

        Spacer(Modifier.height(6.dp))

        // The key bar is native and sits above the soft keyboard, which is the one thing
        // a browser on a phone genuinely cannot get right.
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            KEYS.forEach { (label, code) ->
                OutlinedButton(
                    onClick = { type(code) },
                    modifier = Modifier.weight(1f).height(40.dp),
                    contentPadding = PaddingValues(0.dp),
                    shape = RoundedCornerShape(7.dp),
                    enabled = canType,
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Hull.fathom),
                ) {
                    Text(label, fontSize = 11.sp, fontFamily = FontFamily.Monospace, maxLines = 1)
                }
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = prompt,
                onValueChange = { prompt = it },
                modifier = Modifier.weight(1f),
                placeholder = {
                    Text(
                        if (canType) "Type a prompt, then send" else "You are watching this session",
                        fontSize = 13.sp,
                    )
                },
                enabled = canType,
                maxLines = 4,
                textStyle = androidx.compose.ui.text.TextStyle(fontSize = 14.sp, color = Hull.foam),
                shape = RoundedCornerShape(9.dp),
                keyboardActions = KeyboardActions(onSend = {}),
            )
            Spacer(Modifier.width(6.dp))
            Button(
                onClick = {
                    if (prompt.isNotBlank()) {
                        type(prompt + "\r")
                        prompt = ""
                    }
                },
                enabled = canType && prompt.isNotBlank(),
                colors = ButtonDefaults.buttonColors(containerColor = Hull.brass, contentColor = Hull.hull),
                shape = RoundedCornerShape(9.dp),
            ) { Text("Send", fontWeight = FontWeight.SemiBold) }
        }

        val mine = helm != null && helm == clientId
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                when {
                    mine -> "you have the helm"
                    helm != null -> "someone else has the helm"
                    else -> "helm is open"
                },
                color = Hull.fathomDim,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
            )
            Spacer(Modifier.weight(1f))
            if (canType) {
                TextButton(onClick = { send(Outbound.helm(sessionId, claim = !mine)) }) {
                    Text(
                        if (mine) "Release" else "Take the helm",
                        color = if (mine) Hull.brass else Hull.fathom,
                        fontSize = 12.sp,
                    )
                }
            }
        }
    }
}
