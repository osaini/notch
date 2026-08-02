import assert from 'node:assert/strict';
import test from 'node:test';

import { runQueue } from '../lib/queue.mjs';

function makeJobs(counts) {
  const jobs = [];
  for (const [provider, count] of Object.entries(counts)) {
    for (let index = 0; index < count; index += 1) jobs.push({ jobId: `${provider}-${index}`, provider });
  }
  return jobs;
}

test('queue enforces per-provider concurrency independently', async () => {
  const inFlight = { claude: 0, codex: 0 };
  const peak = { claude: 0, codex: 0 };

  await runQueue({
    jobs: makeJobs({ claude: 7, codex: 7 }),
    concurrency: { claude: 2, codex: 2 },
    execute: async (job) => {
      inFlight[job.provider] += 1;
      peak[job.provider] = Math.max(peak[job.provider], inFlight[job.provider]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight[job.provider] -= 1;
      return { status: 'succeeded' };
    }
  });

  assert.equal(peak.claude, 2, 'claude lane exceeded its concurrency limit');
  assert.equal(peak.codex, 2, 'codex lane exceeded its concurrency limit');
});

test('a provider whose jobs all fail does not cancel the other provider', async () => {
  const { results } = await runQueue({
    jobs: makeJobs({ claude: 3, codex: 3 }),
    concurrency: { claude: 2, codex: 2 },
    retry: { maxAttempts: 1 },
    execute: async (job) => {
      if (job.provider === 'codex') throw new Error('provider exploded');
      return { status: 'succeeded' };
    }
  });

  const claudeResults = results.filter((entry) => entry.job.provider === 'claude');
  const codexResults = results.filter((entry) => entry.job.provider === 'codex');
  assert.equal(claudeResults.length, 3);
  assert.ok(claudeResults.every((entry) => entry.result.status === 'succeeded'));
  assert.equal(codexResults.length, 3);
  assert.ok(codexResults.every((entry) => entry.result.status === 'failed'));
  assert.match(codexResults[0].result.errorSummary, /provider exploded/);
});

test('jobs start in the order they were supplied', async () => {
  const started = [];
  await runQueue({
    jobs: makeJobs({ claude: 4 }),
    concurrency: { claude: 1 },
    execute: async (job) => {
      started.push(job.jobId);
      return { status: 'succeeded' };
    }
  });
  assert.deepEqual(started, ['claude-0', 'claude-1', 'claude-2', 'claude-3']);
});

test('a transient failure is retried exactly once, after a randomized delay', async () => {
  const delays = [];
  let attempts = 0;

  const { results } = await runQueue({
    jobs: [{ jobId: 'claude-0', provider: 'claude' }],
    concurrency: { claude: 1 },
    retry: { maxAttempts: 2, minDelayMs: 100, maxDelayMs: 300 },
    sleep: async (ms) => delays.push(ms),
    random: () => 0.5,
    execute: async () => {
      attempts += 1;
      return attempts === 1 ? { status: 'failed' } : { status: 'succeeded' };
    }
  });

  assert.equal(attempts, 2);
  assert.equal(results[0].result.status, 'succeeded');
  assert.equal(delays.length, 1);
  assert.ok(delays[0] >= 100 && delays[0] <= 300, `delay ${delays[0]} outside the configured window`);
});

test('schema-invalid output is not retried more than once', async () => {
  let attempts = 0;
  const { results } = await runQueue({
    jobs: [{ jobId: 'codex-0', provider: 'codex' }],
    concurrency: { codex: 1 },
    sleep: async () => {},
    execute: async () => {
      attempts += 1;
      return { status: 'failed', errorSummary: 'output failed schema validation' };
    }
  });
  assert.equal(attempts, 2, 'expected the original attempt plus exactly one retry');
  assert.equal(results[0].attempts, 2);
  assert.equal(results[0].result.status, 'failed');
});

test('timeouts are not retried inside a run; resume is the recovery path', async () => {
  let attempts = 0;
  const { results } = await runQueue({
    jobs: [{ jobId: 'claude-0', provider: 'claude' }],
    concurrency: { claude: 1 },
    execute: async () => {
      attempts += 1;
      return { status: 'timed_out' };
    }
  });
  assert.equal(attempts, 1);
  assert.equal(results[0].result.status, 'timed_out');
});
