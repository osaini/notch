import { useState } from 'react'
import type { PlanUsage, UsageSnapshot } from '@shared/types'
import { compactTokens, durationUntil, groupedNumber, relativeTime } from '../format'

interface Props {
  usage: UsageSnapshot
  onRefresh: () => Promise<UsageSnapshot>
}

function planStateLabel(plan: PlanUsage): string {
  if (plan.state === 'fresh') return 'live'
  if (plan.state === 'auth-expired') return 'auth expired'
  if (plan.state === 'unavailable') return 'unavailable'
  return plan.source === 'transcript' ? 'transcript fallback' : 'stale cache'
}

export function Usage({ usage, onRefresh }: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [refreshNote, setRefreshNote] = useState<string | null>(null)

  const compact = compactTokens(usage.totalTokens)
  const compactMatch = compact.match(/^([\d.]+)(.*)$/)
  const heroNumber = compactMatch?.[1] ?? compact
  const heroUnit = compactMatch?.[2] ?? ''
  const blockPercent =
    usage.block.tokens > 0 ? Math.min(100, (usage.block.tokens / 5_000_000) * 100) : 0
  const planRows = usage.planUsage.flatMap((plan) =>
    plan.periods.map((period) => ({
      key: `${plan.agent}-${period.id}`,
      label: `${plan.agent === 'codex' ? 'cx' : 'cl'} ${
        period.windowMinutes === 300
          ? '5h'
          : period.windowMinutes === 10_080
            ? 'wk'
            : period.label
      }`,
      agent: plan.agent,
      utilization: Math.max(0, Math.min(100, period.utilization)),
      resetsAt: period.resetsAt,
      fetchedAt: plan.fetchedAt,
      state: planStateLabel(plan),
      message: plan.message
    }))
  )
  const unavailablePlans = usage.planUsage.filter((plan) => plan.periods.length === 0)

  return (
    <div className="tab-pane usage-pane">
      <section className="usage-hero">
        <div>
          <span className="usage-eyebrow">Tokens, all time</span>
          <div className="usage-total">
            <strong>{heroNumber}</strong><b>{heroUnit}</b>
          </div>
          <small>{groupedNumber(usage.totalTokens)} exact</small>
        </div>
        <div className="usage-stats">
          <span>Requests <b>{groupedNumber(usage.messages)}</b></span>
          <span>Sessions <b>{groupedNumber(usage.sessions)}</b></span>
          <span>Active days <b>{groupedNumber(usage.activeDays)}</b></span>
          <span>In / out <b>{compactTokens(usage.inputTokens)} / {compactTokens(usage.outputTokens)}</b></span>
          <span>Cache r/w <b>{compactTokens(usage.cacheReadTokens)} / {compactTokens(usage.cacheCreationTokens)}</b></span>
        </div>
      </section>

      <div className="section-rule"><span>Plan utilization</span><i /><em>provider data</em></div>
      <section className="plan-bars">
        {planRows.map((row) => (
          <div className={`plan-row ${row.agent}`} key={row.key}>
            <b>{row.label}</b>
            <progress max="100" value={row.utilization} />
            <strong>{Math.round(row.utilization)}%</strong>
            <small title={row.message}>
              resets in {durationUntil(row.resetsAt)} · {row.state} · {relativeTime(row.fetchedAt)}
            </small>
          </div>
        ))}
        {unavailablePlans.map((plan) => (
          <div className={`plan-row plan-unavailable ${plan.agent}`} key={`${plan.agent}-unavailable`}>
            <b>{plan.agent === 'claude' ? 'cl' : 'cx'}</b>
            <progress max="100" value="0" />
            <strong>—</strong>
            <small>{plan.message ?? `${plan.agent} plan data is unavailable.`}</small>
          </div>
        ))}
        {usage.planUsage.length === 0 && (
          <p className="footnote">Provider plan data is not available yet.</p>
        )}
      </section>

      <div className="section-rule"><span>Current 5 hours</span><i /><em>local estimate</em></div>
      <section className="plan-bars local-bars">
        <div className="plan-row local">
          <b>Local</b><progress max="100" value={blockPercent} /><strong>{compactTokens(usage.block.tokens)}</strong>
          <small>{usage.block.messages} requests · oldest activity rolls out in {durationUntil(usage.block.resetsAt)}</small>
        </div>
        <p className="footnote">
          Computed from local Claude and Codex transcripts. This is recent volume, not a plan-limit
          percentage; the provider percentages above are the plan data.
        </p>
      </section>

      <div className="usage-footer">
        <span>
          {usage.scannedAt ? `scanned ${relativeTime(usage.scannedAt)}` : 'scanning…'} · {usage.filesTracked} transcripts
          {refreshNote && <small>{refreshNote}</small>}
        </span>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setRefreshNote(null)
            try {
              const next = await onRefresh()
              const degraded = next.planUsage.filter((plan) => plan.state !== 'fresh')
              setRefreshNote(
                degraded.length
                  ? degraded.map((plan) => `${plan.agent}: ${planStateLabel(plan)}`).join(' · ')
                  : 'providers updated'
              )
            } catch {
              setRefreshNote('refresh failed')
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Scanning…' : 'Rescan'}
        </button>
      </div>
    </div>
  )
}
