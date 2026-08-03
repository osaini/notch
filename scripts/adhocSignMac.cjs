const { execFile } = require('node:child_process')
const { readdir } = require('node:fs/promises')
const path = require('node:path')
const { promisify } = require('node:util')

const run = promisify(execFile)

/**
 * Ad-hoc signs the macOS bundle.
 *
 * ⚠️ WRITTEN BUT NEVER EXECUTED BY THE AUTHOR — this project is developed on
 * Windows and there is no way to run this here. Treat it as a starting point and
 * verify it first; it is one of the two files most likely to be wrong. See
 * PORTING.md §8.
 *
 * Why it exists at all: this project has no Apple Developer ID, so the app ships
 * unsigned. But arm64 macOS refuses to execute a *wholly* unsigned binary, so
 * "unsigned" in practice has to mean "signed with the ad-hoc identity" (`-`),
 * which asserts no identity and needs no certificate. electron-builder may do
 * this itself when `identity: null`, but that is internal behaviour this project
 * cannot test, so it is done explicitly.
 *
 * An ad-hoc signature carries no notarization ticket, so Gatekeeper still blocks
 * a downloaded copy until the user right-clicks → Open or clears the quarantine
 * attribute. That is expected and documented in the README, not a bug here.
 *
 * Do NOT add hardenedRuntime, entitlements, or notarization: all three require a
 * Developer ID this project does not have.
 */
module.exports = async function adhocSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )

  const sign = async (target) => {
    // `--force` replaces any signature electron-builder already applied.
    // `--timestamp=none` because a trusted timestamp needs a real identity.
    await run('codesign', ['--force', '--sign', '-', '--timestamp=none', target])
  }

  // Inside out: nested code must be signed before the enclosing bundle, or the
  // outer signature seals a hash of something that then changes. This is the
  // modern replacement for the deprecated `--deep`.
  const frameworks = path.join(appPath, 'Contents', 'Frameworks')
  let nested = []
  try {
    nested = await readdir(frameworks)
  } catch {
    // No Frameworks directory is not a failure worth stopping the build for.
  }

  // Helper .app bundles live inside the framework, so sign the deepest first.
  for (const entry of nested.filter((name) => name.endsWith('.app'))) {
    await sign(path.join(frameworks, entry))
  }
  for (const entry of nested.filter((name) => name.endsWith('.framework'))) {
    await sign(path.join(frameworks, entry))
  }
  for (const entry of nested.filter((name) => name.endsWith('.dylib'))) {
    await sign(path.join(frameworks, entry))
  }

  await sign(appPath)

  // Fail the build rather than shipping a bundle that will not launch.
  await run('codesign', ['--verify', '--strict', appPath])
  console.log(`ad-hoc signed ${path.basename(appPath)} (no Developer ID; not notarized)`)
}
