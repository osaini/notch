import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ORCHESTRATOR_DIR } from '../lib/config.mjs';
import { runFix } from '../lib/fix.mjs';
import { loadImplementContext } from '../lib/implement.mjs';
import { resolveCommand, runCapture } from '../lib/proc.mjs';
import { RunStore } from '../lib/run-store.mjs';

const context = await loadImplementContext(path.join(ORCHESTRATOR_DIR, 'manifest.example.json'));

/** git's autocrlf rewrites checked-out line endings on Windows. */
async function read(target) {
  return (await readFile(target, 'utf8')).replace(/\r\n/g, '\n');
}

async function makeRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'bugs-fixbatch-'));
  const git = await resolveCommand('git');
  const run = (args) => runCapture(git, args, { cwd: repoRoot, timeoutMs: 60_000 });
  await run(['init', '-b', 'main']);
  await run(['config', 'user.email', 'test@example.com']);
  await run(['config', 'user.name', 'Test']);
  await writeFile(path.join(repoRoot, 'a.js'), 'export const a = 1;\n');
  await writeFile(path.join(repoRoot, 'b.js'), 'export const b = 1;\n');
  await writeFile(path.join(repoRoot, '.gitignore'), '.debug-runs/\nnode_modules/\n');
  await run(['add', '-A']);
  await run(['commit', '-m', 'initial']);
  const head = await run(['rev-parse', 'HEAD']);
  return { repoRoot, commit: head.stdout.trim() };
}

function promotedEntry(overrides = {}) {
  return {
    candidateId: 'a'.repeat(64),
    shortId: 'a'.repeat(12),
    title: 'a is wrong',
    severity: 'P1',
    file: 'a.js',
    symbol: 'a',
    lineStart: 1,
    lineEnd: 1,
    failurePath: 'a is 1 and should be 2',
    observableImpact: 'callers see 1',
    preconditions: ['a is read'],
    suggestedTest: 'assert a === 2',
    evidenceByProvider: { claude: ['a.js:1'] },
    status: 'verified',
    tiebroken: false,
    comparison: { foundBy: ['A', 'B'], verdicts: {} },
    ...overrides
  };
}

/**
 * Adapter that edits a file during the implement phase and otherwise returns
 * canned schema-valid payloads. `onImplement` decides what each fix does.
 */
function batchAdapter({ worktreePath, behaviour }) {
  return {
    async runJob({ phase, prompt }) {
      const ok = (data) => ({ status: 'succeeded', exitCode: 0, data, metadata: { argv: [], warnings: [] } });

      if (phase === 'fixplan') {
        // Deliberately reverse the severity order so the planner is observably in charge.
        const ids = [...prompt.matchAll(/"candidate_id": "([0-9a-f]{64})"/g)].map((match) => match[1]);
        return ok({
          summary: 'reverse order',
          fixes: ids.map((id, index) => ({
            candidate_id: id,
            order: ids.length - index,
            rationale: 'test ordering',
            interacts_with: []
          })),
          conflicts: []
        });
      }

      if (phase === 'plan') return ok({ summary: 'plan', steps: [{ file: 'a.js', change: 'edit' }], assumptions: [], risks: [] });
      if (phase === 'critique') return ok({ verdict: 'accept', rationale: 'fine', findings: [] });

      if (phase === 'implement') {
        const action = behaviour(prompt);
        if (action.throw) return { status: 'failed', exitCode: 1, data: null, metadata: { errorSummary: action.throw, argv: [] } };
        if (action.file) await writeFile(path.join(worktreePath, action.file), action.contents);
        return ok({ summary: 'done', assumptions: [], complete: true, responses: [] });
      }

      // review
      const action = behaviour(prompt);
      return ok(
        action.reject
          ? {
              verdict: 'revise',
              rationale: 'not good enough',
              findings: [{ severity: 'blocking', file: 'a.js', line: 1, claim: 'wrong', failure_scenario: 'still returns 1' }]
            }
          : { verdict: 'accept', rationale: 'good', findings: [] }
      );
    }
  };
}

test('a fix that fails does not abort the rest of the batch, and its work is not carried forward', async () => {
  const { repoRoot, commit } = await makeRepo();
  const runId = '20260801-000000-aaaaaaa';
  const store = await new RunStore(repoRoot, runId).init();

  try {
    const failing = promotedEntry({ candidateId: '1'.repeat(64), shortId: '1'.repeat(12), title: 'first fails', file: 'a.js' });
    const passing = promotedEntry({ candidateId: '2'.repeat(64), shortId: '2'.repeat(12), title: 'second works', file: 'b.js' });

    const adapters = {
      claude: batchAdapter({
        worktreePath: store.worktreePath,
        behaviour: (prompt) =>
          // The failing fix writes a file, then its reviewer refuses it forever.
          prompt.includes('first fails')
            ? { file: 'a.js', contents: 'export const a = 999;\n', reject: true }
            : { file: 'b.js', contents: 'export const b = 2;\n' }
      }),
      codex: batchAdapter({
        worktreePath: store.worktreePath,
        behaviour: (prompt) => (prompt.includes('first fails') ? { reject: true } : {})
      })
    };

    const run = await runFix({
      repoRoot,
      store,
      context,
      commit,
      promoted: [failing, passing],
      implementer: 'claude',
      maxRounds: 1,
      skipBaseline: true,
      adapters
    });

    assert.equal(run.fixes.length, 2, 'both fixes must be attempted');
    const byTitle = new Map(run.fixes.map((entry) => [entry.title, entry]));
    assert.notEqual(byTitle.get('first fails').status, 'accepted');
    assert.equal(byTitle.get('second works').status, 'accepted');
    assert.ok(byTitle.get('second works').commit, 'an accepted fix must be committed so the next diff is scoped');
    assert.equal(run.status, 'partial');
    assert.equal(run.accepted, 1);

    // The rejected fix's edit must not survive into the batch result.
    assert.equal(await read(path.join(store.worktreePath, 'a.js')), 'export const a = 1;\n');
    assert.equal(await read(path.join(store.worktreePath, 'b.js')), 'export const b = 2;\n');
    assert.deepEqual(run.cumulative.filesChanged, ['b.js'], 'only accepted work belongs in the cumulative diff');

    // The rejected work is still auditable even though it was reverted.
    const rejectedDiff = await read(store.fixRoundPath(byTitle.get('first fails').fixIndex, 1, 'diff.patch'));
    assert.match(rejectedDiff, /a = 999/);

    // The user's own checkout is untouched.
    const git = await resolveCommand('git');
    const status = await runCapture(git, ['status', '--porcelain'], { cwd: repoRoot, timeoutMs: 60_000 });
    assert.equal(status.stdout.trim(), '', 'the source checkout must stay clean');
    assert.equal(await read(path.join(repoRoot, 'b.js')), 'export const b = 1;\n');
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('the fix planner controls the order the batch is worked through', async () => {
  const { repoRoot, commit } = await makeRepo();
  const store = await new RunStore(repoRoot, '20260801-000001-aaaaaaa').init();

  try {
    const order = [];
    const adapters = {
      claude: batchAdapter({
        worktreePath: store.worktreePath,
        behaviour: (prompt) => {
          const match = prompt.match(/Title: (.+)/);
          if (match && !order.includes(match[1])) order.push(match[1]);
          return { file: 'a.js', contents: `export const a = ${order.length + 1};\n` };
        }
      }),
      codex: batchAdapter({ worktreePath: store.worktreePath, behaviour: () => ({}) })
    };

    const run = await runFix({
      repoRoot,
      store,
      context,
      commit,
      // P0 first by severity; the stub planner reverses it.
      promoted: [
        promotedEntry({ candidateId: '1'.repeat(64), shortId: '1'.repeat(12), title: 'urgent', severity: 'P0' }),
        promotedEntry({ candidateId: '2'.repeat(64), shortId: '2'.repeat(12), title: 'later', severity: 'P2' })
      ],
      implementer: 'claude',
      maxRounds: 1,
      skipBaseline: true,
      adapters
    });

    assert.deepEqual(
      run.fixes.map((entry) => entry.title),
      ['later', 'urgent'],
      'the planner order must win over the severity ranking'
    );
    assert.equal(run.accepted, 2);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
