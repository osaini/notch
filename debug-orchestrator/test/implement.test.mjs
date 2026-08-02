import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MAX_ROUNDS,
  assignRoles,
  loadImplementContext,
  normalizeReview,
  runImplement,
  taskIdentity
} from '../lib/implement.mjs';
import { ORCHESTRATOR_DIR } from '../lib/config.mjs';
import { RunStore } from '../lib/run-store.mjs';
import { resolveCommand, runCapture } from '../lib/proc.mjs';
import { branchNameFor } from '../lib/worktree.mjs';

const context = await loadImplementContext(path.join(ORCHESTRATOR_DIR, 'manifest.example.json'));

function planPayload() {
  return {
    summary: 'Add a 429 branch.',
    steps: [{ file: 'src/a.js', change: 'handle 429 before the generic throw' }],
    assumptions: ['the endpoint sends retry-after'],
    risks: ['cooldown could mask a real outage']
  };
}

function implementPayload(overrides = {}) {
  return { summary: 'Added the branch.', assumptions: [], complete: true, responses: [], ...overrides };
}

function reviewPayload(overrides = {}) {
  return { verdict: 'accept', rationale: 'Looks correct.', findings: [], ...overrides };
}

/** A real git repo, because the pipeline creates a real worktree from a real commit. */
async function makeRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'bugs-implement-'));
  const git = await resolveCommand('git');
  const run = (args) => runCapture(git, args, { cwd: repoRoot, timeoutMs: 60_000 });
  await run(['init', '-b', 'main']);
  await run(['config', 'user.email', 'test@example.com']);
  await run(['config', 'user.name', 'Test']);
  await writeFile(path.join(repoRoot, 'a.js'), 'export const a = 1;\n');
  // Matches the real repo, where `.debug-runs/` is ignored. Without it the run
  // directory itself would show up as untracked and mask a genuine dirty tree.
  await writeFile(path.join(repoRoot, '.gitignore'), '.debug-runs/\n');
  await run(['add', '-A']);
  await run(['commit', '-m', 'initial']);
  const head = await run(['rev-parse', 'HEAD']);
  return { repoRoot, commit: head.stdout.trim(), git };
}

/** Adapter that answers per phase and can edit the worktree on `implement`. */
function phaseAdapter(responses, calls = [], onImplement = null) {
  return {
    async runJob(args) {
      calls.push({ phase: args.phase, round: args.round, mode: args.mode, cwd: args.repoRoot });
      if (args.phase === 'implement' && onImplement) await onImplement(args);
      const entry = responses[args.phase];
      const data = typeof entry === 'function' ? entry(args) : entry;
      return { status: 'succeeded', exitCode: 0, data, metadata: { command: 'fake', argv: [], warnings: [] } };
    }
  };
}

test('a finding without a concrete failure scenario is downgraded to a nit', () => {
  const review = normalizeReview({
    verdict: 'revise',
    rationale: 'x',
    findings: [
      { severity: 'blocking', file: 'a.js', line: 1, claim: 'vague', failure_scenario: '   ' },
      { severity: 'blocking', file: 'a.js', line: 2, claim: 'real', failure_scenario: 'input 0 divides by zero' }
    ]
  });
  assert.equal(review.blockingCount, 1);
  assert.equal(review.findings[0].severity, 'nit');
  assert.equal(review.findings[0].downgraded, true);
  assert.equal(review.findings[1].severity, 'blocking');
  assert.equal(review.verdict, 'revise');
});

test('a claimed revise with no blocking findings converges to accept', () => {
  const review = normalizeReview({
    verdict: 'revise',
    rationale: 'style',
    findings: [{ severity: 'nit', file: 'a.js', line: 1, claim: 'naming', failure_scenario: 'n/a' }]
  });
  assert.equal(review.verdict, 'accept');
  assert.equal(review.claimedVerdict, 'revise');
});

test('roles are complementary and unknown implementers are rejected', () => {
  assert.deepEqual(assignRoles('claude'), { implementer: 'claude', reviewer: 'codex' });
  assert.deepEqual(assignRoles('codex'), { implementer: 'codex', reviewer: 'claude' });
  assert.throws(() => assignRoles('gpt'), /Unknown implementer/);
});

test('task identity is stable for text and passes candidate ids through', () => {
  const a = taskIdentity({ task: '  Fix the thing  ' });
  const b = taskIdentity({ task: 'Fix the thing' });
  assert.equal(a.id, b.id);
  assert.equal(a.kind, 'task');
  assert.deepEqual(taskIdentity({ candidateId: 'abc123' }), { kind: 'candidate', id: 'abc123' });
});

test('an accepted change ends the loop after one round and never touches the source tree', async () => {
  const { repoRoot, commit, git } = await makeRepo();
  try {
    const store = await new RunStore(repoRoot, '20260731-000000-aaaaaaa').init();
    const calls = [];
    const adapter = phaseAdapter(
      { plan: planPayload(), critique: reviewPayload(), implement: implementPayload(), review: reviewPayload() },
      calls,
      async (args) => {
        await writeFile(path.join(args.worktreePath, 'a.js'), 'export const a = 2;\n');
      }
    );

    const run = await runImplement({
      repoRoot,
      store,
      context,
      commit,
      task: 'Change a to 2',
      adapters: { claude: adapter, codex: adapter },
      skipBaseline: true
    });

    assert.equal(run.status, 'accepted');
    assert.equal(run.rounds.length, 1);
    assert.deepEqual(
      calls.map((call) => call.phase),
      ['plan', 'critique', 'implement', 'review']
    );

    // Only the implement phase runs in write mode, and every phase is scoped to
    // the worktree rather than the checkout.
    const writeCalls = calls.filter((call) => call.mode === 'write');
    assert.deepEqual(writeCalls.map((call) => call.phase), ['implement']);
    assert.ok(calls.every((call) => call.cwd === store.worktreePath));

    // The source tree is untouched: the edit exists only in the worktree.
    assert.equal(await readFile(path.join(repoRoot, 'a.js'), 'utf8'), 'export const a = 1;\n');
    assert.equal(await readFile(path.join(store.worktreePath, 'a.js'), 'utf8'), 'export const a = 2;\n');

    const diff = await readFile(store.roundPath(1, 'diff.patch'), 'utf8');
    assert.match(diff, /-export const a = 1;/);
    assert.match(diff, /\+export const a = 2;/);

    const status = await runCapture(git, ['status', '--porcelain'], { cwd: repoRoot, timeoutMs: 30_000 });
    assert.equal(status.stdout.trim(), '');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('an unchanged diff stops the loop instead of burning every round', async () => {
  const { repoRoot, commit } = await makeRepo();
  try {
    const store = await new RunStore(repoRoot, '20260731-000001-aaaaaaa').init();
    const calls = [];
    let writes = 0;
    const adapter = phaseAdapter(
      {
        plan: planPayload(),
        critique: reviewPayload(),
        implement: implementPayload(),
        // Always blocking, so only the no-progress guard can end this run.
        review: reviewPayload({
          verdict: 'revise',
          findings: [
            { severity: 'blocking', file: 'a.js', line: 1, claim: 'still wrong', failure_scenario: 'input 0 breaks' }
          ]
        })
      },
      calls,
      async (args) => {
        // Identical content every round: the second round produces no new diff.
        writes += 1;
        await writeFile(path.join(args.worktreePath, 'a.js'), 'export const a = 2;\n');
      }
    );

    const run = await runImplement({
      repoRoot,
      store,
      context,
      commit,
      task: 'Change a to 2',
      maxRounds: 5,
      adapters: { claude: adapter, codex: adapter },
      skipBaseline: true
    });

    assert.equal(run.status, 'stalled');
    assert.equal(writes, 2);
    assert.equal(run.rounds.length, 1);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('a run that never converges stops at the round cap and keeps its work', async () => {
  const { repoRoot, commit } = await makeRepo();
  try {
    const store = await new RunStore(repoRoot, '20260731-000002-aaaaaaa').init();
    let round = 0;
    const adapter = phaseAdapter(
      {
        plan: planPayload(),
        critique: reviewPayload(),
        implement: implementPayload(),
        review: reviewPayload({
          verdict: 'revise',
          findings: [
            { severity: 'blocking', file: 'a.js', line: 1, claim: 'wrong', failure_scenario: 'input 0 breaks' }
          ]
        })
      },
      [],
      async (args) => {
        round += 1;
        await writeFile(path.join(args.worktreePath, 'a.js'), `export const a = ${round + 1};\n`);
      }
    );

    const run = await runImplement({
      repoRoot,
      store,
      context,
      commit,
      task: 'Change a',
      maxRounds: 2,
      adapters: { claude: adapter, codex: adapter },
      skipBaseline: true
    });

    assert.equal(run.status, 'unconverged');
    assert.equal(run.rounds.length, 2);
    assert.equal(run.worktree.branch, branchNameFor(store.runId));
    // The rejected work is kept for inspection rather than discarded.
    assert.match(await readFile(path.join(store.worktreePath, 'a.js'), 'utf8'), /export const a = 3;/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('default round cap is exported and prompts carry every template variable', () => {
  assert.equal(DEFAULT_MAX_ROUNDS, 3);
  assert.match(context.prompts.plan, /\{\{TASK\}\}/);
  assert.match(context.prompts.critique, /\{\{PLAN_JSON\}\}/);
  assert.match(context.prompts.implement, /\{\{REVIEW_JSON\}\}/);
  assert.match(context.prompts.review, /\{\{DIFF\}\}/);
  assert.match(context.prompts.review, /\{\{BASELINE_JSON\}\}/);
});
