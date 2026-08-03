import { spawn } from 'node:child_process'
import type { AgentProcess, ProcessIntegration } from '../types'
import { powerShellArgs } from './powershell'

/** Local copies: this module must not import from the flat src/main tree. */
function recordObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Codex rollout files do not contain a PID. The process list is the
 * authoritative signal that a TUI still exists; a rollout can end forever on
 * `task_started` when the user closes the tab or runs `/exit`.
 *
 * Every failure path resolves null rather than []. SessionWatcher prunes TUI
 * rows a non-null list does not mention, so [] would delete live sessions.
 */
async function listCodexTuiProcesses(): Promise<AgentProcess[] | null> {
  const script = `
$ErrorActionPreference = 'Stop'
@(Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'") |
  Where-Object { $_.CommandLine -notmatch '(?i)(?:^|\\s)app-server(?:\\s|$)' } |
  ForEach-Object {
    [pscustomobject]@{
      pid = [int]$_.ProcessId
      startedAt = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()
      commandLine = [string]$_.CommandLine
    }
  } |
  ConvertTo-Json -Compress
`
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', powerShellArgs(script), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const stdout: Buffer[] = []
    const timer = setTimeout(() => child.kill(), 2500)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.once('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        resolve(null)
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString('utf8') || '[]') as unknown
        const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
        resolve(
          rows.flatMap((value) => {
            const row = recordObject(value)
            const pid = num(row?.pid, -1)
            const startedAt = num(row?.startedAt)
            return pid > 0 && startedAt > 0
              ? [{ pid, startedAt, commandLine: str(row?.commandLine) }]
              : []
          })
        )
      } catch {
        resolve(null)
      }
    })
  })
}

export const processes: ProcessIntegration = { listCodexTuiProcesses }
