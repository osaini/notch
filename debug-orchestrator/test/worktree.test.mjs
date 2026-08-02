import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveCommand, runCapture } from '../lib/proc.mjs';
import {
  branchNameFor,
  captureDiff,
  createWorktree,
  linkDependencies,
  removeWorktree,
  unlinkDependencies
} from '../lib/worktree.mjs';

/** A real repo with a real node_modules, because the hazard is a real junction. */
async function makeRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'bugs-worktree-'));
  const git = await resolveCommand('git');
  const run = (args) => runCapture(git, args, { cwd: repoRoot, timeoutMs: 60_000 });
  await run(['init', '-b', 'main']);
  await run(['config', 'user.email', 'test@example.com']);
  await run(['config', 'user.name', 'Test']);
  await writeFile(path.join(repoRoot, 'a.js'), 'export const a = 1;\n');
  await writeFile(path.join(repoRoot, '.gitignore'), '.debug-runs/\nnode_modules/\n');
  await mkdir(path.join(repoRoot, 'node_modules', '.bin'), { recursive: true });
  await writeFile(path.join(repoRoot, 'node_modules', '.bin', 'tool'), 'binary\n');
  await writeFile(path.join(repoRoot, 'node_modules', 'pkg.js'), 'module.exports = 1;\n');
  await run(['add', '-A']);
  await run(['commit', '-m', 'initial']);
  const head = await run(['rev-parse', 'HEAD']);
  return { repoRoot, commit: head.stdout.trim() };
}

/**
 * Regression: removing a worktree must not delete through the node_modules
 * junction into the repository's own dependencies.
 *
 * This is not hypothetical — `git worktree remove --force` followed the junction
 * and emptied `node_modules/.bin` in the real repo before `unlinkDependencies`
 * existed.
 */
test('removing a worktree leaves the repository node_modules intact', async () => {
  const { repoRoot, commit } = await makeRepo();
  const runId = '20260731-000100-bbbbbbb';
  const worktreePath = path.join(repoRoot, '.debug-runs', runId, 'tree');
  try {
    await createWorktree({ repoRoot, worktreePath, commit, runId });
    const deps = await linkDependencies({ repoRoot, worktreePath });
    assert.ok(['junction', 'copy'].includes(deps.strategy), `unexpected strategy ${deps.strategy}`);

    // The dependency really is reachable from inside the worktree.
    assert.equal(await readFile(path.join(worktreePath, 'node_modules', 'pkg.js'), 'utf8'), 'module.exports = 1;\n');

    await removeWorktree({ repoRoot, worktreePath, runId });

    // The target survived, contents and all.
    assert.equal(await readFile(path.join(repoRoot, 'node_modules', 'pkg.js'), 'utf8'), 'module.exports = 1;\n');
    assert.deepEqual(await readdir(path.join(repoRoot, 'node_modules', '.bin')), ['tool']);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('unlinkDependencies removes only the link, never the target', async () => {
  const { repoRoot, commit } = await makeRepo();
  const runId = '20260731-000101-bbbbbbb';
  const worktreePath = path.join(repoRoot, '.debug-runs', runId, 'tree');
  try {
    await createWorktree({ repoRoot, worktreePath, commit, runId });
    const deps = await linkDependencies({ repoRoot, worktreePath });

    const result = await unlinkDependencies(worktreePath);
    assert.equal(result.unlinked, deps.strategy === 'junction');
    assert.equal(await readFile(path.join(repoRoot, 'node_modules', 'pkg.js'), 'utf8'), 'module.exports = 1;\n');

    // Idempotent: a second call is a no-op rather than an error.
    assert.equal((await unlinkDependencies(worktreePath)).unlinked, false);
  } finally {
    await removeWorktree({ repoRoot, worktreePath, runId }).catch(() => {});
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('a worktree is branched from the commit and its diff excludes the source tree', async () => {
  const { repoRoot, commit } = await makeRepo();
  const runId = '20260731-000102-bbbbbbb';
  const worktreePath = path.join(repoRoot, '.debug-runs', runId, 'tree');
  try {
    const wt = await createWorktree({ repoRoot, worktreePath, commit, runId });
    assert.equal(wt.branch, branchNameFor(runId));
    assert.equal(wt.reused, false);

    // Creating twice reuses rather than failing, so resume keeps its work.
    assert.equal((await createWorktree({ repoRoot, worktreePath, commit, runId })).reused, true);

    await writeFile(path.join(worktreePath, 'a.js'), 'export const a = 42;\n');
    const captured = await captureDiff({ worktreePath });
    assert.deepEqual(captured.filesChanged, ['a.js']);
    assert.match(captured.diff, /\+export const a = 42;/);
    assert.equal(captured.truncated, false);

    // The source file is untouched.
    assert.equal(await readFile(path.join(repoRoot, 'a.js'), 'utf8'), 'export const a = 1;\n');
  } finally {
    await removeWorktree({ repoRoot, worktreePath, runId }).catch(() => {});
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('an oversized diff is truncated with an explicit marker, not silently clipped', async () => {
  const { repoRoot, commit } = await makeRepo();
  const runId = '20260731-000103-bbbbbbb';
  const worktreePath = path.join(repoRoot, '.debug-runs', runId, 'tree');
  try {
    await createWorktree({ repoRoot, worktreePath, commit, runId });
    await writeFile(path.join(worktreePath, 'a.js'), Array.from({ length: 5000 }, (_, i) => `const x${i} = ${i};`).join('\n'));
    const captured = await captureDiff({ worktreePath, maxBytes: 2000 });
    assert.equal(captured.truncated, true);
    assert.ok(captured.byteLength > 2000);
    assert.match(captured.diff, /\[diff truncated at 2000 bytes/);
  } finally {
    await removeWorktree({ repoRoot, worktreePath, runId }).catch(() => {});
    await rm(repoRoot, { recursive: true, force: true });
  }
});
