import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type {
  HookEvent,
  InteractionResponse,
  PendingInteraction,
  PendingPermissionInteraction,
  PendingQuestionInteraction,
  StructuredQuestion
} from '@shared/types'

/**
 * Preferred port. It is written into the user's settings.json, so it has to be
 * stable across restarts; we only move off it if it is genuinely taken.
 */
export const DEFAULT_PORT = 47821
const PORT_ATTEMPTS = 12
const MAX_BODY_BYTES = 1_000_000
/**
 * Budget for a single question, re-armed each time the user answers one.
 *
 * An agent often asks several things at once, and the whole set arrives as one
 * held request. Spending one deadline across all of them punishes the user for
 * the agent's batching, so each question gets its own.
 */
export const QUESTION_TIMEOUT_MS = 120_000
/**
 * Hard ceiling on a single held request, whatever the per-question resets add
 * up to. It must stay under the `PreToolUse` hook timeout in HOOK_SPECS, or
 * Claude gives up first and our reply lands on a request that no longer exists.
 */
export const MAX_HOLD_MS = 570_000
export const PERMISSION_TIMEOUT_MS = 30_000

/** Query marker that identifies hook entries as ours, independent of port. */
export const HOOK_MARKER = 'app=windows-notch'
const [HOOK_MARKER_KEY, HOOK_MARKER_VALUE] = HOOK_MARKER.split('=')
/** The only path this listener answers on. */
export const HOOK_PATH = '/hook'
/** Query parameter carrying the shared secret. */
export const HOOK_TOKEN_KEY = 'token'
/**
 * Query parameter carrying how a hook entry should be read.
 *
 * Claude exposes a notification's type (`agent_completed`, `idle_prompt`, …)
 * only through the settings `matcher` — never in the request body. Installing
 * one entry per meaning and labelling its URL is what lets this one endpoint
 * tell "a human is blocking" apart from "that finished".
 */
export const HOOK_INTENT_KEY = 'intent'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** `blocking` turns the notch red; `info` is observability only. */
export type HookIntent = 'blocking' | 'info'

/**
 * Per-install secret embedded in the hook URL.
 *
 * Loopback binding alone is not a trust boundary: any local process, and any
 * web page able to make a simple cross-origin POST, can otherwise forge
 * permission cards and read back the answers the user types.
 */
export function generateHookToken(): string {
  return randomBytes(24).toString('base64url')
}

function tokenMatches(expected: string, received: string | null): boolean {
  if (!expected || !received) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(received, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Events that put a session into the red state. */
const BLOCKING_EVENTS = new Set(['PermissionRequest', 'Notification'])
/** Events that clear it. */
const CLEARING_EVENTS = new Set([
  'Stop',
  'SubagentStop',
  'SessionEnd',
  'PostToolUse',
  'UserPromptSubmit'
])

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Converts Claude's AskUserQuestion input to the transport-neutral UI shape. */
export function normalizeClaudeQuestions(input: Record<string, unknown>): StructuredQuestion[] {
  if (!Array.isArray(input.questions)) return []
  return input.questions.flatMap((raw, index) => {
    const question = object(raw)
    if (!question) return []
    const prompt = text(question.question).trim()
    if (!prompt) return []
    const options = Array.isArray(question.options)
      ? question.options.flatMap((rawOption) => {
          const option = object(rawOption)
          const label = option ? text(option.label).trim() : ''
          return label
            ? [{ label, description: text(option?.description).trim() || undefined }]
            : []
        })
      : []
    return [{
      id: text(question.id).trim() || `question-${index + 1}`,
      header: text(question.header).trim() || `Question ${index + 1}`,
      question: prompt,
      options,
      selectionMode: question.multiSelect === true ? 'multiple' : 'single',
      // Claude's native question UI always permits a typed alternative.
      allowOther: question.allowOther !== false,
      secret: question.secret === true || question.isSecret === true
    } satisfies StructuredQuestion]
  })
}

export function hookUrl(port: number, token: string, intent: HookIntent = 'blocking'): string {
  // The marker stays first so the installer's `isOurs` check and the port
  // regex keep matching regardless of what follows.
  const base = `http://127.0.0.1:${port}${HOOK_PATH}?${HOOK_MARKER}&${HOOK_TOKEN_KEY}=${encodeURIComponent(token)}`
  return intent === 'blocking' ? base : `${base}&${HOOK_INTENT_KEY}=${intent}`
}

/**
 * Localhost listener for Claude Code `type: "http"` hooks.
 *
 * Observability events are answered immediately. PermissionRequest and the
 * AskUserQuestion PreToolUse hook are held for an explicit UI response, with
 * internal fail-open deadlines shorter than Claude's configured timeouts.
 */
export class HookServer extends EventEmitter {
  private server: http.Server | null = null
  private boundPort: number | null = null
  private pending = new Map<
    string,
    {
      interaction: PendingInteraction
      originalInput: Record<string, unknown>
      /** False when the payload carried no `tool_input` to echo back. */
      capturedInput: boolean
      response: http.ServerResponse
      timer: NodeJS.Timeout
    }
  >()
  private questionTimeoutMs: number
  private permissionTimeoutMs: number
  private token: string

  constructor(
    options: {
      questionTimeoutMs?: number
      permissionTimeoutMs?: number
      token?: string
    } = {}
  ) {
    super()
    this.questionTimeoutMs = options.questionTimeoutMs ?? QUESTION_TIMEOUT_MS
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS
    this.token = options.token || generateHookToken()
  }

  get port(): number | null {
    return this.boundPort
  }

  /** The secret callers must present. Written into the installed hook URL. */
  get authToken(): string {
    return this.token
  }

  /** Adopts the token already installed in settings.json, if there is one. */
  async start(preferredPort = DEFAULT_PORT, token?: string): Promise<number> {
    if (token) this.token = token
    for (let i = 0; i < PORT_ATTEMPTS; i++) {
      const port = preferredPort + i
      try {
        this.boundPort = await this.listen(port)
        return this.boundPort
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err
      }
    }
    throw new Error(
      `No free port in ${preferredPort}-${preferredPort + PORT_ATTEMPTS - 1} for the hook listener`
    )
  }

  stop(): void {
    for (const id of [...this.pending.keys()]) this.finishInteraction(id, null)
    this.server?.close()
    this.server = null
    this.boundPort = null
  }

  getPendingInteractions(): PendingInteraction[] {
    return [...this.pending.values()]
      .map((entry) => entry.interaction)
      .sort(compareInteractions)
  }

  respond(id: string, response: InteractionResponse): boolean {
    return this.finishInteraction(id, response)
  }

  /**
   * Re-arms the deadline for the next question in a multi-question card.
   *
   * Returns false once the hard ceiling is reached, which leaves the existing
   * deadline running rather than extending past what Claude will wait for.
   */
  extendInteraction(id: string): boolean {
    const entry = this.pending.get(id)
    if (!entry || entry.interaction.kind !== 'questions') return false
    const now = Date.now()
    const ceiling = entry.interaction.receivedAt + MAX_HOLD_MS
    const next = Math.min(now + this.questionTimeoutMs, ceiling)
    if (next <= (entry.interaction.expiresAt ?? 0)) return false

    clearTimeout(entry.timer)
    const interaction = { ...entry.interaction, windowStartedAt: now, expiresAt: next }
    entry.interaction = interaction
    entry.timer = setTimeout(() => this.finishInteraction(id, null), next - now)
    this.pending.set(id, entry)
    this.emit('pending-change', this.getPendingInteractions())
    return true
  }

  private listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res))
      const onError = (err: Error): void => {
        server.removeListener('listening', onListening)
        server.close()
        reject(err)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        // Later runtime errors must not take the app down.
        server.on('error', (err) => this.emit('server-error', err))
        this.server = server
        resolve(port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      // Loopback only — nothing outside this machine can reach it.
      server.listen(port, '127.0.0.1')
    })
  }

  /**
   * Everything a caller must prove before its JSON is treated as a real hook.
   *
   * The token stops any local process that cannot read the user's settings.json
   * from forging prompts. The Origin and Host checks stop the browser-side
   * version of the same attack: Claude's Node hook client sends no Origin
   * header, every browser does, and a rebound DNS name never presents a
   * loopback Host.
   */
  private authorize(req: http.IncomingMessage): HookIntent | null {
    if (req.headers.origin) return null

    const host = req.headers.host ?? ''
    const hostname = host.replace(/:\d+$/, '')
    if (!LOOPBACK_HOSTS.has(hostname)) return null

    let url: URL
    try {
      url = new URL(req.url ?? '', 'http://127.0.0.1')
    } catch {
      return null
    }
    if (url.pathname !== HOOK_PATH) return null
    if (url.searchParams.get(HOOK_MARKER_KEY) !== HOOK_MARKER_VALUE) return null
    if (!tokenMatches(this.token, url.searchParams.get(HOOK_TOKEN_KEY))) return null
    // An unlabelled entry is blocking, which is what every pre-intent install
    // wrote and the safer reading of an unrecognised label.
    return url.searchParams.get(HOOK_INTENT_KEY) === 'info' ? 'info' : 'blocking'
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }

    const intent = this.authorize(req)
    if (!intent) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end('{}')
      req.resume()
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let aborted = false

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end('{}')
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('error', () => {
      aborted = true
    })

    req.on('end', () => {
      if (aborted) return
      let payload: Record<string, unknown> = {}
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        if (text.trim()) payload = JSON.parse(text) as Record<string, unknown>
      } catch {
        this.sendJson(res, {})
        return
      }
      const event = this.toEvent(payload)
      if (
        event.hook_event_name === 'PermissionRequest' ||
        (event.hook_event_name === 'PreToolUse' && event.tool_name === 'AskUserQuestion')
      ) {
        this.holdInteraction(event, res)
      } else {
        // Only permission prompts are held. Observability hooks answer first.
        this.sendJson(res, {})
        this.dispatch(event, intent)
      }
    })
  }

  private toEvent(payload: Record<string, unknown>): HookEvent {
    return {
      hook_event_name:
        typeof payload.hook_event_name === 'string' ? payload.hook_event_name : undefined,
      session_id: typeof payload.session_id === 'string' ? payload.session_id : undefined,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
      transcript_path:
        typeof payload.transcript_path === 'string' ? payload.transcript_path : undefined,
      permission_mode:
        typeof payload.permission_mode === 'string' ? payload.permission_mode : undefined,
      message: typeof payload.message === 'string' ? payload.message : undefined,
      tool_name: typeof payload.tool_name === 'string' ? payload.tool_name : undefined,
      tool_input:
        payload.tool_input &&
        typeof payload.tool_input === 'object' &&
        !Array.isArray(payload.tool_input)
          ? (payload.tool_input as Record<string, unknown>)
          : undefined,
      permission_suggestions: Array.isArray(payload.permission_suggestions)
        ? payload.permission_suggestions
        : undefined,
      receivedAt: Date.now()
    }
  }

  private dispatch(event: HookEvent, intent: HookIntent = 'blocking'): void {
    this.emit('hook', event)

    const name = event.hook_event_name ?? ''
    if (BLOCKING_EVENTS.has(name) && this.isBlocking(event, intent)) {
      this.emit('blocked', event)
    } else if (CLEARING_EVENTS.has(name)) {
      this.emit('unblocked', event)
    }
  }

  /**
   * A notification only demands a human when its installed entry says so and
   * the session is not merely planning.
   *
   * `agent_completed` and `auth_success` arrive on the `info` entry: those
   * report that something finished, not that anything is waiting. And in plan
   * mode Claude is still working — the real ask arrives later as the
   * ExitPlanMode `PermissionRequest`, which is a held interaction and is never
   * routed through here.
   */
  private isBlocking(event: HookEvent, intent: HookIntent): boolean {
    if (event.hook_event_name !== 'Notification') return true
    if (intent === 'info') return false
    return event.permission_mode !== 'plan'
  }

  private holdInteraction(event: HookEvent, response: http.ServerResponse): void {
    const receivedAt = Date.now()
    const common = {
      id: randomUUID(),
      agent: 'claude' as const,
      sessionId: event.session_id ?? '',
      cwd: event.cwd ?? '',
      transport: 'claude-hook' as const,
      answerable: true as const,
      receivedAt,
      windowStartedAt: receivedAt,
      expiresAt:
        receivedAt +
        (event.hook_event_name === 'PreToolUse'
          ? this.questionTimeoutMs
          : this.permissionTimeoutMs)
    }
    const originalInput = event.tool_input ?? {}
    const interaction: PendingInteraction =
      event.hook_event_name === 'PreToolUse'
        ? {
            ...common,
            kind: 'questions',
            questions: normalizeClaudeQuestions(originalInput)
          } satisfies PendingQuestionInteraction
        : {
            ...common,
            kind: 'permission',
            toolName: event.tool_name ?? 'Unknown tool',
            toolInput: originalInput
          } satisfies PendingPermissionInteraction
    if (interaction.kind === 'questions' && interaction.questions.length === 0) {
      this.sendJson(response, {})
      this.dispatch(event)
      return
    }
    const timer = setTimeout(
      () => this.finishInteraction(interaction.id, null),
      event.hook_event_name === 'PreToolUse'
        ? this.questionTimeoutMs
        : this.permissionTimeoutMs
    )
    this.pending.set(interaction.id, {
      interaction,
      originalInput,
      capturedInput: event.tool_input !== undefined,
      response,
      timer
    })
    response.on('close', () => {
      if (!response.writableEnded && this.pending.has(interaction.id)) {
        this.removeInteraction(interaction.id)
        this.emit('interaction-resolved', { interaction, result: 'disconnected' })
        this.emit('pending-change', this.getPendingInteractions())
      }
    })
    this.emit('hook', event)
    this.emit('blocked', event)
    this.emit('pending-change', this.getPendingInteractions())
  }

  private finishInteraction(id: string, answer: InteractionResponse | null): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    const { response, interaction, originalInput, capturedInput } = entry
    if (answer && answer.kind !== interaction.kind) return false
    if (
      interaction.kind === 'questions' &&
      answer?.kind === 'questions' &&
      interaction.questions.some((question) => {
        const selected = answer.answers[question.id]
        return !Array.isArray(selected) || selected.length === 0
      })
    ) {
      return false
    }
    this.removeInteraction(id)

    if (interaction.kind === 'permission' && answer?.kind === 'permission' && answer.decision === 'allow') {
      // `updatedInput` is optional in the published schema, but a bare allow is
      // dropped for tools that require user interaction — ExitPlanMode being the
      // one we care about. The result is the worst possible symptom: the notch
      // reports the answer sent while the terminal sits on its own prompt.
      // Echoing the input back unchanged means "approved, nothing modified" and
      // makes the allow stick. It is inert for tools that would have taken a
      // bare allow anyway, so it is not special cased on the tool name.
      //
      // `updatedInput` REPLACES the tool's arguments, so it is only safe to send
      // when the payload actually carried them. Without that guard a request
      // missing `tool_input` would be approved with its arguments wiped.
      this.sendJson(response, {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: capturedInput
            ? { behavior: 'allow', updatedInput: originalInput }
            : { behavior: 'allow' }
        }
      })
    } else if (interaction.kind === 'permission' && answer?.kind === 'permission' && answer.decision === 'deny') {
      // Claude reads this string. Denying an ExitPlanMode request means "keep
      // planning", not "this plan is wrong" — saying the latter would send it
      // off rewriting a plan the user never objected to.
      const message =
        interaction.toolName === 'ExitPlanMode'
          ? 'Not yet — keep planning. Continue refining the plan in plan mode.'
          : 'Denied in Windows Notch'
      this.sendJson(response, {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'deny',
            message,
            interrupt: false
          }
        }
      })
    } else if (interaction.kind === 'questions' && answer?.kind === 'questions') {
      const answers: Record<string, string> = {}
      for (const question of interaction.questions) {
        const selected = answer.answers[question.id]!
        answers[question.question] = selected.join(', ')
      }
      this.sendJson(response, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: {
            ...originalInput,
            questions: originalInput.questions,
            answers
          }
        }
      })
    } else {
      // No decision: Claude falls back to its normal terminal permission UI.
      this.sendJson(response, {})
    }

    this.emit('interaction-resolved', {
      interaction,
      result: answer ?? 'timeout'
    })
    this.emit('pending-change', this.getPendingInteractions())
    return true
  }

  private removeInteraction(id: string): void {
    const entry = this.pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(id)
  }

  private sendJson(response: http.ServerResponse, body: unknown): void {
    if (response.writableEnded || response.destroyed) return
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }
}

export interface HookSpec {
  event: string
  /** Claude's settings-level filter. For Notification it selects the type. */
  matcher?: string
  intent: HookIntent
  /** Seconds Claude waits for our reply before giving up on the hook. */
  timeout: number
}

/**
 * Exactly what we write into settings.json.
 *
 * Two things this encodes that a flat name list could not:
 *
 * 1. `Notification` is installed twice. Its type is only reachable through the
 *    matcher, so each half gets its own URL and the endpoint reads the meaning
 *    back off `?intent=`. Without the split, "that finished" turns the notch
 *    red exactly like "I need you".
 * 2. `UserPromptSubmit` must be present, or a red state has nothing to clear it
 *    until Stop, SessionEnd, or the ten-minute sweep.
 */
export const HOOK_SPECS: readonly HookSpec[] = [
  { event: 'PermissionRequest', intent: 'blocking', timeout: 45 },
  // Long enough for the per-question budget below; the documented http default.
  { event: 'PreToolUse', matcher: 'AskUserQuestion', intent: 'blocking', timeout: 600 },
  {
    event: 'Notification',
    matcher: 'permission_prompt|idle_prompt|agent_needs_input',
    intent: 'blocking',
    timeout: 5
  },
  {
    event: 'Notification',
    matcher: 'agent_completed|auth_success|elicitation_complete|elicitation_response',
    intent: 'info',
    timeout: 5
  },
  { event: 'UserPromptSubmit', intent: 'blocking', timeout: 5 },
  { event: 'Stop', intent: 'blocking', timeout: 5 },
  { event: 'SessionEnd', intent: 'blocking', timeout: 5 }
] as const

/** Distinct event names we install, for status display and staleness checks. */
export const HOOK_EVENTS: readonly string[] = [
  ...new Set(HOOK_SPECS.map((spec) => spec.event))
]

export function compareInteractions(a: PendingInteraction, b: PendingInteraction): number {
  const aExpiry = a.expiresAt ?? Number.POSITIVE_INFINITY
  const bExpiry = b.expiresAt ?? Number.POSITIVE_INFINITY
  return aExpiry - bExpiry || a.receivedAt - b.receivedAt
}
