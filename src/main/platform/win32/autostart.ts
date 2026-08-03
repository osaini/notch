import { app } from 'electron'
import type { AutostartIntegration } from '../types'

export const autostart: AutostartIntegration = {
  apply(enabled) {
    try {
      // `path` is required on Windows: without it the Run entry points at
      // whatever Electron resolved at install time rather than the shipped exe.
      app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
      return true
    } catch (err) {
      // On the startup path — a failed autostart toggle must not stop launch.
      console.error('[autostart]', (err as Error).message)
      return false
    }
  }
}
