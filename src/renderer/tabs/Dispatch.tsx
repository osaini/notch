import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CLAUDE_MODEL_ALIASES,
  CODEX_MODEL_FALLBACK,
  LAUNCHER_LABELS,
  type AgentTuning,
  type AgentVersions,
  type ClaudeEffort,
  type CodexEffort,
  type ComboWorkflow,
  type DispatchResult,
  type DispatchTarget,
  type PermissionMode,
  type UsageSnapshot
} from '@shared/types'
import { Listbox, type ListboxOption } from '../components/Listbox'
import { durationUntil } from '../format'
import { usePlatform } from '../platform'

interface Props {
  attachments: string[]
  usage: UsageSnapshot
  onClearAttachments: (sent?: string[]) => void
}

/**
 * Labelled the way the CLI labels them. `dontAsk` is a valid mode the picker
 * deliberately leaves out: it skips prompting without the safety classifier
 * that makes `auto` reasonable, and `bypassPermissions` already covers that
 * ground with an honest name.
 */
const CLAUDE_MODES: { id: PermissionMode; label: string; severity: string }[] = [
  { id: 'manual', label: 'Manual', severity: 'safe' },
  { id: 'auto', label: 'Auto', severity: 'caution' },
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

const CLAUDE_EFFORTS: ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const CODEX_EFFORTS: CodexEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Builds a picker list whose first entry sends nothing at all.
 *
 * The empty value is the point: it is what keeps "Default" from being a model
 * name of its own, so an untouched dispatch produces exactly the argv it
 * produced before these selectors existed.
 */
function tuningOptions(values: readonly string[], defaultMeta: string): ListboxOption[] {
  return [
    { value: '', title: 'Default', meta: defaultMeta, kind: 'plain' },
    ...values.map((value) => ({ value, title: value, kind: 'plain' as const }))
  ]
}

/**
 * The permission mode each target resets to when selected. The pair defaults to
 * `auto` so the radios match `buildAdversarialArgs`' own fallback: an
 * implementer working alongside a reviewer is meant to run unattended.
 */
const DEFAULT_MODE: Record<string, PermissionMode> = {
  claude: 'manual',
  codex: 'codex-on-request',
  'claude-codex': 'auto'
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
  const promptRevision = useRef(0)
  const [mode, setMode] = useState<PermissionMode>('manual')
  const [workflow, setWorkflow] = useState<ComboWorkflow>('bug-search')
  const [versions, setVersions] = useState<AgentVersions | null>(null)
  // Empty objects mean "Default everywhere", which sends no flags at all.
  const [claudeTuning, setClaudeTuning] = useState<AgentTuning<ClaudeEffort>>({})
  const [codexTuning, setCodexTuning] = useState<AgentTuning<CodexEffort>>({})
  const [codexModels, setCodexModels] = useState<readonly string[]>(CODEX_MODEL_FALLBACK)
  const [result, setResult] = useState<DispatchResult | null>(null)
  const [sending, setSending] = useState(false)
  const [browsing, setBrowsing] = useState(false)

  useEffect(() => {
    void window.notch.getRecentProjects().then((directories) => {
      setProjects(directories)
      setCwd((current) => current || directories[0] || '')
    })
    void window.notch.getAgentVersions().then(setVersions)
    // Empty means the managed app server is not up to be asked, which is not an
    // error — the static fallback already seeded the list.
    void window.notch.getCodexModels().then((models) => {
      if (models.length) setCodexModels(models)
    })
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
    const sentPrompt = prompt
    const sentPromptRevision = promptRevision.current
    const sentAttachments = [...attachments]
    setSending(true)
    setResult(null)
    try {
      const response = await window.notch.dispatch({
        agent,
        cwd,
        prompt: sentPrompt,
        permissionMode: mode,
        comboWorkflow: combo ? workflow : undefined,
        attachments: sentAttachments,
        // Sent for whichever agents this target actually runs. The pair sends
        // both, and each half is routed to the agent its key names.
        claude: agent === 'codex' ? undefined : claudeTuning,
        codex: combo || agent === 'codex' ? codexTuning : undefined
      })
      setResult(response)
      if (response.ok) {
        if (promptRevision.current === sentPromptRevision) setPrompt('')
        onClearAttachments(sentAttachments)
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
              setMode(DEFAULT_MODE[candidate.id] ?? 'manual')
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
          onChange={(event) => {
            promptRevision.current++
            setPrompt(event.target.value)
          }}
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

      {/* Bug-search is excluded for the same reason the implementer-permission
          block is: it runs the orchestrator, which pins its own agent settings. */}
      {(!combo || workflow === 'adversarial') && (
        <>
          {agent !== 'codex' && (
            <TuningRow
              legend={combo ? 'Implementer model & effort (Claude)' : 'Model & effort'}
              models={CLAUDE_MODEL_ALIASES}
              efforts={CLAUDE_EFFORTS}
              defaultMeta="Your Claude account default"
              value={claudeTuning}
              onChange={setClaudeTuning}
            />
          )}
          {(combo || agent === 'codex') && (
            <TuningRow
              legend={combo ? 'Reviewer model & effort (Codex)' : 'Model & effort'}
              models={codexModels}
              efforts={CODEX_EFFORTS}
              defaultMeta="From ~/.codex/config.toml"
              value={codexTuning}
              onChange={setCodexTuning}
            />
          )}
          <p className="footnote">
            Default sends no flag, so the agent keeps whatever model and effort its own config
            already selects.
          </p>
        </>
      )}

      {attachments.length > 0 && (
        <div className="attach-note">
          <b>Tray {attachments.length}</b>
          <span>{attachments.length} tray file{attachments.length === 1 ? '' : 's'} will be appended as @-references.</span>
          <button type="button" onClick={() => onClearAttachments()}>Clear</button>
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

/**
 * One agent's model + effort pair.
 *
 * Two `Listbox`es rather than another `.mode-grid` of radios: the pair target
 * shows two of these at once, and four radio grids do not fit the overlay.
 */
function TuningRow<E extends string>({
  legend,
  models,
  efforts,
  defaultMeta,
  value,
  onChange
}: {
  legend: string
  models: readonly string[]
  efforts: readonly E[]
  defaultMeta: string
  value: AgentTuning<E>
  onChange: (next: AgentTuning<E>) => void
}): React.JSX.Element {
  return (
    <fieldset className="mode-field">
      <legend>{legend}</legend>
      <div className="tuning-row">
        <Listbox
          label={`${legend} — model`}
          value={value.model ?? ''}
          options={tuningOptions(models, defaultMeta)}
          placeholder="Default"
          onChange={(next) => onChange({ ...value, model: next || undefined })}
        />
        <Listbox
          label={`${legend} — effort`}
          value={value.effort ?? ''}
          options={tuningOptions(efforts, defaultMeta)}
          placeholder="Default"
          onChange={(next) => onChange({ ...value, effort: (next as E) || undefined })}
        />
      </div>
    </fieldset>
  )
}

function leaf(value: string): string {
  return value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value
}
