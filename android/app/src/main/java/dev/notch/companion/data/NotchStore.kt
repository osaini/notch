package dev.notch.companion.data

import android.content.Context
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

/**
 * Where this phone points and what it uses to prove it is paired.
 *
 * Plain SharedPreferences, deliberately. The device token is not a password: it
 * is a revocable, 30-day, per-device credential that already crosses the LAN in
 * cleartext on every request, so encrypting it at rest would protect it from
 * nothing that can't already read it off the wire. "Unpair all phones" on the
 * desktop is the real revocation story.
 */
class NotchStore(context: Context) {
  private val prefs = context.applicationContext
    .getSharedPreferences("notch", Context.MODE_PRIVATE)

  var baseUrl: String?
    get() = prefs.getString(KEY_BASE_URL, null)
    set(value) = prefs.edit().putString(KEY_BASE_URL, value).apply()

  var deviceToken: String?
    get() = prefs.getString(KEY_TOKEN, null)
    set(value) = prefs.edit().putString(KEY_TOKEN, value).apply()

  var deviceName: String
    get() = prefs.getString(KEY_DEVICE_NAME, null) ?: android.os.Build.MODEL ?: "Phone"
    set(value) = prefs.edit().putString(KEY_DEVICE_NAME, value).apply()

  /** Forgets the pairing but keeps the address, so re-pairing is one screen. */
  fun clearPairing() {
    prefs.edit().remove(KEY_TOKEN).apply()
  }

  fun clearAll() {
    prefs.edit().clear().apply()
  }

  private companion object {
    const val KEY_BASE_URL = "baseUrl"
    const val KEY_TOKEN = "deviceToken"
    const val KEY_DEVICE_NAME = "deviceName"
  }
}

/**
 * Persists exactly one cookie: `notch_device`.
 *
 * OkHttp's default jar is in-memory, which would drop the pairing on every
 * process death — and a foreground service does die and restart. Storing the
 * token ourselves and re-attaching it means the app comes back paired.
 */
class NotchCookieJar(private val store: NotchStore) : CookieJar {

  override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
    cookies.firstOrNull { it.name == COOKIE }?.let { cookie ->
      // Max-Age=0 is how the bridge signals an unpair.
      if (cookie.value.isEmpty()) store.clearPairing() else store.deviceToken = cookie.value
    }
  }

  override fun loadForRequest(url: HttpUrl): List<Cookie> {
    val token = store.deviceToken ?: return emptyList()
    return listOf(
      Cookie.Builder()
        .name(COOKIE)
        .value(token)
        .domain(url.host)
        .path("/")
        .build()
    )
  }

  private companion object {
    const val COOKIE = "notch_device"
  }
}
