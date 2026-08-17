import type { SessionActionResult, SessionState } from '@shared/types'
import type { FocusIntegration } from '../types'
import { runPowerShell } from './powershell'

/**
 * Windows Terminal owns the visible window, not claude.exe/codex.exe. Walk
 * ancestors until one has a MainWindowHandle, then ask User32 to foreground it.
 */
async function focusSessionWindow(session: SessionState): Promise<SessionActionResult> {
  const startPid = session.pid && Number.isInteger(session.pid) ? session.pid : 0
  const agent = session.agent
  // Claude Design and Cowork rows carry an exact HWND, so they skip the ancestor
  // walk entirely — the only cases where the focused window is not a guess.
  // (For Cowork the *window* is exact; which chat it shows is Claude Desktop's.)
  const handle = /^\d+$/.test(session.windowHandle ?? '') ? session.windowHandle! : '0'
  const exactLabel =
    agent === 'claude-cowork' ? 'the Claude Desktop window' : 'the Claude Design window'
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NotchUser32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
}
"@

function Focus-Handle([IntPtr]$handle) {
  if ($handle -eq [IntPtr]::Zero) { return $false }
  [void][NotchUser32]::ShowWindowAsync($handle, 9)
  return [NotchUser32]::SetForegroundWindow($handle)
}

$exactHandle = [int64]${handle}
if ($exactHandle -ne 0) {
  $target = [IntPtr]$exactHandle
  if ([NotchUser32]::IsWindow($target)) {
    $ok = Focus-Handle $target
    @{ found = $true; focused = $ok; process = "${exactLabel}"; exact = $true } |
      ConvertTo-Json -Compress
    exit 0
  }
  @{ found = $false; focused = $false; process = ""; exact = $true } | ConvertTo-Json -Compress
  exit 0
}

$pidToCheck = ${startPid}
$visited = @{}
while ($pidToCheck -gt 0 -and -not $visited.ContainsKey($pidToCheck)) {
  $visited[$pidToCheck] = $true
  $process = Get-Process -Id $pidToCheck -ErrorAction SilentlyContinue
  if ($process -and $process.MainWindowHandle -ne 0) {
    $ok = Focus-Handle $process.MainWindowHandle
    @{ found = $true; focused = $ok; process = $process.ProcessName } | ConvertTo-Json -Compress
    exit 0
  }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$pidToCheck" -ErrorAction SilentlyContinue
  if (-not $cim) { break }
  $pidToCheck = [int]$cim.ParentProcessId
}

if ("${agent}" -eq "codex") {
  $candidate = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
  if (-not $candidate) {
    $candidate = Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } |
      Sort-Object StartTime -Descending |
      Select-Object -First 1
  }
  if ($candidate) {
    $ok = Focus-Handle $candidate.MainWindowHandle
    @{ found = $true; focused = $ok; process = $candidate.ProcessName } | ConvertTo-Json -Compress
    exit 0
  }
}

@{ found = $false; focused = $false; process = "" } | ConvertTo-Json -Compress
`

  try {
    const parsed = JSON.parse(await runPowerShell(script)) as {
      found?: boolean
      focused?: boolean
      process?: string
      exact?: boolean
    }
    if (!parsed.found) {
      return {
        ok: false,
        message: parsed.exact
          ? 'That window has already been closed.'
          : 'No host window was found for this session.'
      }
    }
    if (parsed.exact) {
      return {
        ok: Boolean(parsed.focused),
        message: parsed.focused
          ? `Focused ${parsed.process}.`
          : `Found ${parsed.process}, but Windows refused foreground focus.`
      }
    }
    return {
      ok: Boolean(parsed.focused),
      message: parsed.focused
        ? `Focused ${parsed.process || 'the session host'} (the exact terminal tab is best-effort).`
        : `Found ${parsed.process || 'the session host'}, but Windows refused foreground focus.`
    }
  } catch (err) {
    return { ok: false, message: `Could not focus the session: ${(err as Error).message}` }
  }
}

export const focus: FocusIntegration = { focusSessionWindow }
