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
    // `//host/share` is a perfectly *absolute* POSIX path, so an isAbsolute check
    // alone lets a network location through. macOS does not auto-mount from one
    // the way Windows does from a UNC path, so this is not the same
    // credential-leak vector — but no real project directory starts with `//`,
    // and keeping the rule identical on both platforms is worth more than the
    // nothing it costs.
    if (target.startsWith('//') || target.startsWith('\\\\')) return false
    return path.isAbsolute(target)
  }
}
