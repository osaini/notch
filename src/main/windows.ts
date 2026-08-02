import { join } from 'node:path'
import { BrowserWindow, screen, shell } from 'electron'

/**
 * `shell.openExternal` hands the URL to whatever handler Windows has
 * registered for its scheme, which includes plenty that are not browsers
 * (`file:`, `ms-msdt:`, and anything else installed software has claimed).
 * Only the three schemes a link in this UI could legitimately mean get through.
 */
const OPENABLE_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

function isExternallyOpenable(url: string): boolean {
  try {
    return OPENABLE_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

import {
  NOTCH_POSITION_PRESETS,
  type AppSettings,
  type DisplayOption,
  type NotchDragInput,
  type NotchDragState,
  type NotchPosition,
  type ScreenEdge
} from '@shared/types'

/**
 * The overlay window is a fixed-size transparent sheet pinned to an edge of a
 * display. The renderer draws the collapsed pill against that edge and expands
 * the panel inward inside the same window, so growing and shrinking never
 * resizes (and never flickers) the native window.
 *
 * While collapsed the window is click-through. Hover-to-expand is detected
 * here from screen coordinates because Windows does not reliably forward
 * renderer mouse events through a click-through native window.
 *
 * # Motion
 *
 * Everything is animated in terms of the *pill's centre point in screen
 * coordinates* rather than window bounds, because the pill occupies a
 * different spot inside the overlay for each edge (top-centre, bottom-centre,
 * left-middle, right-middle). The window origin is derived from that centre
 * every frame:
 *
 *     origin = pillCentre - paint
 *
 * where `paint` is where the renderer draws the pill inside the window (sent to
 * it as an offset from the window's centre). Those two values must always
 * agree, and they live in different processes: a change to `paint` only reaches
 * the screen a frame or two after the window has already moved, so any change
 * to it while the window is moving tears the pill loose for those frames. Hence
 * the rule this file is built around:
 *
 *   - `paint` holds still for the whole hold, apart from the turn described
 *     below, and only really moves during the settle that follows the release,
 *     where it is interpolated with the same eased progress as the flight — so
 *     it is a small fraction of motion the pill is making anyway.
 *
 * A drag previews whichever of the four edges is nearest, so it can turn the
 * pill onto a perpendicular one mid-hold. That is safe because the renderer
 * centres the collapsed pill in the window and offsets it by `paint`: the
 * reshape from 276x32 to 32x276 happens around a fixed centre, so the turn
 * itself moves nothing. `paint` still has to give a little, because a pill
 * turned end-on needs half its length of window on either side and the value
 * frozen at grab time may sit only half a thickness from the window edge. It
 * slews over TURN_MS to the nearest value that keeps the reshaped pill inside
 * the window (see `fitPaint`) — the smallest correction that works, made while
 * the pill is already flying to a different edge.
 */
export const OVERLAY_WIDTH = 520
export const OVERLAY_HEIGHT = 660

/** How often we check whether the cursor has left an interactive window. */
const CURSOR_POLL_MS = 200
/** Pill geometry inside the overlay; mirrors --pill-h and the wrap size in styles.css. */
const PILL_THICKNESS = 32
const PILL_LENGTH = 276
/** Maximum along-edge distance from a named preset before drag snaps to it. */
const PRESET_SNAP_DISTANCE = 44
/** How far past its resting line the pill must be pulled to fly free of the edge. */
const DETACH_DISTANCE = 100
/** Coming back within this distance reattaches; the gap from the above is hysteresis. */
const REATTACH_DISTANCE = 64
/**
 * How much closer a rival edge must be before the drag stops previewing the one
 * it is on. Without it the two edges meeting at a corner are both a hair away
 * and the pill flaps between their shapes; with it, sliding along the top into a
 * corner stays on the top and you have to commit this far inward down the side
 * to turn the pill onto it.
 */
const EDGE_STICKINESS = 40
/** Peak elastic gap an attached pill opens up while it is being pulled away. */
const RUBBER_BAND = 30
/** Motion loop period. ~83Hz is smooth and leaves the compositor room to breathe. */
const FRAME_MS = 12
/** Exponential follow constant while dragging; smaller tracks the cursor tighter. */
const DRAG_TAU_MS = 26
/** Duration of the settle animation that lands the pill back onto an edge. */
const SETTLE_MS = 300
/** Paint slew when the pill turns onto a perpendicular edge; mirrors the CSS reshape. */
const TURN_MS = 220

type Axis = 'horizontal' | 'vertical'

interface Point {
  x: number
  y: number
}

interface DragSession {
  /**
   * Grab offset along the pill's long axis. Carried through a turn rather than
   * recomputed: it is the fraction of the way along the bar the pill was picked
   * up by, so keeping it means you keep hold of the same spot once it rotates.
   */
  grabAlong: number
  /** Which edge the pill is currently previewing; its axis is the pill's shape. */
  edge: ScreenEdge
  floating: boolean
}

interface MotionState {
  mode: 'drag' | 'settle'
  /** Pill centre in screen coordinates. */
  pill: Point
  /** Pill centre inside the overlay window. */
  paint: Point
  detach: number
  target: { pill: Point; detach: number }
  from: { pill: Point; paint: Point; detach: number }
  paintTarget: Point
  startedAt: number
  duration: number
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * Rounds a screen coordinate to a value Electron will accept. `Math.round`
 * alone is not enough: it returns `-0` for anything in [-0.5, 0), and V8 reports
 * `-0` as not an int32, so the native bindings reject it with "conversion
 * failure" rather than treating it as zero. A pill settling against the top or
 * left edge sits exactly where the coordinate crosses zero, so the animation
 * would sample a fraction below it and take the main process down.
 */
function roundCoord(value: number): number {
  const rounded = Math.round(value)
  return rounded === 0 ? 0 : rounded
}

export class NotchWindow {
  private win: BrowserWindow | null = null
  private interactive: boolean | null = null
  private cursorTimer: NodeJS.Timeout | null = null
  private frameTimer: NodeJS.Timeout | null = null
  private lastFrameAt = 0
  private motion: MotionState | null = null
  private drag: DragSession | null = null
  private appliedOrigin: Point | null = null
  private sentDragState: NotchDragState | null = null
  private peekUntil = 0
  private settings: AppSettings = {
    position: { displayId: null, edge: 'top', offset: 0.5 },
    launchAtLogin: false,
    theme: 'dark',
    mobileBridge: false
  }

  create(): BrowserWindow {
    const win = new BrowserWindow({
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: true,
      show: false,
      // A tool window stays out of Alt-Tab, which is what an overlay wants.
      type: 'toolbar',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        // The preload only touches `electron` itself, so it has nothing to lose
        // by running seatbelted — and a renderer compromise gains far less.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    this.win = win
    // `screen-saver` is the highest level that still lets normal windows be
    // focused; it keeps the notch above the taskbar and above maximised apps.
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.setInteractive(false)
    this.startCursorWatch()
    this.reposition(false)

    win.once('ready-to-show', () => win.showInactive())

    // A reload (or a dev-server hot swap) mid-gesture leaves no renderer to
    // send the release, so drop the session rather than pinning the window.
    win.webContents.on('did-start-loading', () => {
      this.drag = null
      this.sentDragState = null
    })


    // Never navigate the overlay itself; open real links in the browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isExternallyOpenable(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })

    // The overlay is a fixed local document. Anything that tries to replace it
    // in place — a stray anchor, an injected script — is a bug or an attack.
    win.webContents.on('will-navigate', (event, url) => {
      if (url === win.webContents.getURL()) return
      event.preventDefault()
      if (isExternallyOpenable(url)) void shell.openExternal(url)
    })

    const onDisplayChange = (): void => this.reposition()
    screen.on('display-metrics-changed', onDisplayChange)
    screen.on('display-added', onDisplayChange)
    screen.on('display-removed', onDisplayChange)

    win.on('closed', () => {
      screen.removeListener('display-metrics-changed', onDisplayChange)
      screen.removeListener('display-added', onDisplayChange)
      screen.removeListener('display-removed', onDisplayChange)
      this.stopCursorWatch()
      this.stopMotion()
      this.drag = null
      this.win = null
    })

    return win
  }

  get browserWindow(): BrowserWindow | null {
    return this.win
  }

  loadRenderer(devServerUrl: string | undefined): void {
    if (!this.win) return
    if (devServerUrl) {
      void this.win.loadURL(devServerUrl)
    } else {
      void this.win.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  getDisplays(): DisplayOption[] {
    const primaryId = screen.getPrimaryDisplay().id
    return screen.getAllDisplays().map((display, index) => ({
      id: String(display.id),
      label: `Display ${index + 1} · ${display.bounds.width}×${display.bounds.height}`,
      primary: display.id === primaryId,
      bounds: { ...display.bounds }
    }))
  }

  applySettings(settings: AppSettings, animate = true): void {
    this.settings = settings
    // A live drag owns the position; the settings write it produces at the end
    // of the gesture must not yank the window out from under the settle.
    if (this.drag) return
    this.reposition(animate)
  }

  /** Moves the overlay to its persisted display, edge and normalized offset. */
  reposition(animate = false): void {
    if (!this.win || this.win.isDestroyed() || this.drag) return
    const pill = this.pillCentreFor(this.settings.position)
    if (animate && this.win.isVisible()) {
      // Already flying to the same place (the settings write at the end of a
      // drag lands here): let that animation finish instead of restarting it.
      if (
        this.motion?.mode === 'settle' &&
        Math.abs(this.motion.target.pill.x - pill.x) < 1 &&
        Math.abs(this.motion.target.pill.y - pill.y) < 1
      ) {
        return
      }
      this.settleTo(pill, this.settings.position.edge, this.displayFor(this.settings.position))
      return
    }
    this.stopMotion()
    const edge = this.settings.position.edge
    const display = this.displayFor(this.settings.position)
    const origin = this.windowOriginFor(pill, edge, display)
    this.win.setBounds({ ...origin, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT })
    this.appliedOrigin = origin
    this.emitDragState(false, edge, false, 0, this.paintOffset(this.restPaint(pill, edge, display)))
  }

  /**
   * Consumes one cursor sample from the renderer's pill drag. Returns the
   * position to persist once the gesture ends, otherwise null.
   */
  handleDrag(input: NotchDragInput): NotchPosition | null {
    if (!this.win || this.win.isDestroyed()) return null

    if (input.phase === 'start') {
      // Grabbing the pill mid-flight adopts its landing spot instead of
      // freezing a half-finished reshape, which would have nowhere valid to
      // draw the pill inside the window.
      if (this.motion) this.reposition(false)
      const edge = this.settings.position.edge
      const grab = this.axisOf(edge) === 'horizontal' ? input.grabX ?? 0 : input.grabY ?? 0
      this.drag = {
        grabAlong: clamp(grab, -PILL_LENGTH / 2, PILL_LENGTH / 2),
        edge,
        floating: false
      }
      // Freeze `paint` at what is on screen right now, not the plain per-edge
      // anchor: near the ends of the travel the resting pill is already drawn
      // off-centre, and starting from the anchor would jolt it on first frame.
      const resting = this.settings.position
      this.beginDragMotion(
        this.restPaint(this.pillCentreFor(resting), edge, this.displayFor(resting))
      )
    }

    const drag = this.drag
    if (!drag) return null

    // The anchor is where the pill's centre wants to be. Only the along-axis
    // grab offset is honoured; the cross-axis one is at most half a pill
    // thickness and keeping it would just fight the edge snap. The axis comes
    // from the edge picked last frame — this frame's cannot be known until the
    // anchor exists — and the exponential follow absorbs that frame of lag.
    const anchor: Point =
      this.axisOf(drag.edge) === 'horizontal'
        ? { x: input.screenX - drag.grabAlong, y: input.screenY }
        : { x: input.screenX, y: input.screenY - drag.grabAlong }
    const display = screen.getDisplayNearestPoint({
      x: roundCoord(anchor.x),
      y: roundCoord(anchor.y)
    })

    if (input.phase === 'end') {
      // Whatever was being previewed is what it lands on, so releasing never
      // moves the pill somewhere the gesture had not already shown.
      const landingEdge = drag.edge
      const position = this.positionFrom(
        this.attachedPillCentre(anchor, landingEdge, display, 0),
        landingEdge,
        display
      )
      this.drag = null
      this.settings = { ...this.settings, position }
      this.settleTo(this.pillCentreFor(position), landingEdge, display)
      return position
    }

    const previousEdge = drag.edge
    const { edge, distance } = this.nearestEdge(anchor, display, previousEdge)
    drag.edge = edge
    // Turning onto a perpendicular edge reshapes the pill, which needs room in
    // the window the frozen `paint` may not have left on that axis.
    if (this.axisOf(edge) !== this.axisOf(previousEdge)) this.turnPaintTo(edge)
    if (drag.floating ? distance <= REATTACH_DISTANCE : distance > DETACH_DISTANCE) {
      drag.floating = !drag.floating
    }
    // Continuous through the flip either way, so attaching and detaching never
    // pops the shape.
    const detach = clamp(distance / DETACH_DISTANCE, 0, 1)
    this.setDragTarget(
      drag.floating
        ? this.freePillCentre(anchor, edge, display)
        : this.attachedPillCentre(anchor, edge, display, detach),
      detach
    )
    return null
  }

  /**
   * Toggles click-through. Interactive means the panel is open (or a drag is in
   * flight) and the window should receive clicks and keystrokes.
   */
  setInteractive(interactive: boolean): void {
    if (!this.win || this.win.isDestroyed()) return
    if (this.interactive === interactive) return
    this.interactive = interactive

    if (interactive) {
      this.win.setIgnoreMouseEvents(false)
      this.startCursorWatch()
    } else {
      this.win.setIgnoreMouseEvents(true, { forward: true })
      // Keep polling while collapsed: Windows does not reliably forward
      // renderer hover events through a click-through native window.
      this.startCursorWatch()
    }
  }

  isInteractive(): boolean {
    return this.interactive === true
  }

  /**
   * Expands the panel briefly so a re-launch from the Start menu has visible
   * feedback. Nothing tears the peek down: once `peekUntil` lapses the cursor
   * watch collapses it on the next tick, exactly as a hover-out would.
   */
  peek(ms = 1500): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.showInactive()
    this.peekUntil = Date.now() + ms
    this.setInteractive(true)
    this.win.webContents.send('notch:force-expand')
  }

  /**
   * Polling is authoritative in both directions: it opens a collapsed
   * click-through pill and collapses an unfocused panel after the cursor leaves.
   */
  private startCursorWatch(): void {
    if (this.cursorTimer) return
    this.cursorTimer = setInterval(() => {
      if (!this.win || this.win.isDestroyed()) return this.stopCursorWatch()
      // Hover has no say while the notch is being dragged, is settling, or is
      // holding a peek open away from the cursor.
      if (this.drag || this.motion || Date.now() < this.peekUntil) return
      const point = screen.getCursorScreenPoint()
      const b = this.win.getBounds()
      if (!this.interactive) {
        const pill = this.collapsedPillBounds()
        const overPill =
          point.x >= pill.x &&
          point.x < pill.x + pill.width &&
          point.y >= pill.y &&
          point.y < pill.y + pill.height
        if (overPill) {
          // Make the transparent native surface interactive before asking the
          // renderer to animate. Switching it in the middle of the first CSS
          // frame causes a visible DWM hitch on Windows.
          this.setInteractive(true)
          this.win.webContents.send('notch:force-expand')
        }
        return
      }
      // A focused panel is being used deliberately (typing a prompt); leave it.
      if (this.win.isFocused()) return
      const inside =
        point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height
      if (!inside) this.win.webContents.send('notch:force-collapse')
    }, CURSOR_POLL_MS)
  }

  /**
   * Screen rect of the resting pill. Derived from the pill's centre rather than
   * from the window, because near the ends of the travel the pill is drawn
   * off-centre inside a window that has been held inside the display.
   */
  private collapsedPillBounds(): Electron.Rectangle {
    const edge = this.settings.position.edge
    const centre = this.pillCentreFor(this.settings.position)
    const horizontal = this.axisOf(edge) === 'horizontal'
    const width = horizontal ? PILL_LENGTH : PILL_THICKNESS
    const height = horizontal ? PILL_THICKNESS : PILL_LENGTH
    return {
      x: roundCoord(centre.x - width / 2),
      y: roundCoord(centre.y - height / 2),
      width,
      height
    }
  }

  private stopCursorWatch(): void {
    if (this.cursorTimer) clearInterval(this.cursorTimer)
    this.cursorTimer = null
  }

  private displayFor(position: NotchPosition): Electron.Display {
    const displays = screen.getAllDisplays()
    return (
      displays.find((display) => String(display.id) === position.displayId) ??
      screen.getPrimaryDisplay()
    )
  }

  private axisOf(edge: ScreenEdge): Axis {
    return edge === 'top' || edge === 'bottom' ? 'horizontal' : 'vertical'
  }

  /** Where the renderer draws the pill's centre inside the overlay, per edge. */
  private pillAnchor(edge: ScreenEdge): Point {
    const half = PILL_THICKNESS / 2
    switch (edge) {
      case 'top':
        return { x: OVERLAY_WIDTH / 2, y: half }
      case 'bottom':
        return { x: OVERLAY_WIDTH / 2, y: OVERLAY_HEIGHT - half }
      case 'left':
        return { x: half, y: OVERLAY_HEIGHT / 2 }
      default:
        return { x: OVERLAY_WIDTH - half, y: OVERLAY_HEIGHT / 2 }
    }
  }

  private originFor(pillCentre: Point, paint: Point): Point {
    return { x: roundCoord(pillCentre.x - paint.x), y: roundCoord(pillCentre.y - paint.y) }
  }

  /**
   * While in motion the renderer centres the pill in the window and shifts it by
   * this, rather than relying on the per-edge flex alignment: one number decides
   * the position on both sides of the process boundary.
   */
  private paintOffset(paint: Point): Point {
    return { x: paint.x - OVERLAY_WIDTH / 2, y: paint.y - OVERLAY_HEIGHT / 2 }
  }

  /**
   * The nearest `paint` that keeps a pill shaped for `edge` inside the overlay.
   * Turning swaps which axis needs half a length of room and which needs half a
   * thickness, and a `paint` frozen against the window's own edge has only the
   * latter — a pill turned end-on there would have half its length clipped off.
   * Clamping rather than re-anchoring keeps the correction as small as the turn
   * allows: a top-edge paint of (260, 16) becomes (260, 138), moving in y only.
   */
  private fitPaint(paint: Point, edge: ScreenEdge): Point {
    const horizontal = this.axisOf(edge) === 'horizontal'
    const marginX = horizontal ? PILL_LENGTH / 2 : PILL_THICKNESS / 2
    const marginY = horizontal ? PILL_THICKNESS / 2 : PILL_LENGTH / 2
    return {
      x: clamp(paint.x, marginX, OVERLAY_WIDTH - marginX),
      y: clamp(paint.y, marginY, OVERLAY_HEIGHT - marginY)
    }
  }

  /**
   * The band the pill's centre is confined to along its edge. It is sized by the
   * pill, not by the overlay: the pill slides until its own end meets the
   * display. Sizing it by the window used to cost most of the vertical range —
   * the overlay is 660 tall against a 1200 tall screen, which left the pill a
   * 540px band on the side edges versus 1400px on the top and bottom, so a side
   * drag spent most of its travel pinned against the clamp. Dragging, presets
   * and the resting position all share this, which keeps release from jumping.
   */
  private alongRange(
    edge: ScreenEdge,
    display: Electron.Display
  ): { lo: number; hi: number; travel: number } {
    const { bounds } = display
    const horizontal = this.axisOf(edge) === 'horizontal'
    const span = horizontal ? bounds.width : bounds.height
    const start = horizontal ? bounds.x : bounds.y
    const travel = Math.max(0, span - PILL_LENGTH)
    const lo = start + Math.min(PILL_LENGTH / 2, span / 2)
    return { lo, hi: lo + travel, travel }
  }

  /**
   * The window origin for a pill parked at `pillCentre`. The pill may now sit
   * closer to the ends of the display than half an overlay, so the window is
   * held inside the display along the edge axis and the pill is drawn off-centre
   * inside it instead. That is what keeps the expanded panel on-screen wherever
   * the pill is parked — the window never has to hang off the display for the
   * pill to reach the end of its travel.
   */
  private windowOriginFor(
    pillCentre: Point,
    edge: ScreenEdge,
    display: Electron.Display
  ): Point {
    const anchor = this.pillAnchor(edge)
    const { bounds } = display
    let x = pillCentre.x - anchor.x
    let y = pillCentre.y - anchor.y
    if (this.axisOf(edge) === 'horizontal') {
      x = clamp(x, bounds.x, Math.max(bounds.x, bounds.x + bounds.width - OVERLAY_WIDTH))
    } else {
      y = clamp(y, bounds.y, Math.max(bounds.y, bounds.y + bounds.height - OVERLAY_HEIGHT))
    }
    return { x: roundCoord(x), y: roundCoord(y) }
  }

  /**
   * Where the renderer must draw the pill inside the window for it to land on
   * `pillCentre` once the window has been held inside the display. At rest this
   * is what `paint` settles to; away from the ends it equals `pillAnchor`.
   */
  private restPaint(pillCentre: Point, edge: ScreenEdge, display: Electron.Display): Point {
    const origin = this.windowOriginFor(pillCentre, edge, display)
    return { x: pillCentre.x - origin.x, y: pillCentre.y - origin.y }
  }

  /** The screen point the pill's centre rests at for a persisted position. */
  private pillCentreFor(position: NotchPosition): Point {
    const display = this.displayFor(position)
    const { bounds } = display
    const { lo, travel } = this.alongRange(position.edge, display)
    const along = lo + travel * clamp(position.offset, 0, 1)
    const rest = PILL_THICKNESS / 2
    switch (position.edge) {
      case 'top':
        return { x: along, y: bounds.y + rest }
      case 'bottom':
        return { x: along, y: bounds.y + bounds.height - rest }
      case 'left':
        return { x: bounds.x + rest, y: along }
      default:
        return { x: bounds.x + bounds.width - rest, y: along }
    }
  }

  /** Inverse of `pillCentreFor`. */
  private positionFrom(
    pillCentre: Point,
    edge: ScreenEdge,
    display: Electron.Display
  ): NotchPosition {
    const { lo, travel } = this.alongRange(edge, display)
    const along = this.axisOf(edge) === 'horizontal' ? pillCentre.x : pillCentre.y
    return {
      displayId: String(display.id),
      edge,
      offset: travel > 0 ? clamp((along - lo) / travel, 0, 1) : 0
    }
  }

  /**
   * Nearest edge and how far the point sits inward of that edge's resting
   * footprint — anywhere on the resting pill itself counts as zero, so which
   * part of it was grabbed does not tilt the shape. `sticky` is the edge being
   * previewed right now; it is handed EDGE_STICKINESS of head start, which is
   * what stops the two edges of a corner from trading the pill back and forth.
   */
  private nearestEdge(
    point: Point,
    display: Electron.Display,
    sticky?: ScreenEdge
  ): { edge: ScreenEdge; distance: number } {
    const { bounds } = display
    const rest = PILL_THICKNESS
    const candidates = [
      { edge: 'top' as ScreenEdge, distance: point.y - bounds.y - rest },
      { edge: 'bottom' as ScreenEdge, distance: bounds.y + bounds.height - point.y - rest },
      { edge: 'left' as ScreenEdge, distance: point.x - bounds.x - rest },
      { edge: 'right' as ScreenEdge, distance: bounds.x + bounds.width - point.x - rest }
    ]
    const score = (entry: { edge: ScreenEdge; distance: number }): number =>
      entry.distance - (entry.edge === sticky ? EDGE_STICKINESS : 0)
    candidates.sort((a, b) => score(a) - score(b))
    return { edge: candidates[0].edge, distance: Math.max(0, candidates[0].distance) }
  }

  /**
   * Pill centre while attached: locked to the edge line, plus an elastic gap
   * that opens as the cursor pulls away, and magnetised to nearby presets.
   */
  private attachedPillCentre(
    anchor: Point,
    edge: ScreenEdge,
    display: Electron.Display,
    detach: number
  ): Point {
    const { bounds } = display
    const horizontal = this.axisOf(edge) === 'horizontal'
    const { lo, hi, travel } = this.alongRange(edge, display)
    let along = clamp(horizontal ? anchor.x : anchor.y, lo, hi)
    if (travel > 0) {
      const magnet = NOTCH_POSITION_PRESETS.filter((preset) => preset.edge === edge)
        .map((preset) => lo + travel * preset.offset)
        .find((presetAlong) => Math.abs(along - presetAlong) <= PRESET_SNAP_DISTANCE)
      if (magnet !== undefined) along = magnet
    }
    const lift = PILL_THICKNESS / 2 + RUBBER_BAND * detach * detach
    switch (edge) {
      case 'top':
        return { x: along, y: bounds.y + lift }
      case 'bottom':
        return { x: along, y: bounds.y + bounds.height - lift }
      case 'left':
        return { x: bounds.x + lift, y: along }
      default:
        return { x: bounds.x + bounds.width - lift, y: along }
    }
  }

  /** Pill centre while detached: under the cursor, but never off the display. */
  private freePillCentre(anchor: Point, edge: ScreenEdge, display: Electron.Display): Point {
    const { bounds } = display
    const { lo, hi } = this.alongRange(edge, display)
    const half = PILL_THICKNESS / 2
    if (this.axisOf(edge) === 'horizontal') {
      return {
        x: clamp(anchor.x, lo, hi),
        y: clamp(anchor.y, bounds.y + half, bounds.y + bounds.height - half)
      }
    }
    return {
      x: clamp(anchor.x, bounds.x + half, bounds.x + bounds.width - half),
      y: clamp(anchor.y, lo, hi)
    }
  }

  private beginDragMotion(paint: Point): void {
    const pill = this.motion?.pill ?? this.pillCentreFor(this.settings.position)
    const detach = this.motion?.detach ?? 0
    this.motion = {
      mode: 'drag',
      pill: { ...pill },
      paint: { ...paint },
      detach,
      target: { pill: { ...pill }, detach },
      from: { pill: { ...pill }, paint: { ...paint }, detach },
      paintTarget: { ...paint },
      startedAt: Date.now(),
      duration: 0
    }
    this.startMotion()
  }

  private setDragTarget(pill: Point, detach: number): void {
    if (!this.motion || this.motion.mode !== 'drag') return
    this.motion.target = { pill, detach }
    this.startMotion()
  }

  /**
   * Slews `paint` to somewhere the pill can be drawn end-on, over the same span
   * the renderer takes to reshape it. The settle's tween fields carry it: they
   * sit idle in drag mode, where `duration` is 0 and nothing reads them.
   */
  private turnPaintTo(edge: ScreenEdge): void {
    const motion = this.motion
    if (!motion || motion.mode !== 'drag') return
    const paintTarget = this.fitPaint(motion.paint, edge)
    if (paintTarget.x === motion.paint.x && paintTarget.y === motion.paint.y) return
    motion.from.paint = { ...motion.paint }
    motion.paintTarget = paintTarget
    motion.startedAt = Date.now()
    motion.duration = TURN_MS
    this.startMotion()
  }

  private settleTo(
    pill: Point,
    edge: ScreenEdge,
    display: Electron.Display,
    duration = SETTLE_MS
  ): void {
    // Lands on the drawn position the pill will hold at rest, which near the
    // ends of the travel is offset from the plain per-edge anchor.
    const paintTarget = this.restPaint(pill, edge, display)
    const current = this.motion
    const from = {
      pill: { ...(current?.pill ?? this.pillCentreFor(this.settings.position)) },
      paint: { ...(current?.paint ?? paintTarget) },
      detach: current?.detach ?? 0
    }
    this.motion = {
      mode: 'settle',
      pill: { ...from.pill },
      paint: { ...from.paint },
      detach: from.detach,
      target: { pill, detach: 0 },
      from,
      paintTarget,
      startedAt: Date.now(),
      duration
    }
    this.startMotion()
  }

  private startMotion(): void {
    if (this.frameTimer) return
    this.lastFrameAt = Date.now()
    this.frameTimer = setInterval(() => this.tick(), FRAME_MS)
  }

  private stopMotion(): void {
    if (this.frameTimer) clearInterval(this.frameTimer)
    this.frameTimer = null
    this.motion = null
  }

  private tick(): void {
    const motion = this.motion
    if (!this.win || this.win.isDestroyed() || !motion) {
      this.stopMotion()
      return
    }
    const now = Date.now()
    const dt = Math.max(1, now - this.lastFrameAt)
    this.lastFrameAt = now

    let finished = false
    if (motion.mode === 'drag') {
      // Frame-rate independent exponential follow: absorbs pointer jitter and
      // the integer window-move quantum without feeling laggy.
      const k = 1 - Math.exp(-dt / DRAG_TAU_MS)
      motion.pill.x += (motion.target.pill.x - motion.pill.x) * k
      motion.pill.y += (motion.target.pill.y - motion.pill.y) * k
      motion.detach += (motion.target.detach - motion.detach) * k
      // `paint` holds still for the whole hold apart from a turn, which arms
      // this the same way the settle rides its own eased progress.
      if (motion.duration > 0) {
        const progress = clamp((now - motion.startedAt) / motion.duration, 0, 1)
        const eased = 1 - Math.pow(1 - progress, 3)
        motion.paint.x = motion.from.paint.x + (motion.paintTarget.x - motion.from.paint.x) * eased
        motion.paint.y = motion.from.paint.y + (motion.paintTarget.y - motion.from.paint.y) * eased
        if (progress >= 1) motion.duration = 0
      }
    } else {
      const progress =
        motion.duration <= 0 ? 1 : clamp((now - motion.startedAt) / motion.duration, 0, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      motion.pill.x = motion.from.pill.x + (motion.target.pill.x - motion.from.pill.x) * eased
      motion.pill.y = motion.from.pill.y + (motion.target.pill.y - motion.from.pill.y) * eased
      // Reshaping rides the same curve as the flight, so the pill's drawn
      // position moves by a fraction of what it is already travelling.
      motion.paint.x = motion.from.paint.x + (motion.paintTarget.x - motion.from.paint.x) * eased
      motion.paint.y = motion.from.paint.y + (motion.paintTarget.y - motion.from.paint.y) * eased
      // Flatten slightly ahead of arrival so the corners are square by the
      // time the pill touches the edge.
      motion.detach = motion.from.detach * (1 - Math.min(1, eased * 1.3))
      finished = progress >= 1
    }

    const edge = this.drag?.edge ?? this.settings.position.edge
    const origin = this.originFor(motion.pill, motion.paint)
    // Every geometry helper here runs through `clamp`, which passes NaN straight
    // through, so a single bad sample would otherwise reach `setPosition` — and
    // that throws, ~83 times a second, taking the main process down with it.
    // Abandon the gesture and fall back to the last persisted position instead.
    if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y)) {
      console.warn('[notch] discarding motion with non-finite origin', origin)
      this.stopMotion()
      this.drag = null
      this.reposition(false)
      return
    }
    if (
      !this.appliedOrigin ||
      this.appliedOrigin.x !== origin.x ||
      this.appliedOrigin.y !== origin.y
    ) {
      this.win.setPosition(origin.x, origin.y)
      this.appliedOrigin = origin
    }
    // The offset stays live after the gesture: at rest the pill is placed from
    // it too, so zeroing it on the last frame would snap the pill to the window
    // centre line. `paint` has already reached its resting value by then.
    this.emitDragState(
      !finished,
      edge,
      this.drag?.floating ?? false,
      finished ? 0 : motion.detach,
      this.paintOffset(motion.paint)
    )

    if (finished) this.stopMotion()
  }

  /**
   * Streams shape state to the renderer. `offset` and `edge` must be applied in
   * the same paint, which is why they travel in one message.
   */
  private emitDragState(
    active: boolean,
    edge: ScreenEdge,
    floating: boolean,
    detach: number,
    offset: Point
  ): void {
    if (!this.win || this.win.isDestroyed()) return
    const next: NotchDragState = {
      active,
      edge,
      floating,
      detach: Math.round(detach * 1000) / 1000,
      offsetX: Math.round(offset.x * 10) / 10,
      offsetY: Math.round(offset.y * 10) / 10
    }
    const previous = this.sentDragState
    if (
      previous &&
      previous.active === next.active &&
      previous.edge === next.edge &&
      previous.floating === next.floating &&
      previous.offsetX === next.offsetX &&
      previous.offsetY === next.offsetY &&
      Math.abs(previous.detach - next.detach) < 0.004
    ) {
      return
    }
    this.sentDragState = next
    this.win.webContents.send('notch:dragState', next)
  }

  /**
   * The last state streamed to the renderer, or the resting state if none has
   * been sent yet. A renderer subscribes from an effect that runs after the page
   * has loaded, so the message sent while it was still parsing is gone by then —
   * and since the resting offset is what places the pill, it has to be able to
   * ask rather than wait for the next gesture to redraw it.
   */
  getDragState(): NotchDragState {
    if (this.sentDragState) return this.sentDragState
    const position = this.settings.position
    const pill = this.pillCentreFor(position)
    const paint = this.restPaint(pill, position.edge, this.displayFor(position))
    const offset = this.paintOffset(paint)
    return {
      active: false,
      edge: position.edge,
      floating: false,
      detach: 0,
      offsetX: Math.round(offset.x * 10) / 10,
      offsetY: Math.round(offset.y * 10) / 10
    }
  }

  send(channel: string, payload: unknown): void {
    if (!this.win || this.win.isDestroyed()) return
    this.win.webContents.send(channel, payload)
  }
}
