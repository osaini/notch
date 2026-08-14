import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

/** The quiet zone the spec requires. Scanners fail without it. */
const MARGIN = 4

interface Props {
  /** Text to encode. Usually a companion URL with the pairing code attached. */
  value: string
  /** Rendered edge length in CSS pixels, quiet zone included. */
  size?: number
}

/**
 * A QR code drawn as a single SVG path.
 *
 * One <rect> per dark module puts roughly a thousand nodes in the DOM and makes
 * re-encoding on every endpoint change visibly janky. Emitting one "move then
 * draw a 1x1 box" pair per module into a single path keeps it to one node.
 *
 * `currentColor` for the modules and a transparent background let the code
 * follow the app theme instead of forcing a white card into a dark panel —
 * scanners only need contrast, not specifically black on white.
 */
export function QrCode({ value, size = 168 }: Props): React.JSX.Element | null {
  const path = useMemo(() => {
    if (!value) return null
    try {
      // Type 0 picks the smallest version that fits. 'M' tolerates ~15% damage,
      // which is the usual balance for a code read off a screen at arm's length.
      const qr = qrcode(0, 'M')
      qr.addData(value)
      qr.make()
      const count = qr.getModuleCount()
      const parts: string[] = []
      for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
          if (qr.isDark(row, col)) parts.push(`M${col + MARGIN} ${row + MARGIN}h1v1h-1z`)
        }
      }
      return { d: parts.join(''), extent: count + MARGIN * 2 }
    } catch {
      // Only reachable if the value exceeds QR capacity, which a LAN URL cannot.
      return null
    }
  }, [value])

  if (!path) return null

  return (
    <svg
      className="qr-code"
      width={size}
      height={size}
      viewBox={`0 0 ${path.extent} ${path.extent}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={`QR code for ${value}`}
    >
      <path d={path.d} fill="currentColor" />
    </svg>
  )
}
