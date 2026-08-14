import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const edge =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const targetUrl = process.env.NOTCH_MOBILE_URL ?? 'http://127.0.0.1:4174'
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-mobile-edge-'))
const outputDir = path.resolve('mobile', 'artifacts')

await fs.mkdir(outputDir, { recursive: true })

let browser
let socket

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function pageTarget() {
  let port
  for (let attempt = 0; attempt < 100; attempt++) {
    if (browser?.exitCode !== null) throw new Error('Mobile verification browser exited during startup')
    try {
      if (!port) {
        const activePort = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')
        const parsed = Number.parseInt(activePort.split(/\r?\n/, 1)[0], 10)
        if (Number.isInteger(parsed) && parsed > 0) port = parsed
      }
      if (!port) throw new Error('DevTools port is not ready')
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      // Edge is still starting.
    }
    await delay(100)
  }
  throw new Error('Timed out connecting to the mobile verification browser')
}

let nextId = 0
const pending = new Map()
function command(method, params = {}) {
  const id = ++nextId
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? 'Page evaluation failed')
  }
  return result.result.value
}

async function screenshot(name) {
  const result = await command('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false
  })
  await fs.writeFile(path.join(outputDir, name), Buffer.from(result.data, 'base64'))
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

try {
  browser = spawn(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--window-size=390,844',
      targetUrl
    ],
    { stdio: 'ignore', windowsHide: true }
  )
  const spawnFailure = new Promise((_, reject) => {
    browser.once('error', reject)
  })
  const target = await Promise.race([pageTarget(), spawnFailure])
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })

  await command('Page.enable')
  await command('Runtime.enable')
  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true
  })
  await command('Page.navigate', { url: targetUrl })
  await delay(700)

  const initialText = await evaluate('document.body.innerText')
  assert(initialText.includes('Notch'), 'Dashboard brand did not render')
  assert(initialText.includes('Agents'), 'Dashboard sessions did not render')
  assert(initialText.includes('Needs you'), 'Urgent session state did not render')
  await screenshot('dashboard-390x844.png')

  await evaluate(`
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.includes('Mobile companion'))
      ?.click()
  `)
  await delay(200)
  const composerOpen = await evaluate(
    'document.querySelector(\'textarea[aria-label="Message agent"]\') !== null'
  )
  assert(composerOpen, 'Conversation composer did not open')

  await evaluate(`
    (() => {
      const input = document.querySelector('textarea[aria-label="Message agent"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, 'Send me a short progress update.')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()
  `)
  await delay(80)
  await evaluate(`document.querySelector('.composer form')?.requestSubmit?.()`)
  await evaluate(`document.querySelector('.composer')?.requestSubmit()`)
  await delay(200)
  const sentText = await evaluate('document.body.innerText')
  assert(sentText.includes('Send me a short progress update.'), 'Message was not added to the thread')
  await screenshot('conversation-390x844.png')

  await evaluate(`document.querySelector('button[aria-label="Back to sessions"]')?.click()`)
  await delay(150)
  await evaluate(`
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '+ New task')
      ?.click()
  `)
  await delay(150)
  const sheetText = await evaluate('document.body.innerText')
  assert(sheetText.includes('Start a new task'), 'Dispatch sheet did not open')
  assert(sheetText.includes('Claude') && sheetText.includes('Codex'), 'Agent picker did not render')

  console.log('Mobile verification passed: dashboard, conversation, message send, and dispatch sheet.')
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      await command('Browser.close')
    } catch {
      browser?.kill()
    }
    socket.close()
  } else {
    browser?.kill()
  }
  if (browser && browser.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => browser.once('exit', resolve)),
      delay(1500)
    ])
    if (browser.exitCode === null) browser.kill()
  }
  if (!profile.startsWith(`${os.tmpdir()}${path.sep}notch-mobile-edge-`)) {
    throw new Error(`Refusing to remove unexpected browser profile: ${profile}`)
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(profile, { recursive: true, force: true })
      break
    } catch (error) {
      if (attempt === 4) throw error
      await delay(200)
    }
  }
}
