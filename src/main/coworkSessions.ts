import fsp from 'node:fs/promises'
import path from 'node:path'
import type { SessionState } from '@shared/types'
import { AGENT_PATHS } from './agentPaths'
import { platform } from './platform'
import { cleanTitle, isPidAlive } from './sessionUtils'

/**
 * Claude Cowork sessions.
 *
 * Cowork is not a separate agent protocol. It runs a real Claude Code CLI — the
 * session files it writes are byte-for-byte the shape `sessionWatcher` already
 * parses — but points `CLAUDE_CONFIG_DIR` at a *per-session* directory inside
 * Claude Desktop's data folder rather than `~/.claude`. That single indirection
 * is the whole reason Cowork was invisible to the notch:
 *
 *   <root>/<accountUuid>/<orgUuid>/
 *     local_<uuid>.json                       session metadata (title, folders)
 *     local_<uuid>/
 *       .claude/sessions/<pid>.json           same shape as ~/.claude/sessions
 *       .claude/projects/<slug>/<cli>.jsonl   a standard Claude Code transcript
 *       audit.jsonl                           40 MB, and growing
 *
 * The CLI is spawned PER TURN and exits when the turn ends, so a live PID means
 * "working right now" and nothing else — an idle Cowork session has no process
 * at all. Idle rows therefore come from metadata recency, the way Codex rows do.
 */

/** How long a finished Cowork session stays listed. Matches `CODEX_RECENT_MS`. */
const COWORK_RECENT_MS = 30 * 60 * 1000

/** Enough for any plausible workspace; a runaway tree must not stall a sweep. */
const MAX_COWORK_SESSIONS = 64

/**
 * A sibling of the account directories rather than a session store, and it
 * nests org/account in the opposite order — walking into it would mint rows
 * from plugin manifests.
 */
const NON_ACCOUNT_DIRS = new Set(['skills-plugin'])

const SESSION_FILE = /^local_(.+)\.json$/

interface CoworkMetadata {
  sessionId: string
  cliSessionId: string
  cwd: string
  title: string
  model: string
  folder: string
  createdAt: number
  lastActivityAt: number
  isArchived: boolean
}

interface MetadataCacheEntry {
  size: number
  mtimeMs: number
  parsed: CoworkMetadata | null
}

export interface CoworkScan {
  sessions: SessionState[]
  /**
   * False when some part of the tree could not be read. As everywhere else in
   * the watcher this means "do not treat absence as proof of death" — it does
   * NOT mean an error worth showing, and a missing tree is fully authoritative.
   */
  authoritative: boolean
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * `local_<uuid>.json` is 200-600 KB of which almost all is `systemPrompt`, so
 * this is only ever called behind the size+mtime memo below.
 *
 * `JSON.parse` is the right parser despite `enabledMcpTools` carrying
 * case-varying duplicate keys (`local:Blender:x` beside `local:blender:x`).
 * Duplicates are legal JSON and last-one-wins here; it is strict dictionary
 * parsers such as PowerShell's `ConvertFrom-Json` that throw on them. Nothing
 * needs fixing.
 */
export function parseCoworkMetadata(fileName: string, text: string): CoworkMetadata | null {
  const match = SESSION_FILE.exec(fileName)
  if (!match) return null

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  // The filename is the authority: the `sessionId` field has been seen to carry
  // the `local_` prefix while sibling logs record the bare uuid.
  const sessionId = str(raw.sessionId) || `local_${match[1]}`

  const folders = Array.isArray(raw.userSelectedFolders) ? raw.userSelectedFolders : []
  const folder = folders.map((entry) => str(entry).trim()).find((entry) => entry !== '') ?? ''

  return {
    sessionId,
    cliSessionId: str(raw.cliSessionId),
    cwd: str(raw.cwd),
    title: cleanTitle(raw.title),
    model: str(raw.model),
    folder,
    createdAt: num(raw.createdAt),
    lastActivityAt: num(raw.lastActivityAt),
    isArchived: raw.isArchived === true
  }
}

/**
 * Builds the row for one Cowork session.
 *
 * `folder` — the directory the person actually chose in Cowork — is used as the
 * cwd rather than the session's real cwd, which is a `local_<uuid>/outputs`
 * scratch path that means nothing to anyone. Worse, that recorded cwd is an
 * un-virtualized `AppData\Roaming\Claude\...` string that does not exist on
 * disk under the Store build, so it must never reach anything that resolves it.
 */
export function toCoworkSession(
  meta: CoworkMetadata,
  livePid: number | null,
  freshness: number,
  transcriptPath: string | undefined
): SessionState {
  const working = livePid !== null
  return {
    key: `claude-cowork:${meta.sessionId}`,
    agent: 'claude-cowork',
    pid: livePid ?? undefined,
    sessionId: meta.sessionId,
    cwd: meta.folder,
    // Cowork can run with no folder attached at all, in which case there is no
    // honest path to show — say where it lives instead, as design rows do.
    location: meta.folder ? undefined : 'Claude Cowork',
    name: meta.title || (meta.folder ? path.basename(meta.folder) : 'Cowork session'),
    kind: 'cowork',
    entrypoint: 'local-agent',
    status: working ? 'busy' : 'idle',
    // Says which of the two signals produced the status, so a surprising row can
    // be read back to its cause.
    rawStatus: working ? 'local-agent-turn' : 'local-agent-recent',
    startedAt: meta.createdAt || freshness,
    updatedAt: freshness,
    statusUpdatedAt: freshness,
    needsInput: false,
    transcriptPath,
    // The per-turn CLI is not a safe kill target: it would abort a turn
    // mid-flight and Cowork would just spawn another. The row says Hide.
    canTerminate: false,
    // Cowork has no window of its own — it is a surface inside Claude Desktop's
    // single main window — and when idle it has no process to trace either.
    canFocus: false
  }
}

/** Freshest evidence of activity, in ms. */
function freshnessOf(meta: CoworkMetadata, metaMtimeMs: number): number {
  // `lastActivityAt` lags: it is stamped at turn boundaries and has been
  // observed minutes behind a transcript that was still growing.
  return Math.max(meta.lastActivityAt, metaMtimeMs)
}

export class CoworkReader {
  private roots: string[] | null = null
  private readonly metadata = new Map<string, MetadataCacheEntry>()

  /**
   * Resolved roots, remembered once found.
   *
   * An empty result is deliberately NOT cached, so installing Claude Desktop
   * mid-session starts producing rows without restarting the notch. A non-empty
   * one is, because sweeping `%LOCALAPPDATA%\Packages` every two seconds to
   * re-learn a path that does not move would be pure waste.
   */
  private async resolveRoots(): Promise<string[]> {
    if (AGENT_PATHS.coworkOverride) return [AGENT_PATHS.coworkOverride]
    if (this.roots && this.roots.length > 0) return this.roots
    this.roots = await platform.coworkRoots.roots()
    return this.roots
  }

  async read(now: number): Promise<CoworkScan> {
    const roots = await this.resolveRoots()
    if (roots.length === 0) return { sessions: [], authoritative: true }

    const sessions: SessionState[] = []
    const seen = new Set<string>()
    let authoritative = true

    for (const root of roots) {
      const accounts = await this.listDirs(root)
      if (accounts === null) {
        authoritative = false
        continue
      }
      for (const account of accounts) {
        if (NON_ACCOUNT_DIRS.has(account.toLowerCase())) continue
        const accountDir = path.join(root, account)
        const orgs = await this.listDirs(accountDir)
        if (orgs === null) {
          authoritative = false
          continue
        }
        for (const org of orgs) {
          const result = await this.readOrg(path.join(accountDir, org), now, sessions, seen)
          authoritative = result && authoritative
          if (sessions.length >= MAX_COWORK_SESSIONS) break
        }
      }
    }

    this.pruneMetadataCache(seen)
    return { sessions, authoritative }
  }

  /**
   * One `<accountUuid>/<orgUuid>` directory.
   *
   * The traversal is fixed-depth on purpose and there is no recursive helper
   * anywhere in this file. Each session directory holds a 40 MB `audit.jsonl`,
   * a full nested Claude Code home and an `outputs` tree, with a 9 GB VM disk
   * image not far away — pointing a `listJsonl`-style walk at this would be a
   * disaster.
   */
  private async readOrg(
    orgDir: string,
    now: number,
    sessions: SessionState[],
    seen: Set<string>
  ): Promise<boolean> {
    let entries: string[]
    try {
      entries = await fsp.readdir(orgDir)
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT'
    }

    let authoritative = true
    for (const entry of entries) {
      if (sessions.length >= MAX_COWORK_SESSIONS) break
      const match = SESSION_FILE.exec(entry)
      if (!match) continue

      const metaPath = path.join(orgDir, entry)
      const meta = await this.metadataFor(metaPath, entry)
      if (meta === undefined) {
        authoritative = false
        continue
      }
      // A file that parsed but is not a session is not a read failure.
      if (meta === null) continue
      if (meta.isArchived) continue
      if (seen.has(meta.sessionId)) continue

      const stat = await this.statOf(metaPath)
      const freshness = freshnessOf(meta, stat?.mtimeMs ?? 0)
      const sessionDir = path.join(orgDir, `local_${match[1]}`)
      const livePid = await this.livePidFor(sessionDir, now, freshness)

      // No running turn and nothing recent: a months-dormant chat, not a row.
      if (livePid === null && now - freshness > COWORK_RECENT_MS) continue

      seen.add(meta.sessionId)
      sessions.push(
        toCoworkSession(meta, livePid, freshness, this.transcriptPath(sessionDir, meta))
      )
    }
    return authoritative
  }

  /**
   * The PID of a turn running right now, or `null`.
   *
   * The `.claude/sessions` directory mtime is checked first so a session last
   * touched in April costs one `stat` instead of a readdir plus file reads.
   * Its mtime moves whenever a turn writes a PID file, so it can only be stale
   * if there is genuinely nothing to find.
   */
  private async livePidFor(
    sessionDir: string,
    now: number,
    freshness: number
  ): Promise<number | null> {
    const dir = path.join(sessionDir, '.claude', 'sessions')
    const stat = await this.statOf(dir)
    if (!stat) return null
    if (now - Math.max(stat.mtimeMs, freshness) > COWORK_RECENT_MS) return null

    let entries: string[]
    try {
      entries = await fsp.readdir(dir)
    } catch {
      return null
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      // Stale PID files outlive their process here exactly as they do in
      // ~/.claude/sessions, so the filename is a claim to be verified.
      const pid = Number.parseInt(path.basename(entry, '.json'), 10)
      if (isPidAlive(pid)) return pid
    }
    return null
  }

  /**
   * The nested transcript, if the layout is the one we expect.
   *
   * Built rather than searched: it is a standard Claude Code transcript keyed by
   * `cliSessionId`, under the project slug for the session's own outputs cwd.
   * Returning a path that may not exist is fine — every consumer reads it
   * defensively — and is far cheaper than walking the session tree to find it.
   */
  private transcriptPath(sessionDir: string, meta: CoworkMetadata): string | undefined {
    if (!meta.cliSessionId || !meta.cwd) return undefined
    const slug = meta.cwd.replace(/[^a-zA-Z0-9]/g, '-')
    return path.join(sessionDir, '.claude', 'projects', slug, `${meta.cliSessionId}.jsonl`)
  }

  /**
   * `undefined` on read failure, `null` when the file is not a session.
   *
   * Memoized on size+mtime like the Codex rollout cache: these files are big and
   * only change at turn boundaries, so re-parsing them on a 2 s poll would be
   * the most expensive thing the notch does.
   */
  private async metadataFor(
    metaPath: string,
    fileName: string
  ): Promise<CoworkMetadata | null | undefined> {
    const stat = await this.statOf(metaPath)
    if (!stat) return undefined

    const cached = this.metadata.get(metaPath)
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.parsed
    }

    let text: string
    try {
      text = await fsp.readFile(metaPath, 'utf8')
    } catch {
      return undefined
    }
    const parsed = parseCoworkMetadata(fileName, text)
    this.metadata.set(metaPath, { size: stat.size, mtimeMs: stat.mtimeMs, parsed })
    return parsed
  }

  private async statOf(target: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const stat = await fsp.stat(target)
      return { size: stat.size, mtimeMs: stat.mtimeMs }
    } catch {
      return null
    }
  }

  /** Directory names in `dir`, or `null` when the listing failed for real. */
  private async listDirs(dir: string): Promise<string[] | null> {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch (err) {
      // A tree that is simply not there is a complete answer, not a failure.
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null
    }
  }

  /**
   * Drops cache entries for sessions that stopped being listed, so archiving or
   * deleting Cowork chats cannot grow this map for the life of the process.
   */
  private pruneMetadataCache(seen: Set<string>): void {
    if (this.metadata.size <= MAX_COWORK_SESSIONS * 4) return
    for (const [key, entry] of this.metadata) {
      if (!entry.parsed || !seen.has(entry.parsed.sessionId)) this.metadata.delete(key)
    }
  }
}
