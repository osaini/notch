/**
 * Covers the 0.1.x -> 0.2.0 hook-marker and backup migration.
 *
 * `HOOK_MARKER` and `BACKUP_PATH` are persisted identifiers living in the user's
 * real `~/.claude/settings.json`, so getting the rename wrong is silent and
 * destructive: orphaned hooks that fire twice, or a "pristine" backup overwritten
 * with an already-modified config. This pins both.
 *
 * Unlike `npm run verify`, this test is side-effect-free and safe for CI.
 * `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows, so setting both
 * before importing `hookInstaller` redirects SETTINGS_PATH and BACKUP_PATH into a
 * temp directory. The first assertion checks that redirect actually took, so a
 * future refactor that resolves the path earlier fails loudly here rather than
 * rewriting the developer's own Claude config.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-hook-migration-'))
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const claudeDir = path.join(sandbox, '.claude')
fs.mkdirSync(claudeDir, { recursive: true })
const settingsPath = path.join(claudeDir, 'settings.json')
const legacyBackupPath = `${settingsPath}.windows-notch-backup`
const newBackupPath = `${settingsPath}.notch-backup`

const TOKEN = 'a'.repeat(32)
const legacyUrl = (extra = ''): string =>
  `http://127.0.0.1:47821/hook?app=windows-notch&token=${TOKEN}${extra}`

/** A 0.1.x install, plus a user hook on an event we also use. */
const legacyInstall = {
  model: 'opus',
  hooks: {
    PermissionRequest: [{ hooks: [{ type: 'http', url: legacyUrl(), timeout: 45 }] }],
    Notification: [
      {
        matcher: 'permission_prompt|idle_prompt|agent_needs_input',
        hooks: [{ type: 'http', url: legacyUrl(), timeout: 5 }]
      },
      {
        matcher: 'agent_completed|auth_success|elicitation_complete|elicitation_response',
        hooks: [{ type: 'http', url: legacyUrl('&intent=info'), timeout: 5 }]
      }
    ],
    Stop: [{ hooks: [{ type: 'http', url: legacyUrl(), timeout: 5 }] }],
    SessionEnd: [{ hooks: [{ type: 'http', url: legacyUrl(), timeout: 5 }] }],
    PreToolUse: [
      { matcher: 'AskUserQuestion', hooks: [{ type: 'http', url: legacyUrl(), timeout: 600 }] },
      // Someone else's hook, on an event we rewrite. The easiest thing to break.
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] },
      // Contains the old raw substring but not the app=notch query parameter.
      { matcher: 'Foreign', hooks: [{ type: 'http', url: 'https://example.test/hook?myapp=notch' }] }
    ],
    UserPromptSubmit: [{ hooks: [{ type: 'http', url: legacyUrl(), timeout: 5 }] }]
  },
  tui: 'fullscreen',
  skipDangerousModePermissionPrompt: true
}

const USER_HOOK = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }
const FOREIGN_HOOK = {
  matcher: 'Foreign',
  hooks: [{ type: 'http', url: 'https://example.test/hook?myapp=notch' }]
}
/** A backup captured before the 0.1.x install existed — the file we must not lose. */
const PRISTINE_BACKUP = `${JSON.stringify({ model: 'opus', tui: 'fullscreen' }, null, 2)}\n`

const pass = (msg: string): void => console.log(`  PASS  ${msg}`)

function seed(): void {
  fs.writeFileSync(settingsPath, `${JSON.stringify(legacyInstall, null, 2)}\n`, 'utf8')
}

function markers(): { current: number; legacy: number } {
  const text = fs.readFileSync(settingsPath, 'utf8')
  return {
    current: (text.match(/[?&]app=notch(?:&|"|$)/g) ?? []).length,
    legacy: (text.match(/[?&]app=windows-notch(?:&|"|$)/g) ?? []).length
  }
}

function readSettings(): typeof legacyInstall {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as typeof legacyInstall
}

async function main(): Promise<void> {
  const { HOOK_EVENTS } = await import('../src/main/hookServer')
  const { BACKUP_PATH, SETTINGS_PATH, getHookStatus, installHooks, uninstallHooks } = await import(
    '../src/main/hookInstaller'
  )

  // Refuse to run at all if the sandbox redirect did not take.
  assert.equal(SETTINGS_PATH, settingsPath, 'sandbox redirect failed — would touch the real config')
  assert.equal(BACKUP_PATH, newBackupPath, 'sandbox redirect failed for BACKUP_PATH')
  pass('SETTINGS_PATH and BACKUP_PATH are redirected into the sandbox')

  seed()
  fs.writeFileSync(legacyBackupPath, PRISTINE_BACKUP, 'utf8')

  const before = await getHookStatus()
  assert.equal(before.installed, true, 'a legacy install must still be recognised as ours')
  assert.equal(before.complete, false, 'legacy entries require a current-spec repair')
  assert.equal(before.hasLegacyMarker, true, 'the legacy marker must be reported')
  assert.equal(before.port, 47821, 'the port must still be readable from a legacy URL')
  assert.equal(before.backupPath, legacyBackupPath, 'a legacy backup must be reported as the backup')
  pass('getHookStatus recognises a 0.1.x install and flags hasLegacyMarker')

  await installHooks(47821, TOKEN)

  const counts = markers()
  assert.equal(counts.legacy, 0, `expected no legacy markers, found ${counts.legacy}`)
  // One entry per event, plus the second Notification group carrying intent=info.
  assert.equal(
    counts.current,
    HOOK_EVENTS.length + 1,
    `expected ${HOOK_EVENTS.length + 1} migrated entries, found ${counts.current}`
  )
  pass(`install rewrote all ${counts.current} entries to the current marker`)

  const migrated = readSettings()
  for (const [event, groups] of Object.entries(migrated.hooks)) {
    const ours = (groups as { hooks?: { url?: string }[] }[]).flatMap((group) =>
      (group.hooks ?? []).filter((cmd) => typeof cmd.url === 'string' && cmd.url.includes('app=notch'))
    )
    assert.equal(
      new Set(ours.map((cmd) => cmd.url)).size,
      ours.length,
      `${event} gained a duplicate entry — it would fire twice per event`
    )
  }
  pass('no event gained a duplicate entry')

  assert.equal((await getHookStatus()).hasLegacyMarker, false)
  assert.equal((await getHookStatus()).complete, true)
  pass('hasLegacyMarker clears, so startup stops reinstalling on every launch')

  const partial = readSettings()
  partial.hooks.Notification = partial.hooks.Notification.slice(1)
  fs.writeFileSync(settingsPath, `${JSON.stringify(partial, null, 2)}\n`, 'utf8')
  const partialStatus = await getHookStatus()
  assert.equal(partialStatus.installed, true)
  assert.equal(partialStatus.complete, false)
  await installHooks(47821, TOKEN)
  assert.equal((await getHookStatus()).complete, true)
  pass('a missing Notification specification is detected and repairable')

  assert.deepEqual(
    migrated.hooks.PreToolUse.find((group) => (group as { matcher?: string }).matcher === 'Bash'),
    USER_HOOK,
    "the user's own hook was modified"
  )
  assert.deepEqual(
    migrated.hooks.PreToolUse.find((group) => (group as { matcher?: string }).matcher === 'Foreign'),
    FOREIGN_HOOK,
    'a foreign URL containing myapp=notch was misclassified as ours'
  )
  assert.equal(migrated.model, 'opus')
  assert.equal(migrated.tui, 'fullscreen')
  assert.equal(migrated.skipDangerousModePermissionPrompt, true)
  pass("the user's own hook and every non-hook key survive the migration")

  // The sharp edge. By install time settings.json already carries our hooks, so
  // writing a fresh backup would replace the pristine copy with a modified one.
  assert.equal(fs.existsSync(legacyBackupPath), false, 'the legacy backup should have been renamed')
  assert.equal(
    fs.readFileSync(newBackupPath, 'utf8'),
    PRISTINE_BACKUP,
    'the pristine backup was replaced by an already-modified settings.json'
  )
  pass('the pristine pre-0.2 backup was renamed, not overwritten')

  await uninstallHooks()
  assert.deepEqual(markers(), { current: 0, legacy: 0 }, 'uninstall left entries behind')
  assert.deepEqual(
    readSettings().hooks,
    { PreToolUse: [USER_HOOK, FOREIGN_HOOK] },
    'uninstall must leave exactly the user hook'
  )
  assert.equal(readSettings().model, 'opus')
  pass('uninstall after migration removes only our entries')

  // Uninstalling a 0.1.x install directly, with no migrating install first, is
  // the path a user takes when they just want the app gone.
  seed()
  await uninstallHooks()
  assert.deepEqual(markers(), { current: 0, legacy: 0 }, 'a pure legacy install must be removable')
  assert.deepEqual(readSettings().hooks, { PreToolUse: [USER_HOOK, FOREIGN_HOOK] })
  pass('a 0.1.x install can be uninstalled without an install migrating it first')

  const emptyOnly = '{"hooks":{"PreCompact":[]}}\n'
  fs.writeFileSync(settingsPath, emptyOnly, 'utf8')
  await uninstallHooks()
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), emptyOnly)
  pass('uninstall is a byte-for-byte no-op for a user-owned empty event array')

  const malformed = '{"hooks":{"Stop":{"legacy":true}}}\n'
  fs.writeFileSync(settingsPath, malformed, 'utf8')
  const refused = await installHooks(47821, TOKEN)
  assert.match(refused.error ?? '', /hooks\.Stop must be an array/)
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), malformed)
  pass('install refuses a malformed managed event without overwriting it')

  const exactForeign = {
    hooks: {
      PreToolUse: [{
        matcher: 'Foreign',
        hooks: [{ type: 'http', url: 'https://example.test/callback?app=notch&token=foreign' }]
      }]
    }
  }
  fs.writeFileSync(settingsPath, `${JSON.stringify(exactForeign, null, 2)}\n`, 'utf8')
  await installHooks(47821, TOKEN)
  await uninstallHooks()
  assert.deepEqual(readSettings(), exactForeign)
  pass('an external hook carrying app=notch is never classified as ours')

  console.log('\nHook migration tests passed.')
}

main()
  .catch((err) => {
    console.error(`\nFAIL: ${(err as Error).message}`)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(sandbox, { recursive: true, force: true })
  })
