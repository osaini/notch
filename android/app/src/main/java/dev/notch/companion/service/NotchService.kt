package dev.notch.companion.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import dev.notch.companion.MainActivity
import dev.notch.companion.R
import dev.notch.companion.canPostNotifications
import dev.notch.companion.setPrefsWatching
import dev.notch.companion.data.Connection
import dev.notch.companion.data.NotchRepository
import dev.notch.companion.data.SessionStatus
import dev.notch.companion.data.SessionSummary
import dev.notch.companion.data.Snapshot
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

internal fun waitingSessions(
  snapshot: Snapshot?,
  connection: Connection
): List<SessionSummary> =
  if (connection == Connection.ONLINE) {
    snapshot?.sessions.orEmpty().filter { it.status == SessionStatus.NEEDS_INPUT }
  } else {
    emptyList()
  }

/**
 * Holds the SSE connection while the app is in the background and raises a
 * notification the moment a session starts waiting on a human.
 *
 * This is the entire reason the native client exists. An installed PWA cannot
 * do it: Web Push needs a cloud push service to deliver through, and this
 * bridge is a LAN-only server with no internet presence to route from. A
 * foreground service is the supported way to keep a socket open on modern
 * Android, and the ongoing notification it requires is the honest disclosure
 * that something is holding a connection.
 */
class NotchService : LifecycleService() {

  private val repo by lazy { NotchRepository.get(this) }

  /**
   * Sessions already announced. Without this every snapshot broadcast — one per
   * file-watcher tick — would re-post the same alert and the phone would buzz
   * continuously while a session sits waiting.
   */
  private val announced = mutableSetOf<String>()

  override fun onCreate() {
    super.onCreate()
    createChannels()
    ServiceCompat.startForeground(
      this,
      ONGOING_ID,
      ongoingNotification("Connecting…"),
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
      } else {
        0
      }
    )

    repo.connect()

    lifecycleScope.launch {
      combine(repo.snapshot, repo.connection) { snapshot, connection -> snapshot to connection }
        .collect { (snapshot, connection) ->
          if (!canPostNotifications(this@NotchService)) {
            // Permission can be revoked while the activity is away. Stop at
            // the next stream/connection update instead of retaining a watcher
            // that is no longer capable of alerting the user.
            setPrefsWatching(this@NotchService, false)
            stopSelf()
            return@collect
          }
          // A retained snapshot is only authoritative while the stream is
          // online. Reconnect starts from CONNECTING and must wait for a fresh
          // update before it can alert.
          val waiting = waitingSessions(snapshot, connection)

          if (connection == Connection.ONLINE) {
            for (session in waiting) {
              if (
                session.key !in announced &&
                notifyNeedsInput(session.key, session.name, session.project)
              ) announced.add(session.key)
            }
            // Only a fresh online snapshot can prove an earlier alert resolved.
            // Keeping it through a disconnect also prevents a reconnect from
            // turning the same unresolved request into a second audible alert.
            val stillWaiting = waiting.map { it.key }.toSet()
            val resolved = announced - stillWaiting
            announced.removeAll(resolved)
            resolved.forEach {
              NotificationManagerCompat.from(this@NotchService).cancel(it.hashCode())
            }
          }

          updateOngoing(snapshot?.computerName, connection, waiting.size)
          // Revocation leaves nothing for a background watcher to do. Staying
          // sticky here would show a permanent "Not paired" notification and
          // retain a dead stream until the user explicitly opened the app.
          if (connection == Connection.UNPAIRED) stopSelf()
        }
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    super.onStartCommand(intent, flags, startId)
    // Restart if the system kills us: the point is to be listening.
    return START_STICKY
  }

  override fun onDestroy() {
    // The repository is process-wide. Keep its stream only when the activity
    // is visibly using it; otherwise a stopped/killed notification service
    // must release the connection it owned.
    if (!repo.hasVisibleActivity()) repo.disconnect()
    super.onDestroy()
  }

  private fun createChannels() {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ONGOING, "Connection", NotificationManager.IMPORTANCE_MIN).apply {
        description = "Shows that Notch is watching your computer."
        setShowBadge(false)
      }
    )
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ALERTS, "Needs input", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "An agent on your computer is waiting for an answer."
        enableVibration(true)
      }
    )
  }

  private fun contentIntent(): PendingIntent = PendingIntent.getActivity(
    this,
    0,
    Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
  )

  private fun ongoingNotification(text: String): Notification =
    NotificationCompat.Builder(this, CHANNEL_ONGOING)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle("Notch")
      .setContentText(text)
      .setContentIntent(contentIntent())
      .setOngoing(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .build()

  private fun updateOngoing(computer: String?, connection: Connection, waiting: Int) {
    val text = when (connection) {
      Connection.ONLINE -> buildString {
        append(computer ?: "Connected")
        if (waiting > 0) append(" · $waiting waiting")
      }
      Connection.CONNECTING -> "Reconnecting…"
      Connection.UNPAIRED -> "Not paired"
      Connection.OFFLINE -> "Offline"
    }
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
        PackageManager.PERMISSION_GRANTED
    ) return
    runCatching {
      NotificationManagerCompat.from(this).notify(ONGOING_ID, ongoingNotification(text))
    }
  }

  private fun notifyNeedsInput(key: String, name: String, project: String): Boolean {
    val notification = NotificationCompat.Builder(this, CHANNEL_ALERTS)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle("$name needs input")
      .setContentText(project.ifBlank { "Waiting for an answer" })
      .setContentIntent(contentIntent())
      .setAutoCancel(true)
      // A sticky service may recreate while the same notification id is still
      // present. Updating it must not buzz the user a second time.
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .build()
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
        PackageManager.PERMISSION_GRANTED
    ) return false
    return runCatching {
      NotificationManagerCompat.from(this).notify(key.hashCode(), notification)
      true
    }.getOrDefault(false)
  }

  companion object {
    private const val CHANNEL_ONGOING = "notch.connection"
    private const val CHANNEL_ALERTS = "notch.alerts"
    private const val ONGOING_ID = 1

    fun start(context: Context) {
      val intent = Intent(context, NotchService::class.java)
      runCatching { context.startForegroundService(intent) }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, NotchService::class.java))
    }
  }
}
