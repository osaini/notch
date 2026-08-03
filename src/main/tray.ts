import { Menu, Tray } from 'electron'
import type { NotchColor } from '@shared/types'
import { platform } from './platform'

/**
 * The tray mark for a status colour.
 *
 * The pixel math is shared in `trayRender.ts`; the size, palette and
 * template-image decision are per-platform, because the Windows tray sits on
 * dark chrome while the macOS menu bar composites onto the wallpaper.
 */
export function trayImage(color: NotchColor): Electron.NativeImage {
  return platform.tray.image(color)
}

export interface TrayActions {
  onToggleHooks: () => void
  onOpenSettings: () => void
  onRefreshUsage: () => void
  onQuit: () => void
}

/**
 * The overlay is frameless and skips the taskbar, so the tray icon is the only
 * way to reach install/uninstall and to quit.
 */
export class NotchTray {
  private tray: Tray | null = null
  private color: NotchColor = 'grey'
  private hooksInstalled = false
  private summary = 'No active sessions'

  constructor(private actions: TrayActions) {}

  create(): void {
    this.tray = new Tray(this.image(this.color))
    this.render()
  }

  setColor(color: NotchColor, summary: string): void {
    if (this.color === color && this.summary === summary) return
    this.color = color
    this.summary = summary
    this.tray?.setImage(this.image(color))
    this.render()
  }

  /**
   * A template image is reduced to its alpha channel so macOS can recolour it,
   * which would discard the status colour. Whether that trade is worth making is
   * the platform's call, not this class's.
   */
  private image(color: NotchColor): Electron.NativeImage {
    const image = trayImage(color)
    if (platform.tray.template) image.setTemplateImage(true)
    return image
  }

  setHooksInstalled(installed: boolean): void {
    if (this.hooksInstalled === installed) return
    this.hooksInstalled = installed
    this.render()
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private render(): void {
    if (!this.tray) return
    // macOS does not show tray tooltips at all. The summary is already the first
    // (disabled) menu item, so there is nothing to replace it with.
    if (platform.tray.supportsTooltip) {
      this.tray.setToolTip(`Notch — ${this.summary}`)
    }
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: this.summary, enabled: false },
        { type: 'separator' },
        {
          label: this.hooksInstalled ? 'Uninstall hooks' : 'Install hooks',
          click: this.actions.onToggleHooks
        },
        { label: 'Rescan usage', click: this.actions.onRefreshUsage },
        { label: 'Reveal settings.json', click: this.actions.onOpenSettings },
        { type: 'separator' },
        { label: 'Quit Notch', click: this.actions.onQuit }
      ])
    )
  }
}
