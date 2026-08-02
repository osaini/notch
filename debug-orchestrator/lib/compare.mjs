import { TRACKS } from './tracks.mjs';

/**
 * How the two tracks landed on one candidate.
 *
 * `disputed` is deliberately narrow: one track's verifier confirmed the failure
 * path and the other's rejected it. That is a real contradiction about the code
 * and worth paying to resolve. A confirmed-versus-needs_reproduction split is
 * not a contradiction — one side simply could not prove a runtime assumption —
 * so it lands in `unresolved` and never triggers a tiebreak.
 */
export const AGREEMENTS = [
  'both-confirmed',
  'both-rejected',
  'disputed',
  'single-confirmed',
  'single-rejected',
  'unresolved'
];

export function classifyAgreement(verdictsByTrack) {
  const present = Object.values(verdictsByTrack ?? {}).filter(Boolean);
  if (!present.length) return 'unresolved';

  const confirmed = present.filter((entry) => entry.verdict === 'confirmed').length;
  const rejected = present.filter((entry) => entry.verdict === 'rejected').length;

  if (present.length === 1) {
    if (confirmed === 1) return 'single-confirmed';
    if (rejected === 1) return 'single-rejected';
    return 'unresolved';
  }

  if (confirmed === present.length) return 'both-confirmed';
  if (rejected === present.length) return 'both-rejected';
  if (confirmed > 0 && rejected > 0) return 'disputed';
  return 'unresolved';
}

/**
 * Join the two tracks on candidate id.
 *
 * Candidate ids are content hashes (`candidateIdFor`), not provenance, so the
 * same defect described by both finders collapses to the same id and the two
 * tracks line up without any model involvement.
 *
 * A track only ever challenges its own findings, so a candidate carries a
 * verdict only from tracks that found it: the verdict set is always a subset of
 * `foundBy`.
 */
export function compareTracks({ candidates, verdicts = [], tracks = TRACKS }) {
  const byCandidate = new Map();
  for (const entry of verdicts) {
    if (!entry?.candidateId || !entry.track) continue;
    if (!byCandidate.has(entry.candidateId)) byCandidate.set(entry.candidateId, {});
    byCandidate.get(entry.candidateId)[entry.track] = entry;
  }

  return candidates.map((candidate) => {
    const foundBy = tracks
      .filter((track) => (candidate.providers ?? []).includes(track.finder))
      .map((track) => track.id);

    const verdictsByTrack = {};
    for (const track of tracks) {
      verdictsByTrack[track.id] = byCandidate.get(candidate.candidateId)?.[track.id] ?? null;
    }

    return {
      candidateId: candidate.candidateId,
      shortId: candidate.shortId,
      foundBy,
      verdicts: verdictsByTrack,
      agreement: classifyAgreement(verdictsByTrack),
      tiebreak: null
    };
  });
}

/** Fold tiebreak results back onto the comparisons they resolve. */
export function applyTiebreaks(comparisons, tiebreaks = []) {
  const byId = new Map(tiebreaks.map((entry) => [entry.candidateId, entry]));
  return comparisons.map((comparison) =>
    byId.has(comparison.candidateId) ? { ...comparison, tiebreak: byId.get(comparison.candidateId) } : comparison
  );
}

export function disputedComparisons(comparisons) {
  return comparisons.filter((comparison) => comparison.agreement === 'disputed');
}

export function summarizeComparisons(comparisons) {
  const counts = Object.fromEntries(AGREEMENTS.map((name) => [name, 0]));
  let trackAOnly = 0;
  let trackBOnly = 0;
  let bothTracks = 0;
  for (const comparison of comparisons) {
    counts[comparison.agreement] = (counts[comparison.agreement] ?? 0) + 1;
    if (comparison.foundBy.length >= 2) bothTracks += 1;
    else if (comparison.foundBy[0] === 'A') trackAOnly += 1;
    else if (comparison.foundBy[0] === 'B') trackBOnly += 1;
  }
  return { counts, trackAOnly, trackBOnly, bothTracks, total: comparisons.length };
}
