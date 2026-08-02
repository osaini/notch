import type {
  Bridge,
  BridgeStatus,
  ChatMessage,
  DispatchInput,
  SessionSummary,
  Snapshot
} from './types'

const now = Date.now()

const sessions: SessionSummary[] = [
  {
    key: 'claude:windows-notch',
    agent: 'claude',
    name: 'Mobile companion',
    project: 'windows-notch',
    path: 'C:\\Users\\you\\Projects\\windows-notch',
    status: 'working',
    detail: 'Building the mobile dashboard',
    updatedAt: now - 18_000,
    canMessage: true
  },
  {
    key: 'codex:storefront',
    agent: 'codex',
    name: 'Checkout tests',
    project: 'storefront',
    path: 'C:\\Users\\you\\Projects\\storefront',
    status: 'needs-input',
    detail: 'Needs approval to run the test suite',
    updatedAt: now - 72_000,
    canMessage: true
  },
  {
    key: 'claude:docs',
    agent: 'claude',
    name: 'API documentation',
    project: 'platform-docs',
    path: 'C:\\Users\\you\\Projects\\platform-docs',
    status: 'idle',
    detail: 'Finished with 3 files changed',
    updatedAt: now - 9 * 60_000,
    canMessage: false
  }
]

const messages = new Map<string, ChatMessage[]>([
  [
    'claude:windows-notch',
    [
      {
        id: 'm1',
        role: 'user',
        text: 'Build the phone dashboard without touching the desktop feature files.',
        createdAt: now - 13 * 60_000
      },
      {
        id: 'm2',
        role: 'agent',
        text: 'I’ve isolated the PWA in its own folder. I’m wiring the session cards and message composer now.',
        createdAt: now - 4 * 60_000
      }
    ]
  ],
  [
    'codex:storefront',
    [
      {
        id: 'm3',
        role: 'agent',
        text: 'The checkout fix is ready. May I run the full browser test suite?',
        createdAt: now - 72_000
      }
    ]
  ],
  [
    'claude:docs',
    [
      {
        id: 'm4',
        role: 'agent',
        text: 'Documentation is complete. I updated authentication, pagination, and error examples.',
        createdAt: now - 9 * 60_000
      }
    ]
  ]
])

const snapshot: Snapshot = {
  computerName: 'Studio PC',
  connected: true,
  sessions,
  projects: [
    { name: 'windows-notch', path: 'C:\\Users\\you\\Projects\\windows-notch' },
    { name: 'storefront', path: 'C:\\Users\\you\\Projects\\storefront' },
    { name: 'platform-docs', path: 'C:\\Users\\you\\Projects\\platform-docs' }
  ]
}

export class MockBridge implements Bridge {
  private listeners = new Set<(value: Snapshot) => void>()

  async getStatus(): Promise<BridgeStatus> {
    return {
      computerName: snapshot.computerName,
      authenticated: true,
      requiresPairing: false
    }
  }

  async pair(): Promise<void> {
    // Demo mode is already connected.
  }

  async getSnapshot(): Promise<Snapshot> {
    return structuredClone(snapshot)
  }

  async getMessages(key: string): Promise<ChatMessage[]> {
    return structuredClone(messages.get(key) ?? [])
  }

  async sendMessage(key: string, text: string): Promise<ChatMessage> {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text,
      createdAt: Date.now()
    }
    const current = messages.get(key) ?? []
    messages.set(key, [...current, message])

    const session = sessions.find((item) => item.key === key)
    if (session) {
      session.status = 'working'
      session.detail = 'Working on your follow-up'
      session.updatedAt = Date.now()
      this.publish()
    }
    return structuredClone(message)
  }

  async dispatch(input: DispatchInput): Promise<SessionSummary> {
    const project = snapshot.projects.find((item) => item.path === input.cwd)
    const session: SessionSummary = {
      key: `${input.agent}:${crypto.randomUUID()}`,
      agent: input.agent,
      name: input.prompt.length > 34 ? `${input.prompt.slice(0, 34)}…` : input.prompt,
      project: project?.name ?? 'New task',
      path: input.cwd,
      status: 'working',
      detail: 'Starting on your computer',
      updatedAt: Date.now(),
      canMessage: true
    }
    sessions.unshift(session)
    messages.set(session.key, [
      {
        id: crypto.randomUUID(),
        role: 'user',
        text: input.prompt,
        createdAt: Date.now()
      }
    ])
    this.publish()
    return structuredClone(session)
  }

  subscribe(onSnapshot: (value: Snapshot) => void): () => void {
    this.listeners.add(onSnapshot)
    return () => this.listeners.delete(onSnapshot)
  }

  private publish(): void {
    const value = structuredClone(snapshot)
    for (const listener of this.listeners) listener(value)
  }
}
