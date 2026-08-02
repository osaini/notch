# Notch mobile bridge

Implemented in `src/main/mobileBridge.ts`. The desktop app serves `mobile/dist` and the API from one
origin. Authentication uses an HttpOnly cookie instead of exposing a bearer token to browser
JavaScript.

## Pairing and transport

1. The desktop Settings tab shows private-network URLs and a short-lived six-digit pairing code.
2. The phone opens that URL and posts the code plus a user-visible device name.
3. The bridge sets a random, revocable, HttpOnly, SameSite=Strict session cookie.
4. All API and server-sent-event requests require that cookie.
5. The server listens on port `47822` (walking forward if occupied). It is never unauthenticated:
   snapshot, transcript, dispatch, follow-up, and event routes all require a paired device.

The bridge rejects unsafe cross-origin writes, caps request bodies, rate-limits pairing attempts,
expires pairing codes, restricts dispatch to the computer-owned project list, and stores only a hash
of each device credential. The Settings tab can revoke all paired phones.

The current transport is HTTP so it should only be used on a trusted private LAN or private overlay
network. TLS is required before exposing it to the public internet.

## HTTP API

All routes are under `/api/v1`.

### `GET /snapshot`

Returns:

```json
{
  "computerName": "Studio PC",
  "connected": true,
  "sessions": [
    {
      "key": "claude:session-id",
      "agent": "claude",
      "name": "Mobile companion",
      "project": "windows-notch",
      "path": "C:\\Projects\\windows-notch",
      "status": "working",
      "detail": "Building the mobile dashboard",
      "updatedAt": 1785280000000,
      "canMessage": true
    }
  ],
  "projects": [
    { "name": "windows-notch", "path": "C:\\Projects\\windows-notch" }
  ]
}
```

`status` is `working`, `idle`, `needs-input`, or `reviewing`. `canMessage` must be false when Notch
can observe a session but has no safe input channel.

### `GET /sessions/:key/messages`

Returns a JSON array:

```json
[
  {
    "id": "message-id",
    "role": "agent",
    "text": "I found the failing test.",
    "createdAt": 1785280000000
  }
]
```

Transcript content must be normalized on the computer. Do not send raw transcript records, tool
credentials, hidden reasoning, or environment variables to the phone.

### `POST /sessions/:key/messages`

Body: `{ "text": "Run the focused test first." }`

Returns the accepted user message. Idle Claude sessions resume through `claude -p --resume` with
`dontAsk`; idle Codex sessions resume through `codex exec resume` with workspace sandboxing and no
interactive approvals. The route returns `409` for read-only or currently-working sessions and
`410` when a session no longer exists.

### `POST /dispatch`

Body:

```json
{
  "agent": "claude",
  "cwd": "C:\\Projects\\windows-notch",
  "prompt": "Run the verification suite."
}
```

Returns the new session summary. `cwd` must match an exact path from the server-owned project list;
never accept an arbitrary phone-provided working directory without validation.

### `GET /events`

Server-sent event stream. Send complete snapshots to keep the phone client simple:

```text
event: snapshot
data: {"computerName":"Studio PC","connected":true,"sessions":[],"projects":[]}
```

The bridge sends a comment heartbeat every 20 seconds.

## Future permission route

Do not expose this until the agent-specific response formats and timeout behavior have been verified:

`POST /questions/:id/decision` with `{ "decision": "allow" | "deny" }`.

The computer remains the authority. Decisions must be scoped to one pending question, expire
quickly, be auditable locally, and fall back to the terminal when the phone does not answer.
