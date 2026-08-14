package dev.notch.companion.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.notch.companion.data.NotchRepository
import kotlinx.coroutines.launch

/**
 * Address + pairing in one screen.
 *
 * They are one step in practice: the QR shown in Notch's Settings tab encodes
 * `http://host:port/#pair=NNNNNN`, so a single scan supplies both halves and
 * the user only names the phone. The manual fields exist for a phone with no
 * working camera, and are pre-filled by a scan so the two paths converge.
 */
@Composable
fun SetupScreen(
  repo: NotchRepository,
  onPaired: () -> Unit
) {
  val scope = rememberCoroutineScope()
  var address by remember { mutableStateOf(repo.store.baseUrl.orEmpty()) }
  var code by remember { mutableStateOf("") }
  var deviceName by remember { mutableStateOf(repo.store.deviceName) }
  var busy by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }
  var probed by remember { mutableStateOf<String?>(null) }

  val scanner = rememberQrScanner { result ->
    error = null
    val parsed = parsePairingUrl(result)
    if (parsed == null) {
      error = "That QR code is not a Notch pairing code."
    } else {
      address = parsed.baseUrl
      parsed.code?.let { code = it }
    }
  }

  Column(
    modifier = Modifier
      .fillMaxSize()
      .verticalScroll(rememberScrollState())
      .padding(24.dp),
    verticalArrangement = Arrangement.spacedBy(16.dp)
  ) {
    Spacer(Modifier.height(24.dp))
    Text("Connect to your computer", style = MaterialTheme.typography.headlineSmall)
    Text(
      "In Notch, open Settings and turn on Allow phone access. Then scan the QR code it shows.",
      style = MaterialTheme.typography.bodyMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant
    )

    Button(
      onClick = { scanner() },
      modifier = Modifier.fillMaxWidth()
    ) { Text("Scan QR code") }

    HorizontalDivider()
    Text("Or enter it by hand", style = MaterialTheme.typography.labelLarge)

    OutlinedTextField(
      value = address,
      onValueChange = { address = it; probed = null },
      label = { Text("Computer address") },
      placeholder = { Text("http://192.168.1.20:47822") },
      singleLine = true,
      keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
      modifier = Modifier.fillMaxWidth()
    )

    OutlinedTextField(
      value = code,
      onValueChange = { code = it.filter(Char::isDigit).take(6) },
      label = { Text("Pairing code") },
      singleLine = true,
      keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
      modifier = Modifier.fillMaxWidth()
    )

    OutlinedTextField(
      value = deviceName,
      onValueChange = { deviceName = it.take(80) },
      label = { Text("Name this phone") },
      singleLine = true,
      modifier = Modifier.fillMaxWidth()
    )

    probed?.let {
      Text("Found $it", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodySmall)
    }
    error?.let {
      Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    }

    Button(
      enabled = !busy && address.isNotBlank() && code.length == 6,
      onClick = {
        busy = true
        error = null
        scope.launch {
          try {
            repo.store.baseUrl = normalizeAddress(address)
            // Probing first turns "wrong address" and "wrong code" into two
            // different messages instead of one confusing pairing failure.
            val status = repo.client.status()
            probed = status.computerName
            repo.client.pair(code, deviceName.ifBlank { "Phone" })
            repo.reconnect()
            onPaired()
          } catch (failure: Throwable) {
            error = failure.message ?: "Could not pair with that computer."
          } finally {
            busy = false
          }
        }
      },
      modifier = Modifier.fillMaxWidth()
    ) {
      if (busy) {
        CircularProgressIndicator(
          modifier = Modifier.size(18.dp),
          strokeWidth = 2.dp,
          color = MaterialTheme.colorScheme.onPrimary
        )
        Spacer(Modifier.width(10.dp))
      }
      Text(if (busy) "Pairing…" else "Pair phone")
    }

    Text(
      "Codes expire after ten minutes. Your phone must be on the same Wi-Fi as the computer.",
      style = MaterialTheme.typography.bodySmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant
    )
    Spacer(Modifier.height(24.dp))
  }
}

data class PairingUrl(val baseUrl: String, val code: String?)

/**
 * Splits the QR payload into origin and pairing code.
 *
 * The desktop puts the code in the fragment precisely so it is never sent to
 * the server; here that means the origin is everything before the `#`, and the
 * code has to be lifted out separately rather than left on the URL.
 */
fun parsePairingUrl(raw: String): PairingUrl? {
  val trimmed = raw.trim()
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return null
  val hashIndex = trimmed.indexOf('#')
  val origin = if (hashIndex >= 0) trimmed.substring(0, hashIndex) else trimmed
  val fragment = if (hashIndex >= 0) trimmed.substring(hashIndex + 1) else ""
  val code = Regex("(?:^|&)pair=(\\d{6})(?:&|$)").find(fragment)?.groupValues?.get(1)
  return PairingUrl(normalizeAddress(origin), code)
}

/** Trims the trailing slash so path joining in NotchClient stays predictable. */
fun normalizeAddress(raw: String): String {
  var value = raw.trim()
  if (!value.startsWith("http://") && !value.startsWith("https://")) value = "http://$value"
  return value.trimEnd('/')
}
