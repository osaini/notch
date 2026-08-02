import { access, cp, lstat, rm, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';

import { resolveCommand, runCapture } from './proc.mjs';

const GIT_TIMEOUT_MS = 120_000;

async function git(repoRoot, args, timeoutMs = GIT_TIMEOUT_MS) {
  const command = await resolveCommand('git');
  if (!command) throw new Error('git not found on PATH');
  return runCapture(command, args, { cwd: repoRoot, timeoutMs });
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Branch name for a run. Namespaced so it can never collide with a real branch. */
export function branchNameFor(runId) {
  return `debug-impl/${runId}`;
}

/**
 * Create the run's worktree at `<run>/tree`, checked out at `commit`.
 *
 * A worktree rather than a clone: it shares the object store, so setup is
 * near-instant regardless of history size. The user's checkout is never touched,
 * which is the whole point — the implementer edits only in here.
 *
 * Idempotent: an existing worktree at the same path is reused, so `resume` does
 * not have to rebuild it and lose uncommitted work from an interrupted round.
 */
export async function createWorktree({ repoRoot, worktreePath, commit, runId }) {
  const branch = branchNameFor(runId);
  if (await exists(path.join(worktreePath, '.git'))) {
    return { path: worktreePath, branch, commit, reused: true };
  }

  const result = await git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, commit]);
  if (result.status !== 'succeeded') {
    throw new Error(
      `git worktree add failed (exit ${result.exitCode}): ${`${result.stderr}${result.stdout}`.trim().slice(0, 400)}`
    );
  }
  return { path: worktreePath, branch, commit, reused: false };
}

/**
 * Make dependencies available inside the worktree.
 *
 * Baseline commands (`npm run typecheck`, `verify`, …) cannot run without
 * `node_modules`, and a fresh install per run would dominate the runtime. A
 * directory symlink is tried first and falls back to a copy, because symlink
 * creation on Windows needs either Developer Mode or elevation and fails with
 * EPERM otherwise.
 *
 * Returns the strategy used so the run record can explain a later baseline
 * failure instead of leaving it mysterious.
 */
export async function linkDependencies({ repoRoot, worktreePath, copyFallback = true }) {
  const source = path.join(repoRoot, 'node_modules');
  const destination = path.join(worktreePath, 'node_modules');

  if (!(await exists(source))) return { strategy: 'absent', note: 'repo has no node_modules' };
  if (await exists(destination)) return { strategy: 'present', note: 'worktree already has node_modules' };

  try {
    await symlink(source, destination, 'junction');
    return { strategy: 'junction', note: null };
  } catch (error) {
    if (!copyFallback) {
      return { strategy: 'failed', note: `symlink failed: ${String(error?.message ?? error)}` };
    }
  }

  try {
    await cp(source, destination, { recursive: true });
    return { strategy: 'copy', note: null };
  } catch (error) {
    return { strategy: 'failed', note: `copy failed: ${String(error?.message ?? error)}` };
  }
}

/**
 * The implementer's output: everything it changed, as a unified diff.
 *
 * `git add -A` first so new files appear — an untracked file is invisible to
 * `git diff` and the reviewer would never see it. Staging is a read of intent,
 * not a commit: this function never commits. A multi-fix run commits between
 * fixes via `commitWorktree`, but only ever onto the run's throwaway branch.
 */
export async function captureDiff({ worktreePath, maxBytes = 400_000 }) {
  const add = await git(worktreePath, ['add', '-A']);
  if (add.status !== 'succeeded') {
    throw new Error(`git add failed in worktree: ${add.stderr.trim().slice(0, 300)}`);
  }
  const diff = await git(worktreePath, ['diff', '--cached', '--no-color']);
  if (diff.status !== 'succeeded') {
    throw new Error(`git diff failed in worktree: ${diff.stderr.trim().slice(0, 300)}`);
  }
  const names = await git(worktreePath, ['diff', '--cached', '--name-only']);

  const full = diff.stdout;
  const truncated = full.length > maxBytes;
  return {
    diff: truncated
      ? `${full.slice(0, maxBytes)}\n\n[diff truncated at ${maxBytes} bytes — ${full.length} total]`
      : full,
    truncated,
    byteLength: full.length,
    filesChanged: names.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  };
}

/**
 * Commit the staged change onto the run's throwaway branch.
 *
 * Only used when several fixes share one worktree. Without it every fix's
 * `captureDiff` would return the accumulated work of all the previous ones, and
 * the reviewer for fix #3 would be handed fixes #1 and #2 to re-review.
 *
 * This commits to `debug-impl/<run-id>` inside `.debug-runs/<id>/tree` and
 * nowhere else. The user's checkout and branches are never touched — the
 * worktree is a scratch branch that `--clean` deletes wholesale.
 */
export async function commitWorktree({ worktreePath, message }) {
  const staged = await git(worktreePath, ['diff', '--cached', '--name-only']);
  if (staged.status !== 'succeeded') {
    throw new Error(`git diff --cached failed in worktree: ${staged.stderr.trim().slice(0, 300)}`);
  }
  if (!staged.stdout.trim()) return { committed: false, sha: null, reason: 'nothing staged' };

  const result = await git(worktreePath, [
    '-c',
    'user.name=debug-orchestrator',
    '-c',
    'user.email=debug-orchestrator@localhost',
    'commit',
    '--no-verify',
    '--no-gpg-sign',
    '-m',
    message
  ]);
  if (result.status !== 'succeeded') {
    throw new Error(
      `git commit failed in worktree (exit ${result.exitCode}): ${`${result.stderr}${result.stdout}`.trim().slice(0, 400)}`
    );
  }
  const head = await git(worktreePath, ['rev-parse', 'HEAD']);
  return { committed: true, sha: head.stdout.trim() || null, reason: null };
}

/**
 * Throw away uncommitted work and return the worktree to its last commit.
 *
 * Used when a fix in a shared worktree did not converge. Its changes must not
 * leak into the next fix's diff — the next reviewer would be handed rejected
 * work to re-review as if it were new. Nothing is lost: every round's diff is
 * already on disk under `fixes/<index>/rounds/<round>/diff.patch`.
 *
 * `git clean` runs without `-x` deliberately. Ignored files stay, which is what
 * keeps the `node_modules` junction intact — removing it here would follow the
 * link and delete the repository's real dependencies.
 */
export async function resetWorktree({ worktreePath }) {
  const reset = await git(worktreePath, ['reset', '--hard', 'HEAD']);
  if (reset.status !== 'succeeded') {
    throw new Error(`git reset --hard failed in worktree: ${reset.stderr.trim().slice(0, 300)}`);
  }
  const clean = await git(worktreePath, ['clean', '-fd']);
  if (clean.status !== 'succeeded') {
    throw new Error(`git clean failed in worktree: ${clean.stderr.trim().slice(0, 300)}`);
  }
  return { reset: true };
}

/** The accumulated diff of every fix applied in a shared worktree. */
export async function captureCumulativeDiff({ worktreePath, baseCommit, maxBytes = 400_000 }) {
  const diff = await git(worktreePath, ['diff', '--no-color', `${baseCommit}..HEAD`]);
  if (diff.status !== 'succeeded') {
    throw new Error(`git diff ${baseCommit}..HEAD failed in worktree: ${diff.stderr.trim().slice(0, 300)}`);
  }
  const names = await git(worktreePath, ['diff', '--name-only', `${baseCommit}..HEAD`]);
  const full = diff.stdout;
  const truncated = full.length > maxBytes;
  return {
    diff: truncated
      ? `${full.slice(0, maxBytes)}\n\n[diff truncated at ${maxBytes} bytes — ${full.length} total]`
      : full,
    truncated,
    byteLength: full.length,
    filesChanged: names.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  };
}

/**
 * Detach the `node_modules` link before anything walks the worktree.
 *
 * This is not a tidiness step. A junction is a real directory entry: a
 * recursive delete that follows it — `git worktree remove --force` does —
 * deletes the *target*, which is the repository's own `node_modules`. Unlinking
 * first removes only the link and leaves the target untouched.
 *
 * A copied (non-link) `node_modules` is left alone; deleting it is the caller's
 * normal recursive removal, and it owns no data anyone else needs.
 */
export async function unlinkDependencies(worktreePath) {
  const destination = path.join(worktreePath, 'node_modules');
  try {
    const stats = await lstat(destination);
    if (!stats.isSymbolicLink()) return { unlinked: false, reason: 'not a link' };
  } catch {
    return { unlinked: false, reason: 'absent' };
  }
  try {
    await unlink(destination);
    return { unlinked: true, reason: null };
  } catch (error) {
    // Never fall back to a recursive delete here: if unlink failed the entry may
    // still be a live link, and rm -r would destroy the real node_modules.
    throw new Error(
      `Refusing to remove ${worktreePath}: could not unlink the node_modules junction ` +
        `(${String(error?.message ?? error)}). Remove it manually before retrying.`
    );
  }
}

/**
 * Remove the worktree and its branch.
 *
 * Only ever called explicitly. A failed or unconverged run keeps its tree so the
 * work can be inspected — silently deleting the only copy of a rejected change
 * is how you lose an afternoon.
 */
export async function removeWorktree({ repoRoot, worktreePath, runId }) {
  // Must happen before git touches the tree. See unlinkDependencies.
  const link = await unlinkDependencies(worktreePath);

  const removed = await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
  if (removed.status !== 'succeeded') {
    // The directory may already be gone; prune so git's metadata agrees.
    await git(repoRoot, ['worktree', 'prune']);
    await rm(worktreePath, { recursive: true, force: true });
  }
  const branch = branchNameFor(runId);
  const deleted = await git(repoRoot, ['branch', '-D', branch]);
  return {
    worktreeRemoved: true,
    branchRemoved: deleted.status === 'succeeded',
    branch,
    dependencyLinkRemoved: link.unlinked
  };
}
