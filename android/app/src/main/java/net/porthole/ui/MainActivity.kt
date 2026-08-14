package net.porthole.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.porthole.net.AlreadyLive
import net.porthole.net.HistoryEntry
import net.porthole.net.SessionInfo
import net.porthole.net.claimPairing
import net.porthole.net.fetchHistory
import net.porthole.net.startSession
import net.porthole.service.PanelBus
import net.porthole.service.PanelService
import net.porthole.store.Panel
import net.porthole.store.PanelStore
import net.porthole.store.parsePairingUri

sealed interface Screen {
    data object Panels : Screen
    data object Scan : Screen
    data object Sessions : Screen
    data class Terminal(val sessionId: String) : Screen
}

class MainActivity : ComponentActivity() {

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    /**
     * Observable, because the activity is singleTask. A pairing link tapped while the
     * app is already open arrives at onNewIntent, and a plain field captured once by
     * setContent would never see it: the link would be silently ignored, which is the
     * most common way anyone would actually use one.
     */
    private val currentIntent = mutableStateOf<Intent?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        askForNotifications()
        currentIntent.value = intent
        setContent { PortholeTheme { Root(currentIntent.value) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        currentIntent.value = intent
    }

    /**
     * Without this the service runs and the socket works, but nothing ever appears on
     * the lock screen, which is the entire point of the app.
     */
    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
        if (granted != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}

@Composable
private fun Root(launchIntent: Intent?) {
    val context = LocalContextCompat()
    val store = remember { PanelStore(context) }
    var panels by remember { mutableStateOf(store.list()) }
    var screen by remember { mutableStateOf<Screen>(if (panels.isEmpty()) Screen.Panels else Screen.Sessions) }

    val connected by PanelBus.connected.collectAsStateWithLifecycle()
    val activePanel by PanelBus.panel.collectAsStateWithLifecycle()
    val notice by PanelBus.notice.collectAsStateWithLifecycle()

    // Connect to the first saved panel on launch, and follow a notification tap through
    // to the session it was about.
    // Reconnect to the panel you were last on, not whichever happens to be first.
    LaunchedEffect(panels) {
        if (activePanel == null) {
            store.preferred()?.let { PanelService.start(context, it.id) }
        }
    }
    var autoPairUri by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(launchIntent) {
        launchIntent?.getStringExtra("openSession")?.let { screen = Screen.Terminal(it) }
        // A pairing link should pair, not merely open the scanner. This also covers a
        // device with no usable camera, which includes every emulator.
        launchIntent?.data?.toString()?.let { uri ->
            if (parsePairingUri(uri) != null) {
                autoPairUri = uri
                screen = Screen.Scan
            }
        }
    }

    Scaffold(
        containerColor = Hull.hull,
        topBar = { TopBar(activePanel?.name, connected, screen) { screen = it } },
        snackbarHost = {},
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (val s = screen) {
                is Screen.Panels -> PanelsScreen(
                    panels = panels,
                    onScan = { screen = Screen.Scan },
                    onPick = { p ->
                        store.lastUsedId = p.id
                        PanelService.start(context, p.id)
                        screen = Screen.Sessions
                    },
                    onForget = { p -> store.remove(p.id); panels = store.list() },
                )

                is Screen.Scan -> ScanScreen(
                    autoPairUri = autoPairUri,
                    onCancel = { autoPairUri = null; screen = if (panels.isEmpty()) Screen.Panels else Screen.Sessions },
                    onPaired = { panel ->
                        autoPairUri = null
                        store.add(panel)
                        panels = store.list()
                        PanelService.start(context, panel.id)
                        screen = Screen.Sessions
                    },
                )

                is Screen.Sessions -> SessionsScreen(
                    onOpen = { id -> screen = Screen.Terminal(id) },
                    onManagePanels = { screen = Screen.Panels },
                )

                is Screen.Terminal -> TerminalScreen(
                    sessionId = s.sessionId,
                    onBack = { screen = Screen.Sessions },
                )
            }

            notice?.let { message ->
                Snackbar(
                    modifier = Modifier.align(Alignment.BottomCenter).padding(12.dp),
                    action = { TextButton(onClick = { PanelBus.notice.value = null }) { Text("OK") } },
                ) { Text(message) }
            }
        }
    }
}

@Composable
private fun LocalContextCompat() = androidx.compose.ui.platform.LocalContext.current

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TopBar(panelName: String?, connected: Boolean, screen: Screen, go: (Screen) -> Unit) {
    TopAppBar(
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = Hull.deck,
            titleContentColor = Hull.foam,
        ),
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(13.dp).clip(CircleShape)
                        .background(if (connected) Hull.starboard else Hull.fathomDim)
                )
                Spacer(Modifier.width(10.dp))
                Column {
                    Text(
                        "PORTHOLE",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = 2.sp,
                    )
                    panelName?.let {
                        Text(
                            it,
                            fontSize = 11.sp,
                            color = Hull.fathomDim,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
            }
        },
        actions = {
            if (screen !is Screen.Panels) {
                TextButton(onClick = { go(Screen.Panels) }) {
                    Text("Panels", color = Hull.fathom, fontSize = 13.sp)
                }
            }
        },
    )
}

@Composable
private fun PanelsScreen(
    panels: List<Panel>,
    onScan: () -> Unit,
    onPick: (Panel) -> Unit,
    onForget: (Panel) -> Unit,
) {
    Column(Modifier.fillMaxSize().padding(16.dp)) {
        SectionLabel("Panels")

        if (panels.isEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text(
                "No panels yet. Run \"porthole pair\" on your machine and scan the code it shows.",
                color = Hull.fathom,
                fontSize = 14.sp,
            )
        }

        LazyColumn(Modifier.weight(1f)) {
            items(panels, key = { it.id }) { panel ->
                Row(
                    Modifier.fillMaxWidth().clickable { onPick(panel) }.padding(vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(panel.name, color = Hull.foam, fontSize = 15.sp)
                        Text(
                            "${panel.host}:${panel.port}  ${panel.role}",
                            color = Hull.fathomDim,
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    TextButton(onClick = { onForget(panel) }) {
                        Text("Forget", color = Hull.fathomDim, fontSize = 13.sp)
                    }
                }
                HorizontalDivider(color = Hull.rim)
            }
        }

        Button(
            onClick = onScan,
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = Hull.brass, contentColor = Hull.hull),
            shape = RoundedCornerShape(10.dp),
        ) { Text("Scan a pairing code", fontWeight = FontWeight.SemiBold) }
    }
}

@Composable
private fun SessionsScreen(onOpen: (String) -> Unit, onManagePanels: () -> Unit) {
    val sessions by PanelBus.sessions.collectAsStateWithLifecycle()
    val connected by PanelBus.connected.collectAsStateWithLifecycle()
    val panel by PanelBus.panel.collectAsStateWithLifecycle()
    val canCreate by PanelBus.canCreate.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    var history by remember { mutableStateOf<List<HistoryEntry>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    var confirmForce by remember { mutableStateOf<HistoryEntry?>(null) }

    // Refreshed whenever the live list changes, so a session that just ended reappears
    // under Resume without needing the screen reopened.
    LaunchedEffect(panel, sessions.size) {
        val p = panel ?: return@LaunchedEffect
        history = withContext(Dispatchers.IO) { fetchHistory(p) }
    }

    fun resume(entry: HistoryEntry, force: Boolean) {
        val p = panel ?: return
        val cwd = entry.cwd ?: return
        busy = true
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                startSession(p, cwd, entry.title.take(40), resumeId = entry.sessionId, force = force)
            }
            busy = false
            result.fold(
                onSuccess = { onOpen(it) },
                onFailure = { err ->
                    if (err is AlreadyLive) confirmForce = entry
                    else PanelBus.notice.value = err.message ?: "Could not resume it"
                },
            )
        }
    }

    val running = sessions.map { it.id }.toSet()
    val resumable = history.filter { it.resumable && it.sessionId !in running }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        LazyColumn(Modifier.fillMaxSize()) {
            item { SectionLabel("Sessions") }

            if (sessions.isEmpty()) {
                item {
                    Text(
                        if (connected) "Nothing running on this panel yet."
                        else "Connecting to the panel…",
                        color = Hull.fathom,
                        fontSize = 14.sp,
                        modifier = Modifier.padding(vertical = 6.dp),
                    )
                }
            }

            items(sessions, key = { it.id }) { session ->
                SessionRow(session) { onOpen(session.id) }
                HorizontalDivider(color = Hull.rim)
            }

            item { SectionLabel("Resume") }

            if (!canCreate) {
                item {
                    Text(
                        "This link can drive sessions but not start them. Pair again with " +
                            "--can-create to resume from here.",
                        color = Hull.fathomDim,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(bottom = 6.dp),
                    )
                }
            } else if (resumable.isEmpty()) {
                item {
                    Text(
                        "No past conversations yet. A session only becomes resumable " +
                            "once it has been given a prompt.",
                        color = Hull.fathomDim,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(bottom = 6.dp),
                    )
                }
            }

            items(resumable, key = { it.sessionId }) { entry ->
                HistoryRow(entry, enabled = canCreate && !busy) { resume(entry, force = false) }
                HorizontalDivider(color = Hull.rim)
            }

            item { Spacer(Modifier.height(24.dp)) }
        }
    }

    confirmForce?.let { entry ->
        AlertDialog(
            onDismissRequest = { confirmForce = null },
            containerColor = Hull.deck,
            title = { Text("Already open?", color = Hull.foam) },
            text = {
                Text(
                    "That conversation was written to moments ago, so it looks like it is " +
                        "open somewhere else. Resuming runs a second copy writing the same " +
                        "transcript.",
                    color = Hull.fathom,
                    fontSize = 13.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = { val e = entry; confirmForce = null; resume(e, force = true) }) {
                    Text("Resume anyway", color = Hull.port)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmForce = null }) { Text("Cancel", color = Hull.fathom) }
            },
        )
    }
}

@Composable
private fun HistoryRow(entry: HistoryEntry, enabled: Boolean, onClick: () -> Unit) {
    val ageMinutes = ((System.currentTimeMillis() - entry.lastActivityAt) / 60_000).coerceAtLeast(0)
    val age = when {
        ageMinutes < 60 -> "${ageMinutes}m ago"
        ageMinutes < 60 * 24 -> "${ageMinutes / 60}h ago"
        else -> "${ageMinutes / 1440}d ago"
    }

    Row(
        Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick).padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(9.dp).clip(CircleShape)
                .background(if (entry.likelyLive) Hull.brass else Hull.fathomDim)
        )
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                entry.title,
                color = if (enabled) Hull.foam else Hull.fathomDim,
                fontSize = 15.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "$age   ${entry.cwd?.substringAfterLast('/') ?: ""}" +
                    if (entry.likelyLive) "   open elsewhere" else "",
                color = Hull.fathomDim,
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun SessionRow(session: SessionInfo, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(9.dp).clip(CircleShape).background(
                when {
                    session.needsAttention -> Hull.port
                    session.alive -> Hull.starboard
                    else -> Hull.fathomDim
                }
            )
        )
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                session.label,
                color = if (session.alive) Hull.foam else Hull.fathom,
                fontSize = 15.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                if (session.alive) "${session.viewers} watching   ${session.cols}x${session.rows}"
                else "stopped (${session.exitCode ?: "?"})",
                color = Hull.fathomDim,
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

@Composable
fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        color = Hull.fathomDim,
        fontSize = 11.sp,
        letterSpacing = 2.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 14.dp, bottom = 4.dp),
    )
}
