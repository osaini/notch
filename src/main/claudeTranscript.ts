import type { Dirent } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { CLAUDE_USAGE_DIRS, PROJECTS_DIR } from './usage'

/**
 * Claude Code names a session file after its PID and fills `name` with a slug
 * derived from the cwd (`windows-notch-40`). The title a person recognises —
 * the one the terminal tab shows — is only ever written to the transcript, as
 * repeated `{"type":"ai-title","aiTitle":"…"}` records. This module finds that
 * transcript and reads the newest title out of it.
 */

/** Backwards scan granularity, and the delta read's minimum useful window. */
const CHUNK_BYTES = 64 * 1024
/**
 * Transcripts reach several megabytes and the title is almost always in the
 * last chunk. One outlier on a resumed session sat 1.9 MB back, so the walk is
 * generous — but bounded, because a session whose title never appears must not
 * cost a full re-read of the file on every scan.
 */
const MAX_SCAN_BYTES = 8 * 1024 * 1024

interface TitleCacheEntry {
  size: number
  mtimeMs: number
  title: string
}

/**
 * The directory Claude Code stores a project's transcripts under: the absolute
 * cwd with every non-alphanumeric character replaced by a hyphen, which is why
 * `C:\Users\me` becomes `C--Users-me` and a worktree keeps its doubled hyphen.
 */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Recursive lookup of `<sessionId>.jsonl`, for when the cwd encoding misses. */
export async function findTranscript(dir: string, sessionId: string): Promise<string | null> {
  let entries: Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const expected = `${sessionId}.jsonl`.toLowerCase()
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === expected) return full
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findTranscript(path.join(dir, entry.name), sessionId)
    if (found) return found
  }
  return null
}

/** Looks through Claude's current and compatibility transcript roots in order. */
export async function findTranscriptInRoots(
  sessionId: string,
  roots: readonly string[] = CLAUDE_USAGE_DIRS
): Promise<string | null> {
  for (const root of roots) {
    const found = await findTranscript(root, sessionId)
    if (found) return found
  }
  return null
}

/**
 * The `aiTitle` of the last `ai-title` record in a slice of transcript JSONL.
 *
 * The record's own `sessionId` is deliberately ignored: resuming a conversation
 * carries the pre-resume records into the new file, and the newest title is
 * still the right one for it. A leading partial line simply fails to parse.
 */
export function lastAiTitle(text: string): string {
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (!line || line.charCodeAt(0) !== 123 || !line.includes('"ai-title"')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    if (record.type !== 'ai-title') continue
    const title = typeof record.aiTitle === 'string' ? record.aiTitle : ''
    if (title) return title
  }
  return ''
}

async function readRange(
  handle: Awaited<ReturnType<typeof fsp.open>>,
  start: number,
  end: number
): Promise<string> {
  const length = end - start
  if (length <= 0) return ''
  const buffer = Buffer.alloc(length)
  await handle.read(buffer, 0, length, start)
  return buffer.toString('utf8')
}

/**
 * Walks back from EOF a chunk at a time until a title turns up. Each chunk is
 * joined to the one after it before parsing, so a record straddling a chunk
 * boundary is still read whole.
 */
async function scanBackwards(
  handle: Awaited<ReturnType<typeof fsp.open>>,
  size: number
): Promise<string> {
  const floor = Math.max(0, size - MAX_SCAN_BYTES)
  let end = size
  let carry = ''
  while (end > floor) {
    const start = Math.max(floor, end - CHUNK_BYTES)
    const text = (await readRange(handle, start, end)) + carry
    const title = lastAiTitle(text)
    if (title) return title
    // Everything before the first newline may be half a record; hand it to the
    // next (earlier) chunk rather than re-reading it.
    const firstNewline = text.indexOf('\n')
    carry = firstNewline >= 0 ? text.slice(0, firstNewline + 1) : text
    end = start
  }
  return ''
}

/**
 * Resolves and caches the newest `aiTitle` for live Claude sessions.
 *
 * The watcher rescans every two seconds, so nothing here re-reads a transcript
 * that has not changed, and a transcript that has only grown is read from the
 * previous end onwards.
 */
export class ClaudeTitleReader {
  /** `null` records a session whose transcript does not exist yet. */
  private paths = new Map<string, string | null>()
  private titles = new Map<string, TitleCacheEntry>()

  /** '' when the session has no transcript, or none with a title yet. */
  async titleFor(sessionId: string, cwd: string): Promise<string> {
    if (!sessionId) return ''
    const file = await this.resolvePath(sessionId, cwd)
    if (!file) return ''
    return this.readTitle(file)
  }

  /** The transcript backing a session, once found. */
  transcriptPath(sessionId: string): string | undefined {
    return this.paths.get(sessionId) ?? undefined
  }

  /** Drops every session that is no longer running. */
  prune(liveSessionIds: ReadonlySet<string>): void {
    const liveFiles = new Set<string>()
    for (const [sessionId, file] of this.paths) {
      if (!liveSessionIds.has(sessionId)) this.paths.delete(sessionId)
      else if (file) liveFiles.add(file)
    }
    for (const file of this.titles.keys()) {
      if (!liveFiles.has(file)) this.titles.delete(file)
    }
  }

  private async resolvePath(sessionId: string, cwd: string): Promise<string | null> {
    const cached = this.paths.get(sessionId)
    // A resolved path never moves. A `null` is retried, because a session that
    // has only just started may not have written its transcript yet.
    if (cached) return cached
    const guess = cwd ? path.join(PROJECTS_DIR, projectDirName(cwd), `${sessionId}.jsonl`) : ''
    let file: string | null = null
    if (guess) {
      try {
        await fsp.access(guess)
        file = guess
      } catch {
        // The cwd encoding is a fast path, not a contract.
      }
    }
    if (!file) file = await findTranscriptInRoots(sessionId)
    this.paths.set(sessionId, file)
    return file
  }

  private async readTitle(file: string): Promise<string> {
    let handle: Awaited<ReturnType<typeof fsp.open>>
    try {
      handle = await fsp.open(file, 'r')
    } catch {
      return this.titles.get(file)?.title ?? ''
    }
    try {
      const { size, mtimeMs } = await handle.stat()
      const cached = this.titles.get(file)
      if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.title
      let title: string
      if (cached && size > cached.size) {
        // Only the appended bytes can hold a newer title; the previous one
        // stands if they hold none. The window reaches back a chunk so a record
        // that was half-written at the last stat is not missed — re-reading a
        // title we already have costs nothing.
        const from = Math.max(0, cached.size - CHUNK_BYTES)
        title = lastAiTitle(await readRange(handle, from, size)) || cached.title
      } else {
        title = await scanBackwards(handle, size)
      }
      this.titles.set(file, { size, mtimeMs, title })
      return title
    } catch {
      return this.titles.get(file)?.title ?? ''
    } finally {
      await handle.close()
    }
  }
}
