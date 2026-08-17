import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CoworkRootProbe } from '../types'

/** The leaf every candidate ends in; Claude Desktop's name for Cowork on disk. */
const SESSIONS_LEAF = 'local-agent-mode-sessions'

/**
 * Where the Store build hides its `%APPDATA%`.
 *
 * Claude Desktop ships as an MSIX package, and MSIX virtualizes `%APPDATA%`:
 * `C:\Users\<me>\AppData\Roaming\Claude` genuinely does not exist, while the
 * real Electron userData sits under the package's `LocalCache`. Confusingly the
 * app still *records* un-virtualized `AppData\Roaming\Claude\...` paths inside
 * its own session files, so those strings must never be resolved against disk.
 */
const MSIX_SUFFIX = path.join('LocalCache', 'Roaming', 'Claude', SESSIONS_LEAF)

/**
 * The publisher hash (`Claude_pzs8sxrjxfjjc`) is deliberately not hardcoded — it
 * differs between the Store build, a sideloaded package and a re-signed one.
 */
const PACKAGE_PREFIX = 'Claude_'

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fsp.stat(candidate)).isDirectory()
  } catch {
    return false
  }
}

async function msixRoots(localAppData: string): Promise<string[]> {
  const packages = path.join(localAppData, 'Packages')
  let entries: string[]
  try {
    entries = await fsp.readdir(packages)
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    if (!entry.startsWith(PACKAGE_PREFIX)) continue
    const candidate = path.join(packages, entry, MSIX_SUFFIX)
    if (await isDirectory(candidate)) found.push(candidate)
  }
  return found
}

export const coworkRoots: CoworkRootProbe = {
  async roots() {
    const home = os.homedir()
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')

    // The classic (non-Store) installer writes straight to %APPDATA%, so check
    // it first: when both exist that build is the one the user launched.
    const classic = path.join(roaming, 'Claude', SESSIONS_LEAF)
    const found = (await isDirectory(classic)) ? [classic] : []
    found.push(...(await msixRoots(local)))
    return found
  }
}
