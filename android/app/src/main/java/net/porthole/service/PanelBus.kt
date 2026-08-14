package net.porthole.service

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import net.porthole.net.PanelClient
import net.porthole.net.PanelEvent
import net.porthole.net.SessionInfo
import net.porthole.store.Panel

/**
 * Shared state between the service that owns the connection and the UI that displays it.
 *
 * A process-wide object rather than a bound service, deliberately. The connection has to
 * outlive every screen, and the alternative is threading a binder through Compose for no
 * gain: there is exactly one connection and exactly one process.
 */
object PanelBus {

    val connected = MutableStateFlow(false)
    val panel = MutableStateFlow<Panel?>(null)
    val sessions = MutableStateFlow<List<SessionInfo>>(emptyList())
    val role = MutableStateFlow("view")
    val clientId = MutableStateFlow("")
    val helm = MutableStateFlow<String?>(null)
    val attention = MutableStateFlow<PanelEvent.Attention?>(null)
    val notice = MutableStateFlow<String?>(null)

    /** Which session the terminal screen is currently showing. */
    val attached = MutableStateFlow<String?>(null)

    /**
     * Replay 0: terminal output is only meaningful to a live WebView. A screen that
     * appears later asks for a fresh snapshot rather than replaying a backlog.
     */
    val output = MutableSharedFlow<PanelEvent.Output>(replay = 0, extraBufferCapacity = 512)
    val snapshots = MutableSharedFlow<PanelEvent.Snapshot>(replay = 1, extraBufferCapacity = 8)

    @Volatile
    var client: PanelClient? = null

    fun reset() {
        connected.value = false
        sessions.value = emptyList()
        helm.value = null
        attention.value = null
        attached.value = null
        client = null
    }
}
