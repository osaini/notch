/**
 * Regenerates `build/icon.png` and `build/icon.ico` from `build/icon.svg`.
 *
 * Hand-run, not a build step: all three files are committed, so a fresh checkout
 * needs no rasterizer and CI has nothing to generate. Run this only when
 * `icon.svg` changes, and commit the results — CI fails a PR that touches the SVG
 * without the raster outputs.
 *
 * This replaces `generateIcons.ps1`, which used System.Drawing and so could only
 * run on Windows — the one thing that hard-blocked a macOS checkout. It renders
 * under Electron rather than adding a rasterizer dependency: `sharp` is a native
 * addon with platform-specific prebuilds, and this project keeps its runtime
 * dependencies to exactly `ws` so there is nothing to recompile per platform.
 * Running a script under Electron is a pattern the repo already uses for
 * `test:tray-icons`.
 *
 * The SVG is loaded rather than redrawn. `generateIcons.ps1` reimplemented the
 * artwork as GraphicsPath calls, which meant two sources of truth that could
 * drift silently.
 *
 * There is deliberately no .icns here: electron-builder derives the macOS icon
 * from a >=512px PNG using its bundled app-builder, cross-platform.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, app, nativeImage } from 'electron'

/** The sizes Windows actually picks between, smallest to largest. */
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
/** electron-builder wants at least 512 to derive a macOS .icns. */
const PNG_SIZE = 512

/**
 * Every size is rendered once, stacked in a single page, and cropped out.
 *
 * Two constraints force this rather than one window per size:
 *  - Windows clamps a window to roughly 120px wide, so a 16x16 window cannot
 *    exist and its capture comes back padded.
 *  - `webPreferences.offscreen` makes `loadFile` fail outright with ERR_FAILED,
 *    so the hidden-window path is the only one available.
 *
 * Rendering each size natively also beats downscaling one large capture: the
 * artwork has 14px-at-512 strokes, which bicubic downscaling to 16px turns to
 * mush.
 */
const LAYOUT_WIDTH = 512
const ALL_SIZES = [...ICO_SIZES, PNG_SIZE]
const TOTAL_HEIGHT = ALL_SIZES.reduce((sum, size) => sum + size, 0)

const buildDir = join(__dirname, '..', 'build')
/**
 * Written next to icon.svg so the page can reference it with a relative path.
 *
 * A `data:text/html` document whose `<img>` is itself a `data:` URL is refused by
 * Chromium, so the page has to be loaded from a real file.
 */
const stagePath = join(buildDir, '.icon-render.html')

function stageHtml(): string {
  const blocks = ALL_SIZES.map(
    (size) => `<img src="icon.svg" width="${size}" height="${size}">`
  ).join('\n')
  return `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  /* Stacked flush at the top-left so each crop rect is a running total. */
  img{display:block;margin:0}
</style>
${blocks}`
}

/** Renders every size once and returns them keyed by edge length. */
async function renderAll(): Promise<Map<number, Buffer>> {
  writeFileSync(stagePath, stageHtml(), 'utf8')
  const win = new BrowserWindow({
    width: LAYOUT_WIDTH,
    height: TOTAL_HEIGHT,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000'
  })
  try {
    await win.loadFile(stagePath)
    let sheet = await win.webContents.capturePage()
    // The capture is in device pixels, so a HiDPI display returns a scaled
    // sheet. Normalising back to the CSS layout size restores the crop
    // coordinates below. LAYOUT_WIDTH is far above the platform minimum window
    // width, so this only ever undoes device scaling.
    const captured = sheet.getSize()
    if (captured.width !== LAYOUT_WIDTH || captured.height !== TOTAL_HEIGHT) {
      sheet = sheet.resize({ width: LAYOUT_WIDTH, height: TOTAL_HEIGHT, quality: 'best' })
    }
    if (sheet.isEmpty()) throw new Error('the render sheet came back empty')

    const rendered = new Map<number, Buffer>()
    let y = 0
    for (const size of ALL_SIZES) {
      const tile = sheet.crop({ x: 0, y, width: size, height: size })
      if (tile.isEmpty()) throw new Error(`the ${size}px tile came back empty`)
      rendered.set(size, tile.toPNG())
      y += size
    }
    return rendered
  } finally {
    win.destroy()
  }
}

/**
 * Packs PNGs into an ICO container.
 *
 * A direct port of the BinaryWriter block in the old generateIcons.ps1: same
 * header, same 16-byte directory entries, same PNG-in-ICO payloads.
 */
function buildIco(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  let offset = header.length + directory.length
  images.forEach(({ size, png }, index) => {
    const at = index * 16
    // 256 is encoded as 0 — the field is a single byte, so 256 does not fit.
    directory.writeUInt8(size === 256 ? 0 : size, at)
    directory.writeUInt8(size === 256 ? 0 : size, at + 1)
    directory.writeUInt8(0, at + 2) // palette size: not paletted
    directory.writeUInt8(0, at + 3) // reserved
    directory.writeUInt16LE(1, at + 4) // colour planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += png.length
  })

  return Buffer.concat([header, directory, ...images.map((image) => image.png)])
}

app.whenReady()
  .then(async () => {
    mkdirSync(buildDir, { recursive: true })
    const rendered = await renderAll()

    const icoPath = join(buildDir, 'icon.ico')
    const ico = buildIco(ICO_SIZES.map((size) => ({ size, png: rendered.get(size)! })))
    writeFileSync(icoPath, ico)
    console.log(`Generated ${icoPath} with ${ICO_SIZES.length} sizes, ${ico.length} bytes`)

    const pngPath = join(buildDir, 'icon.png')
    writeFileSync(pngPath, rendered.get(PNG_SIZE)!)
    console.log(`Generated ${pngPath} at ${PNG_SIZE}px, ${rendered.get(PNG_SIZE)!.length} bytes`)

    const check = nativeImage.createFromPath(pngPath)
    if (check.isEmpty() || check.getSize().width !== PNG_SIZE) {
      throw new Error('the generated icon.png is not a readable 512px image')
    }
    app.quit()
  })
  .catch((error: unknown) => {
    console.error(error)
    app.exit(1)
  })
  .finally(() => {
    rmSync(stagePath, { force: true })
  })
