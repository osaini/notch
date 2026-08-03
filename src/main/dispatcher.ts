import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  DispatchRequest,
  DispatchResult,
  PermissionMode,
  SessionState
} from '@shared/types'
import { buildImplementerPrompt, buildReviewerPrompt } from './comboPrompts'
import type { ManagedCodexService } from './managedCodex'
import { platform } from './platform'
import { runFirstWorkingPlan } from './platform/launch'
import type { LaunchPlan, TerminalRunRequest } from './platform/types'

const CLAUDE_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions'
]

export function buildClaudeArgs(req: DispatchRequest): string[] {
  const args: string[] = []
  if (
    req.permissionMode &&
    CLAUDE_MODES.includes(req.permissionMode) &&
    req.permissionMode !== 'default'
  ) {
    args.push('--permission-mode', req.permissionMode)
  }
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
 * back to `acceptEdits`. The reviewer is pinned to a read-only sandbox and is
 * never allowed to request command approval. Both settings are deliberately not
 * configurable: the sandbox makes `never` safe, and a reviewer that can edit
 * the tree it is reviewing has stopped being a reviewer.
 */
export function buildAdversarialArgs(req: DispatchRequest): {
  claudeArgs: string[]
  codexArgs: string[]
} {
  const task = composePrompt(req)
  const implementerMode =
    req.permissionMode && CLAUDE_MODES.includes(req.permissionMode)
      ? req.permissionMode
      : 'acceptEdits'
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
  const agentArgs = agent === 'codex' ? buildCodexArgs(req) : buildClaudeArgs(req)
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

  const { claudeArgs, codexArgs } = buildAdversarialArgs(req)
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
    const text = await fsp.readFile(path.join(os.homedir(), '.claude.json'), 'utf8')
    const config = JSON.parse(text) as { projects?: Record<string, unknown> }
    for (const dir of Object.keys(config.projects ?? {})) add(dir)
  } catch {
    // No config, or unreadable — the live sessions are still a useful list.
  }

  const dirs = [...seen.values()]
  const checks = await Promise.all(dirs.map((dir) => isDirectory(dir)))
  return dirs.filter((_, i) => checks[i])
}

