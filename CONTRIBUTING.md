# Contributing

## Supported platforms

Windows is the platform this app shipped on and the one it is verified against.
macOS support is **in progress**: everything platform-specific now sits behind
`src/main/platform/`, with `win32/` complete and `darwin/` a set of typed stubs.

If you are working on the macOS side, read [PORTING.md](PORTING.md) first. Several
of the obvious implementations are wrong in ways that are silent, and that file
says which and why.

Linux is not supported; the app shows an error dialog and exits.

## Prerequisites

- Windows 10 or 11, or macOS
- Node 22+
- [Claude Code](https://claude.com/claude-code); optionally the Codex CLI
- A terminal for dispatch. On Windows that is Windows Terminal (`wt.exe`), with a
  safely encoded PowerShell fallback; the primary path assumes `wt`.

## Getting started

```sh
npm install
npm run dev
```

`npm run icons` is deliberately **not** part of this. `build/icon.svg`, `icon.ico`
and `icon.png` are all committed, so a fresh checkout needs no rasterizer. Run it
by hand only when you change the SVG, and commit the regenerated files — CI fails a
pull request that changes one without the other.

`npm run dev` runs electron-vite with hot reload. To run a production build
locally instead:

```sh
npm run build
npm run launcher:install   # Windows only: Start-menu shortcut for this checkout
```

The shortcut targets the repo's own Electron binary with the repo as its
argument, so it always launches whatever is in `out/` — no reinstall needed
after a rebuild. It is a Windows-only convenience and refuses to run elsewhere;
on macOS use `npm run dev`.

## Checks

Run these before opening a pull request:

```sh
npm run typecheck            # main, renderer, and scripts
npm run test:status-flash
npm run test:pill-geometry
npm run test:interactions
npm run test:platform-contract  # both platforms' contracts, on either OS
npm run test:hook-migration     # the 0.1.x -> 0.2.0 hook marker migration
npm run test:tray-icons      # runs under Electron
npm run bugs:test            # debug-orchestrator unit tests
```

CI runs all of the above on `windows-latest` **and** `macos-latest`, with
`fail-fast` disabled so one platform's failure never hides the other's. A red
Windows leg is never acceptable, even when macOS is green.

### No native dependencies

Runtime `dependencies` must stay exactly `["ws"]`, and CI enforces it. Having no
native addons is what lets the same source run on both platforms with nothing to
recompile — `active-win`, `sharp` and `node-mac-permissions` are all off the table.
If you think you need one, open an issue first.

### `npm run verify` is not side-effect-free

It exercises the real subsystems against your actual `~/.claude` directory,
including **installing and uninstalling hooks in `~/.claude/settings.json`**.
Run it deliberately, on your own machine, and check that it restores cleanly.
It is deliberately excluded from CI.

## Packaging

```sh
npm run package    # unpacked build for the host platform, in release/
npm run dist       # installer for the host platform
npm run dist:win   # force the Windows target
npm run dist:mac   # force the macOS target
```

The configuration lives in `electron-builder.yml` rather than `package.json`
specifically so it can carry comments — several settings look wrong and are not.
Read them before changing any of them. In particular, `appId` is a persisted
identity, not a name: it decides `app.getPath('userData')`, so changing it orphans
the user's settings, usage cache and paired phones.

Things that look wrong and are not:

- **`signAndEditExecutable: false`** (Windows). electron-builder's rcedit step
  needs symlink privileges to unpack its archive, which is not a reasonable thing
  to require of a contributor. `scripts/stampExecutableIcon.cjs` runs from the
  `afterPack` dispatcher and applies the icon with `resedit` in pure JS instead.
  Please don't re-enable rcedit without checking that a non-elevated build
  still works.
- **The Windows installer is unsigned.** SmartScreen will show "Windows protected
  your PC" on first run; "More info" → "Run anyway" proceeds. Signing needs a
  certificate the project does not have.
- **`identity: null` plus an ad-hoc `codesign`** (macOS). There is no Apple
  Developer ID, and arm64 macOS refuses to execute a *wholly* unsigned binary — so
  "unsigned" here has to mean "signed with the ad-hoc identity", which asserts
  nothing and needs no certificate. `scripts/adhocSignMac.cjs` does that in
  `afterPack`. **Do not enable `hardenedRuntime`, entitlements, or notarization**:
  all three require a Developer ID, and turning them on produces failures that
  look like configuration bugs.
- **The macOS icon is a PNG, not an `.icns`.** electron-builder derives the `.icns`
  from any ≥512px PNG, so there is nothing to generate or keep in sync.

## Code style

There is no linter config — match the surrounding code. Two things worth
knowing, because they are load-bearing rather than stylistic:

- **Comments explain *why*.** The codebase leans on them for the non-obvious
  mechanics (window geometry, the drag physics, hook timeouts). Follow that.
- **Validate at the IPC boundary.** Anything crossing from the renderer into
  `src/main` gets shape-checked in main, not just typed. See
  `parseDispatchRequest` in `src/main/index.ts`.

New platform-specific behaviour belongs in `src/main/platform/`, not in a
`process.platform` check at the call site. `platform/index.ts` is meant to be the
only place in the app that branches on the OS.

If you are touching the mobile bridge or the dispatcher, read
[SECURITY.md](SECURITY.md) first — both are deliberately powerful, and changes
there need to keep the guarantees that file describes.
