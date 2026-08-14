package dev.notch.companion.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** A bridge error carrying the HTTP status, so callers can react to 401 vs 409. */
class BridgeException(val status: Int, message: String) : IOException(message)

internal fun remotePairingIsAlreadyGone(status: Int): Boolean = status == 401

/** Plain HTTP is restricted to local/private address space. */
internal fun isPrivateBridgeHost(host: String): Boolean {
  if (host.equals("localhost", ignoreCase = true) || host == "::1") return true

  val octets = host.split('.').map { it.toIntOrNull() }
  if (octets.size != 4 || octets.any { it == null || it !in 0..255 }) return false
  val first = octets[0]!!
  val second = octets[1]!!
  return first == 10 ||
    (first == 172 && second in 16..31) ||
    (first == 192 && second == 168) ||
    (first == 100 && second in 64..127) ||
    first == 127
}

/**
 * Client for the /api/v1 surface documented in docs/mobile-bridge.md.
 *
 * Note there is no Origin header on any of these requests. The bridge's
 * assertSafeOrigin() returns early when Origin is absent, which is what lets a
 * native client post to the same routes the browser client does — the check
 * exists to stop *other web pages* forging requests, and there is no browser
 * here to forge one.
 */
class NotchClient(private val store: NotchStore) {

  private val http = OkHttpClient.Builder()
    .cookieJar(NotchCookieJar(store))
    // The desktop bridge has no redirect contract. Following one would bypass
    // the base-URL policy below and could re-scope the pairing cookie.
    .followRedirects(false)
    .followSslRedirects(false)
    .connectTimeout(6, TimeUnit.SECONDS)
    .writeTimeout(15, TimeUnit.SECONDS)
    // The SSE stream is deliberately never idle for longer than the bridge's
    // 20s heartbeat comment, so a 60s read timeout detects a dead desktop
    // without cutting a healthy stream.
    .readTimeout(60, TimeUnit.SECONDS)
    .retryOnConnectionFailure(true)
    .build()

  /** Exposed so the SSE reader can share the connection pool and cookie jar. */
  fun httpClient(): OkHttpClient = http

  fun baseUrl(): String? = store.baseUrl

  private fun url(path: String): String {
    val base = store.baseUrl?.trimEnd('/')
      ?: throw BridgeException(0, "No computer address set yet.")
    val parsed = base.toHttpUrlOrNull()
      ?: throw BridgeException(0, "That computer address is not a valid URL.")
    if (parsed.scheme == "http" && !isPrivateBridgeHost(parsed.host)) {
      throw BridgeException(
        0,
        "Plain HTTP is allowed only for a private LAN or Tailscale address. Use HTTPS for public hosts."
      )
    }
    return "$base/api/v1$path"
  }

  /**
   * Android's network-security config cannot express IP ranges. Keep the
   * transport permission broad enough for private addresses, then apply the
   * actual policy here before OkHttp opens a socket.
   */
  fun request(path: String): Request.Builder = Request.Builder().url(url(path))

  private suspend fun call(request: Request): String = withContext(Dispatchers.IO) {
    http.newCall(request).execute().use { response -> body(response) }
  }

  private fun body(response: Response): String {
    val text = response.body?.string().orEmpty()
    if (response.isSuccessful) return text
    // The bridge reports failures as {"error": "..."} in prose meant for humans.
    val message = runCatching { JSONObject(text).optString("error") }
      .getOrNull()
      ?.takeIf { it.isNotBlank() }
      ?: "Request failed (HTTP ${response.code})."
    throw BridgeException(response.code, message)
  }

  private fun json(payload: JSONObject) =
    payload.toString().toRequestBody("application/json; charset=utf-8".toMediaType())

  // --- unauthenticated -----------------------------------------------------

  /** Also serves as the reachability probe on the setup screen. */
  suspend fun status(): BridgeStatus =
    BridgeStatus.from(JSONObject(call(request("/status").get().build())))

  suspend fun pair(code: String, deviceName: String) {
    val payload = JSONObject()
      .put("code", code)
      .put("deviceName", deviceName)
    call(request("/pair").post(json(payload)).build())
    store.deviceName = deviceName
  }

  // --- paired --------------------------------------------------------------

  suspend fun unpair() {
    // Keep the credential if desktop revocation fails. It is the only token
    // that can retry the device-specific DELETE, and the UI promises that
    // unpairing removes this phone from the computer as well as locally.
    try {
      call(request("/pair").delete().build())
    } catch (failure: BridgeException) {
      // A 401 means the desktop already removed or expired this device, so
      // there is nothing remote left to retry. Network and server failures keep
      // the credential so the same DELETE can be attempted again.
      if (!remotePairingIsAlreadyGone(failure.status)) throw failure
    }
    store.clearPairing()
  }

  suspend fun snapshot(): Snapshot =
    Snapshot.from(JSONObject(call(request("/snapshot").get().build())))

  suspend fun messages(key: String): List<Message> {
    val encoded = java.net.URLEncoder.encode(key, "UTF-8")
    val text = call(request("/sessions/$encoded/messages").get().build())
    return org.json.JSONArray(text).map(Message::from)
  }

  suspend fun sendMessage(key: String, text: String) {
    val encoded = java.net.URLEncoder.encode(key, "UTF-8")
    val payload = JSONObject().put("text", text)
    call(request("/sessions/$encoded/messages").post(json(payload)).build())
  }

  suspend fun dispatch(agent: String, cwd: String, prompt: String) {
    val payload = JSONObject()
      .put("agent", agent)
      .put("cwd", cwd)
      .put("prompt", prompt)
    call(request("/dispatch").post(json(payload)).build())
  }
}
