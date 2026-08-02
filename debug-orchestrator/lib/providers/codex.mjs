import { readFile, rm } from 'node:fs/promises';

import { resolveCommand, runCapture, spawnCapture } from '../proc.mjs';
import { shortHash, sha256Hex } from '../hash.mjs';
import { validate } from '../validate.mjs';
import { assertReadOnlyArgs, assertWriteScopedArgs } from './safety.mjs';

export const PROVIDER = 'codex';
export const COMMAND_NAME = 'codex';

let capabilityCache = null;

/**
 * `--strict-config` was added after Codex 0.146.0. Preflight is what enforces the
 * supported version floor; this probe keeps the adapter honest on an older CLI by
 * dropping an unsupported flag and reporting it, instead of failing every job
 * with an argument-parse error.
 */
export async function detectCapabilities(commandPath, { force = false } = {}) {
  if (capabilityCache && !force) return capabilityCache;
  const help = await runCapture(commandPath, ['exec', '--help'], { timeoutMs: 30_000 });
  const text = `${help.stdout}${help.stderr}`;
  capabilityCache = {
    strictConfig: text.includes('--strict-config'),
    outputSchema: text.includes('--output-schema'),
    outputLastMessage: text.includes('--output-last-message'),
    ephemeral: text.includes('--ephemeral'),
    probed: help.status === 'succeeded'
  };
  return capabilityCache;
}

export function resetCapabilityCache() {
  capabilityCache = null;
}

export function buildArgs({ repoRoot, model, schemaPath, resultPath, capabilities = {}, mode = 'read-only' }) {
  const args = ['exec'];
  if (capabilities.ephemeral !== false) args.push('--ephemeral');
  if (capabilities.strictConfig) args.push('--strict-config');
  args.push('--model', model);
  args.push('--cd', repoRoot);
  // Read-only for scan and review. `workspace-write` is granted only to the
  // implement phase, where `--cd` is the run's own worktree, so the widened
  // sandbox still cannot reach the user's checkout.
  args.push('--sandbox', mode === 'write' ? 'workspace-write' : 'read-only');
  args.push('--output-schema', schemaPath);
  args.push('--output-last-message', resultPath);
  // `service_tier` is deliberately left unset so Standard processing is used.
  args.push('-');
  return args;
}

/**
 * Run one Codex job.
 *
 * stdout is progress JSONL and is streamed to disk for auditing only. The
 * structured payload is the file written by `--output-last-message`; stderr is
 * never parsed as a finding payload.
 */
export async function runJob({
  repoRoot,
  prompt,
  schema,
  schemaPath,
  resultPath,
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

  const capabilities = await detectCapabilities(commandPath);
  const args = buildArgs({
    repoRoot,
    model: modelConfig.model ?? 'gpt-5.6-sol',
    schemaPath,
    resultPath,
    capabilities,
    mode
  });
  if (mode === 'write') assertWriteScopedArgs(PROVIDER, args, worktreePath);
  else assertReadOnlyArgs(PROVIDER, args);

  const warnings = [];
  if (!capabilities.strictConfig) {
    warnings.push('codex CLI does not support --strict-config; flag omitted');
  }

  // A retry must never read the previous attempt's result file.
  await rm(resultPath, { force: true });

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
    argv: args,
    durationMs: run.durationMs,
    warnings,
    capabilities,
    errorSummary: run.error ?? null,
    stderrTail: run.stderrTail
  };

  if (run.status !== 'succeeded') {
    return { status: run.status, exitCode: run.exitCode, data: null, metadata };
  }

  let rawResult;
  try {
    rawResult = await readFile(resultPath, 'utf8');
  } catch (error) {
    return {
      status: 'failed',
      exitCode: run.exitCode,
      data: null,
      metadata: { ...metadata, errorSummary: `Codex wrote no structured result file: ${String(error?.message ?? error)}` }
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(extractJson(rawResult));
  } catch (error) {
    return {
      status: 'failed',
      exitCode: run.exitCode,
      data: null,
      metadata: {
        ...metadata,
        errorSummary: `Codex structured result is not valid JSON: ${String(error?.message ?? error)}`,
        resultDigest: shortHash(sha256Hex(rawResult))
      }
    };
  }

  const check = validate(schema, parsed);
  if (!check.valid) {
    return {
      status: 'failed',
      exitCode: run.exitCode,
      data: null,
      metadata: { ...metadata, errorSummary: `Codex output failed schema validation: ${check.errors.slice(0, 5).join('; ')}` }
    };
  }

  return { status: 'succeeded', exitCode: run.exitCode, data: parsed, metadata };
}

/** Tolerate a fenced or prose-wrapped payload without ever inventing data. */
export function extractJson(text) {
  const trimmed = String(text).trim();
  if (!trimmed) throw new Error('empty result');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  throw new Error('no JSON object found in result');
}
