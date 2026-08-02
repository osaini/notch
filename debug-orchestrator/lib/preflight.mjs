import { access, constants } from 'node:fs/promises';
import path from 'node:path';

import { normalizeBaseline } from './config.mjs';
import { resolveCommand, runCapture } from './proc.mjs';

/** Pull the first `x.y.z[-prerelease]` out of arbitrary `--version` output. */
export function parseVersion(text) {
  const match = String(text ?? '').match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    raw: match[0]
  };
}

/** Semver comparison, including the rule that a prerelease sorts below its release. */
export function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a;
  const right = typeof b === 'string' ? parseVersion(b) : b;
  if (!left || !right) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

export function meetsMinimum(actual, minimum) {
  const result = compareVersions(actual, minimum);
  return result !== null && result >= 0;
}

async function pathExists(target) {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `claude plugin list` prints a plugin name followed by indented detail lines.
 * The plugin counts as enabled when its own block says so, not merely because
 * the word appears somewhere else in the output.
 */
export function isPluginEnabled(output, pluginName) {
  const lines = String(output ?? '').split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(pluginName));
  if (index === -1) return false;
  for (const line of lines.slice(index + 1)) {
    // The block ends at the first blank or unindented line; a later plugin's
    // status must never be read as this one's.
    if (!line.trim() || !/^\s/.test(line)) break;
    if (/status\s*:/i.test(line)) return /\benabled\b/i.test(line);
  }
  return false;
}

function check(name, ok, detail, { fatal = true } = {}) {
  return { name, status: ok ? 'pass' : fatal ? 'fail' : 'warn', detail, fatal };
}

/**
 * Verify tooling, repository state, and manifest integrity.
 *
 * Makes no paid model calls: only `--version`, `plugin list`, and git plumbing.
 */
export async function runToolingChecks({ repoRoot, manifest }) {
  const checks = [];
  const versions = {};

  const resolved = {};
  for (const name of ['codex', 'claude', 'git', 'node', 'npm']) {
    resolved[name] = await resolveCommand(name);
    checks.push(check(`resolve ${name}`, Boolean(resolved[name]), resolved[name] ?? 'not found on PATH'));
  }

  // Version floors are advisory and manifest-driven: a repository that has hit
  // a specific CLI bug can pin one, but an unpinned CLI must not block a run.
  const minimums = manifest.minimumVersions ?? {};
  const versionProbes = [
    { name: 'codex', args: ['--version'], minimum: minimums.codex ?? null },
    { name: 'claude', args: ['--version'], minimum: minimums.claude ?? null },
    { name: 'node', args: ['--version'], minimum: null },
    { name: 'git', args: ['--version'], minimum: null }
  ];

  for (const probe of versionProbes) {
    if (!resolved[probe.name]) continue;
    const result = await runCapture(resolved[probe.name], probe.args, { cwd: repoRoot, timeoutMs: 60_000 });
    const text = `${result.stdout}${result.stderr}`.trim();
    versions[probe.name] = text.split('\n')[0]?.trim() ?? '';
    if (result.status !== 'succeeded') {
      checks.push(check(`${probe.name} --version`, false, `exited with ${result.exitCode}: ${text.slice(0, 200)}`));
      continue;
    }
    checks.push(check(`${probe.name} --version`, true, versions[probe.name]));
    if (probe.minimum) {
      const parsed = parseVersion(text);
      checks.push(
        check(
          `${probe.name} >= ${probe.minimum}`,
          meetsMinimum(parsed, probe.minimum),
          parsed ? `found ${parsed.raw}` : `could not parse a version from "${text.slice(0, 120)}"`,
          { fatal: false }
        )
      );
    }
  }

  // Informational only: the batch coordinator does not use plugins. Repositories
  // that do depend on one can list it under `requiredClaudePlugins`.
  const wantedPlugins = manifest.requiredClaudePlugins ?? [];
  if (resolved.claude && wantedPlugins.length) {
    const plugins = await runCapture(resolved.claude, ['plugin', 'list'], { cwd: repoRoot, timeoutMs: 120_000 });
    const text = `${plugins.stdout}${plugins.stderr}`;
    for (const plugin of wantedPlugins) {
      const enabled = isPluginEnabled(text, plugin);
      checks.push(
        check(`claude plugin ${plugin} enabled`, enabled, enabled ? 'enabled' : 'not detected as enabled', {
          fatal: false
        })
      );
    }
  }

  let commit = null;
  if (resolved.git) {
    const inside = await runCapture(resolved.git, ['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot, timeoutMs: 30_000 });
    const isWorktree = inside.status === 'succeeded' && inside.stdout.trim() === 'true';
    checks.push(check('git worktree', isWorktree, isWorktree ? repoRoot : inside.stderr.trim().slice(0, 200)));

    if (isWorktree) {
      const head = await runCapture(resolved.git, ['rev-parse', 'HEAD'], { cwd: repoRoot, timeoutMs: 30_000 });
      commit = head.stdout.trim();
      checks.push(check('git rev-parse HEAD', head.status === 'succeeded' && Boolean(commit), commit || 'unavailable'));

      const status = await runCapture(resolved.git, ['status', '--porcelain'], { cwd: repoRoot, timeoutMs: 60_000 });
      const dirty = status.stdout.trim();
      checks.push(
        check(
          'git worktree is clean',
          status.status === 'succeeded' && dirty.length === 0,
          dirty ? `${dirty.split('\n').length} dirty path(s):\n${dirty.slice(0, 800)}` : 'clean'
        )
      );
    }
  }

  const missingPaths = [];
  for (const shard of manifest.shards) {
    for (const relative of shard.paths) {
      if (!(await pathExists(path.resolve(repoRoot, relative)))) missingPaths.push(`${shard.id}: ${relative}`);
    }
  }
  checks.push(check('manifest paths exist', missingPaths.length === 0, missingPaths.join('\n') || 'all present'));

  return { checks, versions, commit, resolved };
}

/**
 * Run the deterministic baseline. Failures are recorded, not thrown: a
 * pre-existing failing test is not an LLM-discovered bug, but the report has to
 * say which checks were already red.
 */
export async function runBaseline({ repoRoot, manifest, onProgress = () => {} }) {
  const commands = normalizeBaseline(manifest);
  // No configured baseline is a valid configuration, not a failure: plenty of
  // repositories have no single command that means "still healthy".
  if (!commands.length) return { checks: [], configured: false };

  const checks = [];
  for (const command of commands) {
    onProgress(command);
    const binary = await resolveCommand(command.command);
    if (!binary) {
      checks.push({
        name: command.name,
        command: `${command.command} ${command.args.join(' ')}`.trim(),
        status: 'failed',
        exitCode: null,
        stdoutTail: '',
        stderrTail: `${command.command} not found on PATH`
      });
      continue;
    }
    const result = await runCapture(binary, command.args, { cwd: repoRoot, timeoutMs: 20 * 60 * 1000 });
    checks.push({
      name: command.name,
      command: `${command.command} ${command.args.join(' ')}`.trim(),
      status: result.status,
      exitCode: result.exitCode,
      stdoutTail: result.stdout.slice(-4000),
      stderrTail: result.stderr.slice(-4000)
    });
  }
  return { checks, configured: true };
}
