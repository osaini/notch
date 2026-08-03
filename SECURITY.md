# Security

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/osaini/notch/security/advisories/new)
rather than opening a public issue. Expect an initial response within a week.

## Threat model

Read this before installing. Notch is a control surface for coding agents, and
several of its features exist specifically to *reduce* friction around approval
prompts. That is useful and it is also the risk.

### What the app can do on your machine

- **Launches agents in terminals.** The Dispatch tab spawns `claude`, `codex`,
  or a pair of them via `wt.exe` in a directory you choose, and it can request
  `bypassPermissions` / `--dangerously-bypass-approvals-and-sandbox`. Anything
  that can drive the renderer can therefore run code as you, in any directory.
  Arguments are always passed as an argv array, never as a shell string, so
  prompt text cannot inject extra commands — but the dispatch itself is real.
- **Edits `~/.claude/settings.json`.** Turning on Permission controls installs
  hook entries pointing at a local listener. A one-time pristine backup is
  written first, and uninstalling restores it.
- **Reads your Claude credentials.** The Usage tab reads the OAuth token from
  `~/.claude/.credentials.json` to call `https://api.anthropic.com`. That is
  the only outbound host the app contacts. There is no telemetry.
- **Reads session transcripts** under `~/.claude` to derive status and usage.

### The phone companion is off by default

`Settings → Phone companion → Allow phone access` starts an HTTP server bound
to **all interfaces**, not just loopback. When it is on:

- A paired phone can dispatch agents and send messages to running sessions,
  using `--permission-mode dontAsk` and `approval_policy="never"`. Pairing a
  device grants it unattended code execution in your projects.
- Traffic is **plain HTTP**. The device token travels in cleartext over your
  network on every request. Anyone who can observe the segment can replay it
  until the token expires (30 days).
- Pairing uses a 6-digit code with a 10-minute lifetime, rate limited to 8
  attempts per IP per 5 minutes and 24 attempts globally per issued code.
  Device tokens are stored SHA-256 hashed.

Only enable it on a network you trust, and never port-forward it or expose it
through a tunnel. `Unpair all phones` revokes every device immediately.

### Hardening already in place

For anyone auditing the Electron surface:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- The preload exposes a hand-written API over `contextBridge`. There is no
  generic `ipcRenderer.invoke` passthrough — every channel is named explicitly.
- `will-navigate` and `setWindowOpenHandler` both deny, and `shell.openExternal`
  accepts only `http:`, `https:`, and `mailto:`.
- Deny-all permission handler on the default session, except clipboard writes.
- CSP on the renderer document and as a real response header on the bridge.
- The hook listener binds `127.0.0.1` only, requires a `timingSafeEqual` token,
  rejects requests carrying an `Origin`, and requires a loopback `Host` (which
  is what blocks DNS rebinding).

### Out of scope

The app trusts the local user and anything already running as them. A
compromised `claude` or `codex` binary, a malicious `~/.claude/settings.json`,
or another process on your machine are all outside what this app can defend
against.
