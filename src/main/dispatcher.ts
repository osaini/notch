import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  DispatchRequest,
  DispatchResult,
  PermissionMode,
  SessionState
} from '@shared/types'
import { buildImplementerPrompt, buildReviewerPrompt } from './comboPrompts'
import { AGENT_PATHS } from './agentPaths'
import type { ManagedCodexService } from './managedCodex'
import { platform } from './platform'
import { runFirstWorkingPlan } from './platform/launch'
import type { LaunchPlan, TerminalRunRequest } from './platform/types'

const CLAUDE_MODES: PermissionMode[] = [
  'manual',
  'auto',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk'
]

/**
 * The mode the pair's implementer runs under when the request names one that
 * Claude cannot use. `auto` clears its own approvals behind a safety
 * classifier, which is what makes an unattended implementer useful.
 */
export const IMPLEMENTER_MODE: PermissionMode = 'auto'

/** Where `auto` is turned off, the implementer lands here instead. */
export const IMPLEMENTER_FALLBACK_MODE: PermissionMode = 'acceptEdits'

/**
 * True when any Claude settings file switches `auto` off.
 *
 * Claude Code refuses to start under `--permission-mode auto` once
 * `permissions.disableAutoMode` is set, so a dispatch that assumed `auto`
 * would fail in the terminal with nothing useful shown here. Reading the flag
 * lets the launch degrade to `acceptEdits` instead of not launching at all.
 */
export function isAutoModeDisabled(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object') return false
  const permissions = (settings as { permissions?: unknown }).permissions
  if (!permissions || typeof permissions !== 'object') return false
  return (permissions as { disableAutoMode?: unknown }).disableAutoMode === 'disable'
}

/** Downgrades `auto` to something launchable when the mode is switched off. */
export function resolveClaudeMode(
  mode: PermissionMode,
  autoDisabled: boolean
): PermissionMode {
  return mode === 'auto' && autoDisabled ? IMPLEMENTER_FALLBACK_MODE : mode
}

export function buildClaudeArgs(req: DispatchRequest): string[] {
  const args: string[] = []
  if (
    req.permissionMode &&
    CLAUDE_MODES.includes(req.permissionMode)
  ) {
    args.push('--permission-mode', req.permissionMode)
  }
  if (req.claude?.model) args.push('--model', req.claude.model)
  if (req.claude?.effort) args.push('--effort', req.claude.effort)
  const prompt = composePrompt(req)
  if (prompt) args.push(prompt)
  return args
}

export function buildCodexArgs(
  req: DispatchRequest,
  options: { sandbox?: 'read-only' } = {}
): string[] {
  const args: string[] = []
  // Top-level Codex flag, so it applies to the interactive CLI and not just
  // `codex exec`. Placed before the approval policy so the argv reads as
  // sandbox-then-policy, matching how the orchestrator builds its commands.
  if (options.sandbox) args.push('--sandbox', options.sandbox)
  switch (req.permissionMode) {
    case 'codex-untrusted':
      args.push('--ask-for-approval', 'untrusted')
      break
    case 'codex-never':
      args.push('--ask-for-approval', 'never')
      break
    case 'codex-bypass':
      args.push('--dangerously-bypass-approvals-and-sandbox')
      break
    case 'codex-on-request':
    default:
      args.push('--ask-for-approval', 'on-request')
      break
  }
  if (req.codex?.model) args.push('--model', req.codex.model)
  // Codex has no effort flag; the level is a config override. The value is
  // parsed as TOML, so it is quoted to land as a string rather than relying on
  // the parser's raw-literal fallback.
  if (req.codex?.effort) args.push('-c', `model_reasoning_effort="${req.codex.effort}"`)
  const prompt = composePrompt(req)
  if (prompt) args.push(prompt)
  return args
}

/** Appends Tray attachments to the prompt as @-references. */
export function composePrompt(req: DispatchRequest): string {
  const parts: string[] = []
  const prompt = req.prompt?.trim()
  if (prompt) parts.push(prompt)
  for (const file of req.attachments ?? []) {
    if (file) parts.push(`@${file}`)
  }
  return parts.join('\n')
}

/** Relative path probed to decide whether a project can run the pipeline. */
export const ORCHESTRATOR_ENTRY = 'debug-orchestrator/orchestrate.mjs'

/**
 * Drives the repository's own bug-search pipeline.
 *
 * `node` is invoked directly rather than `npm run bugs:scan` because `npm`
 * resolves to `npm.cmd` on Windows, which Windows Terminal will not launch.
 * `orchestrate.mjs` derives its repo root from its own file location, so the
 * script always scans the project it lives in.
 */
export function buildBugSearchRequest(cwd: string): TerminalRunRequest {
  return { cwd, exe: 'node', args: [ORCHESTRATOR_ENTRY, 'scan'] }
}

/**
 * Role-split argv for the adversarial pair.
 *
 * The implementer honours whichever Claude permission mode was chosen, falling
 * back to `auto`. The reviewer is pinned to a read-only sandbox and is
 * never allowed to request command approval. Both settings are deliberately not
 * configurable: the sandbox makes `never` safe, and a reviewer that can edit
 * the tree it is reviewing has stopped being a reviewer.
 *
 * Model and effort are not safety properties, so each half keeps its own: the
 * request carries them under `claude` and `codex`, and spreading `req` into the
 * two builders below routes each to the agent it names.
 */
export function buildAdversarialArgs(
  req: DispatchRequest,
  options: { autoDisabled?: boolean } = {}
): {
  claudeArgs: string[]
  codexArgs: string[]
} {
  const task = composePrompt(req)
  const implementerMode = resolveClaudeMode(
    req.permissionMode && CLAUDE_MODES.includes(req.permissionMode)
      ? req.permissionMode
      : IMPLEMENTER_MODE,
    options.autoDisabled ?? false
  )
  return {
    claudeArgs: buildClaudeArgs({
      ...req,
      prompt: buildImplementerPrompt(task),
      attachments: [],
      permissionMode: implementerMode
    }),
    codexArgs: buildCodexArgs(
      {
        ...req,
        prompt: buildReviewerPrompt(task),
        attachments: [],
        permissionMode: 'codex-never'
      },
      { sandbox: 'read-only' }
    )
  }
}

/**
 * Runs the platform's launch plans and shapes the outcome into a DispatchResult.
 *
 * No plans means the platform has no terminal integration yet; that degrades to
 * a typed failure rather than throwing, so the UI can say so.
 */
async function runPlans(plans: LaunchPlan[]): Promise<DispatchResult> {
  if (plans.length === 0) {
    return {
      ok: false,
      command: '',
      launcher: platform.terminal.primaryLauncher,
      transport: 'legacy-cli',
      error: `Launching a terminal is not available on ${platform.os} yet.`
    }
  }
  const outcome = await runFirstWorkingPlan(plans)
  return {
    ok: outcome.ok,
    command: outcome.plan.display,
    launcher: outcome.plan.launcher,
    transport: 'legacy-cli',
    ...(outcome.error ? { error: outcome.error } : {})
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fsp.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Whether this machine has `auto` switched off, read fresh per dispatch.
 *
 * Unreadable or unparseable settings mean "not disabled": the mode is on by
 * default, so guessing otherwise would downgrade launches for no reason.
 */
export async function autoModeDisabled(
  cwd: string,
  claudeRoot = AGENT_PATHS.claudeRoot
): Promise<boolean> {
  // Claude merges user settings with both checked-in and local project
  // settings. Any layer can prohibit auto mode, and the selected project is
  // exactly the directory the dispatched CLI will load them from.
  const files = [
    path.join(claudeRoot, 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json')
  ]
  for (const file of files) {
    try {
      const text = await fsp.readFile(file, 'utf8')
      if (isAutoModeDisabled(JSON.parse(text))) return true
    } catch {
      // Missing and malformed layers do not erase a valid setting in another
      // layer. Keep looking before falling back to Claude's default.
    }
  }
  return false
}

/**
 * Spawns a detached agent session in its own terminal window.
 *
 * Args are passed as an array, never as a shell string, so prompts containing
 * quotes, `;` (which Windows Terminal treats as a pane delimiter) or `&` are
 * handed to the agent verbatim. That invariant now lives in
 * `TerminalIntegration`, which every platform's launch plans must honour — see
 * SECURITY.md.
 */
export async function dispatch(
  req: DispatchRequest,
  managedCodex?: ManagedCodexService
): Promise<DispatchResult> {
  const cwd = req.cwd?.trim()
  if (!cwd) {
    return {
      ok: false,
      command: '',
      launcher: platform.terminal.primaryLauncher,
      transport: 'legacy-cli',
      error: 'No project directory selected'
    }
  }
  if (!(await isDirectory(cwd))) {
    return {
      ok: false,
      command: '',
      launcher: platform.terminal.primaryLauncher,
      transport: 'legacy-cli',
      error: `Not a directory: ${cwd}`
    }
  }

  // Before the managed-Codex path: a pair wants two real terminals side by
  // side, not a loopback App Server session.
  if (req.agent === 'claude-codex') return dispatchCombo(req, cwd)

  const agent = req.agent === 'codex' ? 'codex' : 'claude'
  if (agent === 'codex' && managedCodex) {
    try {
      return await managedCodex.dispatch(req, composePrompt(req))
    } catch (error) {
      console.warn('[managed codex] falling back to CLI:', (error as Error).message)
    }
  }
  if (agent === 'codex') {
    return runPlans(
      platform.terminal.agentPlans({ cwd, exe: agent, args: buildCodexArgs(req) })
    )
  }
  // Only Claude has a mode that the machine can refuse, so only Claude pays for
  // the settings read.
  const permissionMode = resolveClaudeMode(req.permissionMode, await autoModeDisabled(cwd))
  const agentArgs = buildClaudeArgs({ ...req, permissionMode })
  return runPlans(platform.terminal.agentPlans({ cwd, exe: agent, args: agentArgs }))
}

/** True when the project carries its own copy of the bug-search pipeline. */
export async function hasOrchestrator(cwd: string): Promise<boolean> {
  try {
    return (await fsp.stat(path.join(cwd, ORCHESTRATOR_ENTRY))).isFile()
  } catch {
    return false
  }
}

/**
 * Launches the Claude + Codex pair.
 *
 * `bug-search` drives the repository's own pipeline, which only exists in
 * projects that vendor `debug-orchestrator/`. Everywhere else the request
 * degrades to the adversarial pair rather than failing, so the button still
 * does the useful half of what it promises.
 */
async function dispatchCombo(req: DispatchRequest, cwd: string): Promise<DispatchResult> {
  const wantsBugSearch = req.comboWorkflow === 'bug-search'
  const bugSearch = wantsBugSearch && (await hasOrchestrator(cwd))

  // The pipeline is a single command, so it is an ordinary agent launch. Only
  // the adversarial pair wants two commands side by side.
  if (bugSearch) {
    return runPlans(platform.terminal.agentPlans(buildBugSearchRequest(cwd)))
  }

  const { claudeArgs, codexArgs } = buildAdversarialArgs(req, {
    autoDisabled: await autoModeDisabled(cwd)
  })
  return runPlans(
    platform.terminal.pairPlans(
      { cwd, exe: 'claude', args: claudeArgs },
      { cwd, exe: 'codex', args: codexArgs }
    )
  )
}

/**
 * Candidate project directories for the dispatch picker: the cwds of live
 * sessions first, then everything Claude Code has recorded in ~/.claude.json.
 * Paths there appear in both slash conventions, so they are normalised and
 * deduplicated.
 */
export async function getRecentProjects(sessions: SessionState[]): Promise<string[]> {
  const seen = new Map<string, string>()

  const add = (raw: string): void => {
    if (!raw) return
    const normalized = platform.paths.normalizeProjectPath(raw)
    if (!normalized) return
    // Windows folds case here; POSIX must not, or two real paths collapse.
    const key = platform.paths.projectPathKey(normalized)
    if (!seen.has(key)) seen.set(key, normalized)
  }

  for (const session of sessions) add(session.cwd)

  try {
    const text = await fsp.readFile(AGENT_PATHS.claudeProjectIndex, 'utf8')
    const config = JSON.parse(text) as { projects?: Record<string, unknown> }
    for (const dir of Object.keys(config.projects ?? {})) add(dir)
  } catch {
    // No config, or unreadable — the live sessions are still a useful list.
  }

  const dirs = [...seen.values()]
  const checks = await Promise.all(dirs.map((dir) => isDirectory(dir)))
  return dirs.filter((_, i) => checks[i])
}

