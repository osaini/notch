import { execFile } from 'node:child_process'
import type { AgentVersions } from '@shared/types'

/**
 * Pulls the first `x.y.z[-prerelease]` out of arbitrary `--version` output.
 *
 * Deliberately duplicated from `debug-orchestrator/lib/preflight.mjs` rather
 * than imported: that module is plain ESM outside the Electron build, and one
 * regex is cheaper than a cross-build-boundary import. It handles both shapes
 * we care about — `2.1.220 (Claude Code)` and `codex-cli 0.146.0`.
 */
export function parseVersion(text: string): string | null {
  const match = String(text ?? '').match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  return match ? match[0] : null
}

const PROBE_TIMEOUT_MS = 5_000

/** Runs `<exe> --version`, resolving to null on any failure. Never throws. */
function probe(exe: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      exe,
      ['--version'],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true, shell: true },
      (error, stdout, stderr) => {
        if (error && !stdout) return resolve(null)
        resolve(parseVersion(`${stdout}\n${stderr}`))
      }
    )
  })
}

const EMPTY: AgentVersions = { claude: null, codex: null, probedAt: null }

let cached: AgentVersions = EMPTY
let inflight: Promise<AgentVersions> | null = null

/**
 * Probed once and cached for the life of the process. A CLI upgrade mid-session
 * is rare enough that a stale label until the next launch is the right trade
 * against spawning two processes every time the Dispatch tab renders.
 */
export function getAgentVersions(): Promise<AgentVersions> {
  if (cached.probedAt !== null) return Promise.resolve(cached)
  if (inflight) return inflight

  inflight = Promise.all([probe('claude'), probe('codex')])
    .then(([claude, codex]) => {
      cached = { claude, codex, probedAt: Date.now() }
      return cached
    })
    .catch(() => EMPTY)
    .finally(() => {
      inflight = null
    })

  return inflight
}
