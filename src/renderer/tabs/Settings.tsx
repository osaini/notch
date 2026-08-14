import { useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  DisplayOption,
  HookInstallStatus,
  MobileBridgeStatus,
  MobileEndpoint,
  MobileEndpointKind,
  NotchPosition,
  NotchPositionPreset,
  ThemePreference
} from '@shared/types'
import { NOTCH_POSITION_PRESETS } from '@shared/types'
import { Listbox } from '../components/Listbox'
import { QrCode } from '../components/QrCode'
import { durationUntil } from '../format'
import { usePlatform } from '../platform'

interface Props {
  settings: AppSettings
  hooks: HookInstallStatus | null
  onToggleHooks: () => void
  onChange: (settings: AppSettings) => void
}

const THEMES: { id: ThemePreference; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'Follow system' }
]

/** What each address is good for, in the user's terms rather than the OS's. */
const ENDPOINT_HINT: Record<MobileEndpointKind, string> = {
  lan: 'Same Wi-Fi',
  vpn: 'Over VPN',
  other: 'Other network',
  loopback: 'Will not work from a phone'
}

const GRID: (NotchPositionPreset | null)[] = [
  findPreset('top', 0), findPreset('top', 0.5), findPreset('top', 1),
  findPreset('left', 0.5), null, findPreset('right', 0.5),
  findPreset('bottom', 0), findPreset('bottom', 0.5), findPreset('bottom', 1)
]

export function Settings({
  settings,
  hooks,
  onToggleHooks,
  onChange
}: Props): React.JSX.Element {
  const platformInfo = usePlatform()
  const [displays, setDisplays] = useState<DisplayOption[]>([])
  const [saving, setSaving] = useState(false)
  const [mobile, setMobile] = useState<MobileBridgeStatus | null>(null)
  /** Which endpoint the QR encodes. Null follows the bridge's recommendation. */
  const [chosenUrl, setChosenUrl] = useState<string | null>(null)

  useEffect(() => {
    void window.notch.getDisplays().then(setDisplays)
    void window.notch.getMobileBridgeStatus().then(setMobile)
    // The pairing code is one-shot and short-lived: it is replaced the instant a
    // phone consumes it. Without this subscription the tab keeps showing a code
    // that has already stopped working.
    return window.notch.onMobileStatus(setMobile)
  }, [])

  const endpoints = mobile?.endpoints ?? []
  const selected: MobileEndpoint | undefined =
    endpoints.find((endpoint) => endpoint.url === chosenUrl) ??
    endpoints.find((endpoint) => endpoint.recommended) ??
    endpoints[0]

  /**
   * The pairing code rides in the fragment so a scan lands on a pre-filled form
   * and the user types nothing at all. A fragment is never sent to the server,
   * so this exposes the code nowhere the displayed digits had not already.
   */
  const pairingLink =
    selected && mobile?.pairingCode && mobile.pairingExpiresAt > Date.now()
      ? `${selected.url}/#pair=${mobile.pairingCode}`
      : (selected?.url ?? '')

  const updatePosition = async (patch: Partial<NotchPosition>): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.notch.updateSettings({ position: patch })
      onChange(next)
    } finally {
      setSaving(false)
    }
  }

  const displayOptions = useMemo(() => [
    { value: '', title: 'Primary display', meta: 'System primary', kind: 'display' as const },
    ...displays.map((display) => {
      const [title, resolution = `${display.bounds.width}×${display.bounds.height}`] = display.label.split(' · ')
      return {
        value: display.id,
        title: `${title}${display.primary ? ' (primary)' : ''}`,
        meta: resolution,
        kind: 'display' as const
      }
    })
  ], [displays])

  const currentPreset = NOTCH_POSITION_PRESETS.find((preset) =>
    preset.edge === settings.position.edge && preset.offset === settings.position.offset)

  return (
    <div className="tab-pane settings-pane">
      <div className="section-rule"><span>Appearance</span><i /></div>
      <div className="theme-control" role="radiogroup" aria-label="Appearance">
        {THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={settings.theme === theme.id}
            className={settings.theme === theme.id ? 'active' : ''}
            onClick={async () => {
              const next = await window.notch.updateSettings({ theme: theme.id })
              onChange(next)
            }}
          >
            {theme.label}
          </button>
        ))}
      </div>

      <div className="section-rule">
        <span>Where it lives</span><i /><em>{saving ? 'Saving…' : 'Drag anytime'}</em>
      </div>
      <div className="position-control">
        <div className="monitor-grid" aria-label="Notch position presets">
          {GRID.map((preset, index) => preset ? (
            <button
              key={preset.label}
              type="button"
              title={preset.label}
              aria-label={preset.label}
              className={settings.position.edge === preset.edge && settings.position.offset === preset.offset ? 'active' : ''}
              onClick={() => void updatePosition({ edge: preset.edge, offset: preset.offset })}
            />
          ) : <span key={`blank-${index}`} />)}
        </div>
        <div className="position-copy">
          <strong>{currentPreset?.label ?? `${capitalize(settings.position.edge)} custom`}</strong>
          <small>{settings.position.edge} · offset {settings.position.offset.toFixed(2)}</small>
          <input
            aria-label="Position along edge"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={settings.position.offset}
            onChange={(event) => void updatePosition({ offset: Number.parseFloat(event.target.value) })}
          />
        </div>
      </div>

      <div className="field">
        <span className="field-label">Monitor</span>
        <Listbox
          label="Monitor"
          value={settings.position.displayId ?? ''}
          options={displayOptions}
          placeholder="Primary display"
          onChange={(value) => void updatePosition({ displayId: value || null })}
        />
      </div>

      <label className="toggle-row">
        <span><strong>Launch at sign-in</strong><small>Keeps the notch available after a restart.</small></span>
        <input
          type="checkbox"
          checked={settings.launchAtLogin}
          onChange={async (event) => {
            const next = await window.notch.updateSettings({ launchAtLogin: event.target.checked })
            onChange(next)
          }}
        />
        <i className="switch" />
      </label>

      <label className="toggle-row">
        <span><strong>Permission controls</strong><small>Answer Claude permission requests from the notch.</small></span>
        <input type="checkbox" checked={Boolean(hooks?.installed)} onChange={onToggleHooks} />
        <i className="switch" />
      </label>

      <section className="mobile-bridge-card">
        <div className="section-rule compact">
          <span>Phone companion</span><i />
          <em className={mobile?.running ? 'green online-label' : 'grey online-label'}>
            {mobile?.running ? 'Online' : 'Offline'}
          </em>
        </div>

        <label className="toggle-row">
          <span>
            <strong>Allow phone access</strong>
            <small>
              Serves the companion over plain HTTP to your whole local network. A paired
              phone can run agents in your projects without approval prompts.
            </small>
          </span>
          <input
            type="checkbox"
            checked={settings.mobileBridge}
            onChange={async (event) => {
              const next = await window.notch.updateSettings({ mobileBridge: event.target.checked })
              onChange(next)
              setMobile(await window.notch.getMobileBridgeStatus())
            }}
          />
          <i className="switch" />
        </label>

        {!settings.mobileBridge ? (
          <p className="security-note">
            Off. Nothing is listening, and paired devices cannot reach this computer.
          </p>
        ) : (
          <>
            {mobile?.error && <div className="notice error">{mobile.error}</div>}

            <div className="pairing-scan">
              <QrCode value={pairingLink} />
              <div className="pairing-scan-copy">
                <div className="field-label">Scan with your phone's camera</div>
                <p className="muted xsmall">
                  Opens the companion and fills in the code. Your phone must be on the
                  same Wi-Fi as this computer.
                </p>
                <div className="pairing-code">
                  {(mobile?.pairingCode || '------').split('').map((digit, index) => (
                    <span key={index}>{digit}</span>
                  ))}
                </div>
                <div className="muted xsmall">
                  Expires in {durationUntil(mobile?.pairingExpiresAt ?? null)} ·{' '}
                  {mobile?.pairedDevices ?? 0} paired device(s)
                </div>
                <button
                  type="button"
                  className="btn"
                  disabled={!mobile}
                  onClick={() => void window.notch.regenerateMobilePairing().then(setMobile)}
                >
                  New code
                </button>
              </div>
            </div>

            <div className="field-label">Or type this address into your phone's browser</div>
            {endpoints.map((endpoint) => (
              <div
                key={endpoint.url}
                className={`mobile-url${endpoint.url === selected?.url ? ' selected' : ''} kind-${endpoint.kind}`}
              >
                <button
                  type="button"
                  className="mobile-url-pick"
                  title={`${endpoint.label} — ${ENDPOINT_HINT[endpoint.kind]}`}
                  aria-pressed={endpoint.url === selected?.url}
                  onClick={() => setChosenUrl(endpoint.url)}
                >
                  <span className="mobile-url-address">{endpoint.url}</span>
                  <span className="mobile-url-hint">
                    {endpoint.recommended ? 'Recommended' : ENDPOINT_HINT[endpoint.kind]}
                  </span>
                </button>
                <button type="button" onClick={() => void navigator.clipboard.writeText(endpoint.url)}>
                  Copy
                </button>
              </div>
            ))}
            {mobile?.running && endpoints.length <= 1 && (
              <p className="security-note">
                This computer has no network address a phone could reach. Connect it to
                Wi-Fi or Ethernet, then reopen this tab.
              </p>
            )}
            {Boolean(mobile?.pairedDevices) && (
              <button type="button" className="link danger-link" onClick={() => void window.notch.clearMobileDevices().then(setMobile)}>
                Unpair all phones
              </button>
            )}
            <p className="security-note">HTTP on your private LAN only. Never port-forward this service.</p>
          </>
        )}
      </section>

      <p className="footnote">
        After choosing Quit, reopen {platformInfo?.productName ?? 'Notch'}{' '}
        {platformInfo ? platformInfo.relaunchHint : 'from where you installed it'}.
      </p>
    </div>
  )
}

function findPreset(edge: NotchPositionPreset['edge'], offset: number): NotchPositionPreset {
  const preset = NOTCH_POSITION_PRESETS.find((item) => item.edge === edge && item.offset === offset)
  if (!preset) throw new Error(`Missing ${edge} ${offset} preset`)
  return preset
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
