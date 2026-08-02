import assert from 'node:assert/strict';
import test from 'node:test';

import { orderFixes, selectFixes, toFixTask } from '../lib/fix.mjs';

function promotedEntry(overrides = {}) {
  return {
    candidateId: 'a'.repeat(64),
    shortId: 'a'.repeat(12),
    title: 'Session watcher never clears its debounce timer',
    severity: 'P2',
    file: 'src/main/sessionWatcher.ts',
    symbol: 'startWatching',
    lineStart: 40,
    lineEnd: 62,
    failurePath: 'startWatching reassigns this.timer without clearTimeout',
    observableImpact: 'The watcher keeps firing after stopWatching resolves',
    preconditions: ['Two changes inside the debounce window'],
    suggestedTest: 'Call startWatching twice',
    evidenceByProvider: { claude: ['src/main/sessionWatcher.ts:44'] },
    status: 'verified',
    tiebroken: false,
    comparison: null,
    ...overrides
  };
}

test('only findings both tracks confirmed are eligible to fix', () => {
  const promoted = [
    promotedEntry({ candidateId: '1'.repeat(64), status: 'verified' }),
    promotedEntry({ candidateId: '2'.repeat(64), status: 'probable' }),
    promotedEntry({ candidateId: '3'.repeat(64), status: 'disputed' }),
    promotedEntry({ candidateId: '4'.repeat(64), status: 'needs_reproduction' }),
    promotedEntry({ candidateId: '5'.repeat(64), status: 'rejected' })
  ];

  const { selected } = selectFixes({ promoted });
  assert.deepEqual(selected.map((entry) => entry.candidateId), ['1'.repeat(64)]);
});

test('a tiebroken finding is excluded unless explicitly asked for', () => {
  const promoted = [
    promotedEntry({ candidateId: '1'.repeat(64), status: 'verified' }),
    promotedEntry({ candidateId: '2'.repeat(64), status: 'probable', tiebroken: true })
  ];

  assert.equal(selectFixes({ promoted }).selected.length, 1, 'two models contradicting each other is not a fix premise');
  assert.equal(selectFixes({ promoted, includeTiebroken: true }).selected.length, 2);
});

test('the batch is capped and ordered by severity, and reports what it dropped', () => {
  const promoted = [
    promotedEntry({ candidateId: '1'.repeat(64), severity: 'P3' }),
    promotedEntry({ candidateId: '2'.repeat(64), severity: 'P0' }),
    promotedEntry({ candidateId: '3'.repeat(64), severity: 'P2' }),
    promotedEntry({ candidateId: '4'.repeat(64), severity: 'P1' })
  ];

  const { selected, eligibleCount } = selectFixes({ promoted, maxFixes: 2 });
  assert.equal(eligibleCount, 4, 'the cap must not hide how many were eligible');
  assert.deepEqual(selected.map((entry) => entry.severity), ['P0', 'P1']);
});

test('the planner decides the order', () => {
  const selected = [
    promotedEntry({ candidateId: '1'.repeat(64), severity: 'P0' }),
    promotedEntry({ candidateId: '2'.repeat(64), severity: 'P1' }),
    promotedEntry({ candidateId: '3'.repeat(64), severity: 'P2' })
  ];

  const { ordered, planned, unplanned } = orderFixes(selected, {
    fixes: [
      { candidate_id: '3'.repeat(64), order: 1, rationale: 'shared helper', interacts_with: [] },
      { candidate_id: '1'.repeat(64), order: 2, rationale: 'depends on the helper', interacts_with: [] },
      { candidate_id: '2'.repeat(64), order: 3, rationale: 'isolated', interacts_with: [] }
    ]
  });

  assert.deepEqual(ordered.map((entry) => entry.candidateId), ['3'.repeat(64), '1'.repeat(64), '2'.repeat(64)]);
  assert.equal(planned, 3);
  assert.equal(unplanned, 0);
});

test('a malformed plan never drops a fix from the batch', () => {
  const selected = [
    promotedEntry({ candidateId: '1'.repeat(64), severity: 'P0' }),
    promotedEntry({ candidateId: '2'.repeat(64), severity: 'P1' }),
    promotedEntry({ candidateId: '3'.repeat(64), severity: 'P2' })
  ];

  // Omits one fix, duplicates another, invents a third, and returns a bad order.
  const { ordered, planned, unplanned } = orderFixes(selected, {
    fixes: [
      { candidate_id: '2'.repeat(64), order: 1 },
      { candidate_id: '2'.repeat(64), order: 9 },
      { candidate_id: 'f'.repeat(64), order: 2 },
      { candidate_id: '1'.repeat(64), order: 'first' }
    ]
  });

  assert.equal(ordered.length, 3, 'every selected fix must survive a malformed plan');
  assert.deepEqual(new Set(ordered.map((entry) => entry.candidateId)).size, 3);
  assert.equal(ordered[0].candidateId, '2'.repeat(64), 'the one valid instruction is still honoured');
  assert.equal(planned, 1);
  assert.equal(unplanned, 2);
  // Everything the planner did not place keeps the incoming severity ranking.
  assert.deepEqual(ordered.slice(1).map((entry) => entry.severity), ['P0', 'P2']);
});

test('an empty or absent plan falls back to the severity ranking', () => {
  const selected = [
    promotedEntry({ candidateId: '1'.repeat(64), severity: 'P0' }),
    promotedEntry({ candidateId: '2'.repeat(64), severity: 'P1' })
  ];

  for (const plan of [null, undefined, {}, { fixes: [] }]) {
    const { ordered } = orderFixes(selected, plan);
    assert.deepEqual(ordered.map((entry) => entry.severity), ['P0', 'P1']);
  }
});

test('the fix task carries both verifiers reasoning and forbids unrelated work', () => {
  const task = toFixTask(
    promotedEntry({
      comparison: {
        foundBy: ['A', 'B'],
        verdicts: {
          A: { challenger: 'codex', verdict: 'confirmed', rationale: 'no clearTimeout on the reassignment path' },
          B: { challenger: 'claude', verdict: 'confirmed', rationale: 'the second call overwrites the handle' }
        }
      }
    })
  );

  assert.ok(task.includes('no clearTimeout on the reassignment path'));
  assert.ok(task.includes('the second call overwrites the handle'));
  assert.ok(task.includes('src/main/sessionWatcher.ts:40-62'));
  assert.match(task, /do not fix other findings in the same file/i);
});
