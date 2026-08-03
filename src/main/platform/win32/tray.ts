import { nativeImage } from 'electron'
import { STATUS_COLORS, renderTrayMark } from '../../trayRender'
import type { TrayIntegration } from '../types'

/** The Windows tray sits on dark chrome, so the mark carries its own backing. */
const TRAY_BACKGROUND = '#171513'
const TRAY_FOREGROUND = '#F4EFE7'

export const tray: TrayIntegration = {
  // Windows has no template-image concept; marking one would drop the colour.
  template: false,
  supportsTooltip: true,

  image(color) {
    const bitmap = renderTrayMark({
      logicalSize: 16,
      scale: 2,
      background: TRAY_BACKGROUND,
      foreground: TRAY_FOREGROUND,
      status: STATUS_COLORS[color]
    })
    return nativeImage.createFromBitmap(bitmap.pixels, {
      width: bitmap.width,
      height: bitmap.height,
      scaleFactor: bitmap.scaleFactor
    })
  }
}
