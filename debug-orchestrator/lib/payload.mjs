/**
 * The candidate as a reviewer sees it.
 *
 * Deliberately omits provider identity and scout confidence. A reviewer must
 * judge the code, not the reputation of whoever filed the claim, and must not
 * learn that both finders agreed until after its own inspection is complete —
 * which, for a single-shot job, means never. Independent agreement is applied
 * later, at promotion time.
 */
export function toChallengePayload(candidate) {
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
    suggested_test: candidate.suggestedTest,
    false_positive_risk: candidate.falsePositiveRisk
  };
}
