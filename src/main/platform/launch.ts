import { spawn } from 'node:child_process'
import type { LaunchPlan } from './types'

/**
 * Resolves once the child is spawned; rejects if the exe cannot be found.
 *
 * `windowsHide: false` is deliberate — these launches are terminal windows the
 * user is meant to see. It is a no-op off Windows.
 */
export function spawnDetached(exe: string, args: string[]): Promise<void> {
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

export interface LaunchOutcome {
  ok: boolean
  plan: LaunchPlan
  error?: string
}

/**
 * Tries each plan in order and returns the first that spawns.
 *
 * A missing executable (ENOENT) is the only failure worth falling through on:
 * it means this terminal is not installed. Any other error is a real problem
 * with a terminal that *is* there, so it is reported rather than papered over by
 * silently opening something else.
 *
 * The last plan reports whatever went wrong, ENOENT included — by then there is
 * nothing left to fall back to.
 */
export async function runFirstWorkingPlan(
  plans: LaunchPlan[],
  /** Injectable so managed-Codex tests can observe launches without spawning. */
  spawnFn: (exe: string, args: string[]) => Promise<void> = spawnDetached
): Promise<LaunchOutcome> {
  if (plans.length === 0) {
    throw new Error('runFirstWorkingPlan called with no plans')
  }
  let last: LaunchOutcome | null = null
  for (const [index, plan] of plans.entries()) {
    const isLast = index === plans.length - 1
    try {
      for (const launch of plan.launches) {
        await spawnFn(launch.exe, launch.args)
      }
      return { ok: true, plan }
    } catch (err) {
      const failure: LaunchOutcome = { ok: false, plan, error: (err as Error).message }
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || isLast) return failure
      last = failure
    }
  }
  // Unreachable: the final iteration always returns.
  return last as LaunchOutcome
}
