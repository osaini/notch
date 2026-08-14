import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PORT, hookUrl } from '../src/main/hookServer'
import { getHookStatus, getInstalledHookToken } from '../src/main/hookInstaller'

const STEP_PAUSE_MS = 1700
/** Resolved from the installed hooks, which carry the running app's secret. */
let hookEndpoint = ''

async function resolveHookEndpoint(): Promise<string> {
  const [status, token] = await Promise.all([getHookStatus(), getInstalledHookToken()])
  if (!token) {
    throw new Error(
      'No Notch hook token found in settings.json. Run `npm run hooks:install` first.'
    )
  }
  return hookUrl(status.port ?? DEFAULT_PORT, token)
}

function pause(duration = STEP_PAUSE_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, duration))
}

async function postHook(sessionId: string, hookEventName: string): Promise<void> {
  const response = await fetch(hookEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hook_event_name: hookEventName,
      session_id: sessionId,
      cwd: process.cwd(),
      message: 'Status flash demo'
    })
  })
  if (!response.ok) {
    throw new Error(`Hook endpoint returned HTTP ${response.status}`)
  }
}

async function main(): Promise<void> {
  hookEndpoint = await resolveHookEndpoint()
  const sleeper = spawn(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 60000)'],
    { stdio: 'ignore', windowsHide: true }
  )
  if (!sleeper.pid) throw new Error('Could not start the disposable demo process')

  const sessionId = `notch-status-flash-demo-${sleeper.pid}`
  const sessionsDir = path.join(os.homedir(), '.claude', 'sessions')
  const sessionFile = path.join(sessionsDir, `${sleeper.pid}.json`)
  const startedAt = Date.now()
  const writeStatus = async (status: 'idle' | 'busy'): Promise<void> => {
    const updatedAt = Date.now()
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        pid: sleeper.pid,
        sessionId,
        cwd: process.cwd(),
        name: 'Status flash demo',
        kind: 'interactive',
        status,
        startedAt,
        updatedAt,
        statusUpdatedAt: updatedAt
      })
    )
  }

  try {
    await fs.mkdir(sessionsDir, { recursive: true })
    console.log('Demo: GREEN — new idle agent')
    await writeStatus('idle')
    await pause(2300)

    console.log('Demo: YELLOW — agent starts working')
    await writeStatus('busy')
    await pause()

    console.log('Demo: RED — agent needs input')
    await postHook(sessionId, 'Notification')
    await pause()

    console.log('Demo: BLUE — agent enters review')
    await postHook(sessionId, 'Stop')
    await pause()

    console.log('Demo: GREEN — agent returns idle')
    await writeStatus('idle')
    await pause()
  } finally {
    await fs.rm(sessionFile, { force: true })
    sleeper.kill()
    console.log('Demo cleanup complete.')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
