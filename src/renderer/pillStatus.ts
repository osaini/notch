import type { SessionCounts } from '@shared/types'

/** One concise state, in the priority order the collapsed rail promises. */
export function priorityPillLabel(counts: SessionCounts, interactionCount: number): string {
  if (interactionCount > 0 || counts.needsInput > 0) return 'Needs you'
  if (counts.reviewing > 0) return 'Reviewing'
  if (counts.busy > 0) return 'Working'
  if (counts.total === 0 || counts.idle > 0) return 'Idle'
  return 'Unknown'
}
