import type { SessionActionResult, SessionState } from '@shared/types'
import { platform } from './platform'

/**
 * Brings the window hosting a session to the front.
 *
 * How that is done is platform-specific and lives in each platform's `focus.ts`;
 * on macOS it currently degrades rather than working. Never rejects — the
 * returned `message` is rendered verbatim to the user.
 */
export function focusSessionWindow(session: SessionState): Promise<SessionActionResult> {
  return platform.focus.focusSessionWindow(session)
}
