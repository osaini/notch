import { spawn } from 'node:child_process'
import type { ProcessIntegration } from '../types'

function elapsedMs(raw: string): number | null {
  const match = raw.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  if (!match) return null
  const days = Number(match[1] ?? 0)
  const hours = Number(match[2] ?? 0)
  const minutes = Number(match[3])
  const seconds = Number(match[4])
  if (![days, hours, minutes, seconds].every(Number.isFinite)) return null
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000
}

async function validateClaudeProcess(
  pid: number,
  recordUpdatedAt: number
): Promise<boolean | null> {
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(recordUpdatedAt) || recordUpdatedAt <= 0) {
    return false
  }
  return new Promise((resolve) => {
    const child = spawn('/bin/ps', ['-p', String(pid), '-o', 'etime=', '-o', 'command='], {
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
      if (code === 1) return resolve(false)
      if (code !== 0) return resolve(null)
      const output = Buffer.concat(stdout).toString('utf8').trim()
      const split = output.search(/\s/)
      if (split < 1) return resolve(null)
      const elapsed = elapsedMs(output.slice(0, split))
      const command = output.slice(split).trim()
      if (elapsed === null) return resolve(null)
      const isClaude = /(?:^|[\/\s"'])claude(?:-code)?(?:\.js)?(?:[\/"'\s]|$)/i.test(command)
      const startedAt = Date.now() - elapsed
      resolve(isClaude && startedAt <= recordUpdatedAt + 60_000)
    })
  })
}

export const processes: ProcessIntegration = {
  validateClaudeProcess,
  /**
   * TODO(macos): implement with `ps -axo pid=,etime=,command=`, filtering for
   * `codex` and excluding `app-server` with the same regex win32 uses. Prefer
   * `etime=` (elapsed, relative) over `lstart=` (absolute, localised) —
   * `matchCodexTuiProcesses` pairs a process to a rollout inside a 60-second
   * window, so a timezone-off parse does not error, it attaches the WRONG PID to
   * a session and "End" then kills someone else's agent. See PORTING.md §5; a
   * parse test with real `ps` output pasted in as a fixture is required.
   *
   * Returns null, NOT []. SessionWatcher treats any non-null result as
   * authoritative and prunes every Codex TUI row the list does not mention, so
   * [] would not degrade — it would delete the user's sessions from the UI.
   * null means "could not tell; keep believing what you believed".
   */
  async listCodexTuiProcesses() {
    return null
  }
}
