import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AppSettings, ScreenEdge, ThemePreference } from '@shared/types'

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

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const merged: AppSettings = {
      ...this.value,
      ...patch,
      position: {
        ...this.value.position,
        ...(patch.position ?? {})
      }
    }
    this.value = normalize(merged, this.value)
    await this.save()
    this.emit('update', this.value)
    return this.value
  }

  private async save(): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    await fsp.writeFile(temporary, `${JSON.stringify(this.value, null, 2)}\n`, 'utf8')
    await fsp.rename(temporary, this.filePath)
  }
}
