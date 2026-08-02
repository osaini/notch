import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { AGREEMENTS, applyTiebreaks, classifyAgreement, compareTracks, disputedComparisons, summarizeComparisons } from '../lib/compare.mjs';
import { assignTiebreaker, buildTiebreakJobs, toAnonymousAssessments } from '../lib/tiebreak.mjs';
import { ORCHESTRATOR_DIR } from '../lib/config.mjs';
import { loadContext } from '../lib/pipeline.mjs';
import { makeCandidate } from './fixtures/factories.mjs';

const COMMIT = 'f177f4d7278bcce2eeb0b3e480d11fe88ec24eb2';
// The bundled example, so these tests do not depend on whatever the host
// repository happens to have configured.
const context = await loadContext(process.cwd(), path.join(ORCHESTRATOR_DIR, 'manifest.example.json'));

function verdict(overrides = {}) {
  return {
    candidateId: 'a'.repeat(64),
    verdict: 'confirmed',
    challenger: 'codex',
    track: 'A',
    rationale: 'no clearTimeout on the reassignment path',
    supportingEvidence: ['src/main/sessionWatcher.ts:44'],
    invalidatingEvidence: [],
    confidence: 0.9,
    ...overrides
  };
}

test('agreement covers every combination of two verdicts and is strict about disputes', () => {
  const confirmed = verdict();
  const rejected = verdict({ verdict: 'rejected' });
  const unsure = verdict({ verdict: 'needs_reproduction' });

  assert.equal(classifyAgreement({ A: confirmed, B: confirmed }), 'both-confirmed');
  assert.equal(classifyAgreement({ A: rejected, B: rejected }), 'both-rejected');
  assert.equal(classifyAgreement({ A: confirmed, B: rejected }), 'disputed');
  assert.equal(classifyAgreement({ A: rejected, B: confirmed }), 'disputed');
  assert.equal(classifyAgreement({ A: confirmed, B: null }), 'single-confirmed');
  assert.equal(classifyAgreement({ A: rejected, B: null }), 'single-rejected');
  assert.equal(classifyAgreement({ A: null, B: null }), 'unresolved');
  assert.equal(classifyAgreement({}), 'unresolved');

  // A confirmed/needs_reproduction split is not a contradiction about the code,
  // so it must not be treated as a dispute and must not buy a tiebreak job.
  assert.equal(classifyAgreement({ A: confirmed, B: unsure }), 'unresolved');
  assert.equal(classifyAgreement({ A: rejected, B: unsure }), 'unresolved');
  assert.equal(classifyAgreement({ A: unsure, B: null }), 'unresolved');

  for (const agreement of [
    classifyAgreement({ A: confirmed, B: confirmed }),
    classifyAgreement({ A: confirmed, B: rejected }),
    classifyAgreement({ A: unsure, B: null })
  ]) {
    assert.ok(AGREEMENTS.includes(agreement));
  }
});

test('tracks are joined on the content-derived candidate id', () => {
  const shared = makeCandidate({ candidateId: 'a'.repeat(64), providers: ['claude', 'codex'] });
  const claudeOnly = makeCandidate({ candidateId: 'b'.repeat(64), shortId: 'b'.repeat(12), providers: ['claude'] });
  const codexOnly = makeCandidate({ candidateId: 'c'.repeat(64), shortId: 'c'.repeat(12), providers: ['codex'] });

  const comparisons = compareTracks({
    candidates: [shared, claudeOnly, codexOnly],
    verdicts: [
      verdict({ candidateId: shared.candidateId, track: 'A', challenger: 'codex' }),
      verdict({ candidateId: shared.candidateId, track: 'B', challenger: 'claude', verdict: 'rejected' }),
      verdict({ candidateId: claudeOnly.candidateId, track: 'A', challenger: 'codex' }),
      verdict({ candidateId: codexOnly.candidateId, track: 'B', challenger: 'claude', verdict: 'rejected' })
    ]
  });

  const byId = new Map(comparisons.map((entry) => [entry.candidateId, entry]));
  assert.deepEqual(byId.get(shared.candidateId).foundBy, ['A', 'B']);
  assert.equal(byId.get(shared.candidateId).agreement, 'disputed');
  assert.deepEqual(byId.get(claudeOnly.candidateId).foundBy, ['A']);
  assert.equal(byId.get(claudeOnly.candidateId).agreement, 'single-confirmed');
  assert.equal(byId.get(claudeOnly.candidateId).verdicts.B, null);
  assert.deepEqual(byId.get(codexOnly.candidateId).foundBy, ['B']);
  assert.equal(byId.get(codexOnly.candidateId).agreement, 'single-rejected');

  const summary = summarizeComparisons(comparisons);
  assert.equal(summary.bothTracks, 1);
  assert.equal(summary.trackAOnly, 1);
  assert.equal(summary.trackBOnly, 1);
  assert.equal(summary.counts.disputed, 1);
  assert.equal(summary.total, 3);

  assert.deepEqual(
    disputedComparisons(comparisons).map((entry) => entry.candidateId),
    [shared.candidateId]
  );
});

test('a tiebreak attaches only to the comparison it resolves', () => {
  const comparisons = compareTracks({
    candidates: [makeCandidate({ providers: ['claude', 'codex'] })],
    verdicts: [verdict({ track: 'A' }), verdict({ track: 'B', challenger: 'claude', verdict: 'rejected' })]
  });
  const applied = applyTiebreaks(comparisons, [{ candidateId: 'a'.repeat(64), verdict: 'confirmed', rationale: 'settled' }]);

  assert.equal(applied[0].tiebreak.verdict, 'confirmed');
  assert.equal(applyTiebreaks(comparisons, [])[0].tiebreak, null);
});

test('tiebreak assessments carry no trace of who wrote them', () => {
  const assessments = toAnonymousAssessments({
    A: verdict({ challenger: 'codex', track: 'A', rationale: 'zzz the reassignment path has no guard' }),
    B: verdict({ challenger: 'claude', track: 'B', verdict: 'rejected', rationale: 'aaa stopWatching clears it' })
  });

  const serialized = JSON.stringify(assessments);
  assert.ok(!serialized.includes('claude'), 'provider identity must not leak into the tiebreak prompt');
  assert.ok(!serialized.includes('codex'));
  assert.ok(!serialized.includes('"track"'), 'track identity must not leak either');
  assert.ok(!serialized.includes('confidence'), 'stated certainty must not anchor the tiebreaker');
  assert.deepEqual(assessments.map((entry) => entry.label), ['assessment_1', 'assessment_2']);
});

test('assessment order depends only on content, not on which track produced it', () => {
  const fromA = verdict({ challenger: 'codex', track: 'A', rationale: 'zzz no guard on the reassignment path' });
  const fromB = verdict({ challenger: 'claude', track: 'B', verdict: 'rejected', rationale: 'aaa stopWatching clears it' });

  const forward = toAnonymousAssessments({ A: fromA, B: fromB });
  const reversed = toAnonymousAssessments({ B: fromB, A: fromA });

  assert.deepEqual(
    forward.map((entry) => entry.rationale),
    reversed.map((entry) => entry.rationale),
    'the same two positions must be presented identically regardless of insertion order'
  );
  // Stable across runs, so a resumed run cannot flip the presentation.
  assert.deepEqual(forward, toAnonymousAssessments({ A: fromA, B: fromB }));
});

test('the tiebreaker is picked deterministically and both providers get used', () => {
  assert.equal(assignTiebreaker('00'.repeat(32)), assignTiebreaker('00'.repeat(32)));
  const picks = new Set(
    Array.from({ length: 32 }, (_, index) => assignTiebreaker(index.toString(16).padStart(2, '0').repeat(32)))
  );
  assert.deepEqual([...picks].sort(), ['claude', 'codex'], 'parity must not always land on one provider');
});

test('tiebreak jobs are built only for disputes and carry both positions', () => {
  const candidate = makeCandidate({ candidateId: '00'.repeat(32), providers: ['claude', 'codex'] });
  const comparison = compareTracks({
    candidates: [candidate],
    verdicts: [
      verdict({ candidateId: candidate.candidateId, track: 'A' }),
      verdict({ candidateId: candidate.candidateId, track: 'B', challenger: 'claude', verdict: 'rejected' })
    ]
  })[0];

  const jobs = buildTiebreakJobs({ context, commit: COMMIT, disputes: [{ candidate, comparison }] });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].phase, 'tiebreak');
  assert.equal(jobs[0].schemaName, 'tiebreak');
  assert.deepEqual(jobs[0].candidateIds, [candidate.candidateId]);
  assert.ok(jobs[0].prompt.includes(COMMIT));
  assert.ok(jobs[0].prompt.includes('assessment_1'));
  assert.ok(jobs[0].prompt.includes('assessment_2'));
  assert.ok(!jobs[0].prompt.includes('"challenger"'), 'the rendered prompt must not name a verifier');

  assert.deepEqual(buildTiebreakJobs({ context, commit: COMMIT, disputes: [] }), []);
});
