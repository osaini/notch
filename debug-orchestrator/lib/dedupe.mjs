import { normalizeText, shortHash } from './hash.mjs';
import { SEVERITY_ORDER } from './normalize.mjs';

const TITLE_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'can',
  'does',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'not',
  'of',
  'on',
  'or',
  'the',
  'to',
  'when',
  'with'
]);

export const TITLE_SIMILARITY_THRESHOLD = 0.6;

export function titleTokens(title) {
  return new Set(
    normalizeText(title)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2 && !TITLE_STOPWORDS.has(token))
  );
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function highestSeverity(values) {
  let best = SEVERITY_ORDER[SEVERITY_ORDER.length - 1];
  for (const value of values) {
    if (SEVERITY_ORDER.indexOf(value) < SEVERITY_ORDER.indexOf(best)) best = value;
  }
  return best;
}

function rangesOverlap(a, b) {
  return a.lineStart <= b.lineEnd && b.lineStart <= a.lineEnd;
}

function unique(values) {
  return [...new Set(values)];
}

/**
 * Deterministic MVP deduplication. No model is involved.
 *
 * 1. Identical candidate hashes merge into one candidate.
 * 2. Same file and symbol with overlapping line ranges -> possible duplicate.
 * 3. Same file and category with similar title tokens -> possible duplicate.
 *
 * Rules 2 and 3 never merge. Findings about different symbols are never merged
 * on title similarity alone, because similar wording about different code is the
 * most common false merge.
 */
export function dedupeCandidates(candidates) {
  const byId = new Map();

  for (const candidate of candidates) {
    const existing = byId.get(candidate.candidateId);
    if (!existing) {
      byId.set(candidate.candidateId, {
        candidateId: candidate.candidateId,
        shortId: candidate.shortId ?? shortHash(candidate.candidateId),
        title: candidate.title,
        severity: candidate.severity,
        category: candidate.category,
        file: candidate.file,
        symbol: candidate.symbol,
        lineStart: candidate.lineStart,
        lineEnd: candidate.lineEnd,
        failurePath: candidate.failurePath,
        observableImpact: candidate.observableImpact,
        preconditions: [...candidate.preconditions],
        suggestedTest: candidate.suggestedTest,
        falsePositiveRisk: candidate.falsePositiveRisk,
        reproCommand: candidate.reproCommand ?? null,
        providers: [candidate.provider],
        shards: [candidate.shard],
        jobIds: [candidate.jobId],
        confidenceByProvider: { [candidate.provider]: candidate.confidence },
        // Every provider's original wording is preserved verbatim.
        evidenceByProvider: { [candidate.provider]: [...candidate.evidence] },
        sources: [candidate]
      });
      continue;
    }

    existing.severity = highestSeverity([existing.severity, candidate.severity]);
    existing.lineStart = Math.min(existing.lineStart, candidate.lineStart);
    existing.lineEnd = Math.max(existing.lineEnd, candidate.lineEnd);
    existing.providers = unique([...existing.providers, candidate.provider]);
    existing.shards = unique([...existing.shards, candidate.shard]);
    existing.jobIds = unique([...existing.jobIds, candidate.jobId]);
    existing.preconditions = unique([...existing.preconditions, ...candidate.preconditions]);
    existing.confidenceByProvider[candidate.provider] = Math.max(
      existing.confidenceByProvider[candidate.provider] ?? 0,
      candidate.confidence
    );
    existing.evidenceByProvider[candidate.provider] = unique([
      ...(existing.evidenceByProvider[candidate.provider] ?? []),
      ...candidate.evidence
    ]);
    if (!existing.reproCommand && candidate.reproCommand) existing.reproCommand = candidate.reproCommand;
    existing.sources.push(candidate);
  }

  const merged = [...byId.values()].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.file.localeCompare(b.file) ||
      a.candidateId.localeCompare(b.candidateId)
  );

  const possibleDuplicates = [];
  for (let i = 0; i < merged.length; i += 1) {
    for (let j = i + 1; j < merged.length; j += 1) {
      const a = merged[i];
      const b = merged[j];
      if (a.file !== b.file) continue;

      if (normalizeText(a.symbol) === normalizeText(b.symbol) && rangesOverlap(a, b)) {
        possibleDuplicates.push({
          reason: 'same file and symbol with overlapping line ranges',
          candidateIds: [a.candidateId, b.candidateId],
          shortIds: [a.shortId, b.shortId]
        });
        continue;
      }

      if (normalizeText(a.category) === normalizeText(b.category)) {
        const similarity = jaccard(titleTokens(a.title), titleTokens(b.title));
        if (similarity >= TITLE_SIMILARITY_THRESHOLD) {
          possibleDuplicates.push({
            reason: `same file and category with similar titles (jaccard ${similarity.toFixed(2)})`,
            candidateIds: [a.candidateId, b.candidateId],
            shortIds: [a.shortId, b.shortId]
          });
        }
      }
    }
  }

  return { candidates: merged, possibleDuplicates };
}
