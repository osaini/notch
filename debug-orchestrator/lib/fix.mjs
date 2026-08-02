import { PipelineError } from './cli.mjs';
import { ADAPTERS, DEFAULT_MAX_ROUNDS, assignRoles, executePhase, renderTemplate, runImplement } from './implement.mjs';
import { SEVERITY_ORDER } from './normalize.mjs';
import { atomicWrite, atomicWriteJson } from './run-store.mjs';
import { captureCumulativeDiff, commitWorktree, createWorktree, linkDependencies, resetWorktree } from './worktree.mjs';

export const DEFAULT_MAX_FIXES = 5;

/**
 * Which findings are safe to hand an unattended code writer.
 *
 * Only `verified`: both tracks discovered it independently and both opposing
 * verifiers confirmed the failure path. A finding that survived only because a
 * tiebreak resolved a disagreement is excluded unless asked for — two models
 * actively contradicting each other about whether a bug is real is a poor
 * premise for changing code without a human in the loop.
 */
export function selectFixes({ promoted, maxFixes = DEFAULT_MAX_FIXES, includeTiebroken = false }) {
  const eligible = promoted.filter((entry) => {
    if (entry.status === 'verified') return true;
    return includeTiebroken && entry.status === 'probable' && entry.tiebroken;
  });

  const ranked = eligible.slice().sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.file.localeCompare(b.file) ||
      a.candidateId.localeCompare(b.candidateId)
  );

  return { selected: ranked.slice(0, maxFixes), eligibleCount: ranked.length };
}

/** The finding as the fix planner and implementer see it. */
export function toFixPayload(candidate) {
  return {
    candidate_id: candidate.candidateId,
    title: candidate.title,
    severity: candidate.severity,
    category: candidate.category,
    file: candidate.file,
    symbol: candidate.symbol,
    line_start: candidate.lineStart,
    line_end: candidate.lineEnd,
    preconditions: candidate.preconditions,
    failure_path: candidate.failurePath,
    observable_impact: candidate.observableImpact,
    evidence: [...new Set(Object.values(candidate.evidenceByProvider ?? {}).flat())],
    suggested_test: candidate.suggestedTest
  };
}

/**
 * The task text one fix is implemented from.
 *
 * Carries both verifiers' reasoning, not just the claim. The implementer is
 * fixing something two independent reviewers already agreed about, and their
 * cited code paths are the most useful part of that agreement.
 */
export function toFixTask(candidate) {
  const verdicts = Object.entries(candidate.comparison?.verdicts ?? {})
    .filter(([, verdict]) => verdict)
    .map(([trackId, verdict]) => `- Track ${trackId} (${verdict.challenger}): ${verdict.verdict} — ${verdict.rationale}`);

  return [
    `Fix this bug. It was found independently by both dispatch tracks and confirmed by both opposing verifiers.`,
    '',
    `Title: ${candidate.title}`,
    `Severity: ${candidate.severity}`,
    `Location: ${candidate.file}:${candidate.lineStart}-${candidate.lineEnd} (${candidate.symbol})`,
    '',
    'Failure path:',
    candidate.failurePath,
    '',
    'Observable impact:',
    candidate.observableImpact,
    '',
    'Preconditions:',
    ...(candidate.preconditions ?? []).map((entry) => `- ${entry}`),
    '',
    'Verifier findings:',
    ...(verdicts.length ? verdicts : ['- none recorded']),
    '',
    `Suggested test: ${candidate.suggestedTest || 'none proposed'}`,
    '',
    'Fix only this bug. Do not refactor unrelated code and do not fix other findings in the same file.'
  ].join('\n');
}

/**
 * Order the batch.
 *
 * The planner's ordering is honoured only where it is complete and consistent;
 * anything it omitted, duplicated, or invented falls back to the deterministic
 * severity ranking. A batch must never silently lose a fix because the model
 * returned a malformed order.
 */
export function orderFixes(selected, plan) {
  const entries = plan?.fixes ?? [];
  const bySelected = new Map(selected.map((candidate) => [candidate.candidateId, candidate]));
  const positions = new Map();

  for (const entry of entries) {
    const candidate = bySelected.get(entry?.candidate_id);
    const order = Number(entry?.order);
    if (!candidate || !Number.isInteger(order)) continue;
    if (positions.has(entry.candidate_id)) continue;
    positions.set(entry.candidate_id, order);
  }

  const ordered = selected
    .slice()
    .sort((a, b) => {
      const left = positions.has(a.candidateId) ? positions.get(a.candidateId) : Number.MAX_SAFE_INTEGER;
      const right = positions.has(b.candidateId) ? positions.get(b.candidateId) : Number.MAX_SAFE_INTEGER;
      // Ties and unplanned entries keep the incoming severity ranking.
      return left - right || selected.indexOf(a) - selected.indexOf(b);
    });

  return {
    ordered,
    planned: positions.size,
    unplanned: selected.length - positions.size
  };
}

async function runFixPlan({ store, context, repoRoot, worktreePath, commit, selected, provider, adapters, log }) {
  const prompt = renderTemplate(context.prompts.fixplan, {
    COMMIT_SHA: commit,
    WORKTREE_PATH: worktreePath,
    FINDINGS_JSON: JSON.stringify(selected.map(toFixPayload), null, 2)
  });

  const outcome = await executePhase({
    store,
    context,
    repoRoot,
    worktreePath,
    provider,
    phase: 'fixplan',
    round: 0,
    prompt,
    timeoutMs: (context.manifest.timeoutsMinutes?.fixplan ?? 20) * 60 * 1000,
    modelConfig: context.manifest.providers?.[provider] ?? {},
    adapters,
    log
  });

  await store.writeFixPlan(outcome.data);
  return outcome.data;
}

/**
 * Fix a batch of findings, one at a time, in a single shared worktree.
 *
 * Sequential and shared on purpose: each fix's baseline run validates the
 * accumulated state, so a fix that breaks an earlier one is caught here rather
 * than at merge time. Between fixes the tree is committed (on success) or reset
 * (on failure) so every fix's diff covers only its own work.
 */
export async function runFix({
  repoRoot,
  store,
  context,
  commit,
  promoted,
  implementer = 'claude',
  maxFixes = DEFAULT_MAX_FIXES,
  maxRounds = DEFAULT_MAX_ROUNDS,
  includeTiebroken = false,
  skipBaseline = false,
  adapters = ADAPTERS,
  log = () => {}
}) {
  const roles = assignRoles(implementer);
  const { selected, eligibleCount } = selectFixes({ promoted, maxFixes, includeTiebroken });

  if (!selected.length) {
    throw new PipelineError(
      'No findings are eligible to fix. Only `verified` findings qualify — both tracks must have found it and both verifiers confirmed it. ' +
        'Pass --include-tiebroken to also accept findings a tiebreak resolved.'
    );
  }

  log(`Worktree: ${store.worktreePath}`);
  const worktree = await createWorktree({ repoRoot, worktreePath: store.worktreePath, commit, runId: store.runId });
  const deps = await linkDependencies({ repoRoot, worktreePath: store.worktreePath });
  log(`  branch ${worktree.branch}${worktree.reused ? ' (reused)' : ''}, node_modules: ${deps.strategy}`);

  const run = {
    runId: store.runId,
    kind: 'fix',
    commit,
    roles,
    maxFixes,
    maxRounds,
    includeTiebroken,
    eligibleCount,
    selectedCount: selected.length,
    worktree: { path: store.worktreePath, branch: worktree.branch, dependencies: deps },
    fixes: [],
    status: 'running',
    startedAt: new Date().toISOString()
  };
  await store.writeRun(run);

  log(`Fix batch: ${selected.length} of ${eligibleCount} eligible finding(s), implementer ${roles.implementer}, reviewer ${roles.reviewer}`);

  const plan = await runFixPlan({
    store,
    context,
    repoRoot,
    worktreePath: store.worktreePath,
    commit,
    selected,
    provider: roles.implementer,
    adapters,
    log
  });
  const { ordered, planned, unplanned } = orderFixes(selected, plan);
  log(`  fix plan: ${planned} ordered by the planner, ${unplanned} left in severity order`);
  for (const conflict of plan?.conflicts ?? []) {
    log(`  WARNING conflicting fixes ${(conflict.candidate_ids ?? []).join(' + ')}: ${conflict.explanation}`);
  }

  for (const [index, candidate] of ordered.entries()) {
    const fixIndex = index + 1;
    log('');
    log(`Fix ${fixIndex}/${ordered.length}: ${candidate.shortId} ${candidate.title}`);

    const record = {
      fixIndex,
      candidateId: candidate.candidateId,
      shortId: candidate.shortId,
      severity: candidate.severity,
      title: candidate.title,
      file: candidate.file,
      status: null,
      rounds: 0,
      commit: null,
      error: null
    };

    try {
      const fixRun = await runImplement({
        repoRoot,
        store,
        context,
        commit,
        task: toFixTask(candidate),
        candidateId: candidate.candidateId,
        implementer,
        maxRounds,
        adapters,
        log,
        skipBaseline,
        fixIndex,
        // The batch owns run.json; a single fix must not overwrite it.
        persistRun: false
      });

      record.status = fixRun.status;
      record.rounds = fixRun.rounds.length;

      if (fixRun.status === 'accepted') {
        const committed = await commitWorktree({
          worktreePath: store.worktreePath,
          message: `fix(${candidate.shortId}): ${candidate.title}\n\nCandidate: ${candidate.candidateId}\nRun: ${store.runId}`
        });
        record.commit = committed.sha;
        log(`  committed ${committed.sha ? committed.sha.slice(0, 7) : '(nothing staged)'}`);
      } else {
        // Unconverged work must not bleed into the next fix's diff. Its rounds
        // are already saved under fixes/<index>/, so nothing is lost.
        await resetWorktree({ worktreePath: store.worktreePath });
        log(`  ${fixRun.status}: worktree reset, this fix's rounds kept under fixes/${fixIndex}/`);
      }
    } catch (error) {
      // One fix failing must not abandon the rest of the batch.
      record.status = 'errored';
      record.error = String(error?.message ?? error);
      log(`  ERROR ${record.error.slice(0, 200)}`);
      try {
        await resetWorktree({ worktreePath: store.worktreePath });
      } catch (resetError) {
        log(`  WARNING could not reset the worktree: ${String(resetError?.message ?? resetError)}`);
      }
    }

    run.fixes.push(record);
    await store.writeRun(run);
  }

  const cumulative = await captureCumulativeDiff({ worktreePath: store.worktreePath, baseCommit: commit });
  await atomicWrite(store.roundPath('cumulative', 'diff.patch'), cumulative.diff);
  await atomicWriteJson(store.roundPath('cumulative', 'summary.json'), {
    filesChanged: cumulative.filesChanged,
    truncated: cumulative.truncated,
    byteLength: cumulative.byteLength
  });

  const accepted = run.fixes.filter((entry) => entry.status === 'accepted').length;
  run.status = accepted === run.fixes.length ? 'accepted' : accepted ? 'partial' : 'none-accepted';
  run.accepted = accepted;
  run.cumulative = {
    filesChanged: cumulative.filesChanged,
    truncated: cumulative.truncated,
    byteLength: cumulative.byteLength
  };
  run.finishedAt = new Date().toISOString();
  await store.writeRun(run);

  return run;
}
