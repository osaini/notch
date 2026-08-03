/**
 * Covers the pure geometry behind the pill drag: which edge a cursor position
 * previews, and where the pill may be drawn inside the overlay once it has
 * turned. Both are numeric thresholds that are painful to judge by eye mid-drag
 * — a corner that hands the pill back and forth reads as a glitch rather than
 * as an off-by-a-few-pixels — so they are pinned here instead.
 */
import assert from 'node:assert/strict'
import type { ScreenEdge } from '../src/shared/types'
import { NotchWindow, OVERLAY_HEIGHT, OVERLAY_WIDTH } from '../src/main/windows'
import { win32Platform } from '../src/main/platform/win32'

interface Point {
  x: number
  y: number
}

/** The private geometry surface under test. */
interface Geometry {
  nearestEdge(
    point: Point,
    display: { bounds: { x: number; y: number; width: number; height: number } },
    sticky?: ScreenEdge
  ): { edge: ScreenEdge; distance: number }
  fitPaint(paint: Point, edge: ScreenEdge): Point
}

/**
 * The overlay integration is injected rather than taken from the host platform,
 * for two reasons: the numbers below are the *Windows* thresholds and should stay
 * asserted on a macOS runner, and the fake display carries only `bounds`, so a
 * platform reading `workArea` would silently produce NaN geometry instead of a
 * failed assertion.
 */
const geometry = new NotchWindow(win32Platform.overlay) as unknown as Geometry
const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }

const PILL_THICKNESS = 32
const PILL_LENGTH = 276
const DETACH_DISTANCE = 100

function edgeAt(point: Point, sticky?: ScreenEdge): ScreenEdge {
  return geometry.nearestEdge(point, display, sticky).edge
}

// --- Reaching a side edge from the top one --------------------------------
// The point of the change: carrying the pill toward the left or right edge has
// to hand it over, or that edge can never catch it the way top and bottom do.

assert.equal(edgeAt({ x: 960, y: 40 }, 'top'), 'top', 'resting near the top stays on top')
assert.equal(
  edgeAt({ x: 1880, y: 200 }, 'top'),
  'right',
  'carried down the right-hand side, the right edge takes over from the top'
)
assert.equal(
  edgeAt({ x: 40, y: 200 }, 'top'),
  'left',
  'and symmetrically on the left'
)
assert.equal(
  edgeAt({ x: 960, y: 1040 }, 'top'),
  'bottom',
  'the far edge of the same axis still wins outright'
)

// --- Corners do not flap ---------------------------------------------------
// Both edges of a corner are a hair away, so without the stickiness bonus the
// pill trades shapes every frame. Sliding along the top into one must not turn.

assert.equal(
  edgeAt({ x: 1900, y: 20 }, 'top'),
  'top',
  'sliding along the top into the top-right corner keeps the top'
)
assert.equal(
  edgeAt({ x: 20, y: 1060 }, 'bottom'),
  'bottom',
  'and along the bottom into the bottom-left corner keeps the bottom'
)
assert.equal(
  edgeAt({ x: 1900, y: 20 }, 'right'),
  'right',
  'the same corner keeps the right edge once the right edge has it'
)
assert.equal(
  edgeAt({ x: 20, y: 1060 }, 'left'),
  'left',
  'hysteresis holds on the other diagonal too'
)

// The handover is one-way at any given point: whichever edge holds it, keeps
// it. That is exactly what stops a cursor parked on the boundary from flapping.
const flapping: string[] = []
for (let y = 0; y <= 200; y += 4) {
  const held = edgeAt({ x: 1890, y }, 'top')
  if (held === 'right' && edgeAt({ x: 1890, y }, 'right') === 'top') {
    flapping.push(`y=${y}`)
  }
}
assert.deepEqual(flapping, [], 'no cursor position hands the pill back and forth')

// --- Distance is measured off the resting footprint ------------------------
// `detach` is derived from this, so the elastic pull and the release into
// mid-air both hang off these numbers.

assert.equal(
  geometry.nearestEdge({ x: 1920 - PILL_THICKNESS, y: 540 }, display, 'right').distance,
  0,
  'a pill sitting on its resting line has no detach'
)
assert.equal(
  geometry.nearestEdge({ x: 1920 - PILL_THICKNESS - 60, y: 540 }, display, 'right').distance,
  60,
  'pulling inward off a side edge measures the same as off a top one'
)
assert.equal(
  geometry.nearestEdge({ x: 60, y: 540 }, display, 'left').distance,
  60 - PILL_THICKNESS,
  'the left edge measures inward from its own footprint'
)
assert.ok(
  geometry.nearestEdge({ x: 1920 - PILL_THICKNESS - DETACH_DISTANCE - 1, y: 540 }, display, 'right')
    .distance > DETACH_DISTANCE,
  'past the detach distance a side edge lets go, as a top one does'
)

// --- The pill fits inside the overlay after a turn -------------------------
// A turned pill needs half its length of window on the axis that only had half
// a thickness, or the window clips it.

const halfAlong = PILL_LENGTH / 2
const halfCross = PILL_THICKNESS / 2

function assertFits(paint: Point, edge: ScreenEdge): void {
  const horizontal = edge === 'top' || edge === 'bottom'
  const marginX = horizontal ? halfAlong : halfCross
  const marginY = horizontal ? halfCross : halfAlong
  assert.ok(
    paint.x - marginX >= -0.0001 && paint.x + marginX <= OVERLAY_WIDTH + 0.0001,
    `paint ${paint.x} leaves the pill hanging out of the window on x for ${edge}`
  )
  assert.ok(
    paint.y - marginY >= -0.0001 && paint.y + marginY <= OVERLAY_HEIGHT + 0.0001,
    `paint ${paint.y} leaves the pill hanging out of the window on y for ${edge}`
  )
}

// The value frozen when a top-edge pill is grabbed sits half a thickness from
// the window's top; turning it end-on there would clip half its length away.
const fromTop = { x: 260, y: halfCross }
const turned = geometry.fitPaint(fromTop, 'left')
assert.deepEqual(turned, { x: 260, y: halfAlong }, 'a turn corrects only the axis that needs it')
assertFits(turned, 'left')

assertFits(geometry.fitPaint({ x: 260, y: OVERLAY_HEIGHT - halfCross }, 'right'), 'right')
assertFits(geometry.fitPaint({ x: halfCross, y: 330 }, 'top'), 'top')
assertFits(geometry.fitPaint({ x: OVERLAY_WIDTH - halfCross, y: 330 }, 'bottom'), 'bottom')

// Every paint the resting pill can hold is already valid for its own edge, so
// picking one up never jolts it.
for (const edge of ['top', 'bottom', 'left', 'right'] as ScreenEdge[]) {
  const horizontal = edge === 'top' || edge === 'bottom'
  for (const along of [halfAlong, 260, OVERLAY_WIDTH - halfAlong]) {
    const paint = horizontal ? { x: along, y: halfCross } : { x: halfCross, y: along }
    if (!horizontal && along > OVERLAY_HEIGHT - halfAlong) continue
    assert.deepEqual(
      geometry.fitPaint(paint, edge),
      paint,
      `a resting ${edge} paint should already fit`
    )
  }
}

console.log('pill geometry: all assertions passed')
