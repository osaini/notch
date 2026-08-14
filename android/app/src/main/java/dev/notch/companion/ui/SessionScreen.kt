package dev.notch.companion.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.notch.companion.data.Message
import dev.notch.companion.data.NotchRepository
import dev.notch.companion.data.SessionSummary
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionScreen(
  repo: NotchRepository,
  session: SessionSummary,
  onBack: () -> Unit
) {
  val scope = rememberCoroutineScope()
  var messages by remember { mutableStateOf<List<Message>>(emptyList()) }
  var draft by remember { mutableStateOf("") }
  var sending by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }
  val listState = rememberLazyListState()

  // The transcript has no push channel of its own — the SSE stream carries
  // session status, not message bodies — so this polls while the screen is up.
  LaunchedEffect(session.key) {
    while (true) {
      runCatching { repo.client.messages(session.key) }
        .onSuccess { fetched ->
          val grew = fetched.size > messages.size
          messages = fetched
          if (grew && fetched.isNotEmpty()) listState.animateScrollToItem(fetched.lastIndex)
        }
        .onFailure { error = it.message }
      delay(4_000)
    }
  }

  Scaffold(
    topBar = {
      TopAppBar(
        title = {
          Column {
            Text(session.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
              "${session.agent} · ${session.status.label}",
              style = MaterialTheme.typography.labelSmall,
              color = statusColor(session.status)
            )
          }
        },
        navigationIcon = { TextButton(onClick = onBack) { Text("Back") } }
      )
    },
    bottomBar = {
      Column {
        error?.let {
          Text(
            it,
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
          )
        }
        Row(
          modifier = Modifier
            .fillMaxWidth()
            .padding(12.dp),
          verticalAlignment = Alignment.Bottom
        ) {
          OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
            modifier = Modifier.weight(1f),
            placeholder = {
              Text(if (session.canMessage) "Send a follow-up" else "This session is read-only")
            },
            enabled = session.canMessage && !sending,
            maxLines = 4
          )
          Spacer(Modifier.width(8.dp))
          Button(
            enabled = session.canMessage && !sending && draft.isNotBlank(),
            onClick = {
              val text = draft.trim()
              sending = true
              error = null
              scope.launch {
                try {
                  repo.client.sendMessage(session.key, text)
                  draft = ""
                  messages = runCatching { repo.client.messages(session.key) }.getOrDefault(messages)
                } catch (failure: Throwable) {
                  error = failure.message ?: "Could not send that."
                } finally {
                  sending = false
                }
              }
            }
          ) { Text(if (sending) "…" else "Send") }
        }
      }
    }
  ) { padding ->
    if (messages.isEmpty()) {
      Box(
        modifier = Modifier.fillMaxSize().padding(padding),
        contentAlignment = Alignment.Center
      ) {
        Text("No messages yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
      return@Scaffold
    }
    LazyColumn(
      state = listState,
      modifier = Modifier.fillMaxSize().padding(padding),
      contentPadding = PaddingValues(16.dp),
      verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
      items(messages, key = { it.id }) { message -> MessageBubble(message) }
    }
  }
}

@Composable
private fun MessageBubble(message: Message) {
  val fromUser = message.role == "user"
  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = if (fromUser) Arrangement.End else Arrangement.Start
  ) {
    Surface(
      color = if (fromUser) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
      contentColor = if (fromUser) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
      shape = RoundedCornerShape(12.dp),
      modifier = Modifier.widthIn(max = 300.dp)
    ) {
      Text(
        message.text,
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        style = MaterialTheme.typography.bodyMedium
      )
    }
  }
}
