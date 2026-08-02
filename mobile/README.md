# Notch Mobile

Phone companion for Windows Notch. It connects to the authenticated bridge hosted by the Electron
app. The manifest is PWA-ready; service-worker installation and offline shell caching require an
HTTPS origin when opened from a phone.

Start Windows Notch:

```powershell
npm start
```

The Settings tab shows phone URLs and a short-lived six-digit pairing code. Open a listed URL on a
phone connected to the same private network and enter that code. The Electron bridge serves the
production PWA itself, normally on port `47822`.

For mobile UI development with hot reload:

```powershell
npm --prefix mobile run dev
```

Open `http://localhost:4174`. Vite proxies `/api` to the Electron bridge. Live mode is the default;
add `?demo=1` only when you intentionally want simulated data.

Production:

```powershell
npm --prefix mobile run build
npm --prefix mobile run preview
```

The production service worker caches only the application shell. API responses and agent data are
never cached.

The current bridge uses authenticated HTTP. Use it only on a trusted private LAN or through a
private overlay network. Public-internet exposure and full PWA installation require TLS and are
deliberately not enabled by this bridge.
