import WebSocket from 'ws'

interface Message {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
}

const endpoint = process.argv[2]
const threadId = process.argv[3]
const readOnly = process.argv[4] === 'read'
const listModels = process.argv[4] === 'models'

if (!endpoint || !threadId) {
  throw new Error('Usage: liveCodexInlineTest <ws-endpoint> <thread-id>')
}

const socket = new WebSocket(endpoint)
let nextId = 1
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()

function request(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
  })
}

const finished = new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error('Timed out waiting for the inline answer')),
    120_000
  )

  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Message
    if (typeof message.id === 'number' && !message.method) {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message || 'Request failed'))
      else waiter.resolve(message.result)
      return
    }
    if (message.method === 'item/tool/requestUserInput') {
      console.log('CODEX_INLINE_QUESTION_SENT')
      return
    }
    if (message.method === 'serverRequest/resolved') {
      console.log('CODEX_INLINE_ANSWER_RESOLVED')
      return
    }
    if (message.method?.toLowerCase().includes('error')) {
      console.log(message.method, JSON.stringify(message.params))
    }
    if (
      message.method === 'turn/completed' &&
      message.params?.threadId === threadId
    ) {
      clearTimeout(timeout)
      console.log(JSON.stringify(message.params))
      console.log('CODEX_INLINE_TURN_COMPLETED')
      resolve()
    }
  })
  socket.once('error', reject)
  socket.once('close', () => {
    if (pending.size > 0) reject(new Error('App Server disconnected'))
  })
})

socket.once('open', async () => {
  try {
    await request('initialize', {
      clientInfo: {
        name: 'notch-live-test',
        title: 'Notch live inline test',
        version: '0.1.0'
      },
      capabilities: { experimentalApi: true }
    })
    socket.send(JSON.stringify({ method: 'initialized', params: {} }))
    await request('thread/resume', { threadId })
    if (listModels) {
      const models = await request('model/list', {})
      console.log(JSON.stringify(models, null, 2))
      process.exit(0)
    }
    if (readOnly) {
      const thread = await request('thread/read', { threadId, includeTurns: true })
      console.log(JSON.stringify(thread, null, 2))
      process.exit(0)
    }
    await request('turn/start', {
      threadId,
      input: [{
        type: 'text',
        text: 'Before doing anything else, use request_user_input to ask exactly one question. Use id "live_test", header "Live test", and question "Did this Codex question appear inside the Notch dropdown?" Provide options "Yes - it appeared" (description: "The notch expanded and showed this question") and "No - it did not" (description: "No inline question appeared"). After the answer arrives, respond with exactly "INLINE_TEST_RESULT: " followed by the selected answer, then stop.'
      }],
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'gpt-5.4',
          reasoning_effort: 'high',
          developer_instructions: null
        }
      }
    })
  } catch (error) {
    console.error(error)
    process.exitCode = 1
    socket.close()
  }
})

finished
  .then(() => socket.close())
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
    socket.close()
  })
