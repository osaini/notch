import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import fsp from 'node:fs/promises'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type {
  DispatchRequest,
  DispatchResult,
  InteractionResponse,
  ManagedCodexState,
  PendingInteraction,
  StructuredQuestion
} from '@shared/types'
import { platform } from './platform'
import { runFirstWorkingPlan, spawnDetached } from './platform/launch'
import type { TerminalIntegration } from './platform/types'

interface RpcMessage {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface ManagedRequest {
  requestId: number | string
  interaction: PendingInteraction
}

interface CodexModel {
  id: string
  isDefault: boolean
}

interface ManagedCodexOptions {
  endpoint?: string
  launchDetached?: (exe: string, args: string[]) => Promise<void>
  /**
   * Injectable so a test can pin one platform's argv while running on another.
   * `agentPlans` is pure, so `testInteractions.ts` passes `win32Platform.terminal`
   * and keeps asserting the exact `wt.exe` command line on a macOS runner.
   */
  terminal?: TerminalIntegration
  rolloutTimeoutMs?: number
  rolloutPollMs?: number
}

const START_TIMEOUT_MS = 10_000
const RPC_TIMEOUT_MS = 20_000
const ROLLOUT_POLL_MS = 50

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function string(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function normalizeQuestions(value: unknown): StructuredQuestion[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw, index) => {
    const question = object(raw)
    if (!question) return []
    const prompt = string(question.question).trim()
    if (!prompt) return []
    const options = Array.isArray(question.options)
      ? question.options.flatMap((candidate) => {
          const option = object(candidate)
          const label = option ? string(option.label).trim() : ''
          return label
            ? [{ label, description: string(option?.description).trim() || undefined }]
            : []
        })
      : []
    return [{
      id: string(question.id).trim() || `question-${index + 1}`,
      header: string(question.header).trim() || `Question ${index + 1}`,
      question: prompt,
      options,
      // The current app-server schema represents single-select questions.
      // Accept a future multi-select marker without requiring an app release.
      selectionMode:
        question.multiSelect === true || question.selectionMode === 'multiple'
          ? 'multiple'
          : 'single',
      allowOther: question.isOther === true || question.allowOther === true,
      secret: question.isSecret === true || question.secret === true
    } satisfies StructuredQuestion]
  })
}

function approvalPolicy(request: DispatchRequest): 'untrusted' | 'on-request' | 'never' {
  if (request.permissionMode === 'codex-untrusted') return 'untrusted'
  if (request.permissionMode === 'codex-never' || request.permissionMode === 'codex-bypass') {
    return 'never'
  }
  return 'on-request'
}

export function compatibleModelOverride(
  configuredModel: string,
  models: CodexModel[]
): string | undefined {
  if (!configuredModel || models.some((model) => model.id === configuredModel)) {
    return undefined
  }
  return models.find((model) => model.isDefault)?.id ?? models[0]?.id
}

export function managedCodexResumeArgs(
  endpoint: string,
  threadId: string
): string[] {
  return ['--remote', endpoint, 'resume', threadId]
}

export async function waitForRolloutReady(
  rolloutPath: string,
  threadId: string,
  timeoutMs = START_TIMEOUT_MS,
  pollMs = ROLLOUT_POLL_MS
): Promise<void> {
  const startedAt = Date.now()
  let lastError = 'the rollout file has not been written yet'
  let stableLength = -1

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const text = await fsp.readFile(rolloutPath, 'utf8')
      if (!text.endsWith('\n')) {
        lastError = 'the rollout file is still being written'
        stableLength = -1
      } else {
        const records = text.split(/\r?\n/).filter(Boolean)
        const first = records[0] ? object(JSON.parse(records[0])) : null
        const payload = object(first?.payload)
        if (
          first?.type === 'session_meta' &&
          string(payload?.id) === threadId &&
          records.every((line) => {
            JSON.parse(line)
            return true
          })
        ) {
          if (stableLength === text.length) return
          stableLength = text.length
          lastError = 'the rollout file has not reached a stable snapshot yet'
        } else {
          stableLength = -1
          lastError = 'the rollout metadata does not match the new Codex thread'
        }
      }
    } catch (error) {
      stableLength = -1
      lastError =
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'the rollout file has not been written yet'
          : (error as Error).message
    }

    const remaining = timeoutMs - (Date.now() - startedAt)
    if (remaining > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)))
    }
  }

  throw new Error(`Codex session was not ready to resume: ${lastError}`)
}

async function unusedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

export class ManagedCodexService extends EventEmitter {
  private child: ChildProcess | null = null
  private socket: WebSocket | null = null
  private nextId = 1
  private rpc = new Map<number | string, PendingRpc>()
  private requests = new Map<string, ManagedRequest>()
  private interactionByRequestId = new Map<string, string>()
  private threads = new Map<string, { cwd: string; sessionId: string }>()
  private models: CodexModel[] | null = null
  private starting: Promise<void> | null = null
  private configuredEndpoint?: string
  private launchDetached: (exe: string, args: string[]) => Promise<void>
  private terminal: TerminalIntegration
  private rolloutTimeoutMs: number
  private rolloutPollMs: number
  private stopping = false
  private state: ManagedCodexState = {
    status: 'idle',
    available: false,
    experimentalApi: false,
    requestUserInput: false
  }

  constructor(options: ManagedCodexOptions = {}) {
    super()
    this.configuredEndpoint = options.endpoint
    this.launchDetached = options.launchDetached ?? spawnDetached
    this.terminal = options.terminal ?? platform.terminal
    this.rolloutTimeoutMs = options.rolloutTimeoutMs ?? START_TIMEOUT_MS
    this.rolloutPollMs = options.rolloutPollMs ?? ROLLOUT_POLL_MS
  }

  getState(): ManagedCodexState {
    return { ...this.state }
  }

  getPendingInteractions(): PendingInteraction[] {
    return [...this.requests.values()].map((entry) => entry.interaction)
  }

  advanceInteraction(id: string): boolean {
    // The app-server owns auto-resolution deadlines and exposes no extension
    // RPC. Advancing is still valid while the request itself remains pending.
    return this.requests.has(id)
  }

  ownsSession(sessionId: string): boolean {
    return this.threads.has(sessionId)
  }

  async start(): Promise<void> {
    this.stopping = false
    if (this.state.status === 'ready' && this.socket?.readyState === WebSocket.OPEN) return
    if (this.starting) return this.starting
    this.starting = this.startInternal().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  stop(): void {
    this.stopping = true
    this.rejectRpc(new Error('Managed Codex stopped'))
    this.models = null
    this.requests.clear()
    this.interactionByRequestId.clear()
    // Ownership is what suppresses the rollout fallback prompt. Once we can no
    // longer answer for these threads we must stop claiming them.
    this.threads.clear()
    this.socket?.close()
    this.socket = null
    this.child?.kill()
    this.child = null
    this.updateState({
      status: 'idle',
      available: false,
      experimentalApi: false,
      requestUserInput: false
    })
    this.emit('pending-change', [])
  }

  async dispatch(request: DispatchRequest, prompt: string): Promise<DispatchResult> {
    await this.start()
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(this.state.error || 'Managed Codex is unavailable')
    }

    const [models, startedValue] = await Promise.all([
      this.listModels(),
      this.request('thread/start', {
        cwd: request.cwd,
        approvalPolicy: approvalPolicy(request),
        ...(request.permissionMode === 'codex-bypass' ? { sandbox: 'danger-full-access' } : {})
      })
    ])
    const started = object(startedValue)
    const thread = object(started?.thread)
    const threadId = string(thread?.id)
    if (!threadId) throw new Error('Codex did not return a thread ID')
    this.threads.set(threadId, { cwd: request.cwd, sessionId: threadId })

    // An explicit pick wins outright. The compatibility override only exists to
    // rescue a thread that started on a model this server does not offer, which
    // is not a question worth asking when the user named one.
    const model =
      request.codex?.model || compatibleModelOverride(string(started?.model), models)
    const codexArgs = managedCodexResumeArgs(this.state.endpoint!, threadId)
    // The plans are built up front because the error paths below report the
    // command that *would* have run, before any launch is attempted.
    const plans = this.terminal.agentPlans({
      cwd: request.cwd,
      exe: 'codex',
      args: codexArgs
    })
    const primary = plans[0]
    const command = primary?.display ?? ''
    const launcher = primary?.launcher ?? this.terminal.primaryLauncher
    // No plans means this platform has no terminal integration yet. Bail before
    // starting a turn, so we never leave one running headlessly with nothing to
    // show the user — the same guarantee the rollout-failure path gives.
    if (plans.length === 0) {
      this.threads.delete(threadId)
      return {
        ok: false,
        command,
        launcher,
        transport: 'managed-codex',
        sessionId: threadId,
        threadId,
        error: `Launching a terminal is not available on ${platform.os} yet.`
      }
    }
    const rolloutPath = string(thread?.path)
    if (!rolloutPath) {
      this.threads.delete(threadId)
      return {
        ok: false,
        command,
        launcher,
        transport: 'managed-codex',
        sessionId: threadId,
        threadId,
        error: 'Codex did not provide a persisted session path, so the terminal was not opened.'
      }
    }
    let turnId = ''
    try {
      const startedTurn = object(
        await this.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: prompt }],
          ...(model ? { model } : {}),
          // `effort`, per `codex app-server generate-json-schema`
          // (TurnStartParams). Not `reasoningEffort`, which is this value's
          // name elsewhere in the protocol: the app server ignores unknown
          // fields rather than rejecting them, so getting this wrong silently
          // runs the turn at whatever config.toml says.
          ...(request.codex?.effort ? { effort: request.codex.effort } : {})
        })
      )
      turnId = string(object(startedTurn?.turn)?.id)
      await waitForRolloutReady(
        rolloutPath,
        threadId,
        this.rolloutTimeoutMs,
        this.rolloutPollMs
      )
    } catch (error) {
      // The turn may already be running headlessly. We are about to tell the
      // user nothing happened, so make that true before returning.
      await this.abandonTurn(threadId, turnId)
      this.threads.delete(threadId)
      return {
        ok: false,
        command,
        launcher,
        transport: 'managed-codex',
        sessionId: threadId,
        threadId,
        error: `${(error as Error).message}. The terminal was not opened.`
      }
    }

    const outcome = await runFirstWorkingPlan(plans, this.launchDetached)
    if (!outcome.ok) {
      // Every launcher failed. Throwing here would let the caller fall back to a
      // fresh CLI session while this turn keeps running — the same duplicated
      // work the rollout-failure path guards against.
      await this.abandonTurn(threadId, turnId)
      this.threads.delete(threadId)
      return {
        ok: false,
        command: outcome.plan.display,
        launcher: outcome.plan.launcher,
        transport: 'managed-codex',
        sessionId: threadId,
        threadId,
        error: `${outcome.error ?? 'No terminal could be launched'}. The terminal was not opened.`
      }
    }
    return {
      ok: true,
      command: outcome.plan.display,
      launcher: outcome.plan.launcher,
      transport: 'managed-codex',
      sessionId: threadId,
      threadId
    }
  }

  /**
   * Best-effort cancellation of a turn the app-server already accepted.
   *
   * `turn/interrupt` requires both ids, so a turn whose id we never saw cannot
   * be cancelled. A failure here must never mask the error that got us here.
   */
  private async abandonTurn(threadId: string, turnId: string): Promise<void> {
    if (!threadId || !turnId) return
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    try {
      await this.request('turn/interrupt', { threadId, turnId })
    } catch (error) {
      this.emit('server-error', error)
    }
  }

  respond(id: string, response: InteractionResponse): boolean {
    const entry = this.requests.get(id)
    if (!entry || response.kind !== 'questions') return false
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    const answers: Record<string, { answers: string[] }> = {}
    for (const question of entry.interaction.kind === 'questions'
      ? entry.interaction.questions
      : []) {
      const selected = response.answers[question.id]
      if (!Array.isArray(selected) || selected.length === 0) return false
      answers[question.id] = { answers: selected }
    }
    // Do not clear here. The app server broadcasts serverRequest/resolved
    // after the first subscriber response wins; that event is authoritative.
    this.send({ id: entry.requestId, result: { answers } })
    return true
  }

  threadForInteraction(id: string): { cwd: string; sessionId: string } | null {
    const entry = this.requests.get(id)
    if (!entry) return null
    return this.threads.get(entry.interaction.sessionId) ?? {
      cwd: entry.interaction.cwd,
      sessionId: entry.interaction.sessionId
    }
  }

  private async startInternal(): Promise<void> {
    this.updateState({
      status: 'starting',
      available: false,
      experimentalApi: false,
      requestUserInput: false,
      error: undefined
    })
    const endpoint =
      this.configuredEndpoint ?? `ws://127.0.0.1:${await unusedLoopbackPort()}`
    if (!this.configuredEndpoint) {
      const child = spawn('codex', ['app-server', '--listen', endpoint], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      })
      this.child = child
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000)
      })
      child.once('exit', (code) => {
        if (this.child !== child) return
        this.child = null
        this.disconnect(`codex app-server exited${code === null ? '' : ` (${code})`}${stderr ? `: ${stderr.trim()}` : ''}`)
      })
      child.once('error', (error) => this.disconnect(error.message))
    }

    try {
      const socket = await this.connect(endpoint)
      // Model availability belongs to one app-server connection. A restarted
      // server can expose a different account or model catalog.
      this.models = null
      this.socket = socket
      socket.on('message', (data) => this.onMessage(data.toString()))
      socket.on('close', () => {
        // close() is asynchronous. If stop() followed immediately by start(),
        // the old socket can close after the new one is already live; that
        // stale callback must not tear down the replacement connection.
        if (this.socket === socket) this.disconnect('Managed Codex connection closed')
      })
      socket.on('error', (error) => this.emit('server-error', error))
      await this.request('initialize', {
        clientInfo: {
          name: 'notch',
          title: 'Notch',
          version: '0.2.0'
        },
        capabilities: { experimentalApi: true }
      })
      this.send({ method: 'initialized', params: {} })
      this.updateState({
        status: 'ready',
        available: true,
        endpoint,
        experimentalApi: true,
        requestUserInput: true,
        error: undefined
      })
    } catch (error) {
      this.child?.kill()
      this.child = null
      this.socket?.close()
      this.socket = null
      this.updateState({
        status: 'unavailable',
        available: false,
        endpoint,
        experimentalApi: false,
        requestUserInput: false,
        error: (error as Error).message
      })
      throw error
    }
  }

  private connect(endpoint: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const attempt = (): void => {
        const socket = new WebSocket(endpoint)
        let settled = false
        socket.once('open', () => {
          settled = true
          resolve(socket)
        })
        socket.once('error', (error) => {
          if (settled) return
          socket.terminate()
          if (Date.now() - startedAt >= START_TIMEOUT_MS) reject(error)
          else setTimeout(attempt, 150)
        })
      }
      attempt()
    })
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rpc.delete(id)
        reject(new Error(`${method} timed out`))
      }, RPC_TIMEOUT_MS)
      this.rpc.set(id, { resolve, reject, timer })
      try {
        this.send({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.rpc.delete(id)
        reject(error)
      }
    })
  }

  /**
   * Model ids this server offers, cached for the connection's lifetime.
   *
   * Public because the Dispatch picker asks for it directly. It never starts
   * the server: an unopened socket returns an uncached empty list and lets the
   * renderer fall back to its static ids.
   */
  async listModels(): Promise<CodexModel[]> {
    if (this.models) return this.models
    // The Dispatch tab asks before the service normally starts. Returning the
    // static-fallback signal must not cache it: dispatch() starts the server
    // later and needs a real model/list request at that point.
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return []
    try {
      const response = object(await this.request('model/list', {}))
      this.models = Array.isArray(response?.data)
        ? response.data.flatMap((value) => {
            const model = object(value)
            const id = model ? string(model.id, string(model.model)) : ''
            return id ? [{ id, isDefault: model?.isDefault === true }] : []
          })
        : []
      return this.models
    } catch {
      // A transient RPC failure is not a model catalog. Leave the cache empty
      // so a later request on this connection can recover.
      return []
    }
  }

  private send(message: RpcMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Managed Codex socket is not open')
    }
    this.socket.send(JSON.stringify(message))
  }

  private onMessage(raw: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(raw) as RpcMessage
    } catch {
      return
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.rpc.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.rpc.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message || 'Codex request failed'))
      else pending.resolve(message.result)
      return
    }
    if (message.method === 'item/tool/requestUserInput' && message.id !== undefined) {
      this.handleUserInputRequest(message.id, message.params ?? {})
      return
    }
    if (message.method === 'serverRequest/resolved') {
      const requestId = message.params?.requestId
      const interactionId = this.interactionByRequestId.get(String(requestId))
      if (interactionId) this.removeInteraction(interactionId, 'resolved')
    }
  }

  private handleUserInputRequest(
    requestId: number | string,
    params: Record<string, unknown>
  ): void {
    const questions = normalizeQuestions(params.questions)
    const threadId = string(params.threadId)
    if (!threadId || questions.length === 0) return
    const existing = this.interactionByRequestId.get(String(requestId))
    if (existing) return
    const thread = this.threads.get(threadId)
    const receivedAt = Date.now()
    const autoResolutionMs =
      typeof params.autoResolutionMs === 'number' && params.autoResolutionMs > 0
        ? params.autoResolutionMs
        : undefined
    const interaction: PendingInteraction = {
      id: randomUUID(),
      kind: 'questions',
      agent: 'codex',
      sessionId: threadId,
      cwd: thread?.cwd ?? '',
      transport: 'codex-app-server',
      answerable: true,
      receivedAt,
      expiresAt: autoResolutionMs ? receivedAt + autoResolutionMs : undefined,
      questions
    }
    this.requests.set(interaction.id, { requestId, interaction })
    this.interactionByRequestId.set(String(requestId), interaction.id)
    this.emit('pending-change', this.getPendingInteractions())
  }

  private removeInteraction(id: string, result: string): void {
    const entry = this.requests.get(id)
    if (!entry) return
    this.requests.delete(id)
    this.interactionByRequestId.delete(String(entry.requestId))
    this.emit('interaction-resolved', { interaction: entry.interaction, result })
    this.emit('pending-change', this.getPendingInteractions())
  }

  private disconnect(reason: string): void {
    if (this.stopping) return
    this.rejectRpc(new Error(reason))
    this.models = null
    this.socket = null
    const child = this.child
    this.child = null
    child?.kill()
    for (const id of [...this.requests.keys()]) this.removeInteraction(id, 'disconnected')
    // Same reason as in stop(): a disconnected service holds no answerable copy
    // of these threads' prompts, so the rollout fallback must become visible.
    this.threads.clear()
    this.updateState({
      status: 'disconnected',
      available: false,
      experimentalApi: false,
      requestUserInput: false,
      error: reason
    })
  }

  private rejectRpc(error: Error): void {
    for (const pending of this.rpc.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.rpc.clear()
  }

  private updateState(state: ManagedCodexState): void {
    this.state = state
    this.emit('state', this.getState())
  }
}
