import { useEffect, useMemo, useState } from 'react'
import {
  LAUNCHER_LABELS,
  type AgentVersions,
  type ComboWorkflow,
  type DispatchResult,
  type DispatchTarget,
  type PermissionMode,
  type UsageSnapshot
} from '@shared/types'
import { Listbox } from '../components/Listbox'
import { durationUntil } from '../format'
import { usePlatform } from '../platform'

interface Props {
  attachments: string[]
  usage: UsageSnapshot
  onClearAttachments: () => void
}

const CLAUDE_MODES: { id: PermissionMode; label: string; severity: string }[] = [
  { id: 'default', label: 'Default', severity: 'safe' },
  { id: 'acceptEdits', label: 'Accept edits', severity: 'caution' },
  { id: 'plan', label: 'Plan', severity: 'info' },
  { id: 'bypassPermissions', label: 'Bypass permissions', severity: 'danger' }
]

const CODEX_MODES: { id: PermissionMode; label: string; severity: string }[] = [
  { id: 'codex-on-request', label: 'Ask on request', severity: 'safe' },
  { id: 'codex-untrusted', label: 'Ask for untrusted commands', severity: 'caution' },
  { id: 'codex-never', label: 'Never ask', severity: 'info' },
  { id: 'codex-bypass', label: 'Bypass approvals and sandbox', severity: 'danger' }
]

const COMBO_WORKFLOWS: { id: ComboWorkflow; label: string; severity: string }[] = [
  { id: 'bug-search', label: 'Bug searching', severity: 'safe' },
  { id: 'adversarial', label: 'Adversarial planning + implementation', severity: 'caution' }
]

/**
 * The three dispatch targets. A table rather than inline ternaries because with
 * a third card every label, monogram and verb would otherwise branch twice.
 */
const TARGETS: {
  id: DispatchTarget
  monogram: string
  title: string
  /** Verb for the dispatch button and the prompt placeholder. */
  short: string
}[] = [
  { id: 'claude', monogram: 'CL', title: 'Claude Code', short: 'Claude' },
  { id: 'codex', monogram: 'CX', title: 'Codex', short: 'Codex' },
  { id: 'claude-codex', monogram: 'C+X', title: 'Claude + Codex', short: 'the pair' }
]

/**
 * The permission mode each target resets to when selected. The pair defaults to
 * `acceptEdits` so the radios match `buildAdversarialArgs`' own fallback.
 */
const DEFAULT_MODE: Record<string, PermissionMode> = {
  claude: 'default',
  codex: 'codex-on-request',
  'claude-codex': 'acceptEdits'
}

function versionLabel(target: DispatchTarget, versions: AgentVersions | null): string {
  const claude = versions?.claude ?? '—'
  const codex = versions?.codex ?? '—'
  if (target === 'claude') return claude
  if (target === 'codex') return codex
  return `${claude} · ${codex}`
}

export function Dispatch({ attachments, usage, onClearAttachments }: Props): React.JSX.Element {
  const platformInfo = usePlatform()
  const [projects, setProjects] = useState<string[]>([])
  const [agent, setAgent] = useState<DispatchTarget>('claude')
  const [cwd, setCwd] = useState('')
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<PermissionMode>('default')
  const [workflow, setWorkflow] = useState<ComboWorkflow>('bug-search')
  const [versions, setVersions] = useState<AgentVersions | null>(null)
  const [result, setResult] = useState<DispatchResult | null>(null)
  const [sending, setSending] = useState(false)
  const [browsing, setBrowsing] = useState(false)

  useEffect(() => {
    void window.notch.getRecentProjects().then((directories) => {
      setProjects(directories)
      setCwd((current) => current || directories[0] || '')
    })
    void window.notch.getAgentVersions().then(setVersions)
  }, [])

  const projectOptions = useMemo(() => projects.map((directory, index) => ({
    value: directory,
    title: leaf(directory),
    meta: directory,
    aside: index === 0 ? 'Recent' : '',
    kind: 'project' as const
  })), [projects])

  const combo = agent === 'claude-codex'
  const target = TARGETS.find((entry) => entry.id === agent) ?? TARGETS[0]

  /**
   * The pair has no single provider quota, so the usage strip renders one row
   * per underlying agent instead of one row for the selection.
   */
  const quickRows = useMemo(() => {
    const kinds: ('claude' | 'codex')[] = combo
      ? ['claude', 'codex']
      : [agent === 'codex' ? 'codex' : 'claude']
    return kinds.map((kind) => {
      const plan = usage.planUsage.find((entry) => entry.agent === kind)
      const period = plan?.periods.find(
        (entry) => entry.windowMinutes === (kind === 'claude' ? 300 : 10_080)
      )
      return {
        kind,
        label: kind === 'claude' ? 'Claude · 5h' : 'Codex · week',
        plan,
        period,
        state:
          plan?.state === 'fresh'
            ? 'live'
            : plan?.state === 'auth-expired'
              ? 'auth expired'
              : plan?.state === 'stale'
                ? 'stale'
                : 'unavailable'
      }
    })
  }, [agent, combo, usage.planUsage])

  const browse = async (): Promise<void> => {
    setBrowsing(true)
    try {
      const selected = await window.notch.browseDirectory(cwd || undefined)
      if (!selected) return
      setProjects((current) => current.includes(selected) ? current : [selected, ...current])
      setCwd(selected)
      setResult(null)
    } finally {
      setBrowsing(false)
    }
  }

  const send = async (): Promise<void> => {
    setSending(true)
    setResult(null)
    try {
      const response = await window.notch.dispatch({
        agent,
        cwd,
        prompt,
        permissionMode: mode,
        comboWorkflow: combo ? workflow : undefined,
        attachments
      })
      setResult(response)
      if (response.ok) {
        setPrompt('')
        onClearAttachments()
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="tab-pane dispatch-pane">
      <div className="agent-cards" role="radiogroup" aria-label="Agent">
        {TARGETS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            role="radio"
            aria-checked={agent === candidate.id}
            className={`agent-card ${candidate.id} ${agent === candidate.id ? 'active' : ''}`}
            onClick={() => {
              setAgent(candidate.id)
              setMode(DEFAULT_MODE[candidate.id] ?? 'default')
            }}
          >
            <span className="agent-monogram">{candidate.monogram}</span>
            <span><strong>{candidate.title}</strong>
              <small>{versionLabel(candidate.id, versions)}</small>
            </span>
          </button>
        ))}
      </div>

      {quickRows.map((row) => (
        <section
          key={row.kind}
          className={`dispatch-usage ${row.kind} ${row.plan?.state ?? 'unavailable'}`}
        >
          <div className="dispatch-usage-head">
            <b>{row.label}</b>
            <strong>{row.period ? `${Math.round(row.period.utilization)}%` : '—'}</strong>
          </div>
          <progress max="100" value={row.period?.utilization ?? 0} />
          <small>
            {row.period
              ? `resets in ${durationUntil(row.period.resetsAt)} · ${row.state}`
              : row.plan?.message ?? `${row.kind === 'claude' ? 'Claude' : 'Codex'} usage is unavailable.`}
          </small>
        </section>
      ))}

      <div className="field">
        <span className="field-label">Project</span>
        <Listbox
          label="Project directory"
          value={cwd}
          options={projectOptions}
          placeholder="No recent projects"
          onChange={(value) => { setCwd(value); setResult(null) }}
          onBrowse={() => void browse()}
          browsing={browsing}
        />
      </div>

      <label className="field">
        <span className="field-label">Prompt</span>
        <textarea
          rows={5}
          value={prompt}
          placeholder={`What should ${target.short} do?`}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>

      <fieldset className="mode-field">
        <legend>
          {combo ? 'Workflow' : agent === 'claude' ? 'Permission mode' : 'Approval policy'}
        </legend>
        <div className="mode-grid">
          {combo
            ? COMBO_WORKFLOWS.map((item) => (
                <label key={item.id} className={workflow === item.id ? 'active' : ''}>
                  <input
                    type="radio"
                    name="combo-workflow"
                    value={item.id}
                    checked={workflow === item.id}
                    onChange={() => setWorkflow(item.id)}
                  />
                  <i className={item.severity} />
                  <span>{item.label}</span>
                </label>
              ))
            : (agent === 'claude' ? CLAUDE_MODES : CODEX_MODES).map((item) => (
                <label key={item.id} className={mode === item.id ? 'active' : ''}>
                  <input
                    type="radio"
                    name="permission-mode"
                    value={item.id}
                    checked={mode === item.id}
                    onChange={() => setMode(item.id)}
                  />
                  <i className={item.severity} />
                  <span>{item.label}</span>
                </label>
              ))}
        </div>
        {combo && workflow === 'bug-search' && (
          <p className="footnote">
            Runs the project&rsquo;s own <code>debug-orchestrator</code> pipeline, which requires a
            clean worktree. Projects without it fall back to the adversarial pair.
          </p>
        )}
      </fieldset>

      {/* Only the adversarial pair takes a permission mode: bug-search runs the
          orchestrator, which pins its own read-only tooling regardless. */}
      {combo && workflow === 'adversarial' && (
        <fieldset className="mode-field">
          <legend>Implementer permission</legend>
          <div className="mode-grid">
            {CLAUDE_MODES.map((item) => (
              <label key={item.id} className={mode === item.id ? 'active' : ''}>
                <input
                  type="radio"
                  name="implementer-mode"
                  value={item.id}
                  checked={mode === item.id}
                  onChange={() => setMode(item.id)}
                />
                <i className={item.severity} />
                <span>{item.label}</span>
              </label>
            ))}
          </div>
          <p className="footnote">
            Applies to Claude, the implementer. Codex reviews under a read-only sandbox and cannot
            edit the tree it is reviewing, so its commands never require approval.
          </p>
        </fieldset>
      )}

      {attachments.length > 0 && (
        <div className="attach-note">
          <b>Tray {attachments.length}</b>
          <span>{attachments.length} tray file{attachments.length === 1 ? '' : 's'} will be appended as @-references.</span>
          <button type="button" onClick={onClearAttachments}>Clear</button>
        </div>
      )}

      <button
        type="button"
        className="dispatch-button"
        disabled={sending || !cwd || (!prompt.trim() && attachments.length === 0)}
        onClick={() => void send()}
      >
        {sending ? 'Launching…' : combo ? 'Dispatch the pair' : `Dispatch ${target.short}`}
      </button>

      {result && (
        <div className={result.ok ? 'notice dispatch-result ok' : 'notice dispatch-result error'}>
          <div>
            <i />
            {result.ok
              ? `${result.transport === 'managed-codex' ? 'Managed Codex' : 'Launched'} via ${LAUNCHER_LABELS[result.launcher]}`
              : `Failed: ${result.error}`}
          </div>
          <code className="cmd">{result.command}</code>
        </div>
      )}

      <p className="footnote">
        Opens a new terminal in the chosen directory. Codex uses a managed loopback App Server when
        available so questions can be answered here
        {platformInfo ? `; ${platformInfo.terminalLabel} has a safely encoded fallback` : ''}.
        {platformInfo && !platformInfo.features.splitPane
          ? ' The pair opens as two windows on this platform rather than two panes.'
          : ''}
      </p>
    </div>
  )
}

function leaf(value: string): string {
  return value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value
}
