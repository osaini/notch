import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import http from 'node:http'
import { networkInterfaces, hostname } from 'node:os'
import path from 'node:path'
import type {
  AgentKind,
  DispatchRequest,
  DispatchResult,
  MobileBridgeStatus,
  MobileEndpoint,
  MobileEndpointKind,
  SessionState
} from '@shared/types'
import { findTranscriptInRoots } from './claudeTranscript'
import { platform } from './platform'
import type { SessionWatcher } from './sessionWatcher'

const DEFAULT_MOBILE_PORT = 47822
const PORT_ATTEMPTS = 12
const MAX_BODY_BYTES = 64 * 1024
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024
const MAX_MESSAGES = 120
const PAIRING_TTL_MS = 10 * 60 * 1000
// The cookie carrying this token crosses the LAN over plain HTTP on every
// request, so it is a short-lived credential by design. Re-pairing is cheap.
const DEVICE_TTL_SECONDS = 30 * 24 * 60 * 60
const DEVICE_TTL_MS = DEVICE_TTL_SECONDS * 1000
const HEARTBEAT_MS = 20_000
const PAIRING_ATTEMPT_WINDOW_MS = 5 * 60 * 1000
const PAIRING_ATTEMPT_LIMIT = 8
/**
 * A per-IP limit alone is defeated by rotating the source address, and the
 * code is only six digits. This caps guesses across all callers, so the search
 * space stays out of reach for the lifetime of any one code.
 */
const PAIRING_GLOBAL_ATTEMPT_LIMIT = 24

/**
 * What Windows assigns to an adapter whose DHCP failed — a Bluetooth PAN, an
 * unplugged dock, a disabled virtual switch. A machine collects several, none
 * of them route anywhere, and listing them buries the one address that works.
 */
function isLinkLocal(address: string): boolean {
  return address.startsWith('169.254.')
}

/** RFC1918 — the ranges a home or office LAN actually hands out. */
function isPrivateLan(address: string): boolean {
  if (address.startsWith('192.168.') || address.startsWith('10.')) return true
  const match = /^172\.(\d+)\./.exec(address)
  return match ? Number(match[1]) >= 16 && Number(match[1]) <= 31 : false
}

/**
 * RFC6598 carrier-grade NAT, which Tailscale and similar overlays allocate
 * from. A phone can reach these, but only once it has joined the same overlay,
 * so they rank below a plain LAN address instead of being hidden.
 */
function isCarrierGradeNat(address: string): boolean {
  const match = /^100\.(\d+)\./.exec(address)
  return match ? Number(match[1]) >= 64 && Number(match[1]) <= 127 : false
}

function endpointKind(address: string): MobileEndpointKind {
  if (isPrivateLan(address)) return 'lan'
  if (isCarrierGradeNat(address)) return 'vpn'
  return 'other'
}

const KIND_RANK: Record<MobileEndpointKind, number> = {
  lan: 0,
  vpn: 1,
  other: 2,
  loopback: 3
}

/**
 * The source address the routing table would use to leave this machine.
 *
 * `networkInterfaces()` cannot distinguish a live Wi-Fi adapter from an
 * Ethernet port that still holds a stale lease — both report a perfectly
 * ordinary private address — so the only way to know which one traffic
 * actually takes is to ask the kernel. Connecting a UDP socket transmits
 * nothing; it resolves the route and binds a source address, which is why this
 * needs no reachable peer and produces no network traffic.
 */
function probePreferredAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    let socket: ReturnType<typeof createSocket> | null = null
    const finish = (address: string | null): void => {
      try {
        socket?.close()
      } catch {
        // Already closing, or never opened.
      }
      socket = null
      resolve(address)
    }
    try {
      socket = createSocket('udp4')
      socket.once('error', () => finish(null))
      // TEST-NET-1: permanently unassigned and unroutable, so the lookup falls
      // to the default route without implying this machine talks to anyone.
      socket.connect(9, '192.0.2.1', () => {
        let address: string | null = null
        try {
          address = socket?.address().address ?? null
        } catch {
          address = null
        }
        finish(address)
      })
    } catch {
      finish(null)
    }
  })
}

type MobileStatus = 'working' | 'idle' | 'needs-input' | 'reviewing' | 'unknown'

interface MobileSessionSummary {
  key: string
  agent: AgentKind
  name: string
  project: string
  path: string
  status: MobileStatus
  detail: string
  updatedAt: number
  canMessage: boolean
  expectedKey?: string
  excludedKeys?: string[]
}

interface MobileMessage {
  id: string
  role: 'user' | 'agent' | 'system'
  text: string
  createdAt: number
}

interface ProjectOption {
  name: string
  path: string
}

interface MobileSnapshot {
  computerName: string
  connected: true
  sessions: MobileSessionSummary[]
  projects: ProjectOption[]
}

interface StoredDevice {
  id: string
  name: string
  tokenHash: string
  pairedAt: number
  lastSeenAt: number
}

interface StoredDevices {
  devices: StoredDevice[]
}

interface PairAttempt {
  count: number
  startedAt: number
}

interface MobileBridgeOptions {
  userDataDir: string
  assetsDir: string
  watcher: SessionWatcher
  getProjects: () => Promise<string[]>
  dispatch: (request: DispatchRequest) => Promise<DispatchResult>
  /** Injectable so credential-expiry behavior can be tested without waiting. */
  now?: () => number
  /** Injectable so follow-up launch races can be covered without starting an agent. */
  spawnProcess?: typeof spawn
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
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

function projectName(cwd: string): string {
  return path.basename(cwd.replace(/[\\/]+$/, '')) || cwd
}

const AGENT_NAMES: Record<AgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  'claude-design': 'Claude Design'
}

function mobileStatus(session: SessionState, running: boolean): MobileStatus {
  if (running) return 'working'
  if (session.needsInput || session.status === 'needs-input') return 'needs-input'
  if (session.status === 'reviewing') return 'reviewing'
  if (session.status === 'busy') return 'working'
  if (session.status === 'idle') return 'idle'
  return 'unknown'
}

function statusDetail(session: SessionState, status: MobileStatus): string {
  if (session.needsInputReason) return session.needsInputReason
  // Design has no transcript to resume, so it never offers a follow-up.
  if (session.agent === 'claude-design') return 'Open on this computer'
  if (status === 'working') return `${AGENT_NAMES[session.agent]} is working`
  if (status === 'reviewing') return 'Review gate in progress'
  if (status === 'idle') return 'Ready for a follow-up'
  if (status === 'unknown') return 'Agent status is temporarily unavailable'
  return 'Waiting for you'
}

function canResume(session: SessionState): boolean {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(session.sessionId)
}

/** CLI argv for a phone-sent follow-up, with prompt text kept positional. */
export function buildMobileFollowupArgs(
  agent: 'claude' | 'codex',
  sessionId: string,
  text: string
): string[] {
  return agent === 'claude'
    ? [
        '-p',
        '--resume',
        sessionId,
        '--permission-mode',
        'dontAsk',
        '--output-format',
        'json',
        '--',
        text
      ]
    : [
        'exec',
        '--sandbox',
        'workspace-write',
        '-c',
        'approval_policy="never"',
        '--json',
        'resume',
        sessionId,
        '--',
        text
      ]
}

function mimeType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
    case '.webmanifest':
      return 'application/manifest+json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    default:
      return 'application/octet-stream'
  }
}

function cookieValue(req: http.IncomingMessage, name: string): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='))
      } catch {
        // A malformed cookie is simply not a credential. Treating it as a 500
        // lets any LAN caller manufacture noisy server failures at will.
        return ''
      }
    }
  }
  return ''
}

/** True only for plain-HTTP address ranges this bridge is safe to advertise. */
export function isSafeMobileEndpointAddress(address: string): boolean {
  const kind = endpointKind(address)
  return !isLinkLocal(address) && (kind === 'lan' || kind === 'vpn')
}

function responseItemText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (!isRecord(item)) continue
    const type = stringValue(item.type)
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      const text = stringValue(item.text)
      if (text) parts.push(text)
    }
  }
  return parts.join('\n').trim()
}

function parseClaudeMessages(text: string): MobileMessage[] {
  const output: MobileMessage[] = []
  let index = 0
  for (const line of text.split('\n')) {
    index++
    if (!line.startsWith('{')) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (record.isMeta === true || (record.type !== 'user' && record.type !== 'assistant')) continue
    const message = isRecord(record.message) ? record.message : {}
    const role = record.type === 'user' ? 'user' : 'agent'
    const content = responseItemText(message.content)
    if (!content || content.startsWith('<local-command-')) continue
    output.push({
      id: stringValue(record.uuid) || stringValue(message.id) || `claude-${index}`,
      role,
      text: content,
      createdAt: timestamp(record.timestamp, index)
    })
  }
  return output.slice(-MAX_MESSAGES)
}

function parseCodexMessages(text: string): MobileMessage[] {
  const output: MobileMessage[] = []
  let index = 0
  for (const line of text.split('\n')) {
    index++
    if (!line.startsWith('{')) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (record.type !== 'event_msg' || !isRecord(record.payload)) continue
    const payload = record.payload
    const type = stringValue(payload.type)
    if (type !== 'user_message' && type !== 'agent_message') continue
    const content = stringValue(payload.message)
    if (!content) continue
    output.push({
      id: stringValue(payload.id) || `${type}-${index}`,
      role: type === 'user_message' ? 'user' : 'agent',
      text: content,
      createdAt: timestamp(record.timestamp, index)
    })
  }
  return output.slice(-MAX_MESSAGES)
}

async function readTranscriptTail(file: string): Promise<string> {
  const handle = await fsp.open(file, 'r')
  try {
    const stat = await handle.stat()
    const length = Math.min(stat.size, MAX_TRANSCRIPT_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, stat.size - length)
    let text = buffer.toString('utf8')
    if (stat.size > length) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
    }
    return text
  } finally {
    await handle.close()
  }
}

export class MobileBridge extends EventEmitter {
  private server: http.Server | null = null
  private boundPort: number | null = null
  private pairingCode = ''
  private pairingExpiresAt = 0
  private devices: StoredDevice[] = []
  private readonly devicesPath: string
  private readonly clients = new Map<http.ServerResponse, { deviceId: string; pairedAt: number }>()
  private readonly runningSessions = new Set<string>()
  private readonly pairAttempts = new Map<string, PairAttempt>()
  private pairAttemptsForCode = 0
  private readonly transcriptCache = new Map<string, string>()
  private heartbeat: NodeJS.Timeout | null = null
  private pairingTimer: NodeJS.Timeout | null = null
  private readonly dispatchWork = new Map<string, Promise<void>>()
  private lastError: string | undefined
  private broadcastQueued = false
  /** Serializes snapshot generation and writes so an older async snapshot cannot overtake a newer one. */
  private broadcastWork: Promise<void> = Promise.resolve()
  private deviceSaveWork: Promise<void> = Promise.resolve()
  private watcherListener: (() => void) | null = null
  /** Cached result of the last routing probe. See probePreferredAddress(). */
  private preferredAddress: string | null = null

  constructor(private readonly options: MobileBridgeOptions) {
    super()
    this.devicesPath = path.join(options.userDataDir, 'mobile-devices.json')
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  async start(preferredPort = DEFAULT_MOBILE_PORT): Promise<number> {
    await this.loadDevices()
    this.regeneratePairing()

    for (let offset = 0; offset < PORT_ATTEMPTS; offset++) {
      const port = preferredPort + offset
      try {
        await this.listen(port)
        this.boundPort = port
        this.lastError = undefined
        // Register only after the listener is live. A failed start must leave
        // no callback behind, especially because a later attempt replaces the
        // single reference that stop() knows how to remove.
        this.watcherListener = () => this.queueBroadcast()
        this.options.watcher.on('update', this.watcherListener)
        this.heartbeat = setInterval(() => {
          this.pruneUnauthorizedClients()
          this.writeToClients(': heartbeat\n\n')
        }, HEARTBEAT_MS)
        // Before the first status goes out, so the Settings tab never shows an
        // unranked list on the one render the user is most likely to act on.
        this.preferredAddress = await probePreferredAddress()
        this.emit('status', this.getStatus())
        return port
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error
      }
    }
    this.lastError = `No free port in ${preferredPort}-${preferredPort + PORT_ATTEMPTS - 1}`
    this.emit('status', this.getStatus())
    throw new Error(this.lastError)
  }

  stop(): void {
    if (this.watcherListener) this.options.watcher.off('update', this.watcherListener)
    this.watcherListener = null
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.pairingTimer) clearTimeout(this.pairingTimer)
    this.pairingTimer = null
    for (const client of this.clients.keys()) client.end()
    this.clients.clear()
    this.server?.close()
    this.server = null
    this.boundPort = null
  }

  /**
   * Re-probes the routing table before reporting. The Settings tab uses this,
   * because the right address changes the moment the user joins a different
   * network; the push path stays on the cached value so a status broadcast
   * never waits on a socket.
   */
  async refreshStatus(): Promise<MobileBridgeStatus> {
    this.preferredAddress = await probePreferredAddress()
    return this.getStatus()
  }

  /**
   * Every address a phone could reach, best first, with loopback last and
   * labelled. The failure this ordering exists to prevent is a user copying
   * `http://localhost` — or a Bluetooth adapter's link-local address — onto a
   * phone, getting nothing, and concluding the companion is broken.
   */
  private endpoints(): MobileEndpoint[] {
    const port = this.boundPort
    if (!port) return []
    const byUrl = new Map<string, MobileEndpoint>()
    for (const [label, entries] of Object.entries(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family !== 'IPv4' || entry.internal) continue
        if (!isSafeMobileEndpointAddress(entry.address)) continue
        const kind = endpointKind(entry.address)
        // This service is intentionally plain HTTP and grants paired clients
        // unattended execution. Never advertise a public interface as a phone
        // endpoint, even if the OS happens to assign one directly.
        const url = `http://${entry.address}:${port}`
        if (byUrl.has(url)) continue
        byUrl.set(url, {
          url,
          label,
          kind,
          recommended: entry.address === this.preferredAddress
        })
      }
    }
    const endpoints = [...byUrl.values()].sort((a, b) => {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1
      const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind]
      return rank !== 0 ? rank : a.url.localeCompare(b.url)
    })
    endpoints.push({
      url: `http://localhost:${port}`,
      label: 'This computer only',
      kind: 'loopback',
      recommended: false
    })
    return endpoints
  }

  getStatus(): MobileBridgeStatus {
    const now = this.now()
    const pairingActive = Boolean(this.pairingCode) && now < this.pairingExpiresAt
    return {
      running: Boolean(this.server && this.boundPort),
      port: this.boundPort,
      endpoints: this.endpoints(),
      pairingCode: pairingActive ? this.pairingCode : '',
      pairingExpiresAt: pairingActive ? this.pairingExpiresAt : 0,
      pairedDevices: this.devices.filter(
        (device) => now - device.pairedAt < DEVICE_TTL_MS
      ).length,
      error: this.lastError
    }
  }

  regeneratePairing(): MobileBridgeStatus {
    if (this.pairingTimer) clearTimeout(this.pairingTimer)
    this.pairingCode = String(randomInt(100_000, 1_000_000))
    this.pairingExpiresAt = this.now() + PAIRING_TTL_MS
    this.pairAttemptsForCode = 0
    const expiresAt = this.pairingExpiresAt
    this.pairingTimer = setTimeout(() => {
      if (this.pairingExpiresAt !== expiresAt || this.now() < expiresAt) return
      this.pairingCode = ''
      this.pairingExpiresAt = 0
      this.pairingTimer = null
      this.emit('status', this.getStatus())
    }, PAIRING_TTL_MS)
    const status = this.getStatus()
    this.emit('status', status)
    return status
  }

  async clearPairedDevices(): Promise<MobileBridgeStatus> {
    this.devices = []
    await this.saveDevices()
    for (const client of this.clients.keys()) client.end()
    this.clients.clear()
    const status = this.regeneratePairing()
    return status
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res))
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening)
        server.close()
        reject(error)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        server.on('error', (error) => {
          this.lastError = error.message
          this.emit('status', this.getStatus())
        })
        this.server = server
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '0.0.0.0')
    })
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.setSecurityHeaders(res)
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      if (url.pathname.startsWith('/api/')) {
        await this.handleApi(req, res, url)
      } else {
        await this.serveAsset(req, res, url)
      }
    } catch (error) {
      if (res.headersSent || res.writableEnded) return
      const status = error instanceof HttpError ? error.status : 500
      const message = error instanceof HttpError ? error.message : 'The mobile bridge failed.'
      this.sendJson(res, status, { error: message })
    }
  }

  private async handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    res.setHeader('cache-control', 'no-store')
    const method = req.method ?? 'GET'

    if (method === 'GET' && url.pathname === '/api/v1/health') {
      this.sendJson(res, 200, { ok: true, computerName: hostname() })
      return
    }
    if (method === 'GET' && url.pathname === '/api/v1/status') {
      const authenticated = Boolean(await this.authorize(req, false))
      this.sendJson(res, 200, {
        computerName: hostname(),
        authenticated,
        requiresPairing: !authenticated
      })
      return
    }
    if (method === 'POST' && url.pathname === '/api/v1/pair') {
      this.assertSafeOrigin(req)
      await this.pair(req, res)
      return
    }

    const authorizedDevice = await this.authorize(req, true)

    if (method === 'DELETE' && url.pathname === '/api/v1/pair') {
      this.assertSafeOrigin(req)
      const removedId = authorizedDevice?.id
      this.devices = this.devices.filter((device) => device.id !== removedId)
      await this.saveDevices()
      this.closeClients((client) => client.deviceId === removedId)
      res.setHeader(
        'set-cookie',
        'notch_device=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
      )
      this.sendJson(res, 200, { ok: true })
      this.emit('status', this.getStatus())
      return
    }

    if (method === 'GET' && url.pathname === '/api/v1/snapshot') {
      this.sendJson(res, 200, await this.snapshot())
      return
    }
    if (method === 'GET' && url.pathname === '/api/v1/events') {
      if (!authorizedDevice) throw new HttpError(401, 'Pair this phone with Notch first.')
      await this.openEventStream(req, res, authorizedDevice)
      return
    }
    if (method === 'POST' && url.pathname === '/api/v1/dispatch') {
      this.assertSafeOrigin(req)
      const body = await this.readJson(req)
      this.sendJson(res, 201, await this.dispatchFromPhone(body))
      return
    }

    const messagesMatch = /^\/api\/v1\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
    if (messagesMatch) {
      const key = decodeURIComponent(messagesMatch[1])
      if (method === 'GET') {
        this.sendJson(res, 200, await this.messagesFor(key))
        return
      }
      if (method === 'POST') {
        this.assertSafeOrigin(req)
        const body = await this.readJson(req)
        const text = stringValue(body.text).trim()
        this.sendJson(res, 202, await this.sendMessage(key, text))
        return
      }
    }

    throw new HttpError(404, 'Unknown mobile bridge route.')
  }

  private async pair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress ?? 'unknown'
    const now = this.now()
    const attempt = this.pairAttempts.get(remote)
    if (attempt && now - attempt.startedAt < PAIRING_ATTEMPT_WINDOW_MS) {
      if (attempt.count >= PAIRING_ATTEMPT_LIMIT) {
        throw new HttpError(429, 'Too many pairing attempts. Try again in a few minutes.')
      }
      attempt.count++
    } else {
      this.pairAttempts.set(remote, { count: 1, startedAt: now })
    }

    // Guesses against the current code, from anyone. Reset whenever a new code
    // is issued, so the budget is per-code rather than per-window.
    if (this.pairAttemptsForCode >= PAIRING_GLOBAL_ATTEMPT_LIMIT) {
      throw new HttpError(429, 'Too many pairing attempts. Generate a new pairing code.')
    }
    this.pairAttemptsForCode++

    const body = await this.readJson(req)
    const code = stringValue(body.code).replace(/\D/g, '')
    if (now > this.pairingExpiresAt || code !== this.pairingCode) {
      throw new HttpError(401, 'That pairing code is invalid or expired.')
    }

    const token = randomBytes(32).toString('base64url')
    const device: StoredDevice = {
      id: randomUUID(),
      name: stringValue(body.deviceName).trim().slice(0, 80) || 'Phone',
      tokenHash: hashToken(token),
      pairedAt: now,
      lastSeenAt: now
    }
    this.devices = [...this.devices.slice(-7), device]
    await this.saveDevices()
    this.pairAttempts.delete(remote)
    res.setHeader(
      'set-cookie',
      `notch_device=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DEVICE_TTL_SECONDS}`
    )
    this.regeneratePairing()
    this.sendJson(res, 200, { ok: true })
  }

  private async authorize(
    req: http.IncomingMessage,
    required: boolean
  ): Promise<StoredDevice | null> {
    const now = this.now()
    const activeDevices = this.devices.filter(
      (candidate) => now - candidate.pairedAt < DEVICE_TTL_MS
    )
    if (activeDevices.length !== this.devices.length) {
      this.devices = activeDevices
      await this.saveDevices()
      this.emit('status', this.getStatus())
    }
    const token = cookieValue(req, 'notch_device')
    const tokenHash = token ? hashToken(token) : ''
    const device = tokenHash
      ? this.devices.find((candidate) => candidate.tokenHash === tokenHash)
      : undefined
    if (!device) {
      if (required) throw new HttpError(401, 'Pair this phone with Notch first.')
      return null
    }
    device.lastSeenAt = now
    return device
  }

  private assertSafeOrigin(req: http.IncomingMessage): void {
    const origin = req.headers.origin
    if (!origin) return
    const host = req.headers.host ?? ''
    try {
      const originUrl = new URL(origin)
      if (originUrl.host === host) return
      const remote = req.socket.remoteAddress ?? ''
      const loopbackRemote =
        remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      const loopbackOrigin =
        originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1'
      if (loopbackRemote && loopbackOrigin) return
    } catch {
      // Rejected below.
    }
    throw new HttpError(403, 'Cross-origin request rejected.')
  }

  private async snapshot(): Promise<MobileSnapshot> {
    const [projects, desktop] = await Promise.all([
      this.options.getProjects(),
      Promise.resolve(this.options.watcher.getSnapshot())
    ])
    return {
      computerName: hostname(),
      connected: true,
      sessions: desktop.sessions.map((session) => this.toMobileSession(session)),
      projects: projects.map((project) => ({ name: projectName(project), path: project }))
    }
  }

  private toMobileSession(session: SessionState): MobileSessionSummary {
    const status = mobileStatus(session, this.runningSessions.has(session.key))
    return {
      key: session.key,
      agent: session.agent,
      name: session.name,
      project: projectName(session.cwd) || session.location || '',
      path: session.cwd,
      status,
      detail: statusDetail(session, status),
      updatedAt: session.updatedAt || session.statusUpdatedAt || session.startedAt,
      canMessage: canResume(session)
    }
  }

  private sessionFor(key: string): SessionState {
    const session = this.options.watcher
      .getSnapshot()
      .sessions.find((candidate) => candidate.key === key)
    if (!session) throw new HttpError(410, 'That session is no longer available.')
    return session
  }

  private async messagesFor(key: string): Promise<MobileMessage[]> {
    const session = this.sessionFor(key)
    let transcript = session.transcriptPath || this.transcriptCache.get(key)
    if (!transcript && session.agent === 'claude') {
      transcript = await findTranscriptInRoots(session.sessionId) ?? undefined
      if (transcript) this.transcriptCache.set(key, transcript)
    }
    if (!transcript) return []
    try {
      const text = await readTranscriptTail(transcript)
      return session.agent === 'codex' ? parseCodexMessages(text) : parseClaudeMessages(text)
    } catch {
      return []
    }
  }

  private async sendMessage(key: string, text: string): Promise<MobileMessage> {
    if (!text) throw new HttpError(400, 'Enter a message first.')
    if (text.length > 20_000) throw new HttpError(413, 'Message is too long.')
    const session = this.sessionFor(key)
    if (!canResume(session)) throw new HttpError(409, 'This session is read-only.')
    if (this.runningSessions.has(key) || session.status !== 'idle' || session.needsInput) {
      throw new HttpError(409, 'Wait until the agent is idle before sending a follow-up.')
    }

    const args = buildMobileFollowupArgs(
      session.agent === 'claude' ? 'claude' : 'codex',
      session.sessionId,
      text
    )

    // Reserve the session before spawning. `spawn` does not report success until
    // a later event, and two paired phones can otherwise both pass the idle
    // check during that gap and resume the same conversation concurrently.
    this.runningSessions.add(key)
    void this.queueBroadcast()
    try {
      await this.spawnFollowup(session.agent, args, session.cwd, key)
    } catch (error) {
      this.runningSessions.delete(key)
      void this.queueBroadcast()
      throw error
    }
    return {
      id: randomUUID(),
      role: 'user',
      text,
      createdAt: Date.now()
    }
  }

  private async spawnFollowup(
    agent: AgentKind,
    args: string[],
    cwd: string,
    key: string
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = (this.options.spawnProcess ?? spawn)(agent, args, {
        cwd,
        windowsHide: true,
        stdio: 'ignore'
      })
      child.once('error', reject)
      child.once('spawn', () => {
        resolve()
      })
      child.once('exit', () => {
        this.runningSessions.delete(key)
        void this.queueBroadcast()
      })
    })
  }

  private async dispatchFromPhone(body: Record<string, unknown>): Promise<MobileSessionSummary> {
    if (body.agent !== 'claude' && body.agent !== 'codex') {
      throw new HttpError(400, 'Choose Claude or Codex.')
    }
    const agent: AgentKind = body.agent
    const cwd = stringValue(body.cwd).trim()
    const prompt = stringValue(body.prompt).trim()
    if (!cwd || !prompt) throw new HttpError(400, 'Choose a project and enter a prompt.')
    if (prompt.length > 20_000) throw new HttpError(413, 'Prompt is too long.')
    const projects = await this.options.getProjects()
    const cwdKey = platform.paths.projectPathKey(platform.paths.normalizeProjectPath(cwd))
    const selected = projects.find((candidate) =>
      platform.paths.projectPathKey(platform.paths.normalizeProjectPath(candidate)) === cwdKey)
    if (!selected) throw new HttpError(403, 'Choose a project from the computer-owned list.')
    const targetKey = `${agent}\0${platform.paths.projectPathKey(platform.paths.normalizeProjectPath(selected))}`
    return this.runSerializedDispatch(targetKey, async () => {
      const before = new Set(
        this.options.watcher
          .getSnapshot()
          .sessions.filter((session) => session.agent === agent)
          .map((session) => session.key)
      )
      const dispatchedAt = Date.now()
      const result = await this.options.dispatch({
        agent,
        cwd: selected,
        prompt,
        // The phone has no terminal permission UI. Pairing is the explicit trust
        // grant, so mobile-launched work must use the unattended modes promised
        // by the companion UI and threat model.
        permissionMode: agent === 'codex' ? 'codex-bypass' : 'bypassPermissions'
      })
      if (!result.ok) throw new HttpError(500, result.error || 'The agent did not start.')

      const discovered = await this.waitForNewSession(agent, selected, before, 4500)
      if (discovered) return this.toMobileSession(discovered)
      return {
        key: `pending:${randomUUID()}`,
        agent,
        name: prompt.length > 54 ? `${prompt.slice(0, 51)}…` : prompt,
        project: projectName(selected),
        path: selected,
        status: 'working',
        detail: 'Started in Windows Terminal; waiting for its session record',
        updatedAt: dispatchedAt,
        canMessage: false,
        ...(result.sessionId ? { expectedKey: `${agent}:${result.sessionId}` } : {}),
        excludedKeys: [...before]
      }
    })
  }

  private async waitForNewSession(
    agent: AgentKind,
    cwd: string,
    before: Set<string>,
    timeoutMs: number
  ): Promise<SessionState | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.options.watcher
        .getSnapshot()
        .sessions.find(
          (session) =>
            session.agent === agent &&
            !before.has(session.key) &&
            platform.paths.projectPathKey(platform.paths.normalizeProjectPath(session.cwd)) ===
              platform.paths.projectPathKey(platform.paths.normalizeProjectPath(cwd))
        )
      if (found) return found
      await new Promise<void>((resolve) => setTimeout(resolve, 250))
    }
    return null
  }

  private async openEventStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    device: StoredDevice
  ): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    })
    // Register before the first async snapshot begins. An update that arrives
    // while getProjects() is pending must see this client and queue a successor
    // snapshot instead of disappearing permanently.
    this.clients.set(res, { deviceId: device.id, pairedAt: device.pairedAt })
    const remove = (): void => { this.clients.delete(res) }
    req.on('close', remove)
    res.on('error', remove)
    await this.queueBroadcast()
  }

  private queueBroadcast(): Promise<void> {
    if (this.broadcastQueued) return this.broadcastWork
    this.broadcastQueued = true
    const run = this.broadcastWork.then(async () => {
      this.broadcastQueued = false
      await this.broadcastSnapshot()
    })
    // Keep the serialization chain usable after a transient failure, and make
    // fire-and-forget watcher calls safe from unhandled rejections.
    this.broadcastWork = run.catch((error) => {
      console.error('[mobile bridge] snapshot broadcast failed:', (error as Error).message)
    })
    return this.broadcastWork
  }

  private async broadcastSnapshot(): Promise<void> {
    if (!this.clients.size) return
    this.pruneUnauthorizedClients()
    if (!this.clients.size) return
    const payload = `event: snapshot\ndata: ${JSON.stringify(await this.snapshot())}\n\n`
    this.writeToClients(payload)
  }

  /**
   * An SSE client that stops reading must not make the desktop buffer updates
   * without bound. Dropping that one connection is safe: both companions
   * reconnect automatically and receive a fresh snapshot.
   */
  private writeToClients(payload: string): void {
    for (const response of this.clients.keys()) {
      try {
        if (!response.destroyed && !response.writableEnded && response.write(payload)) continue
      } catch {
        // Treat a synchronous socket failure exactly like backpressure.
      }
      this.clients.delete(response)
      response.destroy()
    }
  }

  private closeClients(predicate: (client: { deviceId: string; pairedAt: number }) => boolean): void {
    for (const [response, client] of this.clients) {
      if (!predicate(client)) continue
      this.clients.delete(response)
      response.end()
    }
  }

  private pruneUnauthorizedClients(): void {
    const now = this.now()
    const activeIds = new Set(
      this.devices
        .filter((device) => now - device.pairedAt < DEVICE_TTL_MS)
        .map((device) => device.id)
    )
    this.closeClients((client) =>
      now - client.pairedAt >= DEVICE_TTL_MS || !activeIds.has(client.deviceId))
  }

  private async runSerializedDispatch<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.dispatchWork.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.dispatchWork.set(key, tail)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (this.dispatchWork.get(key) === tail) this.dispatchWork.delete(key)
    }
  }

  private async serveAsset(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'Method not allowed.')
    }
    const root = path.resolve(this.options.assetsDir)
    const requested = decodeURIComponent(url.pathname)
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '')
    let file = path.resolve(root, relative)
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
      throw new HttpError(403, 'Invalid asset path.')
    }
    try {
      const stat = await fsp.stat(file)
      if (!stat.isFile()) throw new Error('not a file')
    } catch {
      file = path.join(root, 'index.html')
    }
    const body = await fsp.readFile(file)
    res.writeHead(200, {
      'content-type': mimeType(file),
      'content-length': body.length,
      'cache-control': path.basename(file) === 'index.html' ? 'no-cache' : 'public, max-age=3600'
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  private setSecurityHeaders(res: http.ServerResponse): void {
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-frame-options', 'DENY')
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    )
  }

  private sendJson(res: http.ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body)
    })
    res.end(body)
  }

  private readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let tooLarge = false
      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          tooLarge = true
          reject(new HttpError(413, 'Request body is too large.'))
          return
        }
        chunks.push(chunk)
      })
      req.on('error', reject)
      req.on('end', () => {
        if (tooLarge) return
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          resolve(isRecord(parsed) ? parsed : {})
        } catch {
          reject(new HttpError(400, 'Request body must be valid JSON.'))
        }
      })
    })
  }

  private async loadDevices(): Promise<void> {
    try {
      const stored = JSON.parse(await fsp.readFile(this.devicesPath, 'utf8')) as StoredDevices
      const now = this.now()
      const devices = Array.isArray(stored.devices) ? stored.devices : []
      this.devices = devices.filter(
        (device) =>
          device &&
          typeof device.tokenHash === 'string' &&
          typeof device.pairedAt === 'number' &&
          Number.isFinite(device.pairedAt) &&
          now - device.pairedAt < DEVICE_TTL_MS
      )
      if (this.devices.length !== devices.length) await this.saveDevices()
    } catch {
      this.devices = []
    }
  }

  private async saveDevices(): Promise<void> {
    const save = this.deviceSaveWork.then(async () => {
      await fsp.mkdir(path.dirname(this.devicesPath), { recursive: true })
      const temporary = `${this.devicesPath}.tmp`
      await fsp.writeFile(
        temporary,
        `${JSON.stringify({ devices: this.devices }, null, 2)}\n`,
        'utf8'
      )
      await fsp.rename(temporary, this.devicesPath)
    })
    // A failed write must reject its caller but not poison later persistence.
    this.deviceSaveWork = save.catch(() => undefined)
    return save
  }
}
