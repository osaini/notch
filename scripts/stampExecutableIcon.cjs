const { copyFile, readFile, unlink, writeFile } = require('node:fs/promises')
const path = require('node:path')

/**
 * Electron Builder normally stamps the Windows icon through rcedit. That path
 * is disabled in this project because its tool archive requires symlink
 * privileges to extract on Windows. ResEdit performs the same icon replacement
 * in JavaScript, so packaging stays usable without Developer Mode or elevation.
 */
module.exports = async function stampExecutableIcon(context) {
  if (context.electronPlatformName !== 'win32') return

  const ResEdit = await import('resedit')
  const executablePath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`
  )
  const iconPath = path.join(context.packager.projectDir, 'build', 'icon.ico')
  const temporaryPath = `${executablePath}.icon-stamped`

  const executable = ResEdit.NtExecutable.from(await readFile(executablePath), {
    ignoreCert: true
  })
  const resources = ResEdit.NtExecutableResource.from(executable)
  const iconFile = ResEdit.Data.IconFile.from(await readFile(iconPath))
  const iconData = iconFile.icons.map((item) => item.data)
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)
  const targets = groups.length > 0 ? groups : [{ id: 101, lang: 1033 }]

  for (const target of targets) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries,
      target.id,
      target.lang,
      iconData
    )
  }

  // signAndEditExecutable is disabled above, so electron-builder never gets a
  // chance to replace Electron's stock VERSIONINFO block. Keep Explorer,
  // Task Manager, crash reports, and shortcut properties aligned with the app.
  const appInfo = context.packager.appInfo
  const filename = `${appInfo.productFilename}.exe`
  const version = appInfo.getVersionInWeirdWindowsForm()
  const language = { lang: 1033, codepage: 1200 }
  let versionInfos = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)
  if (versionInfos.length === 0) {
    versionInfos = [
      ResEdit.Resource.VersionInfo.create({
        lang: language.lang,
        fixedInfo: {},
        strings: []
      })
    ]
  }
  for (const versionInfo of versionInfos) {
    versionInfo.setFileVersion(version, language.lang)
    versionInfo.setProductVersion(version, language.lang)
    versionInfo.setStringValues(language, {
      CompanyName: appInfo.companyName ?? 'Oaj Saini',
      FileDescription: appInfo.description,
      InternalName: filename,
      LegalCopyright: appInfo.copyright,
      OriginalFilename: filename,
      ProductName: appInfo.productName
    })
    versionInfo.outputToResourceEntries(resources.entries)
  }

  resources.outputResource(executable)
  await writeFile(temporaryPath, Buffer.from(executable.generate()))
  try {
    await copyFile(temporaryPath, executablePath)
  } finally {
    await unlink(temporaryPath).catch(() => {})
  }
}
