import path from 'node:path'
import type { PathIntegration } from '../types'

export const paths: PathIntegration = {
  /** Claude records project paths in both slash conventions; settle on one. */
  normalizeProjectPath(raw) {
    return path.win32.normalize(raw.replace(/\//g, '\\')).replace(/[\\/]+$/, '')
  },

  /** Windows paths are case-insensitive, so the dedupe key must be too. */
  projectPathKey(normalized) {
    return normalized.toLowerCase()
  },

  isRevealable(target) {
    // A UNC path would make Explorer reach out to an SMB host and hand over the
    // user's credentials on the way. Only local absolute paths get revealed.
    if (target.startsWith('\\\\') || target.startsWith('//')) return false
    return path.isAbsolute(target)
  }
}
