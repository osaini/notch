import { useEffect, useState } from 'react'
import type {
  HookInstallStatus,
  PendingInteraction,
  SessionState,
  SessionsSnapshot
} from '@shared/types'
import { relativeTime, shortPath } from '../format'
import { usePlatform } from '../platform'

interface Props {
  snapshot: SessionsSnapshot
  hooks: HookInstallStatus | null
  onToggleHooks: () => void
}

const AGENT_LABELS: Record<SessionState['agent'], string> = {
  claude: 'CL',
  codex: 'CX',
  'claude-design': 'CD',
  'claude-cowork': 'CW'
}

function statusText(session: SessionState): string {
  if (session.needsInput) return session.needsInputReason ?? 'Needs input'
  if (session.status === 'reviewing') return 'Reviewing'
  if (session.status === 'busy') return 'Working'
  if (session.agent === 'claude-design') return 'Open'
  if (session.status === 'idle') return 'Idle'
  return session.rawStatus ? `Unknown (${session.rawStatus})` : 'Unknown'
}

function statusClass(session: SessionState): string {
  if (session.needsInput) return 'red'
  if (session.status === 'reviewing') return 'blue'
  if (session.status === 'busy') return 'yellow'
  if (session.status === 'idle') return 'green'
  return 'grey'
}

export function Sessions({ snapshot, hooks, onToggleHooks }: Props): React.JSX.Element {
  const { sessions, error, designError, prunedCount, counts } = snapshot
  const [message, setMessage] = useState<string | null>(null)
  const platformInfo = usePlatform()
  // Absent until the first IPC round trip; assume the feature exists until told
  // otherwise, so the empty-state copy does not flicker on every mount.
  const hasDesignDetection = platformInfo?.features.designWindows ?? true

  return (
    <div className="tab-pane sessions-pane">
      <div className="section-rule">
        <span>Live</span><i />
        <em className="state-runs">
          {counts.needsInput > 0 && <b className="red">{counts.needsInput} needs you</b>}
          {counts.reviewing > 0 && <b className="blue">{counts.reviewing} reviewing</b>}
          {counts.busy > 0 && <b className="yellow">{counts.busy} working</b>}
          {counts.idle > 0 && <b className="green">{counts.idle} idle</b>}
          {counts.total === 0 && <b className="grey">No active sessions</b>}
        </em>
      </div>

      {message && <p className="notice">{message}</p>}
      {error && <p className="notice error">Cannot read session files — {error}</p>}
      {designError && <p className="notice error">{designError}</p>}
      {sessions.length === 0 && !error && (
        <div className="empty">
          <p>No live or recently active agent sessions.</p>
          <p className="muted">
            Claude uses PID session files; Codex uses recent rollout activity
            {hasDesignDetection
              ? '; Claude Design is detected from its Claude Desktop window.'
              : '. Claude Design cannot be detected on this platform.'}
          </p>
        </div>
      )}

      <ul className="session-list">
        {sessions.map((session) => {
          const focusTitle = session.windowHandle
            ? 'Focuses this exact window'
            : 'Best-effort: focuses the host window, not necessarily its tab'
          const focusSession = async (): Promise<void> => {
            const result = await window.notch.focusSession(session.key)
            setMessage(result.message)
          }
          return (
          <li key={session.key} className={`session ${session.status === 'busy' ? 'working' : ''}`}>
            {session.canFocus && (
              <button
                type="button"
                className="session-focus-hitbox"
                aria-label={`Open ${session.name}`}
                title={focusTitle}
                onClick={() => void focusSession()}
              />
            )}
            <span className={`status-gutter ${statusClass(session)}`} />
            <span className={`session-monogram ${session.agent}`}>
              {AGENT_LABELS[session.agent] ?? session.agent}
            </span>
            <div className="session-main">
              <div className="session-title">
                {/* Chat titles are sentences and the row clamps to one line. */}
                <span className="session-name" title={session.name}>
                  {session.name}
                </span>
                {session.kind !== 'interactive' && session.kind !== 'design' && (
                  <span className="tag">{session.kind}</span>
                )}
              </div>
              {session.cwd ? (
                <button
                  type="button"
                  className="session-cwd"
                  title={session.cwd}
                  onClick={() => window.notch.revealPath(session.cwd)}
                >
                  {shortPath(session.cwd)}
                </button>
              ) : (
                <span className="session-cwd muted">{session.location ?? '—'}</span>
              )}
            </div>
            <div className="session-meta">
              <span className={`session-status ${statusClass(session)}`}>{statusText(session)}</span>
              <span className="muted">{relativeTime(session.statusUpdatedAt || session.updatedAt)}</span>
              <div className="session-actions">
                {session.canFocus && (
                  <button
                    type="button"
                    className="mini-link"
                    title={focusTitle}
                    onClick={() => void focusSession()}
                  >
                    Open
                  </button>
                )}
                <button
                  type="button"
                  className="mini-link danger-text"
                  title={session.canTerminate
                    ? 'Ends the session after confirmation; unsaved agent work may be lost.'
                    : 'Hides the row after confirmation; the transcript or window remains.'}
                  onClick={async () => {
                    const verb = session.canTerminate ? 'end' : 'hide'
                    const consequence = session.canTerminate
                      ? 'Unsaved agent work may be lost.'
                      : session.agent === 'claude-design'
                        ? 'The window stays open — this only hides the row.'
                        : 'The transcript will stay on disk.'
                    if (!window.confirm(`Really ${verb} “${session.name}”? ${consequence}`)) return
                    const result = await window.notch.terminateSession(session.key)
                    setMessage(result.message)
                  }}
                >
                  {session.canTerminate ? 'End' : 'Hide'}
                </button>
              </div>
            </div>
            {session.status === 'busy' && <span className="session-shimmer" aria-hidden="true" />}
          </li>
          )
        })}
      </ul>

      <div className="section-rule permission-rule">
        <span>Permission controls</span><i />
        <em className={hooks?.installed ? 'green' : 'grey'}>
          {hooks?.installed ? 'Installed' : 'Not installed'}
        </em>
      </div>
      <div className="permission-summary">
        <div>
          {hooks?.error ? hooks.error : hooks?.installed
            ? `127.0.0.1:${hooks.port ?? '?'}\n${hooks.events.join(' · ')}`
            : 'Local HTTP hooks are not installed.'}
        </div>
        <button type="button" className="btn" onClick={onToggleHooks}>
          {hooks?.installed ? 'Uninstall' : 'Install'}
        </button>
      </div>
      <p className="footnote">
        Backs up <code>settings.json</code> once, then merges only marked entries. Uninstall removes
        only those.
      </p>
      {prunedCount > 0 && <p className="footnote">{prunedCount} stale Claude session file(s) ignored.</p>}
    </div>
  )
}

interface TakeoverProps {
  interaction: PendingInteraction
  queueCount: number
  onDismiss: () => void
  onResponseAccepted: () => void
  onOpenAgent: () => void
}

export function InteractionTakeover({
  interaction,
  queueCount,
  onDismiss,
  onResponseAccepted,
  onOpenAgent
}: TakeoverProps): React.JSX.Element {
  const [answering, setAnswering] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [jsonOpen, setJsonOpen] = useState(false)
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [, setClock] = useState(0)

  useEffect(() => {
    setStep(0)
    setAnswers({})
    setOther({})
    setMessage(null)
  }, [interaction.id])

  useEffect(() => {
    if (!interaction.expiresAt) return
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [interaction.id, interaction.expiresAt])

  const seconds = interaction.expiresAt
    ? Math.max(0, Math.ceil((interaction.expiresAt - Date.now()) / 1000))
    : null
  // Measured from the window currently counting down, not from when the whole
  // card arrived, so the ring restarts full after each per-question reset.
  const duration = interaction.expiresAt
    ? Math.max(1, interaction.expiresAt - (interaction.windowStartedAt ?? interaction.receivedAt))
    : 1
  const progress = interaction.expiresAt
    ? Math.max(
        0,
        Math.min(170, 170 * (1 - (interaction.expiresAt - Date.now()) / duration))
      )
    : 0

  const openAgent = async (): Promise<void> => {
    const result = await window.notch.openInteractionSession(interaction.id)
    if (result.ok) onOpenAgent()
    else setMessage(result.message)
  }

  const respondPermission = async (decision: 'allow' | 'deny'): Promise<void> => {
    setAnswering(true)
    try {
      const accepted = await window.notch.respondToInteraction(interaction.id, {
        kind: 'permission',
        decision
      })
      if (accepted) onResponseAccepted()
      else setMessage('That permission prompt already expired.')
    } finally {
      setAnswering(false)
    }
  }

  const current =
    interaction.kind === 'questions' ? interaction.questions[step] : undefined
  const selected = current ? answers[current.id] ?? [] : []
  const typedOther = current ? other[current.id] ?? '' : ''
  const currentAnswer = current
    ? [...selected, ...(typedOther.trim() ? [typedOther.trim()] : [])]
    : []
  const valid = currentAnswer.length > 0

  const selectOption = (label: string): void => {
    if (!current || !interaction.answerable) return
    setMessage(null)
    setAnswers((previous) => {
      const values = previous[current.id] ?? []
      const next =
        current.selectionMode === 'multiple'
          ? values.includes(label)
            ? values.filter((value) => value !== label)
            : [...values, label]
          : [label]
      return { ...previous, [current.id]: next }
    })
    if (current.selectionMode === 'single') {
      setOther((previous) => ({ ...previous, [current.id]: '' }))
    }
  }

  const setOtherValue = (value: string): void => {
    if (!current || !interaction.answerable) return
    setOther((previous) => ({ ...previous, [current.id]: value }))
    if (value && current.selectionMode === 'single') {
      setAnswers((previous) => ({ ...previous, [current.id]: [] }))
    }
  }

  const completeAnswers = (): Record<string, string[]> =>
    interaction.kind === 'questions'
      ? Object.fromEntries(
          interaction.questions.map((question) => [
            question.id,
            [
              ...(answers[question.id] ?? []),
              ...((other[question.id] ?? '').trim()
                ? [(other[question.id] ?? '').trim()]
                : [])
            ]
          ])
        )
      : {}

  const next = async (): Promise<void> => {
    if (!current || !valid) {
      setMessage('Choose an option or enter an answer to continue.')
      return
    }
    setMessage(null)
    setAnswering(true)
    try {
      // Only held hooks have a deadline to extend. If the interaction expired
      // while this answer was being entered, do not advance into a dead card.
      if (interaction.expiresAt) {
        const advanced = await window.notch.advanceInteraction(interaction.id)
        if (!advanced) {
          setMessage('That question already expired.')
          return
        }
      }
      setStep((value) => value + 1)
    } finally {
      setAnswering(false)
    }
  }

  const submit = async (): Promise<void> => {
    if (!current || !valid) {
      setMessage('Choose an option or enter an answer to continue.')
      return
    }
    setAnswering(true)
    try {
      const accepted = await window.notch.respondToInteraction(interaction.id, {
        kind: 'questions',
        answers: completeAnswers()
      })
      if (accepted) onResponseAccepted()
      else setMessage('That question was already answered or expired.')
    } finally {
      setAnswering(false)
    }
  }

  return (
    <section className="permission-takeover interaction-takeover">
      <div className="takeover-head">
        {seconds !== null ? (
          <div className="countdown">
            <svg viewBox="0 0 60 60" aria-hidden="true">
              <circle className="ring-track" cx="30" cy="30" r="27" />
              <circle
                className="ring-progress"
                cx="30"
                cy="30"
                r="27"
                strokeDasharray="170"
                strokeDashoffset={progress}
              />
            </svg>
            <span>{seconds}</span>
          </div>
        ) : (
          <span className={`interaction-agent ${interaction.agent}`}>
            {interaction.agent === 'codex' ? 'CX' : 'CL'}
          </span>
        )}
        <div className="takeover-copy">
          <div className="takeover-label">
            <b>{interaction.agent === 'codex' ? 'Codex' : 'Claude'}</b>
            <span>{leaf(interaction.cwd)}</span>
          </div>
          {interaction.kind === 'permission' ? (
            isPlanApproval(interaction) ? (
              <p>Ready to code?</p>
            ) : (
              <QuestionSentence interaction={interaction} />
            )
          ) : (
            <>
              <p className="question-header">{current?.header}</p>
              <h2>{current?.question}</h2>
            </>
          )}
          <small>
            {interaction.answerable ? 'Answer here' : 'View only'}
            {seconds !== null ? ` · terminal fallback in ${seconds}s` : ''}
            {queueCount > 1 ? ` · ${queueCount} waiting` : ''}
          </small>
        </div>
      </div>

      {interaction.kind === 'permission' ? (
        <>
          {isPlanApproval(interaction) && <PlanPreview interaction={interaction} />}
          <div className={`raw-input ${jsonOpen ? 'open' : ''}`}>
            <button type="button" onClick={() => setJsonOpen((value) => !value)}>
              <span>Raw tool input</span><i className="chevron" />
            </button>
            {jsonOpen && <pre>{JSON.stringify(interaction.toolInput, null, 2)}</pre>}
          </div>
          {message && <p className="notice error">{message}</p>}
          <div className="question-actions">
            <button type="button" className="deny" disabled={answering} onClick={() => void respondPermission('deny')}>
              {isPlanApproval(interaction) ? 'Keep planning' : 'Deny'}
            </button>
            <button type="button" className="allow" disabled={answering} onClick={() => void respondPermission('allow')}>
              {isPlanApproval(interaction) ? 'Approve plan' : 'Allow once'}
            </button>
          </div>
          {isPlanApproval(interaction) && (
            <p className="footnote">
              Approving lets Claude start. Whether edits are auto-accepted or approved one by one is
              still chosen in the terminal — a hook cannot set the permission mode.
            </p>
          )}
        </>
      ) : (
        <>
          <div className="question-progress" aria-label={`Question ${step + 1} of ${interaction.questions.length}`}>
            {interaction.questions.map((question, index) => (
              <i key={question.id} className={index <= step ? 'active' : ''} />
            ))}
            <span>{step + 1} / {interaction.questions.length}</span>
          </div>
          <div className="option-list">
            {current?.options.map((option) => {
              const checked = selected.includes(option.label)
              return (
                <button
                  key={option.label}
                  type="button"
                  className={`option-card ${checked ? 'selected' : ''}`}
                  disabled={!interaction.answerable}
                  aria-pressed={checked}
                  onClick={() => selectOption(option.label)}
                >
                  <i className={current.selectionMode === 'multiple' ? 'checkbox' : 'radio'} />
                  <span>
                    <b>{option.label}</b>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </button>
              )
            })}
            {interaction.answerable && (current?.allowOther || current?.options.length === 0) && (
              <label className={`other-answer ${typedOther ? 'selected' : ''}`}>
                <span>{current.secret ? 'Secret answer' : 'Other'}</span>
                <input
                  type={current.secret ? 'password' : 'text'}
                  value={typedOther}
                  disabled={!interaction.answerable}
                  autoComplete="off"
                  placeholder={current.secret ? 'Enter securely' : 'Type your answer'}
                  onChange={(event) => setOtherValue(event.target.value)}
                />
              </label>
            )}
          </div>
          {!interaction.answerable && (
            <p className="notice">
              {interaction.transport === 'codex-rollout'
                ? 'This Codex task was launched outside Notch. Answer it in the agent window.'
                : 'The agent finished its turn with this question. Reply in its terminal.'}
            </p>
          )}
          {message && <p className="notice error">{message}</p>}
          {interaction.answerable && (
            <div className="step-actions">
              <button
                type="button"
                className="btn"
                disabled={step === 0 || answering}
                onClick={() => {
                  setMessage(null)
                  setStep((value) => value - 1)
                }}
              >
                Back
              </button>
              {step < interaction.questions.length - 1 ? (
                <button type="button" className="allow" disabled={answering} onClick={next}>Next</button>
              ) : (
                <button type="button" className="allow" disabled={answering} onClick={() => void submit()}>Send answer</button>
              )}
            </div>
          )}
        </>
      )}

      <div className="interaction-footer">
        <button type="button" className="open-agent" onClick={() => void openAgent()}>
          Open agent
        </button>
        <button type="button" className="show-sessions" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </section>
  )
}

/** Plan approval is a permission request, but reads nothing like one. */
function isPlanApproval(
  interaction: Extract<PendingInteraction, { kind: 'permission' }>
): boolean {
  return interaction.toolName === 'ExitPlanMode'
}

/**
 * The plan body, when it is available.
 *
 * ExitPlanMode does not take the plan as a tool parameter — it reads it from
 * the plan file — so `toolInput` is usually empty and there is nothing to show.
 * Rendered only when a plan string is actually present rather than reserving
 * space for a field that may never arrive; `Raw tool input` stays available
 * either way for whatever the tool did send.
 */
function PlanPreview({
  interaction
}: {
  interaction: Extract<PendingInteraction, { kind: 'permission' }>
}): React.JSX.Element {
  const plan = interaction.toolInput.plan
  if (typeof plan !== 'string' || !plan.trim()) {
    return <p className="notice">Claude finished planning. The plan is in its terminal.</p>
  }
  return (
    <div className="raw-input open plan-preview">
      <pre>{plan}</pre>
    </div>
  )
}

function QuestionSentence({
  interaction
}: {
  interaction: Extract<PendingInteraction, { kind: 'permission' }>
}): React.JSX.Element {
  const input = interaction.toolInput
  const stringValue = (...keys: string[]): string => {
    for (const key of keys) if (typeof input[key] === 'string') return input[key] as string
    return ''
  }
  if (interaction.toolName === 'Bash') return <p>Run <code>{stringValue('command') || 'this command'}</code> in the project root?</p>
  if (interaction.toolName === 'Write' || interaction.toolName === 'Edit') {
    return <p>{interaction.toolName} <code>{stringValue('file_path', 'path') || 'this file'}</code>?</p>
  }
  if (interaction.toolName === 'Read') return <p>Read <code>{stringValue('file_path', 'path') || 'this file'}</code>?</p>
  if (interaction.toolName === 'WebFetch') {
    const url = stringValue('url')
    let host = url
    try { host = new URL(url).host } catch { /* show the supplied value */ }
    return <p>Fetch content from <code>{host || 'this host'}</code>?</p>
  }
  return <p><code>{interaction.toolName}</code> wants permission.</p>
}

function leaf(value: string): string {
  return value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'project'
}
