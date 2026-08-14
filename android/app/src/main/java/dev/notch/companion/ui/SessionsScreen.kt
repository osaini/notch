package dev.notch.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.notch.companion.data.Connection
import dev.notch.companion.data.SessionStatus
import dev.notch.companion.data.SessionSummary
import dev.notch.companion.data.Snapshot

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
  snapshot: Snapshot?,
  connection: Connection,
  error: String?,
  onOpen: (SessionSummary) -> Unit,
  onDispatch: () -> Unit,
  onSettings: () -> Unit
) {
  Scaffold(
    topBar = {
      TopAppBar(
        title = {
          Column {
            Text(snapshot?.computerName ?: "Notch", maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
              connectionLabel(connection, error),
              style = MaterialTheme.typography.labelSmall,
              color = if (connection == Connection.ONLINE) {
                MaterialTheme.colorScheme.onSurfaceVariant
              } else {
                MaterialTheme.colorScheme.error
              }
            )
          }
        },
        actions = {
          TextButton(onClick = onSettings) { Text("Settings") }
        }
      )
    },
    floatingActionButton = {
      ExtendedFloatingActionButton(
        onClick = onDispatch,
        text = { Text("New task") },
        icon = {}
      )
    }
  ) { padding ->
    val sessions = snapshot?.sessions.orEmpty()
      // Anything waiting on a human goes to the top; that is the whole reason
      // to pick up the phone.
      .sortedWith(compareBy({ it.status != SessionStatus.NEEDS_INPUT }, { -it.updatedAt }))

    if (sessions.isEmpty()) {
      Box(
        modifier = Modifier.fillMaxSize().padding(padding).padding(32.dp),
        contentAlignment = Alignment.Center
      ) {
        Text(
          when (connection) {
            Connection.ONLINE -> "No agent sessions running."
            Connection.CONNECTING -> "Connecting to your computer…"
            Connection.UNPAIRED -> "This phone is no longer paired."
            Connection.OFFLINE -> "Not connected."
          },
          color = MaterialTheme.colorScheme.onSurfaceVariant
        )
      }
      return@Scaffold
    }

    LazyColumn(
      modifier = Modifier.fillMaxSize().padding(padding),
      contentPadding = PaddingValues(bottom = 88.dp)
    ) {
      items(sessions, key = { it.key }) { session ->
        SessionRow(session, onClick = { onOpen(session) })
        HorizontalDivider(color = MaterialTheme.colorScheme.outline)
      }
    }
  }
}

@Composable
private fun SessionRow(session: SessionSummary, onClick: () -> Unit) {
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .clickable(onClick = onClick)
      .padding(horizontal = 16.dp, vertical = 14.dp),
    verticalAlignment = Alignment.CenterVertically
  ) {
    Box(
      modifier = Modifier
        .size(10.dp)
        .clip(CircleShape)
        .background(statusColor(session.status))
    )
    Spacer(Modifier.width(12.dp))
    Column(Modifier.weight(1f)) {
      Text(
        session.name,
        style = MaterialTheme.typography.bodyLarge,
        fontWeight = FontWeight.Medium,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis
      )
      Text(
        listOf(session.project, session.detail).filter { it.isNotBlank() }.joinToString(" · "),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis
      )
    }
    Spacer(Modifier.width(8.dp))
    Text(
      session.status.label,
      style = MaterialTheme.typography.labelSmall,
      color = statusColor(session.status)
    )
  }
}

private fun connectionLabel(connection: Connection, error: String?): String = when (connection) {
  Connection.ONLINE -> "Connected"
  Connection.CONNECTING -> error ?: "Reconnecting…"
  Connection.UNPAIRED -> "Not paired"
  Connection.OFFLINE -> "Offline"
}
