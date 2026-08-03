/**
 * Enough of `electron` to let a plain node script import modules from
 * `src/main` and exercise their pure geometry. Anything that actually talks to
 * the platform throws rather than pretending to work, so a test that strays out
 * of the pure parts fails loudly instead of asserting against a stub.
 *
 * This surface is wider than any single test needs, and deliberately so.
 * `src/main/platform/index.ts` statically imports BOTH platform trees so there
 * is exactly one `process.platform` decision in the app, which means esbuild
 * links `win32/*` and `darwin/*` into every bundled test that reaches the
 * platform barrel. A missing export here is not a runtime throw — it is
 * `error: No matching export in "scripts/stubs/electron.ts"`, a hard build
 * failure of the test script. Add to this file when a platform module starts
 * importing a new `electron` member.
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

export const app = {
  getPath: () => unsupported('app.getPath'),
  getName: () => unsupported('app.getName'),
  getVersion: () => unsupported('app.getVersion'),
  setName: () => unsupported('app.setName'),
  setPath: () => unsupported('app.setPath'),
  setLoginItemSettings: () => unsupported('app.setLoginItemSettings'),
  getLoginItemSettings: () => unsupported('app.getLoginItemSettings'),
  setAppUserModelId: () => unsupported('app.setAppUserModelId'),
  setActivationPolicy: () => unsupported('app.setActivationPolicy'),
  requestSingleInstanceLock: () => unsupported('app.requestSingleInstanceLock'),
  whenReady: () => unsupported('app.whenReady'),
  quit: () => unsupported('app.quit'),
  exit: () => unsupported('app.exit'),
  relaunch: () => unsupported('app.relaunch'),
  on: () => unsupported('app.on'),
  once: () => unsupported('app.once'),
  isPackaged: false,
  /**
   * Present but always throwing. On macOS this is an object and on Windows it is
   * `undefined`, so platform code must reach it as `app.dock?.hide()`. Defining
   * it here keeps that optional-chaining habit honest under test.
   */
  dock: {
    hide: () => unsupported('app.dock.hide'),
    show: () => unsupported('app.dock.show')
  }
}

export const dialog = {
  showErrorBox: () => unsupported('dialog.showErrorBox'),
  showMessageBox: () => unsupported('dialog.showMessageBox'),
  showMessageBoxSync: () => unsupported('dialog.showMessageBoxSync')
}

export const ipcMain = {
  handle: () => unsupported('ipcMain.handle'),
  removeHandler: () => unsupported('ipcMain.removeHandler'),
  on: () => unsupported('ipcMain.on'),
  once: () => unsupported('ipcMain.once')
}

export const nativeTheme = {
  shouldUseDarkColors: false,
  on: () => unsupported('nativeTheme.on'),
  removeListener: () => unsupported('nativeTheme.removeListener')
}

export const nativeImage = {
  createEmpty: () => unsupported('nativeImage.createEmpty'),
  createFromBitmap: () => unsupported('nativeImage.createFromBitmap'),
  createFromBuffer: () => unsupported('nativeImage.createFromBuffer'),
  createFromPath: () => unsupported('nativeImage.createFromPath'),
  createFromDataURL: () => unsupported('nativeImage.createFromDataURL')
}

export const session = {
  defaultSession: {
    setPermissionRequestHandler: () => unsupported('session.setPermissionRequestHandler')
  },
  fromPartition: () => unsupported('session.fromPartition')
}

export class Tray {
  constructor() {
    unsupported('Tray')
  }
}

export class Menu {
  static buildFromTemplate(): never {
    return unsupported('Menu.buildFromTemplate')
  }

  static setApplicationMenu(): never {
    return unsupported('Menu.setApplicationMenu')
  }
}
