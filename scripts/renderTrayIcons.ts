import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { NotchColor } from '../src/shared/types'
import { trayImage } from '../src/main/tray'

const colors: NotchColor[] = ['green', 'yellow', 'red', 'blue', 'grey']

app.whenReady().then(() => {
  const output = join(__dirname, 'tray-icon-previews')
  mkdirSync(output, { recursive: true })
  for (const color of colors) {
    const image = trayImage(color)
    const png = image.toPNG()
    if (image.isEmpty() || png.length === 0) {
      throw new Error(`Tray image for ${color} is empty`)
    }
    writeFileSync(join(output, `${color}.png`), png)
    console.log(`${color}: ${image.getSize().width}x${image.getSize().height}, ${png.length} bytes`)
  }
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
