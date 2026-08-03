import { app } from 'electron'
import type { OverlayIntegration } from '../types'

/**
 * On the startup path: `windowOptions`, `pillArea` and `afterCreate` all run
 * before the first frame, and `pillArea` runs again on every drag frame. None of
 * them may throw — the app launching with a mispositioned pill is a feedback
 * loop, the app not launching is not.
 */
export const overlay: OverlayIntegration = {
  windowOptions() {
    return {
      // macOS has no 'toolbar' type. A panel is the non-activating, floating
      // equivalent, and keeps the overlay out of the window cycle.
      // TODO(macos): verify against `setAlwaysOnTop('screen-saver')` and
      // `setVisibleOnAllWorkspaces({visibleOnFullScreen:true})`, which
      // windows.ts already applies and which interact with Spaces differently
      // here than on Windows. See PORTING.md §2.
      type: 'panel'
    }
  },

  /**
   * `workArea`, not `bounds` — unlike Windows, where the notch deliberately sits
   * over the taskbar. On macOS `bounds` includes the menu bar, so a top-centre
   * pill would land underneath it, and on a notched MacBook partly behind the
   * real camera housing.
   *
   * TODO(macos): workArea excludes the menu bar and the Dock, which is the right
   * first approximation, but it does NOT describe the physical notch — a notched
   * display reports a workArea spanning the full width including the area beside
   * the camera. Report what you actually observe with a screenshot before
   * changing anything: the fix belongs here, not in NOTCH_POSITION_PRESETS,
   * which is shared with Windows and also feeds drag snapping.
   */
  pillArea(display) {
    return display.workArea
  },

  afterCreate() {
    // A tray overlay has no business in the Dock or in Cmd-Tab. `LSUIElement` in
    // the packaged Info.plist covers the shipped app; this covers `npm run dev`,
    // where there is no Info.plist of ours, so both behave the same.
    // Optional-chained because `dock` is undefined off macOS and this module is
    // linked into every build.
    app.dock?.hide()
  }
}
