/**
 * Dispatches electron-builder's single `afterPack` hook per platform.
 *
 * electron-builder only accepts one afterPack entry, and each platform needs a
 * different fixup, so the branch lives here rather than inside either script.
 * Both targets early-return on the wrong platform anyway, but keeping the
 * dispatch explicit means adding a third platform does not mean editing them.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') {
    return require('./stampExecutableIcon.cjs')(context)
  }
  if (context.electronPlatformName === 'darwin') {
    return require('./adhocSignMac.cjs')(context)
  }
}
