import type { OverlayIntegration } from '../types'

export const overlay: OverlayIntegration = {
  windowOptions() {
    return {
      // A tool window stays out of Alt-Tab, which is what an overlay wants.
      // Windows-only: macOS has no 'toolbar' window type.
      type: 'toolbar'
    }
  },

  /**
   * `bounds`, not `workArea`, on purpose: the notch is meant to sit *over* the
   * taskbar, so it must be allowed into the whole display.
   */
  pillArea(display) {
    return display.bounds
  },

  afterCreate() {
    // Nothing Windows-specific beyond the constructor options.
  }
}
