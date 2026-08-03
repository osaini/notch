import type { TerminalIntegration } from '../types'

/**
 * TODO(macos): implement. This is the PR that needs the most review — see
 * PORTING.md §6 and risk 4.
 *
 * Shape to follow, and the reason it is not a free choice:
 *
 * Today nothing in this app ever builds a shell string. `dispatcher.ts` spawns
 * `(exe, argvArray)`, and the Windows PowerShell fallback base64-decodes every
 * user-controlled value *inside* a fixed program rather than interpolating it.
 * AppleScript's `do script` takes a shell string, which invites
 * `cd <cwd> && claude "<prompt>"` — and prompts routinely contain quotes, `;`,
 * `$(` and newlines. That would be a command-injection bug reachable from the
 * mobile bridge.
 *
 * So: write argv to a 0600 temp file and have the launched shell `exec "$@"`
 * from it, mirroring the base64 technique already in `win32/terminal.ts`. Do not
 * interpolate. A test in `testInteractions.ts` feeding a prompt containing
 * `"; rm -rf ~ #` and `$(id)` and asserting those bytes appear nowhere in the
 * returned LaunchPlan except inside an opaque encoded blob is required, not
 * optional — that test is the guardrail; this comment is only its justification.
 *
 * Terminal.app has no panes, so `pairPlans` degrades to two windows and
 * `supportsSplitPane` stays false. iTerm2 does have panes (`split vertically
 * with same profile`); if you add it, detect it by presence at module load and
 * put it first in the plan order — do not probe inside these calls, they are
 * pure.
 *
 * Returning [] means "no terminal integration"; dispatcher.ts turns that into a
 * typed DispatchResult failure rather than spawning anything.
 */
export const terminal: TerminalIntegration = {
  primaryLabel: 'Terminal',
  primaryLauncher: 'apple-terminal',
  supportsSplitPane: false,

  agentPlans() {
    return []
  },

  pairPlans() {
    return []
  }
}
