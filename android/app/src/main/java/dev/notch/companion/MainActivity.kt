package dev.notch.companion

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.notch.companion.data.NotchRepository
import dev.notch.companion.service.NotchService
import dev.notch.companion.ui.*

/** Screens, kept as a sealed type instead of pulling in navigation-compose. */
private sealed interface Screen {
  data object Setup : Screen
  data object Sessions : Screen
  data object Dispatch : Screen
  data object Settings : Screen
  data class Detail(val sessionKey: String) : Screen
}

private val ScreenSaver = listSaver<Screen, String>(
  save = { screen ->
    when (screen) {
      Screen.Setup -> listOf("setup")
      Screen.Sessions -> listOf("sessions")
      Screen.Dispatch -> listOf("dispatch")
      Screen.Settings -> listOf("settings")
      is Screen.Detail -> listOf("detail", screen.sessionKey)
    }
  },
  restore = { saved ->
    when (saved.firstOrNull()) {
      "setup" -> Screen.Setup
      "dispatch" -> Screen.Dispatch
      "settings" -> Screen.Settings
      "detail" -> saved.getOrNull(1)?.let(Screen::Detail) ?: Screen.Sessions
      else -> Screen.Sessions
    }
  }
)

class MainActivity : ComponentActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val repo = NotchRepository.get(this)

    setContent {
      NotchTheme {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
          App(repo)
        }
      }
    }
  }

  override fun onStart() {
    super.onStart()
    // Reconnecting on every foreground makes the list correct after the phone
    // has been asleep, whether or not the background service is enabled.
    NotchRepository.get(this).apply {
      setActivityVisible(true)
      connect()
    }
  }

  override fun onStop() {
    val repo = NotchRepository.get(this)
    repo.setActivityVisible(false)
    // With background watching off, the visible activity is the only owner of
    // the SSE stream. Do not quietly keep it alive after the user leaves.
    if (!prefsWatching(this)) repo.disconnect()
    super.onStop()
  }
}

@Composable
private fun App(repo: NotchRepository) {
  val context = androidx.compose.ui.platform.LocalContext.current
  val snapshot by repo.snapshot.collectAsStateWithLifecycle()
  val connection by repo.connection.collectAsStateWithLifecycle()
  val error by repo.error.collectAsStateWithLifecycle()

  var screen by rememberSaveable(stateSaver = ScreenSaver) {
    mutableStateOf<Screen>(if (repo.isPaired()) Screen.Sessions else Screen.Setup)
  }
  var watching by remember {
    mutableStateOf(prefsWatching(context) && canPostNotifications(context))
  }

  val lifecycleOwner = LocalLifecycleOwner.current
  DisposableEffect(lifecycleOwner) {
    val observer = LifecycleEventObserver { _, event ->
      if (event != Lifecycle.Event.ON_START) return@LifecycleEventObserver
      val enabled = prefsWatching(context) && canPostNotifications(context)
      if (!enabled && prefsWatching(context)) {
        // Permission can be revoked in system settings while the activity is
        // stopped. Reconcile the app switch and service on the next foreground.
        setPrefsWatching(context, false)
        NotchService.stop(context)
      }
      watching = enabled
    }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
  }

  LaunchedEffect(Unit) {
    // Also reconcile immediately in case composition starts after ON_START on
    // an activity recreation and the observer does not see that first event.
    if (prefsWatching(context) && !canPostNotifications(context)) {
      setPrefsWatching(context, false)
      NotchService.stop(context)
      watching = false
    }
  }

  val notificationPermission = rememberLauncherForActivityResult(
    ActivityResultContracts.RequestPermission()
  ) { granted ->
    // Denying the permission leaves the service pointless, so don't start it.
    if (granted) {
      setPrefsWatching(context, true)
      watching = true
      NotchService.start(context)
    } else {
      setPrefsWatching(context, false)
      watching = false
    }
  }

  fun setWatching(enabled: Boolean) {
    if (!enabled) {
      setPrefsWatching(context, false)
      watching = false
      NotchService.stop(context)
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    } else {
      setPrefsWatching(context, true)
      watching = true
      NotchService.start(context)
    }
  }

  // A paired phone with watching on should have the service running even after
  // a reboot brought the activity up cold.
  LaunchedEffect(watching, repo.isPaired()) {
    if (watching && repo.isPaired()) NotchService.start(context)
  }

  // The desktop can revoke this device at any time; when it does, fall back to
  // the setup screen rather than showing an empty list forever.
  LaunchedEffect(connection) {
    if (connection == dev.notch.companion.data.Connection.UNPAIRED) screen = Screen.Setup
  }

  BackHandler(enabled = screen != Screen.Setup && screen != Screen.Sessions) {
    screen = Screen.Sessions
  }

  when (val current = screen) {
    Screen.Setup -> SetupScreen(
      repo = repo,
      onPaired = {
        screen = Screen.Sessions
        if (watching) NotchService.start(context)
      }
    )

    Screen.Sessions -> SessionsScreen(
      snapshot = snapshot,
      connection = connection,
      error = error,
      onOpen = { screen = Screen.Detail(it.key) },
      onDispatch = { screen = Screen.Dispatch },
      onSettings = { screen = Screen.Settings }
    )

    Screen.Dispatch -> DispatchScreen(
      repo = repo,
      projects = snapshot?.projects.orEmpty(),
      onBack = { screen = Screen.Sessions },
      onDispatched = { screen = Screen.Sessions }
    )

    Screen.Settings -> SettingsScreen(
      repo = repo,
      connection = connection,
      watching = watching,
      onWatchingChange = ::setWatching,
      onBack = { screen = Screen.Sessions },
      onForgotten = {
        NotchService.stop(context)
        screen = Screen.Setup
      }
    )

    is Screen.Detail -> {
      // Re-read the session from the live snapshot so its status keeps updating
      // while the transcript is open.
      val live = snapshot?.sessions?.firstOrNull { it.key == current.sessionKey }
      LaunchedEffect(snapshot, current.sessionKey) {
        if (snapshot != null && live == null) screen = Screen.Sessions
      }
      if (live != null) {
        SessionScreen(
          repo = repo,
          session = live,
          onBack = { screen = Screen.Sessions }
        )
      } else if (snapshot == null) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
          CircularProgressIndicator()
        }
      }
    }
  }
}

private const val PREFS = "notch-ui"
private const val KEY_WATCHING = "watching"

internal fun prefsWatching(context: Context): Boolean =
  context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_WATCHING, false)

internal fun setPrefsWatching(context: Context, value: Boolean) {
  context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    .edit().putBoolean(KEY_WATCHING, value).apply()
}

internal fun canPostNotifications(context: Context): Boolean =
  Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
    ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
      PackageManager.PERMISSION_GRANTED
