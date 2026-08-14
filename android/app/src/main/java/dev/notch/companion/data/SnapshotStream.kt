package dev.notch.companion.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Request
import org.json.JSONObject

sealed interface StreamEvent {
  data class Update(val snapshot: Snapshot) : StreamEvent
  data class Disconnected(val reason: String) : StreamEvent
  /** The desktop revoked this device; the UI must fall back to pairing. */
  data object Unauthorized : StreamEvent
}

/**
 * Reads GET /api/v1/events, which is Server-Sent Events, not a WebSocket.
 *
 * Hand-parsed rather than pulled from a library: the bridge emits exactly one
 * event name (`snapshot`) plus `: heartbeat` comment lines, so the general case
 * of the SSE grammar — retry hints, multi-line data, last-event-id — is not in
 * play and would only add a dependency.
 */
fun NotchClient.snapshotStream(): Flow<StreamEvent> = callbackFlow {
  val job = launch {
    var backoffMs = 1_000L
    while (isActive) {
      var call: okhttp3.Call? = null
      try {
        val request: Request = request("/events")
          .get()
          .header("Accept", "text/event-stream")
          .header("Cache-Control", "no-cache")
          .build()
        call = httpClient().newCall(request)
        call.execute().use { response ->
          if (response.code == 401) {
            trySend(StreamEvent.Unauthorized)
            return@launch
          }
          if (!response.isSuccessful) error("HTTP ${response.code}")

          val source = response.body?.source() ?: error("empty stream")
          // A live connection resets the backoff, so a desktop that drops once
          // an hour does not creep toward the ceiling over a long day.
          backoffMs = 1_000L
          var event: String? = null
          val data = StringBuilder()

          while (isActive && !source.exhausted()) {
            val line = source.readUtf8LineStrict()
            when {
              // Comment — the 20s heartbeat. Proves liveness, carries nothing.
              line.startsWith(":") -> Unit
              line.startsWith("event:") -> event = line.removePrefix("event:").trim()
              line.startsWith("data:") -> data.append(line.removePrefix("data:").trim())
              // Blank line terminates one event.
              line.isEmpty() -> {
                if (event == "snapshot" && data.isNotEmpty()) {
                  runCatching { Snapshot.from(JSONObject(data.toString())) }
                    .onSuccess { trySend(StreamEvent.Update(it)) }
                }
                event = null
                data.setLength(0)
              }
            }
          }
        }
        trySend(StreamEvent.Disconnected("Connection closed."))
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: Throwable) {
        trySend(StreamEvent.Disconnected(error.message ?: "Cannot reach this computer."))
      } finally {
        call?.cancel()
      }

      if (!isActive) break
      delay(backoffMs)
      backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
    }
  }
  awaitClose { job.cancel() }
}.flowOn(Dispatchers.IO)
