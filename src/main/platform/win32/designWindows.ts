import type { DesignWindowProbe } from '../types'
import { powerShellArgs } from './powershell'

/**
 * One long-lived PowerShell process sweeps on a timer and prints one JSON line
 * per sweep. Re-spawning `powershell.exe` every few seconds would cost more
 * than everything else the notch does combined.
 *
 * The sweep reports every visible Claude Desktop window and marks which ones
 * are Design, rather than dropping the rest: the main window is what a Cowork
 * row focuses. Classification still uses only the titles handed in, so the
 * policy stays in `designWatcher`.
 */
function buildScript(titles: readonly string[], sweepMs: number): string {
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
      # An untitled top-level window is a transient Electron shell, never
      # something a person could be looking at.
      if ([string]::IsNullOrWhiteSpace($title)) { return $true }
      [void]$found.Add([pscustomobject]@{
        handle = [string]$hWnd.ToInt64()
        pid = $owner
        title = $title
        design = $designTitles -contains $title
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
  Start-Sleep -Milliseconds ${sweepMs}
}
`
}

export const designWindows: DesignWindowProbe = {
  supported: true,
  unsupportedReason: '',
  sweepCommand(titles, sweepMs) {
    return { exe: 'powershell.exe', args: powerShellArgs(buildScript(titles, sweepMs)) }
  }
}
