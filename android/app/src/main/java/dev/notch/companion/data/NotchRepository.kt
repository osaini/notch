package dev.notch.companion.data

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class Connection { OFFLINE, CONNECTING, ONLINE, UNPAIRED }

/**
 * One process-wide bridge connection.
 *
 * The activity and the foreground service both need the same live snapshot, and
 * opening two SSE streams would double the desktop's broadcast work and let the
 * two disagree about which sessions need input. A singleton owned by the
 * Application keeps exactly one stream alive for as long as either wants it.
 */
class NotchRepository private constructor(context: Context) {

  val store = NotchStore(context)
  val client = NotchClient(store)

  private val scope = CoroutineScope(SupervisorJob())
  private var streamJob: kotlinx.coroutines.Job? = null
  @Volatile private var activityVisible = false

  private val _snapshot = MutableStateFlow<Snapshot?>(null)
  val snapshot: StateFlow<Snapshot?> = _snapshot.asStateFlow()

  private val _connection = MutableStateFlow(Connection.OFFLINE)
  val connection: StateFlow<Connection> = _connection.asStateFlow()

  private val _error = MutableStateFlow<String?>(null)
  val error: StateFlow<String?> = _error.asStateFlow()

  fun isConfigured(): Boolean = store.baseUrl != null
  fun isPaired(): Boolean = store.deviceToken != null

  fun setActivityVisible(visible: Boolean) {
    activityVisible = visible
  }

  fun hasVisibleActivity(): Boolean = activityVisible

  /** Idempotent: repeated calls keep the single existing stream. */
  fun connect() {
    if (streamJob?.isActive == true) return
    if (!isConfigured() || !isPaired()) {
      _connection.value = if (isConfigured()) Connection.UNPAIRED else Connection.OFFLINE
      return
    }
    _connection.value = Connection.CONNECTING
    streamJob = scope.launch {
      client.snapshotStream().collect { event ->
        when (event) {
          is StreamEvent.Update -> {
            _snapshot.value = event.snapshot
            _connection.value = Connection.ONLINE
            _error.value = null
          }
          is StreamEvent.Disconnected -> {
            _connection.value = Connection.CONNECTING
            _error.value = event.reason
          }
          StreamEvent.Unauthorized -> {
            store.clearPairing()
            _snapshot.value = null
            _connection.value = Connection.UNPAIRED
            _error.value = "This phone is no longer paired."
          }
        }
      }
    }
  }

  fun disconnect() {
    streamJob?.cancel()
    streamJob = null
    _connection.value = Connection.OFFLINE
  }

  /** Drops the stream and reopens it — used after pairing or changing address. */
  fun reconnect() {
    disconnect()
    connect()
  }

  suspend fun forget() {
    client.unpair()
    disconnect()
    _snapshot.value = null
    store.clearAll()
    _connection.value = Connection.OFFLINE
  }

  companion object {
    @Volatile private var instance: NotchRepository? = null

    fun get(context: Context): NotchRepository =
      instance ?: synchronized(this) {
        instance ?: NotchRepository(context.applicationContext).also { instance = it }
      }
  }
}
