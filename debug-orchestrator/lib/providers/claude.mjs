import { readFile } from 'node:fs/promises';

import { resolveCommand, spawnCapture } from '../proc.mjs';
import { sha256Hex, shortHash } from '../hash.mjs';
import { validate } from '../validate.mjs';
import { assertReadOnlyArgs, assertWriteScopedArgs, redactArgs } from './safety.mjs';

export const PROVIDER = 'claude';
export const COMMAND_NAME = 'claude';

/** Read-only tool set for discovery and challenge. Write/Edit/Bash are never granted. */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

/** Implement-phase tools. Only ever paired with a worktree-scoped cwd. */
export const WRITE_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'];

export function buildArgs({
  model,
  effort,
  tools,
  schemaJson,
  maxBudgetUsd,
  /** `read-only` for scout/challenge/critique/review; `write` for implement. */
  mode = 'read-only'
}) {
  const writing = mode === 'write';
  const args = ['-p'];
  args.push('--model', model);
  if (effort) args.push('--effort', effort);
  // `plan` mode cannot apply edits even if a write tool were somehow reachable.
  args.push('--permission-mode', writing ? 'acceptEdits' : 'plan');
  args.push('--tools', (tools ?? (writing ? WRITE_TOOLS : READ_ONLY_TOOLS)).join(','));
  args.push('--output-format', 'json');
  args.push('--json-schema', schemaJson);
  if (maxBudgetUsd !== undefined && maxBudgetUsd !== null) {
    args.push('--max-budget-usd', String(maxBudgetUsd));
  }
  args.push('--no-session-persistence');
  return args;
}

/**
 * Pull the validated structured object out of the `--output-format json` envelope.
 *
 * Returns `{ value, source }`, or `null` when the envelope carries no structured
 * field. The caller fails the job in that case and keeps the raw response.
 */
export function extractStructured(envelope) {
  const record = Array.isArray(envelope)
    ? [...envelope].reverse().find((entry) => entry && typeof entry === 'object' && entry.type === 'result') ??
      envelope[envelope.length - 1]
    : envelope;
  if (!record || typeof record !== 'object') return null;

  const directKeys = ['structured_output', 'structuredOutput', 'structured_result', 'structuredResult', 'structured'];
  for (const key of directKeys) {
    const value = record[key];
    if (value && typeof value === 'object') return { value, source: key };
    if (typeof value === 'string') {
      const parsed = tryParse(value);
      if (parsed) return { value: parsed, source: key };
    }
  }

  // Some builds nest the structured object inside `result`.
  if (record.result && typeof record.result === 'object') {
    return { value: record.result, source: 'result' };
  }
  if (typeof record.result === 'string') {
    const parsed = tryParse(record.result);
    if (parsed) return { value: parsed, source: 'result:json' };
  }
  return null;
}

function tryParse(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = trimmed.startsWith('{') || trimmed.startsWith('[') ? trimmed : fenced ? fenced[1].trim() : null;
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Run one Claude job.
 *
 * The full JSON envelope is preserved as raw output. Only the structured object
 * inside it is normalized; an absent structured field fails the job rather than
 * degrading into an empty successful result.
 */
export async function runJob({
  repoRoot,
  prompt,
  schema,
  providerSchema,
  rawOutputPath,
  rawErrorPath,
  timeoutMs,
  modelConfig = {},
  mode = 'read-only',
  /** Required when `mode` is `write`: the only tree the job may modify. */
  worktreePath = null
}) {
  const commandPath = await resolveCommand(COMMAND_NAME);
  if (!commandPath) {
    return {
      status: 'failed',
      exitCode: null,
      data: null,
      metadata: { errorSummary: `Could not resolve "${COMMAND_NAME}" on PATH.`, argv: [] }
    };
  }

  const schemaJson = JSON.stringify(providerSchema ?? schema);
  const args = buildArgs({
    model: modelConfig.model ?? 'opus',
    effort: modelConfig.effort ?? 'high',
    schemaJson,
    maxBudgetUsd: modelConfig.maxBudgetUsdPerJob,
    mode
  });
  // Claude has no `--cd`: it writes wherever it is spawned, so the scoping
  // guarantee is the cwd passed to spawnCapture below, which must be the
  // worktree. Assert that rather than trusting the caller.
  if (mode === 'write') {
    assertWriteScopedArgs(PROVIDER, args, worktreePath);
    if (repoRoot !== worktreePath) {
      throw new Error(`claude implement job would run in ${repoRoot}, not the run worktree ${worktreePath}`);
    }
  } else {
    assertReadOnlyArgs(PROVIDER, args);
  }

  const recordedArgv = redactArgs(args, [
    { value: schemaJson, placeholder: `<json-schema sha256:${shortHash(sha256Hex(schemaJson))}>` }
  ]);

  const run = await spawnCapture({
    command: commandPath,
    args,
    cwd: repoRoot,
    stdin: prompt,
    stdoutPath: rawOutputPath,
    stderrPath: rawErrorPath,
    timeoutMs
  });

  const metadata = {
    command: commandPath,
    argv: recordedArgv,
    durationMs: run.durationMs,
    warnings: [],
    errorSummary: run.error ?? null,
    stderrTail: run.stderrTail
  };

  if (run.status !== 'succeeded') {
    return { status: run.status, exitCode: run.exitCode, data: null, metadata };
  }

  let rawText;
  try {
    rawText = await readFile(rawOutputPath, 'utf8');
  } catch (error) {
    return {
      status: 'failed',
      exitCode: run.exitCode,
      data: null,
      metadata: { ...metadata, errorSummary: `Could not read Claude raw output: ${String(error?.message ?? error)}` }
    };
  }

  let envelope;
  try {
    envelope = JSON.parse(rawText);
  } catch (error) {
    return {
      status: 'failed',
      exitCode: run.exitCode,
      data: null,
      metadata: {
        ...metadata,
        errorSummary: `Claude envelope is not valid JSON: ${String(error?.message ?? error)}`,
        rawDigest: shortHash(sha256Hex(rawText))
      }
    };
  }

  const envelopeRecord = Array.isArray(envelope) ? envelope[envelope.length - 1] : envelope;
  if (envelopeRecord?.is_error === true || envelopeRecord?.subtype === 'error_max_budget') {
    return {
      status: 'failed',
      exitCode: run.exitCode,
      data: null,
      metadata: { ...metadata, errorSummary: `Claude reported an error envelope (subtype=${envelopeRecord?.subtype ?? 'unknown'})` }
    };
  }

  const structured = extractStructured(envelope);
  if (!structured) {
    return {
      status: 'failed',
      exitCode: run.exitCode,
      data: null,
      metadata: {
        ...metadata,
        errorSummary: 'Claude envelope contained no structured output field; raw response retained for diagnosis.'
      }
    };
  }

  const check = validate(schema, structured.value);
  if (!check.valid) {
    return {
      status: 'failed',
      exitCode: run.exitCode,
      data: null,
      metadata: {
        ...metadata,
        errorSummary: `Claude output failed schema validation: ${check.errors.slice(0, 5).join('; ')}`,
        structuredSource: structured.source
      }
    };
  }

  return {
    status: 'succeeded',
    exitCode: run.exitCode,
    data: structured.value,
    metadata: {
      ...metadata,
      structuredSource: structured.source,
      usage: envelopeRecord?.usage ?? null,
      totalCostUsd: envelopeRecord?.total_cost_usd ?? null
    }
  };
}
