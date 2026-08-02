import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_CANDIDATES_PER_CHALLENGE,
  buildChallengeJobs,
  buildScoutJobs,
  loadContext,
  runPhase,
  splitByTrack,
  toChallengePayload
} from '../lib/pipeline.mjs';
import { ORCHESTRATOR_DIR } from '../lib/config.mjs';
import { RunStore } from '../lib/run-store.mjs';
import { fakeAdapter, makeCandidate, makeFindingsPayload, makeVerdictsPayload } from './fixtures/factories.mjs';

const COMMIT = 'f177f4d7278bcce2eeb0b3e480d11fe88ec24eb2';
// Load the bundled example only for its prompts and schemas; the shards below
// are declared here so these tests do not depend on any manifest's contents.
const context = await loadContext(process.cwd(), path.join(ORCHESTRATOR_DIR, 'manifest.example.json'));
const shards = [
  { id: 'main-lifecycle', description: 'Lifecycle and session state', paths: ['src/main'] },
  { id: 'hooks-dispatch-ipc', description: 'Hooks, dispatch, and trust boundaries', paths: ['src/main'] }
];

/** A throwaway repository containing exactly the files the fixtures cite. */
async function makeRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'bugs-pipeline-'));
  await mkdir(path.join(repoRoot, 'src', 'main'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src', 'main', 'sessionWatcher.ts'), Array.from({ length: 200 }, () => '// line').join('\n'));
  return repoRoot;
}

test('scout jobs run per shard and provider, and store prompts, records, and normalized output', async () => {
  const repoRoot = await makeRepo();
  try {
    const store = await new RunStore(repoRoot, '20260730-000000-f177f4d').init();
    const jobs = buildScoutJobs({ context, commit: COMMIT, shards, providers: ['claude', 'codex'] });
    assert.equal(jobs.length, shards.length * 2);
    assert.deepEqual(
      jobs.map((job) => job.jobId),
      shards.flatMap((shard) => [`scout-claude-${shard.id}`, `scout-codex-${shard.id}`])
    );

    const calls = [];
    const adapters = {
      claude: fakeAdapter({ status: 'succeeded', data: makeFindingsPayload() }, calls),
      codex: fakeAdapter({ status: 'succeeded', data: makeFindingsPayload({ shard_id: 'hooks-dispatch-ipc' }) }, calls)
    };

    const { outputs, records } = await runPhase({ store, context, jobs, repoRoot, adapters });

    assert.equal(calls.length, 4);
    assert.equal(outputs.size, 4);
    assert.ok([...records.values()].every((record) => record.status === 'succeeded'));
    for (const record of records.values()) {
      assert.ok(record.outputPaths.prompt.startsWith('prompts'));
      assert.ok(record.outputPaths.normalized.startsWith('normalized'));
      assert.equal(typeof record.inputHash, 'string');
      assert.ok(record.startedAt && record.finishedAt);
    }

    const persisted = await store.readJobs();
    assert.equal(persisted.size, 4);
    const first = await store.readNormalized('claude', 'scout-claude-main-lifecycle');
    assert.equal(first.candidates.length, 1);
    assert.equal(first.candidates[0].provider, 'claude');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('successful jobs are skipped on resume, and changed inputs invalidate the cache', async () => {
  const repoRoot = await makeRepo();
  try {
    const store = await new RunStore(repoRoot, '20260730-000001-f177f4d').init();
    const jobs = buildScoutJobs({ context, commit: COMMIT, shards, providers: ['claude', 'codex'] });
    const calls = [];
    const adapters = {
      claude: fakeAdapter({ status: 'succeeded', data: makeFindingsPayload() }, calls),
      codex: fakeAdapter({ status: 'succeeded', data: makeFindingsPayload() }, calls)
    };

    await runPhase({ store, context, jobs, repoRoot, adapters });
    assert.equal(calls.length, 4);

    // Resume with identical inputs: nothing should be re-executed.
    const previousJobs = await store.readJobs();
    const resumed = await runPhase({ store, context, jobs, repoRoot, previousJobs, reuseCache: true, adapters });
    assert.equal(calls.length, 4, 'a cached, unchanged job must not call the provider again');
    assert.ok([...resumed.records.values()].every((record) => record.status === 'skipped'));
    assert.equal(resumed.outputs.size, 4, 'cached normalized output must still be available downstream');

    // A changed prompt invalidates every job built from it.
    const editedPrompts = { ...context, promptHashes: { ...context.promptHashes, scout: 'prompt-changed' } };
    const promptJobs = buildScoutJobs({ context: editedPrompts, commit: COMMIT, shards, providers: ['claude', 'codex'] });
    await runPhase({ store, context, jobs: promptJobs, repoRoot, previousJobs, reuseCache: true, adapters });
    assert.equal(calls.length, 8, 'a changed prompt hash must invalidate cached jobs');

    // So does a changed schema.
    const editedSchemas = { ...context, schemaHashes: { ...context.schemaHashes, findings: 'schema-changed' } };
    const schemaJobs = buildScoutJobs({ context: editedSchemas, commit: COMMIT, shards, providers: ['claude', 'codex'] });
    await runPhase({ store, context, jobs: schemaJobs, repoRoot, previousJobs: await store.readJobs(), reuseCache: true, adapters });
    assert.equal(calls.length, 12, 'a changed schema hash must invalidate cached jobs');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('a failed job is re-run on resume even though its inputs are unchanged', async () => {
  const repoRoot = await makeRepo();
  try {
    const store = await new RunStore(repoRoot, '20260730-000002-f177f4d').init();
    const jobs = buildScoutJobs({ context, commit: COMMIT, shards: shards.slice(0, 1), providers: ['claude'] });
    const calls = [];
    const failing = { claude: fakeAdapter({ status: 'failed', errorSummary: 'provider unavailable' }, calls) };
    await runPhase({ store, context, jobs, repoRoot, adapters: failing });
    assert.equal((await store.readJobs()).get(jobs[0].jobId).status, 'failed');

    const healthy = { claude: fakeAdapter({ status: 'succeeded', data: makeFindingsPayload() }, calls) };
    await runPhase({ store, context, jobs, repoRoot, previousJobs: await store.readJobs(), reuseCache: true, adapters: healthy });
    assert.equal((await store.readJobs()).get(jobs[0].jobId).status, 'succeeded');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('a timeout marks only the target job as timed out', async () => {
  const repoRoot = await makeRepo();
  try {
    const store = await new RunStore(repoRoot, '20260730-000003-f177f4d').init();
    const jobs = buildScoutJobs({ context, commit: COMMIT, shards, providers: ['claude', 'codex'] });
    const victim = 'scout-codex-hooks-dispatch-ipc';

    const plan = (args) =>
      args.jobId === victim ? { status: 'timed_out', errorSummary: 'timed out after 1800000 ms' } : { status: 'succeeded', data: makeFindingsPayload() };
    const adapters = { claude: fakeAdapter(plan), codex: fakeAdapter(plan) };

    await runPhase({ store, context, jobs, repoRoot, adapters });
    const records = await store.readJobs();

    assert.equal(records.get(victim).status, 'timed_out');
    for (const [jobId, record] of records) {
      if (jobId === victim) continue;
      assert.equal(record.status, 'succeeded', `${jobId} should be unaffected by another job's timeout`);
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('malformed provider output fails the job and keeps the raw response', async () => {
  const repoRoot = await makeRepo();
  try {
    const store = await new RunStore(repoRoot, '20260730-000004-f177f4d').init();
    const jobs = buildScoutJobs({ context, commit: COMMIT, shards: shards.slice(0, 1), providers: ['claude'] });
    const adapters = { claude: fakeAdapter({ status: 'succeeded', data: { shard_id: 'main-lifecycle' } }) };

    await runPhase({ store, context, jobs, repoRoot, adapters });
    const record = (await store.readJobs()).get(jobs[0].jobId);

    assert.equal(record.status, 'failed');
    assert.match(record.errorSummary, /schema validation|findings array/);
    assert.equal(record.outputPaths.normalized, null);
    assert.ok(record.outputPaths.raw, 'the raw response path must be retained for diagnosis');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('each track is challenged only by its opposing provider', () => {
  const claudeOnly = makeCandidate({ candidateId: '00'.repeat(32), provider: 'claude' });
  const codexOnly = makeCandidate({ candidateId: '11'.repeat(32), provider: 'codex' });

  const tracksById = splitByTrack([claudeOnly, codexOnly]);
  assert.deepEqual([...tracksById.keys()], ['A', 'B']);
  assert.deepEqual(tracksById.get('A').candidates.map((entry) => entry.candidateId), [claudeOnly.candidateId]);
  assert.deepEqual(tracksById.get('B').candidates.map((entry) => entry.candidateId), [codexOnly.candidateId]);

  const jobs = buildChallengeJobs({ context, commit: COMMIT, tracksById });
  const byCandidate = new Map();
  for (const job of jobs) {
    for (const candidateId of job.candidateIds) byCandidate.set(candidateId, job);
  }

  assert.equal(byCandidate.get(claudeOnly.candidateId).provider, 'codex', "Track A's findings must be verified by Codex");
  assert.equal(byCandidate.get(claudeOnly.candidateId).track, 'A');
  assert.equal(byCandidate.get(codexOnly.candidateId).provider, 'claude', "Track B's findings must be verified by Claude");
  assert.equal(byCandidate.get(codexOnly.candidateId).track, 'B');
});

test('a candidate both finders produced is challenged once per track, not once overall', () => {
  // Same content from both finders collapses to one candidate id.
  const fromClaude = makeCandidate({ candidateId: '22'.repeat(32), provider: 'claude' });
  const fromCodex = makeCandidate({ candidateId: '22'.repeat(32), provider: 'codex' });

  const tracksById = splitByTrack([fromClaude, fromCodex]);
  const jobs = buildChallengeJobs({ context, commit: COMMIT, tracksById });

  const challengers = jobs
    .filter((job) => job.candidateIds.includes('22'.repeat(32)))
    .map((job) => ({ track: job.track, provider: job.provider }));

  assert.equal(challengers.length, 2, 'a jointly discovered candidate must be verified by both providers');
  assert.deepEqual(
    challengers.sort((a, b) => a.track.localeCompare(b.track)),
    [
      { track: 'A', provider: 'codex' },
      { track: 'B', provider: 'claude' }
    ]
  );

  // The two jobs must be distinguishable, or the second silently overwrites the
  // first in jobs.jsonl and in the resume cache.
  const jobIds = jobs.map((job) => job.jobId);
  assert.equal(new Set(jobIds).size, jobIds.length, 'job ids must be unique across tracks');
  const hashes = jobs.map((job) => job.inputHash);
  assert.equal(new Set(hashes).size, hashes.length, 'input hashes must differ per track');
});

test('challenge jobs batch at most ten candidates each, per track', () => {
  const candidates = Array.from({ length: 23 }, (_, index) =>
    makeCandidate({ candidateId: String(index).padStart(64, '0'), provider: 'claude' })
  );
  const tracksById = splitByTrack(candidates);
  const jobs = buildChallengeJobs({ context, commit: COMMIT, tracksById });

  assert.ok(jobs.every((job) => job.provider === 'codex'), 'only Track A has findings, so only Codex verifies');
  assert.ok(jobs.every((job) => job.track === 'A'));
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map((job) => job.candidateIds.length), [MAX_CANDIDATES_PER_CHALLENGE, MAX_CANDIDATES_PER_CHALLENGE, 3]);
  assert.equal(new Set(jobs.flatMap((job) => job.candidateIds)).size, 23, 'every candidate is challenged exactly once');
  assert.deepEqual(jobs.map((job) => job.jobId), [
    'challenge-A-codex-01',
    'challenge-A-codex-02',
    'challenge-A-codex-03'
  ]);
});

test('the challenge payload hides which provider found the candidate', () => {
  const candidate = {
    ...makeCandidate({}),
    providers: ['claude', 'codex'],
    confidenceByProvider: { claude: 0.9, codex: 0.7 },
    evidenceByProvider: { claude: ['src/main/sessionWatcher.ts:44'], codex: ['src/main/sessionWatcher.ts:51'] }
  };
  const payload = toChallengePayload(candidate);
  const serialized = JSON.stringify(payload);

  assert.ok(!serialized.includes('claude'), 'provider identity must not leak into the challenge prompt');
  assert.ok(!serialized.includes('codex'));
  assert.ok(!('providers' in payload) && !('confidence' in payload), 'origin and scout confidence must not anchor the challenger');
  assert.deepEqual(payload.evidence.sort(), ['src/main/sessionWatcher.ts:44', 'src/main/sessionWatcher.ts:51']);
  assert.equal(payload.candidate_id, candidate.candidateId);
});

test('challenge jobs normalize verdicts and reject an incomplete response', async () => {
  const repoRoot = await makeRepo();
  try {
    const store = await new RunStore(repoRoot, '20260730-000005-f177f4d').init();
    const candidates = [makeCandidate({ candidateId: 'ab'.repeat(32), provider: 'claude' })];
    const tracksById = splitByTrack(candidates);
    const jobs = buildChallengeJobs({ context, commit: COMMIT, tracksById });

    const good = { codex: fakeAdapter({ status: 'succeeded', data: makeVerdictsPayload([candidates[0].candidateId]) }) };
    const { outputs } = await runPhase({ store, context, jobs, repoRoot, adapters: good });
    const normalized = [...outputs.values()][0];
    assert.equal(normalized.verdicts.length, 1);
    assert.equal(normalized.verdicts[0].challenger, 'codex');
    assert.equal(normalized.verdicts[0].verdict, 'confirmed');
    assert.equal(normalized.verdicts[0].track, 'A', 'a verdict must record which track it judged');

    const bad = { codex: fakeAdapter({ status: 'succeeded', data: { verdicts: [] } }) };
    await runPhase({ store, context, jobs, repoRoot, adapters: bad });
    const record = (await store.readJobs()).get(jobs[0].jobId);
    assert.equal(record.status, 'failed');
    assert.match(record.errorSummary, /omitted 1 candidate/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('the scout prompt carries the shard contract and no fix instructions', () => {
  const [job] = buildScoutJobs({ context, commit: COMMIT, shards: shards.slice(0, 1), providers: ['claude'] });
  assert.ok(job.prompt.includes(COMMIT));
  assert.ok(job.prompt.includes(shards[0].id));
  assert.ok(job.prompt.includes(shards[0].paths[0]));
  assert.ok(!job.prompt.includes('{{'), 'every placeholder must be substituted');
  assert.match(job.prompt, /Do not edit files\./);
  assert.match(job.prompt, /Do not propose implementation fixes\./);
});

test('a provider-restricted run produces one job per shard with distinct input hashes', () => {
  const jobs = buildScoutJobs({ context, commit: COMMIT, shards: context.manifest.shards, providers: ['codex'] });
  assert.equal(jobs.length, context.manifest.shards.length);
  assert.ok(jobs.every((job) => job.provider === 'codex'));
  assert.equal(new Set(jobs.map((job) => job.inputHash)).size, jobs.length, 'each shard must hash differently');

  const otherCommit = buildScoutJobs({ context, commit: 'deadbeef', shards: context.manifest.shards, providers: ['codex'] });
  assert.ok(
    jobs.every((job, index) => job.inputHash !== otherCommit[index].inputHash),
    'a different commit must invalidate every cached job'
  );
});
