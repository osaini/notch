import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizeText, sha256Hex, shortHash } from './hash.mjs';
import { validate } from './validate.mjs';

export const MIN_CONFIDENCE = 0.65;
export const SEVERITY_ORDER = ['P0', 'P1', 'P2', 'P3'];

export class NormalizationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'NormalizationError';
    this.errors = errors;
  }
}

export function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function trimString(value) {
  return String(value ?? '').trim();
}

function cleanList(values) {
  if (!Array.isArray(values)) return [];
  return values.map(trimString).filter((entry) => entry.length > 0);
}

/**
 * Deterministic candidate id: SHA-256 over the normalized category, file, symbol,
 * and failure path. Two providers describing the same defect in the same place
 * collapse to the same id; the same wording about a different symbol does not.
 */
export function candidateIdFor({ category, file, symbol, failurePath }) {
  const material = [normalizeText(category), normalizeText(normalizePath(file)), normalizeText(symbol), normalizeText(failurePath)].join(
    '\n'
  );
  return sha256Hex(material);
}

/** Default fs-backed source; tests inject a stub instead of writing fixture files. */
export function createRepoFileReader(repoRoot) {
  const cache = new Map();
  return async (relativePath) => {
    if (cache.has(relativePath)) return cache.get(relativePath);
    let info = null;
    try {
      const absolute = path.resolve(repoRoot, relativePath);
      // Reject anything that escapes the repository root.
      const relative = path.relative(repoRoot, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        info = null;
      } else {
        const text = await readFile(absolute, 'utf8');
        info = { exists: true, lineCount: text.split('\n').length };
      }
    } catch {
      info = null;
    }
    cache.set(relativePath, info);
    return info;
  };
}

/**
 * Normalize one provider's scout payload for one shard.
 *
 * Structural problems throw (`NormalizationError`) because they mean the adapter
 * handed us something that does not match the findings schema. Per-finding
 * content problems drop that finding with a recorded reason, so a single bad
 * citation cannot discard an otherwise usable job.
 */
export async function normalizeScoutOutput({
  data,
  schema,
  provider,
  shardId,
  jobId,
  runId,
  fileReader,
  minConfidence = MIN_CONFIDENCE
}) {
  if (schema) {
    const check = validate(schema, data);
    if (!check.valid) {
      throw new NormalizationError(`scout output failed schema validation for ${provider}/${shardId}`, check.errors);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new NormalizationError(`scout output for ${provider}/${shardId} is not an object`);
  }
  if (!Array.isArray(data.findings)) {
    throw new NormalizationError(`scout output for ${provider}/${shardId} has no findings array`);
  }

  const candidates = [];
  const dropped = [];

  for (const [index, finding] of data.findings.entries()) {
    const where = `${provider}/${shardId}#${index}`;
    if (!finding || typeof finding !== 'object') {
      throw new NormalizationError(`finding ${where} is not an object`);
    }

    const file = normalizePath(finding.file);
    const symbol = trimString(finding.symbol);
    const category = trimString(finding.category);
    const failurePath = trimString(finding.failure_path);
    const title = trimString(finding.title);
    const confidence = Number(finding.confidence);
    const lineStart = Number(finding.line_start);
    const lineEnd = Number(finding.line_end);
    const preconditions = cleanList(finding.preconditions);
    const evidence = cleanList(finding.evidence);

    if (!Number.isFinite(confidence) || confidence < minConfidence) {
      dropped.push({ where, title, reason: `confidence ${finding.confidence} below threshold ${minConfidence}` });
      continue;
    }
    if (!title || !symbol || !category || !failurePath || !file) {
      dropped.push({ where, title, reason: 'missing required text field after trimming' });
      continue;
    }
    if (!preconditions.length) {
      dropped.push({ where, title, reason: 'no non-empty preconditions' });
      continue;
    }
    if (!evidence.length) {
      dropped.push({ where, title, reason: 'no non-empty evidence entries' });
      continue;
    }
    if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart) {
      dropped.push({ where, title, reason: `invalid line range ${finding.line_start}-${finding.line_end}` });
      continue;
    }

    const fileInfo = fileReader ? await fileReader(file) : { exists: true, lineCount: Number.POSITIVE_INFINITY };
    if (!fileInfo?.exists) {
      dropped.push({ where, title, reason: `cited file does not exist: ${file}` });
      continue;
    }
    if (Number.isFinite(fileInfo.lineCount) && lineStart > fileInfo.lineCount) {
      dropped.push({ where, title, reason: `line_start ${lineStart} exceeds ${file} length ${fileInfo.lineCount}` });
      continue;
    }

    const fullId = candidateIdFor({ category, file, symbol, failurePath });
    candidates.push({
      candidateId: fullId,
      shortId: shortHash(fullId),
      provider,
      shard: shardId,
      jobId,
      runId,
      title,
      severity: SEVERITY_ORDER.includes(finding.severity) ? finding.severity : 'P3',
      confidence,
      category,
      file,
      symbol,
      lineStart,
      lineEnd,
      preconditions,
      failurePath,
      observableImpact: trimString(finding.observable_impact),
      evidence,
      reproCommand: finding.repro_command === null || finding.repro_command === undefined ? null : trimString(finding.repro_command) || null,
      suggestedTest: trimString(finding.suggested_test),
      falsePositiveRisk: trimString(finding.false_positive_risk)
    });
  }

  return {
    provider,
    shard: shardId,
    jobId,
    candidates,
    dropped,
    residualRisks: cleanList(data.residual_risks)
  };
}

/**
 * Normalize one challenger's verdict payload.
 *
 * A response that omits a requested candidate, judges an unknown candidate, or
 * returns two verdicts for the same candidate is rejected outright: partial
 * acceptance would silently leave candidates unchallenged.
 */
export function normalizeChallengeOutput({ data, schema, challenger, track = null, jobId, runId, expectedCandidateIds }) {
  if (schema) {
    const check = validate(schema, data);
    if (!check.valid) {
      throw new NormalizationError(`challenge output failed schema validation for ${challenger}`, check.errors);
    }
  }
  if (!data || !Array.isArray(data.verdicts)) {
    throw new NormalizationError(`challenge output for ${challenger} has no verdicts array`);
  }

  const expected = new Set(expectedCandidateIds);
  const seen = new Set();
  const verdicts = [];

  for (const raw of data.verdicts) {
    const candidateId = trimString(raw?.candidate_id);
    if (!candidateId) throw new NormalizationError(`challenge output for ${challenger} contains a verdict with no candidate id`);
    if (!expected.has(candidateId)) {
      throw new NormalizationError(`challenge output for ${challenger} judged unknown candidate ${shortHash(candidateId)}`);
    }
    if (seen.has(candidateId)) {
      throw new NormalizationError(`challenge output for ${challenger} returned multiple verdicts for ${shortHash(candidateId)}`);
    }
    seen.add(candidateId);

    verdicts.push({
      candidateId,
      shortId: shortHash(candidateId),
      verdict: raw.verdict,
      challenger,
      // Which track's finding this judges. Two tracks can judge the same
      // candidate id; the pair is what makes the verdict uniquely addressable.
      track,
      jobId,
      runId,
      rationale: trimString(raw.rationale),
      supportingEvidence: cleanList(raw.supporting_evidence),
      invalidatingEvidence: cleanList(raw.invalidating_evidence),
      minimalReproduction: raw.minimal_reproduction ? trimString(raw.minimal_reproduction) : null,
      confidence: Number(raw.confidence)
    });
  }

  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) {
    throw new NormalizationError(
      `challenge output for ${challenger} omitted ${missing.length} candidate(s): ${missing.map((id) => shortHash(id)).join(', ')}`
    );
  }

  return verdicts;
}

/**
 * Normalize a tiebreaker's payload.
 *
 * Same completeness contract as the challenge phase: an omitted, unknown, or
 * doubled candidate rejects the whole job, because a partially resolved dispute
 * set would silently leave findings stuck in `disputed` with no signal that the
 * tiebreaker never got to them.
 */
export function normalizeTiebreakOutput({ data, schema, tiebreaker, jobId, runId, expectedCandidateIds }) {
  if (schema) {
    const check = validate(schema, data);
    if (!check.valid) {
      throw new NormalizationError(`tiebreak output failed schema validation for ${tiebreaker}`, check.errors);
    }
  }
  if (!data || !Array.isArray(data.verdicts)) {
    throw new NormalizationError(`tiebreak output for ${tiebreaker} has no verdicts array`);
  }

  const expected = new Set(expectedCandidateIds);
  const seen = new Set();
  const tiebreaks = [];

  for (const raw of data.verdicts) {
    const candidateId = trimString(raw?.candidate_id);
    if (!candidateId) throw new NormalizationError(`tiebreak output for ${tiebreaker} contains a verdict with no candidate id`);
    if (!expected.has(candidateId)) {
      throw new NormalizationError(`tiebreak output for ${tiebreaker} judged unknown candidate ${shortHash(candidateId)}`);
    }
    if (seen.has(candidateId)) {
      throw new NormalizationError(`tiebreak output for ${tiebreaker} returned multiple verdicts for ${shortHash(candidateId)}`);
    }
    seen.add(candidateId);

    tiebreaks.push({
      candidateId,
      shortId: shortHash(candidateId),
      verdict: raw.verdict,
      resolves: raw.resolves,
      tiebreaker,
      jobId,
      runId,
      rationale: trimString(raw.rationale),
      supportingEvidence: cleanList(raw.supporting_evidence),
      invalidatingEvidence: cleanList(raw.invalidating_evidence),
      minimalReproduction: raw.minimal_reproduction ? trimString(raw.minimal_reproduction) : null,
      confidence: Number(raw.confidence)
    });
  }

  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) {
    throw new NormalizationError(
      `tiebreak output for ${tiebreaker} omitted ${missing.length} candidate(s): ${missing.map((id) => shortHash(id)).join(', ')}`
    );
  }

  return tiebreaks;
}
