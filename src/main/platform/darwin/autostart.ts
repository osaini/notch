import { app } from 'electron'
import type { AutostartIntegration } from '../types'

export const autostart: AutostartIntegration = {
  /**
   * On the startup path — must not throw.
   *
   * No `path` argument, unlike Windows. On macOS `process.execPath` points at
   * the helper binary *inside* the bundle, so passing it would register a login
   * item that launches the helper directly rather than the app. Electron
   * resolves the enclosing .app itself when `path` is omitted.
   */
  apply(enabled) {
    try {
      app.setLoginItemSettings({ openAtLogin: enabled })
      return true
    } catch (err) {
      console.error('[autostart]', (err as Error).message)
      return false
    }
  }
}
