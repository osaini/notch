import { execFileSync } from 'node:child_process'

interface AppKitPoint {
  x: number
  y: number
}

interface AppKitSize {
  width: number
  height: number
}

interface AppKitRect {
  origin: AppKitPoint
  size: AppKitSize
}

interface AppKitScreen {
  frame: AppKitRect
  safe: { top: number; left: number; bottom: number; right: number }
  left: AppKitRect
  right: AppKitRect
}

export interface DisplayCutoutProbe {
  displayBounds: Electron.Rectangle
  cutout: Electron.Rectangle
}

/*
 * Fixed source and fixed argv only. Nothing from a session, prompt, path, or
 * display is ever placed in JavaScript source (or in a shell string).
 */
const APPKIT_SCREEN_PROBE = [
  'ObjC.import("AppKit");',
  'const screens=$.NSScreen.screens.js;',
  'const rows=[];',
  'for(let i=0;i<screens.length;i++){',
  'const s=screens[i];',
  'rows.push({frame:ObjC.deepUnwrap(s.frame),safe:ObjC.deepUnwrap(s.safeAreaInsets),left:ObjC.deepUnwrap(s.auxiliaryTopLeftArea),right:ObjC.deepUnwrap(s.auxiliaryTopRightArea)});',
  '}',
  'JSON.stringify(rows);'
].join('')

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

function isRect(value: unknown): value is AppKitRect {
  if (!value || typeof value !== 'object') return false
  const rect = value as Partial<AppKitRect>
  return Boolean(
    rect.origin &&
    rect.size &&
    finite(rect.origin.x) &&
    finite(rect.origin.y) &&
    finite(rect.size.width) &&
    finite(rect.size.height)
  )
}

function isScreen(value: unknown): value is AppKitScreen {
  if (!value || typeof value !== 'object') return false
  const screen = value as Partial<AppKitScreen>
  return Boolean(
    isRect(screen.frame) &&
    isRect(screen.left) &&
    isRect(screen.right) &&
    screen.safe &&
    finite(screen.safe.top) &&
    finite(screen.safe.left) &&
    finite(screen.safe.bottom) &&
    finite(screen.safe.right)
  )
}

/** Converts AppKit's bottom-left screen space into Electron's top-left space. */
export function parseDisplayCutouts(output: string): DisplayCutoutProbe[] {
  try {
    const parsed: unknown = JSON.parse(output)
    if (!Array.isArray(parsed) || parsed.length === 0 || !isScreen(parsed[0])) return []
    const mainTop = parsed[0].frame.origin.y + parsed[0].frame.size.height
    const probes: DisplayCutoutProbe[] = []

    for (const candidate of parsed) {
      if (!isScreen(candidate)) continue
      const { frame, left, right, safe } = candidate
      const displayBounds = {
        x: frame.origin.x,
        y: mainTop - (frame.origin.y + frame.size.height),
        width: frame.size.width,
        height: frame.size.height
      }
      const cutoutLeft = left.origin.x + left.size.width
      const cutoutRight = right.origin.x
      const cutoutHeight = Math.max(safe.top, left.size.height, right.size.height)
      if (
        frame.size.width <= 0 ||
        frame.size.height <= 0 ||
        cutoutHeight <= 0 ||
        cutoutRight <= cutoutLeft ||
        cutoutLeft < frame.origin.x ||
        cutoutRight > frame.origin.x + frame.size.width
      ) {
        continue
      }
      probes.push({
        displayBounds,
        cutout: {
          x: cutoutLeft,
          y: displayBounds.y,
          width: cutoutRight - cutoutLeft,
          height: cutoutHeight
        }
      })
    }
    return probes
  } catch {
    return []
  }
}

let cachedProbes: DisplayCutoutProbe[] | undefined

function appKitCutouts(): DisplayCutoutProbe[] {
  if (cachedProbes) return cachedProbes
  try {
    const output = execFileSync(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', APPKIT_SCREEN_PROBE],
      { encoding: 'utf8', timeout: 1500, windowsHide: true }
    )
    cachedProbes = parseDisplayCutouts(output)
  } catch {
    cachedProbes = []
  }
  return cachedProbes
}

export function displayCutout(display: Electron.Display): Electron.Rectangle | null {
  try {
    const match = appKitCutouts().find(({ displayBounds }) =>
      Math.abs(displayBounds.x - display.bounds.x) < 1 &&
      Math.abs(displayBounds.y - display.bounds.y) < 1 &&
      Math.abs(displayBounds.width - display.bounds.width) < 1 &&
      Math.abs(displayBounds.height - display.bounds.height) < 1
    )
    return match ? { ...match.cutout } : null
  } catch {
    return null
  }
}
