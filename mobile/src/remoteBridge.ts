import type {
  Bridge,
  BridgeStatus,
  ChatMessage,
  DispatchInput,
  SessionSummary,
  Snapshot
} from './types'

export class BridgeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...init?.headers
    }
  })
  if (!response.ok) {
    let message = `Notch bridge returned ${response.status}`
    try {
      const body = await response.json() as { error?: string }
      if (body.error) message = body.error
    } catch {
      // Keep the status-based fallback.
    }
    throw new BridgeHttpError(response.status, message)
  }
  return response.json() as Promise<T>
}

export class RemoteBridge implements Bridge {
  getStatus(): Promise<BridgeStatus> {
    return request('/status')
  }

  async pair(code: string, deviceName: string): Promise<void> {
    await request('/pair', {
      method: 'POST',
      body: JSON.stringify({ code, deviceName })
    })
  }

  getSnapshot(): Promise<Snapshot> {
    return request('/snapshot')
  }

  getMessages(key: string): Promise<ChatMessage[]> {
    return request(`/sessions/${encodeURIComponent(key)}/messages`)
  }

  sendMessage(key: string, text: string): Promise<ChatMessage> {
    return request(`/sessions/${encodeURIComponent(key)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text })
    })
  }

  dispatch(input: DispatchInput): Promise<SessionSummary> {
    return request('/dispatch', {
      method: 'POST',
      body: JSON.stringify(input)
    })
  }

  subscribe(onSnapshot: (snapshot: Snapshot) => void): () => void {
    const events = new EventSource('/api/v1/events')
    const listener = (event: MessageEvent<string>): void => {
      onSnapshot(JSON.parse(event.data) as Snapshot)
    }
    events.addEventListener('snapshot', listener as EventListener)
    events.addEventListener('error', () => {
      // EventSource reconnects automatically. The next successful snapshot
      // replaces any stale UI state.
    })
    return () => events.close()
  }
}
