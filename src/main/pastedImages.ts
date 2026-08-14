/**
 * Turns clipboard image bytes into a file the Tray can hold.
 *
 * The Tray holds paths, because an @-reference is a path — that is the whole
 * contract with the agents. A dropped file already has one and is referenced
 * where it lies. A pasted screenshot has none, so it has to land on disk first.
 *
 * It lands under userData rather than the OS temp directory: the file is not
 * read when it is pasted, it is read whenever the agent that was dispatched
 * with it gets around to opening it, and a temp sweeper is entitled to delete
 * it in between. Old pastes are pruned here instead, on a schedule this code
 * controls.
 *
 * The extension is decided by sniffing the bytes, never by the type the
 * clipboard claims. That extension is the only hint the agent gets about what
 * it is opening, so it has to describe what is actually in the file, and bytes
 * matching nothing are refused rather than saved under a guess.
 */
import { app } from 'electron'
import { MAX_PASTED_IMAGE_BYTES } from '../shared/types'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** How long a pasted image survives before the next paste sweeps it away. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000

const ascii = (bytes: Uint8Array, at: number, text: string): boolean => {
  if (bytes.length < at + text.length) return false
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false
  }
  return true
}

const magic = (bytes: Uint8Array, values: number[]): boolean => {
  if (bytes.length < values.length) return false
  return values.every((value, i) => bytes[i] === value)
}

/** ISO base media brands that are still just a picture. */
const isoBrand = (bytes: Uint8Array, brands: string[]): boolean =>
  ascii(bytes, 4, 'ftyp') && brands.some((brand) => ascii(bytes, 8, brand))

const BOM = /^\uFEFF/

/**
 * SVG has no magic number, so it is recognized last and only as a fallback:
 * text that opens a tag and reaches an `<svg` early on.
 */
const looksLikeSvg = (bytes: Uint8Array): boolean => {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('utf8').replace(BOM, '').trim()
  return head.startsWith('<') && head.includes('<svg')
}

const SIGNATURES: Array<[string, (bytes: Uint8Array) => boolean]> = [
  ['png', (b) => magic(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['jpg', (b) => magic(b, [0xff, 0xd8, 0xff])],
  ['gif', (b) => ascii(b, 0, 'GIF8')],
  ['webp', (b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')],
  ['bmp', (b) => ascii(b, 0, 'BM')],
  ['tif', (b) => magic(b, [0x49, 0x49, 0x2a, 0x00]) || magic(b, [0x4d, 0x4d, 0x00, 0x2a])],
  ['avif', (b) => isoBrand(b, ['avif', 'avis'])],
  ['heic', (b) => isoBrand(b, ['heic', 'heix', 'hevc', 'mif1'])],
  ['svg', looksLikeSvg]
]

/** The extension for the format these bytes actually are, or null if unknown. */
export function sniffImageExtension(bytes: Uint8Array): string | null {
  for (const [ext, matches] of SIGNATURES) {
    if (matches(bytes)) return ext
  }
  return null
}

/** Where pasted images live. Only the main process knows this path. */
export function pastedImagesDir(): string {
  return path.join(app.getPath('userData'), 'pasted-images')
}

/** Sortable, local-time, collision-proof — and readable in an agent's prompt. */
function pastedName(extension: string, now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('')
  return `paste-${stamp}-${randomBytes(3).toString('hex')}.${extension}`
}

/**
 * Writes clipboard bytes into `dir` and returns the path, or null if the bytes
 * are empty, oversized, or not an image this can name.
 *
 * `dir` is a parameter rather than `pastedImagesDir()` so the whole write path
 * is exercisable outside Electron.
 */
export async function savePastedImage(dir: string, bytes: Uint8Array): Promise<string | null> {
  if (bytes.length === 0 || bytes.length > MAX_PASTED_IMAGE_BYTES) return null
  const extension = sniffImageExtension(bytes)
  if (!extension) return null

  await fs.mkdir(dir, { recursive: true })
  // `wx` rather than a plain write: two pastes in the same second are one
  // random suffix apart, and silently overwriting the earlier one would drop a
  // file the user has already put in the tray.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const target = path.join(dir, pastedName(extension))
    try {
      await fs.writeFile(target, bytes, { flag: 'wx' })
      void prunePastedImages(dir)
      return target
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  return null
}

/** Best-effort sweep of pastes older than KEEP_MS. Never throws. */
export async function prunePastedImages(dir: string, now = Date.now()): Promise<void> {
  try {
    for (const name of await fs.readdir(dir)) {
      if (!name.startsWith('paste-')) continue
      const target = path.join(dir, name)
      const stat = await fs.stat(target).catch(() => null)
      if (stat && now - stat.mtimeMs > KEEP_MS) await fs.rm(target, { force: true })
    }
  } catch {
    // The directory may not exist yet, or the sweep may race a real paste.
    // Neither is worth reporting: stale scratch files are not a failure.
  }
}
