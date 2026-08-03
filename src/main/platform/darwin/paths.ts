import path from 'node:path'
import type { PathIntegration } from '../types'

export const paths: PathIntegration = {
  normalizeProjectPath(raw) {
    return path.posix.normalize(raw).replace(/\/+$/, '') || raw
  },

  /**
   * No lowercasing. APFS is case-insensitive by default but case-*preserving*,
   * and a case-folded key would collapse two genuinely different paths on a
   * case-sensitive volume. Showing one duplicate is better than hiding a project.
   */
  projectPathKey(normalized) {
    return normalized
  },

  isRevealable(target) {
    return path.isAbsolute(target)
  }
}
