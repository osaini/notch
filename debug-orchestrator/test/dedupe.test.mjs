import assert from 'node:assert/strict';
import test from 'node:test';

import { dedupeCandidates, jaccard, titleTokens } from '../lib/dedupe.mjs';
import { candidateIdFor } from '../lib/normalize.mjs';
import { makeCandidate } from './fixtures/factories.mjs';

function candidateWith(overrides) {
  const merged = makeCandidate(overrides);
  const candidateId = candidateIdFor({
    category: merged.category,
    file: merged.file,
    symbol: merged.symbol,
    failurePath: merged.failurePath
  });
  return { ...merged, candidateId, shortId: candidateId.slice(0, 12) };
}

test('identical candidate hashes merge while preserving every provider\'s provenance', () => {
  const claude = candidateWith({ provider: 'claude', confidence: 0.7, severity: 'P2', evidence: ['claude cite'] });
  const codex = candidateWith({
    provider: 'codex',
    shard: 'hooks-dispatch-ipc',
    jobId: 'scout-codex-hooks-dispatch-ipc',
    confidence: 0.95,
    severity: 'P0',
    evidence: ['codex cite'],
    lineStart: 38,
    lineEnd: 70
  });

  const { candidates } = dedupeCandidates([claude, codex]);

  assert.equal(candidates.length, 1);
  const merged = candidates[0];
  assert.deepEqual(merged.providers.sort(), ['claude', 'codex']);
  assert.deepEqual(merged.shards.sort(), ['hooks-dispatch-ipc', 'main-lifecycle']);
  assert.deepEqual(merged.jobIds.sort(), ['scout-claude-main-lifecycle', 'scout-codex-hooks-dispatch-ipc']);
  assert.equal(merged.severity, 'P0', 'the highest severity must win');
  assert.deepEqual(merged.confidenceByProvider, { claude: 0.7, codex: 0.95 });
  assert.deepEqual(merged.evidenceByProvider.claude, ['claude cite']);
  assert.deepEqual(merged.evidenceByProvider.codex, ['codex cite']);
  assert.equal(merged.lineStart, 38);
  assert.equal(merged.lineEnd, 70);
  assert.equal(merged.sources.length, 2);
});

test('similar titles in different symbols are never merged', () => {
  const first = candidateWith({ symbol: 'startWatching', title: 'Debounce timer is never cleared on restart' });
  const second = candidateWith({
    provider: 'codex',
    symbol: 'stopWatching',
    title: 'Debounce timer is never cleared on shutdown'
  });

  const { candidates, possibleDuplicates } = dedupeCandidates([first, second]);

  assert.equal(candidates.length, 2, 'different symbols must stay separate candidates');
  assert.equal(possibleDuplicates.length, 1, 'they should still be flagged for human review');
  assert.match(possibleDuplicates[0].reason, /similar titles/);
  assert.deepEqual(possibleDuplicates[0].candidateIds.sort(), [first.candidateId, second.candidateId].sort());
});

test('same file and symbol with overlapping line ranges is flagged, not merged', () => {
  const first = candidateWith({ category: 'resource-leak', lineStart: 40, lineEnd: 62 });
  const second = candidateWith({
    provider: 'codex',
    category: 'race-condition',
    failurePath: 'two watchers observe the same file',
    lineStart: 55,
    lineEnd: 80
  });

  const { candidates, possibleDuplicates } = dedupeCandidates([first, second]);
  assert.equal(candidates.length, 2);
  assert.equal(possibleDuplicates.length, 1);
  assert.match(possibleDuplicates[0].reason, /overlapping line ranges/);
});

test('non-overlapping ranges in the same symbol are left alone', () => {
  const first = candidateWith({ category: 'resource-leak', lineStart: 10, lineEnd: 20 });
  const second = candidateWith({
    provider: 'codex',
    category: 'race-condition',
    failurePath: 'a different transition entirely',
    title: 'Focus handler drops the second event',
    lineStart: 90,
    lineEnd: 110
  });
  const { candidates, possibleDuplicates } = dedupeCandidates([first, second]);
  assert.equal(candidates.length, 2);
  assert.equal(possibleDuplicates.length, 0);
});

test('candidates in different files are never compared', () => {
  const first = candidateWith({ title: 'Timer is never cleared' });
  const second = candidateWith({ provider: 'codex', file: 'src/main/focus.ts', title: 'Timer is never cleared' });
  const { candidates, possibleDuplicates } = dedupeCandidates([first, second]);
  assert.equal(candidates.length, 2);
  assert.equal(possibleDuplicates.length, 0);
});

test('title tokenization ignores stopwords and short tokens', () => {
  assert.deepEqual([...titleTokens('The timer is not cleared')].sort(), ['cleared', 'timer']);
  assert.equal(jaccard(titleTokens('timer never cleared'), titleTokens('timer never cleared')), 1);
  assert.equal(jaccard(titleTokens('timer leak'), titleTokens('focus regression')), 0);
});
