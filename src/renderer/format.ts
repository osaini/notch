/** Small display helpers shared by the tabs. */

export function compactTokens(n: number): string {
  const units = ['', 'K', 'M', 'B']
  let value = n
  let unit = 0
  while (Math.abs(value) >= 1_000 && unit < units.length - 1) {
    value /= 1_000
    unit++
  }
  let rounded = Number(value.toFixed(1))
  if (Math.abs(rounded) >= 1_000 && unit < units.length - 1) {
    rounded /= 1_000
    unit++
  }
  if (unit > 0) return `${rounded.toFixed(1)}${units[unit]}`
  return `${n}`
}

export function groupedNumber(n: number): string {
  return n.toLocaleString('en-US')
}

export function relativeTime(ts: number | null): string {
  if (!ts) return '—'
  const delta = Date.now() - ts
  if (delta < 0) return 'just now'
  const seconds = Math.floor(delta / 1000)
  if (seconds < 45) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function durationUntil(ts: number | null): string {
  if (ts === null) return '—'
  const delta = ts - Date.now()
  if (delta <= 0) return 'now'
  const minutes = Math.floor(delta / 60_000)
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

export function hourLabel(hour: number | null): string {
  if (hour === null) return '—'
  const suffix = hour < 12 ? 'am' : 'pm'
  const h = hour % 12 === 0 ? 12 : hour % 12
  return `${h}${suffix}`
}

/** Trims a long absolute path to its last two segments. */
export function shortPath(p: string): string {
  if (!p) return ''
  const parts = p.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return p
  const separator = p.includes('\\') && !p.includes('/') ? '\\' : '/'
  return `…${separator}${parts.slice(-2).join(separator)}`
}

export function modelLabel(model: string | null): string {
  if (!model) return '—'
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}
