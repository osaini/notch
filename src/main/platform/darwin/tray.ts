import { nativeImage } from 'electron'
import { STATUS_COLORS, renderTrayMark } from '../../trayRender'
import type { TrayIntegration } from '../types'

/**
 * The menu bar composites onto the user's wallpaper, so the mark is drawn
 * without the dark backing plate the Windows tray needs.
 */
const MENU_BAR_FOREGROUND = '#F4EFE7'

export const tray: TrayIntegration = {
  /**
   * Not a template image, deliberately.
   *
   * `setTemplateImage(true)` reduces an image to its alpha channel so macOS can
   * recolour it for light/dark menu bars and for the highlighted state. That
   * would discard the status colour — which is the entire product. The tradeoff
   * is that this icon does not invert when the menu bar item is clicked.
   *
   * TODO(macos): confirm this reads correctly on a light menu bar; if it does
   * not, the fallback is a template glyph plus colour carried in the menu title
   * rather than the icon. See PORTING.md §3.
   */
  template: false,
  /** macOS does not show tray tooltips; NotchTray puts the summary in the menu. */
  supportsTooltip: false,

  /**
   * On the startup path — must not throw, and must not return an empty image.
   * An invisible menu-bar item is indistinguishable from a crashed app.
   */
  image(color) {
    const bitmap = renderTrayMark({
      logicalSize: 16,
      scale: 2,
      background: null,
      foreground: MENU_BAR_FOREGROUND,
      status: STATUS_COLORS[color]
    })
    return nativeImage.createFromBitmap(bitmap.pixels, {
      width: bitmap.width,
      height: bitmap.height,
      scaleFactor: bitmap.scaleFactor
    })
  }
}
