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

  resources.outputResource(executable)
  await writeFile(temporaryPath, Buffer.from(executable.generate()))
  try {
    await copyFile(temporaryPath, executablePath)
  } finally {
    await unlink(temporaryPath).catch(() => {})
  }
}
