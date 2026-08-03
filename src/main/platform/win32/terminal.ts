import type { LaunchPlan, TerminalIntegration, TerminalRunRequest } from '../types'
import { encodedPowerShell, encodedValue } from './powershell'

/** Renders argv for display only — never used to spawn. */
function displayCommand(exe: string, args: string[]): string {
  const quoted = args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg))
  return [exe, ...quoted].join(' ')
}

/**
 * Builds the argv for Windows Terminal.
 *
 * Verified on Windows Terminal + Claude Code 2.1.220: the `--` terminator is
 * REQUIRED. Without it wt parses `--permission-mode` as one of its own
 * `new-tab` options and the tab dies immediately.
 */
export function buildWtArgs(request: TerminalRunRequest): string[] {
  return ['-d', request.cwd, '--', request.exe, ...request.args]
}

/**
 * Two agents, one window, two panes.
 *
 * `;` is Windows Terminal's pane delimiter. Because argv is passed as an array
 * and never as a shell string, it is safe — and required — as its own element;
 * embedding it in an adjacent argument would make wt parse the whole thing as
 * one command.
 */
export function buildPairWtArgs(
  first: TerminalRunRequest,
  second: TerminalRunRequest
): string[] {
  return [
    ...buildWtArgs(first),
    ';',
    'split-pane',
    ...buildWtArgs(second)
  ]
}

/**
 * Safe no-Windows-Terminal fallback. User-controlled values are base64-decoded
 * inside a fixed PowerShell program and invoked as an argument array; they are
 * never interpolated into shell syntax.
 */
export function buildPowerShellConsoleArgs(request: TerminalRunRequest): string[] {
  const encodedArgs = request.args.map((arg) => `'${encodedValue(arg)}'`).join(', ')
  const script = `
$decode = { param([string]$value) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) }
$targetDir = & $decode '${encodedValue(request.cwd)}'
$agentArgs = @(${encodedArgs}) | ForEach-Object { & $decode $_ }
Set-Location -LiteralPath $targetDir
& '${request.exe}' @agentArgs
`
  return ['-NoProfile', '-NoExit', '-EncodedCommand', encodedPowerShell(script)]
}

function wtPlan(args: string[]): LaunchPlan {
  return {
    launcher: 'wt',
    display: displayCommand('wt.exe', args),
    launches: [{ exe: 'wt.exe', args }]
  }
}

export const terminal: TerminalIntegration = {
  primaryLabel: 'Windows Terminal',
  primaryLauncher: 'wt',
  supportsSplitPane: true,

  agentPlans(request) {
    return [
      wtPlan(buildWtArgs(request)),
      {
        launcher: 'powershell',
        display: `powershell.exe -NoExit -- ${request.exe} ${request.args.length} argument(s)`,
        launches: [
          { exe: 'powershell.exe', args: buildPowerShellConsoleArgs(request) }
        ]
      }
    ]
  },

  pairPlans(first, second) {
    return [
      wtPlan(buildPairWtArgs(first, second)),
      {
        launcher: 'powershell',
        // No Windows Terminal: two separate consoles instead of two panes.
        display: `powershell.exe -NoExit -- ${first.exe} + ${second.exe} (2 consoles)`,
        launches: [
          { exe: 'powershell.exe', args: buildPowerShellConsoleArgs(first) },
          { exe: 'powershell.exe', args: buildPowerShellConsoleArgs(second) }
        ]
      }
    ]
  }
}
