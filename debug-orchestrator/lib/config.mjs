import { access, constants, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PipelineError } from './cli.mjs';
import { resolveCommand, runCapture } from './proc.mjs';

export const ORCHESTRATOR_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** What a target repository names its config, when it keeps one of its own. */
export const MANIFEST_BASENAME = 'debug-orchestrator.json';

/**
 * Everything the pipeline needs a value for, so a repository's manifest only
 * has to say what differs. `shards` and `baseline` are deliberately empty:
 * they describe a specific codebase and cannot have a useful default.
 */
export const MANIFEST_DEFAULTS = {
  version: 1,
  packageManager: 'npm',
  concurrency: { claude: 2, codex: 2 },
  timeoutsMinutes: {
    scout: 30,
    challenge: 20,
    tiebreak: 20,
    reproduce: 30,
    fixplan: 20,
    plan: 30,
    critique: 20,
    implement: 45,
    review: 30
  },
  providers: {
    claude: { model: 'opus', effort: 'high', maxBudgetUsdPerJob: 3 },
    codex: { model: 'gpt-5.6-sol' }
  },
  /**
   * Advisory floors. Left null by default: pinning a minimum is useful for a
   * team that has hit a specific CLI bug, and merely noise for everyone else.
   */
  minimumVersions: { claude: null, codex: null },
  /** Probed and reported, never fatal. */
  requiredClaudePlugins: [],
  baseline: [],
  shards: []
};

async function exists(target) {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the repository to work on.
 *
 * Asking git from the current directory is what lets the orchestrator live
 * anywhere — vendored in the target repo, cloned beside it, or installed
 * globally. The orchestrator's own parent directory is the last resort, which
 * keeps the vendored layout working when git is unavailable.
 */
export async function resolveRepoRoot(explicit, cwd = process.cwd()) {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!(await exists(resolved))) throw new PipelineError(`--repo-root does not exist: ${resolved}`);
    return resolved;
  }

  const git = await resolveCommand('git');
  if (git) {
    const top = await runCapture(git, ['rev-parse', '--show-toplevel'], { cwd, timeoutMs: 30_000 });
    if (top.status === 'succeeded' && top.stdout.trim()) {
      return path.resolve(top.stdout.trim());
    }
  }

  return path.resolve(ORCHESTRATOR_DIR, '..');
}

/**
 * Find the shard manifest, preferring the target repository's own.
 *
 * A repository that vendors this directory can keep its config at the root as
 * `debug-orchestrator.json` rather than editing a file inside the tool, so
 * updating the tool never clobbers its configuration.
 */
export async function resolveManifestPath(repoRoot, explicit) {
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!(await exists(resolved))) throw new PipelineError(`--manifest does not exist: ${resolved}`);
    return resolved;
  }

  const inRepo = path.join(repoRoot, MANIFEST_BASENAME);
  if (await exists(inRepo)) return inRepo;

  const vendored = path.join(ORCHESTRATOR_DIR, 'manifest.json');
  if (await exists(vendored)) return vendored;

  throw new PipelineError(
    `No manifest found. Create ${MANIFEST_BASENAME} in ${repoRoot} (copy ` +
      `${path.join(ORCHESTRATOR_DIR, 'manifest.example.json')} to start), or pass --manifest <path>.`
  );
}

function mergeSection(defaults, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return { ...defaults };
  return { ...defaults, ...override };
}

/** Fill a parsed manifest out with defaults, one level deep per section. */
export function applyManifestDefaults(raw) {
  const manifest = { ...MANIFEST_DEFAULTS, ...raw };
  manifest.concurrency = mergeSection(MANIFEST_DEFAULTS.concurrency, raw?.concurrency);
  manifest.timeoutsMinutes = mergeSection(MANIFEST_DEFAULTS.timeoutsMinutes, raw?.timeoutsMinutes);
  manifest.minimumVersions = mergeSection(MANIFEST_DEFAULTS.minimumVersions, raw?.minimumVersions);
  manifest.providers = {
    claude: mergeSection(MANIFEST_DEFAULTS.providers.claude, raw?.providers?.claude),
    codex: mergeSection(MANIFEST_DEFAULTS.providers.codex, raw?.providers?.codex)
  };
  manifest.baseline = Array.isArray(raw?.baseline) ? raw.baseline : MANIFEST_DEFAULTS.baseline;
  manifest.shards = Array.isArray(raw?.shards) ? raw.shards : MANIFEST_DEFAULTS.shards;
  manifest.requiredClaudePlugins = Array.isArray(raw?.requiredClaudePlugins)
    ? raw.requiredClaudePlugins
    : MANIFEST_DEFAULTS.requiredClaudePlugins;
  return manifest;
}

/**
 * A baseline entry is `{ name, args }` (run with the configured package
 * manager) or `{ name, command, args }` (run verbatim). Normalising here means
 * callers never have to care which form the manifest used.
 */
export function normalizeBaseline(manifest) {
  const packageManager = manifest.packageManager ?? MANIFEST_DEFAULTS.packageManager;
  return (manifest.baseline ?? []).map((entry, index) => ({
    name: entry.name ?? entry.command ?? `check-${index + 1}`,
    command: entry.command ?? packageManager,
    args: Array.isArray(entry.args) ? entry.args : []
  }));
}

/** Read, parse, and default a manifest. Returns the raw text too, for hashing. */
export async function readManifest(manifestPath) {
  const text = await readFile(manifestPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PipelineError(`${manifestPath} is not valid JSON: ${error.message}`);
  }
  return { manifest: applyManifestDefaults(parsed), text, manifestPath };
}
