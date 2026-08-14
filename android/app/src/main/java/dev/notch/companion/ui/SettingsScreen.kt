package dev.notch.companion.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.notch.companion.data.Connection
import dev.notch.companion.data.NotchRepository
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
  repo: NotchRepository,
  connection: Connection,
  watching: Boolean,
  onWatchingChange: (Boolean) -> Unit,
  onBack: () -> Unit,
  onForgotten: () -> Unit
) {
  val scope = rememberCoroutineScope()
  var busy by remember { mutableStateOf(false) }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("Settings") },
        navigationIcon = { TextButton(onClick = onBack) { Text("Back") } }
      )
    }
  ) { padding ->
    Column(
      modifier = Modifier
        .fillMaxSize()
        .padding(padding)
        .verticalScroll(rememberScrollState())
        .padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(20.dp)
    ) {
      ListItem(
        headlineContent = { Text("Computer") },
        supportingContent = { Text(repo.store.baseUrl ?: "Not set") }
      )
      ListItem(
        headlineContent = { Text("Connection") },
        supportingContent = {
          Text(
            when (connection) {
              Connection.ONLINE -> "Connected"
              Connection.CONNECTING -> "Reconnecting"
              Connection.UNPAIRED -> "Not paired"
              Connection.OFFLINE -> "Offline"
            }
          )
        }
      )

      HorizontalDivider()

      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically
      ) {
        Column(Modifier.weight(1f)) {
          Text("Notify me when an agent needs input", style = MaterialTheme.typography.bodyLarge)
          Text(
            "Keeps a connection open in the background. Shows an ongoing notification, " +
              "which Android requires for this.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
          )
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = watching, onCheckedChange = onWatchingChange)
      }

      HorizontalDivider()

      OutlinedButton(
        enabled = !busy,
        onClick = {
          busy = true
          scope.launch {
            runCatching { repo.forget() }
            busy = false
            onForgotten()
          }
        },
        modifier = Modifier.fillMaxWidth()
      ) { Text("Unpair this phone") }

      Text(
        "Unpairing also tells the computer to forget this device. You can revoke it from " +
          "Notch's Settings tab at any time with Unpair all phones.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
      )
    }
  }
}
