import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RUNS_DIRNAME,
  RunStore,
  atomicWrite,
  atomicWriteJson,
  formatRunId,
  latestRunId,
  listRunIds
} from '../lib/run-store.mjs';

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'bugs-store-'));
}

test('run ids are UTC timestamps plus a short commit', () => {
  const runId = formatRunId(new Date(Date.UTC(2026, 6, 30, 4, 5, 6)), 'f177f4d7278bcce2');
  assert.equal(runId, '20260730-040506-f177f4d');
});

test('atomic writes never leave a partially written canonical file', async () => {
  const dir = await tempDir();
  try {
    const target = path.join(dir, 'run.json');
    await atomicWriteJson(target, { status: 'running', counts: { candidates: 1 } });
    const original = await readFile(target, 'utf8');

    // A write that throws mid-flight must leave the previous file intact...
    await assert.rejects(() => atomicWrite(target, Symbol('not writable')));
    assert.equal(await readFile(target, 'utf8'), original, 'canonical file was damaged by a failed write');

    // ...and must not leave a temporary file behind.
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], `temporary files leaked: ${leftovers.join(', ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent atomic writes always leave one complete, parseable file', async () => {
  const dir = await tempDir();
  try {
    const target = path.join(dir, 'candidates.json');
    const small = { candidates: [] };
    const large = { candidates: Array.from({ length: 5000 }, (_, index) => ({ id: index, note: 'x'.repeat(200) })) };

    await Promise.all([
      atomicWriteJson(target, large),
      atomicWriteJson(target, small),
      atomicWriteJson(target, large),
      atomicWriteJson(target, small)
    ]);

    const parsed = JSON.parse(await readFile(target, 'utf8'));
    assert.ok(parsed.candidates.length === 0 || parsed.candidates.length === 5000, 'file contains a blend of two writes');
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the job log replays to the latest record per job id and survives a torn line', async () => {
  const dir = await tempDir();
  try {
    const store = await new RunStore(dir, '20260730-000000-abcdef0').init();
    await store.appendJob({ jobId: 'scout-claude-main-lifecycle', status: 'failed', inputHash: 'h1' });
    await store.appendJob({ jobId: 'scout-codex-main-lifecycle', status: 'succeeded', inputHash: 'h2' });
    await store.appendJob({ jobId: 'scout-claude-main-lifecycle', status: 'succeeded', inputHash: 'h1' });
    await writeFile(store.jobsPath, '{"jobId":"scout-claude-main', { flag: 'a' });

    const jobs = await store.readJobs();
    assert.equal(jobs.size, 2);
    assert.equal(jobs.get('scout-claude-main-lifecycle').status, 'succeeded');
    assert.equal(jobs.get('scout-codex-main-lifecycle').status, 'succeeded');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('run listing is chronological and --latest picks the newest run', async () => {
  const dir = await tempDir();
  try {
    assert.deepEqual(await listRunIds(dir), []);
    assert.equal(await latestRunId(dir), null);
    for (const runId of ['20260730-010000-aaaaaaa', '20260731-090000-bbbbbbb', '20260730-235959-ccccccc']) {
      await new RunStore(dir, runId).init();
    }
    assert.deepEqual(await listRunIds(dir), [
      '20260730-010000-aaaaaaa',
      '20260730-235959-ccccccc',
      '20260731-090000-bbbbbbb'
    ]);
    assert.equal(await latestRunId(dir), '20260731-090000-bbbbbbb');

    // `preflight/` lives beside the runs and is not one. Run ids start with a
    // digit, so an unfiltered listing sorted it last and --latest always
    // resolved to it.
    await mkdir(path.join(dir, RUNS_DIRNAME, 'preflight'), { recursive: true });
    assert.equal(await latestRunId(dir), '20260731-090000-bbbbbbb');
    assert.ok(!(await listRunIds(dir)).includes('preflight'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the run directory layout matches the documented contract', async () => {
  const dir = await tempDir();
  try {
    const store = await new RunStore(dir, '20260730-000000-abcdef0').init();
    const entries = (await readdir(store.root)).sort();
    assert.deepEqual(entries, ['baseline', 'normalized', 'prompts', 'raw']);
    assert.deepEqual((await readdir(path.join(store.root, 'raw'))).sort(), ['claude', 'codex']);
    assert.deepEqual((await readdir(path.join(store.root, 'normalized'))).sort(), ['claude', 'codex']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
