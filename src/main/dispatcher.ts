import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentKind,
  DispatchRequest,
  DispatchResult,
  PermissionMode,
  SessionState
} from '@shared/types'
import { buildImplementerPrompt, buildReviewerPrompt } from './comboPrompts'
import type { ManagedCodexService } from './managedCodex'

const CLAUDE_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions'
]

/**
 * Builds the argv for Windows Terminal.
 *
 * Verified on Windows Terminal + Claude Code 2.1.220: the `--` terminator is
 * REQUIRED. Without it wt parses `--permission-mode` as one of its own
 * `new-tab` options and the tab dies immediately.
 */
export function buildWtArgs(cwd: string, claudeArgs: string[]): string[] {
  return ['-d', cwd, '--', 'claude', ...claudeArgs]
}

export function buildAgentWtArgs(
  cwd: string,
  agent: AgentKind,
  agentArgs: string[]
): string[] {
  return ['-d', cwd, '--', agent, ...agentArgs]
}

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
export function buildBugSearchWtArgs(cwd: string): string[] {
  return ['-d', cwd, '--', 'node', ORCHESTRATOR_ENTRY, 'scan']
}

/**
 * Two agents, one window, two panes.
 *
 * `;` is Windows Terminal's pane delimiter. Because argv is passed as an array
 * and never as a shell string, it is safe — and required — as its own element;
 * embedding it in an adjacent argument would make wt parse the whole thing as
 * one command.
 */
export function buildAdversarialWtArgs(
  cwd: string,
  claudeArgs: string[],
  codexArgs: string[]
): string[] {
  return [
    '-d', cwd, '--', 'claude', ...claudeArgs,
    ';',
    'split-pane', '-d', cwd, '--', 'codex', ...codexArgs
  ]
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

/** Renders argv for display only — not used to actually spawn. */
function displayCommand(exe: string, args: string[]): string {
  const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a))
  return [exe, ...quoted].join(' ')
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fsp.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Spawns a detached Claude Code session in its own terminal window.
 *
 * Args are passed as an array, never as a shell string, so prompts containing
 * quotes, `;` (which Windows Terminal treats as a pane delimiter) or `&` are
 * handed to claude verbatim.
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
      launcher: 'wt',
      transport: 'legacy-cli',
      error: 'No project directory selected'
    }
  }
  if (!(await isDirectory(cwd))) {
    return {
      ok: false,
      command: '',
      launcher: 'wt',
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
  const wtArgs = buildAgentWtArgs(cwd, agent, agentArgs)
  const wtCommand = displayCommand('wt.exe', wtArgs)

  try {
    await spawnDetached('wt.exe', wtArgs)
    return {
      ok: true,
      command: wtCommand,
      launcher: 'wt',
      transport: 'legacy-cli'
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        ok: false,
        command: wtCommand,
        launcher: 'wt',
        transport: 'legacy-cli',
        error: (err as Error).message
      }
    }
  }

  const fallbackCommand = `powershell.exe -NoExit -- ${agent} ${agentArgs.length} argument(s)`
  try {
    await spawnPowerShellConsole(cwd, agent, agentArgs)
    return {
      ok: true,
      command: fallbackCommand,
      launcher: 'powershell',
      transport: 'legacy-cli'
    }
  } catch (err) {
    return {
      ok: false,
      command: fallbackCommand,
      launcher: 'powershell',
      transport: 'legacy-cli',
      error: (err as Error).message
    }
  }
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

  const wtArgs = bugSearch
    ? buildBugSearchWtArgs(cwd)
    : (() => {
        const { claudeArgs, codexArgs } = buildAdversarialArgs(req)
        return buildAdversarialWtArgs(cwd, claudeArgs, codexArgs)
      })()
  const wtCommand = displayCommand('wt.exe', wtArgs)

  try {
    await spawnDetached('wt.exe', wtArgs)
    return { ok: true, command: wtCommand, launcher: 'wt', transport: 'legacy-cli' }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        ok: false,
        command: wtCommand,
        launcher: 'wt',
        transport: 'legacy-cli',
        error: (err as Error).message
      }
    }
  }

  // No Windows Terminal: two separate consoles instead of two panes.
  const fallbackCommand = bugSearch
    ? 'powershell.exe -NoExit -- node debug-orchestrator/orchestrate.mjs scan'
    : 'powershell.exe -NoExit -- claude + codex (2 consoles)'
  try {
    if (bugSearch) {
      await spawnPowerShellConsole(cwd, 'node', [ORCHESTRATOR_ENTRY, 'scan'])
    } else {
      const { claudeArgs, codexArgs } = buildAdversarialArgs(req)
      await spawnPowerShellConsole(cwd, 'claude', claudeArgs)
      await spawnPowerShellConsole(cwd, 'codex', codexArgs)
    }
    return {
      ok: true,
      command: fallbackCommand,
      launcher: 'powershell',
      transport: 'legacy-cli'
    }
  } catch (err) {
    return {
      ok: false,
      command: fallbackCommand,
      launcher: 'powershell',
      transport: 'legacy-cli',
      error: (err as Error).message
    }
  }
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
    const normalized = path.win32.normalize(raw.replace(/\//g, '\\')).replace(/[\\/]+$/, '')
    if (!normalized) return
    const key = normalized.toLowerCase()
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

/** Resolves once the child is spawned; rejects if the exe cannot be found. */
function spawnDetached(exe: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * Safe no-Windows-Terminal fallback. User-controlled values are base64-decoded
 * inside a fixed PowerShell program and invoked as an argument array; they are
 * never interpolated into shell syntax.
 */
function spawnPowerShellConsole(
  cwd: string,
  /** Executable name — an agent CLI, or `node` for the pipeline. */
  agent: string,
  args: string[]
): Promise<void> {
  const encode = (value: string): string => Buffer.from(value, 'utf8').toString('base64')
  const encodedArgs = args.map((arg) => `'${encode(arg)}'`).join(', ')
  const script = `
$decode = { param([string]$value) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) }
$targetDir = & $decode '${encode(cwd)}'
$agentArgs = @(${encodedArgs}) | ForEach-Object { & $decode $_ }
Set-Location -LiteralPath $targetDir
& '${agent}' @agentArgs
`
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64')
  return spawnDetached('powershell.exe', [
    '-NoProfile',
    '-NoExit',
    '-EncodedCommand',
    encodedScript
  ])
}
