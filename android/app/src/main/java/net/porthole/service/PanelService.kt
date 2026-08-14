package net.porthole.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import net.porthole.R
import net.porthole.net.Outbound
import net.porthole.net.PanelClient
import net.porthole.net.PanelEvent
import net.porthole.store.PanelStore
import net.porthole.ui.MainActivity

/**
 * Holds the panel connection for as long as the app is paired to one.
 *
 * This is the entire reason the app exists rather than a bookmark to the web panel. A
 * page can only listen while it is on screen, and Web Push needs HTTPS and therefore a
 * certificate. A foreground service is exempt from doze, so when Claude stops for a
 * permission prompt at three in the morning the phone actually buzzes, over plain HTTP,
 * with no third party involved.
 */
class PanelService : Service() {

    companion object {
        private const val CHANNEL_CONNECTION = "porthole.connection"
        private const val CHANNEL_ATTENTION = "porthole.attention"
        private const val ONGOING_ID = 1
        private const val ATTENTION_BASE_ID = 100

        const val EXTRA_PANEL_ID = "panelId"
        const val ACTION_START = "net.porthole.START"
        const val ACTION_STOP = "net.porthole.STOP"

        fun start(context: Context, panelId: String) {
            val intent = Intent(context, PanelService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_PANEL_ID, panelId)
            }
            ContextCompat_startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, PanelService::class.java).apply { action = ACTION_STOP })
        }

        private fun ContextCompat_startForegroundService(context: Context, intent: Intent) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }

    private var client: PanelClient? = null
    private var attentionCounter = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                shutdown()
                return START_NOT_STICKY
            }
            ACTION_START -> {
                val panelId = intent.getStringExtra(EXTRA_PANEL_ID)
                val panel = panelId?.let { PanelStore(this).get(it) }
                if (panel == null) {
                    stopSelf()
                    return START_NOT_STICKY
                }

                startForeground(ONGOING_ID, ongoingNotification(panel.name, connected = false))
                PanelBus.panel.value = panel

                client?.disconnect()
                client = PanelClient(
                    panel = panel,
                    onEvent = ::handle,
                    onConnectionChange = { up ->
                        PanelBus.connected.value = up
                        notify(ONGOING_ID, ongoingNotification(panel.name, up))
                    },
                ).also {
                    PanelBus.client = it
                    it.connect()
                }
            }
        }
        // Restarted by the system if killed, because a dropped connection means missed
        // alerts, which is the one thing this must not do quietly.
        return START_STICKY
    }

    private fun handle(event: PanelEvent) {
        when (event) {
            is PanelEvent.Welcome -> {
                PanelBus.clientId.value = event.clientId
                PanelBus.role.value = event.role
                PanelBus.sessions.value = event.sessions
                // Announce ourselves. A phone does not vote on terminal size until it is
                // the only viewer; the terminal screen revises this once it knows.
                PanelBus.client?.send(Outbound.hello(80, 24, wantsResize = false))
            }

            is PanelEvent.Sessions -> PanelBus.sessions.value = event.sessions

            is PanelEvent.Snapshot -> PanelBus.snapshots.tryEmit(event)

            is PanelEvent.Output -> PanelBus.output.tryEmit(event)

            is PanelEvent.Presence -> PanelBus.helm.value = event.helm

            is PanelEvent.Attention -> {
                PanelBus.attention.value = event
                raiseAttention(event)
            }

            is PanelEvent.Denied -> PanelBus.notice.value = when (event.reason) {
                "role" -> "You are watching this session, not steering it"
                "helm" -> "Someone else has the helm right now"
                "dead" -> "That session has stopped"
                else -> "That was not allowed"
            }

            is PanelEvent.Failure -> PanelBus.notice.value = event.message

            else -> Unit
        }
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)

        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_CONNECTION,
                getString(R.string.channel_connection_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = getString(R.string.channel_connection_desc)
                setShowBadge(false)
            }
        )

        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ATTENTION,
                getString(R.string.channel_attention_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = getString(R.string.channel_attention_desc)
                enableVibration(true)
            }
        )
    }

    private fun openAppIntent(sessionId: String? = null): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            sessionId?.let { putExtra("openSession", it) }
        }
        return PendingIntent.getActivity(
            this,
            sessionId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun ongoingNotification(panelName: String, connected: Boolean): Notification =
        NotificationCompat.Builder(this, CHANNEL_CONNECTION)
            .setContentTitle(if (connected) "Connected to $panelName" else "Reconnecting to $panelName")
            .setContentText(if (connected) "Watching for sessions that need you" else "Waiting for the panel")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(openAppIntent())
            .build()

    private fun raiseAttention(event: PanelEvent.Attention) {
        val session = PanelBus.sessions.value.firstOrNull { it.id == event.sessionId }
        val notification = NotificationCompat.Builder(this, CHANNEL_ATTENTION)
            .setContentTitle(event.text)
            .setContentText(session?.label ?: "Claude session")
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openAppIntent(event.sessionId))
            .build()

        notify(ATTENTION_BASE_ID + (attentionCounter++ % 8), notification)
    }

    private fun notify(id: Int, notification: Notification) {
        try {
            NotificationManagerCompat.from(this).notify(id, notification)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS not granted. The in-app banner still shows.
        }
    }

    private fun shutdown() {
        client?.disconnect()
        client = null
        PanelBus.reset()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        client?.disconnect()
        PanelBus.reset()
        super.onDestroy()
    }
}
