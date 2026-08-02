export const STATUSES = ['verified', 'probable', 'disputed', 'needs_reproduction', 'rejected'];

/** Bar for calling a P0/P1 verified without an executable reproduction. */
export const STRONG_AGREEMENT = {
  challengerConfidence: 0.85,
  scoutConfidence: 0.8
};

/**
 * Both tracks found this independently.
 *
 * This replaces the old provider-count check. After the split each track's
 * candidate carries exactly one finder, so counting providers on a per-track
 * candidate would always return one and collapse every finding to `probable`.
 * Cross-track agreement carries the identical meaning — Track A's finder is
 * Claude, Track B's is Codex — but now each side brings its own verdict too.
 */
function foundByBothTracks(comparison) {
  return (comparison?.foundBy ?? []).length >= 2;
}

function presentVerdicts(comparison) {
  return Object.values(comparison?.verdicts ?? {}).filter(Boolean);
}

function lowestScoutConfidence(candidate) {
  const values = Object.values(candidate.confidenceByProvider ?? {});
  return values.length ? Math.min(...values) : 0;
}

/**
 * Every confirming verifier cited exact code-path proof at high confidence.
 *
 * With two tracks this is a stronger bar than it was with one: *both* verifiers
 * must clear it, not whichever one happened to be assigned.
 */
function strongAgreement(candidate, comparison) {
  const confirmations = presentVerdicts(comparison).filter((entry) => entry.verdict === 'confirmed');
  if (!confirmations.length) return false;
  return (
    confirmations.every(
      (entry) => Number(entry.confidence) >= STRONG_AGREEMENT.challengerConfidence && (entry.supportingEvidence?.length ?? 0) > 0
    ) && lowestScoutConfidence(candidate) >= STRONG_AGREEMENT.scoutConfidence
  );
}

/**
 * Classify one candidate against the two-track promotion policy.
 *
 * `reproduction` is reserved for the reproduction phase (Milestone 5). Until that
 * lands it is always undefined, which is why nothing reaches `verified` through
 * executable evidence yet.
 */
export function classifyCandidate(candidate, comparison, reproduction) {
  if (reproduction?.reproduced && reproduction?.matchesPredictedFailurePath) {
    return { status: 'verified', reason: 'deterministic reproduction failed for the predicted reason' };
  }

  const agreement = comparison?.agreement ?? 'unresolved';

  switch (agreement) {
    case 'both-confirmed': {
      if (!foundByBothTracks(comparison)) {
        // A track only challenges its own findings, so two verdicts imply two
        // finders. Reaching here means the comparison was built inconsistently.
        return { status: 'probable', reason: 'two verdicts recorded without two independent discoveries' };
      }
      const isHighSeverity = candidate.severity === 'P0' || candidate.severity === 'P1';
      if (isHighSeverity && !strongAgreement(candidate, comparison)) {
        return {
          status: 'probable',
          reason: `${candidate.severity} requires executable evidence or unusually strong independent agreement with exact code-path proof`
        };
      }
      return {
        status: 'verified',
        reason: 'both tracks discovered it independently and both opposing verifiers confirmed the failure path'
      };
    }

    case 'single-confirmed':
      return {
        status: 'probable',
        reason: 'single-track discovery confirmed on the code path by the opposing verifier, with no executable reproduction'
      };

    case 'disputed': {
      const tiebreak = comparison?.tiebreak ?? null;
      if (!tiebreak) {
        return { status: 'disputed', reason: 'the two tracks reached opposite verdicts and no tiebreak was recorded' };
      }
      if (tiebreak.verdict === 'confirmed') {
        return {
          status: 'probable',
          reason: `tiebreak confirmed the failure path after the two tracks disagreed: ${tiebreak.rationale || 'no rationale given'}`
        };
      }
      if (tiebreak.verdict === 'rejected') {
        return {
          status: 'rejected',
          reason: `tiebreak invalidated the failure path after the two tracks disagreed: ${tiebreak.rationale || 'no rationale given'}`
        };
      }
      return { status: 'disputed', reason: 'the two tracks disagreed and the tiebreak could not resolve it either' };
    }

    case 'both-rejected':
      return { status: 'rejected', reason: 'both opposing verifiers invalidated the failure path' };

    case 'single-rejected':
      return { status: 'rejected', reason: 'the opposing verifier invalidated the failure path' };

    default:
      return {
        status: 'needs_reproduction',
        reason: presentVerdicts(comparison).length
          ? 'no verifier could prove or disprove a runtime assumption'
          : 'no verdict recorded; the challenge job did not produce a judgement for this candidate'
      };
  }
}

/**
 * A finding whose status came from a tiebreak rather than clean agreement.
 *
 * Fix selection excludes these by default: a bug two models actively disagreed
 * about is a poor candidate for an unattended code change.
 */
export function isTiebroken(comparison) {
  return comparison?.agreement === 'disputed' && Boolean(comparison?.tiebreak);
}

export function promoteAll({ candidates, comparisons = [], reproductions = [] }) {
  const comparisonById = new Map(comparisons.map((entry) => [entry.candidateId, entry]));
  const reproById = new Map(reproductions.map((repro) => [repro.candidateId, repro]));

  return candidates.map((candidate) => {
    const comparison = comparisonById.get(candidate.candidateId) ?? null;
    const reproduction = reproById.get(candidate.candidateId) ?? null;
    const { status, reason } = classifyCandidate(candidate, comparison, reproduction);
    const verdicts = presentVerdicts(comparison);
    return {
      ...candidate,
      status,
      statusReason: reason,
      comparison,
      tiebroken: isTiebroken(comparison),
      // The highest-signal single verdict, kept so per-finding rendering has one
      // to lead with. The full per-track pair stays on `comparison`.
      verdict: verdicts.find((entry) => entry.verdict === 'confirmed') ?? verdicts[0] ?? null,
      reproduction
    };
  });
}
