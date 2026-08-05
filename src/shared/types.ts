/** Types shared across main, preload and renderer. */

export type AgentKind = 'claude' | 'codex' | 'claude-design'

/** Per-session state, after merging files with live hook signals. */
export type AgentStatus = 'idle' | 'busy' | 'needs-input' | 'reviewing' | 'unknown'

/** Aggregate light colour. `grey` means no live sessions at all. */
export type NotchColor = 'green' | 'yellow' | 'red' | 'blue' | 'grey'

export interface SessionState {
  /** Stable renderer/action key, namespaced by agent. */
  key: string
  agent: AgentKind
  /** Claude PID. Codex's rollout format has no PID association. */
  pid?: number
  sessionId: string
  /** Absolute path the session was started in. Empty for surfaces with no cwd. */
  cwd: string
  /** Display-only origin used when `cwd` is empty, e.g. `claude.ai/design`. */
  location?: string
  /** Human label from agent metadata/index, with transcript and cwd fallbacks. */
  name: string
  kind: string
  version?: string
  entrypoint?: string
  /** Merged status: hook-driven `needs-input` wins over the file's idle/busy. */
  status: AgentStatus
  /** Raw `status` string as written by Claude Code, for debugging/degrading. */
  rawStatus?: string
  startedAt: number
  updatedAt: number
  statusUpdatedAt?: number
  /** Background job this session *is*, when Claude Code started it as one. */
  jobId?: string
  /**
   * Background job this session handed off to.
   *
   * A parked session keeps its own file — and its last `busy` status — forever,
   * so it must not be shown alongside the job that took over.
   */
  parkedJobId?: string
  /** True while the agent is blocked on a permission, question or notification. */
  needsInput: boolean
  needsInputReason?: string
  needsInputAt?: number
  transcriptPath?: string
  /**
   * Decimal HWND of the exact window backing this session, when one is known.
   * Sent as a string because a 64-bit handle does not survive a JS number.
   */
  windowHandle?: string
  canTerminate: boolean
  canFocus: boolean
}

export interface SessionCounts {
  total: number
  idle: number
  busy: number
  needsInput: number
  reviewing: number
  unknown: number
}

export interface SessionsSnapshot {
  sessions: SessionState[]
  color: NotchColor
  counts: SessionCounts
  /** Sessions the watcher pruned because their PID is gone. */
  prunedCount: number
  /** Live sessions hidden because they parked into a background job. */
  parkedCount: number
  scannedAt: number
  /** Set when the sessions directory could not be read at all. */
  error?: string
  /** Set when Claude Design window detection could not be kept running. */
  designError?: string
}

/** Payload posted by a Claude Code `type: "http"` hook. */
export interface HookEvent {
  hook_event_name?: string
  session_id?: string
  cwd?: string
  transcript_path?: string
  permission_mode?: string
  message?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  permission_suggestions?: unknown[]
  receivedAt: number
}

export interface InteractionOption {
  label: string
  description?: string
}

export interface StructuredQuestion {
  id: string
  header: string
  question: string
  options: InteractionOption[]
  selectionMode: 'single' | 'multiple'
  allowOther: boolean
  secret: boolean
}

export type InteractionTransport =
  | 'claude-hook'
  | 'codex-app-server'
  | 'codex-rollout'

interface PendingInteractionBase {
  id: string
  agent: AgentKind
  sessionId: string
  cwd: string
  transport: InteractionTransport
  answerable: boolean
  receivedAt: number
  expiresAt?: number
  /**
   * Start of the deadline currently counting down. Equals `receivedAt` until
   * the first per-question reset; after that the countdown ring must measure
   * against this or it would keep scaling to the original window and drift.
   */
  windowStartedAt?: number
}

export interface PendingPermissionInteraction extends PendingInteractionBase {
  kind: 'permission'
  agent: 'claude'
  transport: 'claude-hook'
  answerable: true
  toolName: string
  toolInput: Record<string, unknown>
}

export interface PendingQuestionInteraction extends PendingInteractionBase {
  kind: 'questions'
  questions: StructuredQuestion[]
}

export type PendingInteraction =
  | PendingPermissionInteraction
  | PendingQuestionInteraction

export type InteractionResponse =
  | { kind: 'permission'; decision: 'allow' | 'deny' }
  | { kind: 'questions'; answers: Record<string, string[]> }

export interface ManagedCodexState {
  status: 'idle' | 'starting' | 'ready' | 'unavailable' | 'disconnected'
  available: boolean
  endpoint?: string
  experimentalApi: boolean
  requestUserInput: boolean
  error?: string
}

export interface UsageDayCount {
  /** `YYYY-MM-DD` in local time. */
  date: string
  tokens: number
  messages: number
}

export interface UsageSnapshot {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  messages: number
  sessions: number
  activeDays: number
  currentStreak: number
  longestStreak: number
  /** Local hour 0-23 with the most assistant messages, or null if no data. */
  peakHour: number | null
  favoriteModel: string | null
  modelBreakdown: { model: string; messages: number; tokens: number }[]
  /** Oldest-first, one entry per day for the heatmap window. */
  days: UsageDayCount[]
  /** Rolling 5-hour window — a LOCAL ESTIMATE, not a plan limit. */
  block: {
    tokens: number
    messages: number
    /** Epoch ms when the window started (first message still inside it). */
    startedAt: number | null
    /** Epoch ms when the oldest message rolls out of the window. */
    resetsAt: number | null
  }
  filesTracked: number
  scannedAt: number
  /** True while the first full scan is still running. */
  scanning: boolean
  agentBreakdown: {
    agent: AgentKind
    totalTokens: number
    messages: number
    sessions: number
  }[]
  planUsage: PlanUsage[]
}

export interface PlanUsagePeriod {
  id: string
  label: string
  /** Provider quota window length, when known. */
  windowMinutes: number | null
  utilization: number
  resetsAt: number | null
}

export type PlanUsageSource = 'live' | 'cache' | 'transcript'
export type PlanUsageState = 'fresh' | 'stale' | 'auth-expired' | 'unavailable'

export interface PlanUsage {
  agent: AgentKind
  fetchedAt: number | null
  stale: boolean
  source: PlanUsageSource
  state: PlanUsageState
  message?: string
  periods: PlanUsagePeriod[]
}

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions'
  | 'codex-untrusted'
  | 'codex-on-request'
  | 'codex-never'
  | 'codex-bypass'

/**
 * What the Dispatch tab can launch. Wider than `AgentKind`, which describes a
 * live session: `claude-codex` starts a *pair* of agents and never becomes a
 * session agent of its own.
 */
export type DispatchTarget = AgentKind | 'claude-codex'

/** The paired-agent workflows offered by the `claude-codex` target. */
export type ComboWorkflow = 'bug-search' | 'adversarial'

export interface DispatchRequest {
  agent: DispatchTarget
  cwd: string
  prompt: string
  permissionMode: PermissionMode
  /** Required when `agent` is `claude-codex`; ignored otherwise. */
  comboWorkflow?: ComboWorkflow
  /** Absolute paths from the Tray, appended to the prompt as @-references. */
  attachments?: string[]
}

/** Versions of the installed agent CLIs, probed once at startup. */
export interface AgentVersions {
  /** `null` while the probe is in flight, or if it failed. */
  claude: string | null
  codex: string | null
  probedAt: number | null
}

/**
 * Which terminal actually ran the agent. Per-platform, so the renderer must not
 * assume the Windows pair — see `LAUNCHER_LABELS`.
 */
export type DispatchLauncher = 'wt' | 'powershell' | 'apple-terminal' | 'iterm2'

/** Display names for each launcher, so no tab hardcodes a platform's terminal. */
export const LAUNCHER_LABELS: Record<DispatchLauncher, string> = {
  wt: 'Windows Terminal',
  powershell: 'PowerShell',
  'apple-terminal': 'Terminal',
  iterm2: 'iTerm2'
}

export interface DispatchResult {
  ok: boolean
  /** The exact command line used, for display and debugging. */
  command: string
  launcher: DispatchLauncher
  transport: 'managed-codex' | 'legacy-cli'
  sessionId?: string
  threadId?: string
  error?: string
}

/**
 * What the renderer needs to know about the host OS, so no tab hardcodes
 * Windows-only copy or offers a feature this platform does not have.
 */
export interface PlatformInfo {
  os: 'win32' | 'darwin'
  productName: string
  /** Primary terminal for dispatch, e.g. "Windows Terminal" / "Terminal". */
  terminalLabel: string
  /** How to reopen the app after Quit, e.g. "from the Start menu". */
  relaunchHint: string
  features: {
    /** Whether focusing a session's host window does anything. */
    focusWindows: boolean
    /** Whether Claude Design windows can be detected at all. */
    designWindows: boolean
    /** Whether an agent pair opens as two panes rather than two windows. */
    splitPane: boolean
  }
}

export interface SessionActionResult {
  ok: boolean
  message: string
}

export interface HookInstallStatus {
  installed: boolean
  /** Port the local hook listener is actually bound to. */
  port: number | null
  /** Hook events currently pointed at us. */
  events: string[]
  settingsPath: string
  backupPath: string | null
  /**
   * True when any installed entry still carries a pre-rename marker. Those
   * entries are recognised as ours, so `installed` stays true — this flag is
   * what tells the startup path to rewrite them anyway.
   */
  hasLegacyMarker?: boolean
  /** Set when settings.json exists but could not be parsed. */
  error?: string
}

export type ScreenEdge = 'top' | 'bottom' | 'left' | 'right'

export interface NotchPosition {
  displayId: string | null
  edge: ScreenEdge
  /** Normalized position along the selected edge. */
  offset: number
}

export interface NotchPositionPreset {
  label: string
  edge: ScreenEdge
  offset: number
}

/** Named positions that the drag interaction snaps to. */
export const NOTCH_POSITION_PRESETS: readonly NotchPositionPreset[] = [
  { label: 'Top left', edge: 'top', offset: 0 },
  { label: 'Top center', edge: 'top', offset: 0.5 },
  { label: 'Top right', edge: 'top', offset: 1 },
  { label: 'Bottom left', edge: 'bottom', offset: 0 },
  { label: 'Bottom center', edge: 'bottom', offset: 0.5 },
  { label: 'Bottom right', edge: 'bottom', offset: 1 },
  { label: 'Left center', edge: 'left', offset: 0.5 },
  { label: 'Right center', edge: 'right', offset: 0.5 }
]

export type NotchDragPhase = 'start' | 'move' | 'end'

/** One cursor sample from the renderer's pill drag gesture. */
export interface NotchDragInput {
  phase: NotchDragPhase
  /** Cursor position in screen (DIP) coordinates. */
  screenX: number
  screenY: number
  /** Vector from the pill's centre to the grab point; only read on `start`. */
  grabX?: number
  grabY?: number
}

/**
 * Live shape hints streamed by the main process while the notch is in motion,
 * so the renderer can morph between "flush against an edge" and "free floating
 * rounded rectangle" in lockstep with the native window move.
 */
export interface NotchDragState {
  /** True while dragging and while settling back onto an edge. */
  active: boolean
  /** Edge the notch is attached to, or would reattach to right now. */
  edge: ScreenEdge
  /** True once the pill has pulled far enough to fly free of its edge. */
  floating: boolean
  /** 0 = flush against the edge, 1 = fully detached. */
  detach: number
  /**
   * Where to draw the pill's centre while `active`, as an offset from the centre
   * of the overlay window. The main process positions the native window against
   * the same numbers, which is what keeps the pill glued to the cursor.
   */
  offsetX: number
  offsetY: number
  /** Resolved collapsed pill size for this display and position. */
  pillWidth: number
  pillHeight: number
  /** Physical cutout within the pill's local coordinate space, when reserved. */
  cutout?: { x: number; y: number; width: number; height: number }
}

export type ThemePreference = 'dark' | 'light' | 'system'

export interface AppSettings {
  position: NotchPosition
  launchAtLogin: boolean
  theme: ThemePreference
  /**
   * The phone companion listens on every interface, and a paired device can
   * dispatch agents with approvals bypassed. That is too much to hand out by
   * default, so the bridge stays down until it is switched on here.
   */
  mobileBridge: boolean
}

export interface MobileBridgeStatus {
  running: boolean
  port: number | null
  urls: string[]
  pairingCode: string
  pairingExpiresAt: number
  pairedDevices: number
  error?: string
}

export interface DisplayOption {
  id: string
  label: string
  primary: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

/** The contextBridge surface exposed to the renderer as `window.notch`. */
export interface NotchApi {
  onSessions(cb: (snapshot: SessionsSnapshot) => void): () => void
  onUsage(cb: (snapshot: UsageSnapshot) => void): () => void
  onInteractions(cb: (interactions: PendingInteraction[]) => void): () => void
  onManagedCodexState(cb: (state: ManagedCodexState) => void): () => void
  onSettings(cb: (settings: AppSettings) => void): () => void
  onDragState(cb: (state: NotchDragState) => void): () => void
  /**
   * The drag state as it stands right now. The resting state carries the offset
   * that places the pill, so a renderer that subscribed after the last message
   * was sent has to ask for it rather than wait for the next gesture.
   */
  getDragState(): Promise<NotchDragState>
  onForceExpand(cb: () => void): () => void
  onForceCollapse(cb: () => void): () => void
  getSessions(): Promise<SessionsSnapshot>
  getUsage(): Promise<UsageSnapshot>
  refreshUsage(): Promise<UsageSnapshot>
  getInteractions(): Promise<PendingInteraction[]>
  respondToInteraction(id: string, response: InteractionResponse): Promise<boolean>
  /** Re-arms the per-question deadline when the card advances a step. */
  advanceInteraction(id: string): Promise<boolean>
  openInteractionSession(id: string): Promise<SessionActionResult>
  getManagedCodexState(): Promise<ManagedCodexState>
  setInteractive(interactive: boolean): void
  getHookStatus(): Promise<HookInstallStatus>
  installHooks(): Promise<HookInstallStatus>
  uninstallHooks(): Promise<HookInstallStatus>
  getRecentProjects(): Promise<string[]>
  /** Installed agent CLI versions, for the Dispatch cards. */
  getAgentVersions(): Promise<AgentVersions>
  browseFiles(): Promise<string[]>
  browseDirectory(initialPath?: string): Promise<string | null>
  dispatch(req: DispatchRequest): Promise<DispatchResult>
  terminateSession(key: string): Promise<SessionActionResult>
  focusSession(key: string): Promise<SessionActionResult>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getDisplays(): Promise<DisplayOption[]>
  /** Host OS copy and feature flags. Static for the process lifetime. */
  getPlatformInfo(): Promise<PlatformInfo>
  getMobileBridgeStatus(): Promise<MobileBridgeStatus>
  regenerateMobilePairing(): Promise<MobileBridgeStatus>
  clearMobileDevices(): Promise<MobileBridgeStatus>
  dragNotch(input: NotchDragInput): void
  revealPath(path: string): void
  pathForFile(file: File): string
  quit(): void
}
