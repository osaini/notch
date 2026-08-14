import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSettings,
  HookInstallStatus,
  NotchDragState,
  PendingInteraction,
  SessionsSnapshot,
  UsageSnapshot
} from '@shared/types'
import { Sessions, InteractionTakeover } from './tabs/Sessions'
import { Usage } from './tabs/Usage'
import { Dispatch } from './tabs/Dispatch'
import { Tray } from './tabs/Tray'
import { Settings } from './tabs/Settings'
import { emptyUsage } from './emptyUsage'
import { relativeTime } from './format'
import {
  flashColor,
  StatusFlashTracker,
  type FlashColor
} from './statusFlash'
import { priorityPillLabel } from './pillStatus'
import { usePasteImages } from './pasteImages'

type TabId = 'sessions' | 'usage' | 'dispatch' | 'tray' | 'settings'

const TABS: { id: TabId; label: string }[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'usage', label: 'Usage' },
  { id: 'dispatch', label: 'Dispatch' },
  { id: 'tray', label: 'Tray' },
  { id: 'settings', label: 'Settings' }
]

const EMPTY_SESSIONS: SessionsSnapshot = {
  sessions: [],
  color: 'grey',
  counts: { total: 0, idle: 0, busy: 0, needsInput: 0, reviewing: 0, unknown: 0 },
  prunedCount: 0,
  parkedCount: 0,
  scannedAt: 0
}

const DEFAULT_SETTINGS: AppSettings = {
  position: { displayId: null, edge: 'top', offset: 0.5 },
  launchAtLogin: false,
  theme: 'dark',
  mobileBridge: false
}

/** Pointer travel before a press on the pill becomes a drag instead of a click. */
const DRAG_THRESHOLD_PX = 3
/** Must match the open/close transition in styles.css. */
const PANEL_TRANSITION_MS = 240
/** Absorb one-frame boundary noise as the clipped hit region changes shape. */
const HOVER_LEAVE_GRACE_MS = 48

/**
 * How long the pill's contents stay hidden while it turns onto a perpendicular
 * edge. With the 90ms fade back in, they finish arriving just after the 220ms
 * CSS reshape in styles.css has landed.
 */
const TURN_FADE_MS = 180

/** Live gesture bookkeeping. Refs only: none of this should re-render the tree. */
interface PillGesture {
  pointerId: number
  origin: { x: number; y: number }
  /** Cursor offset from the pill's centre when the press landed. */
  grab: { x: number; y: number }
  latest: { x: number; y: number }
  started: boolean
  frame: number | null
}

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<SessionsSnapshot>(EMPTY_SESSIONS)
  const [usage, setUsage] = useState<UsageSnapshot>(emptyUsage)
  const [hooks, setHooks] = useState<HookInstallStatus | null>(null)
  const [interactions, setInteractions] = useState<PendingInteraction[]>([])
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<TabId>('sessions')
  const [attachments, setAttachments] = useState<string[]>([])
  const [dismissedInteraction, setDismissedInteraction] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [sessionsReady, setSessionsReady] = useState(false)
  const [interactionsReady, setInteractionsReady] = useState(false)
  const [statusFlash, setStatusFlash] = useState<{
    id: number
    color: FlashColor
  } | null>(null)

  const [drag, setDrag] = useState<NotchDragState | null>(null)
  const [turn, setTurn] = useState(0)
  const [turning, setTurning] = useState(false)

  // Pinned rather than always interactions[0]. The list is sorted by expiry, so
  // extending the card's deadline for the next question — or a fresher prompt
  // arriving — would otherwise swap the card out from under a half-typed answer.
  const [activeId, setActiveId] = useState<string | null>(null)
  useEffect(() => {
    setActiveId((current) =>
      current && interactions.some((candidate) => candidate.id === current)
        ? current
        : interactions[0]?.id ?? null
    )
  }, [interactions])

  const activeInteraction =
    interactions.find((candidate) => candidate.id === activeId) ?? interactions[0]
  const takeover = Boolean(
    activeInteraction && activeInteraction.id !== dismissedInteraction
  )
  const dragging = drag?.active ?? false
  // The panel rides along collapsed: dragging a 476px sheet around feels heavy,
  // and the pill is the only part the gesture is about.
  const open = !dragging && (expanded || takeover || Boolean(confirmation))
  // While dragging the notch must keep receiving pointer events even though it
  // is collapsed, or the native window would go click-through mid-gesture.
  const interactive = open || dragging
  const edge = drag?.edge ?? settings.position.edge
  const upright = edge === 'left' || edge === 'right'
  const interactiveRef = useRef(false)
  const uprightRef = useRef(upright)
  const draggingRef = useRef(dragging)
  const hoverLeaveTimerRef = useRef<number | null>(null)
  const interactiveReleaseTimerRef = useRef<number | null>(null)
  const turnSequenceRef = useRef(0)
  const gestureRef = useRef<PillGesture | null>(null)
  const statusFlashTrackerRef = useRef(new StatusFlashTracker())
  const statusFlashSequenceRef = useRef(0)

  useEffect(() => {
    const acceptSessions = (next: SessionsSnapshot): void => {
      setSnapshot(next)
      setSessionsReady(true)
    }
    const acceptInteractions = (next: PendingInteraction[]): void => {
      setInteractions(next)
      setInteractionsReady(true)
    }
    const unsubSessions = window.notch.onSessions(acceptSessions)
    const unsubUsage = window.notch.onUsage(setUsage)
    const unsubInteractions = window.notch.onInteractions(acceptInteractions)
    const unsubSettings = window.notch.onSettings(setSettings)
    // Kept after the gesture ends too: the main process is the authority on
    // which edge the window is actually parked against, and its final message
    // carries a zeroed offset, so this stays correct at rest.
    const unsubDrag = window.notch.onDragState(setDrag)
    const unsubExpand = window.notch.onForceExpand(() => setExpanded(true))
    const unsubCollapse = window.notch.onForceCollapse(() => {
      setExpanded(false)
    })
    void window.notch.getDragState().then(setDrag)
    void window.notch.getSessions().then(acceptSessions)
    void window.notch.getUsage().then(setUsage)
    void window.notch.getInteractions().then(acceptInteractions)
    void window.notch.getSettings().then(setSettings)
    void window.notch.getHookStatus().then(setHooks)
    return () => {
      unsubSessions(); unsubUsage(); unsubInteractions(); unsubSettings(); unsubDrag(); unsubExpand(); unsubCollapse()
    }
  }, [])

  useEffect(() => {
    if (!sessionsReady || !interactionsReady) return
    const next = statusFlashTrackerRef.current.update(snapshot.sessions, interactions)
    if (!next || open) return
    statusFlashSequenceRef.current += 1
    setStatusFlash({
      id: statusFlashSequenceRef.current,
      color: flashColor(next)
    })
  }, [interactions, interactionsReady, open, sessionsReady, snapshot.sessions])

  useEffect(() => {
    if (!statusFlash) return
    const timer = window.setTimeout(() => setStatusFlash(null), 1320)
    return () => window.clearTimeout(timer)
  }, [statusFlash])

  useEffect(() => {
    draggingRef.current = dragging
  }, [dragging])

  // Turning onto a perpendicular edge squeezes the bar from 276x32 to 32x276
  // while its flex direction flips in one frame, so its contents ride the turn
  // faded out rather than being visibly mangled. The detach fade does not cover
  // this: a pill that turns while still attached to an edge has detach near 0.
  useEffect(() => {
    if (uprightRef.current === upright) return
    uprightRef.current = upright
    // Only a gesture turns the pill. Adopting an edge on load is not a turn.
    if (!draggingRef.current) return
    turnSequenceRef.current += 1
    setTurn(turnSequenceRef.current)
  }, [upright])

  // Keyed on the turn rather than on `turning`, so a state change arriving
  // mid-turn cannot cancel the timer and strand the class on, and a second turn
  // inside the first simply re-arms it.
  useEffect(() => {
    if (!turn) return
    setTurning(true)
    const timer = window.setTimeout(() => setTurning(false), TURN_FADE_MS)
    return () => window.clearTimeout(timer)
  }, [turn])

  useEffect(() => {
    if (
      dismissedInteraction &&
      !interactions.some((interaction) => interaction.id === dismissedInteraction)
    ) {
      setDismissedInteraction(null)
    }
  }, [dismissedInteraction, interactions])

  useEffect(() => {
    if (!confirmation) return
    const timer = window.setTimeout(() => setConfirmation(null), 850)
    return () => window.clearTimeout(timer)
  }, [confirmation])

  useEffect(() => {
    const resolved = settings.theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : settings.theme
    document.documentElement.dataset.theme = resolved
  }, [settings])

  useEffect(() => {
    if (interactiveReleaseTimerRef.current !== null) {
      window.clearTimeout(interactiveReleaseTimerRef.current)
      interactiveReleaseTimerRef.current = null
    }

    if (interactive) {
      if (!interactiveRef.current) {
        interactiveRef.current = true
        window.notch.setInteractive(true)
      }
      return
    }

    if (!interactiveRef.current) return
    // Changing a transparent BrowserWindow between interactive and
    // click-through makes DWM rebuild its hit-test surface. Keep it interactive
    // until the closing compositor transition is over so that native switch
    // cannot steal a frame from the animation.
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0
      : PANEL_TRANSITION_MS
    interactiveReleaseTimerRef.current = window.setTimeout(() => {
      interactiveReleaseTimerRef.current = null
      interactiveRef.current = false
      window.notch.setInteractive(false)
    }, delay)

    return () => {
      if (interactiveReleaseTimerRef.current !== null) {
        window.clearTimeout(interactiveReleaseTimerRef.current)
        interactiveReleaseTimerRef.current = null
      }
    }
  }, [interactive])

  useEffect(() => () => {
    if (hoverLeaveTimerRef.current !== null) {
      window.clearTimeout(hoverLeaveTimerRef.current)
    }
    if (interactiveReleaseTimerRef.current !== null) {
      window.clearTimeout(interactiveReleaseTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (takeover && activeInteraction) {
          setDismissedInteraction(activeInteraction.id)
          return
        }
        setExpanded(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeInteraction, takeover])

  const label = useMemo(() => {
    return priorityPillLabel(snapshot.counts, interactions.length)
  }, [interactions.length, snapshot])

  const displayColor = interactions.length > 0 ? 'red' : snapshot.color

  const agentCounts = useMemo(() => ({
    claude: snapshot.sessions.filter((session) => session.agent !== 'codex').length,
    codex: snapshot.sessions.filter((session) => session.agent === 'codex').length
  }), [snapshot.sessions])

  const toggleHooks = useCallback(async () => {
    const next = hooks?.installed
      ? await window.notch.uninstallHooks()
      : await window.notch.installHooks()
    setHooks(next)
  }, [hooks])

  const addAttachments = useCallback((paths: string[]) => {
    setAttachments((previous) => [...new Set([...previous, ...paths])])
  }, [])

  // Panel-wide, not Tray-pane-only: a screenshot is usually pasted mid-sentence
  // while writing the prompt it belongs to. The Tray tab's badge is the receipt.
  usePasteImages(addAttachments)

  const onNotchMouseEnter = useCallback((): void => {
    if (hoverLeaveTimerRef.current !== null) {
      window.clearTimeout(hoverLeaveTimerRef.current)
      hoverLeaveTimerRef.current = null
    }
    setExpanded(true)
  }, [])

  const onNotchMouseLeave = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    if (gestureRef.current || hoverLeaveTimerRef.current !== null) return
    if (edge === 'top' && drag?.cutout) {
      const stillOverWing = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>('.pill-wing')
      ).some((wing) => {
        const rect = wing.getBoundingClientRect()
        return event.clientX >= rect.left && event.clientX < rect.right &&
          event.clientY >= rect.top && event.clientY < rect.bottom
      })
      // The expanding clip-path changes the hit-test outline around the cursor
      // even though the hardware rail itself never moves. Do not treat that
      // compositor boundary event as a genuine hover-out from either wing.
      if (stillOverWing) return
    }
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0
      : HOVER_LEAVE_GRACE_MS
    hoverLeaveTimerRef.current = window.setTimeout(() => {
      hoverLeaveTimerRef.current = null
      if (!gestureRef.current) setExpanded(false)
    }, delay)
  }, [drag?.cutout, edge])

  // Cursor samples are coalesced to one per frame: pointermove can fire far
  // faster than the compositor, and every extra sample is a wasted window move.
  const flushGesture = useCallback(() => {
    const gesture = gestureRef.current
    if (!gesture) return
    gesture.frame = null
    window.notch.dragNotch({
      phase: 'move',
      screenX: gesture.latest.x,
      screenY: gesture.latest.y
    })
  }, [])

  const onPillPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || gestureRef.current) return
    const handle = event.currentTarget
    const pill = handle.closest('.pill')
    if (!(pill instanceof HTMLElement)) return
    const rect = pill.getBoundingClientRect()
    gestureRef.current = {
      pointerId: event.pointerId,
      origin: { x: event.screenX, y: event.screenY },
      // Where in the pill it was picked up, so the bar does not jump to centre
      // itself under the cursor. The main process clamps this to the collapsed
      // pill, which is narrower than the open one measured here.
      grab: {
        x: event.clientX - (rect.left + rect.width / 2),
        y: event.clientY - (rect.top + rect.height / 2)
      },
      latest: { x: event.screenX, y: event.screenY },
      started: false,
      frame: null
    }
    handle.setPointerCapture(event.pointerId)
  }

  const onPillPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gesture.latest = { x: event.screenX, y: event.screenY }
    if (!gesture.started) {
      const travelled = Math.hypot(
        event.screenX - gesture.origin.x,
        event.screenY - gesture.origin.y
      )
      // A plain click on the pill must not kick off a move-and-settle round trip.
      if (travelled < DRAG_THRESHOLD_PX) return
      gesture.started = true
      window.notch.dragNotch({
        phase: 'start',
        screenX: event.screenX,
        screenY: event.screenY,
        grabX: gesture.grab.x,
        grabY: gesture.grab.y
      })
      return
    }
    if (gesture.frame === null) {
      gesture.frame = window.requestAnimationFrame(flushGesture)
    }
  }

  const onPillPointerUp = (event: React.PointerEvent<HTMLElement>): void => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    if (gesture.frame !== null) window.cancelAnimationFrame(gesture.frame)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!gesture.started) return
    window.notch.dragNotch({ phase: 'end', screenX: event.screenX, screenY: event.screenY })
  }

  const hardwareNotch = edge === 'top' && Boolean(drag?.cutout)
  const gestureHandlers = {
    onPointerDown: onPillPointerDown,
    onPointerMove: onPillPointerMove,
    onPointerUp: onPillPointerUp,
    onPointerCancel: onPillPointerUp
  }

  return (
    <div
      className={[
        'stage',
        `edge-${edge}`,
        dragging ? 'dragging' : '',
        // Collapsed, the pill is placed from the offset the main process sends;
        // open, the panel reclaims the per-edge alignment so it cannot be
        // pushed off the display by a pill parked at the end of its travel.
        open ? 'panel-open' : '',
        hardwareNotch ? 'hardware-notch' : '',
        drag?.floating ? 'floating' : '',
        turning ? 'turning' : ''
      ].filter(Boolean).join(' ')}
      style={{
        '--detach': drag?.detach ?? 0,
        '--pill-dx': `${drag?.offsetX ?? 0}px`,
        '--pill-dy': `${drag?.offsetY ?? 0}px`,
        '--pill-width': `${drag?.pillWidth ?? 276}px`,
        '--pill-height': `${drag?.pillHeight ?? 32}px`,
        '--cutout-left': `${drag?.cutout?.x ?? 0}px`,
        '--cutout-width': `${drag?.cutout?.width ?? 0}px`
      } as React.CSSProperties}
    >
      <div className={`notch-wrap ${open ? 'open' : ''}`}>
        {statusFlash && !open && (
          <span
            key={statusFlash.id}
            className={`pill-status-flash flash-${statusFlash.color}`}
            aria-hidden="true"
          />
        )}
        <div
          className={`notch ${open ? 'open' : ''} status-${displayColor} ${takeover ? 'takeover-active' : ''}`}
          onMouseEnter={onNotchMouseEnter}
          onMouseLeave={onNotchMouseLeave}
        >
          <div
            className="pill"
            title="Drag to another screen edge"
            {...(!hardwareNotch ? gestureHandlers : {})}
          >
            <span className="pill-status pill-wing" {...(hardwareNotch ? gestureHandlers : {})}>
              <span className="dot beacon" />
              <span className="pill-label">{label}</span>
            </span>
            <span className="pill-spacer" />
            <span className="pill-agents pill-wing" {...(hardwareNotch ? gestureHandlers : {})}>
              <span className="agent-count claude" aria-label={`${agentCounts.claude} Claude sessions`}><i />{agentCounts.claude}</span>
              <span className="agent-count codex" aria-label={`${agentCounts.codex} Codex sessions`}><i />{agentCounts.codex}</span>
            </span>
          </div>

          <div className="panel" aria-hidden={!open} inert={!open}>
            {takeover && activeInteraction ? (
              <InteractionTakeover
                interaction={activeInteraction}
                queueCount={interactions.length}
                onDismiss={() => setDismissedInteraction(activeInteraction.id)}
                onResponseAccepted={() => {
                  setDismissedInteraction(activeInteraction.id)
                  setConfirmation(activeInteraction.id)
                  setExpanded(false)
                }}
                onOpenAgent={() => {
                  setDismissedInteraction(activeInteraction.id)
                  setExpanded(false)
                }}
              />
            ) : confirmation ? (
              <section className="interaction-confirmation" role="status">
                <span className="confirmation-check">✓</span>
                <strong>Answer sent</strong>
                <small>The agent is continuing.</small>
              </section>
            ) : (
              <>
                <nav className="tabs">
                  {TABS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={item.id === tab ? 'tab active' : 'tab'}
                      onClick={() => {
                        if (
                          item.id === 'sessions' &&
                          dismissedInteraction &&
                          interactions.length > 0
                        ) {
                          setDismissedInteraction(null)
                        } else {
                          setTab(item.id)
                        }
                      }}
                    >
                      {item.label}
                      {item.id === 'tray' && attachments.length > 0 && <span className="badge">{attachments.length}</span>}
                      {item.id === 'sessions' && interactions.length > 0 && <span className="badge danger">{interactions.length}</span>}
                    </button>
                  ))}
                </nav>
                <div className="panel-body">
                  {tab === 'sessions' && <Sessions snapshot={snapshot} hooks={hooks} onToggleHooks={toggleHooks} />}
                  {tab === 'usage' && (
                    <Usage
                      usage={usage}
                      onRefresh={async () => {
                        const next = await window.notch.refreshUsage()
                        setUsage(next)
                        return next
                      }}
                    />
                  )}
                  {tab === 'dispatch' && (
                    <Dispatch
                      attachments={attachments}
                      usage={usage}
                      onClearAttachments={() => setAttachments([])}
                    />
                  )}
                  {tab === 'tray' && (
                    <Tray
                      attachments={attachments}
                      onAdd={addAttachments}
                      onRemove={(path) => setAttachments((previous) => previous.filter((item) => item !== path))}
                      onClear={() => setAttachments([])}
                    />
                  )}
                  {tab === 'settings' && (
                    <Settings
                      settings={settings}
                      hooks={hooks}
                      onToggleHooks={toggleHooks}
                      onChange={setSettings}
                    />
                  )}
                </div>
                <footer className="panel-footer">
                  <span className={`status-chip status-${displayColor}`}>
                    {displayColor === 'blue' ? 'reviewing' : displayColor}
                  </span>
                  <span className="footer-actions">
                    <span>{snapshot.scannedAt ? `scan ${relativeTime(snapshot.scannedAt)}` : 'scanning'}</span>
                    <button type="button" className="link" onClick={() => window.notch.quit()}>Quit</button>
                  </span>
                </footer>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
