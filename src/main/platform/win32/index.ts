import type { PlatformIntegration } from '../types'
import { autostart } from './autostart'
import { designWindows } from './designWindows'
import { focus } from './focus'
import { overlay } from './overlay'
import { paths } from './paths'
import { processes } from './processes'
import { terminal } from './terminal'
import { tray } from './tray'

/**
 * No top-level side effects in this module or anything it imports. Both platform
 * trees are statically linked into every build and every bundled test, so their
 * module bodies run on the wrong OS as a matter of course — see `../index.ts`.
 */
export const win32Platform: PlatformIntegration = {
  os: 'win32',
  focus,
  designWindows,
  processes,
  terminal,
  autostart,
  overlay,
  tray,
  paths,
  info: {
    os: 'win32',
    terminalLabel: terminal.primaryLabel,
    relaunchHint: 'from the Start menu',
    features: {
      focusWindows: true,
      designWindows: designWindows.supported,
      splitPane: terminal.supportsSplitPane
    }
  }
}
