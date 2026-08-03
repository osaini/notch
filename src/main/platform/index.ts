import { app, dialog } from 'electron'
import { darwinPlatform } from './darwin'
import type { PlatformIntegration } from './types'
import { win32Platform } from './win32'

/**
 * STATIC imports, deliberately.
 *
 * A dynamic `import()` here would break two things:
 *
 *  1. electron-vite builds `src/main` as CJS, and rollup answers a dynamic
 *     import by code-splitting `out/main` into extra chunks — a packaging
 *     surface change for no benefit.
 *  2. The esbuild test scripts bundle to a single CJS file with
 *     `--alias:electron=./scripts/stubs/electron.ts`. Static imports resolve
 *     through that alias cleanly; a lazy require can escape it.
 *
 * The cost is that BOTH platform modules are linked into every build and their
 * module bodies execute on every platform. They must therefore have NO top-level
 * side effects — no spawn, no `app.` call, no `new Tray`, nothing but function
 * and const definitions. `npm run test:pill-geometry` links them under the
 * electron stub, so a stray top-level `electron` call fails there.
 */
function select(): PlatformIntegration | null {
  if (process.platform === 'win32') return win32Platform
  if (process.platform === 'darwin') return darwinPlatform
  return null
}

const selected = select()

/**
 * The single platform decision in the app.
 *
 * Typed as non-null for the benefit of every call site, because by the time any
 * of them run `assertSupportedPlatform` has already exited an unsupported OS.
 */
export const platform: PlatformIntegration = selected as PlatformIntegration

/**
 * Call once, first thing in `whenReady`, before anything touches `platform`.
 *
 * The explicit third branch is three lines and turns "why is it running
 * PowerShell on Linux" into a dialog. A `process.platform === 'darwin' ? … : …`
 * ternary would silently hand every other OS the Windows implementation.
 */
export function assertSupportedPlatform(): boolean {
  if (selected) return true
  dialog.showErrorBox(
    'Unsupported platform',
    `Notch supports Windows and macOS. This is ${process.platform}.`
  )
  app.exit(1)
  return false
}

export type * from './types'
