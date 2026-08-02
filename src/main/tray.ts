import { Menu, Tray, nativeImage } from 'electron'
import type { NotchColor } from '@shared/types'

const COLORS: Record<NotchColor, string> = {
  green: '#6FB585',
  yellow: '#D9A93F',
  red: '#E2705A',
  blue: '#7FA8D6',
  grey: '#736D60'
}

const TRAY_BACKGROUND = '#171513'
const TRAY_FOREGROUND = '#F4EFE7'

type Rgb = readonly [number, number, number]

function rgb(hex: string): Rgb {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ]
}

function roundedRect(
  x: number,
  y: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  radius: number
): boolean {
  const nearestX = Math.max(left + radius, Math.min(x, right - radius))
  const nearestY = Math.max(top + radius, Math.min(y, bottom - radius))
  return Math.hypot(x - nearestX, y - nearestY) <= radius
}

/** Builds the dynamic-island mark with a live status badge at 2x tray resolution. */
export function trayImage(color: NotchColor): Electron.NativeImage {
  const logicalSize = 16
  const scale = 2
  const size = logicalSize * scale
  const samples = 4
  const background = rgb(TRAY_BACKGROUND)
  const foreground = rgb(TRAY_FOREGROUND)
  const status = rgb(COLORS[color])

  // Premultiplied BGRA in top-down rows, the raw bitmap layout Electron expects.
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let alpha = 0
      let red = 0
      let green = 0
      let blue = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = (x + (sx + 0.5) / samples) / scale
          const py = (y + (sy + 0.5) / samples) / scale
          let sample: Rgb | null = roundedRect(px, py, 0.8, 0.8, 15.2, 15.2, 3.1)
            ? background
            : null
          if (roundedRect(px, py, 2.1, 5.05, 13.9, 10.95, 2.95)) sample = foreground
          const distance = Math.hypot(px - 10.85, py - 8)
          if (distance <= 1.55) sample = background
          if (distance <= 1.05) sample = status
          if (sample) {
            alpha += 1
            red += sample[0]
            green += sample[1]
            blue += sample[2]
          }
        }
      }

      const sampleCount = samples * samples
      const coverage = alpha / sampleCount
      const i = (y * size + x) * 4
      if (alpha > 0) {
        // BMP pixels are premultiplied BGRA, matching Electron's native image layout.
        pixels[i] = Math.round((blue / alpha) * coverage)
        pixels[i + 1] = Math.round((green / alpha) * coverage)
        pixels[i + 2] = Math.round((red / alpha) * coverage)
        pixels[i + 3] = Math.round(255 * coverage)
      }
    }
  }

  return nativeImage.createFromBitmap(pixels, {
    width: size,
    height: size,
    scaleFactor: scale
  })
}

export interface TrayActions {
  onToggleHooks: () => void
  onOpenSettings: () => void
  onRefreshUsage: () => void
  onQuit: () => void
}

/**
 * The overlay is frameless and skips the taskbar, so the tray icon is the only
 * way to reach install/uninstall and to quit.
 */
export class NotchTray {
  private tray: Tray | null = null
  private color: NotchColor = 'grey'
  private hooksInstalled = false
  private summary = 'No active sessions'

  constructor(private actions: TrayActions) {}

  create(): void {
    this.tray = new Tray(trayImage(this.color))
    this.render()
  }

  setColor(color: NotchColor, summary: string): void {
    if (this.color === color && this.summary === summary) return
    this.color = color
    this.summary = summary
    this.tray?.setImage(trayImage(color))
    this.render()
  }

  setHooksInstalled(installed: boolean): void {
    if (this.hooksInstalled === installed) return
    this.hooksInstalled = installed
    this.render()
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private render(): void {
    if (!this.tray) return
    this.tray.setToolTip(`Windows Notch — ${this.summary}`)
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: this.summary, enabled: false },
        { type: 'separator' },
        {
          label: this.hooksInstalled ? 'Uninstall hooks' : 'Install hooks',
          click: this.actions.onToggleHooks
        },
        { label: 'Rescan usage', click: this.actions.onRefreshUsage },
        { label: 'Reveal settings.json', click: this.actions.onOpenSettings },
        { type: 'separator' },
        { label: 'Quit Windows Notch', click: this.actions.onQuit }
      ])
    )
  }
}
