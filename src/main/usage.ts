import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentKind,
  PlanUsage,
  UsageDayCount,
  UsageSnapshot
} from '@shared/types'
import { AGENT_PATHS } from './agentPaths'

const CLAUDE_CONFIG_DIR = AGENT_PATHS.claudeRoot
export const PROJECTS_DIR = AGENT_PATHS.claudeProjects
export const CLAUDE_TRANSCRIPTS_DIR = AGENT_PATHS.claudeTranscripts
export const CLAUDE_USAGE_DIRS = [PROJECTS_DIR, CLAUDE_TRANSCRIPTS_DIR] as const
export const CODEX_PROJECTS_DIR = AGENT_PATHS.codexSessions
export const CODEX_ARCHIVED_PROJECTS_DIR = AGENT_PATHS.codexArchivedSessions
export const CODEX_USAGE_DIRS = [CODEX_PROJECTS_DIR, CODEX_ARCHIVED_PROJECTS_DIR] as const
const CLAUDE_CONFIG_PATH = process.env.CLAUDE_CONFIG_DIR
  ? path.join(CLAUDE_CONFIG_DIR, '.claude.json')
  : path.join(os.homedir(), '.claude.json')
const CLAUDE_CREDENTIALS_PATH = path.join(CLAUDE_CONFIG_DIR, '.credentials.json')
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

const CACHE_VERSION = 3
const CHUNK_BYTES = 4 * 1024 * 1024
export const BLOCK_MS = 5 * 60 * 60 * 1000
const EVENT_RETENTION_MS = 6 * 60 * 60 * 1000
const HEATMAP_DAYS = 182
const RESCAN_MS = 60_000
/**
 * Provider plan data is fetched far less often than transcripts are rescanned.
 *
 * The shortest quota window is five hours, so minute-resolution buys nothing,
 * and both fetches are expensive in a way local scanning is not: Claude's is a
 * rate-limited HTTPS call, Codex's spawns a `codex app-server` process.
 */
const PLAN_FETCH_MS = 5 * 60 * 1000
const PLAN_STALE_MS = 15 * 60 * 1000
const PROVIDER_TIMEOUT_MS = 8_000
const CLAUDE_PROVIDER_ATTEMPTS = 2
const CLAUDE_RETRY_DELAY_MS = 250
/**
 * How long to stop calling the usage endpoint after it answers 429.
 *
 * The endpoint sends `retry-after: 0`, which is useless as a wait, so a floor
 * is applied and repeated limits back off geometrically. Without this the
 * scanner re-hits a saturated endpoint every cycle and never recovers.
 */
const CLAUDE_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000
const CLAUDE_RATE_LIMIT_COOLDOWN_MAX_MS = 60 * 60 * 1000

interface UsageEvent {
  t: number
  k: number
}

interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

interface FileAggregate {
  agent: AgentKind
  size: number
  mtimeMs: number
  offset: number
  messages: number
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  days: Record<string, [number, number]>
  hours: number[]
  models: Record<string, [number, number]>
  events: UsageEvent[]
  /** Persisted so a retry appended on a later pass still deduplicates. */
  seenKeys: string[]
  codexTotals?: TokenTotals
  codexModel?: string
  codexPlan?: PlanUsage
}

interface UsageCache {
  version: number
  files: Record<string, FileAggregate>
  /** Last usable provider responses survive app restarts and transient outages. */
  providerPlans?: Partial<Record<AgentKind, PlanUsage>>
}

function emptyAggregate(agent: AgentKind): FileAggregate {
  return {
    agent,
    size: 0,
    mtimeMs: 0,
    offset: 0,
    messages: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    days: {},
    hours: new Array<number>(24).fill(0),
    models: {},
    events: [],
    seenKeys: []
  }
}

function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDays(key: string, delta: number): string {
  const [year, month, day] = key.split('-').map(Number)
  return localDateKey(new Date(year, month - 1, day + delta))
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function timestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

async function listTranscripts(dir: string): Promise<string[]> {
  const output: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return output
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) output.push(...(await listTranscripts(full)))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(full)
  }
  return output
}

/**
 * Finds transcripts across equivalent active/archive roots without counting a
 * session twice while it is being moved or mirrored. Session file basenames
 * contain globally unique IDs for both Claude and Codex; earlier roots win, so
 * the live copy is preferred over an archived or compatibility copy.
 */
export async function listUniqueTranscripts(roots: readonly string[]): Promise<string[]> {
  const groups = await Promise.all(roots.map(listTranscripts))
  const unique = new Map<string, string>()
  for (const files of groups) {
    for (const file of files) {
      const identity = path.basename(file).toLowerCase()
      if (!unique.has(identity)) unique.set(identity, file)
    }
  }
  return [...unique.values()]
}

function addUsage(
  aggregate: FileAggregate,
  when: number,
  totals: TokenTotals,
  model: string
): void {
  const total = totals.input + totals.output + totals.cacheRead + totals.cacheCreate
  if (total <= 0) return
  const date = new Date(when)

  aggregate.messages++
  aggregate.input += totals.input
  aggregate.output += totals.output
  aggregate.cacheRead += totals.cacheRead
  aggregate.cacheCreate += totals.cacheCreate

  const dateKey = localDateKey(date)
  const day = aggregate.days[dateKey] ?? [0, 0]
  day[0] += total
  day[1]++
  aggregate.days[dateKey] = day
  aggregate.hours[date.getHours()]++

  const modelEntry = aggregate.models[model] ?? [0, 0]
  modelEntry[0]++
  modelEntry[1] += total
  aggregate.models[model] = modelEntry
  aggregate.events.push({ t: when, k: total })
}

function ingestClaudeLine(
  aggregate: FileAggregate,
  record: Record<string, unknown>,
  seen: Set<string>
): void {
  if (record.type !== 'assistant') return
  const message =
    record.message && typeof record.message === 'object'
      ? (record.message as Record<string, unknown>)
      : undefined
  const usage =
    message?.usage && typeof message.usage === 'object'
      ? (message.usage as Record<string, unknown>)
      : undefined
  if (!message || !usage) return

  const id = typeof message.id === 'string' ? message.id : null
  const requestId = typeof record.requestId === 'string' ? record.requestId : null
  if (id && requestId) {
    const key = `${id}:${requestId}`
    if (seen.has(key)) return
    seen.add(key)
  }

  addUsage(
    aggregate,
    timestamp(record.timestamp),
    {
      input: numeric(usage.input_tokens),
      output: numeric(usage.output_tokens),
      cacheRead: numeric(usage.cache_read_input_tokens),
      cacheCreate: numeric(usage.cache_creation_input_tokens)
    },
    typeof message.model === 'string' ? message.model : 'unknown'
  )
}

function planLabel(windowMinutes: number, fallback: string): string {
  if (windowMinutes === 300) return '5 hour'
  if (windowMinutes === 10_080) return '7 day'
  if (windowMinutes > 0 && windowMinutes % 1440 === 0) return `${windowMinutes / 1440} day`
  if (windowMinutes > 0 && windowMinutes % 60 === 0) return `${windowMinutes / 60} hour`
  return fallback
}

function ingestCodexLine(aggregate: FileAggregate, record: Record<string, unknown>): void {
  const payload =
    record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : undefined
  if (!payload) return

  if (record.type === 'turn_context' && typeof payload.model === 'string') {
    aggregate.codexModel = payload.model
    return
  }
  if (record.type !== 'event_msg' || payload.type !== 'token_count') return

  const info =
    payload.info && typeof payload.info === 'object'
      ? (payload.info as Record<string, unknown>)
      : undefined
  const totalUsage =
    info?.total_token_usage && typeof info.total_token_usage === 'object'
      ? (info.total_token_usage as Record<string, unknown>)
      : undefined
  if (!totalUsage) return

  const currentInput = numeric(totalUsage.input_tokens)
  const currentCacheRead = numeric(totalUsage.cached_input_tokens)
  const currentCacheCreate = numeric(totalUsage.cache_write_input_tokens)
  const current: TokenTotals = {
    // Codex input_tokens includes cache tokens; store the mutually-exclusive part.
    input: Math.max(0, currentInput - currentCacheRead - currentCacheCreate),
    output: numeric(totalUsage.output_tokens),
    cacheRead: currentCacheRead,
    cacheCreate: currentCacheCreate
  }
  const previous = aggregate.codexTotals ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0
  }
  const currentTotal = current.input + current.output + current.cacheRead + current.cacheCreate
  const previousTotal =
    previous.input + previous.output + previous.cacheRead + previous.cacheCreate
  const reset = currentTotal < previousTotal
  const delta: TokenTotals = {
    input: Math.max(0, current.input - (reset ? 0 : previous.input)),
    output: Math.max(0, current.output - (reset ? 0 : previous.output)),
    cacheRead: Math.max(0, current.cacheRead - (reset ? 0 : previous.cacheRead)),
    cacheCreate: Math.max(0, current.cacheCreate - (reset ? 0 : previous.cacheCreate))
  }
  aggregate.codexTotals = current
  addUsage(
    aggregate,
    timestamp(record.timestamp),
    delta,
    aggregate.codexModel ?? 'codex'
  )

  const rateLimits =
    payload.rate_limits && typeof payload.rate_limits === 'object'
      ? (payload.rate_limits as Record<string, unknown>)
      : undefined
  if (!rateLimits) return
  const periods: PlanUsage['periods'] = []
  for (const id of ['primary', 'secondary'] as const) {
    const raw =
      rateLimits[id] && typeof rateLimits[id] === 'object'
        ? (rateLimits[id] as Record<string, unknown>)
        : undefined
    if (!raw) continue
    const windowMinutes = numeric(raw.window_minutes)
    periods.push({
      id,
      label: planLabel(windowMinutes, id),
      windowMinutes: windowMinutes || null,
      utilization: numeric(raw.used_percent),
      resetsAt: raw.resets_at == null ? null : timestamp(raw.resets_at)
    })
  }
  if (periods.length) {
    const fetchedAt = timestamp(record.timestamp)
    aggregate.codexPlan = {
      agent: 'codex',
      fetchedAt,
      stale: Date.now() - fetchedAt > PLAN_STALE_MS,
      source: 'transcript',
      state: Date.now() - fetchedAt > PLAN_STALE_MS ? 'stale' : 'fresh',
      periods
    }
  }
}

function ingestLine(aggregate: FileAggregate, line: string, seen: Set<string>): void {
  if (!line || line.charCodeAt(0) !== 123) return
  if (
    aggregate.agent === 'claude' &&
    !line.includes('"output_tokens"')
  ) {
    return
  }
  let record: Record<string, unknown>
  try {
    record = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }
  if (aggregate.agent === 'claude') ingestClaudeLine(aggregate, record, seen)
  else ingestCodexLine(aggregate, record)
}

function pruneEvents(aggregate: FileAggregate, now: number): void {
  const cutoff = now - EVENT_RETENTION_MS
  aggregate.events = aggregate.events.filter((event) => event.t >= cutoff)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function claudeWindowMinutes(id: string): number | null {
  if (id === 'five_hour') return 300
  if (id === 'seven_day' || id.startsWith('seven_day_')) return 10_080
  return null
}

export function parseClaudePlanUsage(
  payload: unknown,
  fetchedAt: number,
  source: PlanUsage['source'] = 'live'
): PlanUsage | null {
  const raw = record(payload)
  if (!raw) return null
  const periods = Object.entries(raw).flatMap(([id, value]) => {
    const period = record(value)
    if (!period || typeof period.utilization !== 'number' || !Number.isFinite(period.utilization)) {
      return []
    }
    return [
      {
        id,
        label: id.replace(/_/g, ' '),
        windowMinutes: claudeWindowMinutes(id),
        utilization: numeric(period.utilization),
        resetsAt: period.resets_at == null ? null : timestamp(period.resets_at)
      }
    ]
  })
  if (!periods.length) return null
  return {
    agent: 'claude',
    fetchedAt,
    stale: source !== 'live' || Date.now() - fetchedAt > PLAN_STALE_MS,
    source,
    state: source === 'live' ? 'fresh' : 'stale',
    periods
  }
}

export function parseCodexPlanUsage(payload: unknown, fetchedAt: number): PlanUsage | null {
  const result = record(payload)
  const rateLimits = record(result?.rateLimits ?? result?.rate_limits)
  if (!rateLimits) return null
  const periods: PlanUsage['periods'] = []
  for (const id of ['primary', 'secondary'] as const) {
    const raw = record(rateLimits[id])
    if (!raw) continue
    const rawWindowMinutes = raw.windowDurationMins ?? raw.window_minutes
    const rawUtilization = raw.usedPercent ?? raw.used_percent
    if (
      typeof rawWindowMinutes !== 'number' ||
      !Number.isFinite(rawWindowMinutes) ||
      rawWindowMinutes <= 0 ||
      typeof rawUtilization !== 'number' ||
      !Number.isFinite(rawUtilization)
    ) {
      continue
    }
    const windowMinutes = rawWindowMinutes
    const utilization = rawUtilization
    const resetsAt = raw.resetsAt ?? raw.resets_at
    periods.push({
      id,
      label: planLabel(windowMinutes, id),
      windowMinutes: windowMinutes || null,
      utilization,
      resetsAt: resetsAt == null ? null : timestamp(resetsAt)
    })
  }
  if (!periods.length) return null
  return {
    agent: 'codex',
    fetchedAt,
    stale: false,
    source: 'live',
    state: 'fresh',
    periods
  }
}

export function withoutExpiredPeriods(plan: PlanUsage, now = Date.now()): PlanUsage {
  return {
    ...plan,
    periods: plan.periods.filter((period) => period.resetsAt === null || period.resetsAt > now)
  }
}

function providerFallback(
  agent: AgentKind,
  state: PlanUsage['state'],
  message: string,
  source: PlanUsage['source'],
  candidates: Array<PlanUsage | null | undefined>
): PlanUsage {
  for (const candidate of candidates) {
    if (!candidate) continue
    const usable = withoutExpiredPeriods(candidate)
    if (!usable.periods.length) continue
    return {
      ...usable,
      stale: true,
      state,
      message
    }
  }
  return {
    agent,
    fetchedAt: null,
    stale: true,
    source,
    state: state === 'stale' ? 'unavailable' : state,
    message,
    periods: []
  }
}

async function readClaudeCachedPlanUsage(): Promise<PlanUsage | null> {
  try {
    const config = JSON.parse(await fsp.readFile(CLAUDE_CONFIG_PATH, 'utf8')) as {
      cachedUsageUtilization?: {
        fetchedAtMs?: unknown
        utilization?: unknown
      }
    }
    const cached = config.cachedUsageUtilization
    const fetchedAt = numeric(cached?.fetchedAtMs)
    if (!cached?.utilization || !fetchedAt) return null
    return parseClaudePlanUsage(cached.utilization, fetchedAt, 'cache')
  } catch {
    return null
  }
}

/**
 * Reads a `Retry-After` header, which may be a delay in seconds or an HTTP
 * date. Returns null when absent or unparseable — including the `0` this
 * endpoint actually sends, which would otherwise mean "retry immediately" and
 * defeat the cooldown entirely.
 */
export function parseRetryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed)
    return seconds > 0 ? seconds * 1000 : null
  }
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  const delta = at - now
  return delta > 0 ? delta : null
}

/** Cooldown state for the Claude usage endpoint. Module-scoped, process-wide. */
let claudeCooldownUntil = 0
let claudeConsecutiveLimits = 0

/** Test seam: clears the rate-limit cooldown. */
export function resetClaudeRateLimit(): void {
  claudeCooldownUntil = 0
  claudeConsecutiveLimits = 0
}

/** Exposed so the scanner and tests can see when the endpoint is off-limits. */
export function claudeRateLimitedUntil(): number {
  return claudeCooldownUntil
}

/**
 * Geometric backoff: 10m, 20m, 40m, capped at an hour. A server-supplied
 * `Retry-After` wins when it is longer than the floor. Pure, so the schedule
 * can be asserted without driving the network path.
 */
export function claudeCooldownMs(
  consecutiveLimits: number,
  retryAfterMs: number | null
): number {
  const attempts = Math.min(Math.max(consecutiveLimits, 1), 8)
  const backoff = Math.min(
    CLAUDE_RATE_LIMIT_COOLDOWN_MS * 2 ** (attempts - 1),
    CLAUDE_RATE_LIMIT_COOLDOWN_MAX_MS
  )
  return Math.max(backoff, retryAfterMs ?? 0)
}

function beginClaudeCooldown(retryAfterMs: number | null, now: number): number {
  claudeConsecutiveLimits = Math.min(claudeConsecutiveLimits + 1, 8)
  const wait = claudeCooldownMs(claudeConsecutiveLimits, retryAfterMs)
  claudeCooldownUntil = now + wait
  return wait
}

function rateLimitMessage(waitMs: number): string {
  const minutes = Math.max(1, Math.round(waitMs / 60_000))
  return `Claude usage is rate-limited; showing the last synced value. Retrying in ~${minutes}m.`
}

async function fetchClaudePlanUsage(
  cached: PlanUsage | null,
  previous: PlanUsage | null
): Promise<PlanUsage> {
  // Still cooling down: do not spend a request confirming what we know.
  if (Date.now() < claudeCooldownUntil) {
    return providerFallback(
      'claude',
      'stale',
      rateLimitMessage(claudeCooldownUntil - Date.now()),
      'cache',
      [cached, previous]
    )
  }

  let credentials: {
    claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown }
  }
  try {
    credentials = JSON.parse(await fsp.readFile(CLAUDE_CREDENTIALS_PATH, 'utf8')) as typeof credentials
  } catch {
    return providerFallback(
      'claude',
      'unavailable',
      'Claude credentials are unavailable. Sign in with Claude Code.',
      'cache',
      [cached, previous]
    )
  }

  const accessToken = credentials.claudeAiOauth?.accessToken
  const expiresAt = numeric(credentials.claudeAiOauth?.expiresAt)
  if (typeof accessToken !== 'string' || !accessToken) {
    return providerFallback(
      'claude',
      'unavailable',
      'Claude credentials are unavailable. Sign in with Claude Code.',
      'cache',
      [cached, previous]
    )
  }
  if (expiresAt > 0 && expiresAt <= Date.now()) {
    return providerFallback(
      'claude',
      'auth-expired',
      'Claude sign-in expired. Claude Code will renew it on your next use.',
      'cache',
      [cached, previous]
    )
  }

  let lastError: unknown
  for (let attempt = 0; attempt < CLAUDE_PROVIDER_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS)
    try {
      const response = await fetch(CLAUDE_USAGE_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20'
        },
        signal: controller.signal
      })
      if (response.status === 401 || response.status === 403) {
        return providerFallback(
          'claude',
          'auth-expired',
          'Claude sign-in expired. Claude Code will renew it on your next use.',
          'cache',
          [cached, previous]
        )
      }
      // Rate limited: retrying inside this scan is guaranteed to fail again and
      // only deepens the limit, so stop immediately and start a cooldown.
      if (response.status === 429) {
        const wait = beginClaudeCooldown(
          parseRetryAfterMs(response.headers.get('retry-after')),
          Date.now()
        )
        return providerFallback('claude', 'stale', rateLimitMessage(wait), 'cache', [
          cached,
          previous
        ])
      }
      if (!response.ok) throw new Error(`Claude usage returned HTTP ${response.status}`)
      const plan = parseClaudePlanUsage(await response.json(), Date.now())
      if (!plan) throw new Error('Claude usage returned an unexpected response')
      claudeConsecutiveLimits = 0
      claudeCooldownUntil = 0
      return plan
    } catch (err) {
      lastError = err
    } finally {
      clearTimeout(timeout)
    }
    if (attempt + 1 < CLAUDE_PROVIDER_ATTEMPTS) {
      await new Promise<void>((resolve) => setTimeout(resolve, CLAUDE_RETRY_DELAY_MS))
    }
  }

  const timedOut = lastError instanceof Error && lastError.name === 'AbortError'
  return providerFallback(
    'claude',
    'stale',
    timedOut
      ? 'Claude usage refresh timed out; showing the last synced value.'
      : 'Claude usage refresh failed; showing the last synced value.',
    'cache',
    [cached, previous]
  )
}

async function fetchCodexPlanUsage(
  transcript: PlanUsage | null,
  previous: PlanUsage | null
): Promise<PlanUsage> {
  const fallback = (message: string): PlanUsage =>
    providerFallback('codex', 'stale', message, 'transcript', [transcript, previous])

  return new Promise<PlanUsage>((resolve) => {
    let settled = false
    let carry = ''
    const child = spawn(process.env.CODEX_CLI_PATH || 'codex', ['app-server'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    const finish = (plan: PlanUsage): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.stdin.end()
      if (!child.killed) child.kill()
      resolve(plan)
    }
    const timeout = setTimeout(
      () => finish(fallback('Codex usage refresh timed out.')),
      PROVIDER_TIMEOUT_MS
    )

    child.once('error', () => finish(fallback('Codex CLI is unavailable.')))
    child.once('close', () => {
      if (!settled) finish(fallback('Codex usage refresh ended unexpectedly.'))
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      carry += chunk
      for (;;) {
        const newline = carry.indexOf('\n')
        if (newline < 0) break
        const line = carry.slice(0, newline).trim()
        carry = carry.slice(newline + 1)
        if (!line) continue
        try {
          const message = JSON.parse(line) as {
            id?: unknown
            result?: unknown
            error?: unknown
          }
          if (message.id !== 2) continue
          if (message.error) {
            finish(fallback('Codex usage refresh failed.'))
            return
          }
          const plan = parseCodexPlanUsage(message.result, Date.now())
          finish(plan ?? fallback('Codex usage returned an unexpected response.'))
          return
        } catch {
          // Ignore notifications and non-JSON diagnostics.
        }
      }
    })

    child.stdin.write(
      `${JSON.stringify({
        method: 'initialize',
        id: 1,
        params: {
          clientInfo: {
            name: 'notch',
            title: 'Notch',
            version: '0.2.0'
          }
        }
      })}\n`
    )
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
    child.stdin.write(
      `${JSON.stringify({ method: 'account/rateLimits/read', id: 2, params: {} })}\n`
    )
  })
}

export class UsageScanner extends EventEmitter {
  private readonly cachePath: string
  private cache: UsageCache = { version: CACHE_VERSION, files: {} }
  private snapshot: UsageSnapshot = emptySnapshot(true)
  private timer: NodeJS.Timeout | null = null
  private scanPromise: Promise<UsageSnapshot> | null = null
  private readonly lastProviderPlans = new Map<AgentKind, PlanUsage>()
  /** When the provider plan endpoints were last polled. 0 = never. */
  private planFetchedAt = 0
  /**
   * Exactly what was presented on the last polling scan, replayed on the scans
   * in between. Distinct from `lastProviderPlans`, which only remembers plans
   * that carry usable periods: a zero-period result still carries the message
   * explaining *why* there is no data, and dropping it would blank the reason
   * out between polls.
   */
  private lastPlanSnapshot: PlanUsage[] = []
  lastPassBytes = 0

  constructor(userDataDir: string) {
    super()
    this.cachePath = path.join(userDataDir, 'usage-cache.json')
  }

  getSnapshot(): UsageSnapshot {
    return this.snapshot
  }

  async start(): Promise<void> {
    await this.loadCache()
    this.timer = setInterval(() => void this.runScan(), RESCAN_MS)
    await this.runScan()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async refresh(): Promise<UsageSnapshot> {
    const active = this.scanPromise
    if (active) await active
    return this.runScan(true)
  }

  private async loadCache(): Promise<void> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.cachePath, 'utf8')) as UsageCache
      if (parsed?.version !== CACHE_VERSION || !parsed.files) throw new Error('old cache')
      this.cache = parsed
      for (const aggregate of Object.values(this.cache.files)) {
        if (!Array.isArray(aggregate.hours) || aggregate.hours.length !== 24) {
          aggregate.hours = new Array<number>(24).fill(0)
        }
        if (!Array.isArray(aggregate.events)) aggregate.events = []
        if (!Array.isArray(aggregate.seenKeys)) aggregate.seenKeys = []
      }
      for (const [agent, plan] of Object.entries(this.cache.providerPlans ?? {})) {
        if (
          (agent === 'claude' || agent === 'codex') &&
          plan &&
          plan.agent === agent &&
          Array.isArray(plan.periods) &&
          plan.periods.length > 0
        ) {
          this.lastProviderPlans.set(agent, plan)
        }
      }
    } catch {
      this.cache = { version: CACHE_VERSION, files: {} }
    }
  }

  private async saveCache(): Promise<void> {
    try {
      await fsp.mkdir(path.dirname(this.cachePath), { recursive: true })
      const temporary = `${this.cachePath}.tmp`
      await fsp.writeFile(temporary, JSON.stringify(this.cache), 'utf8')
      await fsp.rename(temporary, this.cachePath)
    } catch {
      // A failed cache write only makes the next launch rescan.
    }
  }

  private runScan(forcePlanFetch = false): Promise<UsageSnapshot> {
    if (this.scanPromise) return this.scanPromise
    const operation = this.scanOnce(forcePlanFetch).finally(() => {
      if (this.scanPromise === operation) this.scanPromise = null
    })
    this.scanPromise = operation
    return operation
  }

  private async scanOnce(forcePlanFetch = false): Promise<UsageSnapshot> {
    this.lastPassBytes = 0
    try {
      const [claudeFiles, codexFiles, claudeCached] = await Promise.all([
        listUniqueTranscripts(CLAUDE_USAGE_DIRS),
        listUniqueTranscripts(CODEX_USAGE_DIRS),
        readClaudeCachedPlanUsage()
      ])
      const sources = new Map<string, AgentKind>()
      for (const file of claudeFiles) sources.set(file, 'claude')
      for (const file of codexFiles) sources.set(file, 'codex')

      for (const [file, agent] of sources) {
        await this.scanFile(file, agent)
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      for (const known of Object.keys(this.cache.files)) {
        if (!sources.has(known)) delete this.cache.files[known]
      }

      const codexTranscript = Object.values(this.cache.files)
        .filter((aggregate) => aggregate.agent === 'codex' && aggregate.codexPlan)
        .map((aggregate) => aggregate.codexPlan!)
        .sort((a, b) => (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0))[0] ?? null
      if (codexTranscript) {
        codexTranscript.stale =
          codexTranscript.fetchedAt === null ||
          Date.now() - codexTranscript.fetchedAt > PLAN_STALE_MS
        codexTranscript.state = codexTranscript.stale ? 'stale' : 'fresh'
      }
      // Transcripts are cheap to rescan every minute; the plan endpoints are
      // not, so they run on their own slower clock. The Rescan button forces a
      // poll — but never bypasses an active rate-limit cooldown, which would
      // just re-trip the limit.
      const planDue =
        forcePlanFetch ||
        this.planFetchedAt === 0 ||
        Date.now() - this.planFetchedAt >= PLAN_FETCH_MS
      let planUsage: PlanUsage[]
      if (planDue) {
        planUsage = await Promise.all([
          fetchClaudePlanUsage(
            claudeCached,
            this.lastProviderPlans.get('claude') ?? null
          ),
          fetchCodexPlanUsage(
            codexTranscript,
            this.lastProviderPlans.get('codex') ?? null
          )
        ])
        this.planFetchedAt = Date.now()
        this.lastPlanSnapshot = planUsage
      } else {
        // Between polls, replay the last presented result verbatim: the
        // snapshot is rebuilt from scratch on every scan, so anything not
        // carried forward here disappears from the UI.
        planUsage = this.lastPlanSnapshot
      }
      for (const plan of planUsage) {
        if (!plan.periods.length) continue
        const remembered = this.lastProviderPlans.get(plan.agent)
        const rememberedAt = remembered?.fetchedAt ?? 0
        const fetchedAt = plan.fetchedAt ?? 0
        if (!remembered || fetchedAt > rememberedAt || plan.state === 'fresh') {
          this.lastProviderPlans.set(plan.agent, plan)
          this.cache.providerPlans ??= {}
          this.cache.providerPlans[plan.agent] = plan
        }
      }

      this.snapshot = this.derive(planUsage)
      await this.saveCache()
      this.emit('update', this.snapshot)
      return this.snapshot
    } catch (err) {
      this.emit('error', err)
      return this.snapshot
    }
  }

  private async scanFile(file: string, agent: AgentKind): Promise<void> {
    let stat: import('node:fs').Stats
    try {
      stat = await fsp.stat(file)
    } catch {
      return
    }

    let aggregate = this.cache.files[file]
    if (!aggregate || aggregate.agent !== agent) {
      aggregate = emptyAggregate(agent)
      this.cache.files[file] = aggregate
    } else if (stat.size < aggregate.offset) {
      aggregate = emptyAggregate(agent)
      this.cache.files[file] = aggregate
    } else if (stat.size === aggregate.size && stat.mtimeMs === aggregate.mtimeMs) {
      return
    }

    const start = aggregate.offset
    if (stat.size > start) {
      let handle: import('node:fs/promises').FileHandle | null = null
      try {
        handle = await fsp.open(file, 'r')
        const seen = new Set(aggregate.seenKeys)
        let position = start
        let carry = Buffer.alloc(0)
        while (position < stat.size) {
          const length = Math.min(CHUNK_BYTES, stat.size - position)
          const buffer = Buffer.allocUnsafe(length)
          const { bytesRead } = await handle.read(buffer, 0, length, position)
          if (bytesRead <= 0) break
          position += bytesRead
          this.lastPassBytes += bytesRead

          const combined =
            carry.length > 0
              ? Buffer.concat([carry, buffer.subarray(0, bytesRead)])
              : buffer.subarray(0, bytesRead)
          let lineStart = 0
          for (let index = 0; index < combined.length; index++) {
            if (combined[index] !== 10) continue
            const line = combined.subarray(lineStart, index).toString('utf8').replace(/\r$/, '')
            ingestLine(aggregate, line, seen)
            lineStart = index + 1
          }
          carry = Buffer.from(combined.subarray(lineStart))
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        aggregate.offset = position - carry.length
        aggregate.seenKeys = [...seen]
      } catch {
        return
      } finally {
        await handle?.close().catch(() => undefined)
      }
    }

    aggregate.size = stat.size
    aggregate.mtimeMs = stat.mtimeMs
    pruneEvents(aggregate, Date.now())
  }

  private derive(planUsage: PlanUsage[]): UsageSnapshot {
    const now = Date.now()
    let input = 0
    let output = 0
    let cacheRead = 0
    let cacheCreate = 0
    let messages = 0
    let sessions = 0
    const days = new Map<string, [number, number]>()
    const hours = new Array<number>(24).fill(0)
    const models = new Map<string, [number, number]>()
    const events: UsageEvent[] = []
    const byAgent = new Map<
      AgentKind,
      { totalTokens: number; messages: number; sessions: number }
    >([
      ['claude', { totalTokens: 0, messages: 0, sessions: 0 }],
      ['codex', { totalTokens: 0, messages: 0, sessions: 0 }]
    ])

    for (const aggregate of Object.values(this.cache.files)) {
      if (aggregate.messages === 0) continue
      const aggregateTotal =
        aggregate.input + aggregate.output + aggregate.cacheRead + aggregate.cacheCreate
      const agent = byAgent.get(aggregate.agent)!
      agent.totalTokens += aggregateTotal
      agent.messages += aggregate.messages
      agent.sessions++

      sessions++
      input += aggregate.input
      output += aggregate.output
      cacheRead += aggregate.cacheRead
      cacheCreate += aggregate.cacheCreate
      messages += aggregate.messages
      for (const [date, [tokens, count]] of Object.entries(aggregate.days)) {
        const current = days.get(date) ?? [0, 0]
        days.set(date, [current[0] + tokens, current[1] + count])
      }
      for (let hour = 0; hour < 24; hour++) hours[hour] += aggregate.hours[hour] ?? 0
      for (const [model, [count, tokens]] of Object.entries(aggregate.models)) {
        const current = models.get(model) ?? [0, 0]
        models.set(model, [current[0] + count, current[1] + tokens])
      }
      for (const event of aggregate.events) {
        if (event.t >= now - BLOCK_MS) events.push(event)
      }
    }

    const activeDates = [...days.keys()].sort()
    let longestStreak = 0
    let run = 0
    let previous: string | null = null
    for (const date of activeDates) {
      run = previous !== null && addDays(previous, 1) === date ? run + 1 : 1
      longestStreak = Math.max(longestStreak, run)
      previous = date
    }

    const today = localDateKey(new Date(now))
    let currentStreak = 0
    let cursor = days.has(today) ? today : addDays(today, -1)
    while (days.has(cursor)) {
      currentStreak++
      cursor = addDays(cursor, -1)
    }

    let peakHour: number | null = null
    let peakCount = 0
    for (let hour = 0; hour < 24; hour++) {
      if (hours[hour] > peakCount) {
        peakCount = hours[hour]
        peakHour = hour
      }
    }

    const modelBreakdown = [...models.entries()]
      .map(([model, [count, tokens]]) => ({ model, messages: count, tokens }))
      .sort((a, b) => b.messages - a.messages)
    const heatmap: UsageDayCount[] = []
    const first = addDays(today, -(HEATMAP_DAYS - 1))
    for (let date = first; ; date = addDays(date, 1)) {
      const [tokens, count] = days.get(date) ?? [0, 0]
      heatmap.push({ date, tokens, messages: count })
      if (date === today) break
    }

    events.sort((a, b) => a.t - b.t)
    const blockTokens = events.reduce((sum, event) => sum + event.k, 0)
    const blockStart = events[0]?.t ?? null

    return {
      totalTokens: input + output + cacheRead + cacheCreate,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreate,
      messages,
      sessions,
      activeDays: days.size,
      currentStreak,
      longestStreak,
      peakHour,
      favoriteModel: modelBreakdown[0]?.model ?? null,
      modelBreakdown,
      days: heatmap,
      block: {
        tokens: blockTokens,
        messages: events.length,
        startedAt: blockStart,
        resetsAt: blockStart === null ? null : blockStart + BLOCK_MS
      },
      filesTracked: Object.keys(this.cache.files).length,
      scannedAt: now,
      scanning: false,
      agentBreakdown: [...byAgent.entries()].map(([agent, value]) => ({ agent, ...value })),
      planUsage
    }
  }
}

export function emptySnapshot(scanning = false): UsageSnapshot {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    messages: 0,
    sessions: 0,
    activeDays: 0,
    currentStreak: 0,
    longestStreak: 0,
    peakHour: null,
    favoriteModel: null,
    modelBreakdown: [],
    days: [],
    block: { tokens: 0, messages: 0, startedAt: null, resetsAt: null },
    filesTracked: 0,
    scannedAt: 0,
    scanning,
    agentBreakdown: [
      { agent: 'claude', totalTokens: 0, messages: 0, sessions: 0 },
      { agent: 'codex', totalTokens: 0, messages: 0, sessions: 0 }
    ],
    planUsage: []
  }
}
