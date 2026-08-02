export type AgentKind = 'claude' | 'codex' | 'claude-design'
export type SessionStatus = 'working' | 'idle' | 'needs-input' | 'reviewing'

export interface SessionSummary {
  key: string
  agent: AgentKind
  name: string
  project: string
  path: string
  status: SessionStatus
  detail: string
  updatedAt: number
  canMessage: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'agent' | 'system'
  text: string
  createdAt: number
  pending?: boolean
}

export interface ProjectOption {
  path: string
  name: string
}

export interface Snapshot {
  computerName: string
  connected: boolean
  sessions: SessionSummary[]
  projects: ProjectOption[]
}

export interface BridgeStatus {
  computerName: string
  authenticated: boolean
  requiresPairing: boolean
}

export interface DispatchInput {
  agent: AgentKind
  cwd: string
  prompt: string
}

export interface Bridge {
  getStatus(): Promise<BridgeStatus>
  pair(code: string, deviceName: string): Promise<void>
  getSnapshot(): Promise<Snapshot>
  getMessages(key: string): Promise<ChatMessage[]>
  sendMessage(key: string, text: string): Promise<ChatMessage>
  dispatch(input: DispatchInput): Promise<SessionSummary>
  subscribe(onSnapshot: (snapshot: Snapshot) => void): () => void
}
