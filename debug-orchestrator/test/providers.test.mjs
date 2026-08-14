import assert from 'node:assert/strict';
import test from 'node:test';

import { buildArgs as buildClaudeArgs, extractStructured, READ_ONLY_TOOLS, WRITE_TOOLS } from '../lib/providers/claude.mjs';
import { buildArgs as buildCodexArgs, extractJson } from '../lib/providers/codex.mjs';
import { toProviderSchema } from '../lib/validate.mjs';
import {
  assertReadOnlyArgs,
  assertWriteScopedArgs,
  findWriteCapableArgs,
  redactArgs
} from '../lib/providers/safety.mjs';

const claudeArgs = buildClaudeArgs({
  model: 'opus',
  effort: 'high',
  schemaJson: JSON.stringify({ type: 'object' }),
  maxBudgetUsd: 3
});

const codexArgs = buildCodexArgs({
  repoRoot: 'C:/repo/windows-notch',
  model: 'gpt-5.6-sol',
  schemaPath: 'C:/repo/.debug-runs/run/schemas/findings.provider.json',
  resultPath: 'C:/repo/.debug-runs/run/raw/codex/scout.result.json',
  capabilities: { strictConfig: true }
});

test('scan commands never expose write-capable flags', () => {
  assert.deepEqual(findWriteCapableArgs(claudeArgs), []);
  assert.deepEqual(findWriteCapableArgs(codexArgs), []);
  assert.doesNotThrow(() => assertReadOnlyArgs('claude', claudeArgs));
  assert.doesNotThrow(() => assertReadOnlyArgs('codex', codexArgs));
});

test('the safety check actually catches write-capable arguments', () => {
  assert.throws(() => assertReadOnlyArgs('claude', ['--tools', 'Read,Write']), /write-capable tool: Write/);
  assert.throws(() => assertReadOnlyArgs('claude', ['--tools', 'Read,Edit,Bash']), /Edit/);
  assert.throws(() => assertReadOnlyArgs('claude', ['--dangerously-skip-permissions']), /forbidden flag/);
  assert.throws(() => assertReadOnlyArgs('codex', ['--sandbox', 'danger-full-access']), /forbidden value/);
  assert.throws(() => assertReadOnlyArgs('codex', ['--sandbox', 'workspace-write']), /forbidden value/);
  assert.throws(() => assertReadOnlyArgs('codex', ['--dangerously-bypass-approvals-and-sandbox']), /forbidden flag/);
  assert.throws(() => assertReadOnlyArgs('codex', ['--add-dir', 'C:/elsewhere']), /forbidden flag/);
});

test('file paths are not mistaken for tool names', () => {
  assert.deepEqual(findWriteCapableArgs(['src/main/dispatcher.ts', 'C:/repo/Write/thing.ts', 'src/renderer']), []);
});

const WORKTREE = 'C:/repo/.debug-runs/run/tree';

test('the implement command grants write access only inside the run worktree', () => {
  const claudeWrite = buildClaudeArgs({
    model: 'opus',
    schemaJson: '{}',
    mode: 'write'
  });
  const codexWrite = buildCodexArgs({
    repoRoot: WORKTREE,
    model: 'gpt-5.6-sol',
    schemaPath: 'C:/schema.json',
    resultPath: 'C:/result.json',
    capabilities: { strictConfig: true },
    mode: 'write'
  });

  // The widened permissions the implementer actually needs.
  assert.ok(claudeWrite.includes('acceptEdits'));
  assert.deepEqual(WRITE_TOOLS, ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash']);
  assert.equal(codexWrite[codexWrite.indexOf('--sandbox') + 1], 'workspace-write');

  assert.doesNotThrow(() => assertWriteScopedArgs('claude', claudeWrite, WORKTREE));
  assert.doesNotThrow(() => assertWriteScopedArgs('codex', codexWrite, WORKTREE));
});

test('write mode still refuses every sandbox escape hatch', () => {
  assert.throws(() => assertWriteScopedArgs('codex', ['--sandbox', 'danger-full-access'], WORKTREE), /forbidden value/);
  assert.throws(() => assertWriteScopedArgs('codex', ['--dangerously-bypass-approvals-and-sandbox'], WORKTREE), /forbidden flag/);
  assert.throws(() => assertWriteScopedArgs('claude', ['--dangerously-skip-permissions'], WORKTREE), /forbidden flag/);
  // --add-dir would let the implementer reach outside its worktree.
  assert.throws(() => assertWriteScopedArgs('claude', ['--add-dir', 'C:/elsewhere'], WORKTREE), /forbidden flag/);
  assert.throws(() => assertWriteScopedArgs('claude', ['--yolo'], WORKTREE), /forbidden flag/);
});

test('a write command aimed anywhere but the run worktree is rejected', () => {
  const escaped = buildCodexArgs({
    repoRoot: 'C:/repo',
    model: 'gpt-5.6-sol',
    schemaPath: 'C:/schema.json',
    resultPath: 'C:/result.json',
    capabilities: {},
    mode: 'write'
  });
  assert.throws(() => assertWriteScopedArgs('codex', escaped, WORKTREE), /not the run worktree/);
  assert.throws(() => assertWriteScopedArgs('codex', escaped, null), /requires a worktree path/);
});

test('read-only mode is still the default for both adapters', () => {
  assert.equal(buildCodexArgs({
    repoRoot: WORKTREE,
    model: 'm',
    schemaPath: 'a',
    resultPath: 'b',
    capabilities: {}
  })[
    buildCodexArgs({ repoRoot: WORKTREE, model: 'm', schemaPath: 'a', resultPath: 'b', capabilities: {} }).indexOf('--sandbox') + 1
  ], 'read-only');
  assert.ok(buildClaudeArgs({ model: 'opus', schemaJson: '{}' }).includes('plan'));
});

test('the claude command is read-only, plan-mode, budgeted, and non-persistent', () => {
  assert.equal(claudeArgs[0], '-p');
  assert.deepEqual(READ_ONLY_TOOLS, ['Read', 'Glob', 'Grep']);
  const pairs = new Map();
  for (let index = 0; index < claudeArgs.length; index += 1) {
    if (claudeArgs[index].startsWith('--')) pairs.set(claudeArgs[index], claudeArgs[index + 1]);
  }
  assert.equal(pairs.get('--model'), 'opus');
  assert.equal(pairs.get('--effort'), 'high');
  assert.equal(pairs.get('--permission-mode'), 'plan');
  assert.equal(pairs.get('--tools'), 'Read,Glob,Grep');
  assert.equal(pairs.get('--output-format'), 'json');
  assert.equal(pairs.get('--max-budget-usd'), '3');
  assert.ok(claudeArgs.includes('--no-session-persistence'));
  assert.equal(pairs.get('--json-schema'), JSON.stringify({ type: 'object' }), 'schema contents, not a path');
});

test('the codex command is ephemeral, read-only sandboxed, and schema-bound', () => {
  assert.equal(codexArgs[0], 'exec');
  assert.ok(codexArgs.includes('--ephemeral'));
  assert.ok(codexArgs.includes('--strict-config'));
  assert.equal(codexArgs[codexArgs.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(codexArgs[codexArgs.indexOf('--model') + 1], 'gpt-5.6-sol');
  assert.ok(codexArgs.includes('--output-schema'));
  assert.ok(codexArgs.includes('--output-last-message'));
  assert.equal(codexArgs[codexArgs.length - 1], '-', 'the prompt must arrive on stdin');
  assert.ok(!codexArgs.some((arg) => String(arg).includes('service_tier')), 'service_tier must stay unset');
});

test('an unsupported --strict-config is dropped rather than breaking every job', () => {
  const args = buildCodexArgs({
    repoRoot: 'C:/repo',
    model: 'gpt-5.6-sol',
    schemaPath: 's.json',
    resultPath: 'r.json',
    capabilities: { strictConfig: false }
  });
  assert.ok(!args.includes('--strict-config'));
  assert.ok(args.includes('--sandbox'));
});

test('the recorded argv redacts the inline schema payload', () => {
  const schemaJson = JSON.stringify({ type: 'object' });
  const recorded = redactArgs(claudeArgs, [{ value: schemaJson, placeholder: '<json-schema sha256:abc123>' }]);
  assert.ok(!recorded.includes(schemaJson));
  assert.ok(recorded.includes('<json-schema sha256:abc123>'));
});

test('provider schemas omit draft declarations unsupported by Claude structured output', () => {
  const projected = toProviderSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { value: { type: 'string', minLength: 1 } }
  });
  assert.equal(projected.$schema, undefined);
  assert.equal(projected.properties.value.minLength, undefined);
  assert.deepEqual(projected.required, ['value']);
});

test('claude structured output is read from the envelope, never invented', () => {
  const payload = { shard_id: 'main-lifecycle', findings: [], residual_risks: [] };
  assert.deepEqual(extractStructured({ type: 'result', structured_output: payload }).value, payload);
  assert.deepEqual(extractStructured({ type: 'result', result: JSON.stringify(payload) }).value, payload);
  assert.deepEqual(extractStructured([{ type: 'system' }, { type: 'result', structuredOutput: payload }]).value, payload);
  assert.equal(extractStructured({ type: 'result', result: 'I could not complete the audit.' }), null);
  assert.equal(extractStructured(null), null);
});

test('codex result extraction tolerates fences but refuses non-JSON', () => {
  assert.equal(extractJson('{"a":1}'), '{"a":1}');
  assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJson('Here you go:\n{"a":1}'), '{"a":1}');
  assert.throws(() => extractJson('   '), /empty result/);
  assert.throws(() => extractJson('no json here'), /no JSON object/);
});
