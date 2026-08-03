/**
 * Runs the plan's verification checks against the real ~/.claude directory,
 * without launching Electron. Bundled and executed by `npm run verify`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SessionWatcher,
  isPidAlive,
  parseCodexTitleIndex,
  toDesignSessions
} from '../src/main/sessionWatcher'
import { DesignWatcher, DESIGN_WINDOW_TITLES } from '../src/main/designWatcher'
import {
  HookServer,
  HOOK_EVENTS,
  HOOK_MARKER,
  LEGACY_HOOK_MARKERS,
  hookUrl
} from '../src/main/hookServer'
import { SETTINGS_PATH, getHookStatus, installHooks, uninstallHooks } from '../src/main/hookInstaller'
import {
  UsageScanner,
  claudeCooldownMs,
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
  getRecentProjects,
  hasOrchestrator
} from '../src/main/dispatcher'
// The Windows argv builders are imported from the win32 platform explicitly, not
// through `platform`, so these assertions keep covering Windows on any host OS.
import { buildPairWtArgs, buildWtArgs } from '../src/main/platform/win32/terminal'

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
  const now = Date.now()
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
  section('hookInstaller (non-destructive round trip)')
  const before = fs.existsSync(SETTINGS_PATH) ? fs.readFileSync(SETTINGS_PATH, 'utf8') : null
  const beforeKeys = before ? Object.keys(JSON.parse(before)) : []
  info(`before: ${beforeKeys.join(', ')}`)

  try {
    const installed = await installHooks(47821)
    const afterInstall = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as Record<string, unknown>
    info(`after install: ${Object.keys(afterInstall).join(', ')}`)

    if (installed.installed && installed.events.length === HOOK_EVENTS.length) {
      pass(`installed ${HOOK_EVENTS.length} hook events`)
    }
    else fail(`installed events: ${installed.events.join(', ')}`)

    for (const key of beforeKeys.filter((key) => key !== 'hooks')) {
      if (JSON.stringify(afterInstall[key]) === JSON.stringify(JSON.parse(before!)[key])) {
        pass(`original key "${key}" untouched`)
      } else {
        fail(`original key "${key}" was modified`)
      }
    }

    if (installed.backupPath && fs.existsSync(installed.backupPath)) pass(`backup written to ${path.basename(installed.backupPath)}`)
    else fail('no backup written')

    const status = await getHookStatus()
    if (status.installed && status.port === 47821) pass('status reports installed on port 47821')
    else fail(`status: installed=${status.installed} port=${status.port}`)

    await uninstallHooks()
    const afterUninstall = fs.readFileSync(SETTINGS_PATH, 'utf8')
    const parsed = JSON.parse(afterUninstall) as Record<string, unknown>
    info(`after uninstall: ${Object.keys(parsed).join(', ')}`)

    const expected = before ? stripNotchHooks(JSON.parse(before) as Record<string, unknown>) : {}
    if (JSON.stringify(parsed) === JSON.stringify(expected)) {
      pass('uninstall removed only Notch hook entries')
    } else {
      fail('uninstall changed settings beyond Notch hook entries')
    }
  } catch (err) {
    fail(`threw: ${(err as Error).message}`)
  } finally {
    if (before === null) {
      if (fs.existsSync(SETTINGS_PATH)) fs.unlinkSync(SETTINGS_PATH)
    } else {
      fs.writeFileSync(SETTINGS_PATH, before, 'utf8')
    }
    info('restored the exact starting settings.json')
  }
}

function stripNotchHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>
  const hooks =
    clone.hooks && typeof clone.hooks === 'object' && !Array.isArray(clone.hooks)
      ? (clone.hooks as Record<string, unknown>)
      : null
  if (!hooks) return clone

  for (const [event, rawGroups] of Object.entries(hooks)) {
    if (!Array.isArray(rawGroups)) continue
    const groups = rawGroups
      .map((rawGroup) => {
        if (!rawGroup || typeof rawGroup !== 'object') return rawGroup
        const group = rawGroup as Record<string, unknown>
        if (!Array.isArray(group.hooks)) return group
        const commands = group.hooks.filter((command) => {
          if (!command || typeof command !== 'object') return true
          const url = (command as Record<string, unknown>).url
          if (typeof url !== 'string') return true
          // Legacy markers count as ours, so uninstall must remove them too —
          // otherwise a pre-rename install could never be cleaned up.
          return ![HOOK_MARKER, ...LEGACY_HOOK_MARKERS].some((marker) => url.includes(marker))
        })
        if (commands.length === group.hooks.length) return group
        return commands.length ? { ...group, hooks: commands } : null
      })
      .filter((group) => group !== null)
    if (groups.length) hooks[event] = groups
    else delete hooks[event]
  }
  if (Object.keys(hooks).length === 0) delete clone.hooks
  return clone
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
    permissionMode: 'default' as const,
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
  // `default` is the CLI's own default, so buildClaudeArgs omits the flag —
  // picking Default in the UI must not silently become acceptEdits.
  if (!claudeArgs.includes('--permission-mode')) {
    pass('a default implementer mode passes no --permission-mode flag')
  } else {
    fail(`default mode should not emit a flag: ${JSON.stringify(claudeArgs)}`)
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
  if (bogus.claudeArgs.includes('acceptEdits')) {
    pass('a non-Claude mode falls back to acceptEdits for the implementer')
  } else {
    fail(`implementer fallback is wrong: ${JSON.stringify(bogus.claudeArgs)}`)
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

async function main(): Promise<void> {
  await checkSessions()
  await checkDesign()
  await checkUsage()
  await checkHookInstall()
  await checkDispatch()

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
