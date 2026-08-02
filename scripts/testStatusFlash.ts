import assert from 'node:assert/strict'
import type {
  AgentStatus,
  PendingInteraction,
  SessionState
} from '../src/shared/types'
import {
  buildEffectiveStatuses,
  flashColor,
  selectStatusFlash,
  StatusFlashTracker
} from '../src/renderer/statusFlash'

function session(
  sessionId: string,
  status: AgentStatus,
  needsInput = false
): SessionState {
  return {
    key: `codex:${sessionId}`,
    agent: 'codex',
    sessionId,
    cwd: 'C:\\test',
    name: sessionId,
    kind: 'interactive',
    status,
    startedAt: 1,
    updatedAt: 1,
    needsInput,
    canTerminate: false,
    canFocus: true
  }
}

function interaction(sessionId: string): PendingInteraction {
  return {
    id: `interaction:${sessionId}`,
    agent: 'codex',
    sessionId,
    cwd: 'C:\\test',
    transport: 'codex-rollout',
    answerable: false,
    receivedAt: 1,
    kind: 'questions',
    questions: []
  }
}

const tracker = new StatusFlashTracker()

assert.equal(tracker.update([session('primary', 'idle')], []), null)
assert.equal(tracker.update([session('primary', 'idle')], []), null)
assert.equal(tracker.update([session('primary', 'busy')], []), 'working')
assert.equal(tracker.update([session('primary', 'needs-input', true)], []), 'needs-input')
assert.equal(tracker.update([session('primary', 'reviewing')], []), 'reviewing')
assert.equal(tracker.update([session('primary', 'idle')], []), 'idle')
assert.equal(
  tracker.update(
    [session('primary', 'idle'), session('new-agent', 'busy')],
    []
  ),
  'working'
)
assert.equal(tracker.update([session('primary', 'idle')], []), null)
assert.equal(
  tracker.update([session('primary', 'idle'), session('unknown', 'unknown')], []),
  null
)
assert.equal(
  tracker.update([session('primary', 'idle')], [interaction('primary')]),
  'needs-input'
)
assert.equal(
  tracker.update([session('primary', 'idle')], [interaction('primary')]),
  null
)
assert.equal(tracker.update([session('primary', 'idle')], []), 'idle')

const previous = buildEffectiveStatuses(
  [session('idle-to-work', 'idle'), session('work-to-idle', 'busy')],
  []
)
const simultaneous = buildEffectiveStatuses(
  [
    session('idle-to-work', 'busy'),
    session('work-to-idle', 'idle'),
    session('new-review', 'reviewing')
  ],
  [interaction('new-input')]
)
assert.equal(selectStatusFlash(previous, simultaneous), 'needs-input')
assert.equal(flashColor('idle'), 'green')
assert.equal(flashColor('working'), 'yellow')
assert.equal(flashColor('needs-input'), 'red')
assert.equal(flashColor('reviewing'), 'blue')

console.log('Status flash tests passed.')
