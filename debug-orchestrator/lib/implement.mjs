import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import * as claudeAdapter from './providers/claude.mjs';
import * as codexAdapter from './providers/codex.mjs';
import { PipelineError } from './cli.mjs';
import { hashObject, sha256Hex, shortHash } from './hash.mjs';
import { ORCHESTRATOR_DIR, normalizeBaseline, readManifest } from './config.mjs';
import { resolveCommand, runCapture } from './proc.mjs';
import { atomicWrite, atomicWriteJson } from './run-store.mjs';
import { assertSubset, toProviderSchema, validate } from './validate.mjs';
import { captureDiff, createWorktree, linkDependencies } from './worktree.mjs';

export const ADAPTERS = { claude: claudeAdapter, codex: codexAdapter };
export const PHASES = ['fixplan', 'plan', 'critique', 'implement', 'review'];
export const DEFAULT_MAX_ROUNDS = 3;

/** Phase → which schema its output must match. */
const PHASE_SCHEMA = {
  fixplan: 'fixplan',
  plan: 'plan',
  critique: 'review',
  implement: 'implementation',
  review: 'review'
};

/** Only the implement phase writes; everything else is read-only by contract. */
const PHASE_MODE = {
  fixplan: 'read-only',
  plan: 'read-only',
  critique: 'read-only',
  implement: 'write',
  review: 'read-only'
};

/**
 * Load prompts, schemas, and the manifest for an implement run.
 *
 * Mirrors `pipeline.loadContext`, but over this pipeline's four prompts and
 * three schemas. Hashes feed job input hashes, so editing a prompt or schema
 * invalidates every job built from it.
 */
export async function loadImplementContext(manifestPath) {
  const { manifest, text: manifestText } = await readManifest(manifestPath);

  const prompts = {};
  const promptHashes = {};
  for (const name of PHASES) {
    prompts[name] = await readFile(path.join(ORCHESTRATOR_DIR, 'prompts', `${name}.md`), 'utf8');
    promptHashes[name] = sha256Hex(prompts[name]);
  }

  const schemas = {};
  const schemaHashes = {};
  const providerSchemas = {};
  for (const name of ['fixplan', 'plan', 'review', 'implementation']) {
    const text = await readFile(path.join(ORCHESTRATOR_DIR, 'schemas', `${name}.schema.json`), 'utf8');
    schemas[name] = JSON.parse(text);
    assertSubset(schemas[name]);
    schemaHashes[name] = sha256Hex(text);
    providerSchemas[name] = toProviderSchema(schemas[name]);
  }

  return {
    manifest,
    manifestHash: sha256Hex(manifestText),
    prompts,
    promptHashes,
    schemas,
    schemaHashes,
    providerSchemas
  };
}

export function renderTemplate(template, values) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.split(`{{${key}}}`).join(String(value)),
    template
  );
}

/**
 * Stable identity for a run's task.
 *
 * A scan candidate has an id already. A free-form task has none, so its
 * normalized text is hashed — that keeps resume keys and report anchors working
 * for both entry points without inventing a fake candidate id.
 */
export function taskIdentity({ candidateId = null, task = '' }) {
  if (candidateId) return { kind: 'candidate', id: candidateId };
  return { kind: 'task', id: `task-${shortHash(sha256Hex(String(task).trim()))}` };
}

export function inputHashFor({ commit, provider, modelConfig, phase, round, promptHash, schemaHash, priorHash }) {
  return hashObject({ commit, provider, modelConfig, phase, round, promptHash, schemaHash, priorHash });
}

/**
 * Which provider plays which role.
 *
 * Roles are not symmetric here, unlike scan's mutual cross-examination, so the
 * pairing is explicit: whoever implements, the *other* one reviews.
 */
export function assignRoles(implementer = 'claude') {
  if (implementer !== 'claude' && implementer !== 'codex') {
    throw new PipelineError(`Unknown implementer "${implementer}". Expected claude or codex.`);
  }
  return { implementer, reviewer: implementer === 'claude' ? 'codex' : 'claude' };
}

/**
 * A finding without a concrete failure scenario is a nit, whatever severity the
 * reviewer claimed.
 *
 * This is load-bearing for convergence: without it a reviewer can block forever
 * on taste, and the loop only ever ends by hitting the round cap.
 */
export function normalizeReview(data) {
  const findings = (data?.findings ?? []).map((finding) => {
    const concrete = typeof finding.failure_scenario === 'string' && finding.failure_scenario.trim().length > 0;
    return {
      ...finding,
      severity: concrete ? finding.severity : 'nit',
      downgraded: !concrete && finding.severity !== 'nit'
    };
  });
  const blocking = findings.filter((finding) => finding.severity === 'blocking');
  return {
    verdict: blocking.length ? 'revise' : 'accept',
    claimedVerdict: data?.verdict ?? null,
    rationale: data?.rationale ?? '',
    findings,
    blockingCount: blocking.length
  };
}

/** Run the repository's own checks inside the worktree. */
export async function runBaselineInWorktree({ worktreePath, manifest, log = () => {} }) {
  const configured = normalizeBaseline(manifest ?? {});
  // An empty baseline means "this repository has no such command", which must
  // read as nothing-to-check rather than as a failing round.
  if (!configured.length) return { ok: true, commands: [], error: null };

  const commands = [];
  for (const command of configured) {
    log(`    baseline: ${command.name}`);
    const binary = await resolveCommand(command.command);
    if (!binary) {
      return { ok: false, commands, error: `${command.command} not found on PATH` };
    }
    const result = await runCapture(binary, command.args, { cwd: worktreePath, timeoutMs: 15 * 60 * 1000 });
    commands.push({
      name: command.name,
      status: result.status,
      exitCode: result.exitCode,
      tail: `${result.stdout}${result.stderr}`.trim().slice(-2000)
    });
  }
  return { ok: commands.every((entry) => entry.status === 'succeeded'), commands, error: null };
}

/** The failing command names, used by the repeated-failure stop condition. */
function failureSignature(baseline) {
  return (baseline?.commands ?? [])
    .filter((entry) => entry.status !== 'succeeded')
    .map((entry) => entry.name)
    .sort()
    .join(',');
}

export async function executePhase({
  store,
  context,
  repoRoot,
  worktreePath,
  provider,
  phase,
  round,
  prompt,
  timeoutMs,
  modelConfig,
  adapters,
  log,
  jobSuffix = ''
}) {
  const schemaName = PHASE_SCHEMA[phase];
  const schema = context.schemas[schemaName];
  const providerSchema = context.providerSchemas[schemaName];
  const providerSchemaPath = path.join(store.root, 'schemas', `${schemaName}.provider.json`);
  await mkdir(path.dirname(providerSchemaPath), { recursive: true });
  await atomicWriteJson(providerSchemaPath, providerSchema);

  // The suffix keeps fixes in a shared run distinct: `jobs.jsonl` replays
  // last-record-per-jobId, so two fixes both writing `plan-claude-r0` would
  // erase the first one's audit trail.
  const jobId = `${phase}-${provider}-r${round}${jobSuffix}`;
  await store.writePrompt(jobId, prompt);
  const rawOutputPath = store.rawPath(provider, jobId, 'stdout.log');
  const rawErrorPath = store.rawPath(provider, jobId, 'stderr.log');
  const resultPath = store.rawPath(provider, jobId, 'result.json');
  await mkdir(path.dirname(rawOutputPath), { recursive: true });

  const mode = PHASE_MODE[phase];
  const startedAt = new Date().toISOString();
  const outcome = await adapters[provider].runJob({
    jobId,
    phase,
    // The implementer is spawned in the worktree; readers see it too, since the
    // code under discussion lives there and not at the original commit.
    repoRoot: worktreePath,
    prompt,
    schema,
    providerSchema,
    schemaPath: providerSchemaPath,
    resultPath,
    rawOutputPath,
    rawErrorPath,
    timeoutMs,
    modelConfig,
    mode,
    worktreePath
  });

  let status = outcome.status;
  let errorSummary = outcome.metadata?.errorSummary ?? null;
  if (status === 'succeeded') {
    const check = validate(schema, outcome.data);
    if (!check.valid) {
      status = 'failed';
      errorSummary = `${phase} output failed schema validation: ${check.errors.slice(0, 5).join('; ')}`;
    }
  }

  const record = {
    jobId,
    provider,
    phase,
    round,
    status,
    mode,
    command: outcome.metadata?.command ?? null,
    argv: outcome.metadata?.argv ?? [],
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: outcome.exitCode ?? null,
    errorSummary,
    warnings: outcome.metadata?.warnings ?? [],
    durationMs: outcome.metadata?.durationMs ?? null,
    totalCostUsd: outcome.metadata?.totalCostUsd ?? null
  };
  await store.appendJob(record);

  log(`  ${status === 'succeeded' ? 'ok  ' : 'FAIL'} ${jobId}${errorSummary ? ` — ${errorSummary.slice(0, 160)}` : ''}`);
  if (status !== 'succeeded') {
    throw new PipelineError(`${phase} job ${jobId} did not succeed: ${errorSummary ?? status}`);
  }
  return { data: outcome.data, record };
}

/**
 * Run the adversarial implement pipeline.
 *
 * plan → critique → implement → review, looping implement/review until the
 * reviewer accepts or a stop condition fires. Every phase writes its prompt,
 * raw output, and job record, so a run is auditable after the fact.
 */
export async function runImplement({
  repoRoot,
  store,
  context,
  commit,
  task,
  candidateId = null,
  implementer = 'claude',
  maxRounds = DEFAULT_MAX_ROUNDS,
  adapters = ADAPTERS,
  log = () => {},
  skipBaseline = false,
  // Set by a multi-fix run: the worktree is already built and shared, and this
  // fix's artefacts nest under `fixes/<index>/` so it cannot overwrite another's.
  fixIndex = null,
  persistRun = true
}) {
  const roles = assignRoles(implementer);
  const identity = taskIdentity({ candidateId, task });
  const providerConfig = context.manifest.providers ?? {};
  const timeouts = context.manifest.timeoutsMinutes ?? {};
  const timeoutFor = (phase) => (timeouts[phase] ?? 30) * 60 * 1000;
  const shared = fixIndex !== null;
  const artefactPath = (round, name) => (shared ? store.fixRoundPath(fixIndex, round, name) : store.roundPath(round, name));
  const jobSuffix = shared ? `-f${fixIndex}` : '';

  log(`Worktree: ${store.worktreePath}`);
  // Idempotent when the tree already exists, so a shared worktree is reused
  // rather than rebuilt between fixes.
  const worktree = await createWorktree({
    repoRoot,
    worktreePath: store.worktreePath,
    commit,
    runId: store.runId
  });
  const deps = await linkDependencies({ repoRoot, worktreePath: store.worktreePath });
  log(`  branch ${worktree.branch}${worktree.reused ? ' (reused)' : ''}, node_modules: ${deps.strategy}`);

  const common = {
    COMMIT_SHA: commit,
    WORKTREE_PATH: store.worktreePath,
    TASK: task
  };
  const run = {
    runId: store.runId,
    kind: 'implement',
    commit,
    task,
    identity,
    roles,
    maxRounds,
    fixIndex,
    worktree: { path: store.worktreePath, branch: worktree.branch, dependencies: deps },
    rounds: [],
    status: 'running',
    startedAt: new Date().toISOString()
  };
  // A fix run owns run.json for the batch as a whole; a single fix inside it
  // must not overwrite that with its own record.
  if (persistRun) await store.writeRun(run);

  // ---- Phase 1: plan -----------------------------------------------------
  const planOut = await executePhase({
    store,
    context,
    repoRoot,
    worktreePath: store.worktreePath,
    provider: roles.implementer,
    phase: 'plan',
    round: 0,
    prompt: renderTemplate(context.prompts.plan, common),
    timeoutMs: timeoutFor('plan'),
    modelConfig: providerConfig[roles.implementer] ?? {},
    adapters,
    log,
    jobSuffix
  });
  await atomicWriteJson(artefactPath(0, 'plan.json'), planOut.data);

  // ---- Phase 2: critique -------------------------------------------------
  const critiqueOut = await executePhase({
    store,
    context,
    repoRoot,
    worktreePath: store.worktreePath,
    provider: roles.reviewer,
    phase: 'critique',
    round: 0,
    prompt: renderTemplate(context.prompts.critique, {
      ...common,
      PLAN_JSON: JSON.stringify(planOut.data, null, 2)
    }),
    timeoutMs: timeoutFor('critique'),
    modelConfig: providerConfig[roles.reviewer] ?? {},
    adapters,
    log,
    jobSuffix
  });
  const critique = normalizeReview(critiqueOut.data);
  await atomicWriteJson(artefactPath(0, 'critique.json'), critique);
  log(`  critique: ${critique.verdict} (${critique.blockingCount} blocking)`);

  // ---- Phases 3–4: implement / review loop -------------------------------
  let review = critique;
  let previousDiffHash = null;
  let previousFailureSignature = null;
  let outcome = 'unconverged';

  for (let round = 1; round <= maxRounds; round += 1) {
    log(`Round ${round}/${maxRounds}`);

    const implementOut = await executePhase({
      store,
      context,
      repoRoot,
      worktreePath: store.worktreePath,
      provider: roles.implementer,
      phase: 'implement',
      round,
      prompt: renderTemplate(context.prompts.implement, {
        ...common,
        PLAN_JSON: JSON.stringify(planOut.data, null, 2),
        REVIEW_JSON: JSON.stringify(review.findings.filter((f) => f.severity === 'blocking'), null, 2)
      }),
      timeoutMs: timeoutFor('implement'),
      modelConfig: providerConfig[roles.implementer] ?? {},
      adapters,
      log,
      jobSuffix
    });

    const captured = await captureDiff({ worktreePath: store.worktreePath });
    await atomicWrite(artefactPath(round, 'diff.patch'), captured.diff);
    const diffHash = sha256Hex(captured.diff);

    if (!captured.diff.trim()) {
      log('  stop: implementer produced no changes');
      outcome = 'no-changes';
      break;
    }
    // No-progress guard: an identical diff means the implementer stopped
    // responding to the review, and another round would repeat it verbatim.
    if (diffHash === previousDiffHash) {
      log('  stop: diff unchanged since the previous round');
      outcome = 'stalled';
      break;
    }
    previousDiffHash = diffHash;

    const baseline = skipBaseline
      ? { ok: true, commands: [], error: 'skipped' }
      : await runBaselineInWorktree({
          worktreePath: store.worktreePath,
          manifest: context.manifest,
          log
        });
    await atomicWriteJson(artefactPath(round, 'baseline.json'), baseline);

    const signature = failureSignature(baseline);
    if (signature && signature === previousFailureSignature) {
      log(`  stop: baseline failed identically twice (${signature})`);
      outcome = 'baseline-stuck';
      break;
    }
    previousFailureSignature = signature || null;

    const reviewOut = await executePhase({
      store,
      context,
      repoRoot,
      worktreePath: store.worktreePath,
      provider: roles.reviewer,
      phase: 'review',
      round,
      prompt: renderTemplate(context.prompts.review, {
        ...common,
        SUMMARY: implementOut.data.summary,
        ASSUMPTIONS: JSON.stringify(implementOut.data.assumptions ?? [], null, 2),
        FILES_CHANGED: captured.filesChanged.join('\n') || '(none)',
        DIFF: captured.diff,
        BASELINE_JSON: JSON.stringify(baseline.commands, null, 2)
      }),
      timeoutMs: timeoutFor('review'),
      modelConfig: providerConfig[roles.reviewer] ?? {},
      adapters,
      log,
      jobSuffix
    });
    review = normalizeReview(reviewOut.data);
    await atomicWriteJson(artefactPath(round, 'review.json'), review);

    run.rounds.push({
      round,
      diffHash: shortHash(diffHash),
      filesChanged: captured.filesChanged,
      diffTruncated: captured.truncated,
      baselineOk: baseline.ok,
      verdict: review.verdict,
      blockingCount: review.blockingCount,
      implementComplete: implementOut.data.complete === true
    });
    if (persistRun) await store.writeRun(run);

    log(`  review: ${review.verdict} (${review.blockingCount} blocking), baseline ${baseline.ok ? 'ok' : 'FAILED'}`);

    if (review.verdict === 'accept' && baseline.ok) {
      outcome = 'accepted';
      break;
    }
  }

  run.status = outcome;
  run.finishedAt = new Date().toISOString();
  await store.writeRun(run);
  return run;
}
