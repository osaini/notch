import { invocation } from './cli.mjs';
import { SEVERITY_ORDER } from './normalize.mjs';

const STATUS_SECTIONS = [
  { status: 'verified', heading: '5. Verified findings' },
  { status: 'probable', heading: '6. Probable findings' },
  { status: 'disputed', heading: '7. Disputed findings (the tracks disagreed)' },
  { status: 'needs_reproduction', heading: '8. Findings needing reproduction' },
  { status: 'rejected', heading: '9. Rejected findings (appendix)' }
];

const AGREEMENT_LABELS = {
  'both-confirmed': 'both verifiers confirmed',
  'both-rejected': 'both verifiers rejected',
  disputed: 'verifiers disagreed',
  'single-confirmed': 'sole verifier confirmed',
  'single-rejected': 'sole verifier rejected',
  unresolved: 'no decisive verdict'
};

const FAILED_STATUSES = new Set(['failed', 'timed_out']);

function escapeCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** `indent` is two spaces for nested detail under a finding, empty at section level. */
function bulletList(values, { emptyText = '_none recorded_', indent = '  ' } = {}) {
  const items = (values ?? []).filter((entry) => String(entry ?? '').trim().length > 0);
  if (!items.length) return `${indent}${emptyText}`;
  return items.map((entry) => `${indent}- ${String(entry).trim()}`).join('\n');
}

function formatConfidences(candidate) {
  const entries = Object.entries(candidate.confidenceByProvider ?? {});
  if (!entries.length) return '_unknown_';
  return entries.map(([provider, value]) => `${provider} ${Number(value).toFixed(2)}`).join(', ');
}

/**
 * Every track's verdict, side by side.
 *
 * For a jointly discovered finding this is the payoff of running two tracks:
 * two verifiers reached a judgement independently, and the report shows both
 * rather than whichever one a coin flip selected.
 */
function formatTrackVerdicts(comparison) {
  const lines = [];
  const entries = Object.entries(comparison?.verdicts ?? {});
  if (!entries.length) return ['- **Per-track verdicts:** _none recorded_'];

  lines.push('- **Per-track verdicts:**');
  for (const [trackId, verdict] of entries) {
    if (!verdict) {
      const found = (comparison?.foundBy ?? []).includes(trackId);
      lines.push(`  - Track ${trackId}: ${found ? '_found it, but no verdict was recorded_' : '_did not find it_'}`);
      continue;
    }
    lines.push(
      `  - Track ${trackId} (verified by ${verdict.challenger}): **${verdict.verdict}** ` +
        `(confidence ${Number(verdict.confidence).toFixed(2)}) — ${verdict.rationale || '_no rationale_'}`
    );
  }
  return lines;
}

function formatFinding(candidate, index) {
  const verdict = candidate.verdict;
  const comparison = candidate.comparison;
  const lines = [];
  lines.push(`### ${index}. ${candidate.title}`);
  lines.push('');
  lines.push(`- **Candidate ID:** \`${candidate.shortId}\` (full: \`${candidate.candidateId}\`)`);
  lines.push(`- **Severity:** ${candidate.severity}`);
  lines.push(`- **Status:** ${candidate.status} — ${candidate.statusReason}`);
  lines.push(`- **Origin provider(s):** ${(candidate.providers ?? []).join(', ') || '_unknown_'}`);
  lines.push(
    `- **Found by track(s):** ${(comparison?.foundBy ?? []).join(', ') || '_unknown_'}` +
      (comparison ? ` — ${AGREEMENT_LABELS[comparison.agreement] ?? comparison.agreement}` : '')
  );
  lines.push(...formatTrackVerdicts(comparison));
  if (comparison?.tiebreak) {
    const tiebreak = comparison.tiebreak;
    lines.push(
      `- **Tiebreak (${tiebreak.tiebreaker}):** **${tiebreak.verdict}** ` +
        `(confidence ${Number(tiebreak.confidence).toFixed(2)}, resolves ${tiebreak.resolves}) — ${tiebreak.rationale || '_no rationale_'}`
    );
  }
  lines.push(`- **Scout confidence:** ${formatConfidences(candidate)}`);
  lines.push(`- **Location:** \`${candidate.file}\` · \`${candidate.symbol}\` · lines ${candidate.lineStart}-${candidate.lineEnd}`);
  lines.push(`- **Category:** ${candidate.category}`);
  lines.push(`- **Shard(s):** ${(candidate.shards ?? []).join(', ')}`);
  lines.push('');
  lines.push('- **Preconditions:**');
  lines.push(bulletList(candidate.preconditions));
  lines.push('');
  lines.push(`- **Failure path:** ${candidate.failurePath}`);
  lines.push(`- **Observable impact:** ${candidate.observableImpact}`);
  lines.push('');
  lines.push('- **Evidence:**');
  for (const [provider, entries] of Object.entries(candidate.evidenceByProvider ?? {})) {
    lines.push(`  - _${provider}:_`);
    for (const entry of entries) lines.push(`    - ${entry}`);
  }
  if (!Object.keys(candidate.evidenceByProvider ?? {}).length) lines.push('  _none recorded_');
  lines.push('');
  if (verdict) {
    lines.push('- **Challenger rationale:** ' + (verdict.rationale || '_none_'));
    lines.push('- **Supporting evidence (challenger):**');
    lines.push(bulletList(verdict.supportingEvidence));
    lines.push('- **Invalidating evidence (challenger):**');
    lines.push(bulletList(verdict.invalidatingEvidence));
    lines.push('');
  }
  lines.push(`- **Proposed reproduction:** ${verdict?.minimalReproduction || candidate.suggestedTest || '_none proposed_'}`);
  if (candidate.reproCommand) lines.push(`- **Repro command:** \`${candidate.reproCommand}\``);
  if (candidate.reproduction) {
    lines.push(
      `- **Reproduction result:** reproduced=${candidate.reproduction.reproduced}, matches predicted path=${candidate.reproduction.matchesPredictedFailurePath}`
    );
  }
  lines.push(`- **False-positive risk:** ${candidate.falsePositiveRisk || '_not stated_'}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Render the run report. Pure: it reads only what it is handed, so `report`
 * regenerates from stored data without any model call.
 */
export function renderReport({
  run,
  promoted = [],
  possibleDuplicates = [],
  residualRisks = [],
  jobs = [],
  baseline = null,
  comparisonSummary = null
}) {
  const counts = Object.fromEntries(
    STATUS_SECTIONS.map(({ status }) => [status, promoted.filter((entry) => entry.status === status).length])
  );
  const failedJobs = jobs.filter((job) => FAILED_STATUSES.has(job.status));
  const out = [];

  out.push(`# Bug orchestration report — ${run.runId}`);
  out.push('');
  out.push('## 1. Run metadata');
  out.push('');
  out.push('| Field | Value |');
  out.push('| --- | --- |');
  out.push(`| Run ID | \`${run.runId}\` |`);
  out.push(`| Status | ${run.status} |`);
  out.push(`| Commit | \`${run.commit}\` |`);
  out.push(`| Started (UTC) | ${run.startedAt} |`);
  out.push(`| Finished (UTC) | ${run.finishedAt ?? '_in progress_'} |`);
  out.push(`| Manifest hash | \`${String(run.manifestHash).slice(0, 12)}\` |`);
  for (const [name, version] of Object.entries(run.cliVersions ?? {})) {
    out.push(`| ${name} | ${escapeCell(version)} |`);
  }
  for (const [name, hash] of Object.entries(run.promptHashes ?? {})) {
    out.push(`| prompt:${name} | \`${String(hash).slice(0, 12)}\` |`);
  }
  for (const [name, hash] of Object.entries(run.schemaHashes ?? {})) {
    out.push(`| schema:${name} | \`${String(hash).slice(0, 12)}\` |`);
  }
  out.push(`| Shards | ${(run.config?.shards ?? []).join(', ') || '_all_'} |`);
  out.push(`| Providers | ${(run.config?.providers ?? []).join(', ')} |`);
  out.push('');
  if ((run.warnings ?? []).length) {
    out.push('**Run warnings:**');
    out.push('');
    out.push(bulletList(run.warnings, { indent: '' }));
    out.push('');
  }

  out.push('## 2. Baseline status');
  out.push('');
  if (!baseline) {
    out.push(`_No baseline recorded for this run. Run \`${invocation('preflight')}\` to capture one._`);
  } else {
    // A persisted preflight snapshot contains tool-resolution checks under
    // `checks` and the repository's deterministic commands under `baseline`.
    // Reports are about the latter. Older test fixtures/run files stored those
    // commands directly in `checks`, so retain that fallback.
    const baselineChecks = Array.isArray(baseline.baseline)
      ? baseline.baseline
      : (baseline.checks ?? []);
    out.push('| Check | Result | Exit code |');
    out.push('| --- | --- | --- |');
    for (const check of baselineChecks) {
      out.push(`| ${escapeCell(check.name)} | ${check.status} | ${check.exitCode ?? '—'} |`);
    }
    out.push('');
    const failing = baselineChecks.filter(
      (check) => check.status !== 'succeeded' && check.status !== 'pass'
    );
    out.push(
      failing.length
        ? `**${failing.length} baseline check(s) were already failing before any model call.** Pre-existing failures are not model-discovered bugs.`
        : 'All baseline checks passed before discovery started.'
    );
  }
  out.push('');

  out.push('## 3. Executive summary');
  out.push('');
  out.push(`- Candidates after deduplication: **${promoted.length}**`);
  out.push(
    `- Verified: **${counts.verified}** · Probable: **${counts.probable}** · Disputed: **${counts.disputed}** · Needs reproduction: **${counts.needs_reproduction}** · Rejected: **${counts.rejected}**`
  );
  out.push(`- Possible-duplicate groups flagged for human review: **${possibleDuplicates.length}**`);
  out.push(`- Failed or timed-out jobs: **${failedJobs.length}**`);
  const bySeverity = SEVERITY_ORDER.map(
    (severity) => `${severity}: ${promoted.filter((entry) => entry.severity === severity && entry.status !== 'rejected').length}`
  ).join(' · ');
  out.push(`- Non-rejected findings by severity: ${bySeverity}`);
  out.push('');

  out.push('## 4. Cross-track comparison');
  out.push('');
  const tracks = run.config?.tracks ?? [];
  if (tracks.length) {
    out.push('| Track | Finder | Verifier |');
    out.push('| --- | --- | --- |');
    for (const track of tracks) out.push(`| ${track.id} | ${track.finder} | ${track.challenger} |`);
    out.push('');
  }
  if (!comparisonSummary) {
    out.push('_No cross-track comparison recorded for this run._');
  } else {
    out.push('| Discovery overlap | Count |');
    out.push('| --- | --- |');
    out.push(`| Found by both tracks | ${comparisonSummary.bothTracks} |`);
    out.push(`| Track A only | ${comparisonSummary.trackAOnly} |`);
    out.push(`| Track B only | ${comparisonSummary.trackBOnly} |`);
    out.push('');
    out.push('| Verifier agreement | Count |');
    out.push('| --- | --- |');
    for (const [agreement, count] of Object.entries(comparisonSummary.counts ?? {})) {
      out.push(`| ${escapeCell(AGREEMENT_LABELS[agreement] ?? agreement)} (\`${agreement}\`) | ${count} |`);
    }
    out.push('');
    const disputes = comparisonSummary.counts?.disputed ?? 0;
    out.push(
      disputes
        ? `**${disputes} finding(s) split the two tracks** — one verifier confirmed the failure path and the other rejected it. ` +
            'A tiebreak round re-inspected each one with both positions anonymised. Read those before trusting either side.'
        : 'The two tracks reached no opposing verdicts; no tiebreak was needed.'
    );
    out.push('');
    out.push(
      'Findings only one track discovered are not weaker claims — they are places the other finder did not look, or looked and missed. ' +
        'Overlap is a signal about agreement, not about severity.'
    );
  }
  out.push('');

  for (const section of STATUS_SECTIONS) {
    out.push(`## ${section.heading}`);
    out.push('');
    const entries = promoted
      .filter((entry) => entry.status === section.status)
      .sort(
        (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.file.localeCompare(b.file)
      );
    if (!entries.length) {
      out.push('_None._');
      out.push('');
      continue;
    }
    entries.forEach((entry, index) => out.push(formatFinding(entry, index + 1)));
  }

  if (possibleDuplicates.length) {
    out.push('## 9a. Possible duplicate groups');
    out.push('');
    out.push('These candidates were **not** merged automatically. A human decides whether they are the same defect.');
    out.push('');
    for (const group of possibleDuplicates) {
      out.push(`- \`${group.shortIds.join('` + `')}\` — ${group.reason}`);
    }
    out.push('');
  }

  out.push('## 10. Residual risks by shard');
  out.push('');
  if (!residualRisks.length) {
    out.push('_None reported._');
  } else {
    const byShard = new Map();
    for (const entry of residualRisks) {
      const key = `${entry.shard}`;
      if (!byShard.has(key)) byShard.set(key, []);
      byShard.get(key).push(`(${entry.provider}) ${entry.risk}`);
    }
    for (const [shard, risks] of [...byShard.entries()].sort()) {
      out.push(`### ${shard}`);
      out.push('');
      out.push(bulletList(risks, { indent: '' }));
      out.push('');
    }
  }
  out.push('');

  out.push('## 11. Failed or timed-out jobs');
  out.push('');
  if (!failedJobs.length) {
    out.push('_None. Every job in this run completed._');
  } else {
    out.push('| Job | Provider | Phase | Status | Exit | Error |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    for (const job of failedJobs) {
      out.push(
        `| \`${escapeCell(job.jobId)}\` | ${job.provider} | ${job.phase} | ${job.status} | ${job.exitCode ?? '—'} | ${escapeCell(
          (job.errorSummary ?? '').slice(0, 180)
        )} |`
      );
    }
    out.push('');
    out.push('Raw stdout and stderr for these jobs are retained under `raw/<provider>/` in the run directory.');
  }
  out.push('');

  out.push('## 12. Recommended next actions');
  out.push('');
  const actions = [];
  if (counts.verified) {
    actions.push(
      `Triage the ${counts.verified} verified finding(s) first; both tracks found them independently and both verifiers confirmed them.`
    );
    actions.push(
      `Fix them with \`${invocation('fix', `--run ${run.runId}`)}\`, which writes only inside an isolated worktree.`
    );
  }
  if (counts.probable) actions.push(`Reproduce the ${counts.probable} probable finding(s) before scheduling any fix.`);
  if (counts.disputed)
    actions.push(
      `Read the ${counts.disputed} disputed finding(s) by hand: the two tracks reached opposite conclusions and the tiebreak did not settle them.`
    );
  if (counts.needs_reproduction)
    actions.push(`Design deterministic experiments for the ${counts.needs_reproduction} finding(s) needing reproduction.`);
  if (failedJobs.length) {
    actions.push(`Re-run the failed jobs with \`${invocation('resume', `--run ${run.runId}`)}\`.`);
  }
  if (possibleDuplicates.length) actions.push('Review the possible-duplicate groups and merge them by hand if they are the same defect.');
  actions.push('Nothing in this run modified the repository. Fixes require an explicit, separate, human-initiated step.');
  out.push(bulletList(actions, { indent: '' }));
  out.push('');

  return `${out.join('\n')}\n`;
}
