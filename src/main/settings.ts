import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AppSettings, AppSettingsPatch, ScreenEdge, ThemePreference } from '@shared/types'

const EDGES = new Set<ScreenEdge>(['top', 'bottom', 'left', 'right'])
const THEMES = new Set<ThemePreference>(['dark', 'light', 'system'])

export const DEFAULT_SETTINGS: AppSettings = {
  position: {
    displayId: null,
    edge: 'top',
    offset: 0.5
  },
  launchAtLogin: false,
  theme: 'dark',
  mobileBridge: false
}

function clampOffset(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, value))
}

function normalize(raw: unknown, current = DEFAULT_SETTINGS): AppSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return current
  const value = raw as Record<string, unknown>
  const rawPosition =
    value.position && typeof value.position === 'object' && !Array.isArray(value.position)
      ? (value.position as Record<string, unknown>)
      : {}
  const edge = EDGES.has(rawPosition.edge as ScreenEdge)
    ? (rawPosition.edge as ScreenEdge)
    : current.position.edge
  const displayId =
    rawPosition.displayId === null || typeof rawPosition.displayId === 'string'
      ? rawPosition.displayId
      : current.position.displayId

  return {
    position: {
      displayId,
      edge,
      offset: clampOffset(rawPosition.offset, current.position.offset)
    },
    launchAtLogin:
      typeof value.launchAtLogin === 'boolean' ? value.launchAtLogin : current.launchAtLogin,
    theme: THEMES.has(value.theme as ThemePreference)
      ? (value.theme as ThemePreference)
      : current.theme,
    mobileBridge:
      typeof value.mobileBridge === 'boolean' ? value.mobileBridge : current.mobileBridge
  }
}

export class SettingsStore extends EventEmitter {
  private readonly filePath: string
  private value: AppSettings = DEFAULT_SETTINGS
  /**
   * Settings can arrive faster than the filesystem can persist them (the
   * position slider is the common case). Keep the merge, write, and event in
   * one ordered transaction so concurrent callers neither race over the same
   * temporary file nor let an older snapshot win on disk.
   */
  private updateWork: Promise<void> = Promise.resolve()

  constructor(userDataDir: string) {
    super()
    this.filePath = path.join(userDataDir, 'settings.json')
  }

  async load(): Promise<AppSettings> {
    try {
      this.value = normalize(JSON.parse(await fsp.readFile(this.filePath, 'utf8')))
    } catch {
      this.value = DEFAULT_SETTINGS
    }
    return this.value
  }

  get(): AppSettings {
    return this.value
  }

  update(patch: AppSettingsPatch): Promise<AppSettings> {
    const result = this.updateWork.then(async () => {
      const current = this.value
      const merged: AppSettings = {
        ...current,
        ...patch,
        position: {
          ...current.position,
          ...(patch.position ?? {})
        }
      }
      const next = normalize(merged, current)
      await this.save(next)
      // Do not expose a value that failed to reach disk, and do not emit an
      // update whose side effects cannot survive a restart.
      this.value = next
      this.emit('update', next)
      return next
    })
    // A failed write rejects its own caller but must not poison later updates.
    this.updateWork = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async save(value: AppSettings): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await fsp.rename(temporary, this.filePath)
  }
}
