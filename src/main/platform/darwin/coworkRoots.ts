import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CoworkRootProbe } from '../types'

/**
 * Unlike Windows there is no package virtualization to see through: a macOS
 * Electron app's userData is always `~/Library/Application Support/<name>`, so
 * there is exactly one candidate and no directory to sweep.
 *
 * This is a real implementation rather than a stub — it is a path probe, not an
 * OS API — but it is unverified against a macOS Cowork install. If the leaf is
 * ever named differently there, this returns `[]` and Cowork rows are simply
 * absent, which is the same silent degradation as Claude Desktop not being
 * installed. It never produces a wrong row.
 */
export const coworkRoots: CoworkRootProbe = {
  async roots() {
    const candidate = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Claude',
      'local-agent-mode-sessions'
    )
    try {
      return (await fsp.stat(candidate)).isDirectory() ? [candidate] : []
    } catch {
      return []
    }
  }
}
