import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AgentVersions,
  AppSettings,
  DisplayOption,
  DispatchRequest,
  DispatchResult,
  HookInstallStatus,
  InteractionResponse,
  ManagedCodexState,
  MobileBridgeStatus,
  NotchApi,
  NotchDragState,
  PendingInteraction,
  PlatformInfo,
  SessionActionResult,
  SessionsSnapshot,
  UsageSnapshot
} from '@shared/types'

/** Wraps an ipcRenderer listener so callers get an unsubscribe function. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: NotchApi = {
  onSessions: (cb) => subscribe<SessionsSnapshot>('notch:sessions', cb),
  onUsage: (cb) => subscribe<UsageSnapshot>('notch:usage', cb),
  onInteractions: (cb) =>
    subscribe<PendingInteraction[]>('notch:interactions', cb),
  onManagedCodexState: (cb) =>
    subscribe<ManagedCodexState>('notch:managedCodexState', cb),
  onSettings: (cb) => subscribe<AppSettings>('notch:settings', cb),
  onDragState: (cb) => subscribe<NotchDragState>('notch:dragState', cb),
  getDragState: () => ipcRenderer.invoke('notch:getDragState') as Promise<NotchDragState>,
  onForceExpand: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('notch:force-expand', listener)
    return () => ipcRenderer.removeListener('notch:force-expand', listener)
  },
  onForceCollapse: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('notch:force-collapse', listener)
    return () => ipcRenderer.removeListener('notch:force-collapse', listener)
  },

  getSessions: () => ipcRenderer.invoke('notch:getSessions') as Promise<SessionsSnapshot>,
  getUsage: () => ipcRenderer.invoke('notch:getUsage') as Promise<UsageSnapshot>,
  refreshUsage: () => ipcRenderer.invoke('notch:refreshUsage') as Promise<UsageSnapshot>,
  getInteractions: () =>
    ipcRenderer.invoke('notch:getInteractions') as Promise<PendingInteraction[]>,
  respondToInteraction: (id: string, response: InteractionResponse) =>
    ipcRenderer.invoke('notch:respondToInteraction', id, response) as Promise<boolean>,
  advanceInteraction: (id: string) =>
    ipcRenderer.invoke('notch:advanceInteraction', id) as Promise<boolean>,
  openInteractionSession: (id: string) =>
    ipcRenderer.invoke('notch:openInteractionSession', id) as Promise<SessionActionResult>,
  getManagedCodexState: () =>
    ipcRenderer.invoke('notch:getManagedCodexState') as Promise<ManagedCodexState>,

  setInteractive: (interactive) => ipcRenderer.send('notch:setInteractive', interactive),

  getHookStatus: () => ipcRenderer.invoke('notch:getHookStatus') as Promise<HookInstallStatus>,
  installHooks: () => ipcRenderer.invoke('notch:installHooks') as Promise<HookInstallStatus>,
  uninstallHooks: () => ipcRenderer.invoke('notch:uninstallHooks') as Promise<HookInstallStatus>,

  getRecentProjects: () => ipcRenderer.invoke('notch:getRecentProjects') as Promise<string[]>,
  getAgentVersions: () => ipcRenderer.invoke('notch:getAgentVersions') as Promise<AgentVersions>,
  browseFiles: () => ipcRenderer.invoke('notch:browseFiles') as Promise<string[]>,
  browseDirectory: (initialPath?: string) =>
    ipcRenderer.invoke('notch:browseDirectory', initialPath) as Promise<string | null>,
  dispatch: (req: DispatchRequest) =>
    ipcRenderer.invoke('notch:dispatch', req) as Promise<DispatchResult>,
  terminateSession: (key) =>
    ipcRenderer.invoke('notch:terminateSession', key) as Promise<SessionActionResult>,
  focusSession: (key) =>
    ipcRenderer.invoke('notch:focusSession', key) as Promise<SessionActionResult>,
  getSettings: () => ipcRenderer.invoke('notch:getSettings') as Promise<AppSettings>,
  updateSettings: (patch) =>
    ipcRenderer.invoke('notch:updateSettings', patch) as Promise<AppSettings>,
  getDisplays: () => ipcRenderer.invoke('notch:getDisplays') as Promise<DisplayOption[]>,
  getPlatformInfo: () => ipcRenderer.invoke('notch:getPlatformInfo') as Promise<PlatformInfo>,
  getMobileBridgeStatus: () =>
    ipcRenderer.invoke('notch:getMobileBridgeStatus') as Promise<MobileBridgeStatus>,
  regenerateMobilePairing: () =>
    ipcRenderer.invoke('notch:regenerateMobilePairing') as Promise<MobileBridgeStatus>,
  clearMobileDevices: () =>
    ipcRenderer.invoke('notch:clearMobileDevices') as Promise<MobileBridgeStatus>,
  dragNotch: (input) => ipcRenderer.send('notch:drag', input),

  revealPath: (target) => ipcRenderer.send('notch:revealPath', target),
  // File.path was removed from the renderer in Electron 32; webUtils is the
  // supported way to resolve a dropped file back to a real path.
  pathForFile: (file) => webUtils.getPathForFile(file),
  quit: () => ipcRenderer.send('notch:quit')
}

contextBridge.exposeInMainWorld('notch', api)
