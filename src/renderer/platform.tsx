import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { PlatformInfo } from '@shared/types'

/**
 * Host OS copy and feature flags, fetched once.
 *
 * Ambient rather than a prop because it never changes for the life of the
 * process and three unrelated tabs need it. `null` until the first IPC round
 * trip resolves, so consumers must render something sensible without it rather
 * than assuming a platform — that assumption is exactly what this replaces.
 */
const PlatformContext = createContext<PlatformInfo | null>(null)

export function PlatformProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [info, setInfo] = useState<PlatformInfo | null>(null)

  useEffect(() => {
    let live = true
    void window.notch.getPlatformInfo().then((next) => {
      if (live) setInfo(next)
    })
    return () => {
      live = false
    }
  }, [])

  return <PlatformContext.Provider value={info}>{children}</PlatformContext.Provider>
}

export function usePlatform(): PlatformInfo | null {
  return useContext(PlatformContext)
}
