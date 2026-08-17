/**
 * The complete platform surface of the app.
 *
 * Everything in `src/main` that cannot run identically on Windows and macOS is
 * declared here and implemented once per OS under `win32/` and `darwin/`. If you
 * are adding a `process.platform` check anywhere else, it belongs in this file
 * instead — `platform/index.ts` is meant to be the only place that branches.
 *
 * Type-only imports, deliberately: this module is linked into every bundled test
 * and must never pull `electron` or `node:child_process` into one. The `Electron.*`
 * types below come from electron's ambient global namespace, not an import.
 *
 * Read `PORTING.md` before implementing a new platform. In particular, three
 * methods here have contracts that a reasonable-looking stub violates:
 * `listCodexTuiProcesses` (null, never []), `DesignWindowProbe.unsupportedReason`
 * (empty means silent), and the five members that must never throw.
 */
import type {
  AgentKind,
  DispatchLauncher,
  NotchColor,
  PlatformInfo,
  SessionActionResult,
  SessionState
} from '@shared/types'

/* ── focus ──────────────────────────────────────────────────────────────── */

export interface FocusIntegration {
  /**
   * Brings the window hosting `session` to the front.
   *
   * MUST NOT throw and MUST NOT reject. `message` is rendered verbatim to the
   * user by `Sessions.tsx`, so it is prose — sentence case, ending in a period,
   * never a stack trace or a developer string.
   */
  focusSessionWindow(session: SessionState): Promise<SessionActionResult>
}

/* ── foreign window presence (Claude Desktop) ───────────────────────────── */

export interface DesignWindow {
  /** Opaque per-platform window identity. Decimal HWND on Windows. */
  handle: string
  pid: number
  title: string
}

/**
 * One sweep's view of Claude Desktop.
 *
 * Design windows are the presence signal for Claude Design. `main` is Claude
 * Desktop's ordinary window — the one Cowork lives inside — and exists only so
 * a Cowork row has something to focus; Cowork is a surface within that window,
 * not a window of its own, so this can never target an individual Cowork chat.
 */
export interface ClaudeWindows {
  design: DesignWindow[]
  main: DesignWindow | null
}

export interface DesignWindowProbe {
  /**
   * False when this platform cannot see another application's window titles.
   * `DesignWatcher` checks this before spawning anything, so `sweepCommand` is
   * never called while it is false.
   */
  readonly supported: boolean
  /**
   * Why, in one user-facing sentence. Only read when `supported` is false.
   *
   * An EMPTY string means "this platform does not have this feature", and the
   * app stays silent. A non-empty string is rendered as a red error notice, so
   * use it only for a platform that *should* work and does not — never for a
   * deliberate omission, or every launch shows a permanent error bar.
   */
  readonly unsupportedReason: string
  /**
   * A long-lived helper that prints one `{"windows":[…]}` JSON line per sweep.
   * Re-spawning per sweep would cost more than everything else the notch does.
   *
   * Each entry is `{handle, pid, title, design}` and covers EVERY visible
   * top-level Claude Desktop window, not only the design ones. `design` is set
   * from the `titles` allowlist passed in, so which captions count stays a
   * decision of the app layer; the sweep only reports what is on screen.
   */
  sweepCommand(
    titles: readonly string[],
    sweepMs: number
  ): {
    exe: string
    args: string[]
  }
}

/* ── process enumeration ────────────────────────────────────────────────── */

export interface AgentProcess {
  pid: number
  /** Epoch ms. Used to pair a process with a rollout inside a 60s window. */
  startedAt: number
  commandLine: string
}

export interface ProcessIntegration {
  /**
   * Confirms a PID still belongs to Claude and was already alive when its
   * session record was last written. False is authoritative; null means the
   * platform could not inspect the process and callers must not terminate it.
   */
  validateClaudeProcess(pid: number, recordUpdatedAt: number): Promise<boolean | null>
  /**
   * Live Codex TUI processes, excluding `app-server` instances.
   *
   * `null` means "could not tell" and is NOT the same as `[]`. SessionWatcher
   * treats any non-null result as authoritative and prunes every TUI row the
   * list does not contain, so returning `[]` does not degrade — it deletes the
   * user's Codex sessions from the UI. An unimplemented platform MUST return
   * null. See `sessionWatcher.ts` and PORTING.md rule 3.
   */
  listCodexTuiProcesses(): Promise<AgentProcess[] | null>
}

/* ── terminal launching ─────────────────────────────────────────────────── */

export interface TerminalRunRequest {
  cwd: string
  /** An executable resolved on PATH: `claude`, `codex`, or `node`. */
  exe: string
  args: string[]
}

/**
 * One launch strategy: every process that must be spawned for it to count as
 * having worked. Two entries means two windows, because this platform cannot
 * put the pair in one.
 */
export interface LaunchPlan {
  launcher: DispatchLauncher
  /** Display-only command line for `DispatchResult.command`. Never spawned. */
  display: string
  launches: { exe: string; args: string[] }[]
}

export interface TerminalIntegration {
  /** UI label for the primary terminal, e.g. "Windows Terminal". */
  readonly primaryLabel: string
  /**
   * Launcher tag to report when no launch was attempted at all — a rejected
   * request, or a platform with no terminal integration yet. `DispatchResult`
   * always carries a launcher, and guessing one from other flags is worse than
   * naming it here.
   */
  readonly primaryLauncher: DispatchLauncher
  /** True when a pair opens as two panes of one window rather than two windows. */
  readonly supportsSplitPane: boolean
  /**
   * Ordered candidates, primary first and fallback last; the caller tries each
   * until one spawns. An EMPTY array means this platform has no terminal
   * integration yet, and the caller turns that into a typed `DispatchResult`
   * failure rather than spawning anything.
   *
   * PURE — no spawning, no fs, no platform probing. That is what lets
   * `testInteractions.ts` assert the exact `wt.exe` argv while running on macOS,
   * so Windows launch behaviour stays covered on a Mac-only CI leg. Keep it that
   * way: probing for an installed terminal belongs in the plan *order*, decided
   * at module load, not inside these calls.
   *
   * SECURITY INVARIANT: every `launches` entry is an argv array, never a shell
   * string, and user-controlled values (cwd, prompts) must never be interpolated
   * into shell or terminal-command syntax. Prompts routinely contain quotes,
   * `;`, `$(` and newlines. See SECURITY.md and PORTING.md §6.
   */
  agentPlans(request: TerminalRunRequest): LaunchPlan[]
  /** Two agents, preferably in one window. Empty means unsupported, as above. */
  pairPlans(first: TerminalRunRequest, second: TerminalRunRequest): LaunchPlan[]
}

/* ── autostart ──────────────────────────────────────────────────────────── */

export interface AutostartIntegration {
  /**
   * MUST NOT throw — this runs on the startup path. Returns false if the
   * setting could not be applied.
   */
  apply(enabled: boolean): boolean
}

/* ── overlay window ─────────────────────────────────────────────────────── */

export interface OverlayIntegration {
  /** Merged into the BrowserWindow options. MUST NOT throw. */
  windowOptions(): Partial<Electron.BrowserWindowConstructorOptions>
  /**
   * The screen rect the pill may occupy on `display`.
   *
   * win32 returns `display.bounds` verbatim and on purpose: the notch is meant
   * to sit over the taskbar. macOS must not, or a top-centre pill lands under
   * the menu bar — and on a notched MacBook, behind the real notch.
   *
   * MUST NOT throw: every reposition and every drag frame calls this.
   */
  pillArea(display: Electron.Display): Electron.Rectangle
  /**
   * Physical display cutout in Electron screen coordinates, when one exists.
   *
   * MUST NOT throw. A missing probe, malformed platform response, or ordinary
   * rectangular display is represented by `null` so overlay geometry can fall
   * back to the compact pill without risking the startup path.
   */
  displayCutout(display: Electron.Display): Electron.Rectangle | null
  /** Per-platform tweaks applied once after the window exists. MUST NOT throw. */
  afterCreate(win: Electron.BrowserWindow): void
}

/* ── tray ───────────────────────────────────────────────────────────────── */

export interface TrayIntegration {
  /**
   * MUST NOT throw, and MUST NOT return an empty NativeImage — an invisible
   * tray item is indistinguishable from a crashed app.
   */
  image(color: NotchColor): Electron.NativeImage
  /** macOS menu-bar icons want template marking; Windows must not have it. */
  readonly template: boolean
  /** False where the OS does not show tray tooltips (macOS). */
  readonly supportsTooltip: boolean
}

/* ── paths ──────────────────────────────────────────────────────────────── */

export interface PathIntegration {
  /** Canonical display form for a project directory. */
  normalizeProjectPath(raw: string): string
  /** Dedupe key for an already-normalized path. Windows lowercases; POSIX must not. */
  projectPathKey(normalized: string): string
  /** False when revealing this path in the file manager is unsafe (UNC, etc). */
  isRevealable(target: string): boolean
}

/* ── cowork roots ───────────────────────────────────────────────────────── */

export interface CoworkRootProbe {
  /**
   * Directories that may hold Claude Desktop's `local-agent-mode-sessions` tree,
   * best first. Locating it is pure OS trivia — on Windows the Store build's
   * `%APPDATA%` is virtualized under a package folder whose publisher hash is
   * not knowable up front — so it belongs here rather than in `agentPaths`.
   *
   * An empty array means "Claude Desktop is not installed", which is a normal
   * state and MUST NOT be reported as an error. Never rejects: a probe that
   * cannot read a candidate simply omits it.
   */
  roots(): Promise<string[]>
}

/* ── aggregate ──────────────────────────────────────────────────────────── */

export interface PlatformIntegration {
  readonly os: 'win32' | 'darwin'
  readonly focus: FocusIntegration
  readonly designWindows: DesignWindowProbe
  readonly coworkRoots: CoworkRootProbe
  readonly processes: ProcessIntegration
  readonly terminal: TerminalIntegration
  readonly autostart: AutostartIntegration
  readonly overlay: OverlayIntegration
  readonly tray: TrayIntegration
  readonly paths: PathIntegration
  /** Copy and feature flags the renderer needs. `productName` is filled in by main. */
  readonly info: Omit<PlatformInfo, 'productName'>
}

/** Re-exported so platform modules can name the agent they are launching. */
export type { AgentKind }
