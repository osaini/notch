import { DEFAULT_PORT } from '../src/main/hookServer'
import { getHookStatus, installHooks, uninstallHooks } from '../src/main/hookInstaller'

async function main(): Promise<void> {
  const action = process.argv[2] ?? 'status'
  if (!['install', 'uninstall', 'status'].includes(action)) {
    throw new Error(`Unknown hook action "${action}". Expected install, uninstall, or status.`)
  }
  const current = await getHookStatus()
  const result =
    action === 'install'
      // Preserve a live listener's fallback port. Startup repairs this again,
      // but the standalone command must not break hooks until that restart.
      ? await installHooks(current.port ?? DEFAULT_PORT)
      : action === 'uninstall'
        ? await uninstallHooks()
        : current
  console.log(JSON.stringify(result, null, 2))
  if (result.error) process.exitCode = 1
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
