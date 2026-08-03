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
 * No top-level side effects in this module or anything it imports. This tree is
 * statically linked into the Windows build too, and its module bodies run there
 * — see `../index.ts` for why the imports are static.
 */
export const darwinPlatform: PlatformIntegration = {
  os: 'darwin',
  focus,
  designWindows,
  processes,
  terminal,
  autostart,
  overlay,
  tray,
  paths,
  info: {
    os: 'darwin',
    terminalLabel: terminal.primaryLabel,
    relaunchHint: 'from Applications',
    features: {
      // Both false until the corresponding stub is implemented. The renderer
      // hides the affordances rather than offering something that cannot work.
      focusWindows: false,
      designWindows: designWindows.supported,
      splitPane: terminal.supportsSplitPane
    }
  }
}
