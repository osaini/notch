/**
 * Enough of `electron` to let a plain node script import modules from
 * `src/main` and exercise their pure geometry. Anything that actually talks to
 * the platform throws rather than pretending to work, so a test that strays out
 * of the pure parts fails loudly instead of asserting against a stub.
 */
function unsupported(name: string): never {
  throw new Error(`electron stub: ${name} is not available outside electron`)
}

export class BrowserWindow {
  constructor() {
    unsupported('BrowserWindow')
  }
}

export const screen = {
  getPrimaryDisplay: () => unsupported('screen.getPrimaryDisplay'),
  getAllDisplays: () => unsupported('screen.getAllDisplays'),
  getCursorScreenPoint: () => unsupported('screen.getCursorScreenPoint'),
  getDisplayNearestPoint: () => unsupported('screen.getDisplayNearestPoint'),
  on: () => unsupported('screen.on'),
  removeListener: () => unsupported('screen.removeListener')
}

export const shell = {
  openExternal: () => unsupported('shell.openExternal'),
  showItemInFolder: () => unsupported('shell.showItemInFolder')
}
