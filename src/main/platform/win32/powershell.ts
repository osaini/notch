import { spawn, type ChildProcess } from 'node:child_process'

/**
 * How long a one-shot PowerShell query may run before it is killed.
 *
 * This is a stuck-process backstop, NOT a latency budget: the queries that use
 * it resolve as soon as they finish, so a generous value costs nothing in the
 * normal case and a tight one only invents failures.
 *
 * It has to clear Windows PowerShell 5.1's one-time "Preparing modules for
 * first use" pass, which is paid by the first invocation after boot and is not
 * proportional to the work. Measured on a cold GitHub `windows-latest` runner:
 * first call **2514 ms**, second 1945 ms, steady state ~330 ms. The former cap
 * of 2500 ms sat directly on that first number, so the first End or Codex sweep
 * on a cold machine was a coin flip — it made CI flaky, and on a user's machine
 * it turned a legitimate End into "the operating system could not verify this
 * Claude process". Ten seconds leaves ~4x margin over the observed warmup.
 */
export const POWERSHELL_QUERY_TIMEOUT_MS = 10_000

/**
 * `-EncodedCommand` takes base64 of UTF-16LE. Encoding the whole program this way
 * means a script can contain quotes and newlines without any shell quoting, which
 * is what keeps user-controlled values out of PowerShell syntax.
 */
export function encodedPowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** Base64 UTF-8, for values a script decodes back at runtime rather than parses. */
export function encodedValue(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

/** Argv for a hidden, profile-free PowerShell running `script`. */
export function powerShellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)]
}

/** Spawns a hidden PowerShell that streams JSON lines until killed. */
export function spawnPowerShellStream(script: string): ChildProcess {
  return spawn('powershell.exe', powerShellArgs(script), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/** Runs a script to completion and resolves its trimmed stdout. */
export function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', powerShellArgs(script), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8').trim()
      if (code === 0) resolve(output)
      else
        reject(
          new Error(Buffer.concat(stderr).toString('utf8').trim() || `PowerShell exited ${code}`)
        )
    })
  })
}
