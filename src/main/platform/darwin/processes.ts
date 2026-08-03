import type { ProcessIntegration } from '../types'

export const processes: ProcessIntegration = {
  /**
   * TODO(macos): implement with `ps -axo pid=,etime=,command=`, filtering for
   * `codex` and excluding `app-server` with the same regex win32 uses. Prefer
   * `etime=` (elapsed, relative) over `lstart=` (absolute, localised) —
   * `matchCodexTuiProcesses` pairs a process to a rollout inside a 60-second
   * window, so a timezone-off parse does not error, it attaches the WRONG PID to
   * a session and "End" then kills someone else's agent. See PORTING.md §5; a
   * parse test with real `ps` output pasted in as a fixture is required.
   *
   * Returns null, NOT []. SessionWatcher treats any non-null result as
   * authoritative and prunes every Codex TUI row the list does not mention, so
   * [] would not degrade — it would delete the user's sessions from the UI.
   * null means "could not tell; keep believing what you believed".
   */
  async listCodexTuiProcesses() {
    return null
  }
}
