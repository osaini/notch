/**
 * Cowork session discovery, against a fixture tree.
 *
 * The rules under test are the ones whose violations are silent or expensive:
 * an archived chat resurfacing as a live row, a months-dormant chat never aging
 * out, a read failure being mistaken for proof that a session died, and — the
 * one that would actually hurt — the enumerator wandering into a session
 * directory, where the real thing keeps a 40 MB audit log next to a 9 GB VM
 * image.
 *
 * `NOTCH_COWORK_DIR` is set before importing anything, because `AGENT_PATHS` is
 * resolved at module load.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'notch-cowork-'))
process.env.NOTCH_COWORK_DIR = FIXTURE

const ACCOUNT = '042d99bf-40ab-4131-abcc-5a35f6f1143c'
const ORG = '8bf17b7a-d532-46db-90a1-f2562840d588'
const ORG_DIR = path.join(FIXTURE, ACCOUNT, ORG)

const MINUTE = 60_000
const NOW = Date.now()

let failures = 0
const pass = (msg: string): void => console.log(`  PASS  ${msg}`)
const fail = (msg: string): void => {
  failures += 1
  console.error(`  FAIL  ${msg}`)
}

async function check(name: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body()
    pass(name)
  } catch (err) {
    fail(`${name} — ${(err as Error).message}`)
  }
}

interface FixtureOptions {
  title?: string
  folder?: string
  lastActivityAt?: number
  isArchived?: boolean
  /** Written into `.claude/sessions/<pid>.json` to look like a running turn. */
  pid?: number
  /** Extra padding, so the parser is exercised on a realistically large file. */
  bulky?: boolean
}

function writeSession(uuid: string, options: FixtureOptions = {}): string {
  const id = `local_${uuid}`
  const sessionDir = path.join(ORG_DIR, id)
  const cwd = path.join(sessionDir, 'outputs')
  fs.mkdirSync(cwd, { recursive: true })

  const meta: Record<string, unknown> = {
    sessionId: id,
    cliSessionId: `cli-${uuid}`,
    cwd,
    userSelectedFolders: options.folder ? [options.folder] : [],
    createdAt: NOW - 60 * MINUTE,
    lastActivityAt: options.lastActivityAt ?? NOW,
    model: 'claude-opus-5',
    isArchived: options.isArchived ?? false,
    title: options.title ?? ''
  }
  if (options.bulky) meta.systemPrompt = 'x'.repeat(200_000)
  fs.writeFileSync(path.join(ORG_DIR, `${id}.json`), JSON.stringify(meta), 'utf8')

  if (options.pid !== undefined) {
    const sessions = path.join(sessionDir, '.claude', 'sessions')
    fs.mkdirSync(sessions, { recursive: true })
    fs.writeFileSync(
      path.join(sessions, `${options.pid}.json`),
      JSON.stringify({ pid: options.pid, sessionId: `cli-${uuid}`, cwd, entrypoint: 'local-agent' }),
      'utf8'
    )
  }
  return sessionDir
}

/** Backdates the metadata file too — freshness is max(lastActivityAt, mtime). */
function backdate(uuid: string, ageMs: number): void {
  const target = path.join(ORG_DIR, `local_${uuid}.json`)
  const when = new Date(NOW - ageMs)
  fs.utimesSync(target, when, when)
}

async function main(): Promise<void> {
  fs.mkdirSync(ORG_DIR, { recursive: true })

  const live = writeSession('11111111-1111-1111-1111-111111111111', {
    title: 'Drone build manual handoff',
    folder: path.join(FIXTURE, 'projects', 'drone-docs'),
    pid: process.pid,
    bulky: true
  })
  writeSession('22222222-2222-2222-2222-222222222222', {
    title: 'Fusion installation help',
    folder: path.join(FIXTURE, 'projects', 'fusion'),
    lastActivityAt: NOW - 5 * MINUTE
  })
  writeSession('33333333-3333-3333-3333-333333333333', {
    title: 'Wakeup daily',
    isArchived: true
  })
  writeSession('44444444-4444-4444-4444-444444444444', {
    title: 'Consolidate game content',
    lastActivityAt: NOW - 90 * MINUTE
  })
  backdate('44444444-4444-4444-4444-444444444444', 90 * MINUTE)

  // A dead PID left behind by a finished turn — the common case, since Cowork
  // spawns a CLI per turn and its session file outlives the process.
  writeSession('55555555-5555-5555-5555-555555555555', {
    title: 'Stale pid',
    lastActivityAt: NOW - 2 * MINUTE,
    pid: 999_999_998
  })

  // Decoys the enumerator must ignore.
  fs.writeFileSync(path.join(ORG_DIR, 'scheduled-tasks.json'), '{"scheduledTasks":[]}', 'utf8')
  fs.writeFileSync(path.join(ORG_DIR, 'cowork-gb-cache.json'), '{}', 'utf8')
  fs.mkdirSync(path.join(FIXTURE, 'skills-plugin', ORG, ACCOUNT), { recursive: true })
  fs.writeFileSync(
    path.join(FIXTURE, 'skills-plugin', ORG, ACCOUNT, 'local_deadbeef.json'),
    JSON.stringify({ sessionId: 'local_deadbeef', title: 'not a session' }),
    'utf8'
  )

  const { CoworkReader, parseCoworkMetadata } = await import('../src/main/coworkSessions')
  const reader = new CoworkReader()
  const scan = await reader.read(NOW)
  const byName = new Map(scan.sessions.map((session) => [session.name, session]))

  await check('the sweep is authoritative and finds only live-or-recent chats', () => {
    assert.ok(scan.authoritative, 'a readable tree must be authoritative')
    assert.deepEqual(
      [...byName.keys()].sort(),
      ['Drone build manual handoff', 'Fusion installation help', 'Stale pid']
    )
  })

  await check('a running turn reads as busy, and its PID is reported', () => {
    const session = byName.get('Drone build manual handoff')
    assert.ok(session)
    assert.equal(session.status, 'busy')
    assert.equal(session.rawStatus, 'local-agent-turn')
    assert.equal(session.pid, process.pid)
  })

  await check('a finished turn reads as idle, not busy', () => {
    const session = byName.get('Fusion installation help')
    assert.ok(session)
    assert.equal(session.status, 'idle')
    assert.equal(session.rawStatus, 'local-agent-recent')
    assert.equal(session.pid, undefined)
  })

  await check('a stale PID file does not fake a running turn', () => {
    const session = byName.get('Stale pid')
    assert.ok(session)
    assert.equal(session.status, 'idle', 'a dead PID must not read as busy')
  })

  await check('archived chats never produce a row', () => {
    assert.equal(byName.has('Wakeup daily'), false)
  })

  await check('a chat idle past the recency window ages out', () => {
    assert.equal(byName.has('Consolidate game content'), false)
  })

  await check('the row shows the folder the user picked, not the outputs scratch dir', () => {
    const session = byName.get('Drone build manual handoff')
    assert.ok(session)
    assert.equal(session.cwd, path.join(FIXTURE, 'projects', 'drone-docs'))
    assert.ok(!session.cwd.includes('outputs'), 'the outputs cwd must never be shown')
    assert.equal(session.location, undefined)
  })

  await check('rows are hide-only, and claim no focus target on their own', () => {
    for (const session of scan.sessions) {
      assert.equal(session.canTerminate, false, `${session.name} must not be terminable`)
      // The reader knows nothing about windows. `SessionWatcher` turns this on
      // only while Claude Desktop is actually open, so a row can never offer a
      // Focus that would raise nothing.
      assert.equal(session.canFocus, false, `${session.name} must not self-declare focus`)
      assert.equal(session.windowHandle, undefined)
      assert.equal(session.agent, 'claude-cowork')
      assert.ok(session.key.startsWith('claude-cowork:'))
    }
  })

  await check('the transcript path points at the nested Claude Code transcript', () => {
    const session = byName.get('Drone build manual handoff')
    assert.ok(session?.transcriptPath)
    assert.ok(session.transcriptPath.startsWith(path.join(live, '.claude', 'projects')))
    assert.ok(session.transcriptPath.endsWith('.jsonl'))
  })

  await check('a folderless chat says where it lives instead of showing a fake path', async () => {
    writeSession('66666666-6666-6666-6666-666666666666', { title: 'No folder' })
    const session = (await new CoworkReader().read(NOW)).sessions.find(
      (candidate) => candidate.name === 'No folder'
    )
    assert.ok(session)
    assert.equal(session.cwd, '')
    assert.equal(session.location, 'Claude Cowork')
  })

  await check('a malformed session file is skipped without failing the sweep', async () => {
    fs.writeFileSync(path.join(ORG_DIR, 'local_broken.json'), '{ not json', 'utf8')
    const again = await new CoworkReader().read(NOW)
    assert.ok(again.authoritative, 'an unparseable file is not a read failure')
    assert.ok(again.sessions.length > 0, 'the other rows must survive')
  })

  // The "Claude Desktop is not installed" case — roots() resolving to [] — is
  // covered by testPlatformContract. This is the shape one step in: the tree
  // exists but holds nothing to report.
  await check('an empty branch of the tree is a complete answer, not an error', async () => {
    fs.mkdirSync(path.join(FIXTURE, 'empty-account'), { recursive: true })
    fs.mkdirSync(path.join(FIXTURE, 'other-account', 'empty-org'), { recursive: true })
    const scanned = await new CoworkReader().read(NOW)
    assert.ok(scanned.authoritative, 'empty directories must not mark the sweep degraded')
    assert.equal(
      scanned.sessions.some((session) => session.name === ''),
      false
    )
  })

  await check('metadata parsing tolerates duplicate keys and prefers the filename id', () => {
    // Real files carry case-varying duplicate keys under `enabledMcpTools`;
    // JSON.parse takes the last, which is fine. A strict parser would throw.
    const text = '{"enabledMcpTools":{"local:Blender:x":true,"local:blender:x":false},"title":"T"}'
    const meta = parseCoworkMetadata('local_abc-123.json', text)
    assert.ok(meta)
    assert.equal(meta.sessionId, 'local_abc-123')
    assert.equal(meta.title, 'T')
    assert.equal(parseCoworkMetadata('not-a-session.json', '{}'), null)
  })

  await check('the enumerator never descends into a session directory', async () => {
    // A trap laid where only a recursive walk would find it. The real tree has a
    // 40 MB audit log and a 9 GB disk image at this depth.
    const trap = path.join(live, 'outputs', 'nested', ACCOUNT, ORG)
    fs.mkdirSync(trap, { recursive: true })
    fs.writeFileSync(
      path.join(trap, 'local_99999999-9999-9999-9999-999999999999.json'),
      JSON.stringify({ sessionId: 'local_trap', title: 'TRAP', lastActivityAt: NOW }),
      'utf8'
    )
    const scanned = await new CoworkReader().read(NOW)
    assert.equal(
      scanned.sessions.some((session) => session.name === 'TRAP'),
      false,
      'a recursive walk reached into a session directory'
    )
  })

  console.log(
    failures === 0
      ? '\nCowork session tests passed.'
      : `\n${failures} cowork assertion(s) failed.`
  )
  if (failures > 0) process.exitCode = 1
}

void main()
  .catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(FIXTURE, { recursive: true, force: true })
  })
