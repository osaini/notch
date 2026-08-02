import { ManagedCodexService } from '../src/main/managedCodex'

async function main(): Promise<void> {
  const service = new ManagedCodexService()
  try {
    await service.start()
    const state = service.getState()
    if (!state.available || !state.experimentalApi || !state.requestUserInput) {
      throw new Error(`Unexpected managed Codex state: ${JSON.stringify(state)}`)
    }
    console.log(`Managed Codex ready at ${state.endpoint}`)
  } finally {
    service.stop()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
