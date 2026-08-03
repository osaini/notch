# Porting Notch to macOS

Read this before writing any code. It exists because several of the obvious
implementations are wrong in ways that are silent — one of them deletes the user's
sessions, another shows a permanent error bar, a third is a command-injection bug.

The author develops on Windows and **cannot run or test any of the macOS code**.
Nothing in `src/main/platform/darwin/` has ever executed. The Windows half is
verified; treat the macOS half as a specification with stubs attached.

---

## 1. Where the boundary is

Everything that cannot run identically on both platforms lives behind one typed
interface. Nothing else in `src/main` branches on `process.platform`.

```
src/main/platform/
  types.ts          the whole contract — read this first
  index.ts          the ONE process.platform decision in the app
  launch.ts         shared spawnDetached + "try plans in order, ENOENT -> next"
  win32/            index focus designWindows processes terminal
                    autostart overlay tray paths powershell
  darwin/           the same nine, minus powershell
```

Everything else stays shared and is already portable: `designWatcher.ts` owns the
EventEmitter, restart backoff and line buffering; `dispatcher.ts` owns the agent
argv (`--permission-mode`, `--ask-for-approval`, prompt composition); `windows.ts`
owns all the geometry; `hookServer`, `hookInstaller`, `mobileBridge`, `usage`,
`transcriptTail` and the entire renderer need no platform work.

`platform/index.ts` uses **static** imports, so both trees are linked into every
build and both module bodies run on the wrong OS as a matter of course. They must
have **no top-level side effects** — no spawn, no `app.` call, no `new Tray()`,
nothing but function and const definitions. `npm run test:pill-geometry` links
them under `scripts/stubs/electron.ts`, so a violation shows up there.

If you need an `electron` member the stub does not export, add it to
`scripts/stubs/electron.ts`. A missing one is an esbuild **link failure**, not a
runtime throw.

## 2. The stub contract

Four rules. They exist because "unimplemented" and "definitively empty" are
different answers, and this codebase already has a place where confusing them
loses data.

1. **Returns `SessionActionResult`** → `{ok: false, message: '<Feature> is not
   available on macOS yet.'}`. `Sessions.tsx` renders `message` **verbatim**, so it
   is prose: sentence case, ends with a period, no stack traces, no "TODO".
2. **Returns `DispatchResult`** → `{ok: false, command: '', launcher: …,
   transport: 'legacy-cli', error: '…'}`.
3. **Returns a collection where empty is a legitimate answer** → return the
   "unknown" sentinel, **never `[]`**. Right now that is
   `processes.listCodexTuiProcesses`, which must return `null`.
4. **A feature that must not even start** → `readonly supported: boolean` plus
   `unsupportedReason`. The caller checks the flag first, so the methods behind it
   may `throw` with a message naming the interface method.

### Rule 3 is not hypothetical

`src/main/sessionWatcher.ts` treats a non-null process list as authoritative and
prunes every Codex TUI row the list does not mention:

```ts
if (isTui && tuiMatches !== null && !tuiProcess) continue   // drops the row
```

So a stub returning `[]` does not degrade — it says "no Codex processes are alive
anywhere" and **deletes every Codex session from the UI**. `null` means "I could
not tell; keep believing what you believed."

### The five members that must never throw

Traced from `app.whenReady()`. Everything else is IPC- or timer-reachable and may
fail loudly.

| Member | Why it is on the startup path |
|---|---|
| `overlay.windowOptions()` | merged into the BrowserWindow constructor |
| `overlay.afterCreate(win)` | runs once immediately after the window exists |
| `overlay.pillArea(display)` | every reposition **and every drag frame** |
| `tray.image(color)` | `tray.create()`; must also not return an empty NativeImage — an invisible menu-bar item is indistinguishable from a crash |
| `autostart.apply(enabled)` | `applyLoginSetting` during startup |

Plus the `designWindows.supported` flag read, before anything is spawned.

**The acceptance test for all of this: `npm run dev` on a Mac must launch and show
the notch with degraded features.** A single startup throw gives you a blank
screen instead of a feedback loop.

## 3. Invariants you may not break

- **Zero native addons.** Runtime `dependencies` must stay exactly `["ws"]`, and
  CI enforces it. `active-win` is the obvious reach for window enumeration and is
  a native addon; so are `sharp` and `node-mac-permissions`. Nothing to recompile
  per platform is the property that makes this port cheap — don't spend it.
- **argv arrays, never shell strings.** See §6.
- **No TCC permission prompt on the startup path.** Anything needing an
  Accessibility, Automation or Screen Recording grant must be triggered by an
  explicit user action and must degrade when denied. See SECURITY.md.
- **Three persisted identifiers are wire protocol, not branding.** `HOOK_MARKER`
  (`hookServer.ts`) lives in the user's real `~/.claude/settings.json`;
  `BACKUP_PATH` (`hookInstaller.ts`) is the pristine pre-install copy of that
  file; `appId` (`electron-builder.yml`) decides `app.getPath('userData')` and must
  stay byte-identical to `setAppUserModelId` in `index.ts`. They look like
  leftover branding. They are not. `npm run test:hook-migration` pins the
  behaviour.
- **A red `windows-latest` leg is never acceptable, even when macOS is green.**
  Windows is the platform users have today.

## 4. Ground rules for changes

You may add files under `src/main/platform/darwin/`, and you may edit
`platform/types.ts` **only by adding** members. If you believe a shared file must
change, open an issue first — that boundary is what makes this reviewable by
someone who cannot run your code.

Every PR should name the section number below that it closes, and paste the output
of the check suite run **on a Mac**. The author cannot reproduce it, so that paste
is the evidence.

```sh
npm run typecheck
npm run test:status-flash
npm run test:pill-geometry
npm run test:interactions
npm run test:platform-contract
npm run test:hook-migration
npm run test:tray-icons     # runs under Electron
npm run bugs:test
```

**`npm run test:platform-contract` is the one to run first and most often.** It
imports *both* platform trees directly, so it holds the darwin implementations to
the rules in §2 while running on Windows — which is the only way the author can
check your work at all. It already caught a real permissiveness bug in
`darwin/paths.ts`. It also enforces the §6 security invariant, so it fails an
interpolating terminal implementation before review does.

Because `agentPlans` is pure, tests pin one platform's argv while running on the
other: `testPillGeometry.ts` passes `win32Platform.overlay`, and
`testInteractions.ts` passes `win32Platform.terminal` to `ManagedCodexService`.
Follow that pattern rather than gating a test to one OS.

`npm run verify` is **not** side-effect-free — it installs and uninstalls hooks in
your real `~/.claude/settings.json`. Run it deliberately, and check it restores
cleanly.

---

## 5. Work items

Roughly in dependency order. §9 is the one you should not do.

### §1 — `npm run dev` launches

Fix only what prevents launch, and report the actual failure list. This is the
acceptance test for §2 above.

### §2 — Overlay geometry and window behaviour

`darwin/overlay.ts`. The highest-risk item after §6, and the one the author
cannot see at all.

- `windowOptions()` returns `type: 'panel'`. Verify it against what `windows.ts`
  already applies unconditionally: `setAlwaysOnTop(true, 'screen-saver')` and
  `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true})`. Those interact
  with Spaces and fullscreen differently here than on Windows.
- `pillArea()` currently returns `display.workArea`. That excludes the menu bar
  and Dock, which is the right first approximation and is why it is not
  `display.bounds` — win32 returns `bounds` on purpose, because the notch is
  *meant* to sit over the taskbar.
- **The open question: a MacBook with a real notch.** `workArea` on a notched
  display spans the full width including the strip beside the camera, so a
  top-centre 276px pill may sit partly *inside* the housing. **Report what you
  observe with a screenshot before changing any default.** The fix belongs in
  `pillArea()`, not in `NOTCH_POSITION_PRESETS` — those are shared with Windows
  and also feed drag snapping (`windows.ts`).
- Hover-to-expand should work on day one: it is driven by a 200ms
  `screen.getCursorScreenPoint()` poll, not by `setIgnoreMouseEvents`'s `forward`
  flag, precisely because Windows could not be relied on to forward events. That
  poll is fully cross-platform.
- Check dragging across two displays with different `scaleFactor`s.
- `app.dock?.hide()` is already called in `afterCreate`, matching `LSUIElement` in
  the packaged Info.plist. Confirm the app stays out of the Dock and Cmd-Tab in
  both dev and packaged builds.

### §3 — Tray

`darwin/tray.ts`. The pixel math is shared in `src/main/trayRender.ts`; only the
size, palette and template decision are per-platform.

`template: false` is deliberate. `setTemplateImage(true)` reduces an image to its
alpha channel so macOS can recolour it, which would **discard the status colour** —
and the colour is the entire product. The cost is that the icon does not invert
when the menu-bar item is highlighted. Confirm it reads correctly on a light menu
bar; if it does not, the fallback is a template glyph with the colour carried in
the menu title, not a coloured template image.

`supportsTooltip: false` is already handled: macOS shows no tray tooltips, and
`NotchTray` already puts the summary in the first (disabled) menu item.

### §4 — Autostart

`darwin/autostart.ts` should already be correct: `setLoginItemSettings({openAtLogin})`
with **no** `path`, because `process.execPath` on macOS points at the helper binary
inside the bundle rather than the `.app`. Verify on a packaged build —
`applyLoginSetting` early-returns when `!app.isPackaged`.

### §5 — Codex TUI process enumeration

`darwin/processes.ts`. Implement with `ps -axo pid=,etime=,command=`, filtering for
`codex` and excluding `app-server` with the same regex win32 uses.

Prefer `etime=` (elapsed, relative) over `lstart=` (absolute, localised).
`matchCodexTuiProcesses` in `sessionWatcher.ts` pairs a process to a rollout inside
a **60-second window**, so a timezone-off parse does not error — it attaches the
**wrong PID** to a session, and "End" then kills someone else's agent.

`matchCodexTuiProcesses` is already pure and exported. A parse test with real `ps`
output pasted in as a fixture is required.

Until it works, keep returning `null`. See rule 3.

### §6 — Terminal launching — the PR that needs the most review

`darwin/terminal.ts`. **This is the highest-severity risk in the port.**

Today nothing in this app builds a shell string. `dispatcher.ts` calls
`spawnDetached(exe, argvArray)`, and the Windows PowerShell fallback
base64-decodes every user-controlled value *inside* a fixed program rather than
interpolating it (`win32/terminal.ts`).

AppleScript's `do script` takes a shell string, which invites
`cd <cwd> && claude "<prompt>"`. Prompts routinely contain quotes, `;`, `$(` and
newlines — the existing test literally uses `'prompt with spaces\nand "quotes"'` —
and prompts can arrive **from the mobile bridge**. Interpolating them is remote
command injection.

Follow the shape: write argv to a `0600` temp file and have the launched shell
`exec "$@"` from it, mirroring the encoding technique already in
`win32/terminal.ts`. Do not interpolate.

**Required, not optional:** a test in `testInteractions.ts` that feeds a prompt
containing `"; rm -rf ~ #` and `$(id)` and asserts those bytes appear nowhere in
the returned `LaunchPlan` except inside an opaque encoded blob. That test is the
guardrail; this section is only its justification.

Other notes:

- `agentPlans` / `pairPlans` must stay **pure** — no spawning, no fs, no probing.
  That is what lets the Windows argv assertions in `verify.ts` and
  `testInteractions.ts` keep passing on a Mac. If you add iTerm2 detection, decide
  the plan *order* at module load, not inside the calls.
- Terminal.app has no panes, so `pairPlans` degrades to two windows and
  `supportsSplitPane` stays `false`. The renderer already says so. iTerm2 does have
  panes (`split vertically with same profile`) if you want the better path.
- Returning `[]` means "no terminal integration", and `dispatcher.ts` turns that
  into a typed failure rather than spawning anything.

### §7 — Focus a session's window

`darwin/focus.ts`. The reachable half: walk the parent chain with
`ps -o ppid= -p <pid>` to find the owning terminal, then activate that application
with `osascript -e 'tell application id "…" to activate'`.

That brings the *application* forward, which is all the Windows implementation
honestly claims either — its own message says "the exact terminal tab is
best-effort". Focusing a specific window or tab needs the Accessibility API and its
TCC prompt: **do not request it.** Document the limitation instead.

### §8 — Packaging

`electron-builder.yml` already has a `mac` block; read its comments first.

- `identity: null` plus `scripts/adhocSignMac.cjs`, because arm64 macOS refuses to
  execute a *wholly* unsigned binary. **`adhocSignMac.cjs` has never been
  executed** — it and `darwin/overlay.ts` are the two things to verify first.
- **Do not enable `hardenedRuntime`, entitlements, or notarization.** All three
  need an Apple Developer ID this project does not have. A PR adding one will be
  closed.
- Confirm `npm run dist:mac` produces a `.dmg` that actually launches after the
  quarantine dance, and confirm the README's instructions match what you see.
- There is no `.icns`: electron-builder derives it from `build/icon.png` (512px).

### §9 — Claude Design detection: DO NOT IMPLEMENT

This looks like a stub. It is a decision.

Claude Design writes nothing locally, so an exact match on the window **title** is
the only signal it exists. macOS redacts `kCGWindowName` for other applications
unless the app holds **Screen Recording** permission (10.15+), and the
Accessibility route needs its own grant.

The reason this is permanent rather than merely unimplemented: **TCC grants are
keyed to the code-signing identity, and this app is ad-hoc signed.** The signature
changes on every rebuild, so the grant would be silently revoked on every update.
That means asking users to re-authorise Screen Recording after every release, to
get a presence dot.

`darwin/designWindows.ts` is `supported: false` with an **empty**
`unsupportedReason`, and the empty string is deliberate: a non-empty reason renders
as a red error notice in `Sessions.tsx`, and a permanent error bar on every launch
for a feature the platform will never have reads as a broken app. The renderer
hides the affordance via `PlatformInfo.features.designWindows` instead.

## 6. Also out of scope

- Anything requiring an Apple Developer account: notarization, hardened runtime,
  entitlements, a signed installer.
- Auto-update. The project has none on either platform; releases are manual.
- Linux. `platform/index.ts` shows an error dialog and exits.
- `scripts/manageLauncher.ts` — a Windows-only development convenience (a Start
  menu `.lnk`). It already refuses to run elsewhere. `npm run dev` is the
  equivalent.
