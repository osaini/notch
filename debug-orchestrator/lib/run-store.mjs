import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const RUNS_DIRNAME = '.debug-runs';

/**
 * Matches what `formatRunId` produces.
 *
 * `.debug-runs/` also holds `preflight/`, which is not a run. Without this
 * filter it was listed as one, and because run ids start with a digit it sorted
 * last, so `--latest` resolved to it every time even with real runs present.
 */
const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]+$/;

/** `YYYYMMDD-HHMMSS-<short-commit>` in UTC. */
export function formatRunId(date, commitSha) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const stamp =
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return `${stamp}-${String(commitSha).slice(0, 7)}`;
}

/**
 * Write to a temporary sibling then rename, so a crash mid-write can never leave
 * a half-written canonical file. The temp name is randomized so concurrent
 * writers cannot collide on it.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * On Windows a replacing rename can fail transiently while another process holds
 * the destination open — antivirus, a file indexer, and OneDrive sync all do
 * this. Those codes are retried briefly; anything else propagates immediately.
 */
async function renameWithRetry(from, to, attempts = 6) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !TRANSIENT_RENAME_CODES.has(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 25));
    }
  }
}

export async function atomicWrite(destination, contents) {
  await mkdir(path.dirname(destination), { recursive: true });
  const tempPath = `${destination}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tempPath, contents, 'utf8');
    await renameWithRetry(tempPath, destination);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function atomicWriteJson(destination, value) {
  await atomicWrite(destination, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonIfExists(target) {
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export class RunStore {
  constructor(repoRoot, runId) {
    this.repoRoot = repoRoot;
    this.runId = runId;
    this.root = path.join(repoRoot, RUNS_DIRNAME, runId);
  }

  get runJsonPath() {
    return path.join(this.root, 'run.json');
  }

  get jobsPath() {
    return path.join(this.root, 'jobs.jsonl');
  }

  get candidatesPath() {
    return path.join(this.root, 'candidates.json');
  }

  get verdictsPath() {
    return path.join(this.root, 'verdicts.json');
  }

  /** Cross-track agreement: what each track found and how the verdicts lined up. */
  get comparisonPath() {
    return path.join(this.root, 'comparison.json');
  }

  /** The ordered, capped set of findings a fix run works through. */
  get fixPlanPath() {
    return path.join(this.root, 'fix-plan.json');
  }

  get reportPath() {
    return path.join(this.root, 'report.md');
  }

  baselinePath(name) {
    return path.join(this.root, 'baseline', name);
  }

  /** The implement run's git worktree. Never the user's checkout. */
  get worktreePath() {
    return path.join(this.root, 'tree');
  }

  /** Per-round artefacts for an implement run: diff, review, baseline. */
  roundPath(round, name) {
    return path.join(this.root, 'rounds', String(round), name);
  }

  /**
   * Per-round artefacts for one fix inside a multi-fix run.
   *
   * Fixes share a worktree but not a namespace: each keeps its own rounds so a
   * later fix cannot overwrite the audit trail of an earlier one.
   */
  fixRoundPath(fixIndex, round, name) {
    return path.join(this.root, 'fixes', String(fixIndex), 'rounds', String(round), name);
  }

  promptPath(jobId) {
    return path.join(this.root, 'prompts', `${jobId}.md`);
  }

  rawPath(provider, jobId, suffix) {
    return path.join(this.root, 'raw', provider, `${jobId}.${suffix}`);
  }

  normalizedPath(provider, jobId) {
    return path.join(this.root, 'normalized', provider, `${jobId}.json`);
  }

  async init() {
    for (const dir of [
      this.root,
      path.join(this.root, 'baseline'),
      path.join(this.root, 'prompts'),
      path.join(this.root, 'raw', 'claude'),
      path.join(this.root, 'raw', 'codex'),
      path.join(this.root, 'normalized', 'claude'),
      path.join(this.root, 'normalized', 'codex')
    ]) {
      await mkdir(dir, { recursive: true });
    }
    return this;
  }

  async writeRun(run) {
    await atomicWriteJson(this.runJsonPath, run);
  }

  async readRun() {
    return readJsonIfExists(this.runJsonPath);
  }

  /**
   * Job history is an append-only log. `readJobs` replays it, so the last record
   * written for a job id wins and an interrupted append can never corrupt an
   * earlier successful record.
   */
  async appendJob(record) {
    await mkdir(this.root, { recursive: true });
    await appendFile(this.jobsPath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  async readJobs() {
    let text;
    try {
      text = await readFile(this.jobsPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return new Map();
      throw error;
    }
    const jobs = new Map();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed);
        if (record?.jobId) jobs.set(record.jobId, record);
      } catch {
        // A torn final line from an interrupted append is discarded, not fatal.
      }
    }
    return jobs;
  }

  async writePrompt(jobId, contents) {
    await atomicWrite(this.promptPath(jobId), contents);
  }

  async writeNormalized(provider, jobId, value) {
    await atomicWriteJson(this.normalizedPath(provider, jobId), value);
  }

  async readNormalized(provider, jobId) {
    return readJsonIfExists(this.normalizedPath(provider, jobId));
  }

  async writeCandidates(value) {
    await atomicWriteJson(this.candidatesPath, value);
  }

  async readCandidates() {
    return readJsonIfExists(this.candidatesPath);
  }

  async writeVerdicts(value) {
    await atomicWriteJson(this.verdictsPath, value);
  }

  async readVerdicts() {
    return readJsonIfExists(this.verdictsPath);
  }

  async writeComparison(value) {
    await atomicWriteJson(this.comparisonPath, value);
  }

  async readComparison() {
    return readJsonIfExists(this.comparisonPath);
  }

  async writeFixPlan(value) {
    await atomicWriteJson(this.fixPlanPath, value);
  }

  async readFixPlan() {
    return readJsonIfExists(this.fixPlanPath);
  }

  async writeReport(markdown) {
    await atomicWrite(this.reportPath, markdown);
  }
}

export async function listRunIds(repoRoot) {
  try {
    const entries = await readdir(path.join(repoRoot, RUNS_DIRNAME), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** Run ids sort lexicographically by UTC timestamp, so the last one is the newest. */
export async function latestRunId(repoRoot) {
  const ids = await listRunIds(repoRoot);
  return ids.length ? ids[ids.length - 1] : null;
}
