import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentKind,
  Bridge,
  BridgeStatus,
  ChatMessage,
  DispatchInput,
  SessionStatus,
  SessionSummary,
  Snapshot
} from './types'
import { BridgeHttpError } from './remoteBridge'

interface AppProps {
  bridge: Bridge
}

const statusCopy: Record<SessionStatus, string> = {
  working: 'Working',
  idle: 'Done',
  'needs-input': 'Needs you',
  reviewing: 'Reviewing'
}

const AGENT_GLYPHS: Record<AgentKind, string> = {
  claude: 'C',
  codex: 'X',
  'claude-design': 'D'
}

function AgentGlyph({ agent }: { agent: AgentKind }): React.JSX.Element {
  return <span className={`agent-glyph ${agent}`}>{AGENT_GLYPHS[agent] ?? '?'}</span>
}

function timeAgo(timestamp: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

function SessionCard({
  session,
  onOpen
}: {
  session: SessionSummary
  onOpen: (session: SessionSummary) => void
}): React.JSX.Element {
  return (
    <button className="session-card" type="button" onClick={() => onOpen(session)}>
      <div className="session-card-top">
        <AgentGlyph agent={session.agent} />
        <div className="session-title-wrap">
          <strong>{session.name}</strong>
          <span>{session.project}</span>
        </div>
        <span className="session-time">{timeAgo(session.updatedAt)}</span>
      </div>
      <p>{session.detail}</p>
      <div className="session-card-bottom">
        <span className={`status-label ${session.status}`}>
          <i />
          {statusCopy[session.status]}
        </span>
        <span className="open-label">Open <span aria-hidden="true">›</span></span>
      </div>
    </button>
  )
}

function Conversation({
  bridge,
  session,
  onBack
}: {
  bridge: Bridge
  session: SessionSummary
  onBack: () => void
}): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [loadingMessages, setLoadingMessages] = useState(true)

  useEffect(() => {
    setLoadingMessages(true)
    void bridge
      .getMessages(session.key)
      .then(setMessages)
      .catch((error: unknown) => {
        setSendError(error instanceof Error ? error.message : 'Transcript could not be loaded.')
      })
      .finally(() => setLoadingMessages(false))
  }, [bridge, session.key])

  const canSend = session.canMessage && session.status === 'idle'

  const send = async (): Promise<void> => {
    const value = text.trim()
    if (!value || sending || !canSend) return
    setText('')
    setSending(true)
    setSendError('')
    try {
      const message = await bridge.sendMessage(session.key, value)
      setMessages((current) => [...current, message])
    } catch (error) {
      setText(value)
      setSendError(error instanceof Error ? error.message : 'Message could not be sent.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="screen conversation-screen">
      <header className="conversation-header">
        <button className="icon-button" type="button" aria-label="Back to sessions" onClick={onBack}>
          ←
        </button>
        <div>
          <strong>{session.name}</strong>
          <span className={`status-label ${session.status}`}>
            <i />
            {statusCopy[session.status]}
          </span>
        </div>
        <AgentGlyph agent={session.agent} />
      </header>

      <main className="messages" aria-live="polite">
        <div className="conversation-context">
          <span>{session.project}</span>
          <small>{session.path}</small>
        </div>
        {messages.map((message) => (
          <article key={message.id} className={`message ${message.role}`}>
            <span>{message.role === 'agent' ? session.agent : message.role}</span>
            <p>{message.text}</p>
            <time>{timeAgo(message.createdAt)}</time>
          </article>
        ))}
        {loadingMessages && <div className="read-only-note">Loading recent messages…</div>}
        {!loadingMessages && messages.length === 0 && (
          <div className="read-only-note">No recent transcript messages are available.</div>
        )}
        {!session.canMessage && (
          <div className="read-only-note">
            This terminal wasn’t started by Notch, so it’s available read-only.
          </div>
        )}
      </main>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <textarea
          aria-label="Message agent"
          placeholder={
            !session.canMessage
              ? 'Read-only session'
              : session.status !== 'idle'
                ? 'Wait until the agent is done'
                : 'Message your agent…'
          }
          rows={1}
          value={text}
          disabled={!canSend}
          onChange={(event) => setText(event.target.value)}
        />
        {sendError && <div className="composer-error">{sendError}</div>}
        <button
          type="submit"
          aria-label="Send message"
          disabled={!canSend || !text.trim() || sending}
        >
          ↑
        </button>
      </form>
    </div>
  )
}

function ProjectListbox({
  projects,
  value,
  onChange
}: {
  projects: Snapshot['projects']
  value: string
  onChange: (path: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(Math.max(0, projects.findIndex((project) => project.path === value)))
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const selected = projects.find((project) => project.path === value)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [open])

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus()
  }, [activeIndex, open])

  const close = (): void => {
    setOpen(false)
    window.setTimeout(() => triggerRef.current?.focus(), 0)
  }

  const choose = (index: number): void => {
    const project = projects[index]
    if (!project) return
    onChange(project.path)
    close()
  }

  return (
    <div className={`mobile-listbox ${open ? 'open' : ''}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="mobile-listbox-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="mobile-project-list"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
            event.preventDefault()
            const selectedIndex = Math.max(0, projects.findIndex((project) => project.path === value))
            const next = event.key === 'Home' ? 0
              : event.key === 'End' ? projects.length - 1
                : event.key === 'ArrowDown' ? Math.min(projects.length - 1, selectedIndex + 1)
                  : Math.max(0, selectedIndex - 1)
            setActiveIndex(next)
            setOpen(true)
          }
          if (event.key === 'Escape') setOpen(false)
        }}
      >
        <span><i /><strong>{selected?.name ?? 'Choose a project'}</strong><small>{selected?.path ?? ''}</small></span>
        <b className="chevron" />
      </button>
      {open && (
        <div id="mobile-project-list" className="mobile-listbox-options" role="listbox">
          {projects.map((project, index) => (
            <button
              key={project.path}
              ref={(element) => { optionRefs.current[index] = element }}
              type="button"
              role="option"
              aria-selected={project.path === value}
              tabIndex={index === activeIndex ? 0 : -1}
              className={index === activeIndex ? 'active' : ''}
              onClick={() => choose(index)}
              onMouseEnter={() => setActiveIndex(index)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
                  event.preventDefault()
                  const next = event.key === 'Home' ? 0
                    : event.key === 'End' ? projects.length - 1
                      : event.key === 'ArrowDown' ? Math.min(projects.length - 1, index + 1)
                        : Math.max(0, index - 1)
                  setActiveIndex(next)
                } else if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  choose(index)
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  close()
                }
              }}
            >
              <span><i /><strong>{project.name}</strong><small>{project.path}</small></span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function NewTaskSheet({
  snapshot,
  bridge,
  onClose,
  onCreated
}: {
  snapshot: Snapshot
  bridge: Bridge
  onClose: () => void
  onCreated: (session: SessionSummary) => void
}): React.JSX.Element {
  const [agent, setAgent] = useState<AgentKind>('claude')
  const [cwd, setCwd] = useState(snapshot.projects[0]?.path ?? '')
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [dispatchError, setDispatchError] = useState('')

  const dispatch = async (): Promise<void> => {
    if (!cwd || !prompt.trim() || sending) return
    setSending(true)
    setDispatchError('')
    try {
      const input: DispatchInput = { agent, cwd, prompt: prompt.trim() }
      const session = await bridge.dispatch(input)
      onCreated(session)
    } catch (error) {
      setDispatchError(error instanceof Error ? error.message : 'The task could not be started.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sheet-handle" />
        <div className="sheet-title-row">
          <div>
            <span className="eyebrow">Your computer</span>
            <h2 id="new-task-title">Start a new task</h2>
          </div>
          <button className="close-button" type="button" aria-label="Close new task" onClick={onClose}>
            ×
          </button>
        </div>

        <label className="field">
          <span>Agent</span>
          <div className="agent-choice">
            {(['claude', 'codex'] as AgentKind[]).map((item) => (
              <button
                key={item}
                type="button"
                className={agent === item ? 'active' : ''}
                onClick={() => setAgent(item)}
              >
                <AgentGlyph agent={item} />
                {item === 'claude' ? 'Claude' : 'Codex'}
              </button>
            ))}
          </div>
        </label>

        <div className="field">
          <span>Project</span>
          <ProjectListbox projects={snapshot.projects} value={cwd} onChange={setCwd} />
        </div>

        <label className="field">
          <span>What should it do?</span>
          <textarea
            rows={5}
            placeholder="Fix the flaky checkout test and explain the cause."
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>

        <button
          className="primary-button"
          type="button"
          disabled={!cwd || !prompt.trim() || sending}
          onClick={() => void dispatch()}
        >
          {sending ? 'Starting…' : 'Start on computer'}
        </button>
        {dispatchError && <div className="sheet-error">{dispatchError}</div>}
      </section>
    </div>
  )
}

function PairingScreen({
  bridge,
  status,
  onPaired
}: {
  bridge: Bridge
  status: BridgeStatus
  onPaired: () => void
}): React.JSX.Element {
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState('My phone')
  const [pairing, setPairing] = useState(false)
  const [error, setError] = useState('')

  const pair = async (): Promise<void> => {
    if (code.replace(/\D/g, '').length !== 6 || pairing) return
    setPairing(true)
    setError('')
    try {
      await bridge.pair(code, deviceName)
      onPaired()
    } catch (pairError) {
      setError(pairError instanceof Error ? pairError.message : 'Pairing failed.')
    } finally {
      setPairing(false)
    }
  }

  return (
    <main className="pairing-screen">
      <div className="pairing-card">
        <div className="brand-mark"><i /></div>
        <span className="eyebrow">Secure connection</span>
        <h1>Pair with {status.computerName}</h1>
        <p>
          Open Settings in Notch and enter the six-digit phone companion code.
        </p>
        <label className="field">
          <span>Pairing code</span>
          <span className="pairing-code-control">
            {Array.from({ length: 6 }, (_, index) => (
              <i key={index} className={index === code.length ? 'active' : ''}>{code[index] ?? ''}</i>
            ))}
            <input
              aria-label="Six digit pairing code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </span>
        </label>
        <label className="field">
          <span>Device name</span>
          <input
            value={deviceName}
            maxLength={80}
            onChange={(event) => setDeviceName(event.target.value)}
          />
        </label>
        <button
          className="primary-button"
          type="button"
          disabled={code.length !== 6 || pairing}
          onClick={() => void pair()}
        >
          {pairing ? 'Pairing…' : 'Pair phone'}
        </button>
        {error && <div className="pairing-error">{error}</div>}
        <p className="pairing-security">
          Codes expire after ten minutes. This phone stores only a one-way pairing credential.
        </p>
      </div>
    </main>
  )
}

export function App({ bridge }: AppProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null)
  const [connectionError, setConnectionError] = useState('')
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const [selected, setSelected] = useState<SessionSummary | null>(null)
  const [showNewTask, setShowNewTask] = useState(false)
  const [filter, setFilter] = useState<'all' | 'active' | 'done'>('all')

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    let cancelled = false
    void (async () => {
      try {
        setConnectionError('')
        const status = await bridge.getStatus()
        if (cancelled) return
        setBridgeStatus(status)
        if (status.requiresPairing) return
        const next = await bridge.getSnapshot()
        if (cancelled) return
        setSnapshot(next)
        unsubscribe = bridge.subscribe(setSnapshot)
      } catch (error) {
        if (cancelled) return
        const unavailable =
          error instanceof BridgeHttpError && error.status === 401
            ? 'This phone needs to be paired again.'
            : error instanceof Error
              ? error.message
              : 'Notch could not be reached.'
        setConnectionError(unavailable)
      }
    })()
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [bridge, connectionAttempt])

  const visibleSessions = useMemo(() => {
    if (!snapshot) return []
    if (filter === 'active') return snapshot.sessions.filter((item) => item.status !== 'idle')
    if (filter === 'done') return snapshot.sessions.filter((item) => item.status === 'idle')
    return snapshot.sessions
  }, [filter, snapshot])

  if (bridgeStatus?.requiresPairing) {
    return (
      <PairingScreen
        bridge={bridge}
        status={bridgeStatus}
        onPaired={() => {
          setBridgeStatus(null)
          setConnectionAttempt((value) => value + 1)
        }}
      />
    )
  }

  if (connectionError) {
    return (
      <main className="connection-screen">
        <div className="brand-mark"><i /></div>
        <h1>Can’t reach Notch</h1>
        <p>{connectionError}</p>
        <button
          className="primary-button"
          type="button"
          onClick={() => setConnectionAttempt((value) => value + 1)}
        >
          Try again
        </button>
        <a href="/?demo=1">Open demo instead</a>
      </main>
    )
  }

  if (!snapshot) {
    return (
      <main className="loading-screen">
        <div className="brand-mark"><i /></div>
        <p>Finding your computer…</p>
      </main>
    )
  }

  const currentSelected = selected
    ? snapshot.sessions.find((session) => session.key === selected.key) ?? selected
    : null

  if (currentSelected) {
    return (
      <Conversation
        bridge={bridge}
        session={currentSelected}
        onBack={() => setSelected(null)}
      />
    )
  }

  const working = snapshot.sessions.filter((item) => item.status === 'working').length
  const needsYou = snapshot.sessions.filter((item) => item.status === 'needs-input').length
  const summary = needsYou
    ? `${needsYou} agent${needsYou === 1 ? '' : 's'} waiting for you`
    : working
      ? `${working} agent${working === 1 ? '' : 's'} working`
      : 'Everything is caught up'

  return (
    <div className="screen home-screen">
      <header className="home-header">
        <div className="brand-row">
          <div className="brand-mark"><i /></div>
          <strong>Notch</strong>
          <span className={`connection ${snapshot.connected ? 'online' : ''}`}>
            {snapshot.connected ? 'Connected' : 'Offline'}
          </span>
        </div>
        <span className="computer-name">{snapshot.computerName}</span>
      </header>

      <main className="home-content">
        <section className={`overview ${needsYou ? 'urgent' : ''}`}>
          <span className="eyebrow">Right now</span>
          <h1>{summary}</h1>
          <div className="overview-counts">
            <span><i className="working-dot" />{working} working</span>
            <span><i className="needs-dot" />{needsYou} need you</span>
            <span>{snapshot.sessions.length} total</span>
          </div>
        </section>

        <div className="section-title">
          <h2>Agents</h2>
          <button type="button" onClick={() => setShowNewTask(true)}>+ New task</button>
        </div>

        <div className="filters" aria-label="Filter sessions">
          {(['all', 'active', 'done'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={filter === item ? 'active' : ''}
              onClick={() => setFilter(item)}
            >
              {item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </div>

        <section className="session-list">
          {visibleSessions.map((session) => (
            <SessionCard key={session.key} session={session} onOpen={setSelected} />
          ))}
          {visibleSessions.length === 0 && (
            <div className="empty-state">No agents in this view.</div>
          )}
        </section>
      </main>

      <nav className="bottom-nav" aria-label="Primary">
        <button className="active" type="button"><span>●</span>Agents</button>
        <button type="button" onClick={() => setShowNewTask(true)}><span>＋</span>Dispatch</button>
        <button type="button" disabled><span>⚙</span>Settings</button>
      </nav>

      {showNewTask && (
        <NewTaskSheet
          snapshot={snapshot}
          bridge={bridge}
          onClose={() => setShowNewTask(false)}
          onCreated={(session) => {
            setShowNewTask(false)
            if (session.canMessage) setSelected(session)
          }}
        />
      )}
    </div>
  )
}
