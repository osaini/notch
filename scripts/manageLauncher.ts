/**
 * Installs a Start menu shortcut named "Notch" so the overlay can be launched
 * with Win → "notch" → Enter.
 *
 * The shortcut runs the repo's own Electron binary against the built `out/`
 * bundle rather than a packaged exe. That binary is already trusted locally
 * (unsigned product builds can be blocked by Application Control policy), it is
 * a GUI-subsystem exe so no console window appears, and it always picks up
 * whatever `npm run build` last produced — no reinstall after a code change.
 *
 * Windows-only, and deliberately not ported: this is a development convenience,
 * not a shipped feature. On other platforms `npm run dev` is the equivalent.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

const SHORTCUT_NAME = 'Notch'
/** Repo names this script has shipped under, so a stale checkout still works. */
const EXPECTED_PACKAGE_NAMES = ['notch', 'windows-notch']

function requireWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error(
      `The Start menu launcher is Windows-only (this is ${process.platform}). ` +
        'Use `npm run dev` instead.'
    )
  }
}

export interface LauncherStatus {
  shortcutPath: string
  installed: boolean
  /** False when `out/main/index.js` is missing, i.e. the shortcut would open nothing. */
  built: boolean
}

/** npm scripts always run at the repo root; verify rather than trust it. */
function repoRoot(): string {
  const root = process.cwd()
  const manifest = path.join(root, 'package.json')
  if (!existsSync(manifest)) {
    throw new Error(`No package.json at ${root} — run this from the repository root.`)
  }
  const name = JSON.parse(readFileSync(manifest, 'utf8')).name
  if (!EXPECTED_PACKAGE_NAMES.includes(name)) {
    throw new Error(
      `Expected the notch repo at ${root}, found "${name}".`
    )
  }
  return root
}

function shortcutPath(): string {
  const appData = process.env.APPDATA
  if (!appData) throw new Error('APPDATA is not set — cannot locate the Start menu.')
  return path.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    `${SHORTCUT_NAME}.lnk`
  )
}

function electronBinary(root: string): string {
  return path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
}

function mainBundle(root: string): string {
  return path.join(root, 'out', 'main', 'index.js')
}

/** Single-quoted PowerShell literal: only `'` needs escaping, by doubling it. */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function getLauncherStatus(): LauncherStatus {
  const root = repoRoot()
  return {
    shortcutPath: shortcutPath(),
    installed: existsSync(shortcutPath()),
    built: existsSync(mainBundle(root))
  }
}

export function installLauncher(): LauncherStatus {
  const root = repoRoot()
  const electron = electronBinary(root)
  if (!existsSync(electron)) {
    throw new Error(`Electron is not installed at ${electron} — run \`npm install\` first.`)
  }
  if (!existsSync(mainBundle(root))) {
    throw new Error(`No build at ${mainBundle(root)} — run \`npm run build\` first.`)
  }

  const target = shortcutPath()
  // Electron reads its first positional argument as the app directory, and
  // resolves `main` from that package.json — the same entry `npm start` uses.
  const script = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psLiteral(target)})`,
    `$s.TargetPath = ${psLiteral(electron)}`,
    `$s.Arguments = ${psLiteral(`"${root}"`)}`,
    `$s.WorkingDirectory = ${psLiteral(root)}`,
    `$s.Description = 'Notch overlay'`,
    '$s.Save()'
  ].join('; ')

  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'pipe'
  })

  return getLauncherStatus()
}

export function uninstallLauncher(): LauncherStatus {
  // Validate the caller before touching the one global shortcut. Otherwise a
  // command run from an unrelated directory deletes the working launcher and
  // only then throws while constructing the return status.
  repoRoot()
  const target = shortcutPath()
  const existed = existsSync(target)
  if (existed) rmSync(target)
  return getLauncherStatus()
}

function main(): void {
  const action = process.argv[2] ?? 'status'
  try {
    // Guard here rather than in each export: the failure otherwise surfaces as
    // "APPDATA is not set", which reads like a broken environment instead of a
    // Windows-only script run on the wrong OS.
    requireWindows()
    const result =
      action === 'install'
        ? installLauncher()
        : action === 'uninstall'
          ? uninstallLauncher()
          : getLauncherStatus()
    console.log(JSON.stringify(result, null, 2))
    if (action === 'install') {
      console.log(`\nPress Win, type "${SHORTCUT_NAME}", and hit Enter to open the overlay.`)
    }
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = 1
  }
}

main()
