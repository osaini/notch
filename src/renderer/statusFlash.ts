import type {
  AgentKind,
  PendingInteraction,
  SessionState
} from '@shared/types'

export type FlashStatus = 'idle' | 'working' | 'needs-input' | 'reviewing'
export type FlashColor = 'green' | 'yellow' | 'red' | 'blue'

const FLASH_PRIORITY: FlashStatus[] = [
  'needs-input',
  'reviewing',
  'working',
  'idle'
]

function agentIdentity(agent: AgentKind, sessionId: string): string {
  return `${agent}:${sessionId}`
}

function sessionFlashStatus(session: SessionState): FlashStatus | null {
  if (session.needsInput || session.status === 'needs-input') return 'needs-input'
  if (session.status === 'reviewing') return 'reviewing'
  if (session.status === 'busy') return 'working'
  if (session.status === 'idle') return 'idle'
  return null
}

export function buildEffectiveStatuses(
  sessions: readonly SessionState[],
  interactions: readonly PendingInteraction[]
): Map<string, FlashStatus> {
  const statuses = new Map<string, FlashStatus>()
  for (const session of sessions) {
    const status = sessionFlashStatus(session)
    if (status) statuses.set(agentIdentity(session.agent, session.sessionId), status)
  }
  for (const interaction of interactions) {
    if (interaction.sessionId) {
      statuses.set(
        agentIdentity(interaction.agent, interaction.sessionId),
        'needs-input'
      )
    }
  }
  return statuses
}

export function selectStatusFlash(
  previous: ReadonlyMap<string, FlashStatus>,
  current: ReadonlyMap<string, FlashStatus>
): FlashStatus | null {
  const changed = new Set<FlashStatus>()
  for (const [identity, status] of current) {
    if (previous.get(identity) !== status) changed.add(status)
  }
  return FLASH_PRIORITY.find((status) => changed.has(status)) ?? null
}

export function flashColor(status: FlashStatus): FlashColor {
  if (status === 'needs-input') return 'red'
  if (status === 'reviewing') return 'blue'
  if (status === 'working') return 'yellow'
  return 'green'
}

/**
 * Holds the last effective status set. The first complete update is a silent
 * hydration baseline; every later update advances the baseline even when the
 * UI chooses not to show the returned flash (for example while expanded).
 */
export class StatusFlashTracker {
  private previous = new Map<string, FlashStatus>()
  private hydrated = false

  update(
    sessions: readonly SessionState[],
    interactions: readonly PendingInteraction[]
  ): FlashStatus | null {
    const current = buildEffectiveStatuses(sessions, interactions)
    if (!this.hydrated) {
      this.previous = current
      this.hydrated = true
      return null
    }
    const flash = selectStatusFlash(this.previous, current)
    this.previous = current
    return flash
  }
}
