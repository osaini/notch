package dev.notch.companion.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * Mirrors of the bridge payloads in src/main/mobileBridge.ts.
 *
 * Parsed by hand with org.json rather than a serialization library: the shapes
 * are small and stable, and every field is read defensively so a desktop
 * running a newer or older Notch degrades instead of throwing.
 */

/** Matches MobileStatus in mobileBridge.ts. */
enum class SessionStatus(val wire: String, val label: String) {
  WORKING("working", "Working"),
  IDLE("idle", "Idle"),
  NEEDS_INPUT("needs-input", "Needs input"),
  REVIEWING("reviewing", "Reviewing"),
  UNKNOWN("unknown", "Unknown");

  companion object {
    fun from(value: String?): SessionStatus =
      entries.firstOrNull { it.wire == value } ?: UNKNOWN
  }
}

data class SessionSummary(
  val key: String,
  val agent: String,
  val name: String,
  val project: String,
  val path: String,
  val status: SessionStatus,
  val detail: String,
  val updatedAt: Long,
  val canMessage: Boolean
) {
  companion object {
    fun from(json: JSONObject) = SessionSummary(
      key = json.optString("key"),
      agent = json.optString("agent"),
      name = json.optString("name"),
      project = json.optString("project"),
      path = json.optString("path"),
      status = SessionStatus.from(json.optString("status")),
      detail = json.optString("detail"),
      updatedAt = json.optLong("updatedAt"),
      canMessage = json.optBoolean("canMessage")
    )
  }
}

data class ProjectOption(val name: String, val path: String) {
  companion object {
    fun from(json: JSONObject) =
      ProjectOption(json.optString("name"), json.optString("path"))
  }
}

data class Snapshot(
  val computerName: String,
  val sessions: List<SessionSummary>,
  val projects: List<ProjectOption>
) {
  companion object {
    fun from(json: JSONObject) = Snapshot(
      computerName = json.optString("computerName"),
      sessions = json.optJSONArray("sessions").map(SessionSummary::from),
      projects = json.optJSONArray("projects").map(ProjectOption::from)
    )
  }
}

data class Message(
  val id: String,
  val role: String,
  val text: String,
  val createdAt: Long
) {
  companion object {
    fun from(json: JSONObject) = Message(
      id = json.optString("id"),
      role = json.optString("role"),
      text = json.optString("text"),
      createdAt = json.optLong("createdAt")
    )
  }
}

data class BridgeStatus(
  val computerName: String,
  val authenticated: Boolean,
  val requiresPairing: Boolean
) {
  companion object {
    fun from(json: JSONObject) = BridgeStatus(
      computerName = json.optString("computerName"),
      authenticated = json.optBoolean("authenticated"),
      requiresPairing = json.optBoolean("requiresPairing", true)
    )
  }
}

internal fun <T> JSONArray?.map(transform: (JSONObject) -> T): List<T> {
  if (this == null) return emptyList()
  return (0 until length()).mapNotNull { index ->
    optJSONObject(index)?.let(transform)
  }
}
