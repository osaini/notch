import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  HOOK_EVENTS,
  HOOK_MARKER,
  HOOK_SPECS,
  HookServer,
  LEGACY_HOOK_MARKERS,
  MAX_HOLD_MS,
  hookUrl,
  normalizeClaudeQuestions
} from '../src/main/hookServer'
import {
  resolveParkedParents,
  isInactiveClaudeBackground,
  matchCodexTuiProcesses,
  parseCodexRollout,
  type SessionWatcher
} from '../src/main/sessionWatcher'
import { lastAssistantText, trailingQuestion } from '../src/main/transcriptTail'
import type { DispatchRequest, SessionState, SessionsSnapshot } from '../src/shared/types'
import {
  ManagedCodexService,
  compatibleModelOverride,
  managedCodexResumeArgs,
  waitForRolloutReady
} from '../src/main/managedCodex'
import { MobileBridge } from '../src/main/mobileBridge'
import { SettingsStore } from '../src/main/settings'
import { win32Platform } from '../src/main/platform/win32'
import { priorityPillLabel } from '../src/renderer/pillStatus'

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for test state')
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

async function testClaudeNormalizationAndRoundTrip(): Promise<void> {
  const originalQuestions = [
    {
      question: 'Where should this run?',
      header: 'Location',
      options: [
        { label: 'Local', description: 'Use this machine' },
        { label: 'Cloud', description: 'Use a remote runner' }
      ],
      multiSelect: false,
      extraField: 'preserve-me'
    },
    {
      question: 'Select checks',
      header: 'Checks',
      options: [{ label: 'Typecheck', description: 'Run TypeScript' }],
      multiSelect: true
    }
  ]
  const normalized = normalizeClaudeQuestions({ questions: originalQuestions })
  assert.equal(normalized.length, 2)
  assert.equal(normalized[1].selectionMode, 'multiple')
  assert.equal(normalized[0].options[0].description, 'Use this machine')
  assert.equal(normalized[0].allowOther, true)

  const server = new HookServer({ questionTimeoutMs: 1000 })
  const port = await server.start(48370)
  server.once('pending-change', () => {
    const interaction = server.getPendingInteractions()[0]
    assert.equal(interaction.kind, 'questions')
    assert.equal(
      server.respond(interaction.id, {
        kind: 'questions',
        answers: {
          'question-1': ['Local'],
          'question-2': ['Typecheck', 'Lint']
        }
      }),
      true
    )
    assert.equal(
      server.respond(interaction.id, {
        kind: 'questions',
        answers: { 'question-1': ['late'], 'question-2': ['late'] }
      }),
      false
    )
  })
  const response = await fetch(hookUrl(port, server.authToken), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'claude-test',
      cwd: 'C:\\test',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: originalQuestions, keep: 42 }
    })
  })
  const body = await response.json() as {
    hookSpecificOutput?: {
      hookEventName?: string
      permissionDecision?: string
      updatedInput?: Record<string, unknown>
    }
  }
  assert.equal(body.hookSpecificOutput?.hookEventName, 'PreToolUse')
  assert.equal(body.hookSpecificOutput?.permissionDecision, 'allow')
  assert.deepEqual(body.hookSpecificOutput?.updatedInput?.questions, originalQuestions)
  assert.deepEqual(body.hookSpecificOutput?.updatedInput?.answers, {
    'Where should this run?': 'Local',
    'Select checks': 'Typecheck, Lint'
  })
  assert.equal(body.hookSpecificOutput?.updatedInput?.keep, 42)
  server.stop()

  const fallback = new HookServer({ questionTimeoutMs: 30 })
  const fallbackPort = await fallback.start(48390)
  const fallbackResponse = await fetch(
    hookUrl(fallbackPort, fallback.authToken),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: originalQuestions.slice(0, 1) }
      })
    }
  )
  assert.deepEqual(await fallbackResponse.json(), {})
  assert.equal(fallback.getPendingInteractions().length, 0)
  fallback.stop()

  const duplicate = new HookServer({ questionTimeoutMs: 1000 })
  const duplicatePort = await duplicate.start(48400)
  let duplicateBlocked = 0
  duplicate.on('blocked', () => { duplicateBlocked++ })
  const duplicateResponse = await fetch(hookUrl(duplicatePort, duplicate.authToken), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'duplicate-prompts',
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { question: 'Which target?', header: 'First', options: [{ label: 'A' }] },
          { question: 'Which target?', header: 'Second', options: [{ label: 'B' }] }
        ]
      }
    })
  })
  assert.deepEqual(await duplicateResponse.json(), {})
  assert.equal(duplicate.getPendingInteractions().length, 0)
  assert.equal(duplicateBlocked, 1, 'duplicate prompts should fall back to the terminal')
  duplicate.stop()
}

/**
 * A forged permission or question card is only useful to an attacker if the
 * listener accepts it, so every rejected shape must also leave nothing pending.
 */
async function testHookAuthorization(): Promise<void> {
  const server = new HookServer({ questionTimeoutMs: 1000 })
  const port = await server.start(48410)
  const token = server.authToken
  assert.ok(token.length >= 16, 'hook token should be a real secret')

  const forgedQuestion = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'attacker',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [{
        question: 'Paste your API key',
        header: 'Setup',
        options: [{ label: 'Ok' }]
      }]
    }
  })

  const rejected: { name: string; url: string; headers?: Record<string, string> }[] = [
    { name: 'no token', url: `http://127.0.0.1:${port}/hook?${HOOK_MARKER}` },
    {
      name: 'wrong token',
      url: `http://127.0.0.1:${port}/hook?${HOOK_MARKER}&token=${'x'.repeat(token.length)}`
    },
    { name: 'no marker', url: `http://127.0.0.1:${port}/hook?token=${token}` },
    { name: 'unknown marker', url: `http://127.0.0.1:${port}/hook?app=other&token=${token}` },
    {
      name: 'wrong path',
      url: `http://127.0.0.1:${port}/other?${HOOK_MARKER}&token=${token}`
    },
    {
      name: 'browser origin',
      url: hookUrl(port, token),
      headers: { origin: 'https://evil.example' }
    }
  ]

  try {
    for (const attempt of rejected) {
      const denied = await fetch(attempt.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(attempt.headers ?? {}) },
        body: forgedQuestion
      })
      assert.equal(denied.status, 403, `${attempt.name} should be rejected`)
      assert.equal(
        server.getPendingInteractions().length,
        0,
        `${attempt.name} should not create an interaction`
      )
    }

    // The genuine URL still works, so the checks are not simply refusing everything.
    const accepted = await fetch(hookUrl(port, token), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'Stop', session_id: 'claude-test' })
    })
    assert.equal(accepted.status, 200)

    // Valid JSON primitives are malformed hook payloads, not process-ending
    // exceptions. They should receive the same harmless empty response.
    const nullPayload = await fetch(hookUrl(port, token), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null'
    })
    assert.equal(nullPayload.status, 200)
    assert.deepEqual(await nullPayload.json(), {})

    // A pre-rename install keeps working until the startup path rewrites it.
    // The listener is already up by then, and an unparseable settings.json means
    // the rewrite never happens at all — rejecting the old marker would silently
    // stop delivering events rather than degrading.
    for (const legacy of LEGACY_HOOK_MARKERS) {
      const legacyAccepted = await fetch(
        `http://127.0.0.1:${port}/hook?${legacy}&token=${token}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hook_event_name: 'Stop', session_id: 'claude-legacy' })
        }
      )
      assert.equal(legacyAccepted.status, 200, `${legacy} should still be answered`)
    }
  } finally {
    // A held interaction keeps its socket open; without this a failed
    // assertion hangs the run instead of reporting it.
    server.stop()
  }
}

async function testHookShutdownIsNotTimeout(): Promise<void> {
  const server = new HookServer({ permissionTimeoutMs: 5_000 })
  const port = await server.start(48430)
  const results: unknown[] = []
  server.on('interaction-resolved', ({ result }) => results.push(result))
  const response = fetch(hookUrl(port, server.authToken), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hook_event_name: 'PermissionRequest',
      session_id: 'shutdown-test',
      tool_name: 'Bash',
      tool_input: { command: 'echo test' }
    })
  })
  await waitFor(() => server.getPendingInteractions().length === 1)
  server.stop()
  assert.equal((await response).status, 200)
  assert.deepEqual(results, ['shutdown'])
}

/**
 * Regression for the stale red state: Claude only emits what we install, so a
 * clearing event that is classified but never installed cannot clear anything.
 *
 * Also covers the two ways a Notification must NOT go red — an `info` entry
 * (`agent_completed` and friends) and a session that is merely planning.
 */
async function testNeedsInputClearsOnNextPrompt(): Promise<void> {
  const server = new HookServer()
  const port = await server.start(48430)
  const blocked: string[] = []
  const unblocked: string[] = []
  server.on('blocked', (event: { hook_event_name?: string }) => {
    blocked.push(event.hook_event_name ?? '')
  })
  server.on('unblocked', (event: { hook_event_name?: string }) => {
    unblocked.push(event.hook_event_name ?? '')
  })

  const post = async (
    body: Record<string, unknown>,
    intent: 'blocking' | 'info' = 'blocking'
  ): Promise<void> => {
    await fetch(hookUrl(port, server.authToken, intent), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  try {
    await post({
      hook_event_name: 'Notification',
      session_id: 'claude-test',
      message: 'Waiting on you'
    })
    await post({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-test' })

    assert.deepEqual(blocked, ['Notification'])
    assert.deepEqual(
      unblocked,
      ['UserPromptSubmit'],
      'submitting the next prompt must clear the needs-input state'
    )
    assert.ok(
      HOOK_EVENTS.includes('UserPromptSubmit'),
      'UserPromptSubmit must be installed or Claude never sends it'
    )

    // "<job> finished" arrives on the info entry and is not a demand for input.
    await post(
      {
        hook_event_name: 'Notification',
        session_id: 'claude-test',
        message: 'fix-hooks-dispatch-ipc-findings finished'
      },
      'info'
    )
    assert.deepEqual(
      blocked,
      ['Notification'],
      'an info notification must not turn the session red'
    )

    // Planning is working. The ask arrives later as an ExitPlanMode permission.
    await post({
      hook_event_name: 'Notification',
      session_id: 'claude-test',
      permission_mode: 'plan',
      message: 'Claude is waiting'
    })
    assert.deepEqual(
      blocked,
      ['Notification'],
      'a plan-mode notification must not turn the session red'
    )

    // A permission request is still blocking regardless of mode.
    await post({
      hook_event_name: 'PermissionRequest',
      session_id: 'claude-test',
      permission_mode: 'plan',
      tool_name: 'ExitPlanMode'
    })
    await waitFor(() => blocked.length === 2)
    assert.deepEqual(blocked, ['Notification', 'PermissionRequest'])
  } finally {
    server.stop()
  }
}

/**
 * An approved plan must actually release the agent.
 *
 * A bare `{behavior:'allow'}` is discarded for tools that require user
 * interaction, so approving a plan in the notch left the terminal sitting on
 * its own prompt while the pill claimed the answer had been sent. Echoing the
 * captured input back is what makes the allow stick.
 */
async function testPermissionAllowEchoesInput(): Promise<void> {
  const planInput = { plan: '# Ship it\n\n- step one', extra: 7 }
  const server = new HookServer({ permissionTimeoutMs: 2000 })
  const port = await server.start(48395)
  try {
    server.once('pending-change', () => {
      const interaction = server.getPendingInteractions()[0]
      assert.equal(interaction.kind, 'permission')
      assert.equal(server.respond(interaction.id, { kind: 'permission', decision: 'allow' }), true)
    })
    const response = await fetch(hookUrl(port, server.authToken), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PermissionRequest',
        session_id: 'claude-test',
        cwd: 'C:\\test',
        permission_mode: 'plan',
        tool_name: 'ExitPlanMode',
        tool_input: planInput
      })
    })
    const body = await response.json() as {
      hookSpecificOutput?: {
        hookEventName?: string
        decision?: { behavior?: string; updatedInput?: Record<string, unknown> }
      }
    }
    assert.equal(body.hookSpecificOutput?.hookEventName, 'PermissionRequest')
    assert.equal(body.hookSpecificOutput?.decision?.behavior, 'allow')
    // Unchanged, and complete — `updatedInput` replaces the tool's arguments.
    assert.deepEqual(body.hookSpecificOutput?.decision?.updatedInput, planInput)
  } finally {
    server.stop()
  }

  // With no `tool_input` to echo there is nothing safe to send, so the bare
  // allow stands rather than approving the tool with its arguments wiped.
  const bare = new HookServer({ permissionTimeoutMs: 2000 })
  const barePort = await bare.start(48396)
  try {
    bare.once('pending-change', () => {
      const interaction = bare.getPendingInteractions()[0]
      assert.equal(bare.respond(interaction.id, { kind: 'permission', decision: 'allow' }), true)
    })
    const response = await fetch(hookUrl(barePort, bare.authToken), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PermissionRequest',
        session_id: 'claude-test',
        tool_name: 'Bash'
      })
    })
    const body = await response.json() as {
      hookSpecificOutput?: { decision?: Record<string, unknown> }
    }
    assert.equal(body.hookSpecificOutput?.decision?.behavior, 'allow')
    assert.equal('updatedInput' in (body.hookSpecificOutput?.decision ?? {}), false)
  } finally {
    bare.stop()
  }
}

/** Two Notification entries with different matchers, or the split cannot work. */
function testHookSpecs(): void {
  const notifications = HOOK_SPECS.filter((spec) => spec.event === 'Notification')
  assert.equal(notifications.length, 2, 'Notification must install as blocking + info')
  assert.equal(notifications.filter((spec) => spec.intent === 'info').length, 1)
  for (const spec of notifications) {
    assert.ok(spec.matcher, 'each Notification entry needs a type matcher')
  }
  assert.equal(
    notifications.some((spec) => spec.matcher?.includes('agent_completed') && spec.intent === 'info'),
    true,
    'agent_completed must be routed to the info entry'
  )
  // The held card can run to MAX_HOLD_MS, so Claude must wait at least that long.
  const preToolUse = HOOK_SPECS.find((spec) => spec.event === 'PreToolUse')
  assert.ok(preToolUse && preToolUse.timeout * 1000 > MAX_HOLD_MS)
}

/** The parked interactive parent must not double the live background job. */
function testParkedSessionDedupe(): void {
  const base = {
    agent: 'claude' as const,
    cwd: 'C:\\repo',
    kind: 'interactive',
    status: 'busy' as const,
    startedAt: 1,
    updatedAt: 2,
    needsInput: false,
    canTerminate: true,
    canFocus: true
  }
  const parent: SessionState = {
    ...base,
    key: 'claude:c11065c8',
    sessionId: 'c11065c8',
    name: 'fix-hooks-dispatch-ipc-findings',
    parkedJobId: '2907a775'
  }
  const child: SessionState = {
    ...base,
    key: 'claude:2907a775',
    sessionId: '2907a775',
    name: 'fix-hooks-dispatch-ipc-findings',
    kind: 'bg',
    jobId: '2907a775',
    rawStatus: 'busy',
    canFocus: false
  }

  const live = new Set(['2907a775'])

  const deduped = resolveParkedParents([parent, child], live)
  assert.deepEqual(deduped.map((session) => session.key), ['claude:2907a775'])

  // The regression: an alive-but-idle `bg` job is pruned before this runs, so
  // its row is absent even though the process is up. Liveness comes from the
  // job id set, so the parent must still be dropped.
  assert.deepEqual(resolveParkedParents([parent], live), [])

  // With the job really gone, the parked parent is the only row left for that
  // work — but its file froze at `busy` at handoff and is never rewritten, so
  // it must not be reported as working.
  const orphaned = resolveParkedParents([parent], new Set<string>())
  assert.deepEqual(orphaned.map((session) => session.key), ['claude:c11065c8'])
  assert.equal(orphaned[0].status, 'idle')
  assert.equal(orphaned[0].needsInput, false)
  // The stale file value stays visible for debugging.
  assert.equal(orphaned[0].rawStatus, parent.rawStatus)

  // A parent frozen mid-question must not strand the pill on red either.
  const blocked = resolveParkedParents(
    [{ ...parent, status: 'needs-input', needsInput: true }],
    new Set<string>()
  )
  assert.equal(blocked[0].needsInput, false)
  assert.equal(blocked[0].status, 'idle')

  // An ordinary pair is untouched.
  const ordinary = resolveParkedParents([child, { ...parent, parkedJobId: undefined }], live)
  assert.equal(ordinary.length, 2)
  assert.equal(ordinary[1].status, 'busy')

  assert.equal(isInactiveClaudeBackground(child), false)
  assert.equal(isInactiveClaudeBackground({ ...child, status: 'idle', rawStatus: 'idle' }), true)
  assert.equal(isInactiveClaudeBackground(parent), false)
}

/** Each answered question buys a fresh budget, up to a hard ceiling. */
async function testPerQuestionDeadline(): Promise<void> {
  const server = new HookServer({ questionTimeoutMs: 5000 })
  const port = await server.start(48450)
  try {
    const posted = fetch(hookUrl(port, server.authToken), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hook_event_name: 'PreToolUse',
        session_id: 'claude-test',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [
            { question: 'First?', header: 'One', options: [{ label: 'a' }] },
            { question: 'Second?', header: 'Two', options: [{ label: 'b' }] }
          ]
        }
      })
    })
    await waitFor(() => server.getPendingInteractions().length === 1)
    const before = server.getPendingInteractions()[0]
    assert.equal(before.windowStartedAt, before.receivedAt)

    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    assert.equal(server.extendInteraction(before.id), true)
    const after = server.getPendingInteractions()[0]
    assert.ok(
      after.expiresAt! > before.expiresAt!,
      'answering a question must push the deadline out'
    )
    assert.ok(
      after.windowStartedAt! > before.windowStartedAt!,
      'the countdown ring measures from the new window'
    )
    assert.equal(server.extendInteraction('no-such-id'), false)

    server.respond(before.id, {
      kind: 'questions',
      answers: { 'question-1': ['a'], 'question-2': ['b'] }
    })
    await posted
  } finally {
    server.stop()
  }
}

/** The follow-up card only appears when a turn actually ends on a question. */
function testTranscriptTail(): void {
  const transcript = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Older turn.' }] } },
    { type: 'user', message: { role: 'user', content: 'go on' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done. All tests pass.\nWant me to also wire this into the tray icon?' }]
      }
    },
    { type: 'system', subtype: 'hook', hookCount: 1 },
    { type: 'file-history-snapshot', messageId: 'x' }
  ].map((record) => JSON.stringify(record)).join('\n')

  assert.match(lastAssistantText(transcript), /^Done\. All tests pass\./)
  assert.equal(
    trailingQuestion(lastAssistantText(transcript)),
    'Want me to also wire this into the tray icon?'
  )

  // A turn that merely mentions a question earlier is not a prompt for input.
  const statement = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Why did it fail? It was the port. Fixed.' }] }
  })
  assert.equal(trailingQuestion(lastAssistantText(statement)), '')

  // A half-written record at the head of the window must not break parsing.
  assert.equal(lastAssistantText(`{"type":"assis\n${statement}`), 'Why did it fail? It was the port. Fixed.')
  assert.equal(lastAssistantText(''), '')
}

function testCodexRolloutParser(): void {
  const questions = [
    {
      id: 'scope',
      header: 'Scope',
      question: 'Which agents?',
      options: [
        { label: 'Managed', description: 'Answer in the notch' },
        { label: 'All', description: 'Display external tasks too' }
      ],
      isOther: true,
      isSecret: false
    }
  ]
  const lines = [
    {
      timestamp: '2026-07-29T12:00:00Z',
      type: 'session_meta',
      payload: { id: 'thread-parser', cwd: 'C:\\repo', originator: 'Codex' }
    },
    {
      timestamp: '2026-07-29T12:00:01Z',
      type: 'event_msg',
      payload: { type: 'task_started' }
    },
    {
      timestamp: '2026-07-29T12:00:02Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input',
        call_id: 'valid-call',
        arguments: JSON.stringify({ questions })
      }
    },
    {
      timestamp: '2026-07-29T12:00:03Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input',
        call_id: 'malformed-call',
        arguments: '{not json'
      }
    },
    {
      timestamp: '2026-07-29T12:00:03Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input',
        call_id: 'second-valid-call',
        arguments: JSON.stringify({ questions })
      }
    }
  ].map((record) => JSON.stringify(record)).join('\n')
  const parsed = parseCodexRollout('fixture.jsonl', lines, Date.now())
  assert.equal(parsed.session?.needsInput, true)
  assert.equal(parsed.interactions.length, 2)
  assert.equal(parsed.interactions[0].answerable, false)
  assert.equal(parsed.interactions[0].transport, 'codex-rollout')
  assert.equal(
    parsed.interactions[0].kind === 'questions'
      ? parsed.interactions[0].questions[0].options[0].description
      : '',
    'Answer in the notch'
  )

  const completed = parseCodexRollout(
    'fixture.jsonl',
    `${lines}\n${JSON.stringify({
      timestamp: '2026-07-29T12:00:04Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'valid-call',
        output: '{"answers":{}}'
      }
    })}`,
    Date.now()
  )
  assert.equal(completed.interactions.length, 1)
}

function testCodexTuiProcessMatching(): void {
  const session = (sessionId: string, startedAt: number): SessionState => ({
    key: `codex:${sessionId}`,
    agent: 'codex',
    sessionId,
    cwd: 'C:\\repo',
    name: sessionId,
    kind: 'codex-tui',
    status: 'busy',
    startedAt,
    updatedAt: startedAt,
    needsInput: false,
    canTerminate: false,
    canFocus: true
  })
  const exact = session('thread-exact', 1_000)
  const direct = session('thread-direct', 20_000)
  const stale = session('thread-stale', 80_000)
  const desktop = { ...session('thread-desktop', 20_000), kind: 'Codex Desktop' }
  const matches = matchCodexTuiProcesses(
    [exact, direct, stale, desktop],
    [
      {
        pid: 101,
        startedAt: 500_000,
        commandLine: 'codex --remote ws://127.0.0.1 resume thread-exact'
      },
      {
        pid: 202,
        startedAt: 20_250,
        commandLine: 'codex --ask-for-approval on-request'
      }
    ]
  )

  assert.equal(matches.get(exact.key)?.pid, 101)
  assert.equal(matches.get(direct.key)?.pid, 202)
  assert.equal(matches.has(stale.key), false)
  assert.equal(matches.has(desktop.key), false)

  const earlier = session('thread-earlier', 0)
  const later = session('thread-later', 50_000)
  const cardinalityMatches = matchCodexTuiProcesses(
    [earlier, later],
    [
      { pid: 303, startedAt: 40_000, commandLine: 'codex' },
      { pid: 404, startedAt: 100_000, commandLine: 'codex' }
    ]
  )
  assert.equal(cardinalityMatches.get(earlier.key)?.pid, 303)
  assert.equal(cardinalityMatches.get(later.key)?.pid, 404)
}

async function testManagedCodexDispatchLaunch(): Promise<void> {
  assert.deepEqual(
    managedCodexResumeArgs(
      'ws://127.0.0.1:4567',
      'thread-command'
    ),
    [
      '--remote',
      'ws://127.0.0.1:4567',
      'resume',
      'thread-command'
    ]
  )

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'notch-managed-'))
  const rolloutPath = path.join(tempDir, 'rollout.jsonl')
  const timeoutPath = path.join(tempDir, 'partial.jsonl')
  const threadId = 'thread-dispatch'
  const record = `${JSON.stringify({
    type: 'session_meta',
    payload: { id: threadId }
  })}\n`
  const splitAt = Math.floor(record.length / 2)
  await fsp.writeFile(rolloutPath, record.slice(0, splitAt))
  await fsp.writeFile(timeoutPath, record.slice(0, splitAt))

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.equal(typeof address, 'object')
  const endpoint = `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const methods: string[] = []
  const launches: { exe: string; args: string[] }[] = []
  const interrupts: { threadId?: string; turnId?: string }[] = []
  let threadStarts = 0
  let rolloutCompleted = false

  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as {
        id?: string | number
        method?: string
        params?: { threadId?: string; turnId?: string }
      }
      if (message.method) methods.push(message.method)
      if (message.method === 'turn/interrupt') {
        interrupts.push(message.params ?? {})
        socket.send(JSON.stringify({ id: message.id, result: {} }))
        return
      }
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: { server: 'fake' } }))
      } else if (message.method === 'model/list') {
        socket.send(JSON.stringify({
          id: message.id,
          result: { data: [{ id: 'gpt-compatible', isDefault: true }] }
        }))
      } else if (message.method === 'thread/start') {
        threadStarts += 1
        const timeout = threadStarts > 1
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            model: 'gpt-newer-than-cli',
            thread: {
              id: timeout ? 'thread-timeout' : threadId,
              path: timeout ? timeoutPath : rolloutPath
            }
          }
        }))
      } else if (message.method === 'turn/start') {
        if (threadStarts === 1) {
          setTimeout(() => {
            fsp.appendFile(rolloutPath, record.slice(splitAt)).then(() => {
              rolloutCompleted = true
            })
          }, 35)
        }
        socket.send(JSON.stringify({
          id: message.id,
          result: { turn: { id: `turn-${threadStarts}` } }
        }))
      }
    })
  })

  const service = new ManagedCodexService({
    endpoint,
    // Pinned to the Windows terminal rather than the host's, so the exact wt.exe
    // argv below stays asserted on a macOS runner too. agentPlans is pure, so
    // this observes real Windows behaviour rather than a stand-in.
    terminal: win32Platform.terminal,
    launchDetached: async (exe, args) => {
      assert.equal(rolloutCompleted, true)
      launches.push({ exe, args })
    },
    rolloutTimeoutMs: 160,
    rolloutPollMs: 5
  })

  try {
    assert.deepEqual(await service.listModels(), [])
    await service.start()
    assert.deepEqual(await service.listModels(), [{ id: 'gpt-compatible', isDefault: true }])
    assert.equal(methods.filter((method) => method === 'model/list').length, 1)
    service.stop()
    await service.start()
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    assert.equal(service.getState().status, 'ready')
    assert.deepEqual(await service.listModels(), [{ id: 'gpt-compatible', isDefault: true }])
    assert.equal(methods.filter((method) => method === 'model/list').length, 2)
    const prompt = 'prompt with spaces\nand "quotes"'
    const result = await service.dispatch({
      agent: 'codex',
      cwd: tempDir,
      prompt,
      permissionMode: 'codex-on-request'
    }, prompt)

    assert.equal(result.ok, true)
    assert.equal(result.transport, 'managed-codex')
    assert.equal(launches.length, 1)
    assert.equal(launches[0].exe, 'wt.exe')
    assert.deepEqual(
      launches[0].args,
      ['-d', tempDir, '--', 'codex', ...managedCodexResumeArgs(
        endpoint,
        threadId
      )]
    )
    assert.equal(methods.includes('turn/start'), true)

    const timeoutResult = await service.dispatch({
      agent: 'codex',
      cwd: tempDir,
      prompt: 'must not launch',
      permissionMode: 'codex-on-request'
    }, 'must not launch')
    assert.equal(timeoutResult.ok, false)
    assert.match(timeoutResult.error ?? '', /terminal was not opened/i)
    assert.equal(launches.length, 1)

    // We told the user nothing was opened, so the accepted turn must not still
    // be running against their project.
    await waitFor(() => interrupts.length === 1)
    assert.deepEqual(interrupts[0], { threadId: 'thread-timeout', turnId: 'turn-2' })
    assert.equal(service.ownsSession('thread-timeout'), false)

    await assert.rejects(
      waitForRolloutReady(timeoutPath, threadId, 40, 5),
      /Codex session was not ready to resume/
    )

    // A disconnected service cannot answer for its threads, so it must stop
    // claiming them — otherwise the rollout fallback prompt stays suppressed.
    assert.equal(service.ownsSession(threadId), true)
    for (const client of server.clients) client.close()
    await waitFor(() => service.getState().status === 'disconnected')
    assert.equal(service.ownsSession(threadId), false)
  } finally {
    service.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fsp.rm(tempDir, { recursive: true, force: true })
  }
}

async function testManagedCodexProtocol(): Promise<void> {
  assert.equal(
    compatibleModelOverride('gpt-newer-than-cli', [
      { id: 'gpt-compatible', isDefault: true }
    ]),
    'gpt-compatible'
  )
  assert.equal(
    compatibleModelOverride('gpt-compatible', [
      { id: 'gpt-compatible', isDefault: true }
    ]),
    undefined
  )

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.equal(typeof address, 'object')
  const endpoint = `ws://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const sockets = new Set<WebSocket>()
  let initialized = 0
  let winningResult: unknown

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as {
        id?: string | number
        method?: string
        result?: unknown
      }
      if (message.method === 'initialize') {
        socket.send(JSON.stringify({ id: message.id, result: { server: 'fake' } }))
      } else if (message.method === 'initialized') {
        initialized++
      } else if (message.id === 'request-1' && message.result && !winningResult) {
        winningResult = message.result
        for (const peer of sockets) {
          peer.send(JSON.stringify({
            method: 'serverRequest/resolved',
            params: { requestId: 'request-1', threadId: 'thread-managed' }
          }))
        }
      }
    })
  })

  const first = new ManagedCodexService({ endpoint })
  const second = new ManagedCodexService({ endpoint })
  await Promise.all([first.start(), second.start()])
  assert.equal(first.getState().requestUserInput, true)
  await waitFor(() => initialized === 2)

  for (const socket of sockets) {
    socket.send(JSON.stringify({
      id: 'request-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-managed',
        turnId: 'turn-1',
        itemId: 'item-1',
        autoResolutionMs: 5000,
        questions: [{
          id: 'choice',
          header: 'Choice',
          question: 'Continue?',
          options: [
            { label: 'Yes', description: 'Keep going' },
            { label: 'No', description: 'Stop here' }
          ],
          isOther: true,
          isSecret: false
        }]
      }
    }))
  }
  await waitFor(
    () =>
      first.getPendingInteractions().length === 1 &&
      second.getPendingInteractions().length === 1
  )
  const interaction = first.getPendingInteractions()[0]
  assert.ok(interaction.expiresAt && interaction.expiresAt > Date.now())
  assert.equal(first.advanceInteraction(interaction.id), true)
  assert.equal(
    first.respond(interaction.id, {
      kind: 'questions',
      answers: { choice: ['Yes'] }
    }),
    true
  )
  await waitFor(
    () =>
      Boolean(winningResult) &&
      first.getPendingInteractions().length === 0 &&
      second.getPendingInteractions().length === 0
  )
  assert.deepEqual(winningResult, {
    answers: { choice: { answers: ['Yes'] } }
  })
  assert.equal(first.advanceInteraction(interaction.id), false)
  assert.equal(
    second.respond(interaction.id, {
      kind: 'questions',
      answers: { choice: ['No'] }
    }),
    false
  )

  for (const socket of sockets) {
    socket.send(JSON.stringify({
      id: 'request-disconnect',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-managed',
        turnId: 'turn-2',
        itemId: 'item-2',
        questions: [{
          id: 'disconnect',
          header: 'Disconnect',
          question: 'This request should be cleared on disconnect.',
          options: [{ label: 'Okay', description: 'Acknowledge' }]
        }]
      }
    }))
  }
  await waitFor(
    () =>
      first.getPendingInteractions().length === 1 &&
      second.getPendingInteractions().length === 1
  )
  for (const socket of sockets) socket.close()
  await waitFor(
    () =>
      first.getState().status === 'disconnected' &&
      second.getState().status === 'disconnected' &&
      first.getPendingInteractions().length === 0 &&
      second.getPendingInteractions().length === 0
  )

  first.stop()
  second.stop()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function testConcurrentSettingsUpdates(): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'notch-settings-test-'))
  try {
    const store = new SettingsStore(dir)
    await store.load()
    assert.equal(store.canApplyStartupSideEffects(), true)
    const emitted: number[] = []
    store.on('update', (settings) => emitted.push(settings.position.offset))

    const updates = Array.from({ length: 40 }, (_, index) =>
      store.update({
        position: {
          displayId: null,
          edge: 'top',
          offset: index / 39
        }
      })
    )
    const results = await Promise.all(updates)
    const saved = JSON.parse(
      await fsp.readFile(path.join(dir, 'settings.json'), 'utf8')
    ) as { position: { offset: number } }

    assert.equal(results.length, 40)
    assert.equal(emitted.length, 40)
    assert.equal(store.get().position.offset, 1)
    assert.equal(saved.position.offset, 1)

    const partials = new SettingsStore(path.join(dir, 'partial'))
    await partials.load()
    await Promise.all([
      partials.update({ position: { edge: 'left', offset: 0.25 } }),
      partials.update({ position: { displayId: 'display-2' } })
    ])
    assert.deepEqual(partials.get().position, {
      displayId: 'display-2',
      edge: 'left',
      offset: 0.25
    })

    // One failed transaction rejects only that caller; the serialization
    // queue must recover for the next update.
    const blockedPath = path.join(dir, 'blocked-by-file')
    await fsp.writeFile(blockedPath, 'not a directory', 'utf8')
    const recovering = new SettingsStore(blockedPath)
    await recovering.load()
    assert.equal(recovering.canApplyStartupSideEffects(), false)
    await assert.rejects(recovering.update({ theme: 'light' }))
    assert.equal(recovering.get().theme, 'dark')
    await fsp.rm(blockedPath)
    await fsp.mkdir(blockedPath)
    assert.equal((await recovering.update({ theme: 'light' })).theme, 'light')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

async function testClaudeProcessIdentityGuard(): Promise<void> {
  if (process.platform !== 'win32') return
  // This test runner is Node, not Claude. A recycled PID owned by any other
  // executable must never pass the final destructive-action guard.
  assert.equal(
    await win32Platform.processes.validateClaudeProcess(process.pid, Date.now()),
    false
  )
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

async function testMobileBridgeSecurityAndLifecycle(): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'notch-mobile-test-'))
  const expiredToken = 'expired-device-token'
  const freshToken = 'fresh-device-token'
  const hash = (token: string): string => createHash('sha256').update(token).digest('hex')
  const now = Date.now()
  await fsp.writeFile(
    path.join(dir, 'mobile-devices.json'),
    JSON.stringify({
      devices: [
        {
          id: 'expired',
          name: 'Expired phone',
          tokenHash: hash(expiredToken),
          pairedAt: now - 31 * 24 * 60 * 60 * 1000,
          lastSeenAt: now
        },
        {
          id: 'fresh',
          name: 'Fresh phone',
          tokenHash: hash(freshToken),
          pairedAt: now,
          lastSeenAt: now
        },
        {
          id: 'revoked',
          name: 'Revoked phone',
          tokenHash: hash('revoked-device-token'),
          pairedAt: now,
          lastSeenAt: now
        }
      ]
    }),
    'utf8'
  )

  let sessions: SessionState[] = []
  let clock = now
  const spawnedFollowups: EventEmitter[] = []
  let getProjects = async (): Promise<string[]> => [dir]
  const watcher = new EventEmitter() as EventEmitter & { getSnapshot(): SessionsSnapshot }
  watcher.getSnapshot = () => ({
    sessions,
    color: 'grey',
    counts: { total: 0, idle: 0, busy: 0, needsInput: 0, reviewing: 0, unknown: 0 },
    prunedCount: 0,
    parkedCount: 0,
    scannedAt: Date.now()
  })
  const dispatched: DispatchRequest[] = []
  const bridge = new MobileBridge({
    userDataDir: dir,
    assetsDir: path.join(process.cwd(), 'mobile', 'dist'),
    watcher: watcher as unknown as SessionWatcher,
    getProjects: () => getProjects(),
    now: () => clock,
    spawnProcess: ((..._args: unknown[]) => {
      const child = new EventEmitter()
      spawnedFollowups.push(child)
      return child
    }) as unknown as typeof import('node:child_process').spawn,
    dispatch: async (request) => {
      dispatched.push(request)
      const agent = request.agent === 'codex' ? 'codex' : 'claude'
      const sessionId = `${agent}-${dispatched.length}`
      sessions = [{
        key: `${agent}:${sessionId}`,
        agent,
        sessionId,
        cwd: dir,
        name: sessionId,
        kind: 'cli',
        status: 'busy',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        needsInput: false,
        canTerminate: true,
        canFocus: true
      }]
      return { ok: true, command: agent, launcher: 'wt', transport: 'legacy-cli' }
    }
  })
  const holders: http.Server[] = []
  const basePort = 48550

  try {
    // Exhaust the complete port search twice. Neither failed attempt may leave
    // an update listener that a later stop can no longer identify.
    for (let port = basePort; port < basePort + 12; port++) {
      const server = http.createServer()
      await listen(server, port)
      holders.push(server)
    }
    await assert.rejects(bridge.start(basePort), /No free port/)
    await assert.rejects(bridge.start(basePort), /No free port/)
    assert.equal(watcher.listenerCount('update'), 0)
    for (const server of holders.splice(0)) await closeServer(server)

    assert.equal(await bridge.start(basePort), basePort)
    assert.equal(watcher.listenerCount('update'), 1)
    assert.equal(bridge.getStatus().pairedDevices, 2)
    clock += 11 * 60 * 1000
    assert.equal(bridge.getStatus().pairingCode, '')

    const origin = `http://127.0.0.1:${basePort}`
    const expired = await fetch(`${origin}/api/v1/snapshot`, {
      headers: { cookie: `notch_device=${expiredToken}` }
    })
    assert.equal(expired.status, 401)

    const dispatchFromPhone = async (agent: 'claude' | 'codex'): Promise<{ key: string }> => {
      const response = await fetch(`${origin}/api/v1/dispatch`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `notch_device=${freshToken}`
        },
        body: JSON.stringify({ agent, cwd: dir, prompt: `Run ${agent}` })
      })
      assert.equal(response.status, 201)
      return response.json() as Promise<{ key: string }>
    }
    await dispatchFromPhone('claude')
    await dispatchFromPhone('codex')
    assert.equal(dispatched[0].permissionMode, 'bypassPermissions')
    assert.equal(dispatched[1].permissionMode, 'codex-bypass')

    const concurrent = await Promise.all([
      dispatchFromPhone('claude'),
      dispatchFromPhone('claude')
    ])
    assert.notEqual(concurrent[0].key, concurrent[1].key)

    const invalidAgent = await fetch(`${origin}/api/v1/dispatch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `notch_device=${freshToken}`
      },
      body: JSON.stringify({ agent: 'claud', cwd: dir, prompt: 'Must not run' })
    })
    assert.equal(invalidAgent.status, 400)
    assert.equal(dispatched.length, 4)

    const malformedCookie = await fetch(`${origin}/api/v1/snapshot`, {
      headers: { cookie: 'notch_device=%E0%A4%A' }
    })
    assert.equal(malformedCookie.status, 401)

    // Reserve an idle conversation before the child reports its asynchronous
    // spawn event. Two phones racing the same follow-up must launch one agent,
    // not two copies that mutate one transcript concurrently.
    const followupSessionId = '12345678-1234-1234-1234-123456789abc'
    sessions = [{
      key: `claude:${followupSessionId}`,
      agent: 'claude',
      sessionId: followupSessionId,
      cwd: dir,
      name: 'Follow-up fixture',
      kind: 'cli',
      status: 'idle',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      needsInput: false,
      canTerminate: true,
      canFocus: true
    }]
    const sendFollowup = (): Promise<Response> => fetch(
      `${origin}/api/v1/sessions/${encodeURIComponent(`claude:${followupSessionId}`)}/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `notch_device=${freshToken}`
        },
        body: JSON.stringify({ text: 'Continue' })
      }
    )
    const firstFollowup = sendFollowup()
    await waitFor(() => spawnedFollowups.length === 1)
    const competingFollowup = await sendFollowup()
    assert.equal(competingFollowup.status, 409)
    assert.equal(spawnedFollowups.length, 1)
    spawnedFollowups[0].emit('spawn')
    assert.equal((await firstFollowup).status, 202)
    spawnedFollowups[0].emit('exit', 0)

    sessions = [{ ...sessions[0], status: 'reviewing' }]
    const reviewingFollowup = await sendFollowup()
    assert.equal(reviewingFollowup.status, 409)
    assert.equal(spawnedFollowups.length, 1)

    // The initial SSE snapshot captures A, then waits on project discovery.
    // An update to B during that wait must be delivered afterward and in order.
    let releaseProjects!: () => void
    const projectsGate = new Promise<void>((resolve) => { releaseProjects = resolve })
    let projectCalls = 0
    getProjects = async () => {
      projectCalls++
      if (projectCalls === 1) await projectsGate
      return [dir]
    }
    sessions = [{ ...sessions[0], name: 'Snapshot A', updatedAt: Date.now() }]
    const orderedStreamPromise = fetch(`${origin}/api/v1/events`, {
      headers: { cookie: `notch_device=${freshToken}` }
    })
    await waitFor(() => projectCalls === 1)
    sessions = [{ ...sessions[0], name: 'Snapshot B', updatedAt: Date.now() + 1 }]
    watcher.emit('update')
    releaseProjects()
    const orderedStream = await orderedStreamPromise
    const orderedReader = orderedStream.body!.getReader()
    const decoder = new TextDecoder()
    let streamed = ''
    const streamDeadline = Date.now() + 2000
    while (!streamed.includes('Snapshot B') && Date.now() < streamDeadline) {
      const read = await Promise.race([
        orderedReader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE update timed out')), 500))
      ])
      if (read.done) break
      streamed += decoder.decode(read.value, { stream: true })
    }
    assert.ok(streamed.includes('Snapshot A'))
    assert.ok(streamed.includes('Snapshot B'))
    assert.ok(streamed.indexOf('Snapshot A') < streamed.indexOf('Snapshot B'))
    await orderedReader.cancel()
    getProjects = async () => [dir]

    const oversized = await fetch(`${origin}/api/v1/dispatch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `notch_device=${freshToken}`
      },
      body: JSON.stringify({ prompt: 'x'.repeat(70 * 1024) })
    })
    assert.equal(oversized.status, 413)
    assert.match((await oversized.json() as { error: string }).error, /too large/i)

    // Revoking one phone closes its already-authorized stream without
    // interrupting credentials belonging to another device.
    const revokedStream = await fetch(`${origin}/api/v1/events`, {
      headers: { cookie: 'notch_device=revoked-device-token' }
    })
    assert.equal(revokedStream.status, 200)
    const revokedReader = revokedStream.body!.getReader()
    await revokedReader.read()
    const revoked = await fetch(`${origin}/api/v1/pair`, {
      method: 'DELETE',
      headers: { cookie: 'notch_device=revoked-device-token' }
    })
    assert.equal(revoked.status, 200)
    assert.equal((await revokedReader.read()).done, true)

    const expiringStream = await fetch(`${origin}/api/v1/events`, {
      headers: { cookie: `notch_device=${freshToken}` }
    })
    const expiringReader = expiringStream.body!.getReader()
    await expiringReader.read()

    // Expiry is enforced by each authorization check, not only when the bridge
    // happens to restart and reload its device file.
    clock += 31 * 24 * 60 * 60 * 1000
    watcher.emit('update')
    assert.equal((await expiringReader.read()).done, true)
    const expiredWhileRunning = await fetch(`${origin}/api/v1/snapshot`, {
      headers: { cookie: `notch_device=${freshToken}` }
    })
    assert.equal(expiredWhileRunning.status, 401)
    assert.equal(bridge.getStatus().pairedDevices, 0)

    bridge.stop()
    assert.equal(watcher.listenerCount('update'), 0)
    assert.equal(await bridge.start(basePort), basePort)
  } finally {
    bridge.stop()
    for (const server of holders) await closeServer(server)
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

function testPriorityPillLabels(): void {
  const counts = (
    values: Partial<SessionsSnapshot['counts']>
  ): SessionsSnapshot['counts'] => ({
    total: 1,
    idle: 0,
    busy: 0,
    needsInput: 0,
    reviewing: 0,
    unknown: 0,
    ...values
  })

  assert.equal(priorityPillLabel(counts({ busy: 1 }), 1), 'Needs you')
  assert.equal(priorityPillLabel(counts({ needsInput: 1, reviewing: 1, busy: 1 }), 0), 'Needs you')
  assert.equal(priorityPillLabel(counts({ reviewing: 1, busy: 1 }), 0), 'Reviewing')
  assert.equal(priorityPillLabel(counts({ busy: 1, idle: 1 }), 0), 'Working')
  assert.equal(priorityPillLabel(counts({ total: 0 }), 0), 'Idle')
  assert.equal(priorityPillLabel(counts({ idle: 1, unknown: 1 }), 0), 'Idle')
  assert.equal(priorityPillLabel(counts({ unknown: 1 }), 0), 'Unknown')

  // The renderer always emits both indicators, including zero. These cover the
  // shortest and widest practical count strings used during visual layout QA.
  for (const claude of [0, 1, 99]) {
    for (const codex of [0, 1, 99]) {
      assert.equal(`${claude}`.length <= 2 && `${codex}`.length <= 2, true)
    }
  }
}

async function main(): Promise<void> {
  await testClaudeNormalizationAndRoundTrip()
  await testHookAuthorization()
  await testHookShutdownIsNotTimeout()
  await testNeedsInputClearsOnNextPrompt()
  await testPermissionAllowEchoesInput()
  testHookSpecs()
  testParkedSessionDedupe()
  await testPerQuestionDeadline()
  testTranscriptTail()
  testCodexRolloutParser()
  testCodexTuiProcessMatching()
  await testManagedCodexDispatchLaunch()
  await testManagedCodexProtocol()
  await testConcurrentSettingsUpdates()
  await testClaudeProcessIdentityGuard()
  await testMobileBridgeSecurityAndLifecycle()
  testPriorityPillLabels()
  console.log('Interaction tests passed.')
}

/** No individual test is anywhere near this slow; reaching it means a stuck await. */
const WATCHDOG_MS = 120_000
/** Long enough for stdio to flush, short enough that a leak is not a hang. */
const FLUSH_GRACE_MS = 100

// Both timers are unref'd: they can never be the reason the process stays up,
// but they still fire whenever something else is holding the loop open.
const watchdog = setTimeout(() => {
  console.error(`Interaction tests exceeded ${WATCHDOG_MS}ms without finishing — aborting.`)
  process.exit(1)
}, WATCHDOG_MS)
watchdog.unref()

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    clearTimeout(watchdog)
    // A failed assertion skips the server.stop() below it, and a listening
    // server keeps node alive forever. Report the result instead of hanging.
    setTimeout(() => process.exit(process.exitCode ?? 0), FLUSH_GRACE_MS).unref()
  })
