import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HookInstallStatus } from '@shared/types'
import { HOOK_EVENTS, HOOK_MARKER, HOOK_SPECS, HOOK_TOKEN_KEY, generateHookToken, hookUrl } from './hookServer'

export const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
/**
 * Created once, on the first install, and never overwritten — it is the
 * pristine pre-Windows-Notch copy of the user's real config.
 */
export const BACKUP_PATH = `${SETTINGS_PATH}.windows-notch-backup`

interface HookCommand {
  type?: string
  url?: string
  timeout?: number
  [key: string]: unknown
}

interface HookGroup {
  matcher?: string
  hooks?: HookCommand[]
  [key: string]: unknown
}

type Settings = Record<string, unknown> & {
  hooks?: Record<string, HookGroup[]>
}

function isOurs(cmd: unknown): boolean {
  if (!cmd || typeof cmd !== 'object') return false
  const url = (cmd as HookCommand).url
  return typeof url === 'string' && url.includes(HOOK_MARKER)
}

async function readSettings(): Promise<{ settings: Settings; existed: boolean; error?: string }> {
  let text: string
  try {
    text = await fsp.readFile(SETTINGS_PATH, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { settings: {}, existed: false }
    }
    throw err
  }
  if (!text.trim()) return { settings: {}, existed: true }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { settings: {}, existed: true, error: 'settings.json is not a JSON object' }
    }
    return { settings: parsed as Settings, existed: true }
  } catch (err) {
    // Refuse to touch a file we cannot round-trip; overwriting it would
    // destroy the user's real config.
    return { settings: {}, existed: true, error: `settings.json is not valid JSON: ${(err as Error).message}` }
  }
}

/** Write via a temp file + rename so a crash cannot leave a half-written config. */
async function writeSettings(settings: Settings): Promise<void> {
  await fsp.mkdir(path.dirname(SETTINGS_PATH), { recursive: true })
  const tmp = `${SETTINGS_PATH}.windows-notch-tmp`
  await fsp.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await fsp.rename(tmp, SETTINGS_PATH)
}

async function backupOnce(): Promise<string | null> {
  if (!fs.existsSync(SETTINGS_PATH)) return null
  if (fs.existsSync(BACKUP_PATH)) return BACKUP_PATH
  await fsp.copyFile(SETTINGS_PATH, BACKUP_PATH)
  return BACKUP_PATH
}

function currentBackupPath(): string | null {
  return fs.existsSync(BACKUP_PATH) ? BACKUP_PATH : null
}

/** Which of our hook events are currently wired up, to which port, and with which token. */
function inspect(settings: Settings): {
  events: string[]
  port: number | null
  token: string | null
} {
  const events: string[] = []
  let port: number | null = null
  let token: string | null = null
  const hooks = settings.hooks
  if (!hooks || typeof hooks !== 'object') return { events, port, token }

  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      const cmds = group?.hooks
      if (!Array.isArray(cmds)) continue
      for (const cmd of cmds) {
        if (!isOurs(cmd)) continue
        if (!events.includes(event)) events.push(event)
        const url = String((cmd as HookCommand).url)
        const match = /:(\d+)\/hook/.exec(url)
        if (match) port = Number.parseInt(match[1], 10)
        try {
          token = new URL(url).searchParams.get(HOOK_TOKEN_KEY) || token
        } catch {
          // A malformed URL of ours simply contributes no token.
        }
      }
    }
  }
  return { events, port, token }
}

/**
 * The secret embedded in the installed hook URLs, so the listener can adopt it
 * instead of rotating it — a rotation would rewrite the user's settings.json on
 * every launch.
 */
export async function getInstalledHookToken(): Promise<string | null> {
  const { settings, error } = await readSettings()
  if (error) return null
  return inspect(settings).token
}

export async function getHookStatus(): Promise<HookInstallStatus> {
  const { settings, error } = await readSettings()
  const { events, port } = inspect(settings)
  return {
    installed: events.length > 0,
    port,
    events,
    settingsPath: SETTINGS_PATH,
    backupPath: currentBackupPath(),
    error
  }
}

/**
 * Deep-merges our hook entries into the user's settings.json, leaving every
 * other key — and every other hook — untouched. Idempotent: re-running with a
 * different port rewrites only our own entries.
 *
 * Omitting `token` reuses whatever is already installed, so a plain reinstall
 * does not invalidate a running listener's secret.
 */
export async function installHooks(port: number, token?: string): Promise<HookInstallStatus> {
  const { settings, error } = await readSettings()
  if (error) {
    return {
      installed: false,
      port: null,
      events: [],
      settingsPath: SETTINGS_PATH,
      backupPath: currentBackupPath(),
      error
    }
  }

  const backupPath = await backupOnce()
  const activeToken = token || inspect(settings).token || generateHookToken()

  const hooks: Record<string, HookGroup[]> =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
      ? { ...settings.hooks }
      : {}

  // Strip every stale entry of ours first. One event can now carry several of
  // our groups, so clearing per-spec would delete a sibling we just added.
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? [...hooks[event]] : []
    hooks[event] = groups
      .map((group) => {
        if (!Array.isArray(group?.hooks)) return group
        if (!group.hooks.some(isOurs)) return group
        const kept = group.hooks.filter((cmd) => !isOurs(cmd))
        return kept.length > 0 ? { ...group, hooks: kept } : null
      })
      .filter((group): group is HookGroup => group !== null)
  }

  for (const spec of HOOK_SPECS) {
    hooks[spec.event] = [
      ...(hooks[spec.event] ?? []),
      {
        ...(spec.matcher ? { matcher: spec.matcher } : {}),
        hooks: [
          {
            type: 'http',
            url: hookUrl(port, activeToken, spec.intent),
            timeout: spec.timeout
          }
        ]
      }
    ]
  }

  await writeSettings({ ...settings, hooks })

  return {
    installed: true,
    port,
    events: [...HOOK_EVENTS],
    settingsPath: SETTINGS_PATH,
    backupPath
  }
}

/** Removes only entries carrying our marker, plus containers we emptied. */
export async function uninstallHooks(): Promise<HookInstallStatus> {
  const { settings, existed, error } = await readSettings()
  if (!existed || error) {
    return {
      installed: false,
      port: null,
      events: [],
      settingsPath: SETTINGS_PATH,
      backupPath: currentBackupPath(),
      error
    }
  }

  const hooks = settings.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return {
      installed: false,
      port: null,
      events: [],
      settingsPath: SETTINGS_PATH,
      backupPath: currentBackupPath()
    }
  }

  const nextHooks: Record<string, HookGroup[]> = {}
  let removed = false

  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      nextHooks[event] = groups
      continue
    }
    const cleanedGroups = groups
      .map((group) => {
        if (!Array.isArray(group?.hooks)) return group
        if (!group.hooks.some(isOurs)) return group
        const kept = group.hooks.filter((cmd) => !isOurs(cmd))
        removed = true
        return kept.length > 0 ? { ...group, hooks: kept } : null
      })
      // Drop groups we emptied, but keep groups that were already empty or
      // shaped differently — those are the user's, not ours.
      .filter((group): group is HookGroup => group !== null)

    if (cleanedGroups.length > 0) nextHooks[event] = cleanedGroups
  }

  const next: Settings = { ...settings }
  if (Object.keys(nextHooks).length > 0) {
    next.hooks = nextHooks
  } else {
    delete next.hooks
  }

  if (removed || Object.keys(nextHooks).length !== Object.keys(hooks).length) {
    await writeSettings(next)
  }

  return {
    installed: false,
    port: null,
    events: [],
    settingsPath: SETTINGS_PATH,
    backupPath: currentBackupPath()
  }
}
