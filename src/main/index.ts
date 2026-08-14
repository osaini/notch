import { app, dialog, ipcMain, nativeTheme, session, shell } from 'electron'
import path from 'node:path'
import type {
  AgentTuning,
  AppSettings,
  AppSettingsPatch,
  ClaudeEffort,
  CodexEffort,
  ComboWorkflow,
  DispatchRequest,
  DispatchResult,
  DispatchTarget,
  HookEvent,
  HookInstallStatus,
  InteractionResponse,
  NotchColor,
  NotchDragInput,
  PendingInteraction,
  PermissionMode,
  PlatformInfo,
  SessionActionResult,
  SessionsSnapshot,
  UsageSnapshot
} from '@shared/types'
import { MAX_DISPATCH_ATTACHMENTS, MAX_DISPATCH_PROMPT_CHARS } from '@shared/types'
import { SessionWatcher } from './sessionWatcher'
import { HookServer, DEFAULT_PORT, compareInteractions } from './hookServer'
import {
  SETTINGS_PATH,
  getHookStatus,
  getInstalledHookToken,
  installHooks,
  uninstallHooks
} from './hookInstaller'
import { UsageScanner, emptySnapshot } from './usage'
import { dispatch, getRecentProjects } from './dispatcher'
import { getAgentVersions } from './agentVersions'
import { pastedImagesDir, savePastedImage } from './pastedImages'
import { NotchWindow } from './windows'
import { NotchTray } from './tray'
import { SettingsStore } from './settings'
import { focusSessionWindow } from './focus'
import { MobileBridge } from './mobileBridge'
import { ManagedCodexService } from './managedCodex'
import { readTrailingQuestion } from './transcriptTail'
import { assertSupportedPlatform, platform } from './platform'

const NEEDS_INPUT_TTL_MS = 10 * 60 * 1000
const NEEDS_INPUT_SWEEP_MS = 30_000

const notch = new NotchWindow()
const watcher = new SessionWatcher()
const hookServer = new HookServer()
const managedCodex = new ManagedCodexService()
let usageScanner: UsageScanner | null = null
let tray: NotchTray | null = null
let hookStatus: HookInstallStatus | null = null
let settingsStore: SettingsStore | null = null
let mobileBridge: MobileBridge | null = null
let quitting = false

/**
 * View-only cards for turns that ended by asking something in prose.
 *
 * Keyed by session so a later turn replaces the earlier question rather than
 * stacking. Held here rather than in HookServer because the hook response has
 * already been sent — there is nothing to answer, only somewhere to go.
 */
const followUps = new Map<string, PendingInteraction>()
const followUpGenerations = new Map<string, number>()
const followUpReads = new Map<string, number>()

function releaseFollowUpGeneration(sessionId: string): void {
  if ((followUpReads.get(sessionId) ?? 0) === 0 && !followUps.has(sessionId)) {
    followUpGenerations.delete(sessionId)
  }
}

function getPendingInteractions(): PendingInteraction[] {
  const managed = managedCodex.getPendingInteractions()
  const managedSessionIds = new Set(managed.map((interaction) => interaction.sessionId))
  const external = watcher
    .getPendingInteractions()
    .filter((interaction) => !managedSessionIds.has(interaction.sessionId))
  // A real prompt for the same session always supersedes its follow-up card.
  const held = [...hookServer.getPendingInteractions(), ...managed, ...external]
  const blocked = new Set(held.map((interaction) => interaction.sessionId))
  const notices = [...followUps.values()].filter(
    (interaction) => !blocked.has(interaction.sessionId)
  )
  return [...held, ...notices].sort(compareInteractions)
}

function clearFollowUp(sessionId: string): void {
  followUpGenerations.set(sessionId, (followUpGenerations.get(sessionId) ?? 0) + 1)
  if (followUps.delete(sessionId)) pushInteractions()
  releaseFollowUpGeneration(sessionId)
}

function pruneFollowUps(snapshot: SessionsSnapshot): void {
  // A failed scan is not authoritative; keep cards until session liveness can
  // be established again instead of erasing a still-valid follow-up.
  if (snapshot.error || snapshot.claudeAuthoritative === false) return
  const liveClaudeIds = new Set(
    snapshot.sessions
      .filter((session) => session.agent === 'claude')
      .map((session) => session.sessionId)
  )
  let changed = false
  const trackedSessionIds = new Set([...followUps.keys(), ...followUpReads.keys()])
  for (const sessionId of trackedSessionIds) {
    if (liveClaudeIds.has(sessionId)) continue
    // Invalidate an in-flight transcript read as well as deleting an existing
    // card. Otherwise a slow Stop read can resurrect a prompt after its session
    // disappeared from an authoritative watcher snapshot.
    followUpGenerations.set(sessionId, (followUpGenerations.get(sessionId) ?? 0) + 1)
    changed = followUps.delete(sessionId) || changed
    releaseFollowUpGeneration(sessionId)
  }
  if (changed) pushInteractions()
}

async function captureFollowUp(event: HookEvent): Promise<void> {
  const sessionId = event.session_id
  if (!sessionId || !event.transcript_path) return
  const generation = (followUpGenerations.get(sessionId) ?? 0) + 1
  followUpGenerations.set(sessionId, generation)
  followUpReads.set(sessionId, (followUpReads.get(sessionId) ?? 0) + 1)
  let question: string | null
  try {
    question = await readTrailingQuestion(event.transcript_path)
  } finally {
    const remaining = (followUpReads.get(sessionId) ?? 1) - 1
    if (remaining > 0) followUpReads.set(sessionId, remaining)
    else followUpReads.delete(sessionId)
  }
  if (followUpGenerations.get(sessionId) !== generation) {
    releaseFollowUpGeneration(sessionId)
    return
  }
  if (!question) {
    if (followUps.delete(sessionId)) pushInteractions()
    releaseFollowUpGeneration(sessionId)
    return
  }
  const receivedAt = Date.now()
  followUps.set(sessionId, {
    id: `followup:${sessionId}`,
    kind: 'questions',
    agent: 'claude',
    sessionId,
    cwd: event.cwd ?? '',
    transport: 'claude-hook',
    // Nothing to send: the turn is over. The card offers only the way back.
    answerable: false,
    receivedAt,
    questions: [{
      id: 'follow-up',
      header: 'Follow-up',
      question,
      options: [],
      selectionMode: 'single',
      allowOther: false,
      secret: false
    }]
  })
  pushInteractions()
}

function pushInteractions(): void {
  notch.send('notch:interactions', getPendingInteractions())
}

const DISPATCH_TARGETS = new Set<DispatchTarget>([
  'claude',
  'codex',
  'claude-design',
  'claude-codex'
])
const PERMISSION_MODES = new Set<PermissionMode>([
  'manual',
  'auto',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'codex-untrusted',
  'codex-on-request',
  'codex-never',
  'codex-bypass'
])
const COMBO_WORKFLOWS = new Set<ComboWorkflow>(['bug-search', 'adversarial'])
const CLAUDE_EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max'])
const CODEX_EFFORTS = new Set<string>(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
/**
 * A model id becomes an argv element, so it is matched against a charset rather
 * than an allow-list of names — the CLIs ship new ids faster than this app does.
 * The leading character may not be `-`, which is what keeps a model id from
 * being read as another flag by the agent or by the terminal launcher.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/

/**
 * Shape-checks one agent's model/effort override.
 *
 * Returns `undefined` when the caller sent nothing, or `null` when it sent
 * something malformed — the caller rejects the whole request on `null` rather
 * than silently dropping a setting the user asked for.
 */
function parseTuning<E extends string>(
  raw: unknown,
  efforts: ReadonlySet<string>
): AgentTuning<E> | null | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const tuning: AgentTuning<E> = {}
  if (value.model !== undefined && value.model !== '') {
    if (typeof value.model !== 'string' || !MODEL_ID.test(value.model)) return null
    tuning.model = value.model
  }
  if (value.effort !== undefined && value.effort !== '') {
    if (typeof value.effort !== 'string' || !efforts.has(value.effort)) return null
    tuning.effort = value.effort as E
  }
  return tuning
}

/**
 * The renderer is the only caller today, but this payload decides which binary
 * runs, in which directory, and under which approval mode — so it is checked
 * here rather than trusted. `dispatcher` validates `cwd` against the
 * filesystem; everything else is shape-checked before it gets that far.
 */
function parseDispatchRequest(raw: unknown): DispatchRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (!DISPATCH_TARGETS.has(value.agent as DispatchTarget)) return null
  if (!PERMISSION_MODES.has(value.permissionMode as PermissionMode)) return null
  if (typeof value.cwd !== 'string' || !value.cwd) return null
  if (
    typeof value.prompt !== 'string' ||
    value.prompt.length > MAX_DISPATCH_PROMPT_CHARS
  ) return null
  if (value.comboWorkflow !== undefined && !COMBO_WORKFLOWS.has(value.comboWorkflow as ComboWorkflow)) {
    return null
  }
  let attachments: string[] | undefined
  if (value.attachments !== undefined) {
    if (
      !Array.isArray(value.attachments) ||
      value.attachments.length > MAX_DISPATCH_ATTACHMENTS
    ) return null
    if (!value.attachments.every((item) => typeof item === 'string' && path.isAbsolute(item))) {
      return null
    }
    attachments = value.attachments as string[]
  }
  const claude = parseTuning<ClaudeEffort>(value.claude, CLAUDE_EFFORTS)
  if (claude === null) return null
  const codex = parseTuning<CodexEffort>(value.codex, CODEX_EFFORTS)
  if (codex === null) return null
  return {
    agent: value.agent as DispatchTarget,
    cwd: value.cwd,
    prompt: value.prompt,
    permissionMode: value.permissionMode as PermissionMode,
    comboWorkflow: value.comboWorkflow as ComboWorkflow | undefined,
    attachments,
    claude,
    codex
  }
}

/** Brings a session's host window forward. Best-effort; never throws. */
async function focusInteractionSession(interaction: PendingInteraction): Promise<void> {
  const session = watcher
    .getSnapshot()
    .sessions.find((candidate) => candidate.sessionId === interaction.sessionId)
  if (!session) return
  try {
    await focusSessionWindow(session)
  } catch (err) {
    console.error('[focus]', (err as Error).message)
  }
}

// `exit` rather than `quit`: a losing instance that merely queues a quit still
// runs the whenReady handler below and fights over the mobile-bridge port.
// Launching again (Win → "notch") peeks the running overlay instead.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', () => notch.peek())
}

function summarize(snapshot: SessionsSnapshot): string {
  const { counts } = snapshot
  if (counts.total === 0) return 'No active sessions'
  const parts: string[] = []
  if (counts.needsInput) parts.push(`${counts.needsInput} needs input`)
  if (counts.reviewing) parts.push(`${counts.reviewing} reviewing`)
  if (counts.busy) parts.push(`${counts.busy} working`)
  if (counts.idle) parts.push(`${counts.idle} idle`)
  if (counts.unknown) parts.push(`${counts.unknown} unknown`)
  return parts.join(' · ')
}

function pushSessions(snapshot: SessionsSnapshot): void {
  notch.send('notch:sessions', snapshot)
  tray?.setColor(snapshot.color as NotchColor, summarize(snapshot))
}

function pushUsage(snapshot: UsageSnapshot): void {
  notch.send('notch:usage', snapshot)
}

function applyLoginSetting(settings: AppSettings): void {
  if (!app.isPackaged) return
  platform.autostart.apply(settings.launchAtLogin)
}

function applyThemeSetting(settings: AppSettings): void {
  nativeTheme.themeSource = settings.theme
}

/**
 * Brings the phone companion up or down to match the setting.
 *
 * The bridge listens on every interface and a paired device can dispatch
 * agents with approvals bypassed, so it stays down until asked for. The object
 * is still constructed at startup: its status getter reports `running: false`
 * while stopped, which is what the Settings tab renders.
 */
async function applyMobileBridgeSetting(settings: AppSettings): Promise<void> {
  if (!mobileBridge) return

  const running = mobileBridge.getStatus().running
  if (settings.mobileBridge === running) return
  if (!settings.mobileBridge) {
    mobileBridge.stop()
    notch.send('notch:mobileStatus', mobileBridge.getStatus())
    return
  }
  try {
    await mobileBridge.start()
  } catch (err) {
    console.error('[mobile bridge] failed to start:', (err as Error).message)
  }
}

/**
 * Serialises bridge transitions so a fast double-toggle cannot start two
 * servers, and so `notch:updateSettings` can await the transition it caused
 * before answering — the renderer reads the status straight after.
 */
let mobileBridgeWork: Promise<void> = Promise.resolve()

function queueMobileBridgeSetting(settings: AppSettings): Promise<void> {
  mobileBridgeWork = mobileBridgeWork.then(() => applyMobileBridgeSetting(settings))
  return mobileBridgeWork
}

async function toggleHooks(): Promise<HookInstallStatus> {
  const current = await getHookStatus()
  const next = current.installed
    ? await uninstallHooks()
    : await installRunningHooks(current)
  hookStatus = next
  tray?.setHooksInstalled(next.installed)
  return next
}

async function installRunningHooks(
  current?: HookInstallStatus
): Promise<HookInstallStatus> {
  const status = current ?? await getHookStatus()
  const port = hookServer.port
  if (port === null) {
    return {
      ...status,
      error: 'The local hook listener is unavailable. Restart Notch before installing hooks.'
    }
  }
  return installHooks(port, hookServer.authToken)
}

function registerIpc(): void {
  ipcMain.handle('notch:getSessions', () => watcher.getSnapshot())
  ipcMain.handle('notch:getUsage', () => usageScanner?.getSnapshot() ?? emptySnapshot(true))
  ipcMain.handle('notch:refreshUsage', async () => {
    if (!usageScanner) return emptySnapshot(true)
    return usageScanner.refresh()
  })
  ipcMain.handle('notch:getInteractions', () => getPendingInteractions())
  ipcMain.handle(
    'notch:respondToInteraction',
    (_event, id: string, response: InteractionResponse) => {
      const interaction = getPendingInteractions().find((candidate) => candidate.id === id)
      if (!interaction || !interaction.answerable) return false
      return interaction.transport === 'claude-hook'
        ? hookServer.respond(id, response)
        : managedCodex.respond(id, response)
    }
  )
  ipcMain.handle('notch:advanceInteraction', (_event, id: string) =>
    hookServer.extendInteraction(id) || managedCodex.advanceInteraction(id)
  )
  ipcMain.handle(
    'notch:openInteractionSession',
    async (_event, id: string): Promise<SessionActionResult> => {
      const interaction = getPendingInteractions().find((candidate) => candidate.id === id)
      if (!interaction) return { ok: false, message: 'That prompt is no longer available.' }
      const session = watcher
        .getSnapshot()
        .sessions.find((candidate) => candidate.sessionId === interaction.sessionId)
      if (!session) {
        return {
          ok: false,
          message: 'The originating terminal could not be identified yet.'
        }
      }
      return focusSessionWindow(session)
    }
  )
  ipcMain.handle('notch:getManagedCodexState', () => managedCodex.getState())

  ipcMain.on('notch:setInteractive', (_event, interactive: unknown) => {
    notch.setInteractive(Boolean(interactive))
  })

  ipcMain.handle('notch:getHookStatus', async () => {
    hookStatus = await getHookStatus()
    tray?.setHooksInstalled(hookStatus.installed)
    return hookStatus
  })
  ipcMain.handle('notch:installHooks', async () => {
    hookStatus = await installRunningHooks()
    tray?.setHooksInstalled(hookStatus.installed)
    return hookStatus
  })
  ipcMain.handle('notch:uninstallHooks', async () => {
    hookStatus = await uninstallHooks()
    tray?.setHooksInstalled(false)
    return hookStatus
  })

  ipcMain.handle('notch:getRecentProjects', () => getRecentProjects(watcher.getSnapshot().sessions))
  ipcMain.handle('notch:getAgentVersions', () => getAgentVersions())
  // Deliberately does not start the app server: an idle service returns an
  // empty list and the picker falls back to its static ids.
  ipcMain.handle('notch:getCodexModels', async () =>
    (await managedCodex.listModels()).map((model) => model.id)
  )
  ipcMain.handle('notch:browseFiles', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Add files to the tray',
      buttonLabel: 'Add to tray',
      properties: ['openFile', 'multiSelections']
    }
    const parent = notch.browserWindow
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('notch:savePastedImage', async (_event, bytes: unknown) => {
    // The bytes come from the OS clipboard by way of the renderer, so nothing
    // about them is trusted here: `savePastedImage` names the file from what
    // they actually are, and refuses them outright if it cannot.
    if (!(bytes instanceof Uint8Array)) return null
    try {
      return await savePastedImage(pastedImagesDir(), bytes)
    } catch (err) {
      console.error('[notch] could not save pasted image', err)
      return null
    }
  })
  ipcMain.handle('notch:browseDirectory', async (_event, initialPath: unknown) => {
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a project folder',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory']
    }
    if (typeof initialPath === 'string' && initialPath.trim()) {
      options.defaultPath = initialPath.trim()
    }
    const parent = notch.browserWindow
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('notch:dispatch', (_event, request: unknown) => {
    const parsed = parseDispatchRequest(request)
    if (!parsed) {
      return {
        ok: false,
        command: '',
        launcher: 'wt',
        transport: 'legacy-cli',
        error: 'Malformed dispatch request'
      } satisfies DispatchResult
    }
    return dispatch(parsed, managedCodex)
  })
  ipcMain.handle('notch:terminateSession', (_event, key: string) => watcher.terminate(key))
  ipcMain.handle('notch:focusSession', async (_event, key: string): Promise<SessionActionResult> => {
    const session = watcher.getSnapshot().sessions.find((candidate) => candidate.key === key)
    if (!session) return { ok: false, message: 'Session is no longer available.' }
    return focusSessionWindow(session)
  })

  ipcMain.handle('notch:getSettings', () => settingsStore?.get())
  ipcMain.handle('notch:updateSettings', async (_event, patch: AppSettingsPatch) => {
    if (!settingsStore) throw new Error('Settings are not ready')
    const next = await settingsStore.update(patch)
    // `update` emits synchronously, so the bridge transition this patch caused
    // is already on the queue. Settle it before answering.
    await mobileBridgeWork
    return next
  })
  // Static for the process lifetime, so the renderer fetches it once on mount.
  // Everything here exists so no tab hardcodes Windows-only copy or offers an
  // affordance this platform cannot honour.
  ipcMain.handle(
    'notch:getPlatformInfo',
    (): PlatformInfo => ({ ...platform.info, productName: app.getName() })
  )
  ipcMain.handle('notch:getDisplays', () => notch.getDisplays())
  ipcMain.handle('notch:getDragState', () => notch.getDragState())
  // refreshStatus rather than getStatus: this is the call the Settings tab makes,
  // and the address a phone should use changes when the user joins a different
  // network. Re-probing here keeps the recommendation and the QR code honest.
  ipcMain.handle('notch:getMobileBridgeStatus', async () => mobileBridge?.refreshStatus() ?? {
    running: false,
    port: null,
    endpoints: [],
    pairingCode: '',
    pairingExpiresAt: 0,
    pairedDevices: 0,
    error: 'Mobile bridge is still starting.'
  })
  ipcMain.handle('notch:regenerateMobilePairing', () => {
    if (!mobileBridge) throw new Error('Mobile bridge is still starting.')
    return mobileBridge.regeneratePairing()
  })
  ipcMain.handle('notch:clearMobileDevices', async () => {
    if (!mobileBridge) throw new Error('Mobile bridge is still starting.')
    return mobileBridge.clearPairedDevices()
  })
  ipcMain.on('notch:drag', (_event, input: unknown) => {
    if (!settingsStore || !input || typeof input !== 'object') return
    const candidate = input as Partial<NotchDragInput>
    if (
      (candidate.phase !== 'start' && candidate.phase !== 'move' && candidate.phase !== 'end') ||
      !Number.isFinite(candidate.screenX) ||
      !Number.isFinite(candidate.screenY) ||
      // The grab offset is optional, but a non-finite one is not: it is added to
      // the anchor on `start` and would poison every frame of the gesture.
      (candidate.grabX !== undefined && !Number.isFinite(candidate.grabX)) ||
      (candidate.grabY !== undefined && !Number.isFinite(candidate.grabY))
    ) {
      return
    }
    const landed = notch.handleDrag(candidate as NotchDragInput)
    if (landed) void settingsStore.update({ position: landed })
  })

  ipcMain.on('notch:revealPath', (_event, target: unknown) => {
    if (typeof target !== 'string' || !target) return
    // On Windows a UNC path would make Explorer reach out to an SMB host and hand
    // over the user's credentials on the way, so only local absolute paths are
    // revealed. What counts as safe is the platform's call.
    if (!platform.paths.isRevealable(target)) return
    shell.showItemInFolder(target)
  })
  ipcMain.on('notch:quit', () => {
    quitting = true
    app.quit()
  })
}

app.whenReady().then(async () => {
  // First, before anything reads `platform`: an unsupported OS gets a dialog and
  // an exit rather than the Windows implementation and a mystery PowerShell error.
  if (!assertSupportedPlatform()) return

  // Must stay byte-identical to `build.appId` in package.json, or Windows
  // treats the running app and the installed shortcut as different identities
  // and taskbar pinning silently stops working. A no-op off Windows.
  app.setAppUserModelId('dev.notch.app')

  // A status overlay has no business with the camera, the microphone, location,
  // or notifications. Electron grants several of these by default, so say no
  // once here rather than trusting the renderer never to ask. Copying a pairing
  // URL to the clipboard is the one thing the UI legitimately needs.
  const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
    ALLOWED_PERMISSIONS.has(permission)
  )

  settingsStore = new SettingsStore(app.getPath('userData'))
  const settings = await settingsStore.load()
  settingsStore.on('update', (next: AppSettings) => {
    notch.applySettings(next, true)
    applyLoginSetting(next)
    applyThemeSetting(next)
    void queueMobileBridgeSetting(next)
    notch.send('notch:settings', next)
  })
  if (settingsStore.canApplyStartupSideEffects()) applyLoginSetting(settings)
  applyThemeSetting(settings)
  nativeTheme.on('updated', () => {
    if (settingsStore?.get().theme === 'system') {
      notch.send('notch:settings', settingsStore.get())
    }
  })

  registerIpc()
  notch.create()
  notch.browserWindow?.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    notch.peek()
  })
  notch.applySettings(settings, false)
  notch.loadRenderer(process.env.ELECTRON_RENDERER_URL)

  tray = new NotchTray({
    onToggleHooks: () => void toggleHooks(),
    onOpenSettings: () => shell.showItemInFolder(SETTINGS_PATH),
    onRefreshUsage: () => void usageScanner?.refresh(),
    onQuit: () => {
      quitting = true
      app.quit()
    }
  })
  tray.create()

  watcher.on('update', (snapshot: SessionsSnapshot) => {
    pruneFollowUps(snapshot)
    pushSessions(snapshot)
  })
  watcher.start()
  pushSessions(watcher.getSnapshot())

  mobileBridge = new MobileBridge({
    userDataDir: app.getPath('userData'),
    assetsDir: path.join(app.getAppPath(), 'mobile', 'dist'),
    watcher,
    getProjects: () => getRecentProjects(watcher.getSnapshot().sessions),
    dispatch: (request) => dispatch(request, managedCodex)
  })
  mobileBridge.on('status', (status) => notch.send('notch:mobileStatus', status))
  // Opt-in only. The pairing code is deliberately not logged: it is a live
  // credential for a service that can run agents, and stdout ends up in files.
  await queueMobileBridgeSetting(settings)

  hookServer.on('blocked', (event) => {
    const reason =
      event.hook_event_name === 'PermissionRequest'
        ? event.tool_name
          ? `Permission requested: ${event.tool_name}`
          : 'Permission requested'
        : event.message || 'Waiting on you'
    if (event.session_id) watcher.setNeedsInput(event.session_id, reason)
  })
  hookServer.on('unblocked', (event) => {
    if (!event.session_id) return
    if (event.hook_event_name === 'Stop') {
      watcher.markReviewing(event.session_id)
      // The turn just ended; if it ended on a question, surface it.
      void captureFollowUp(event)
    } else {
      watcher.clearNeedsInput(event.session_id)
      // The user is engaging again, so any parked question is moot.
      clearFollowUp(event.session_id)
    }
  })
  hookServer.on('pending-change', pushInteractions)
  hookServer.on('interaction-resolved', ({ interaction, result }) => {
    const stillPending = getPendingInteractions().some(
      (candidate) => candidate.sessionId === interaction.sessionId
    )
    if (!stillPending && interaction.sessionId) watcher.clearNeedsInput(interaction.sessionId)
    // Running out of time means the user was away rather than uninterested, so
    // put the terminal where they will see it when they come back. Only on the
    // timeout path: an answered or dismissed card must not steal focus.
    if (result === 'timeout') void focusInteractionSession(interaction)
  })
  hookServer.on('server-error', (err: Error) => {
    console.error('[hook server]', err.message)
  })
  watcher.on('interaction-change', pushInteractions)
  managedCodex.on('pending-change', pushInteractions)
  managedCodex.on('state', (state) => notch.send('notch:managedCodexState', state))
  managedCodex.on('interaction-resolved', ({ interaction }) => {
    const stillPending = getPendingInteractions().some(
      (candidate) => candidate.sessionId === interaction.sessionId
    )
    if (!stillPending && interaction.sessionId) watcher.clearNeedsInput(interaction.sessionId)
  })
  managedCodex.on('server-error', (err: Error) => {
    console.error('[managed codex]', err.message)
  })

  try {
    // Adopt the installed secret so a restart does not rewrite settings.json.
    const installedToken = await getInstalledHookToken()
    const port = await hookServer.start(DEFAULT_PORT, installedToken ?? undefined)
    hookStatus = await getHookStatus()
    if (
      hookStatus.installed &&
      (hookStatus.port !== port ||
        !hookStatus.complete ||
        installedToken !== hookServer.authToken ||
        // A pre-rename marker is still recognised as ours, so `installed` is
        // true and nothing above would fire. Without this clause the old marker
        // would stay in the user's settings.json indefinitely.
        hookStatus.hasLegacyMarker)
    ) {
      hookStatus = await installHooks(port, hookServer.authToken)
    }
    tray.setHooksInstalled(hookStatus.installed)
  } catch (err) {
    console.error('[hook server] failed to start:', (err as Error).message)
    const current = await getHookStatus()
    hookStatus = { ...current, error: `The local hook listener failed to start: ${(err as Error).message}` }
    tray.setHooksInstalled(current.installed)
  }

  setInterval(() => watcher.expireNeedsInput(NEEDS_INPUT_TTL_MS), NEEDS_INPUT_SWEEP_MS)

  usageScanner = new UsageScanner(app.getPath('userData'))
  usageScanner.on('update', pushUsage)
  usageScanner.on('error', (err: Error) => console.error('[usage]', err.message))
  void usageScanner.start()
})

app.on('window-all-closed', () => {
  if (quitting) app.quit()
})

app.on('before-quit', () => {
  quitting = true
  watcher.stop()
  hookServer.stop()
  managedCodex.stop()
  mobileBridge?.stop()
  usageScanner?.stop()
  tray?.destroy()
})
