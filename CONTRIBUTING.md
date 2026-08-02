# Contributing

## Prerequisites

- Windows 10 or 11 (the app is Windows-only by design — see "Deliberately not
  included" in the README)
- Node 22+
- [Claude Code](https://claude.com/claude-code); optionally the Codex CLI
- Windows Terminal (`wt.exe`) for dispatch. There is a PowerShell fallback, but
  the primary path assumes `wt`.

## Getting started

```powershell
npm install
npm run icons     # generates build/icon.ico and build/icon.png from build/icon.svg
npm run dev
```

`npm run dev` runs electron-vite with hot reload. To run a production build
locally instead:

```powershell
npm run build
npm run launcher:install   # Start-menu shortcut pointing at this checkout
```

The shortcut targets the repo's own Electron binary with the repo as its
argument, so it always launches whatever is in `out/` — no reinstall needed
after a rebuild.

## Checks

Run these before opening a pull request:

```powershell
npm run typecheck          # main, renderer, and scripts
npm run test:status-flash
npm run test:pill-geometry
npm run test:interactions
npm run test:tray-icons    # runs under Electron
npm run bugs:test          # debug-orchestrator unit tests
```

CI runs all of the above on `windows-latest`.

### `npm run verify` is not side-effect-free

It exercises the real subsystems against your actual `~/.claude` directory,
including **installing and uninstalling hooks in `~/.claude/settings.json`**.
Run it deliberately, on your own machine, and check that it restores cleanly.
It is deliberately excluded from CI.

## Packaging

```powershell
npm run package   # unpacked build in release/win-unpacked
npm run dist      # NSIS installer in release/
```

Two things about the Windows build that look wrong and are not:

- **`signAndEditExecutable: false`.** electron-builder's rcedit step needs
  symlink privileges to unpack its archive, which is not a reasonable thing to
  require of a contributor. `scripts/stampExecutableIcon.cjs` runs as an
  `afterPack` hook and applies the icon with `resedit` in pure JS instead.
  Please don't re-enable rcedit without checking that a non-elevated build
  still works.
- **The installer is unsigned.** SmartScreen will show "Windows protected your
  PC" on first run; "More info" → "Run anyway" proceeds. Signing needs a
  certificate the project does not have.

## Code style

There is no linter config — match the surrounding code. Two things worth
knowing, because they are load-bearing rather than stylistic:

- **Comments explain *why*.** The codebase leans on them for the non-obvious
  mechanics (window geometry, the drag physics, hook timeouts). Follow that.
- **Validate at the IPC boundary.** Anything crossing from the renderer into
  `src/main` gets shape-checked in main, not just typed. See
  `parseDispatchRequest` in `src/main/index.ts`.

If you are touching the mobile bridge or the dispatcher, read
[SECURITY.md](SECURITY.md) first — both are deliberately powerful, and changes
there need to keep the guarantees that file describes.
