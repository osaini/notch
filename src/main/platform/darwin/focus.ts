import type { FocusIntegration } from '../types'

export const focus: FocusIntegration = {
  /**
   * TODO(macos): the portable half of this is reachable — walk the parent chain
   * with `ps -o ppid= -p <pid>` to find the owning terminal, then activate that
   * application with `osascript -e 'tell application id "…" to activate'`. That
   * gets the window to the front, which is all the Windows implementation
   * honestly claims either ("the exact terminal tab is best-effort").
   *
   * Focusing a *specific* window or tab needs the Accessibility API and its TCC
   * prompt. Do not request it: no permission prompt may fire from this app
   * without an explicit user action, and an ad-hoc signature loses the grant on
   * every rebuild anyway. Document the limitation instead. See PORTING.md §7.
   *
   * Never throws and never rejects — `message` is rendered verbatim to the user.
   */
  async focusSessionWindow() {
    return {
      ok: false,
      message: 'Focusing a session window is not available on macOS yet.'
    }
  }
}
