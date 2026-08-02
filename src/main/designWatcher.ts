import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Claude Design has no local session file. It is opened from the Claude Desktop
 * sidebar as its own Electron `BrowserWindow`, and Desktop pins that window's
 * caption: the design window installs `page-title-updated -> preventDefault()`,
 * so the caption stays the creation-time title for the window's whole life.
 * That makes an exact caption match on a Claude Desktop window a stable signal —
 * unlike the main Claude window, whose caption follows the page.
 *
 * Every locale shipped with Claude Desktop 1.24012.9 uses the same string, so a
 * single literal covers them all. Extra spellings are kept here so a localized
 * build that diverges later degrades to "not detected" rather than to a wrong row.
 */
export const DESIGN_WINDOW_TITLES = ['Design', 'Claude Design'] as const

/** Claude Desktop caps concurrent design windows; stay in the same ballpark. */
const MAX_DESIGN_WINDOWS = 16
const SWEEP_MS = 3000
/** Restart backoff after the helper exits, capped so a broken host stays quiet. */
const RESTART_DELAY_MS = [2000, 5000, 15000, 60000]

export interface DesignWindow {
  /** Decimal HWND. A string because a 64-bit handle does not fit a JS number. */
  handle: string
  pid: number
  title: string
}

interface RawWindow {
  handle?: unknown
  pid?: unknown
  title?: unknown
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * One long-lived PowerShell process sweeps on a timer and prints one JSON line
 * per sweep. Re-spawning `powershell.exe` every few seconds would cost more
 * than everything else the notch does combined.
 */
function buildScript(titles: readonly string[]): string {
  const titleLiterals = titles.map((title) => `'${title.replace(/'/g, "''")}'`).join(',')
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NotchDesignWindows {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);
}
"@

$designTitles = @(${titleLiterals})

# Past setup, a transient error must not take the sweep loop down with it.
$ErrorActionPreference = 'Continue'

while ($true) {
  $desktopPids = @{}
  foreach ($proc in @(Get-Process -Name claude -ErrorAction SilentlyContinue)) {
    $desktopPids[$proc.Id] = $true
  }

  $found = New-Object System.Collections.ArrayList
  if ($desktopPids.Count -gt 0) {
    $callback = [NotchDesignWindows+EnumProc] {
      param($hWnd, $lParam)
      if (-not [NotchDesignWindows]::IsWindowVisible($hWnd)) { return $true }
      $owner = 0
      [void][NotchDesignWindows]::GetWindowThreadProcessId($hWnd, [ref]$owner)
      if (-not $desktopPids.ContainsKey($owner)) { return $true }
      $class = New-Object System.Text.StringBuilder 128
      [void][NotchDesignWindows]::GetClassNameW($hWnd, $class, $class.Capacity)
      # Every Electron top-level window uses this class; it excludes the
      # hidden IME/DDE helper windows the same process also owns.
      if ($class.ToString() -ne 'Chrome_WidgetWin_1') { return $true }
      $caption = New-Object System.Text.StringBuilder 512
      [void][NotchDesignWindows]::GetWindowTextW($hWnd, $caption, $caption.Capacity)
      $title = $caption.ToString()
      if ($designTitles -notcontains $title) { return $true }
      [void]$found.Add([pscustomobject]@{
        handle = [string]$hWnd.ToInt64()
        pid = $owner
        title = $title
      })
      return $true
    }
    [void][NotchDesignWindows]::EnumWindows($callback, [IntPtr]::Zero)
  }

  # ConvertTo-Json collapses a one-element array in Windows PowerShell 5.1;
  # the reader normalises both shapes. Written straight to the console handle so
  # each sweep reaches the parent immediately rather than sitting in a buffer.
  [Console]::Out.WriteLine((@{ windows = @($found) } | ConvertTo-Json -Depth 3 -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${SWEEP_MS}
}
`
}

function parseWindows(line: string): DesignWindow[] {
  let parsed: { windows?: unknown }
  try {
    parsed = JSON.parse(line) as { windows?: unknown }
  } catch {
    return []
  }
  const raw = parsed.windows
  const list: unknown[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  const windows: DesignWindow[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const { handle, pid, title } = entry as RawWindow
    if (typeof handle !== 'string' || !/^\d+$/.test(handle)) continue
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue
    windows.push({ handle, pid, title: typeof title === 'string' ? title : 'Design' })
    if (windows.length >= MAX_DESIGN_WINDOWS) break
  }
  return windows
}

/**
 * Emits `update` whenever the set of open Claude Design windows changes.
 * Detection is presence-only: Design runs against claude.ai and writes nothing
 * local, so there is no busy/idle signal to read — see README.
 */
export class DesignWatcher extends EventEmitter {
  private child: ChildProcess | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private restarts = 0
  private stopped = true
  private buffer = ''
  private windows: DesignWindow[] = []
  private lastSerialized = '[]'
  private failure: string | undefined

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.spawnHelper()
  }

  stop(): void {
    this.stopped = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.child?.kill()
    this.child = null
  }

  getWindows(): DesignWindow[] {
    return this.windows
  }

  /** Set only when the helper could not be kept alive at all. */
  getError(): string | undefined {
    return this.failure
  }

  private spawnHelper(): void {
    if (this.stopped) return
    let child: ChildProcess
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          encodedPowerShell(buildScript(DESIGN_WINDOW_TITLES))
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (err) {
      this.scheduleRestart((err as Error).message)
      return
    }
    this.child = child
    this.buffer = ''

    child.stdout?.on('data', (chunk: Buffer) => this.ingest(chunk.toString('utf8')))
    child.once('error', (err: Error) => this.scheduleRestart(err.message))
    child.once('exit', () => {
      if (child === this.child) this.child = null
      this.scheduleRestart('the design window helper exited')
    })
  }

  private ingest(text: string): void {
    this.buffer += text
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.publish(parseWindows(line))
      newline = this.buffer.indexOf('\n')
    }
    // A stuck partial line means a malformed writer, not a huge payload.
    if (this.buffer.length > 64 * 1024) this.buffer = ''
  }

  private publish(windows: DesignWindow[]): void {
    // A successful sweep clears any earlier helper failure.
    this.restarts = 0
    this.failure = undefined
    const serialized = JSON.stringify(windows)
    if (serialized === this.lastSerialized) return
    this.lastSerialized = serialized
    this.windows = windows
    this.emit('update', windows)
  }

  private scheduleRestart(reason: string): void {
    if (this.stopped || this.restartTimer) return
    const delay = RESTART_DELAY_MS[Math.min(this.restarts, RESTART_DELAY_MS.length - 1)]
    this.restarts++
    if (this.restarts > RESTART_DELAY_MS.length) {
      this.failure = `Claude Design detection is unavailable — ${reason}.`
    }
    // Windows may be closing down with the app; drop what we last reported so a
    // dead helper never leaves a phantom design row on screen.
    this.publishEmptyIfNeeded()
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.spawnHelper()
    }, delay)
  }

  private publishEmptyIfNeeded(): void {
    if (this.lastSerialized === '[]') return
    this.lastSerialized = '[]'
    this.windows = []
    this.emit('update', this.windows)
  }
}
