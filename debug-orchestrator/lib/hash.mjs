import { createHash } from 'node:crypto';

/** Deterministic JSON with sorted object keys, so hashes do not depend on key order. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  const body = keys
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',');
  return `{${body}}`;
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function hashObject(value) {
  return sha256Hex(stableStringify(value));
}

export function shortHash(hex, length = 12) {
  return String(hex).slice(0, length);
}

/** Lowercased, whitespace-collapsed text used for identity hashing and token comparison. */
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
