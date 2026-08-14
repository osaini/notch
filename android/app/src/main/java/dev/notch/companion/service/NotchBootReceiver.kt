package dev.notch.companion.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.notch.companion.canPostNotifications
import dev.notch.companion.data.NotchRepository
import dev.notch.companion.prefsWatching

internal fun shouldStartWatcherAfterBoot(
  watching: Boolean,
  canPostNotifications: Boolean,
  configured: Boolean,
  paired: Boolean
): Boolean = watching && canPostNotifications && configured && paired

/** Restores the explicitly enabled watcher after a full device reboot. */
class NotchBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    val repo = NotchRepository.get(context)
    if (
      shouldStartWatcherAfterBoot(
        watching = prefsWatching(context),
        canPostNotifications = canPostNotifications(context),
        configured = repo.isConfigured(),
        paired = repo.isPaired()
      )
    ) {
      NotchService.start(context)
    }
  }
}
