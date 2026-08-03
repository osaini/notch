import type { DesignWindowProbe } from '../types'

/**
 * NOT A TODO — a decision. Do not implement this. See PORTING.md §9.
 *
 * Claude Design has no local session file, so an exact match on the window
 * *title* is the only signal that a Design window exists at all. macOS does not
 * give that up: `kCGWindowName` has been redacted for other applications since
 * 10.15 unless the app holds Screen Recording permission, and the Accessibility
 * route (`AXUIElement`, or System Events via AppleScript) needs its own grant.
 *
 * The reason this is permanent rather than merely unimplemented: TCC grants are
 * keyed to the code-signing identity, and this app ships ad-hoc signed with no
 * Developer ID. An ad-hoc signature changes on every rebuild, so the grant would
 * be silently revoked on every update — asking the user to re-authorise Screen
 * Recording after each release, to get a presence dot.
 *
 * `unsupportedReason` is empty on purpose. A non-empty reason is rendered as a
 * red error notice by Sessions.tsx, and a permanent error bar on every launch
 * for a feature this platform will never have reads as a broken app. The
 * renderer hides the affordance via `PlatformInfo.features.designWindows`
 * instead.
 */
export const designWindows: DesignWindowProbe = {
  supported: false,
  unsupportedReason: '',
  sweepCommand() {
    throw new Error(
      'platform.designWindows.sweepCommand is unreachable while supported is false'
    )
  }
}
