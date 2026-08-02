import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  NormalizationError,
  candidateIdFor,
  normalizeChallengeOutput,
  normalizePath,
  normalizeScoutOutput
} from '../lib/normalize.mjs';
import { alwaysExists, makeFinding, makeFindingsPayload, makeVerdictsPayload } from './fixtures/factories.mjs';

const SCHEMA_DIR = path.resolve(fileURLToPath(new URL('../schemas', import.meta.url)));
const findingsSchema = JSON.parse(await readFile(path.join(SCHEMA_DIR, 'findings.schema.json'), 'utf8'));
const verdictsSchema = JSON.parse(await readFile(path.join(SCHEMA_DIR, 'verdicts.schema.json'), 'utf8'));

const baseArgs = {
  schema: findingsSchema,
  provider: 'claude',
  shardId: 'main-lifecycle',
  jobId: 'scout-claude-main-lifecycle',
  runId: 'test-run',
  fileReader: alwaysExists
};

test('normalizes paths, trims text, and attaches provenance', async () => {
  const result = await normalizeScoutOutput({
    ...baseArgs,
    data: makeFindingsPayload({
      findings: [makeFinding({ file: '.\\src\\main\\sessionWatcher.ts', title: '  Leaked timer  ', evidence: ['  a  ', '', '   '] })]
    })
  });

  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.file, 'src/main/sessionWatcher.ts');
  assert.equal(candidate.title, 'Leaked timer');
  assert.deepEqual(candidate.evidence, ['a']);
  assert.equal(candidate.provider, 'claude');
  assert.equal(candidate.shard, 'main-lifecycle');
  assert.equal(candidate.jobId, 'scout-claude-main-lifecycle');
  assert.equal(candidate.runId, 'test-run');
  assert.equal(candidate.candidateId.length, 64);
  assert.equal(candidate.shortId, candidate.candidateId.slice(0, 12));
});

test('malformed output fails normalization instead of degrading to an empty result', async () => {
  await assert.rejects(
    () => normalizeScoutOutput({ ...baseArgs, data: { shard_id: 'main-lifecycle' } }),
    (error) => error instanceof NormalizationError
  );

  await assert.rejects(
    () => normalizeScoutOutput({ ...baseArgs, data: 'not an object' }),
    (error) => error instanceof NormalizationError
  );

  await assert.rejects(
    () =>
      normalizeScoutOutput({
        ...baseArgs,
        data: makeFindingsPayload({ findings: [{ ...makeFinding(), severity: 'CRITICAL' }] })
      }),
    (error) => error instanceof NormalizationError && error.errors.some((entry) => entry.includes('severity'))
  );
});

test('low-confidence, unciteable, and out-of-range findings are dropped with a reason', async () => {
  const result = await normalizeScoutOutput({
    ...baseArgs,
    data: makeFindingsPayload({
      findings: [
        makeFinding({ confidence: 0.5 }),
        makeFinding({ symbol: 'other', line_start: 90, line_end: 10 }),
        makeFinding({ symbol: 'third', evidence: ['   '] }),
        makeFinding({ symbol: 'fourth', preconditions: [''] })
      ]
    })
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.dropped.length, 4);
  assert.match(result.dropped[0].reason, /confidence/);
  assert.match(result.dropped[1].reason, /invalid line range/);
  assert.match(result.dropped[2].reason, /evidence/);
  assert.match(result.dropped[3].reason, /preconditions/);
});

test('a finding citing a missing file or an impossible line is dropped', async () => {
  const reader = async (file) => (file === 'src/main/sessionWatcher.ts' ? { exists: true, lineCount: 50 } : null);
  const result = await normalizeScoutOutput({
    ...baseArgs,
    fileReader: reader,
    data: makeFindingsPayload({
      findings: [makeFinding({ file: 'src/main/ghost.ts' }), makeFinding({ symbol: 'other', line_start: 400, line_end: 402 })]
    })
  });

  assert.equal(result.candidates.length, 0);
  assert.match(result.dropped[0].reason, /does not exist/);
  assert.match(result.dropped[1].reason, /exceeds/);
});

test('candidate ids depend on category, file, symbol, and failure path only', () => {
  const base = { category: 'resource-leak', file: 'src/main/a.ts', symbol: 'start', failurePath: 'timer never cleared' };
  assert.equal(candidateIdFor(base), candidateIdFor({ ...base, file: 'src\\main\\a.ts' }));
  assert.equal(candidateIdFor(base), candidateIdFor({ ...base, failurePath: '  Timer   Never Cleared  ' }));
  assert.notEqual(candidateIdFor(base), candidateIdFor({ ...base, symbol: 'stop' }));
});

test('normalizePath strips leading separators and normalizes to forward slashes', () => {
  assert.equal(normalizePath('.\\src\\main\\index.ts'), 'src/main/index.ts');
  assert.equal(normalizePath('/src/main/index.ts'), 'src/main/index.ts');
  assert.equal(normalizePath('  src\\shared\\types.ts '), 'src/shared/types.ts');
});

test('challenge output must cover every candidate exactly once', () => {
  const ids = ['a'.repeat(64), 'b'.repeat(64)];
  const args = { schema: verdictsSchema, challenger: 'codex', jobId: 'challenge-codex-01', runId: 'test-run' };

  const verdicts = normalizeChallengeOutput({ ...args, data: makeVerdictsPayload(ids), expectedCandidateIds: ids });
  assert.equal(verdicts.length, 2);
  assert.equal(verdicts[0].challenger, 'codex');

  assert.throws(
    () => normalizeChallengeOutput({ ...args, data: makeVerdictsPayload([ids[0]]), expectedCandidateIds: ids }),
    /omitted 1 candidate/
  );

  assert.throws(
    () => normalizeChallengeOutput({ ...args, data: makeVerdictsPayload([ids[0], ids[0]]), expectedCandidateIds: ids }),
    /multiple verdicts/
  );

  assert.throws(
    () => normalizeChallengeOutput({ ...args, data: makeVerdictsPayload(['c'.repeat(64)]), expectedCandidateIds: ids }),
    /unknown candidate/
  );

  const blank = { verdicts: [{ ...makeVerdictsPayload([ids[0]]).verdicts[0], candidate_id: '' }] };
  assert.throws(() => normalizeChallengeOutput({ ...args, data: blank, expectedCandidateIds: ids }), NormalizationError);
});
