#!/usr/bin/env node
import path from 'node:path';

import { PipelineError, USAGE, UsageError, invocation, parseArgs } from './lib/cli.mjs';
import { resolveManifestPath, resolveRepoRoot } from './lib/config.mjs';
import { DEFAULT_MAX_FIXES, runFix } from './lib/fix.mjs';
import { DEFAULT_MAX_ROUNDS, loadImplementContext, runImplement } from './lib/implement.mjs';
import { loadContext, regenerateArtifacts, runReport, runScan } from './lib/pipeline.mjs';
import { runBaseline, runToolingChecks } from './lib/preflight.mjs';
import { resolveCommand, runCapture } from './lib/proc.mjs';
import { RUNS_DIRNAME, RunStore, atomicWriteJson, formatRunId, latestRunId } from './lib/run-store.mjs';
import { removeWorktree } from './lib/worktree.mjs';

function log(message = '') {
  process.stdout.write(`${message}\n`);
}

/**
 * Preflight makes no paid model calls: version probes, git plumbing, manifest
 * path checks, and the repository's own deterministic baseline.
 */
async function commandPreflight({ repoRoot, manifestPath }) {
  const context = await loadContext(repoRoot, manifestPath);
  log(`Preflight for ${repoRoot}`);
  log(`Manifest: ${manifestPath}`);
  log('');

  const tooling = await runToolingChecks({ repoRoot, manifest: context.manifest });
  for (const check of tooling.checks) {
    const marker = check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL';
    log(`  [${marker}] ${check.name}`);
    if (check.status !== 'pass' && check.detail) {
      for (const line of String(check.detail).split('\n').slice(0, 12)) log(`         ${line}`);
    }
  }

  const fatalFailures = tooling.checks.filter((check) => check.status === 'fail');

  log('');
  log('Baseline (deterministic, no model calls):');
  const baseline = await runBaseline({
    repoRoot,
    manifest: context.manifest,
    onProgress: (command) => log(`  running ${command.command} ${command.args.join(' ')} ...`)
  });
  if (!baseline.configured) {
    log('  none configured — add a "baseline" array to the manifest to get regression checks.');
  }
  for (const check of baseline.checks) {
    log(`  [${check.status === 'succeeded' ? 'PASS' : 'FAIL'}] ${check.name} (exit ${check.exitCode ?? '—'})`);
  }
  const baselineFailures = baseline.checks.filter((check) => check.status !== 'succeeded');

  const record = {
    generatedAt: new Date().toISOString(),
    repoRoot,
    commit: tooling.commit,
    versions: tooling.versions,
    manifestHash: context.manifestHash,
    checks: tooling.checks,
    baseline: baseline.checks
  };
  const targets = [path.join(repoRoot, RUNS_DIRNAME, 'preflight', 'latest.json')];
  if (tooling.commit) targets.push(path.join(repoRoot, RUNS_DIRNAME, 'preflight', `${tooling.commit}.json`));
  for (const target of targets) await atomicWriteJson(target, { ...record, checks: tooling.checks });

  log('');
  if (baselineFailures.length) {
    log(
      `${baselineFailures.length} baseline check(s) are already failing at this commit. They are recorded as pre-existing, not as model-discovered bugs.`
    );
  }
  if (fatalFailures.length) {
    log(`Preflight FAILED: ${fatalFailures.map((check) => check.name).join(', ')}`);
    return 1;
  }
  log('Preflight passed. Baseline snapshot stored under .debug-runs/preflight/.');
  return 0;
}

/**
 * Resolve the task text for an implement run.
 *
 * `--task` is used verbatim. `--candidate` is looked up in a completed scan
 * run's candidates, so the implementer works from the same evidence the scan
 * produced rather than a re-description of it.
 */
async function resolveTask(options, repoRoot) {
  if (options.task) return { task: options.task, candidateId: null };

  const runId = options.latest ? await latestRunId(repoRoot) : options.run;
  if (!runId) throw new PipelineError('No scan run found to read --candidate from.');
  const scanStore = new RunStore(repoRoot, runId);
  const candidates = await scanStore.readCandidates();
  // Candidates are stored camelCase (`dedupeCandidates`), and a short id is what
  // the report prints, so accept either form of either field.
  const found = candidates?.candidates?.find(
    (entry) =>
      entry.candidateId === options.candidate ||
      entry.shortId === options.candidate ||
      entry.candidate_id === options.candidate
  );
  if (!found) {
    throw new PipelineError(`Candidate "${options.candidate}" not found in run ${runId}.`);
  }
  const task = [
    `Fix this bug, found by a prior adversarial scan of ${runId}.`,
    '',
    `Title: ${found.title ?? found.candidateId}`,
    `File: ${found.file ?? 'unknown'}${found.lineStart ? `:${found.lineStart}-${found.lineEnd}` : ''}`,
    `Symbol: ${found.symbol ?? 'unknown'}`,
    '',
    found.failurePath ?? found.failure_path ?? '',
    '',
    found.observableImpact ? `Observable impact: ${found.observableImpact}` : ''
  ].join('\n');
  return { task, candidateId: found.candidateId ?? options.candidate };
}

/**
 * Fix a batch of a scan run's verified findings.
 *
 * A separate command from `scan` on purpose: scanning is read-only and cheap to
 * repeat, while this writes code and costs real model spend. Nothing here runs
 * until someone has read the comparison report and asked for it.
 */
async function commandFix(options, { repoRoot, manifestPath }) {
  if (options.clean) {
    const store = new RunStore(repoRoot, options.clean);
    const removed = await removeWorktree({
      repoRoot,
      worktreePath: store.worktreePath,
      runId: options.clean
    });
    log(`Removed worktree for ${options.clean}${removed.branchRemoved ? ` and branch ${removed.branch}` : ''}.`);
    return 0;
  }

  const git = await resolveCommand('git');
  if (!git) throw new PipelineError('git not found on PATH.');
  const status = await runCapture(git, ['status', '--porcelain'], { cwd: repoRoot, timeoutMs: 60_000 });
  if (status.status !== 'succeeded') throw new PipelineError('Could not read git state.');
  if (status.stdout.trim()) {
    throw new PipelineError(
      `Working tree is not clean. The fix pipeline branches from the scan's commit, so uncommitted work would not be included.\n${status.stdout.trim().slice(0, 800)}`
    );
  }

  const scanRunId = options.latest ? await latestRunId(repoRoot) : options.run;
  if (!scanRunId) throw new PipelineError('No scan run found to fix from.');
  const scanStore = new RunStore(repoRoot, scanRunId);
  const scanRun = await scanStore.readRun();
  if (!scanRun) throw new PipelineError(`Run ${scanRunId} not found under ${RUNS_DIRNAME}/`);

  // Recompute promotions from stored data rather than trusting a cached report:
  // no model calls, and it picks up any prompt or policy change since the scan.
  const { promoted } = await regenerateArtifacts({ store: scanStore, repoRoot, log: () => {} });

  const context = await loadImplementContext(manifestPath);
  const runId = formatRunId(new Date(), scanRun.commit);
  const store = await new RunStore(repoRoot, runId).init();

  log(`Fix run ${runId} from scan ${scanRunId} at ${scanRun.commit.slice(0, 7)}`);

  const run = await runFix({
    repoRoot,
    store,
    context,
    commit: scanRun.commit,
    promoted,
    implementer: options.provider ?? 'claude',
    maxFixes: options['max-fixes'] ? Number(options['max-fixes']) : DEFAULT_MAX_FIXES,
    maxRounds: options['max-rounds'] ? Number(options['max-rounds']) : DEFAULT_MAX_ROUNDS,
    includeTiebroken: Boolean(options['include-tiebroken']),
    skipBaseline: Boolean(options['skip-baseline']),
    log
  });

  log('');
  log(`Status: ${run.status} — ${run.accepted}/${run.fixes.length} fix(es) accepted.`);
  for (const fix of run.fixes) {
    log(`  ${fix.status === 'accepted' ? 'ok  ' : 'FAIL'} ${fix.shortId} ${fix.title} (${fix.status})`);
  }
  log(`Worktree kept at ${store.worktreePath}`);
  log(`Review the batch with: git -C "${store.worktreePath}" log --patch ${scanRun.commit}..HEAD`);
  log(`Remove it with: ${invocation('fix', `--clean ${runId}`)}`);
  // A partially accepted batch still needs a human, so only a clean sweep is a success.
  return run.status === 'accepted' ? 0 : 1;
}

async function commandImplement(options, { repoRoot, manifestPath }) {
  if (options.clean) {
    const store = new RunStore(repoRoot, options.clean);
    const removed = await removeWorktree({
      repoRoot,
      worktreePath: store.worktreePath,
      runId: options.clean
    });
    log(`Removed worktree for ${options.clean}${removed.branchRemoved ? ` and branch ${removed.branch}` : ''}.`);
    return 0;
  }

  const git = await resolveCommand('git');
  if (!git) throw new PipelineError('git not found on PATH.');
  const head = await runCapture(git, ['rev-parse', 'HEAD'], { cwd: repoRoot, timeoutMs: 30_000 });
  const status = await runCapture(git, ['status', '--porcelain'], { cwd: repoRoot, timeoutMs: 60_000 });
  if (head.status !== 'succeeded' || status.status !== 'succeeded') {
    throw new PipelineError('Could not read git state.');
  }
  // The worktree is branched from HEAD, so a dirty checkout would mean the
  // implementer works against code the user can still be editing underneath it.
  if (status.stdout.trim()) {
    throw new PipelineError(
      `Working tree is not clean. The implement pipeline branches from HEAD, so uncommitted work would not be included.\n${status.stdout.trim().slice(0, 800)}`
    );
  }
  const commit = head.stdout.trim();

  const { task, candidateId } = await resolveTask(options, repoRoot);
  const context = await loadImplementContext(manifestPath);
  const runId = formatRunId(new Date(), commit);
  const store = await new RunStore(repoRoot, runId).init();

  log(`Implement run ${runId} at ${commit.slice(0, 7)}`);
  log(`Task: ${task.split('\n')[0]}`);

  const run = await runImplement({
    repoRoot,
    store,
    context,
    commit,
    task,
    candidateId,
    implementer: options.provider ?? 'claude',
    maxRounds: options['max-rounds'] ? Number(options['max-rounds']) : DEFAULT_MAX_ROUNDS,
    skipBaseline: Boolean(options['skip-baseline']),
    log
  });

  log('');
  log(`Status: ${run.status} after ${run.rounds.length} round(s).`);
  log(`Worktree kept at ${store.worktreePath}`);
  log(`Review the change with: git -C "${store.worktreePath}" diff --cached`);
  log(`Remove it with: ${invocation('implement', `--clean ${runId}`)}`);
  // Only an accepted change is a success; everything else needs a human.
  return run.status === 'accepted' ? 0 : 1;
}

async function main() {
  // `--help` must work before any repository or manifest is resolved, so that a
  // misconfigured checkout can still tell the user what the flags are.
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    log(USAGE);
    return argv.length === 0 ? 1 : 0;
  }

  let parsed;
  let repoRoot;
  let manifestPath;
  try {
    // Parsed twice: once to read --repo-root/--manifest, then again with the
    // shard ids that manifest defines so an unknown --shard is caught here.
    const bootstrap = parseArgs(argv);
    repoRoot = await resolveRepoRoot(bootstrap.options['repo-root']);
    manifestPath = await resolveManifestPath(repoRoot, bootstrap.options.manifest);
    const context = await loadContext(repoRoot, manifestPath);
    parsed = parseArgs(argv, { shardIds: context.manifest.shards.map((shard) => shard.id) });
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}\n`);
      return 1;
    }
    throw error;
  }

  const target = { repoRoot, manifestPath };

  switch (parsed.command) {
    case 'help':
      log(USAGE);
      return 0;
    case 'preflight':
      return commandPreflight(target);
    case 'scan':
      return runScan({ ...target, options: parsed.options, mode: 'scan', log });
    case 'resume':
      return runScan({ ...target, options: parsed.options, mode: 'resume', log });
    case 'report':
      return runReport({ ...target, options: parsed.options, log });
    case 'implement':
      return commandImplement(parsed.options, target);
    case 'fix':
      return commandFix(parsed.options, target);
    default:
      process.stderr.write(`${USAGE}\n`);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    // Expected operational failures get a message; anything else gets a stack.
    process.stderr.write(error instanceof PipelineError ? `${error.message}\n` : `${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
