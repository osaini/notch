import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { UsageError, parseArgs } from '../lib/cli.mjs';
import { assertSubset } from '../lib/validate.mjs';
import { compareVersions, meetsMinimum, parseVersion, isPluginEnabled } from '../lib/preflight.mjs';

const ORCHESTRATOR_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(await readFile(path.join(ORCHESTRATOR_DIR, 'manifest.example.json'), 'utf8'));
const shardIds = manifest.shards.map((shard) => shard.id);

test('parses the documented commands and flags', () => {
  assert.deepEqual(parseArgs(['preflight']), { command: 'preflight', options: {} });
  assert.deepEqual(parseArgs(['scan']), { command: 'scan', options: {} });
  assert.deepEqual(parseArgs(['scan', '--shard', 'core'], { shardIds }), {
    command: 'scan',
    options: { shard: 'core' }
  });
  assert.deepEqual(parseArgs(['scan', '--shard=core'], { shardIds }), {
    command: 'scan',
    options: { shard: 'core' }
  });
  assert.deepEqual(parseArgs(['scan', '--provider', 'codex']), { command: 'scan', options: { provider: 'codex' } });
  assert.deepEqual(parseArgs(['resume', '--run', 'abc']), { command: 'resume', options: { run: 'abc' } });
  assert.deepEqual(parseArgs(['report', '--latest']), { command: 'report', options: { latest: true } });
});

test('unknown commands, flags, providers, and shards are usage errors', () => {
  for (const argv of [
    [],
    ['fix'],
    ['scan', '--dry-run'],
    ['scan', '--provider', 'gemini'],
    ['scan', '--shard', 'nope'],
    ['scan', '--shard'],
    ['scan', 'extra'],
    ['resume'],
    ['report'],
    ['report', '--run', 'abc', '--latest'],
    ['preflight', '--shard', 'main-lifecycle']
  ]) {
    assert.throws(() => parseArgs(argv, { shardIds }), UsageError, `expected "${argv.join(' ')}" to be rejected`);
  }
});

test('--help short-circuits to the help command', () => {
  assert.deepEqual(parseArgs(['--help']), { command: 'help', options: {} });
  assert.deepEqual(parseArgs(['scan', '--help'], { shardIds }), { command: 'help', options: {} });
});

test('the manifest is internally consistent', () => {
  assert.equal(manifest.version, 1);
  assert.equal(new Set(shardIds).size, shardIds.length, 'shard ids must be unique');
  for (const shard of manifest.shards) {
    assert.ok(shard.id && shard.description, `${shard.id} needs an id and description`);
    assert.ok(Array.isArray(shard.paths) && shard.paths.length, `${shard.id} needs at least one path`);
    for (const entry of shard.paths) {
      assert.ok(!path.isAbsolute(entry), `${shard.id} path "${entry}" must be repository-relative`);
      assert.ok(!entry.includes('\\'), `${shard.id} path "${entry}" must use forward slashes`);
    }
  }
  for (const provider of ['claude', 'codex']) {
    assert.ok(manifest.concurrency[provider] >= 1, `${provider} needs a concurrency limit`);
    assert.ok(manifest.providers[provider]?.model, `${provider} needs a model`);
  }
  for (const phase of ['scout', 'challenge', 'reproduce']) {
    assert.ok(manifest.timeoutsMinutes[phase] > 0, `${phase} needs a timeout`);
  }
});

test('the fix command needs a scan run to read findings from', () => {
  assert.throws(() => parseArgs(['fix']), /requires --run <run-id> or --latest/);
  assert.throws(() => parseArgs(['fix', '--run', 'r1', '--latest']), /not both/);
  assert.equal(parseArgs(['fix', '--latest']).command, 'fix');
  assert.equal(parseArgs(['fix', '--run', '20260730-120000-f177f4d']).options.run, '20260730-120000-f177f4d');
  // --clean is a teardown that needs no run to read from.
  assert.equal(parseArgs(['fix', '--clean', '20260730-120000-f177f4d']).options.clean, '20260730-120000-f177f4d');
});

test('fix rejects a non-positive cap rather than silently fixing nothing', () => {
  assert.throws(() => parseArgs(['fix', '--latest', '--max-fixes', '0']), /--max-fixes must be a positive integer/);
  assert.throws(() => parseArgs(['fix', '--latest', '--max-fixes', 'many']), /--max-fixes must be a positive integer/);
  assert.throws(() => parseArgs(['fix', '--latest', '--max-rounds', '-1']), /--max-rounds must be a positive integer/);
  assert.equal(parseArgs(['fix', '--latest', '--max-fixes', '3']).options['max-fixes'], '3');
  assert.equal(parseArgs(['fix', '--latest', '--include-tiebroken']).options['include-tiebroken'], true);
});

test('every schema stays inside the bundled validator subset', async () => {
  for (const name of ['findings', 'verdicts', 'tiebreak', 'reproduction', 'fixplan', 'plan', 'review', 'implementation']) {
    const schema = JSON.parse(await readFile(path.join(ORCHESTRATOR_DIR, 'schemas', `${name}.schema.json`), 'utf8'));
    assert.doesNotThrow(() => assertSubset(schema), `${name}.schema.json uses an unsupported keyword`);
  }
});

test('version comparison treats a prerelease as older than its release', () => {
  assert.equal(parseVersion('codex-cli 0.130.0-alpha.5').raw, '0.130.0-alpha.5');
  assert.equal(parseVersion('2.1.220 (Claude Code)').raw, '2.1.220');
  assert.equal(compareVersions('0.146.0-alpha.1', '0.146.0'), -1);
  assert.equal(compareVersions('0.146.0', '0.146.0'), 0);
  assert.equal(compareVersions('0.147.0', '0.146.0'), 1);
  assert.equal(meetsMinimum('0.130.0-alpha.5', '0.146.0'), false);
  assert.equal(meetsMinimum('2.1.220', '2.1.217'), true);
  assert.equal(meetsMinimum('not a version', '1.0.0'), false);
});

test('plugin detection only trusts the plugin\'s own status line', () => {
  const enabled = ['Installed plugins:', '', '  codex@openai-codex', '    Version: 1.0.6', '    Status: enabled'].join('\n');
  const disabled = ['  codex@openai-codex', '    Status: disabled', '', '  other-plugin', '    Status: enabled'].join('\n');
  assert.equal(isPluginEnabled(enabled, 'codex@openai-codex'), true);
  assert.equal(isPluginEnabled(disabled, 'codex@openai-codex'), false);
  assert.equal(isPluginEnabled(enabled, 'missing-plugin'), false);
});
