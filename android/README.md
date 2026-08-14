# Notch companion for Android

A native client for the phone companion bridge. It talks to the same
`/api/v1` REST + SSE surface documented in [`../docs/mobile-bridge.md`](../docs/mobile-bridge.md)
that the web client in [`../mobile`](../mobile) uses — there is no second protocol.

## Why this exists alongside the PWA

One reason, really: **notifications when an agent needs input**. An installed
PWA cannot do that here. Web Push requires a cloud push service to deliver
through, and the bridge is a LAN-only server with no internet presence to route
from; on top of that a service worker will not install over plain HTTP at all,
which is what the bridge speaks. A foreground service holding the SSE stream is
the supported way to get a phone to buzz when a session starts waiting.

The rest — QR pairing, a saved server address, no browser chrome — the PWA can
approximate. If you do not want background alerts, the web client is less to
install and is not going anywhere.

## Building

This is a standalone Gradle build. Nothing in the npm build depends on it, and
it is not part of CI — the repo's "exactly one runtime dependency" rule governs
what ships inside `Notch.exe`, not this directory.

Requirements: JDK 17 and an Android SDK with platform 35 and build-tools 35.

```bash
# Point the build at your SDK (gitignored; regenerate per machine).
echo "sdk.dir=/path/to/Android/Sdk" > local.properties

./gradlew assembleDebug
```

The APK lands at `app/build/outputs/apk/debug/app-debug.apk` (~10 MB).

### Installing it

With the phone connected over USB debugging or wireless debugging:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Or copy the APK to the phone and open it — Android will ask you to allow
installs from that source. It is signed with the local debug key, so it is a
sideload, not a Play install; there is no release signing config here.

## Using it

1. In Notch on the desktop: **Settings → Phone companion → Allow phone access**.
2. In the app: **Scan QR code**, and point it at the QR in that Settings card.
   That fills in both the computer's address and the pairing code.
3. Name the phone and tap **Pair phone**.
4. To get alerts, turn on **Notify me when an agent needs input** in the app's
   Settings. Android will ask for notification permission, and an ongoing
   low-priority notification appears while the connection is held — that is
   required for a foreground service, not optional.

Manual entry is there for a phone with no usable camera; the address is the same
one the desktop lists under the QR.

## Layout

```
app/src/main/java/dev/notch/companion/
  MainActivity.kt          screen switching, notification permission, service toggle
  data/
    Models.kt              payload mirrors, parsed with org.json
    NotchStore.kt          saved address + device token, and the OkHttp cookie jar
    NotchClient.kt         the /api/v1 calls
    SnapshotStream.kt      SSE reader with reconnect/backoff
    NotchRepository.kt     the single shared connection
  service/NotchService.kt  foreground service; raises the needs-input alert
  ui/                      Compose screens
res/xml/network_security_config.xml
```

## Notes for anyone changing this

- **Cleartext is scoped on purpose.** Android's network-security schema cannot
  express RFC1918 or CGNAT ranges, so `network_security_config.xml` enables the
  transport and `NotchClient` rejects any plain-HTTP host outside RFC1918,
  RFC6598 and loopback before opening a socket. A public host still needs TLS.
- **No `Origin` header is sent, and that is fine.** The bridge's
  `assertSafeOrigin()` returns early when `Origin` is absent — the check exists
  to stop other *web pages* forging requests, and there is no browser here.
- **One SSE stream per process.** `NotchRepository` is a singleton because the
  activity and the service both need the snapshot; two streams would double the
  desktop's broadcast work and let the two disagree about what needs input.
- **The transcript polls, the session list does not.** SSE carries session
  status, not message bodies, so `SessionScreen` polls `/messages` while open.
- Dispatch is a project *picker*, not a path field: the desktop rejects any cwd
  outside the list it sent, so a free-form path could only ever produce a 403.
