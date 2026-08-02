import { DEFAULT_PORT } from '../src/main/hookServer'
import { getHookStatus, installHooks, uninstallHooks } from '../src/main/hookInstaller'

async function main(): Promise<void> {
  const action = process.argv[2] ?? 'status'
  const result =
    action === 'install'
      ? await installHooks(DEFAULT_PORT)
      : action === 'uninstall'
        ? await uninstallHooks()
        : await getHookStatus()
  console.log(JSON.stringify(result, null, 2))
}

void main()
