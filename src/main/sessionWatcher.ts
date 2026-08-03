import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentStatus,
  NotchColor,
  PendingInteraction,
  SessionActionResult,
  SessionCounts,
  SessionState,
  SessionsSnapshot,
  StructuredQuestion
} from '@shared/types'
import { DesignWatcher, type DesignWindow } from './designWatcher'
import { platform } from './platform'

export const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions')
export const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions')
export const CODEX_SESSION_INDEX = path.join(os.homedir(), '.codex', 'session_index.jsonl')

const POLL_MS = 2000
const DEBOUNCE_MS = 120
/** Completed Codex threads remain visible briefly; active threads stay indefinitely. */
const CODEX_RECENT_MS = 30 * 60 * 1000

interface RawSession {
  pid?: unknown
  sessionId?: unknown
  cwd?: unknown
  name?: unknown
  kind?: unknown
  status?: unknown
  version?: unknown
  entrypoint?: unknown
  startedAt?: unknown
  updatedAt?: unknown
  statusUpdatedAt?: unknown
  jobId?: unknown
  parkedJobId?: unknown
}

interface CodexCacheEntry {
  size: number
  mtimeMs: number
  parsed: ParsedCodexRollout
}

/** Structurally identical to `AgentProcess`; kept as the name this module uses. */
export interface CodexTuiProcess {
  pid: number
  startedAt: number
  commandLine: string
}

export interface ParsedCodexRollout {
  session: SessionState | null
  interactions: PendingInteraction[]
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function timestamp(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') return ''
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact || compact.startsWith('<') || compact.startsWith('[')) return ''
  return compact.length > 120 ? `${compact.slice(0, 117)}…` : compact
}

/**
 * Codex rollout files do not contain a PID. The process list is the
 * authoritative signal that a TUI still exists; a rollout can end forever on
 * `task_started` when the user closes the tab or runs `/exit`.
 *
 * `null` means "could not tell" and is NOT the same as `[]` — see the pruning
 * decision in `scan`, which treats any non-null result as authoritative.
 */
function listCodexTuiProcesses(): Promise<CodexTuiProcess[] | null> {
  return platform.processes.listCodexTuiProcesses()
}

/**
 * Associates live TUI processes with their rollouts. Managed resumes include
 * the UUID in argv and match exactly. A directly-launched `codex` process does
 * not, so its creation time is paired with the nearest session_meta record.
 */
export function matchCodexTuiProcesses(
  sessions: SessionState[],
  processes: CodexTuiProcess[]
): Map<string, CodexTuiProcess> {
  const matches = new Map<string, CodexTuiProcess>()
  const remainingSessions = sessions.filter(
    (session) => session.agent === 'codex' && session.kind.toLowerCase() === 'codex-tui'
  )
  const remainingProcesses = [...processes]

  for (let sessionIndex = remainingSessions.length - 1; sessionIndex >= 0; sessionIndex--) {
    const session = remainingSessions[sessionIndex]
    const processIndex = remainingProcesses.findIndex((process) =>
      process.commandLine.toLowerCase().includes(session.sessionId.toLowerCase())
    )
    if (processIndex < 0) continue
    matches.set(session.key, remainingProcesses[processIndex])
    remainingSessions.splice(sessionIndex, 1)
    remainingProcesses.splice(processIndex, 1)
  }

  const MAX_START_DELTA_MS = 60_000
  while (remainingSessions.length > 0 && remainingProcesses.length > 0) {
    let bestSession = -1
    let bestProcess = -1
    let bestDelta = Number.POSITIVE_INFINITY
    for (let sessionIndex = 0; sessionIndex < remainingSessions.length; sessionIndex++) {
      for (let processIndex = 0; processIndex < remainingProcesses.length; processIndex++) {
        const delta = Math.abs(
          remainingSessions[sessionIndex].startedAt - remainingProcesses[processIndex].startedAt
        )
        if (delta < bestDelta) {
          bestDelta = delta
          bestSession = sessionIndex
          bestProcess = processIndex
        }
      }
    }
    if (bestDelta > MAX_START_DELTA_MS) break
    const [session] = remainingSessions.splice(bestSession, 1)
    const [process] = remainingProcesses.splice(bestProcess, 1)
    matches.set(session.key, process)
  }

  return matches
}

/**
 * Codex Desktop stores its sidebar labels separately from rollout transcripts.
 * The UUID in this append-only index is the same UUID used by session_meta.
 */
export function parseCodexTitleIndex(text: string): Map<string, string> {
  const titles = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123) continue
    try {
      const record = JSON.parse(line) as Record<string, unknown>
      const id = str(record.id, str(record.session_id))
      const title = cleanTitle(record.thread_name) || cleanTitle(record.title)
      if (id && title) titles.set(id, title)
    } catch {
      // A partially-written final line is normal while Codex Desktop is open.
    }
  }
  return titles
}

async function readCodexTitleIndex(): Promise<Map<string, string>> {
  try {
    return parseCodexTitleIndex(await fsp.readFile(CODEX_SESSION_INDEX, 'utf8'))
  } catch {
    return new Map()
  }
}

/**
 * A PID is live if signalling it does not throw ESRCH. EPERM still proves that
 * the process exists, even if it belongs to an elevated/foreign user.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function toAgentStatus(raw: string): AgentStatus {
  if (raw === 'idle') return 'idle'
  if (raw === 'busy') return 'busy'
  return 'unknown'
}

function parseClaudeSession(fileName: string, text: string): SessionState | null {
  let raw: RawSession
  try {
    raw = JSON.parse(text) as RawSession
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null

  const pidFromName = Number.parseInt(path.basename(fileName, '.json'), 10)
  const pid = Number.isInteger(pidFromName) ? pidFromName : num(raw.pid, -1)
  if (pid <= 0) return null

  const cwd = str(raw.cwd)
  const rawStatus = str(raw.status)
  const sessionId = str(raw.sessionId, `pid-${pid}`)
  const kind = str(raw.kind, 'unknown')
  return {
    key: `claude:${sessionId}`,
    agent: 'claude',
    pid,
    sessionId,
    cwd,
    name: str(raw.name) || (cwd ? path.basename(cwd) : `pid ${pid}`),
    kind,
    version: str(raw.version) || undefined,
    entrypoint: str(raw.entrypoint) || undefined,
    status: toAgentStatus(rawStatus),
    rawStatus: rawStatus || undefined,
    startedAt: num(raw.startedAt),
    updatedAt: num(raw.updatedAt),
    statusUpdatedAt:
      raw.statusUpdatedAt === undefined ? undefined : num(raw.statusUpdatedAt),
    jobId: str(raw.jobId) || undefined,
    parkedJobId: str(raw.parkedJobId) || undefined,
    needsInput: false,
    canTerminate: true,
    // Claude's daemon-backed background PTY has no user-facing host window.
    canFocus: kind !== 'bg'
  }
}

function recordObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return recordObject(JSON.parse(value))
    } catch {
      return null
    }
  }
  return recordObject(value)
}

function normalizeRolloutQuestions(value: unknown): StructuredQuestion[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw, index) => {
    const question = recordObject(raw)
    if (!question) return []
    const prompt = str(question.question).trim()
    if (!prompt) return []
    const options = Array.isArray(question.options)
      ? question.options.flatMap((candidate) => {
          const option = recordObject(candidate)
          const label = option ? str(option.label).trim() : ''
          return label
            ? [{ label, description: str(option?.description).trim() || undefined }]
            : []
        })
      : []
    return [{
      id: str(question.id).trim() || `question-${index + 1}`,
      header: str(question.header).trim() || `Question ${index + 1}`,
      question: prompt,
      options,
      selectionMode:
        question.multiSelect === true || question.selectionMode === 'multiple'
          ? 'multiple'
          : 'single',
      allowOther: question.isOther === true || question.allowOther === true,
      secret: question.isSecret === true || question.secret === true
    } satisfies StructuredQuestion]
  })
}

export function parseCodexRollout(
  file: string,
  text: string,
  mtimeMs: number
): ParsedCodexRollout {
  let sessionId = ''
  let cwd = ''
  let transcriptTitle = ''
  let firstUserPrompt = ''
  let originator = 'Codex'
  let version = ''
  let startedAt = 0
  let lastTaskStarted = 0
  let lastTaskComplete = 0
  const pendingUserInput = new Map<
    string,
    { questions: StructuredQuestion[]; receivedAt: number }
  >()

  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) !== 123) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const payload =
      record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
        ? (record.payload as Record<string, unknown>)
        : {}
    const recordTime = timestamp(record.timestamp, mtimeMs)

    if (record.type === 'session_meta') {
      sessionId = str(payload.id) || str(payload.session_id)
      cwd = str(payload.cwd)
      transcriptTitle =
        cleanTitle(payload.thread_name) ||
        cleanTitle(payload.title) ||
        cleanTitle(payload.name)
      originator = str(payload.originator, str(payload.source, 'Codex'))
      version = str(payload.cli_version)
      startedAt = timestamp(payload.timestamp, recordTime)
      continue
    }

    if (record.type === 'event_msg' && payload.type === 'user_message' && !firstUserPrompt) {
      firstUserPrompt = cleanTitle(payload.message)
    } else if (record.type === 'event_msg' && payload.type === 'task_started') {
      lastTaskStarted = Math.max(lastTaskStarted, timestamp(payload.started_at, recordTime))
    } else if (record.type === 'event_msg' && payload.type === 'task_complete') {
      lastTaskComplete = Math.max(lastTaskComplete, timestamp(payload.completed_at, recordTime))
    } else if (
      (record.type === 'response_item' || record.type === 'custom_tool_call') &&
      (payload.type === 'function_call' || payload.type === 'custom_tool_call')
    ) {
      const name = str(payload.name)
      const callId = str(payload.call_id, str(payload.id))
      if (callId && /request_user_input|askuserquestion|ask_user/i.test(name)) {
        const args = parseArguments(payload.arguments)
        pendingUserInput.set(callId, {
          questions: normalizeRolloutQuestions(args?.questions),
          receivedAt: recordTime
        })
      }
    } else if (
      record.type === 'response_item' &&
      (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')
    ) {
      pendingUserInput.delete(str(payload.call_id, str(payload.id)))
    }
  }

  if (!sessionId) return { session: null, interactions: [] }
  const active = lastTaskStarted > lastTaskComplete
  const needsInput = active && pendingUserInput.size > 0
  const status: AgentStatus = needsInput ? 'needs-input' : active ? 'busy' : 'idle'
  const name =
    transcriptTitle ||
    firstUserPrompt ||
    (cwd ? path.basename(cwd.replace(/^\\\\\?\\/, '')) : 'Codex session')
  const session: SessionState = {
    key: `codex:${sessionId}`,
    agent: 'codex',
    sessionId,
    cwd: cwd.replace(/^\\\\\?\\/, ''),
    name,
    kind: originator,
    version: version || undefined,
    entrypoint: originator,
    status,
    rawStatus: active ? 'task_started' : 'task_complete',
    startedAt: startedAt || mtimeMs,
    updatedAt: mtimeMs,
    statusUpdatedAt: Math.max(lastTaskStarted, lastTaskComplete, mtimeMs),
    needsInput,
    needsInputReason: needsInput ? 'Codex is waiting for your answer' : undefined,
    needsInputAt: needsInput ? lastTaskStarted : undefined,
    transcriptPath: file,
    canTerminate: false,
    canFocus: true
  }
  const interactions: PendingInteraction[] = (active ? [...pendingUserInput.entries()] : []).flatMap(
    ([callId, pending]) =>
      pending.questions.length > 0
        ? [{
            id: `codex-rollout:${sessionId}:${callId}`,
            kind: 'questions',
            agent: 'codex',
            sessionId,
            cwd: session.cwd,
            transport: 'codex-rollout',
            answerable: false,
            receivedAt: pending.receivedAt,
            questions: pending.questions
          } satisfies PendingInteraction]
        : []
  )
  return { session, interactions }
}

/**
 * Turns the open Claude Design windows into session rows.
 *
 * Design runs against claude.ai and writes nothing to disk, so unlike Claude
 * Code and Codex there is no transcript to derive busy/idle from. Presence is
 * the whole signal: an open window is reported `idle`, with `rawStatus` saying
 * where that came from. `firstSeen` is read and extended in place so a window
 * keeps a stable "open since" instead of resetting on every sweep.
 */
export function toDesignSessions(
  windows: DesignWindow[],
  firstSeen: Map<string, number>,
  now: number
): SessionState[] {
  const ordered = [...windows].sort((a, b) => (BigInt(a.handle) < BigInt(b.handle) ? -1 : 1))
  return ordered.map((window, index) => {
    let openedAt = firstSeen.get(window.handle)
    if (openedAt === undefined) {
      openedAt = now
      firstSeen.set(window.handle, openedAt)
    }
    return {
      key: `claude-design:${window.handle}`,
      agent: 'claude-design',
      // Claude Desktop's PID, shared by every one of its windows. Useful for
      // debugging; never a termination target — see `terminate`.
      pid: window.pid,
      sessionId: `design-${window.handle}`,
      cwd: '',
      location: 'claude.ai/design',
      name: ordered.length > 1 ? `${window.title} ${index + 1}` : window.title,
      kind: 'design',
      entrypoint: 'desktop',
      status: 'idle',
      rawStatus: 'window-open',
      startedAt: openedAt,
      updatedAt: openedAt,
      statusUpdatedAt: openedAt,
      needsInput: false,
      windowHandle: window.handle,
      canTerminate: false,
      canFocus: true
    }
  })
}

async function listJsonl(dir: string): Promise<string[]> {
  const output: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return output
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) output.push(...(await listJsonl(full)))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(full)
  }
  return output
}

/**
 * Resolves a session that has handed its conversation to a background job.
 *
 * Claude Code parks the interactive session and starts a `bg` one, linking them
 * with `parkedJobId` -> `jobId`. The parked file is never written again, so it
 * keeps whatever status it had at handoff — usually `busy` — and would show as
 * a permanent second "Working" row for the same conversation.
 *
 * `liveJobIds` must come from PID liveness, not from the rows being displayed.
 * Idle `bg` rows are pruned before this runs, so deriving the set from the
 * surviving rows made an alive-but-idle job look gone and let its parent back
 * in as a permanent "Working".
 *
 * A parent whose job is live is dropped. A parent whose job has really exited
 * is the only row left for that work so it stays — but reported idle, because
 * a file that is never rewritten can never be trusted to say it is busy.
 */
export function resolveParkedParents(
  sessions: SessionState[],
  liveJobIds: ReadonlySet<string>
): SessionState[] {
  const output: SessionState[] = []
  for (const session of sessions) {
    if (!session.parkedJobId) {
      output.push(session)
      continue
    }
    if (liveJobIds.has(session.parkedJobId)) continue
    // `rawStatus` is left alone so the stale file value stays visible.
    output.push({ ...session, status: 'idle', needsInput: false })
  }
  return output
}

/** A completed daemon-backed background job has no window and no live work. */
export function isInactiveClaudeBackground(session: SessionState): boolean {
  return (
    session.agent === 'claude' &&
    session.kind === 'bg' &&
    session.rawStatus !== 'busy'
  )
}

export function countSessions(sessions: SessionState[]): SessionCounts {
  const counts: SessionCounts = {
    total: sessions.length,
    idle: 0,
    busy: 0,
    needsInput: 0,
    reviewing: 0,
    unknown: 0
  }
  for (const session of sessions) {
    if (session.needsInput || session.status === 'needs-input') counts.needsInput++
    else if (session.status === 'busy') counts.busy++
    else if (session.status === 'idle') counts.idle++
    else if (session.status === 'reviewing') counts.reviewing++
    else counts.unknown++
  }
  return counts
}

/** Human-blocked > review gate > working > idle. */
export function aggregateColor(sessions: SessionState[]): NotchColor {
  if (sessions.length === 0) return 'grey'
  if (sessions.some((session) => session.needsInput)) return 'red'
  if (sessions.some((session) => session.status === 'reviewing')) return 'blue'
  if (sessions.some((session) => session.status === 'busy')) return 'yellow'
  return 'green'
}

export class SessionWatcher extends EventEmitter {
  private watchers: fs.FSWatcher[] = []
  private pollTimer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private scanning = false
  private rescanQueued = false
  private snapshot: SessionsSnapshot = {
    sessions: [],
    color: 'grey',
    counts: countSessions([]),
    prunedCount: 0,
    parkedCount: 0,
    scannedAt: 0
  }
  private needsInput = new Map<string, { reason: string; at: number }>()
  private reviewing = new Set<string>()
  private suppressed = new Set<string>()
  private codexCache = new Map<string, CodexCacheEntry>()
  private externalInteractions: PendingInteraction[] = []
  private lastInteractionsSerialized = ''
  private lastSerialized = ''
  private design = new DesignWatcher()
  private designFirstSeen = new Map<string, number>()

  start(): void {
    this.attachWatchers()
    this.design.on('update', () => this.queueScan())
    this.design.start()
    this.pollTimer = setInterval(() => void this.scan(), POLL_MS)
    void this.scan()
  }

  stop(): void {
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    this.design.removeAllListeners('update')
    this.design.stop()
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.pollTimer = null
    this.debounceTimer = null
  }

  getSnapshot(): SessionsSnapshot {
    return this.snapshot
  }

  getPendingInteractions(): PendingInteraction[] {
    return this.externalInteractions
  }

  setNeedsInput(sessionId: string, reason: string): void {
    if (!sessionId) return
    this.needsInput.set(sessionId, { reason, at: Date.now() })
    this.reviewing.delete(sessionId)
    void this.scan()
  }

  clearNeedsInput(sessionId: string): void {
    if (sessionId && this.needsInput.delete(sessionId)) void this.scan()
  }

  markReviewing(sessionId: string): void {
    if (!sessionId) return
    this.needsInput.delete(sessionId)
    // The hook can arrive before the latest session-file write is reflected in
    // our snapshot. Add provisionally; scanOnce keeps it only while raw=busy.
    this.reviewing.add(sessionId)
    void this.scan()
  }

  expireNeedsInput(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs
    let changed = false
    for (const [id, entry] of this.needsInput) {
      if (entry.at < cutoff) {
        this.needsInput.delete(id)
        changed = true
      }
    }
    if (changed) void this.scan()
  }

  async terminate(key: string): Promise<SessionActionResult> {
    const session = this.snapshot.sessions.find((candidate) => candidate.key === key)
    if (!session) return { ok: false, message: 'Session is no longer available.' }
    // Only Claude Code owns a process that is safe to kill. A design row's PID
    // is Claude Desktop itself, so killing it would take the whole app down.
    if (session.agent !== 'claude' || !session.pid) {
      this.suppressed.add(key)
      void this.scan()
      return {
        ok: true,
        message:
          session.agent === 'claude-design'
            ? 'Claude Design shares one process with Claude Desktop, so it cannot be ended from here. The row was hidden; close the Design window to remove it for good.'
            : 'Codex does not expose a per-thread PID. The thread was hidden; its transcript was not deleted.'
      }
    }

    try {
      process.kill(session.pid)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ESRCH') {
        return {
          ok: false,
          message:
            code === 'EPERM'
              ? 'The operating system refused to terminate this process (it may be elevated).'
              : `Could not terminate the process: ${(err as Error).message}`
        }
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
    if (isPidAlive(session.pid)) {
      return { ok: false, message: 'The process is still running.' }
    }
    this.suppressed.add(key)
    void this.scan()
    return { ok: true, message: 'Session ended and hidden. Its transcript was preserved.' }
  }

  private attachWatchers(): void {
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    const attach = (dir: string, recursive: boolean): void => {
      try {
        fs.mkdirSync(dir, { recursive: true })
        const watcher = fs.watch(dir, { recursive }, () => this.queueScan())
        watcher.on('error', () => {
          watcher.close()
          this.watchers = this.watchers.filter((candidate) => candidate !== watcher)
        })
        this.watchers.push(watcher)
      } catch {
        // The safety poll remains authoritative.
      }
    }
    attach(SESSIONS_DIR, false)
    attach(CODEX_SESSIONS_DIR, true)
  }

  private queueScan(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => void this.scan(), DEBOUNCE_MS)
  }

  private async scan(): Promise<void> {
    if (this.scanning) {
      this.rescanQueued = true
      return
    }
    this.scanning = true
    try {
      await this.scanOnce()
    } finally {
      this.scanning = false
      if (this.rescanQueued) {
        this.rescanQueued = false
        void this.scan()
      }
    }
  }

  private async scanOnce(): Promise<void> {
    const sessions: SessionState[] = []
    let pruned = 0
    let error: string | undefined
    const liveClaudeIds = new Set<string>()
    // Filled from every live PID, before any display pruning, so that
    // `resolveParkedParents` judges a job by its process and not by whether
    // its row happened to survive the filters below.
    const liveJobIds = new Set<string>()

    try {
      const files = (await fsp.readdir(SESSIONS_DIR)).filter((file) => file.endsWith('.json'))
      for (const file of files) {
        let text: string
        try {
          text = await fsp.readFile(path.join(SESSIONS_DIR, file), 'utf8')
        } catch {
          continue
        }
        const session = parseClaudeSession(file, text)
        if (!session) continue
        if (!session.pid || !isPidAlive(session.pid)) {
          pruned++
          continue
        }
        if (session.jobId) liveJobIds.add(session.jobId)
        if (isInactiveClaudeBackground(session)) {
          pruned++
          continue
        }
        liveClaudeIds.add(session.sessionId)
        const blocked = this.needsInput.get(session.sessionId)
        if (blocked) {
          session.needsInput = true
          session.status = 'needs-input'
          session.needsInputReason = blocked.reason
          session.needsInputAt = blocked.at
        } else if (this.reviewing.has(session.sessionId)) {
          if (session.rawStatus === 'busy') session.status = 'reviewing'
          else this.reviewing.delete(session.sessionId)
        }
        if (!this.suppressed.has(session.key)) sessions.push(session)
      }
    } catch (err) {
      error = (err as Error).message
    }

    for (const id of [...this.needsInput.keys()]) {
      if (!liveClaudeIds.has(id)) this.needsInput.delete(id)
    }
    for (const id of [...this.reviewing]) {
      if (!liveClaudeIds.has(id)) this.reviewing.delete(id)
    }

    const [codexFiles, codexTitles, codexTuiProcesses] = await Promise.all([
      listJsonl(CODEX_SESSIONS_DIR),
      readCodexTitleIndex(),
      listCodexTuiProcesses()
    ])
    const codexRows: { session: SessionState; interactions: PendingInteraction[] }[] = []
    const knownCodexFiles = new Set(codexFiles)
    for (const file of codexFiles) {
      let stat: fs.Stats
      try {
        stat = await fsp.stat(file)
      } catch {
        continue
      }
      let cached = this.codexCache.get(file)
      if (!cached || cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) {
        let text: string
        try {
          text = await fsp.readFile(file, 'utf8')
        } catch {
          continue
        }
        cached = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          parsed: parseCodexRollout(file, text, stat.mtimeMs)
        }
        this.codexCache.set(file, cached)
      }
      const cachedSession = cached.parsed.session
      const indexedTitle = cachedSession ? codexTitles.get(cachedSession.sessionId) : undefined
      if (!cachedSession) continue
      codexRows.push({
        session: {
          ...cachedSession,
          ...(indexedTitle ? { name: indexedTitle } : {})
        },
        interactions: cached.parsed.interactions
      })
    }
    for (const file of [...this.codexCache.keys()]) {
      if (!knownCodexFiles.has(file)) this.codexCache.delete(file)
    }

    const codexInteractions: PendingInteraction[] = []
    const tuiMatches =
      codexTuiProcesses === null
        ? null
        : matchCodexTuiProcesses(
            codexRows.map((row) => row.session),
            codexTuiProcesses
          )
    for (const row of codexRows) {
      const { session } = row
      if (this.suppressed.has(session.key)) continue
      const isTui = session.kind.toLowerCase() === 'codex-tui'
      const tuiProcess = tuiMatches?.get(session.key)
      // A successful process sweep is authoritative for TUI lifetime. `/exit`,
      // a closed tab, or a crash can leave the rollout permanently "busy".
      if (isTui && tuiMatches !== null && !tuiProcess) continue
      if (tuiProcess) {
        session.pid = tuiProcess.pid
      }
      for (const interaction of row.interactions) {
        if (!this.suppressed.has(`codex:${interaction.sessionId}`)) {
          codexInteractions.push(interaction)
        }
      }
      const active = session.status === 'busy' || session.status === 'needs-input'
      // A matched TUI remains a live session even after its current task goes
      // idle; it disappears as soon as the underlying process exits.
      if (tuiProcess || active || Date.now() - session.updatedAt <= CODEX_RECENT_MS) {
        sessions.push(session)
      }
    }

    codexInteractions.sort((a, b) => a.receivedAt - b.receivedAt)
    const interactionsSerialized = JSON.stringify(codexInteractions)
    if (interactionsSerialized !== this.lastInteractionsSerialized) {
      this.lastInteractionsSerialized = interactionsSerialized
      this.externalInteractions = codexInteractions
      this.emit('interaction-change', this.externalInteractions)
    }

    const designWindows = this.design.getWindows()
    const openHandles = new Set(designWindows.map((window) => window.handle))
    for (const handle of [...this.designFirstSeen.keys()]) {
      if (!openHandles.has(handle)) this.designFirstSeen.delete(handle)
    }
    // A closed window can never come back under the same handle, so a hide of
    // it has nothing left to suppress.
    for (const key of [...this.suppressed]) {
      const handle = key.startsWith('claude-design:') ? key.slice('claude-design:'.length) : null
      if (handle && !openHandles.has(handle)) this.suppressed.delete(key)
    }
    for (const session of toDesignSessions(designWindows, this.designFirstSeen, Date.now())) {
      if (!this.suppressed.has(session.key)) sessions.push(session)
    }

    const rank = (session: SessionState): number => {
      if (session.needsInput) return 0
      if (session.status === 'reviewing') return 1
      if (session.status === 'busy') return 2
      if (session.status === 'idle') return 3
      return 4
    }
    // Before the counts and colour, so a parked row cannot inflate the pill.
    const visible = resolveParkedParents(sessions, liveJobIds)
    visible.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
    this.publish({
      sessions: visible,
      color: aggregateColor(visible),
      counts: countSessions(visible),
      prunedCount: pruned,
      parkedCount: sessions.length - visible.length,
      scannedAt: Date.now(),
      error,
      designError: this.design.getError()
    })
  }

  private publish(snapshot: SessionsSnapshot): void {
    this.snapshot = snapshot
    const serialized = JSON.stringify({
      sessions: snapshot.sessions,
      color: snapshot.color,
      counts: snapshot.counts,
      prunedCount: snapshot.prunedCount,
      error: snapshot.error,
      designError: snapshot.designError
    })
    if (serialized === this.lastSerialized) return
    this.lastSerialized = serialized
    this.emit('update', snapshot)
  }
}
