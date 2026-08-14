package dev.notch.companion.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.notch.companion.data.NotchRepository
import dev.notch.companion.data.ProjectOption
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DispatchScreen(
  repo: NotchRepository,
  projects: List<ProjectOption>,
  onBack: () -> Unit,
  onDispatched: () -> Unit
) {
  val scope = rememberCoroutineScope()
  var agent by remember { mutableStateOf("claude") }
  var project by remember { mutableStateOf(projects.firstOrNull()) }
  var prompt by remember { mutableStateOf("") }
  var busy by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }
  var expanded by remember { mutableStateOf(false) }

  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text("New task") },
        navigationIcon = { TextButton(onClick = onBack) { Text("Cancel") } }
      )
    }
  ) { padding ->
    Column(
      modifier = Modifier
        .fillMaxSize()
        .padding(padding)
        .verticalScroll(rememberScrollState())
        .padding(16.dp),
      verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
      Text("Agent", style = MaterialTheme.typography.labelLarge)
      SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        listOf("claude" to "Claude", "codex" to "Codex").forEachIndexed { index, (value, label) ->
          SegmentedButton(
            selected = agent == value,
            onClick = { agent = value },
            shape = SegmentedButtonDefaults.itemShape(index, 2)
          ) { Text(label) }
        }
      }

      Text("Project", style = MaterialTheme.typography.labelLarge)
      // The desktop rejects any cwd outside the list it sent, so this is a
      // picker rather than a text field on purpose — a free-form path would
      // only ever produce a 403.
      ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
          value = project?.name ?: "No projects available",
          onValueChange = {},
          readOnly = true,
          label = { Text("Folder on your computer") },
          trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
          modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable)
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
          projects.forEach { option ->
            DropdownMenuItem(
              text = { Column { Text(option.name); Text(option.path, style = MaterialTheme.typography.bodySmall) } },
              onClick = { project = option; expanded = false }
            )
          }
        }
      }

      OutlinedTextField(
        value = prompt,
        onValueChange = { prompt = it },
        label = { Text("What should it do?") },
        modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp),
        maxLines = 10
      )

      error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }

      Button(
        enabled = !busy && project != null && prompt.isNotBlank(),
        onClick = {
          busy = true
          error = null
          scope.launch {
            try {
              repo.client.dispatch(agent, project!!.path, prompt.trim())
              onDispatched()
            } catch (failure: Throwable) {
              error = failure.message ?: "Could not start that task."
            } finally {
              busy = false
            }
          }
        },
        modifier = Modifier.fillMaxWidth()
      ) { Text(if (busy) "Starting…" else "Start task") }

      Text(
        "Tasks started from your phone run without approval prompts, in the folder you pick.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
      )
    }
  }
}
