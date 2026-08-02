import { cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PipelineError, invocation } from './cli.mjs';
import { applyTiebreaks, compareTracks, disputedComparisons, summarizeComparisons } from './compare.mjs';
import { ORCHESTRATOR_DIR, readManifest } from './config.mjs';
import { dedupeCandidates } from './dedupe.mjs';
import { hashObject, sha256Hex, shortHash } from './hash.mjs';
import {
  NormalizationError,
  createRepoFileReader,
  normalizeChallengeOutput,
  normalizeScoutOutput,
  normalizeTiebreakOutput
} from './normalize.mjs';
import { toChallengePayload } from './payload.mjs';
import { runToolingChecks } from './preflight.mjs';
import { promoteAll } from './promote.mjs';
import { runCapture, resolveCommand } from './proc.mjs';
import { runQueue } from './queue.mjs';
import { renderReport } from './report.mjs';
import { RunStore, atomicWriteJson, formatRunId, latestRunId, readJsonIfExists, RUNS_DIRNAME } from './run-store.mjs';
import { buildTiebreakJobs, collectTiebreaks } from './tiebreak.mjs';
import { TRACKS, tracksFor } from './tracks.mjs';
import { assertSubset, toProviderSchema } from './validate.mjs';
import * as claudeAdapter from './providers/claude.mjs';
import * as codexAdapter from './providers/codex.mjs';

export const MAX_CANDIDATES_PER_CHALLENGE = 10;

export const ADAPTERS = { claude: claudeAdapter, codex: codexAdapter };

export { toChallengePayload };

async function readTextFile(target) {
  return readFile(target, 'utf8');
}

/** Load the manifest, prompts, and schemas once, with the hashes that feed job input hashes. */
export async function loadContext(repoRoot, manifestPath) {
  const { manifest, text: manifestText } = await readManifest(manifestPath);

  const promptNames = ['scout', 'challenge', 'tiebreak', 'reproduce'];
  const prompts = {};
  const promptHashes = {};
  for (const name of promptNames) {
    prompts[name] = await readTextFile(path.join(ORCHESTRATOR_DIR, 'prompts', `${name}.md`));
    promptHashes[name] = sha256Hex(prompts[name]);
  }

  const schemaNames = ['findings', 'verdicts', 'tiebreak', 'reproduction'];
  const schemas = {};
  const schemaHashes = {};
  const providerSchemas = {};
  for (const name of schemaNames) {
    const text = await readTextFile(path.join(ORCHESTRATOR_DIR, 'schemas', `${name}.schema.json`));
    schemas[name] = JSON.parse(text);
    // Fail loudly if a schema grows a keyword the bundled validator would ignore.
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

function renderTemplate(template, values) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.split(`{{${key}}}`).join(String(value)),
    template
  );
}

function inputHashFor({ commit, provider, modelConfig, phase, key, promptHash, schemaHash }) {
  return hashObject({ commit, provider, modelConfig, phase, key, promptHash, schemaHash });
}

/** Build one scout job per (provider, shard) pair, in manifest shard order. */
export function buildScoutJobs({ context, commit, shards, providers }) {
  const jobs = [];
  for (const shard of shards) {
    for (const provider of providers) {
      const modelConfig = context.manifest.providers[provider];
      const prompt = renderTemplate(context.prompts.scout, {
        COMMIT_SHA: commit,
        SHARD_ID: shard.id,
        SHARD_DESCRIPTION: shard.description,
        SHARD_PATHS: shard.paths.map((entry) => `- ${entry}`).join('\n')
      });
      jobs.push({
        jobId: `scout-${provider}-${shard.id}`,
        provider,
        phase: 'scout',
        shard: shard.id,
        prompt,
        schemaName: 'findings',
        modelConfig,
        timeoutMs: context.manifest.timeoutsMinutes.scout * 60_000,
        inputHash: inputHashFor({
          commit,
          provider,
          modelConfig,
          phase: 'scout',
          key: shard.id,
          promptHash: context.promptHashes.scout,
          schemaHash: context.schemaHashes.findings
        })
      });
    }
  }
  return jobs;
}

/**
 * Split deduplicated scout output into one candidate pool per track.
 *
 * Each track dedupes only its own finder's candidates, so a track's pool is the
 * complete, self-consistent view of what that finder discovered. The two pools
 * stay comparable because candidate ids are content hashes: the same defect
 * described by both finders lands on the same id in both pools.
 */
export function splitByTrack(candidates, tracks = TRACKS) {
  const byTrack = new Map();
  for (const track of tracks) {
    const own = candidates.filter((candidate) => candidate.provider === track.finder);
    byTrack.set(track.id, { ...track, ...dedupeCandidates(own) });
  }
  return byTrack;
}

/**
 * Build challenge jobs for both tracks.
 *
 * Routing is now structural rather than computed: a track's findings are always
 * challenged by that track's opposing provider, so a candidate both finders
 * produced is challenged twice — once per track — instead of once by a
 * coin-flipped challenger. That second verdict is what makes the two tracks
 * comparable at all.
 *
 * Track A's jobs are all Codex and Track B's are all Claude, so the queue's
 * per-provider lanes are exactly the two tracks and they drain in parallel.
 */
export function buildChallengeJobs({ context, commit, tracksById }) {
  const jobs = [];

  for (const [trackId, track] of tracksById) {
    const provider = track.challenger;
    const assigned = track.candidates.slice().sort((a, b) => a.candidateId.localeCompare(b.candidateId));

    for (let index = 0; index * MAX_CANDIDATES_PER_CHALLENGE < assigned.length; index += 1) {
      const batch = assigned.slice(index * MAX_CANDIDATES_PER_CHALLENGE, (index + 1) * MAX_CANDIDATES_PER_CHALLENGE);
      const payload = batch.map(toChallengePayload);
      const citedPaths = [...new Set(batch.map((candidate) => candidate.file))];
      const modelConfig = context.manifest.providers[provider];
      const prompt = renderTemplate(context.prompts.challenge, {
        COMMIT_SHA: commit,
        CITED_PATHS: citedPaths.map((entry) => `- ${entry}`).join('\n'),
        CANDIDATES_JSON: JSON.stringify(payload, null, 2)
      });
      jobs.push({
        jobId: `challenge-${trackId}-${provider}-${String(index + 1).padStart(2, '0')}`,
        provider,
        phase: 'challenge',
        shard: null,
        track: trackId,
        prompt,
        schemaName: 'verdicts',
        modelConfig,
        candidateIds: batch.map((candidate) => candidate.candidateId),
        timeoutMs: context.manifest.timeoutsMinutes.challenge * 60_000,
        inputHash: inputHashFor({
          commit,
          provider,
          modelConfig,
          phase: 'challenge',
          // The track is part of the key: the same candidate batch judged for a
          // different track is a different job with a different answer.
          key: `${trackId}:${batch.map((candidate) => candidate.candidateId).join(',')}`,
          promptHash: context.promptHashes.challenge,
          schemaHash: context.schemaHashes.verdicts
        })
      });
    }
  }
  return jobs;
}

async function gitInfo(repoRoot) {
  const git = await resolveCommand('git');
  if (!git) return { commit: null, dirty: null, error: 'git not found on PATH' };
  const head = await runCapture(git, ['rev-parse', 'HEAD'], { cwd: repoRoot, timeoutMs: 30_000 });
  const status = await runCapture(git, ['status', '--porcelain'], { cwd: repoRoot, timeoutMs: 60_000 });
  return {
    commit: head.stdout.trim() || null,
    dirty: status.status === 'succeeded' ? status.stdout.trim() : null,
    error: head.status === 'succeeded' && status.status === 'succeeded' ? null : 'git command failed'
  };
}

/** Execute one job through its provider adapter, writing prompt, raw, and normalized output. */
export async function executeJob({ store, context, job, repoRoot, log = () => {}, adapters = ADAPTERS }) {
  const adapter = adapters[job.provider];
  const schema = context.schemas[job.schemaName];
  const providerSchema = context.providerSchemas[job.schemaName];
  const providerSchemaPath = path.join(store.root, 'schemas', `${job.schemaName}.provider.json`);

  await store.writePrompt(job.jobId, job.prompt);

  const startedAt = new Date().toISOString();
  const rawOutputPath = store.rawPath(job.provider, job.jobId, 'stdout.log');
  const rawErrorPath = store.rawPath(job.provider, job.jobId, 'stderr.log');
  const resultPath = store.rawPath(job.provider, job.jobId, 'result.json');
  await mkdir(path.dirname(rawOutputPath), { recursive: true });

  const outcome = await adapter.runJob({
    jobId: job.jobId,
    phase: job.phase,
    repoRoot,
    prompt: job.prompt,
    schema,
    providerSchema,
    schemaPath: providerSchemaPath,
    resultPath,
    rawOutputPath,
    rawErrorPath,
    normalizedOutputPath: store.normalizedPath(job.provider, job.jobId),
    timeoutMs: job.timeoutMs,
    modelConfig: job.modelConfig
  });

  let status = outcome.status;
  let errorSummary = outcome.metadata?.errorSummary ?? null;
  let normalized = null;

  if (status === 'succeeded') {
    try {
      switch (job.phase) {
        case 'scout':
          normalized = await normalizeScoutOutput({
            data: outcome.data,
            schema,
            provider: job.provider,
            shardId: job.shard,
            jobId: job.jobId,
            runId: store.runId,
            fileReader: createRepoFileReader(repoRoot)
          });
          break;
        case 'challenge':
          normalized = {
            provider: job.provider,
            jobId: job.jobId,
            track: job.track ?? null,
            verdicts: normalizeChallengeOutput({
              data: outcome.data,
              schema,
              challenger: job.provider,
              track: job.track ?? null,
              jobId: job.jobId,
              runId: store.runId,
              expectedCandidateIds: job.candidateIds
            })
          };
          break;
        case 'tiebreak':
          normalized = {
            provider: job.provider,
            jobId: job.jobId,
            tiebreaks: normalizeTiebreakOutput({
              data: outcome.data,
              schema,
              tiebreaker: job.provider,
              jobId: job.jobId,
              runId: store.runId,
              expectedCandidateIds: job.candidateIds
            })
          };
          break;
        default:
          throw new NormalizationError(`no normalizer registered for phase "${job.phase}"`);
      }
      await store.writeNormalized(job.provider, job.jobId, normalized);
    } catch (error) {
      status = 'failed';
      errorSummary =
        error instanceof NormalizationError
          ? `${error.message}${error.errors?.length ? `: ${error.errors.slice(0, 5).join('; ')}` : ''}`
          : String(error?.message ?? error);
      normalized = null;
    }
  }

  const record = {
    jobId: job.jobId,
    provider: job.provider,
    phase: job.phase,
    shard: job.shard,
    track: job.track ?? null,
    status,
    command: outcome.metadata?.command ?? null,
    argv: outcome.metadata?.argv ?? [],
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: outcome.exitCode ?? null,
    outputPaths: {
      prompt: path.relative(store.root, store.promptPath(job.jobId)),
      raw: path.relative(store.root, rawOutputPath),
      rawError: path.relative(store.root, rawErrorPath),
      result: job.provider === 'codex' ? path.relative(store.root, resultPath) : null,
      normalized: normalized ? path.relative(store.root, store.normalizedPath(job.provider, job.jobId)) : null
    },
    inputHash: job.inputHash,
    candidateIds: job.candidateIds ?? null,
    errorSummary,
    warnings: outcome.metadata?.warnings ?? [],
    durationMs: outcome.metadata?.durationMs ?? null,
    totalCostUsd: outcome.metadata?.totalCostUsd ?? null
  };

  log(`  ${status === 'succeeded' ? 'ok  ' : 'FAIL'} ${job.jobId}${errorSummary ? ` — ${errorSummary.slice(0, 160)}` : ''}`);
  return { status, record, normalized };
}

/**
 * Run a set of jobs, reusing cached results whose inputs are unchanged.
 *
 * A cached job is only reused when its recorded status is `succeeded`, its input
 * hash matches, and its normalized output still parses. A raw output file alone
 * is never treated as proof of success.
 */
export async function runPhase({
  store,
  context,
  jobs,
  repoRoot,
  previousJobs = new Map(),
  log = () => {},
  reuseCache = false,
  adapters = ADAPTERS
}) {
  const outputs = new Map();
  const records = new Map();
  const toRun = [];

  for (const job of jobs) {
    const previous = reuseCache ? previousJobs.get(job.jobId) : null;
    if (previous && previous.status === 'succeeded' && previous.inputHash === job.inputHash) {
      const normalized = await store.readNormalized(job.provider, job.jobId);
      if (normalized) {
        log(`  skip ${job.jobId} (cached, inputs unchanged)`);
        const record = { ...previous, status: 'skipped', reusedFrom: previous.status, skippedAt: new Date().toISOString() };
        await store.appendJob(record);
        records.set(job.jobId, record);
        outputs.set(job.jobId, normalized);
        continue;
      }
      log(`  rerun ${job.jobId} (cached result no longer parses)`);
    } else if (previous && reuseCache) {
      log(`  rerun ${job.jobId} (${previous.inputHash === job.inputHash ? `previous status ${previous.status}` : 'inputs changed'})`);
    }
    toRun.push(job);
  }

  if (toRun.length) {
    const { results, laneErrors } = await runQueue({
      jobs: toRun,
      concurrency: context.manifest.concurrency,
      execute: async (job) => {
        const outcome = await executeJob({ store, context, job, repoRoot, log, adapters });
        return { status: outcome.status, record: outcome.record, normalized: outcome.normalized };
      }
    });

    for (const entry of results) {
      const result = entry.result;
      if (result?.record) {
        const record = { ...result.record, attempts: entry.attempts };
        await store.appendJob(record);
        records.set(entry.job.jobId, record);
      } else {
        const record = {
          jobId: entry.job.jobId,
          provider: entry.job.provider,
          phase: entry.job.phase,
          shard: entry.job.shard,
          track: entry.job.track ?? null,
          status: 'failed',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          exitCode: null,
          inputHash: entry.job.inputHash,
          errorSummary: result?.errorSummary ?? 'job produced no record',
          attempts: entry.attempts,
          outputPaths: {}
        };
        await store.appendJob(record);
        records.set(entry.job.jobId, record);
      }
      if (result?.normalized) outputs.set(entry.job.jobId, result.normalized);
    }

    for (const error of laneErrors) log(`  queue lane error: ${error}`);
  }

  return { outputs, records };
}

function collectScoutResults(outputs) {
  const candidates = [];
  const residualRisks = [];
  for (const normalized of outputs.values()) {
    if (!normalized?.candidates) continue;
    candidates.push(...normalized.candidates);
    for (const risk of normalized.residualRisks ?? []) {
      residualRisks.push({ shard: normalized.shard, provider: normalized.provider, risk });
    }
  }
  return { candidates, residualRisks };
}

function collectVerdicts(outputs) {
  const verdicts = [];
  for (const normalized of outputs.values()) {
    if (Array.isArray(normalized?.verdicts)) verdicts.push(...normalized.verdicts);
  }
  return verdicts;
}

async function writeProviderSchemas(store, context) {
  for (const [name, schema] of Object.entries(context.providerSchemas)) {
    await atomicWriteJson(path.join(store.root, 'schemas', `${name}.provider.json`), schema);
  }
}

async function attachBaseline(store, repoRoot, commit) {
  const source = path.join(repoRoot, RUNS_DIRNAME, 'preflight', `${commit}.json`);
  const baseline = await readJsonIfExists(source);
  if (!baseline) return null;
  await cp(source, store.baselinePath('baseline.json'));
  return baseline;
}

/**
 * Regenerate candidates, verdicts, and the report from whatever normalized data
 * exists on disk. Makes no model calls, so `report` is always cheap and repeatable.
 */
export async function regenerateArtifacts({ store, repoRoot, log = () => {} }) {
  const run = await store.readRun();
  if (!run) throw new PipelineError(`Run ${store.runId} has no run.json`);
  const jobs = await store.readJobs();

  const scoutOutputs = new Map();
  const challengeOutputs = new Map();
  const tiebreakOutputs = new Map();
  for (const [jobId, record] of jobs) {
    if (record.status !== 'succeeded' && record.status !== 'skipped') continue;
    const normalized = await store.readNormalized(record.provider, jobId);
    if (!normalized) continue;
    if (record.phase === 'scout') scoutOutputs.set(jobId, normalized);
    if (record.phase === 'challenge') challengeOutputs.set(jobId, normalized);
    if (record.phase === 'tiebreak') tiebreakOutputs.set(jobId, normalized);
  }

  const { candidates, residualRisks } = collectScoutResults(scoutOutputs);
  const deduped = dedupeCandidates(candidates);
  const tracksById = splitByTrack(candidates, tracksFor(run.config?.providers ?? ['claude', 'codex']));
  await store.writeCandidates({
    runId: store.runId,
    commit: run.commit,
    generatedAt: new Date().toISOString(),
    rawCandidateCount: candidates.length,
    candidates: deduped.candidates,
    possibleDuplicates: deduped.possibleDuplicates,
    residualRisks,
    tracks: Object.fromEntries(
      [...tracksById].map(([id, track]) => [
        id,
        {
          finder: track.finder,
          challenger: track.challenger,
          candidateIds: track.candidates.map((candidate) => candidate.candidateId),
          count: track.candidates.length
        }
      ])
    )
  });

  const verdicts = collectVerdicts(challengeOutputs);
  await store.writeVerdicts({ runId: store.runId, generatedAt: new Date().toISOString(), verdicts });

  const tiebreaks = collectTiebreaks(tiebreakOutputs);
  const comparisons = applyTiebreaks(compareTracks({ candidates: deduped.candidates, verdicts }), tiebreaks);
  const comparisonSummary = summarizeComparisons(comparisons);
  await store.writeComparison({
    runId: store.runId,
    generatedAt: new Date().toISOString(),
    summary: comparisonSummary,
    comparisons
  });

  const promoted = promoteAll({ candidates: deduped.candidates, comparisons });
  const baseline = await readJsonIfExists(store.baselinePath('baseline.json'));

  const counts = {
    rawCandidates: candidates.length,
    candidates: deduped.candidates.length,
    possibleDuplicates: deduped.possibleDuplicates.length,
    verdicts: verdicts.length,
    tiebreaks: tiebreaks.length,
    verified: promoted.filter((entry) => entry.status === 'verified').length,
    probable: promoted.filter((entry) => entry.status === 'probable').length,
    disputed: promoted.filter((entry) => entry.status === 'disputed').length,
    needsReproduction: promoted.filter((entry) => entry.status === 'needs_reproduction').length,
    rejected: promoted.filter((entry) => entry.status === 'rejected').length,
    jobsFailed: [...jobs.values()].filter((job) => job.status === 'failed' || job.status === 'timed_out').length
  };

  const markdown = renderReport({
    run: { ...run, counts },
    promoted,
    possibleDuplicates: deduped.possibleDuplicates,
    residualRisks,
    jobs: [...jobs.values()],
    baseline,
    comparisonSummary
  });
  await store.writeReport(markdown);
  await store.writeRun({ ...run, counts });
  log(`Report written to ${path.relative(repoRoot, store.reportPath)}`);
  return { counts, promoted, deduped, verdicts, comparisons, tiebreaks };
}

/**
 * Create a new run (`scan`) or continue an existing one (`resume`).
 *
 * Returns an exit code: nonzero when any required scout job is still failed
 * after retries, while still generating a partial report.
 */
export async function runScan({ repoRoot, manifestPath, options, mode = 'scan', log = console.log }) {
  const context = await loadContext(repoRoot, manifestPath);
  if (!context.manifest.shards.length) {
    throw new PipelineError(
      `No shards defined in ${manifestPath}. A shard names a slice of the codebase to scout; ` +
        'see manifest.example.json for the shape.'
    );
  }
  const providers = options.provider ? [options.provider] : ['claude', 'codex'];

  const git = await gitInfo(repoRoot);
  if (!git.commit) throw new PipelineError(`Could not determine HEAD commit: ${git.error ?? 'unknown error'}`);

  let store;
  let run;
  let previousJobs = new Map();

  if (mode === 'resume') {
    const runId = options.run ?? (await latestRunId(repoRoot));
    if (!runId) throw new PipelineError("No runs found to resume.");
    store = new RunStore(repoRoot, runId);
    run = await store.readRun();
    if (!run) throw new PipelineError(`Run ${runId} not found under ${RUNS_DIRNAME}/`);
    await store.init(); // idempotent: restores any directory removed since the original scan
    previousJobs = await store.readJobs();
    if (run.commit !== git.commit) {
      throw new PipelineError(
        `Run ${runId} was created at commit ${run.commit.slice(0, 7)} but HEAD is ${git.commit.slice(0, 7)}. Check out the original commit or start a new scan.`
      );
    }
    log(`Resuming run ${runId} at ${run.commit.slice(0, 7)}`);
  } else {
    if (git.dirty) {
      throw new PipelineError(
        `Working tree is not clean. The MVP requires a clean worktree so findings map to a frozen commit.\n${git.dirty.slice(0, 800)}`
      );
    }
    const runId = formatRunId(new Date(), git.commit);
    store = new RunStore(repoRoot, runId);
    await store.init();
    log(`Starting run ${runId} at ${git.commit.slice(0, 7)}`);
  }

  await writeProviderSchemas(store, context);

  const shards = options.shard
    ? context.manifest.shards.filter((shard) => shard.id === options.shard)
    : run?.config?.shards
      ? context.manifest.shards.filter((shard) => run.config.shards.includes(shard.id))
      : context.manifest.shards;
  if (!shards.length) throw new PipelineError("No shards selected.");

  const effectiveProviders = mode === 'resume' && run?.config?.providers ? run.config.providers : providers;
  const tracks = tracksFor(effectiveProviders);
  // Both tracks need both providers: one to find, the opposing one to verify.
  const completeDiscovery = tracks.length === TRACKS.length;

  const tooling = await runToolingChecks({ repoRoot, manifest: context.manifest });
  const warnings = tooling.checks.filter((check) => check.status !== 'pass').map((check) => `${check.name}: ${check.detail}`);
  if (!completeDiscovery) {
    warnings.push(`Provider-restricted run (${effectiveProviders.join(', ')}): not a complete discovery run, challenge phase skipped.`);
  }

  const startedAt = run?.startedAt ?? new Date().toISOString();
  run = {
    runId: store.runId,
    status: 'running',
    startedAt,
    finishedAt: null,
    commit: git.commit,
    cliVersions: tooling.versions,
    manifestHash: context.manifestHash,
    schemaHashes: context.schemaHashes,
    promptHashes: context.promptHashes,
    config: {
      providers: effectiveProviders,
      shards: shards.map((shard) => shard.id),
      concurrency: context.manifest.concurrency,
      timeoutsMinutes: context.manifest.timeoutsMinutes,
      providerConfig: context.manifest.providers,
      tracks: tracks.map((track) => ({ id: track.id, finder: track.finder, challenger: track.challenger })),
      completeDiscovery
    },
    counts: run?.counts ?? {},
    warnings,
    worktreeUnchanged: null
  };
  await store.writeRun(run);

  const baseline = await attachBaseline(store, repoRoot, git.commit);
  if (!baseline) {
    log(`No preflight baseline recorded for this commit; run \`${invocation('preflight')}\` to capture one.`);
  }

  log(`Discovery: ${shards.length} shard(s) x ${effectiveProviders.length} provider(s)`);
  const scoutJobs = buildScoutJobs({ context, commit: git.commit, shards, providers: effectiveProviders });
  const scoutPhase = await runPhase({
    store,
    context,
    commit: git.commit,
    jobs: scoutJobs,
    repoRoot,
    previousJobs,
    log,
    reuseCache: mode === 'resume'
  });

  const { candidates, residualRisks } = collectScoutResults(scoutPhase.outputs);
  const deduped = dedupeCandidates(candidates);
  const tracksById = splitByTrack(candidates, tracks);
  // Written before the challenge phase so an interrupted run still leaves the
  // discovery result on disk; regenerateArtifacts rewrites it at the end.
  await store.writeCandidates({
    runId: store.runId,
    commit: git.commit,
    generatedAt: new Date().toISOString(),
    rawCandidateCount: candidates.length,
    candidates: deduped.candidates,
    possibleDuplicates: deduped.possibleDuplicates,
    residualRisks,
    tracks: Object.fromEntries(
      [...tracksById].map(([id, track]) => [
        id,
        {
          finder: track.finder,
          challenger: track.challenger,
          candidateIds: track.candidates.map((candidate) => candidate.candidateId),
          count: track.candidates.length
        }
      ])
    )
  });
  log(`Discovery produced ${candidates.length} raw candidate(s) -> ${deduped.candidates.length} after deduplication.`);
  for (const [trackId, track] of tracksById) {
    log(`  Track ${trackId}: ${track.finder} found ${track.candidates.length}, ${track.challenger} verifies`);
  }

  if (completeDiscovery && deduped.candidates.length) {
    // Both tracks' jobs go into one queue call: Track A's are all Codex and
    // Track B's are all Claude, so the two provider lanes run them in parallel.
    const challengeJobs = buildChallengeJobs({ context, commit: git.commit, tracksById });
    log(`Challenge: ${challengeJobs.length} job(s) across ${tracksById.size} track(s), max ${MAX_CANDIDATES_PER_CHALLENGE} candidates each`);
    const challengePhase = await runPhase({
      store,
      context,
      commit: git.commit,
      jobs: challengeJobs,
      repoRoot,
      previousJobs,
      log,
      reuseCache: mode === 'resume'
    });

    // ---- Tiebreak: only where the two tracks reached opposite verdicts -----
    const verdicts = collectVerdicts(challengePhase.outputs);
    const comparisons = compareTracks({ candidates: deduped.candidates, verdicts });
    const byId = new Map(deduped.candidates.map((candidate) => [candidate.candidateId, candidate]));
    const disputes = disputedComparisons(comparisons)
      .map((comparison) => ({ comparison, candidate: byId.get(comparison.candidateId) }))
      .filter((entry) => entry.candidate);

    if (disputes.length) {
      const tiebreakJobs = buildTiebreakJobs({ context, commit: git.commit, disputes });
      log(`Tiebreak: ${disputes.length} disputed candidate(s) across ${tiebreakJobs.length} job(s)`);
      await runPhase({
        store,
        context,
        commit: git.commit,
        jobs: tiebreakJobs,
        repoRoot,
        previousJobs,
        log,
        reuseCache: mode === 'resume'
      });
    } else {
      log('Tiebreak skipped: the two tracks reached no opposing verdicts.');
    }
  } else if (!completeDiscovery) {
    log('Challenge phase skipped: a provider-restricted run cannot cross-examine.');
  }

  const after = await gitInfo(repoRoot);
  const worktreeUnchanged = after.commit === git.commit && !after.dirty;
  if (!worktreeUnchanged) {
    log('WARNING: the working tree changed during this run. Discovery and challenge must be read-only; investigate before trusting the report.');
  }

  const allJobs = await store.readJobs();
  const failedRequired = [...allJobs.values()].filter(
    (job) => job.phase === 'scout' && (job.status === 'failed' || job.status === 'timed_out')
  );

  run = {
    ...run,
    status: failedRequired.length ? 'completed_with_failures' : 'completed',
    finishedAt: new Date().toISOString(),
    worktreeUnchanged
  };
  await store.writeRun(run);

  await regenerateArtifacts({ store, repoRoot, log });

  if (failedRequired.length) {
    log(`\n${failedRequired.length} required scout job(s) failed: ${failedRequired.map((job) => job.jobId).join(', ')}`);
    log(`Re-run them with: ${invocation('resume', `--run ${store.runId}`)}`);
    return 1;
  }
  return worktreeUnchanged ? 0 : 1;
}

export async function runReport({ repoRoot, options, log = console.log }) {
  const runId = options.run ?? (await latestRunId(repoRoot));
  if (!runId) throw new PipelineError(`No runs found. Run \`${invocation('scan')}\` first.`);
  const store = new RunStore(repoRoot, runId);
  if (!(await store.readRun())) throw new PipelineError(`Run ${runId} not found under ${RUNS_DIRNAME}/`);
  const { counts } = await regenerateArtifacts({ store, repoRoot, log });
  log(
    `verified=${counts.verified} probable=${counts.probable} needs_reproduction=${counts.needsReproduction} rejected=${counts.rejected}`
  );
  return 0;
}

export { shortHash };
