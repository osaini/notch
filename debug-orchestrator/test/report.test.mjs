import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyAgreement, compareTracks } from '../lib/compare.mjs';
import { classifyCandidate, promoteAll } from '../lib/promote.mjs';
import { renderReport } from '../lib/report.mjs';

function mergedCandidate(overrides = {}) {
  return {
    candidateId: 'a'.repeat(64),
    shortId: 'a'.repeat(12),
    title: 'Debounce timer is never cleared',
    severity: 'P2',
    category: 'resource-leak',
    file: 'src/main/sessionWatcher.ts',
    symbol: 'startWatching',
    lineStart: 40,
    lineEnd: 62,
    failurePath: 'startWatching reassigns this.timer without clearTimeout',
    observableImpact: 'The watcher keeps firing after stopWatching resolves',
    preconditions: ['Two changes inside the debounce window'],
    suggestedTest: 'Call startWatching twice and assert one pending timer',
    falsePositiveRisk: 'stopWatching may clear it elsewhere',
    reproCommand: null,
    providers: ['claude'],
    shards: ['main-lifecycle'],
    jobIds: ['scout-claude-main-lifecycle'],
    confidenceByProvider: { claude: 0.82 },
    evidenceByProvider: { claude: ['src/main/sessionWatcher.ts:44'] },
    sources: [],
    ...overrides
  };
}

function verdict(overrides = {}) {
  return {
    candidateId: 'a'.repeat(64),
    shortId: 'a'.repeat(12),
    verdict: 'confirmed',
    challenger: 'codex',
    track: 'A',
    jobId: 'challenge-A-codex-01',
    rationale: 'The reassignment path has no clearTimeout',
    supportingEvidence: ['src/main/sessionWatcher.ts:44'],
    invalidatingEvidence: [],
    minimalReproduction: null,
    confidence: 0.9,
    ...overrides
  };
}

/** A comparison as `compareTracks` builds it, without running the pipeline. */
function comparison({ foundBy = ['A'], a = verdict(), b = null, agreement, tiebreak = null } = {}) {
  const verdicts = { A: a, B: b };
  return {
    candidateId: 'a'.repeat(64),
    shortId: 'a'.repeat(12),
    foundBy,
    verdicts,
    agreement: agreement ?? classifyAgreement(verdicts),
    tiebreak
  };
}

const bothTracks = { foundBy: ['A', 'B'] };

test('a single-track confirmed finding is probable, not verified', () => {
  const result = classifyCandidate(mergedCandidate(), comparison());
  assert.equal(result.status, 'probable');
  assert.match(result.reason, /single-track/);
});

test('both tracks finding it and both verifiers confirming verifies a low-severity finding', () => {
  const result = classifyCandidate(
    mergedCandidate({ providers: ['claude', 'codex'], confidenceByProvider: { claude: 0.82, codex: 0.7 } }),
    comparison({ ...bothTracks, b: verdict({ challenger: 'claude', track: 'B' }) })
  );
  assert.equal(result.status, 'verified');
});

test('P0 and P1 are not verified without executable evidence or unusually strong agreement', () => {
  const twoConfirms = (overrides = {}) => ({
    ...bothTracks,
    a: verdict(overrides),
    b: verdict({ challenger: 'claude', track: 'B', ...overrides })
  });

  const weak = classifyCandidate(
    mergedCandidate({ severity: 'P0', providers: ['claude', 'codex'], confidenceByProvider: { claude: 0.82, codex: 0.7 } }),
    comparison(twoConfirms({ confidence: 0.9 }))
  );
  assert.equal(weak.status, 'probable', 'a scout confidence of 0.7 is not unusually strong agreement');

  const lowChallenger = classifyCandidate(
    mergedCandidate({ severity: 'P1', providers: ['claude', 'codex'], confidenceByProvider: { claude: 0.9, codex: 0.9 } }),
    comparison(twoConfirms({ confidence: 0.7 }))
  );
  assert.equal(lowChallenger.status, 'probable');

  const noProof = classifyCandidate(
    mergedCandidate({ severity: 'P0', providers: ['claude', 'codex'], confidenceByProvider: { claude: 0.95, codex: 0.9 } }),
    comparison(twoConfirms({ confidence: 0.95, supportingEvidence: [] }))
  );
  assert.equal(noProof.status, 'probable', 'confirmation without cited code-path proof is not verification');

  // One verifier clearing the bar is no longer enough: with two tracks, both must.
  const oneStrong = classifyCandidate(
    mergedCandidate({ severity: 'P0', providers: ['claude', 'codex'], confidenceByProvider: { claude: 0.95, codex: 0.9 } }),
    comparison({ ...bothTracks, a: verdict({ confidence: 0.95 }), b: verdict({ challenger: 'claude', track: 'B', confidence: 0.5 }) })
  );
  assert.equal(oneStrong.status, 'probable', 'both verifiers must clear the bar, not just one');

  const strong = classifyCandidate(
    mergedCandidate({ severity: 'P0', providers: ['claude', 'codex'], confidenceByProvider: { claude: 0.95, codex: 0.9 } }),
    comparison(twoConfirms({ confidence: 0.95 }))
  );
  assert.equal(strong.status, 'verified');

  const reproduced = classifyCandidate(
    mergedCandidate({ severity: 'P0' }),
    comparison({ a: verdict({ verdict: 'needs_reproduction' }) }),
    { reproduced: true, matchesPredictedFailurePath: true }
  );
  assert.equal(reproduced.status, 'verified', 'executable evidence outranks every other signal');
});

test('rejected, needs_reproduction, and unchallenged candidates are classified distinctly', () => {
  assert.equal(classifyCandidate(mergedCandidate(), comparison({ a: verdict({ verdict: 'rejected' }) })).status, 'rejected');
  assert.equal(
    classifyCandidate(mergedCandidate(), comparison({ a: verdict({ verdict: 'needs_reproduction' }) })).status,
    'needs_reproduction'
  );
  const unchallenged = classifyCandidate(mergedCandidate(), null);
  assert.equal(unchallenged.status, 'needs_reproduction');
  assert.match(unchallenged.reason, /no verdict recorded/);
});

test('two verdicts on one candidate both survive instead of overwriting each other', () => {
  const candidate = mergedCandidate({ providers: ['claude', 'codex'] });
  const confirmedByCodex = verdict({ track: 'A', challenger: 'codex' });
  const rejectedByClaude = verdict({
    track: 'B',
    challenger: 'claude',
    verdict: 'rejected',
    rationale: 'stopWatching clears the handle at sessionWatcher.ts:88',
    supportingEvidence: [],
    invalidatingEvidence: ['src/main/sessionWatcher.ts:88']
  });

  const comparisons = compareTracks({
    candidates: [candidate],
    verdicts: [confirmedByCodex, rejectedByClaude]
  });

  assert.equal(comparisons.length, 1);
  assert.deepEqual(comparisons[0].foundBy, ['A', 'B']);
  assert.equal(comparisons[0].verdicts.A.verdict, 'confirmed');
  assert.equal(comparisons[0].verdicts.B.verdict, 'rejected');
  assert.equal(comparisons[0].agreement, 'disputed');

  const [promotedEntry] = promoteAll({ candidates: [candidate], comparisons });
  assert.equal(promotedEntry.status, 'disputed', 'an unresolved contradiction must not be reported as a finding either way');
});

test('a dispute is resolved by the tiebreak, and only by a decisive one', () => {
  const candidate = mergedCandidate({ providers: ['claude', 'codex'] });
  const disputed = {
    ...bothTracks,
    a: verdict(),
    b: verdict({ track: 'B', challenger: 'claude', verdict: 'rejected' })
  };

  const unresolved = classifyCandidate(candidate, comparison(disputed));
  assert.equal(unresolved.status, 'disputed');

  const confirmedTiebreak = classifyCandidate(
    candidate,
    comparison({ ...disputed, tiebreak: { verdict: 'confirmed', rationale: 'no clearTimeout on the reassignment path' } })
  );
  assert.equal(confirmedTiebreak.status, 'probable', 'a tiebroken finding is never promoted straight to verified');

  const rejectedTiebreak = classifyCandidate(
    candidate,
    comparison({ ...disputed, tiebreak: { verdict: 'rejected', rationale: 'the guard at :88 covers it' } })
  );
  assert.equal(rejectedTiebreak.status, 'rejected');

  const indecisive = classifyCandidate(
    candidate,
    comparison({ ...disputed, tiebreak: { verdict: 'needs_reproduction', rationale: 'cannot settle by reading' } })
  );
  assert.equal(indecisive.status, 'disputed', 'an indecisive tiebreak leaves the dispute standing');
});

test('the report includes failed jobs, rejected findings, and baseline status', () => {
  const promoted = promoteAll({
    candidates: [
      mergedCandidate({ providers: ['claude', 'codex'], confidenceByProvider: { claude: 0.9, codex: 0.88 } }),
      mergedCandidate({ candidateId: 'b'.repeat(64), shortId: 'b'.repeat(12), title: 'Focus handler drops the second event' })
    ],
    comparisons: [
      comparison({ ...bothTracks, a: verdict(), b: verdict({ track: 'B', challenger: 'claude' }) }),
      {
        ...comparison({
          a: verdict({
            candidateId: 'b'.repeat(64),
            shortId: 'b'.repeat(12),
            verdict: 'rejected',
            rationale: 'focus.ts:88 already re-arms the handler',
            invalidatingEvidence: ['src/main/focus.ts:88']
          })
        }),
        candidateId: 'b'.repeat(64),
        shortId: 'b'.repeat(12)
      }
    ]
  });

  const markdown = renderReport({
    run: {
      runId: '20260730-120000-f177f4d',
      status: 'completed_with_failures',
      commit: 'f177f4d7278bcce2eeb0b3e480d11fe88ec24eb2',
      startedAt: '2026-07-30T12:00:00.000Z',
      finishedAt: '2026-07-30T12:40:00.000Z',
      manifestHash: 'c0ffee'.repeat(8),
      cliVersions: { claude: '2.1.220 (Claude Code)', codex: 'codex-cli 0.146.0' },
      promptHashes: { scout: 'aa'.repeat(32) },
      schemaHashes: { findings: 'bb'.repeat(32) },
      config: {
        providers: ['claude', 'codex'],
        shards: ['main-lifecycle'],
        tracks: [
          { id: 'A', finder: 'claude', challenger: 'codex' },
          { id: 'B', finder: 'codex', challenger: 'claude' }
        ]
      },
      warnings: ['codex CLI does not support --strict-config; flag omitted']
    },
    promoted,
    comparisonSummary: {
      counts: { 'both-confirmed': 1, 'single-rejected': 1, disputed: 0 },
      trackAOnly: 1,
      trackBOnly: 0,
      bothTracks: 1,
      total: 2
    },
    possibleDuplicates: [{ reason: 'same file and symbol with overlapping line ranges', shortIds: ['a'.repeat(12), 'b'.repeat(12)] }],
    residualRisks: [{ shard: 'main-lifecycle', provider: 'claude', risk: 'Did not inspect tray teardown ordering' }],
    jobs: [
      { jobId: 'scout-claude-main-lifecycle', provider: 'claude', phase: 'scout', status: 'succeeded' },
      {
        jobId: 'scout-codex-mobile-bridge',
        provider: 'codex',
        phase: 'scout',
        status: 'timed_out',
        exitCode: null,
        errorSummary: 'timed out after 1800000 ms'
      },
      {
        jobId: 'challenge-claude-01',
        provider: 'claude',
        phase: 'challenge',
        status: 'failed',
        exitCode: 1,
        errorSummary: 'output failed schema validation'
      }
    ],
    baseline: {
      checks: [
        { name: 'typecheck', status: 'succeeded', exitCode: 0 },
        { name: 'verify', status: 'failed', exitCode: 1 }
      ]
    }
  });

  for (const heading of [
    '## 1. Run metadata',
    '## 2. Baseline status',
    '## 3. Executive summary',
    '## 4. Cross-track comparison',
    '## 5. Verified findings',
    '## 6. Probable findings',
    '## 7. Disputed findings (the tracks disagreed)',
    '## 8. Findings needing reproduction',
    '## 9. Rejected findings (appendix)',
    '## 10. Residual risks by shard',
    '## 11. Failed or timed-out jobs',
    '## 12. Recommended next actions'
  ]) {
    assert.ok(markdown.includes(heading), `report is missing "${heading}"`);
  }

  assert.ok(markdown.includes('scout-codex-mobile-bridge'), 'timed-out job is missing from the report');
  assert.ok(markdown.includes('challenge-claude-01'), 'failed job is missing from the report');
  assert.ok(markdown.includes('timed out after 1800000 ms'));
  assert.ok(markdown.includes('Focus handler drops the second event'), 'rejected finding must stay auditable');
  assert.ok(markdown.includes('focus.ts:88 already re-arms the handler'));
  assert.ok(markdown.includes('1 baseline check(s) were already failing'));
  assert.ok(markdown.includes('codex CLI does not support --strict-config'));
  assert.ok(markdown.includes('Possible duplicate groups'));

  // Every documented per-finding field must appear.
  for (const label of [
    '**Candidate ID:**',
    '**Severity:**',
    '**Status:**',
    '**Origin provider(s):**',
    '**Found by track(s):**',
    '**Per-track verdicts:**',
    '**Scout confidence:**',
    '**Location:**',
    '**Preconditions:**',
    '**Failure path:**',
    '**Observable impact:**',
    '**Evidence:**',
    '**Proposed reproduction:**',
    '**False-positive risk:**'
  ]) {
    assert.ok(markdown.includes(label), `report is missing the "${label}" field`);
  }
});

test('a clean run reports no failed jobs rather than omitting the section', () => {
  const markdown = renderReport({
    run: {
      runId: '20260730-120000-f177f4d',
      status: 'completed',
      commit: 'f177f4d',
      startedAt: '2026-07-30T12:00:00.000Z',
      finishedAt: '2026-07-30T12:10:00.000Z',
      manifestHash: 'abc',
      config: { providers: ['claude', 'codex'], shards: [] }
    },
    promoted: [],
    jobs: [{ jobId: 'scout-claude-main-lifecycle', provider: 'claude', phase: 'scout', status: 'succeeded' }]
  });
  assert.ok(markdown.includes('## 11. Failed or timed-out jobs'));
  assert.ok(markdown.includes('_None. Every job in this run completed._'));
  assert.ok(markdown.includes('Nothing in this run modified the repository.'));
});
