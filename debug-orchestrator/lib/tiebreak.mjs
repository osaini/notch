import { hashObject, sha256Hex } from './hash.mjs';
import { toChallengePayload } from './payload.mjs';

export const MAX_DISPUTES_PER_TIEBREAK = 6;

/**
 * Who breaks the tie.
 *
 * Only two providers exist and both have already opined on a disputed
 * candidate, so no neutral referee is available. The tiebreaker is picked by
 * candidate-id parity — the same deterministic scheme the challenge phase used
 * for jointly discovered candidates — so the assignment is stable across
 * resumes and balanced across providers rather than favouring either one.
 */
export function assignTiebreaker(candidateId, providers = ['claude', 'codex']) {
  const parity = parseInt(String(candidateId).slice(0, 2), 16) % providers.length;
  return providers[parity];
}

/**
 * Strip every trace of who said what.
 *
 * The tiebreaker is one of the two disputants, so leaking identity would let it
 * recognise and defend its own earlier verdict. Ordering is by the hash of the
 * rationale text, not by track or provider, so position carries no signal
 * either. Confidence is dropped for the same reason scout confidence is dropped
 * from a challenge payload: it anchors the judgement on stated certainty
 * instead of on the code.
 */
export function toAnonymousAssessments(verdictsByTrack) {
  return Object.values(verdictsByTrack ?? {})
    .filter(Boolean)
    .map((entry) => ({
      verdict: entry.verdict,
      rationale: entry.rationale,
      supporting_evidence: entry.supportingEvidence ?? [],
      invalidating_evidence: entry.invalidatingEvidence ?? [],
      _order: sha256Hex(String(entry.rationale ?? ''))
    }))
    .sort((a, b) => a._order.localeCompare(b._order))
    .map(({ _order, ...assessment }, index) => ({ label: `assessment_${index + 1}`, ...assessment }));
}

export function toDisputePayload(candidate, comparison) {
  return {
    ...toChallengePayload(candidate),
    assessments: toAnonymousAssessments(comparison.verdicts)
  };
}

/**
 * Build tiebreak jobs for disputed candidates only.
 *
 * Batches are smaller than the challenge phase's because each entry carries two
 * full assessments plus the candidate, and the job asks for independent
 * re-inspection of every one of them.
 */
export function buildTiebreakJobs({ context, commit, disputes, providers = ['claude', 'codex'] }) {
  const byProvider = new Map();
  for (const dispute of disputes) {
    const provider = assignTiebreaker(dispute.candidate.candidateId, providers);
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider).push(dispute);
  }

  const jobs = [];
  for (const provider of providers) {
    const assigned = (byProvider.get(provider) ?? [])
      .slice()
      .sort((a, b) => a.candidate.candidateId.localeCompare(b.candidate.candidateId));

    for (let index = 0; index * MAX_DISPUTES_PER_TIEBREAK < assigned.length; index += 1) {
      const batch = assigned.slice(index * MAX_DISPUTES_PER_TIEBREAK, (index + 1) * MAX_DISPUTES_PER_TIEBREAK);
      const payload = batch.map((entry) => toDisputePayload(entry.candidate, entry.comparison));
      const citedPaths = [...new Set(batch.map((entry) => entry.candidate.file))];
      const modelConfig = context.manifest.providers[provider];
      const prompt = Object.entries({
        COMMIT_SHA: commit,
        CITED_PATHS: citedPaths.map((entry) => `- ${entry}`).join('\n'),
        DISPUTES_JSON: JSON.stringify(payload, null, 2)
      }).reduce((text, [key, value]) => text.split(`{{${key}}}`).join(String(value)), context.prompts.tiebreak);

      jobs.push({
        jobId: `tiebreak-${provider}-${String(index + 1).padStart(2, '0')}`,
        provider,
        phase: 'tiebreak',
        shard: null,
        track: null,
        prompt,
        schemaName: 'tiebreak',
        modelConfig,
        candidateIds: batch.map((entry) => entry.candidate.candidateId),
        timeoutMs: (context.manifest.timeoutsMinutes.tiebreak ?? 20) * 60_000,
        // The payload is part of the key: if either disputed verdict changes,
        // the previous tiebreak was decided on different evidence.
        inputHash: hashObject({
          commit,
          provider,
          modelConfig,
          phase: 'tiebreak',
          key: sha256Hex(JSON.stringify(payload)),
          promptHash: context.promptHashes.tiebreak,
          schemaHash: context.schemaHashes.tiebreak
        })
      });
    }
  }
  return jobs;
}

export function collectTiebreaks(outputs) {
  const tiebreaks = [];
  for (const normalized of outputs.values()) {
    if (Array.isArray(normalized?.tiebreaks)) tiebreaks.push(...normalized.tiebreaks);
  }
  return tiebreaks;
}
