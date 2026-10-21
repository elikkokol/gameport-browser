# GamePort Browser

A lightweight desktop browser built on Electron (Chromium). Every page request goes through a local port you configure, either a proxy this app runs for you or one you already have.

> Using GitHub? See [GITHUB.md](GITHUB.md) for automatic tests, downloadable installers, and running it in Codespaces.

## What you get

| Requirement | How it is met |
|---|---|
| HTML5, WebGL, Canvas | Chromium's GPU pipeline. The app turns on GPU rasterization and zero-copy and ignores the GPU blocklist so WebGL runs on more machines. |
| H.264, MP4, WebM, MSE | Electron's Chromium build includes the proprietary codecs (H.264, AAC) as well as VP8, VP9, AV1 and Opus. MSE is part of Chromium. |
| WebSockets | `ws://` and `wss://` travel through `CONNECT` tunnels in the proxy, so frames are never parsed or buffered. `TCP_NODELAY` is on for low latency. |
| Port routing | Built-in proxy (default `127.0.0.1:8080`) or an external proxy. The route is fixed with no fallback, so if the proxy is down, pages fail instead of going out directly. |
| Tabs, navigation, URL bar | Tabs (new, close, switch, middle-click close), Back, Forward, Reload/Stop, Home, and an address bar that adds `https://` (or `http://` for localhost and IPs) or searches. |
| Media controls, mute | Per-tab mute (toolbar button and speaker icon on tabs that are playing sound) plus a play/pause button for the page's `<video>`/`<audio>`. |
| Sandboxing, low resource use | See "Security and resources" below. |

## 1. Prerequisites

- **Node.js 20 or newer** (22 LTS recommended) with npm. Check with `node --version`.
- **Windows 10+, macOS 12+, or a desktop Linux** with a graphical session.
- **Linux only:** Electron needs a few system libraries. On Debian/Ubuntu:
  `sudo apt install libgtk-3-0 libnss3 libasound2t64 libxss1 libgbm1` (on older releases the package is `libasound2`).
- Up-to-date GPU drivers, for WebGL performance.

## 2. Install and run

```bash
cd gameport-browser
npm install        # downloads Electron (about 100 MB)
npm start
```

The window opens and the toolbar chip shows `Proxy 127.0.0.1:8080` with a green dot when the built-in proxy is up. If the chip is red, hover it for the reason (most often the port is already in use).

Command-line overrides (handy for scripts):

```bash
npm start -- --proxy-port=9090
npm start -- --proxy-mode=external --proxy-host=127.0.0.1 --proxy-port=8888
npm start -- --config=./my-config.json
```

## 3. Configure the port

**From the UI:** click the chip or the gear (Ctrl+,). Choose a route:

- **Built-in proxy**: the app listens on host:port and forwards everything. Optionally chain it to another proxy.
- **External proxy**: send traffic to a proxy already running on host:port (mitmproxy, Squid, a corporate proxy, an SSH `-D`-style HTTP bridge, and so on).
- **Direct**: no proxy.

Changes apply immediately: the proxy restarts and open connections are reset.

**From the file:** settings live in `config.json` in Electron's user-data folder
(Windows `%APPDATA%\gameport-browser`, macOS `~/Library/Application Support/gameport-browser`, Linux `~/.config/gameport-browser`), or at the path you pass with `--config=`. Defaults:

```json
{
  "homepage": "https://duckduckgo.com",
  "searchEngine": "https://duckduckgo.com/?q=%s",
  "network": {
    "mode": "builtin",
    "host": "127.0.0.1",
    "port": 8080,
    "upstream": { "enabled": false, "host": "", "port": 0 },
    "bypass": "<local>",
    "blockedHosts": [],
    "logRequests": false,
    "blockWebRTCLeak": true
  },
  "performance": { "sleepAfterMinutes": 10, "hardwareAcceleration": true },
  "permissions": ["fullscreen", "pointerLock", "clipboard-sanitized-write", "keyboardLock"]
}
```

Notes:
- Keep `host` at `127.0.0.1`. Binding to `0.0.0.0` lets other machines on your network use the proxy, and it has no authentication.
- `bypass` uses Chromium's rules. `<local>` sends single-label hosts such as `localhost` direct. Use `<-loopback>` to push localhost through the proxy too.
- The built-in proxy only handles HTTP and `CONNECT`. An external proxy must support `CONNECT` for HTTPS and WebSockets to work.

## 4. Test it

**Proxy backend (no GUI needed):**

```bash
npm test
```

This starts the proxy plus a test web server and TCP echo server and checks HTTP forwarding, `CONNECT` tunnels (the mechanism behind HTTPS and WebSockets), upstream chaining, the blocklist, loop protection and error handling.

**In the browser:**

1. Set `"logRequests": true` under `network` in `config.json`, run `npm start`, and browse. Every request and tunnel the built-in proxy handles is printed in the terminal.
2. Open **Help > Run capability self-test** (press Alt, or use the menu). It reports WebGL 1/2 and the GPU in use, Canvas, H.264/VP9/AV1/Opus support, MSE support, and measures frames per second. It also has a WebSocket box: paste a `wss://` game-server address to confirm real-time traffic works through your route.
3. Stop the built-in proxy (set an external port with nothing listening). Pages should fail with the "This page didn't load" screen, proving nothing leaks around the proxy.

## 5. Build installers

```bash
npm run dist
```

Output goes to `dist/`: an NSIS installer on Windows, a DMG on macOS, and AppImage plus deb on Linux. Build on the OS you are targeting. Unsigned builds trigger an OS warning; code-signing is configured through electron-builder environment variables.

## Security and resources

- **Sandbox:** every page runs in a sandboxed Chromium renderer with `nodeIntegration` off and `contextIsolation` on. Pages never see Node, and the browser UI exposes only a small whitelisted API that the main process also checks the sender of.
- **Navigation:** only `http`, `https` and `about:blank` can be opened. Pop-ups open as new tabs; `file:`, `javascript:` and other schemes are refused.
- **Permissions:** deny by default. Only the entries in `permissions` are granted (add `"media"` for camera/microphone, or tick the box in Settings).
- **Leak protection:** the route has no direct fallback, and WebRTC's non-proxied UDP is disabled while a proxy is in use (turn this off in Settings if a game needs WebRTC).
- **Memory:** background tabs are throttled by Chromium, and tabs idle for `sleepAfterMinutes` are fully unloaded and reload when clicked (shown in italics). Tabs that are playing sound are never put to sleep. A sleeping tab loses in-page state and back/forward history, so set it to `0` if you keep games open in background tabs.
- **Fullscreen:** a page's fullscreen request (games, video) takes over the whole window with no browser UI.

## Known limits

- **DRM video** (Netflix, Disney+, and similar) needs Widevine, which stock Electron does not include. YouTube and other non-DRM streaming work.
- **Pop-up sign-in flows** that rely on `window.opener` will not complete because pop-ups open as ordinary tabs.
- **HTTPS-first typing:** the address bar adds `https://` for bare domains. If a site only serves HTTP, type `http://` explicitly.
- **No bookmarks, history page, or extensions.** This is deliberately minimal.

## Project layout

```
src/main/main.js     window, tabs, sandbox settings, proxy wiring, sleeping tabs, IPC
src/main/proxy.js    forward proxy (HTTP, CONNECT, chaining, blocklist, stats)
src/main/config.js   config file, validation, CLI overrides
src/ui/              browser chrome (index.html, styles.css, renderer.js, preload.js)
src/ui/selftest.html capability self-test page
scripts/test-proxy.js  proxy integration test
```
