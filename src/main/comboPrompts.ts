/**
 * Role prompts for the `claude-codex` dispatch target.
 *
 * Both agents are launched against the same directory with the same underlying
 * task. What differs is the role each one is told to play, so the pair produces
 * an argument rather than two independent attempts at the same work. These are
 * pure string builders — no spawning, no filesystem — so `verify` can assert
 * their shape without launching anything.
 */

/** Kept short: it is prepended to a prompt the user already wrote. */
const IMPLEMENTER_ROLE = [
  'You are the IMPLEMENTER in an adversarial pair.',
  'Codex is running beside you in the same directory as your reviewer, and will',
  'attack whatever you produce. Plan first, state your assumptions explicitly,',
  'then implement. Expect every shortcut to be found. When the reviewer raises a',
  'point, fix it or say plainly why it is wrong — do not silently concede.'
].join(' ')

const REVIEWER_ROLE = [
  'You are the ADVERSARIAL REVIEWER in a pair.',
  'Claude Code is running beside you in the same directory and is implementing',
  'this task. Your job is to find what is wrong with its plan and its code:',
  'incorrect edge cases, unhandled failures, broken assumptions, missed',
  'requirements. You are running read-only — do not edit files. Read the work as',
  'it lands and report concrete, evidenced problems rather than style opinions.'
].join(' ')

/**
 * The shared task block. Both roles get the identical user prompt so neither
 * is working from a summary of the other's brief.
 */
function withTask(role: string, task: string): string {
  const trimmed = task.trim()
  if (!trimmed) return role
  return `${role}\n\nThe task:\n\n${trimmed}`
}

export function buildImplementerPrompt(task: string): string {
  return withTask(IMPLEMENTER_ROLE, task)
}

export function buildReviewerPrompt(task: string): string {
  return withTask(REVIEWER_ROLE, task)
}
