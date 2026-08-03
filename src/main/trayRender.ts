/**
 * The tray mark, as pure pixels.
 *
 * Deliberately free of `electron`: this is the one part of the tray both
 * platforms share, and keeping it importable without a running Electron is what
 * lets it be exercised directly. The platform tray modules wrap the result in a
 * `nativeImage` with their own size and palette — Windows wants a 16pt
 * dark-chrome badge, the macOS menu bar wants something else.
 */
import type { NotchColor } from '@shared/types'

export const STATUS_COLORS: Record<NotchColor, string> = {
  green: '#6FB585',
  yellow: '#D9A93F',
  red: '#E2705A',
  blue: '#7FA8D6',
  grey: '#736D60'
}

/**
 * The mark is authored in a fixed 16-unit square and mapped onto whatever
 * bitmap size is asked for, so a different logical size does not mean
 * re-deriving every coordinate below.
 */
const DESIGN_BOX = 16

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

export interface TrayMarkOptions {
  /** Logical (unscaled) edge length in points. */
  logicalSize: number
  /** Device pixel ratio to render at; the bitmap is logicalSize * scale square. */
  scale: number
  /** Chrome behind the mark. Omit for a transparent background. */
  background: string | null
  /** The dynamic-island body. */
  foreground: string
  status: string
}

export interface TrayBitmap {
  /** Premultiplied BGRA in top-down rows, the layout Electron expects. */
  pixels: Buffer
  width: number
  height: number
  scaleFactor: number
}

/** Builds the dynamic-island mark with a live status badge, supersampled. */
export function renderTrayMark(options: TrayMarkOptions): TrayBitmap {
  const { logicalSize, scale } = options
  const size = Math.round(logicalSize * scale)
  const samples = 4
  const background = options.background ? rgb(options.background) : null
  const foreground = rgb(options.foreground)
  const status = rgb(options.status)
  // One output pixel is this many design units across.
  const unit = DESIGN_BOX / size

  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let alpha = 0
      let red = 0
      let green = 0
      let blue = 0
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = (x + (sx + 0.5) / samples) * unit
          const py = (y + (sy + 0.5) / samples) * unit
          let sample: Rgb | null = roundedRect(px, py, 0.8, 0.8, 15.2, 15.2, 3.1)
            ? background
            : null
          if (roundedRect(px, py, 2.1, 5.05, 13.9, 10.95, 2.95)) sample = foreground
          const distance = Math.hypot(px - 10.85, py - 8)
          if (distance <= 1.55) sample = background ?? foreground
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

  return { pixels, width: size, height: size, scaleFactor: scale }
}
