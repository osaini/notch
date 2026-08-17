import os from 'node:os'
import path from 'node:path'

export interface AgentPaths {
  claudeRoot: string
  claudeSessions: string
  claudeProjects: string
  claudeTranscripts: string
  claudeProjectIndex: string
  codexRoot: string
  codexSessions: string
  codexArchivedSessions: string
  codexSessionIndex: string
  /**
   * Explicit override for Claude Cowork's `local-agent-mode-sessions` tree, or
   * `null` to let the platform probe find it.
   *
   * Unlike the Claude and Codex roots there is no upstream-blessed environment
   * variable to honour here — Cowork's location is not configurable — so this is
   * Notch's own, and exists so `verify` and the tests can be pointed at a
   * fixture without touching the real Claude Desktop data.
   */
  coworkOverride: string | null
}

function configuredRoot(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && value.trim() ? path.resolve(value.trim()) : fallback
}

/**
 * Local data roots used by Claude Code and Codex.
 *
 * Keeping this in one place prevents the usage scanner, live-session watcher,
 * and transcript readers from quietly looking at different homes. The injected
 * arguments also make environment override behavior testable without mutating
 * the process-wide environment.
 */
export function resolveAgentPaths(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir()
): AgentPaths {
  const hasClaudeOverride =
    typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim().length > 0
  const claudeRoot = configuredRoot(env.CLAUDE_CONFIG_DIR, path.join(homeDir, '.claude'))
  const codexRoot = configuredRoot(env.CODEX_HOME, path.join(homeDir, '.codex'))
  return {
    claudeRoot,
    claudeSessions: path.join(claudeRoot, 'sessions'),
    claudeProjects: path.join(claudeRoot, 'projects'),
    claudeTranscripts: path.join(claudeRoot, 'transcripts'),
    claudeProjectIndex: hasClaudeOverride
      ? path.join(claudeRoot, '.claude.json')
      : path.join(homeDir, '.claude.json'),
    codexRoot,
    codexSessions: path.join(codexRoot, 'sessions'),
    codexArchivedSessions: path.join(codexRoot, 'archived_sessions'),
    codexSessionIndex: path.join(codexRoot, 'session_index.jsonl'),
    coworkOverride:
      typeof env.NOTCH_COWORK_DIR === 'string' && env.NOTCH_COWORK_DIR.trim()
        ? path.resolve(env.NOTCH_COWORK_DIR.trim())
        : null
  }
}

export const AGENT_PATHS = resolveAgentPaths()
