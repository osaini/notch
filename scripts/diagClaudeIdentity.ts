/**
 * TEMPORARY diagnostic for the windows-latest CI failure in
 * `testClaudeProcessIdentityGuard`. Delete once the cause is known.
 *
 * `validateClaudeProcess` returns null on the runner where it returns false
 * locally, and every failure path there collapses to the same null with stderr
 * routed to 'ignore', so the CI log says nothing about why. This reproduces the
 * call with stderr captured and timings printed.
 */
import { spawn } from 'node:child_process'

function powerShellArgs(script: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ]
}

function run(
  exe: string,
  script: string,
  timeoutMs: number
): Promise<{ code: number | null; signal: string | null; out: string; err: string; ms: number }> {
  const started = Date.now()
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(exe, powerShellArgs(script), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      resolve({ code: null, signal: null, out: '', err: `spawn threw: ${String(error)}`, ms: 0 })
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', (c: Buffer) => err.push(c))
    child.once('error', (error: Error) => {
      clearTimeout(timer)
      resolve({ code: null, signal: null, out: '', err: `error event: ${error.message}`, ms: Date.now() - started })
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        code,
        signal,
        out: Buffer.concat(out).toString('utf8').trim(),
        err: (timedOut ? '[KILLED BY TIMEOUT] ' : '') + Buffer.concat(err).toString('utf8').trim(),
        ms: Date.now() - started
      })
    })
  })
}

const PID = process.pid

const CIM = `
$ErrorActionPreference = 'Stop'
$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${PID}"
if ($null -eq $p) { exit 3 }
[pscustomobject]@{
  name = [string]$p.Name
  commandLine = [string]$p.CommandLine
  startedAt = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()
} | ConvertTo-Json -Compress
`

const PIECES = `
$ErrorActionPreference = 'Continue'
$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${PID}"
Write-Output ("null?      : " + ($null -eq $p))
Write-Output ("name       : " + $p.Name)
Write-Output ("cmdline    : " + $p.CommandLine)
Write-Output ("creation   : " + $p.CreationDate)
Write-Output ("creationTyp: " + $p.CreationDate.GetType().FullName)
Write-Output ("psversion  : " + $PSVersionTable.PSVersion)
`

async function main(): Promise<void> {
  console.log(`platform=${process.platform} pid=${PID}`)
  if (process.platform !== 'win32') {
    console.log('not windows — nothing to diagnose')
    return
  }

  for (const attempt of [1, 2, 3]) {
    const r = await run('powershell.exe', CIM, 2500)
    console.log(
      `\n--- attempt ${attempt}: powershell.exe, 2500ms cap ---\n` +
        `elapsed=${r.ms}ms code=${r.code} signal=${r.signal}\n` +
        `stdout=${JSON.stringify(r.out)}\n` +
        `stderr=${JSON.stringify(r.err)}`
    )
  }

  const generous = await run('powershell.exe', CIM, 30_000)
  console.log(
    `\n--- same query, 30000ms cap ---\n` +
      `elapsed=${generous.ms}ms code=${generous.code} signal=${generous.signal}\n` +
      `stdout=${JSON.stringify(generous.out)}\n` +
      `stderr=${JSON.stringify(generous.err)}`
  )

  const pieces = await run('powershell.exe', PIECES, 30_000)
  console.log(
    `\n--- field-by-field ---\n` +
      `elapsed=${pieces.ms}ms code=${pieces.code}\n${pieces.out}\nstderr=${JSON.stringify(pieces.err)}`
  )
}

void main()
