/** Shared fixtures so tests never make model calls. */

export function makeFinding(overrides = {}) {
  return {
    title: 'Session watcher never clears its debounce timer',
    severity: 'P1',
    confidence: 0.82,
    category: 'resource-leak',
    file: 'src/main/sessionWatcher.ts',
    symbol: 'startWatching',
    line_start: 40,
    line_end: 62,
    preconditions: ['A session file changes twice within the debounce window'],
    failure_path: 'startWatching schedules a timer and returns before clearTimeout runs',
    observable_impact: 'The watcher keeps firing after stopWatching resolves',
    evidence: ['src/main/sessionWatcher.ts:44 assigns this.timer without clearing the previous handle'],
    repro_command: null,
    suggested_test: 'Call startWatching twice and assert only one timer is pending',
    false_positive_risk: 'stopWatching may clear the handle through a different code path',
    ...overrides
  };
}

export function makeFindingsPayload(overrides = {}) {
  return {
    shard_id: 'main-lifecycle',
    findings: [makeFinding()],
    residual_risks: ['Did not inspect tray teardown ordering'],
    ...overrides
  };
}

export function makeVerdictsPayload(candidateIds, overrides = {}) {
  return {
    verdicts: candidateIds.map((candidateId) => ({
      candidate_id: candidateId,
      verdict: 'confirmed',
      rationale: 'The timer handle is overwritten with no clearTimeout on the reassignment path',
      supporting_evidence: ['src/main/sessionWatcher.ts:44'],
      invalidating_evidence: [],
      minimal_reproduction: null,
      confidence: 0.9,
      ...overrides
    }))
  };
}

/** Minimal candidate record shaped like `normalizeScoutOutput` output. */
export function makeCandidate(overrides = {}) {
  return {
    candidateId: 'a'.repeat(64),
    shortId: 'a'.repeat(12),
    provider: 'claude',
    shard: 'main-lifecycle',
    jobId: 'scout-claude-main-lifecycle',
    runId: 'test-run',
    title: 'Session watcher never clears its debounce timer',
    severity: 'P1',
    confidence: 0.82,
    category: 'resource-leak',
    file: 'src/main/sessionWatcher.ts',
    symbol: 'startWatching',
    lineStart: 40,
    lineEnd: 62,
    preconditions: ['A session file changes twice within the debounce window'],
    failurePath: 'startWatching schedules a timer and returns before clearTimeout runs',
    observableImpact: 'The watcher keeps firing after stopWatching resolves',
    evidence: ['src/main/sessionWatcher.ts:44'],
    reproCommand: null,
    suggestedTest: 'Call startWatching twice',
    falsePositiveRisk: 'stopWatching may clear it elsewhere',
    ...overrides
  };
}

/**
 * Adapter stub matching the provider contract. `plan` maps a job id to the
 * outcome the fake provider should return.
 */
export function fakeAdapter(plan, calls = []) {
  return {
    async runJob(args) {
      const jobId = args.jobId ?? args.__jobId;
      const outcome = typeof plan === 'function' ? plan(args) : plan;
      calls.push({ jobId, args });
      if (outcome?.delayMs) await new Promise((resolve) => setTimeout(resolve, outcome.delayMs));
      return {
        status: outcome?.status ?? 'succeeded',
        exitCode: outcome?.status === 'succeeded' || !outcome?.status ? 0 : 1,
        data: outcome?.data ?? null,
        metadata: { command: 'fake', argv: [], errorSummary: outcome?.errorSummary ?? null, warnings: [] }
      };
    }
  };
}

/** File reader stub for normalization tests: every cited file exists and is long. */
export const alwaysExists = async () => ({ exists: true, lineCount: 10_000 });
