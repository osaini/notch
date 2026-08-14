/**
 * Runs the plan's verification checks against the real ~/.claude directory,
 * without launching Electron. Bundled and executed by `npm run verify`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SessionWatcher,
  claudeDisplayName,
  cleanTitle,
  isPidAlive,
  parseCodexTitleIndex,
  toDesignSessions
} from '../src/main/sessionWatcher'
import { lastAiTitle, projectDirName } from '../src/main/claudeTranscript'
import { DesignWatcher, DESIGN_WINDOW_TITLES } from '../src/main/designWatcher'
import {
  HookServer,
  HOOK_EVENTS,
  hookUrl
} from '../src/main/hookServer'
import { SETTINGS_PATH, getHookStatus } from '../src/main/hookInstaller'
import {
  UsageScanner,
  claudeCooldownMs,
  fetchCodexPlanUsage,
  listUniqueTranscripts,
  parseClaudePlanUsage,
  parseCodexPlanUsage,
  parseRetryAfterMs,
  withoutExpiredPeriods
} from '../src/main/usage'
import {
  ORCHESTRATOR_ENTRY,
  buildAdversarialArgs,
  buildBugSearchRequest,
  buildClaudeArgs,
  buildCodexArgs,
  autoModeDisabled,
  getRecentProjects,
  hasOrchestrator,
  isAutoModeDisabled,
  resolveClaudeMode
} from '../src/main/dispatcher'
// The Windows argv builders are imported from the win32 platform explicitly, not
// through `platform`, so these assertions keep covering Windows on any host OS.
import { buildPairWtArgs, buildWtArgs } from '../src/main/platform/win32/terminal'
import { resolveAgentPaths } from '../src/main/agentPaths'
import { savePastedImage, sniffImageExtension } from '../src/main/pastedImages'
import { isSafeMobileEndpointAddress } from '../src/main/mobileBridge'
import { isReadablePastedImagePayload } from '../src/shared/types'
import { shortPath } from '../src/renderer/format'

const pass = (msg: string): void => console.log(`  PASS  ${msg}`)
const fail = (msg: string): void => {
  failures += 1
  console.log(`  FAIL  ${msg}`)
}
const info = (msg: string): void => console.log(`        ${msg}`)
let failures = 0

function section(name: string): void {
  console.log(`\n=== ${name} ===`)
}

async function checkSessions(): Promise<void> {
  section('sessionWatcher')
  const titleIndex = parseCodexTitleIndex(
    [
      '{"id":"thread-1","thread_name":"First title"}',
      '{"id":"thread-1","thread_name":"Renamed title"}',
      '{"id":"thread-2","title":"Second title"}'
    ].join('\n')
  )
  if (
    titleIndex.get('thread-1') === 'Renamed title' &&
    titleIndex.get('thread-2') === 'Second title'
  ) {
    pass('Codex Desktop title index parses and honors the newest title')
  } else {
    fail('Codex Desktop title index did not parse correctly')
  }

  // Claude writes its title repeatedly; the last record is the current one, and
  // a chunked read hands us a severed first line as a matter of course.
  const transcript = [
    '{"type":"ai-title","aiTitle":"First title","sessionId":"s1"}',
    '{"type":"user","message":{"role":"user","content":"hi"}}',
    '{"type":"ai-title","aiTitle":"Renamed title","sessionId":"s1"}',
    '{"type":"mode","mode":"normal"}'
  ].join('\n')
  const severed = `ontent":"hi"}}\n${transcript.split('\n').slice(2).join('\n')}`
  if (
    lastAiTitle(transcript) === 'Renamed title' &&
    lastAiTitle(severed) === 'Renamed title' &&
    lastAiTitle('{"type":"user","message":{}}') === ''
  ) {
    pass('transcript title parser takes the newest ai-title and tolerates a cut line')
  } else {
    fail('transcript title parser did not read the newest ai-title')
  }

  const encoded = {
    'C:\\Users\\me': 'C--Users-me',
    'C:\\Users\\me\\Projects\\windows-notch': 'C--Users-me-Projects-windows-notch',
    'C:\\Users\\me\\Projects\\windows-notch\\.claude-worktrees\\fix-it':
      'C--Users-me-Projects-windows-notch--claude-worktrees-fix-it',
    '/home/me/projects/notch': '-home-me-projects-notch'
  }
  const wrongEncoding = Object.entries(encoded).filter(
    ([cwd, expected]) => projectDirName(cwd) !== expected
  )
  if (wrongEncoding.length === 0) pass('project directory encoding matches ~/.claude/projects')
  else fail(`project directory encoding wrong for ${wrongEncoding.map(([cwd]) => cwd).join(', ')}`)

  // A derived slug is the one label the transcript title is allowed to replace.
  const cwdFixture = path.join('C:', 'p', 'notch')
  const title = 'Fix the sessions tab'
  const naming: [string, string][] = [
    [claudeDisplayName('notch-40', 'derived', title, cwdFixture, 7), title],
    [claudeDisplayName('my thread', 'user', title, cwdFixture, 7), 'my thread'],
    [claudeDisplayName('audit deps', 'auto', title, cwdFixture, 7), 'audit deps'],
    // Newer Claude Code drops `nameSource` once it syncs the name itself.
    [claudeDisplayName('notch-40', '', title, cwdFixture, 7), title],
    [claudeDisplayName('notch-40', 'derived', '', cwdFixture, 7), 'notch-40'],
    [claudeDisplayName('', '', '', cwdFixture, 7), 'notch'],
    [claudeDisplayName('', '', '', '', 7), 'pid 7']
  ]
  const wrongNames = naming.filter(([actual, expected]) => actual !== expected)
  if (wrongNames.length === 0) pass('session label prefers a real title over a derived slug')
  else fail(`session label wrong: ${wrongNames.map(([a, e]) => `${a} != ${e}`).join('; ')}`)

  const watcher = new SessionWatcher()
  watcher.start()
  const scanDeadline = Date.now() + 4_000
  while (watcher.getSnapshot().scannedAt === 0 && Date.now() < scanDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const snap = watcher.getSnapshot()

  info(`color=${snap.color} sessions=${snap.sessions.length} pruned=${snap.prunedCount}`)
  for (const s of snap.sessions) {
    info(`  pid ${s.pid} ${s.status.padEnd(11)} ${s.kind.padEnd(11)} ${s.name}`)
  }

  const onDisk = fs.readdirSync(path.join(os.homedir(), '.claude', 'sessions')).filter((f) => f.endsWith('.json'))
  const claudeSessions = snap.sessions.filter((session) => session.agent === 'claude')
  // Parked parents are live files we deliberately hide, so they are accounted
  // for here rather than weakening the invariant to a range.
  const accounted = claudeSessions.length + snap.prunedCount + snap.parkedCount
  if (accounted === onDisk.length) {
    pass(
      `every session file accounted for (${onDisk.length} on disk` +
        `${snap.parkedCount ? `, ${snap.parkedCount} parked` : ''})`
    )
  } else {
    fail(`accounted ${accounted} of ${onDisk.length} files`)
  }

  if (claudeSessions.every((session) => session.pid && isPidAlive(session.pid))) {
    pass('all reported Claude sessions have live PIDs')
  }
  else fail('a reported session has a dead PID')

  // The point of the change: a live row whose session file holds nothing but a
  // derived slug must be showing the transcript's title instead.
  for (const session of claudeSessions) {
    let slug = ''
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions', `${session.pid}.json`), 'utf8')
      ) as { name?: string; nameSource?: string }
      const deliberate = raw.nameSource === 'user' || raw.nameSource === 'auto'
      slug = deliberate ? '' : raw.name ?? ''
    } catch {
      continue
    }
    if (!slug) continue
    const aiTitle = session.transcriptPath
      ? cleanTitle(lastAiTitle(fs.readFileSync(session.transcriptPath, 'utf8')))
      : ''
    if (!aiTitle) info(`pid ${session.pid} has no transcript title yet (showing "${session.name}")`)
    else if (session.name === aiTitle) pass(`pid ${session.pid} shows its chat title, not "${slug}"`)
    else fail(`pid ${session.pid} shows "${session.name}"; transcript says "${aiTitle}"`)
  }

  // A parked file is frozen at handoff, so it can never be the working row.
  const parkedBusy = claudeSessions.filter(
    (session) => session.parkedJobId && (session.status === 'busy' || session.needsInput)
  )
  if (parkedBusy.length === 0) pass('no parked parent is counted as working')
  else fail(`${parkedBusy.length} parked parent(s) still reported busy/needs-input`)

  // A PID that cannot exist must read as dead.
  if (!isPidAlive(999_999_998)) pass('liveness check rejects a bogus PID')
  else fail('liveness check accepted a bogus PID')

  // --- red state, end to end -----------------------------------------
  const target = claudeSessions[0]
  if (!target) {
    info('no live session to exercise the red path')
    watcher.stop()
    return
  }

  const server = new HookServer()
  const port = await server.start(48123)
  server.on('blocked', (e) => watcher.setNeedsInput(e.session_id!, 'Permission requested'))
  server.on('unblocked', (e) => watcher.clearNeedsInput(e.session_id!))
  const endpoint = hookUrl(port, server.authToken)
  info(`hook listener on ${endpoint}`)

  const post = async (
    body: Record<string, unknown>
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    return {
      status: res.status,
      body: JSON.parse(await res.text()) as Record<string, unknown>
    }
  }

  server.once('pending-change', () => {
    const interaction = server.getPendingInteractions()[0]
    if (interaction) {
      server.respond(interaction.id, { kind: 'permission', decision: 'allow' })
    }
  })
  const t0 = Date.now()
  const permissionResponse = await post({
    hook_event_name: 'PermissionRequest',
    session_id: target.sessionId,
    cwd: target.cwd,
    tool_name: 'Bash'
  })
  const elapsed = Date.now() - t0
  if (permissionResponse.status === 200) {
    pass(`PermissionRequest answered 200 after an explicit decision (${elapsed}ms)`)
  } else {
    fail(`PermissionRequest answered ${permissionResponse.status}`)
  }
  const decision = (
    permissionResponse.body.hookSpecificOutput as {
      decision?: { behavior?: string }
    } | undefined
  )?.decision?.behavior
  if (decision === 'allow') pass('PermissionRequest returned the documented allow schema')
  else fail(`unexpected PermissionRequest response: ${JSON.stringify(permissionResponse.body)}`)

  const waitForColor = async (predicate: (color: string) => boolean): Promise<string> => {
    const deadline = Date.now() + 4_000
    while (!predicate(watcher.getSnapshot().color) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return watcher.getSnapshot().color
  }
  const blockedColor = await waitForColor((color) => color === 'red')
  if (blockedColor === 'red') pass('PermissionRequest turned the notch red')
  else fail(`expected red, got ${watcher.getSnapshot().color}`)

  await post({ hook_event_name: 'Stop', session_id: target.sessionId })
  const after = await waitForColor((color) => color !== 'red')
  if (after !== 'red') pass(`Stop cleared the red state (now ${after})`)
  else fail('Stop did not clear the red state')

  server.stop()
  watcher.stop()
}

async function checkDesign(): Promise<void> {
  section('Claude Design (window detection)')

  // --- shaping rules, independent of whether Design is open right now -----
  const firstSeen = new Map<string, number>()
  const windows = [
    { handle: '4242', pid: 100, title: 'Design' },
    { handle: '1010', pid: 100, title: 'Design' }
  ]
  const first = toDesignSessions(windows, firstSeen, 1_000)
  const second = toDesignSessions(windows, firstSeen, 9_000)

  if (first.map((session) => session.windowHandle).join(',') === '1010,4242') {
    pass('design rows are ordered by window handle, not sweep order')
  } else {
    fail(`design rows came back as ${first.map((session) => session.windowHandle).join(',')}`)
  }
  if (first[0].name === 'Design 1' && first[1].name === 'Design 2') {
    pass('concurrent design windows are numbered')
  } else {
    fail(`unexpected design names: ${first.map((session) => session.name).join(', ')}`)
  }
  if (toDesignSessions([windows[0]], new Map(), 1_000)[0].name === 'Design') {
    pass('a lone design window keeps the bare window title')
  } else {
    fail('a lone design window was numbered')
  }
  if (second.every((session) => session.startedAt === 1_000)) {
    pass('an already-open window keeps its original "open since" across sweeps')
  } else {
    fail('design open-since timestamps reset on a later sweep')
  }
  if (first.every((session) => !session.canTerminate && session.canFocus && !session.needsInput)) {
    pass('design rows are focus-only — never a termination target')
  } else {
    fail('a design row claims it can be terminated')
  }
  if (first.every((session) => session.status === 'idle' && session.rawStatus === 'window-open')) {
    pass('design rows report presence honestly (idle / window-open)')
  } else {
    fail('design rows claim a status Design does not expose')
  }

  // --- live detection ------------------------------------------------------
  const watcher = new DesignWatcher()
  watcher.start()
  const detected = await new Promise<ReturnType<DesignWatcher['getWindows']>>((resolve) => {
    const timer = setTimeout(() => resolve(watcher.getWindows()), 8000)
    watcher.once('update', (found) => {
      clearTimeout(timer)
      resolve(found)
    })
  })
  watcher.stop()

  info(`titles treated as Claude Design: ${DESIGN_WINDOW_TITLES.join(', ')}`)
  if (watcher.getError()) {
    fail(`design window helper failed: ${watcher.getError()}`)
  } else {
    pass('design window helper ran a sweep without failing')
  }
  info(`open design windows: ${detected.length}`)
  for (const window of detected) info(`  hwnd ${window.handle} (pid ${window.pid}) ${window.title}`)
  if (detected.length === 0) {
    info('open Claude Design from the Claude Desktop sidebar to exercise the live path')
  } else if (detected.every((window) => /^\d+$/.test(window.handle) && window.pid > 0)) {
    pass('every detected window carries a usable handle and owning PID')
  } else {
    fail('a detected design window is missing its handle or PID')
  }
}

async function checkUsage(): Promise<void> {
  section('usage (incremental scan)')
  const customRoots = resolveAgentPaths(
    { CLAUDE_CONFIG_DIR: './custom-claude', CODEX_HOME: './custom-codex' },
    path.join('ignored', 'home')
  )
  if (
    customRoots.claudeProjects === path.resolve('custom-claude', 'projects') &&
    customRoots.claudeTranscripts === path.resolve('custom-claude', 'transcripts') &&
    customRoots.codexSessions === path.resolve('custom-codex', 'sessions') &&
    customRoots.codexArchivedSessions === path.resolve('custom-codex', 'archived_sessions')
  ) {
    pass('Claude and Codex data-root overrides cover every transcript location')
  } else {
    fail('agent data-root override resolution is inconsistent')
  }
  const rootsFixture = path.join(os.tmpdir(), `notch-usage-roots-${Date.now()}`)
  const activeRoot = path.join(rootsFixture, 'sessions')
  const archiveRoot = path.join(rootsFixture, 'archived_sessions')
  fs.mkdirSync(activeRoot, { recursive: true })
  fs.mkdirSync(archiveRoot, { recursive: true })
  fs.writeFileSync(path.join(activeRoot, 'shared-session.jsonl'), '{"active":true}\n')
  fs.writeFileSync(path.join(archiveRoot, 'shared-session.jsonl'), '{"archived":true}\n')
  fs.writeFileSync(path.join(archiveRoot, 'archive-only.jsonl'), '{}\n')
  const uniqueFiles = await listUniqueTranscripts([activeRoot, archiveRoot])
  if (
    uniqueFiles.length === 2 &&
    uniqueFiles.includes(path.join(activeRoot, 'shared-session.jsonl')) &&
    uniqueFiles.includes(path.join(archiveRoot, 'archive-only.jsonl'))
  ) {
    pass('active and archived transcript roots merge without double counting')
  } else {
    fail('equivalent transcript roots were not de-duplicated correctly')
  }
  fs.rmSync(rootsFixture, { recursive: true, force: true })
  const now = Date.now()
  const originalCodexPath = process.env.CODEX_CLI_PATH
  process.env.CODEX_CLI_PATH = path.join(os.tmpdir(), 'definitely-missing-codex-binary')
  const missingCodex = await fetchCodexPlanUsage(null, null)
  if (originalCodexPath === undefined) delete process.env.CODEX_CLI_PATH
  else process.env.CODEX_CLI_PATH = originalCodexPath
  if (missingCodex.state === 'unavailable' && missingCodex.message?.includes('unavailable')) {
    pass('a missing Codex binary degrades usage state without a stream crash')
  } else {
    fail(`a missing Codex binary returned an unexpected plan: ${JSON.stringify(missingCodex)}`)
  }
  const claudeFixture = parseClaudePlanUsage(
    {
      five_hour: { utilization: 97, resets_at: new Date(now - 60_000).toISOString() },
      seven_day: { utilization: 18, resets_at: new Date(now + 60_000).toISOString() }
    },
    now
  )
  if (
    claudeFixture &&
    withoutExpiredPeriods(claudeFixture, now).periods.every((period) => period.id !== 'five_hour')
  ) {
    pass('expired Claude 5h utilization is discarded')
  } else {
    fail('expired Claude 5h utilization remained visible')
  }
  const codexFixture = parseCodexPlanUsage(
    {
      rateLimits: {
        primary: {
          usedPercent: 24,
          windowDurationMins: 10_080,
          resetsAt: Math.floor((now + 60_000) / 1000)
        },
        secondary: null
      }
    },
    now
  )
  if (
    codexFixture?.periods.length === 1 &&
    codexFixture.periods[0].windowMinutes === 10_080 &&
    codexFixture.periods[0].utilization === 24
  ) {
    pass('Codex app-server weekly fixture is parsed without a secondary period')
  } else {
    fail('Codex app-server weekly fixture was not parsed')
  }
  // Rate-limit handling for the Claude usage endpoint. The live endpoint
  // answers 429 with `retry-after: 0`, which must not be read as "retry now".
  if (
    parseRetryAfterMs('30', now) === 30_000 &&
    parseRetryAfterMs('0', now) === null &&
    parseRetryAfterMs('', now) === null &&
    parseRetryAfterMs(null, now) === null &&
    parseRetryAfterMs('not-a-date', now) === null
  ) {
    pass('Retry-After seconds parse, and 0/empty/garbage yield no delay')
  } else {
    fail('Retry-After second-form parsing is wrong')
  }
  if (
    parseRetryAfterMs(new Date(now + 120_000).toUTCString(), now)! > 118_000 &&
    parseRetryAfterMs(new Date(now - 120_000).toUTCString(), now) === null
  ) {
    pass('Retry-After HTTP-date parses, and past dates yield no delay')
  } else {
    fail('Retry-After date-form parsing is wrong')
  }
  const tenMin = 10 * 60 * 1000
  if (
    claudeCooldownMs(1, null) === tenMin &&
    claudeCooldownMs(2, null) === 2 * tenMin &&
    claudeCooldownMs(3, null) === 4 * tenMin &&
    claudeCooldownMs(99, null) === 60 * 60 * 1000
  ) {
    pass('rate-limit cooldown backs off geometrically and caps at an hour')
  } else {
    fail('rate-limit cooldown schedule is wrong')
  }
  if (
    claudeCooldownMs(1, 45 * 60 * 1000) === 45 * 60 * 1000 &&
    claudeCooldownMs(1, 1_000) === tenMin
  ) {
    pass('a longer server Retry-After wins; a shorter one does not shrink the floor')
  } else {
    fail('Retry-After is not reconciled with the backoff floor')
  }

  if (
    parseClaudePlanUsage({ five_hour: { utilization: 'bad' } }, now) === null &&
    parseCodexPlanUsage({ rateLimits: { primary: { usedPercent: 'bad' } } }, now) === null
  ) {
    pass('malformed provider responses are rejected')
  } else {
    fail('malformed provider responses produced plan data')
  }

  const cacheDir = path.join(os.tmpdir(), `notch-verify-${Date.now()}`)
  fs.mkdirSync(cacheDir, { recursive: true })

  const scanner = new UsageScanner(cacheDir)
  const t0 = Date.now()
  await scanner.start()
  const first = scanner.getSnapshot()
  const firstBytes = scanner.lastPassBytes
  info(`cold scan: ${(firstBytes / 1024 / 1024).toFixed(2)} MB in ${Date.now() - t0}ms`)
  info(`total=${first.totalTokens.toLocaleString()} tokens  messages=${first.messages}  sessions=${first.sessions}`)
  info(`streak=${first.currentStreak}d (longest ${first.longestStreak}d)  peakHour=${first.peakHour}  model=${first.favoriteModel}`)
  info(`5h block: ${first.block.tokens.toLocaleString()} tokens over ${first.block.messages} messages`)

  if (first.totalTokens > 0) pass('cold scan produced token totals')
  else fail('cold scan produced no tokens')
  if (first.days.length === 182) pass('heatmap covers 182 days')
  else fail(`heatmap has ${first.days.length} days`)
  if (first.agentBreakdown.some((agent) => agent.agent === 'codex' && agent.totalTokens > 0)) {
    pass('Codex rollout usage is included')
  } else {
    fail('Codex rollout usage is missing')
  }
  if (first.planUsage.some((plan) => plan.agent === 'claude')) {
    pass('Claude plan provider state is available')
  } else {
    fail('Claude plan provider state is missing')
  }
  if (first.planUsage.some((plan) => plan.agent === 'codex')) {
    pass('Codex plan provider state is available')
  } else {
    fail('Codex plan provider state is missing')
  }
  const persistedUsageCache = JSON.parse(
    fs.readFileSync(path.join(cacheDir, 'usage-cache.json'), 'utf8')
  ) as { providerPlans?: Record<string, unknown> }
  const usableProviderAgents = first.planUsage
    .filter((plan) => plan.periods.length > 0)
    .map((plan) => plan.agent)
  if (
    usableProviderAgents.every((agent) =>
      Object.prototype.hasOwnProperty.call(persistedUsageCache.providerPlans ?? {}, agent)
    )
  ) {
    pass('last usable provider plans are persisted for restart fallback')
  } else {
    fail('a usable provider plan was not persisted')
  }
  for (const plan of first.planUsage) {
    info(
      `${plan.agent} plan: ${plan.state}/${plan.source}, ${plan.periods.length} period(s), fetched=${
        plan.fetchedAt ? new Date(plan.fetchedAt).toISOString() : 'never'
      }`
    )
  }
  if (
    first.planUsage
      .flatMap((plan) => plan.periods)
      .every((period) => period.resetsAt === null || period.resetsAt > Date.now())
  ) {
    pass('no expired provider period is exposed in the live snapshot')
  } else {
    fail('an expired provider period is exposed in the live snapshot')
  }

  // Printed so the totals can be diffed against `npx ccusage claude daily`.
  info('per-day tokens (compare with `npx ccusage claude daily`):')
  for (const day of first.days) {
    if (day.tokens > 0) info(`  ${day.date}  ${day.tokens.toLocaleString().padStart(14)}`)
  }

  const second = await scanner.refresh()
  const secondBytes = scanner.lastPassBytes
  info(`second pass read ${secondBytes} bytes`)
  if (secondBytes < firstBytes) pass(`second pass is incremental (${secondBytes} << ${firstBytes} bytes)`)
  else fail('second pass re-read everything')
  if (second.totalTokens === first.totalTokens) pass('totals stable across passes (no double counting)')
  else fail(`totals drifted: ${first.totalTokens} -> ${second.totalTokens}`)
  if (second.scannedAt > first.scannedAt) pass('manual refresh returns a newly scanned snapshot')
  else fail('manual refresh returned the previous snapshot')

  scanner.stop()
  const restarted = new UsageScanner(cacheDir)
  await restarted.start()
  const restartedSnapshot = restarted.getSnapshot()
  if (
    restarted.lastPassBytes < firstBytes &&
    restartedSnapshot.totalTokens >= first.totalTokens
  ) {
    pass('persisted cache survives a scanner restart with only incremental reads')
  } else {
    fail(
      `restart cache mismatch: ${restarted.lastPassBytes} bytes, ${restartedSnapshot.totalTokens} tokens`
    )
  }
  restarted.stop()
  fs.rmSync(cacheDir, { recursive: true, force: true })
}

async function checkHookInstall(): Promise<void> {
  section('hookInstaller (read-only live status)')
  try {
    const exists = fs.existsSync(SETTINGS_PATH)
    const settings = exists
      ? JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as Record<string, unknown>
      : {}
    info(`keys: ${Object.keys(settings).join(', ') || '(none)'}`)
    const status = await getHookStatus()
    info(`installed=${status.installed} port=${status.port ?? 'none'} events=${status.events.join(', ') || 'none'}`)
    pass(`settings ${exists ? 'parse and hook status resolves' : 'are absent and hook status resolves'}`)
    if (status.installed && status.events.length !== HOOK_EVENTS.length) {
      fail(`partial hook install: ${status.events.join(', ')}`)
    } else if (status.installed) {
      pass(`all ${HOOK_EVENTS.length} hook events are installed`)
    }
  } catch (err) {
    fail(`threw: ${(err as Error).message}`)
  }
}

async function checkDispatch(): Promise<void> {
  section('dispatcher (argv shape only — no launch)')
  const args = buildClaudeArgs({
    agent: 'claude',
    cwd: 'C:\\proj',
    prompt: 'fix the build; then run tests',
    permissionMode: 'plan',
    attachments: ['C:\\shot.png']
  })
  // Against win32Platform directly rather than the host platform: these builders
  // are pure, so the Windows argv stays covered even when this runs on a Mac.
  const wt = buildWtArgs({ cwd: 'C:\\proj', exe: 'claude', args })
  info(JSON.stringify(wt))

  if (wt[3] === 'claude' && wt[2] === '--') pass('wt argv uses the required "--" terminator')
  else fail('wt argv is missing the "--" terminator')
  if (args.includes('--permission-mode') && args.includes('plan')) pass('permission mode forwarded')
  else fail('permission mode missing')
  const prompt = args[args.length - 1]
  if (prompt.includes(';') && prompt.includes('@C:\\shot.png')) {
    pass('prompt passed verbatim as one argv element (";" not split, attachment appended)')
  } else {
    fail(`prompt mangled: ${prompt}`)
  }

  const codexArgs = buildCodexArgs({
    agent: 'codex',
    cwd: 'C:\\proj',
    prompt: 'inspect safely',
    permissionMode: 'codex-on-request'
  })
  const codexWt = buildWtArgs({ cwd: 'C:\\proj', exe: 'codex', args: codexArgs })
  if (codexWt[3] === 'codex' && codexArgs.includes('on-request')) {
    pass('Codex dispatch argv carries the selected approval policy')
  } else {
    fail(`Codex dispatch argv is malformed: ${JSON.stringify(codexWt)}`)
  }

  // Claude + Codex combo target.
  const comboReq = {
    agent: 'claude-codex' as const,
    cwd: 'C:\\proj',
    prompt: 'harden the parser; add cases',
    permissionMode: 'manual' as const,
    attachments: ['C:\\notes.md']
  }
  const { claudeArgs, codexArgs: reviewerArgs } = buildAdversarialArgs(comboReq)
  const pair = buildPairWtArgs(
    { cwd: 'C:\\proj', exe: 'claude', args: claudeArgs },
    { cwd: 'C:\\proj', exe: 'codex', args: reviewerArgs }
  )
  info(JSON.stringify(pair))

  const delimiter = pair.indexOf(';')
  if (delimiter > 0 && pair[delimiter + 1] === 'split-pane') {
    pass('adversarial argv keeps ";" as its own element before split-pane')
  } else {
    fail(`adversarial argv pane delimiter is malformed: ${JSON.stringify(pair)}`)
  }
  const accepted = buildAdversarialArgs({ ...comboReq, permissionMode: 'acceptEdits' })
  if (
    accepted.claudeArgs.includes('--permission-mode') &&
    accepted.claudeArgs.includes('acceptEdits')
  ) {
    pass('adversarial implementer forwards acceptEdits to Claude')
  } else {
    fail(`implementer argv is malformed: ${JSON.stringify(accepted.claudeArgs)}`)
  }
  // Manual is a real selection, not "inherit config". A user whose config
  // defaults to auto/bypass still has to get the mode they clicked.
  const manualAt = claudeArgs.indexOf('--permission-mode')
  if (manualAt >= 0 && claudeArgs[manualAt + 1] === 'manual') {
    pass('a manual implementer explicitly forces manual mode')
  } else {
    fail(`manual mode was not forced: ${JSON.stringify(claudeArgs)}`)
  }
  // The chosen permission mode reaches the implementer; the reviewer's
  // read-only sandbox is pinned and must survive any choice.
  const planned = buildAdversarialArgs({ ...comboReq, permissionMode: 'plan' })
  const plannedSandboxAt = planned.codexArgs.indexOf('--sandbox')
  if (
    planned.claudeArgs.includes('plan') &&
    !planned.claudeArgs.includes('acceptEdits') &&
    plannedSandboxAt >= 0 &&
    planned.codexArgs[plannedSandboxAt + 1] === 'read-only'
  ) {
    pass('implementer honours the selected mode while the reviewer stays read-only')
  } else {
    fail('implementer permission mode is not forwarded, or the reviewer sandbox moved')
  }
  const bogus = buildAdversarialArgs({ ...comboReq, permissionMode: 'codex-bypass' })
  if (bogus.claudeArgs.includes('auto')) {
    pass('a non-Claude mode falls back to auto for the implementer')
  } else {
    fail(`implementer fallback is wrong: ${JSON.stringify(bogus.claudeArgs)}`)
  }
  // Where the machine forbids `auto`, the implementer must still launch.
  const degraded = buildAdversarialArgs(
    { ...comboReq, permissionMode: 'codex-bypass' },
    { autoDisabled: true }
  )
  if (
    degraded.claudeArgs.includes('acceptEdits') &&
    !degraded.claudeArgs.includes('auto')
  ) {
    pass('disableAutoMode degrades the implementer to acceptEdits rather than failing')
  } else {
    fail(`auto degrade is wrong: ${JSON.stringify(degraded.claudeArgs)}`)
  }
  // Only the settings file switches it off — an explicit pick is not a reason.
  const settingsShapes: [unknown, boolean][] = [
    [{ permissions: { disableAutoMode: 'disable' } }, true],
    [{ permissions: { disableAutoMode: 'allow' } }, false],
    [{ permissions: {} }, false],
    [{}, false],
    [null, false],
    ['not an object', false]
  ]
  const wrongShapes = settingsShapes.filter(
    ([settings, expected]) => isAutoModeDisabled(settings) !== expected
  )
  if (wrongShapes.length === 0) {
    pass('disableAutoMode is read only from a real permissions object')
  } else {
    fail(`disableAutoMode parsing wrong for ${wrongShapes.length} shape(s)`)
  }
  const settingsFixture = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'notch-auto-mode-'))
  const projectFixture = path.join(settingsFixture, 'project')
  const rootFixture = path.join(settingsFixture, 'claude-home')
  fs.mkdirSync(path.join(projectFixture, '.claude'), { recursive: true })
  fs.mkdirSync(rootFixture, { recursive: true })
  fs.writeFileSync(path.join(rootFixture, 'settings.json'), '{ malformed on purpose')
  fs.writeFileSync(
    path.join(projectFixture, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { disableAutoMode: 'disable' } })
  )
  if (await autoModeDisabled(projectFixture, rootFixture)) {
    pass('project-local disableAutoMode survives a malformed user settings layer')
  } else {
    fail('project-local disableAutoMode was ignored')
  }
  await fs.promises.rm(settingsFixture, { recursive: true, force: true })
  if (
    resolveClaudeMode('auto', true) === 'acceptEdits' &&
    resolveClaudeMode('auto', false) === 'auto' &&
    resolveClaudeMode('plan', true) === 'plan'
  ) {
    pass('the auto downgrade touches auto only, and only when disabled')
  } else {
    fail('resolveClaudeMode downgraded the wrong mode')
  }
  const sandboxAt = reviewerArgs.indexOf('--sandbox')
  const approvalAt = reviewerArgs.indexOf('--ask-for-approval')
  if (
    sandboxAt >= 0 &&
    reviewerArgs[sandboxAt + 1] === 'read-only' &&
    approvalAt >= 0 &&
    reviewerArgs[approvalAt + 1] === 'never'
  ) {
    pass('adversarial reviewer is read-only and never requests command approval')
  } else {
    fail(`reviewer argv must be read-only with approvals disabled: ${JSON.stringify(reviewerArgs)}`)
  }
  // Each role prompt must be one argv element, carry the role, and include both
  // the task and the tray attachment.
  const implementerPrompt = claudeArgs[claudeArgs.length - 1]
  const reviewerPrompt = reviewerArgs[reviewerArgs.length - 1]
  if (
    implementerPrompt.includes('IMPLEMENTER') &&
    reviewerPrompt.includes('ADVERSARIAL REVIEWER') &&
    implementerPrompt.includes('@C:\\notes.md') &&
    reviewerPrompt.includes('harden the parser; add cases')
  ) {
    pass('role prompts carry the role, the task, and the attachments')
  } else {
    fail('role prompts are malformed')
  }

  const bugSearch = buildWtArgs(buildBugSearchRequest('C:\\proj'))
  if (
    bugSearch[3] === 'node' &&
    bugSearch[4] === ORCHESTRATOR_ENTRY &&
    bugSearch[5] === 'scan'
  ) {
    pass('bug-search argv drives the orchestrator through node, not npm')
  } else {
    fail(`bug-search argv is malformed: ${JSON.stringify(bugSearch)}`)
  }
  // The gate that decides bug-search vs. the adversarial fallback.
  if ((await hasOrchestrator(process.cwd())) && !(await hasOrchestrator(os.tmpdir()))) {
    pass('orchestrator detection distinguishes this repo from an unrelated directory')
  } else {
    fail('orchestrator detection is wrong')
  }

  const projects = await getRecentProjects([])
  info(`recent projects (${projects.length}):`)
  for (const p of projects) info(`  ${p}`)
  if (projects.length > 0) pass('project picker has candidates')
  else fail('no project candidates found')
}

/**
 * A pasted image is named from its bytes, and that name is all the agent gets.
 * A wrong extension is a file the agent cannot open, and an unrecognized blob
 * saved anyway is a path in the prompt pointing at nothing useful.
 */
async function checkPastedImages(): Promise<void> {
  section('pastedImages')

  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  const samples: Array<[string, Uint8Array, string | null]> = [
    ['a screenshot', PNG, 'png'],
    ['a JPEG', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), 'jpg'],
    ['a GIF', new Uint8Array(Buffer.from('GIF89a....')), 'gif'],
    [
      'a WebP',
      new Uint8Array(Buffer.from('RIFF    WEBPVP8 ', 'binary')),
      'webp'
    ],
    ['an SVG', new Uint8Array(Buffer.from('<?xml version="1.0"?><svg xmlns="x"/>')), 'svg'],
    ['plain text', new Uint8Array(Buffer.from('just some notes, not a picture')), null],
    ['an executable', new Uint8Array(Buffer.from('MZ ', 'binary')), null],
    ['nothing at all', new Uint8Array(), null]
  ]
  let sniffed = 0
  for (const [label, bytes, expected] of samples) {
    const actual = sniffImageExtension(bytes)
    if (actual === expected) sniffed += 1
    else fail(`${label} sniffed as ${String(actual)}, expected ${String(expected)}`)
  }
  if (sniffed === samples.length) pass(`sniffed all ${samples.length} payloads by their bytes`)

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'notch-paste-'))
  const first = await savePastedImage(dir, PNG)
  const second = await savePastedImage(dir, PNG)
  if (first && second && first !== second && path.extname(first) === '.png') {
    pass('two pastes in the same second land on two different .png files')
  } else {
    fail(`pastes collided or were misnamed: ${String(first)} / ${String(second)}`)
  }
  if (first && fs.readFileSync(first).equals(Buffer.from(PNG))) {
    pass('the saved file is the bytes that were pasted')
  } else {
    fail('the saved file does not match the pasted bytes')
  }
  if ((await savePastedImage(dir, new Uint8Array(Buffer.from('not an image')))) === null) {
    pass('bytes that are not an image are refused rather than saved under a guess')
  } else {
    fail('a non-image was saved into the tray directory')
  }
  if (
    isReadablePastedImagePayload('image/png', 1024) &&
    !isReadablePastedImagePayload('image/png', 33 * 1024 * 1024) &&
    !isReadablePastedImagePayload('application/octet-stream', 1024)
  ) {
    pass('renderer rejects oversized and non-image payloads before reading their bytes')
  } else {
    fail('renderer-side pasted-image admission is not bounded')
  }
  if (
    isSafeMobileEndpointAddress('192.168.1.20') &&
    isSafeMobileEndpointAddress('100.100.10.20') &&
    !isSafeMobileEndpointAddress('169.254.4.5') &&
    !isSafeMobileEndpointAddress('203.0.113.10')
  ) {
    pass('mobile bridge advertises private/VPN addresses but never public or link-local HTTP')
  } else {
    fail('mobile endpoint safety filter accepted or rejected the wrong address range')
  }
  await fs.promises.rm(dir, { recursive: true, force: true })
}

/**
 * Model/effort overrides, argv shape only.
 *
 * The load-bearing assertion is the negative one: an untouched dispatch must
 * emit exactly the argv it emitted before these selectors existed.
 */
function checkModelEffort(): void {
  section('dispatcher model + effort (argv shape only — no launch)')
  const base = {
    agent: 'claude' as const,
    cwd: 'C:\\proj',
    prompt: 'ship it',
    permissionMode: 'manual' as const
  }

  const tuned = buildClaudeArgs({
    ...base,
    claude: { model: 'opus', effort: 'xhigh' }
  })
  info(JSON.stringify(tuned))
  const modelAt = tuned.indexOf('--model')
  const effortAt = tuned.indexOf('--effort')
  if (
    modelAt >= 0 &&
    tuned[modelAt + 1] === 'opus' &&
    effortAt >= 0 &&
    tuned[effortAt + 1] === 'xhigh' &&
    tuned[tuned.length - 1] === 'ship it'
  ) {
    pass('Claude argv carries --model and --effort ahead of the prompt')
  } else {
    fail(`Claude model/effort argv is malformed: ${JSON.stringify(tuned)}`)
  }

  const untouched = buildClaudeArgs(base)
  if (!untouched.includes('--model') && !untouched.includes('--effort')) {
    pass('a Default model and effort emit no flags at all')
  } else {
    fail(`Default must be a no-op: ${JSON.stringify(untouched)}`)
  }

  const codexTuned = buildCodexArgs({
    ...base,
    agent: 'codex',
    permissionMode: 'codex-on-request',
    codex: { model: 'gpt-5.6-sol', effort: 'none' }
  })
  info(JSON.stringify(codexTuned))
  const codexModelAt = codexTuned.indexOf('--model')
  const configAt = codexTuned.indexOf('-c')
  if (
    codexModelAt >= 0 &&
    codexTuned[codexModelAt + 1] === 'gpt-5.6-sol' &&
    configAt >= 0 &&
    codexTuned[configAt + 1] === 'model_reasoning_effort="none"' &&
    codexTuned.includes('on-request')
  ) {
    pass('Codex argv carries --model and the effort config override, policy intact')
  } else {
    fail(`Codex model/effort argv is malformed: ${JSON.stringify(codexTuned)}`)
  }

  // A model id reaching the launcher must not be readable as a wt.exe flag.
  const wrapped = buildWtArgs({ cwd: 'C:\\proj', exe: 'codex', args: codexTuned })
  if (wrapped[2] === '--' && wrapped[3] === 'codex') {
    pass('a tuned Codex argv still passes through the "--" terminator')
  } else {
    fail(`tuned argv broke the launcher terminator: ${JSON.stringify(wrapped)}`)
  }

  // The pair routes each side independently — that is the whole reason the
  // request keys these by agent rather than by role.
  const pair = buildAdversarialArgs({
    agent: 'claude-codex',
    cwd: 'C:\\proj',
    prompt: 'split the work',
    permissionMode: 'acceptEdits',
    claude: { model: 'sonnet', effort: 'high' },
    codex: { model: 'gpt-5.6', effort: 'low' }
  })
  const reviewerSandboxAt = pair.codexArgs.indexOf('--sandbox')
  if (
    pair.claudeArgs.includes('sonnet') &&
    pair.claudeArgs.includes('high') &&
    !pair.claudeArgs.includes('gpt-5.6') &&
    pair.codexArgs.includes('gpt-5.6') &&
    pair.codexArgs.includes('model_reasoning_effort="low"') &&
    !pair.codexArgs.includes('sonnet')
  ) {
    pass('the pair routes each model/effort to the agent its key names')
  } else {
    fail(
      `pair tuning leaked across agents: ${JSON.stringify(pair.claudeArgs)} / ${JSON.stringify(pair.codexArgs)}`
    )
  }
  if (
    reviewerSandboxAt >= 0 &&
    pair.codexArgs[reviewerSandboxAt + 1] === 'read-only' &&
    pair.codexArgs.includes('never')
  ) {
    pass('reviewer stays read-only with approvals disabled under a tuned pair')
  } else {
    fail(`tuning disturbed the reviewer sandbox: ${JSON.stringify(pair.codexArgs)}`)
  }
}

async function main(): Promise<void> {
  if (
    shortPath('/Users/alice/work/repo') === '…/work/repo' &&
    shortPath('C:\\Users\\alice\\repo') === '…\\alice\\repo'
  ) pass('short paths preserve POSIX and Windows separators')
  else fail('short paths use the wrong platform separator')
  await checkSessions()
  await checkDesign()
  await checkUsage()
  await checkHookInstall()
  await checkDispatch()
  checkModelEffort()
  await checkPastedImages()

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
