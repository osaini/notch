/**
 * Helpers shared by every session source.
 *
 * These live outside `sessionWatcher` only to break an import cycle: the watcher
 * consumes `coworkSessions`, and `coworkSessions` needs both of these. The
 * watcher re-exports them, so existing import sites are unaffected.
 */

/**
 * A PID is live if signalling it does not throw ESRCH. EPERM still proves that
 * the process exists, even if it belongs to an elevated/foreign user.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') return ''
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact || compact.startsWith('<') || compact.startsWith('[')) return ''
  return compact.length > 120 ? `${compact.slice(0, 117)}…` : compact
}
