import { spawn, type ChildProcess } from 'node:child_process'

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
