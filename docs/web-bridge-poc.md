# Orca Web Bridge — Proof of Concept

This branch demonstrates running the Orca renderer in a **regular browser** with
the backend on a **remote machine** — no Electron required on the client. The
existing renderer code runs unchanged; the existing `src/preload/index.ts`
becomes the browser shim by way of two small substitutions made at build time.

It's a one-shot PoC: the renderer mounts, the layout renders, IPC calls
round-trip over WebSocket. Several feature areas still need real plumbing
(PTY data streams, file drag-drop, native dialogs), but the architectural
question — "can the renderer talk to a remote backend over a stable bridge?"
— is answered yes.

## How it works

```
┌─────────────────────────────┐           ┌─────────────────────────────┐
│  Browser                    │  HTTP/WS  │  Linux/Mac/Win backend      │
│  ──────────                 │ ◀───────▶ │  ───────────────────────    │
│  React renderer (vanilla)   │           │  Electron main process,     │
│  window.api ─ WS shim       │           │  ipcMain.handle registry,   │
│  window.electron ─ WS shim  │           │  WebGateway broadcasts      │
│  webFrame/webUtils stubs    │           │  webContents.send events    │
└─────────────────────────────┘           └─────────────────────────────┘
```

### Frontend (`src/web-bridge/`)
- `electron-shim.ts` — browser polyfill for `contextBridge`, `ipcRenderer`,
  `webFrame`, `webUtils`. Vite aliases `electron` → this file when building
  the web bundle (`config/vite.web.config.ts`).
- `electron-toolkit-preload-shim.ts` — same trick for
  `@electron-toolkit/preload`'s `electronAPI`.
- `ws-bridge.ts` — single WebSocket client that multiplexes
  `invoke / send / subscribe / unsubscribe` over one connection.
- `process-shim.ts` — minimal `window.process` so the preload's
  `process.contextIsolated` branch picks the right path.
- `main.tsx` — bundle entry. Imports the polyfills, then the preload (which
  populates `window.api` and `window.electron`), then the existing renderer.

Result: **the same `src/preload/index.ts` ships to both Electron and the
browser** — no code duplication.

### Backend (`src/main/web-gateway/`)
- `ipc-intercept.ts` — wraps `ipcMain.handle` / `ipcMain.on` so every
  registration mirrors into a parallel registry the gateway can dispatch into.
  Also patches `WebContents.prototype.send` so any main → renderer event also
  fans out to subscribed WebSocket clients.
- `server.ts` — HTTP server (static SPA + `/__orca/health`) plus a
  `/__orca/ws` WebSocket endpoint that speaks the same wire protocol as the
  browser shim. Optional shared-token auth via `ORCA_WEB_TOKEN`.
- Wired into `src/main/index.ts` behind `ORCA_WEB_GATEWAY=1`.

### Mock backend (`src/web-bridge/mock-server.ts`)
A standalone Node process that speaks the same wire protocol but returns stub
data. It exists so the PoC can be exercised on a Linux server without a
display — running full Electron headless on a host without xvfb hits a Gtk
init wall plus a daemon-startup failure. The mock is the smallest thing that
proves the renderer side of the bridge.

## Running

The shippable path serves the renderer through the real Electron backend
running in headless mode — no display, no Xvfb needed on the server:

```bash
# One command — build both bundles, start the server.
pnpm web:all

# Or split steps for an iterative dev loop:
pnpm web:build                # rebuild renderer
pnpm build:electron-vite      # rebuild main
pnpm web:serve                # start the backend
```

Then open `http://<server-host>:8080/` in any browser.

Configuration env vars consumed by `web:serve`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORCA_WEB_PORT` | `8080` | HTTP/WS port |
| `ORCA_WEB_TOKEN` | (none) | Optional shared bearer token |
| `ORCA_WEB_PICKER_ROOTS` | `$HOME` | Roots the folder picker may traverse |
| `ORCA_USER_DATA_PATH` | `~/.orca-web` | Backend data dir |

The mock backend (`pnpm exec tsx src/web-bridge/mock-server.ts`) is still
available for renderer-only development against stub data.

## What works in the PoC

- Renderer bundle loads in Chrome/Chromium with zero electron deps in the
  client.
- React mounts the full app shell: title bar, sidebar (Tasks/Search/
  Workspaces), main pane (Add Project / Create Worktree landing), status bar.
- Tailwind CSS layout applies correctly (≈316 KB CSS includes the renderer
  source via `@source "../../**/*.{ts,tsx,html}"`).
- `window.api.foo.bar(args)` round-trips over WebSocket to the gateway and
  back. `window.electron.ipcRenderer.on/invoke/send` works the same way.
- Subscriptions (`ipcRenderer.on`) are deduplicated per channel and
  re-registered on reconnect.

## What still needs work

1. ~~PTY streams~~ — working as of the headless-backend rollout.
2. **File drag-and-drop.** Browser File objects have no `.path`, and
   `webUtils.getPathForFile` returns `''`. A real fix needs a file upload
   IPC (drag → upload bytes → main writes to a temp dir → use that path).
3. **Native dialogs.** `repos.pickFolder()` etc. open Electron dialogs today;
   in the browser they need either an HTML file-picker fallback or a remote
   file-tree picker that talks to the backend's filesystem.
4. **Auth.** PoC uses an optional shared token in `ORCA_WEB_TOKEN`. Production
   needs per-user auth, almost certainly a session cookie issued after an
   OIDC/SSO flow, and per-session capability scoping.
5. **Headless Electron on Linux servers.** The current main process needs a
   display. To self-host the backend on a headless Linux box without xvfb,
   either add an `ORCA_HEADLESS=1` path that skips `BrowserWindow.create`
   and the daemon fork, or run the IPC handlers in plain Node with a small
   Electron-API stub. The mock server illustrates the second option.
6. **Electron 41 ESM-from-CJS quirk.** Calling `installIpcIntercept()` at the
   top of `main/index.ts` (before `app.whenReady`) crashes with a misleading
   "Cannot read properties of undefined (reading 'prototype')" stack frame.
   Calling it inside `whenReady` works fine. The PoC does the latter.
7. **Subscriptions on reconnect.** Re-subscribe on open works for channels;
   in-flight invokes during a disconnect are silently dropped.
8. **CSP.** The Electron renderer ships with a strict CSP injected by
   electron-vite at build time; the web bundle doesn't set one yet.

9. **In-app browser pane.** Orca's "New Browser Tab" feature uses
   Electron's `<webview>` element — no analogue in a regular browser.
   Currently the affordance is hidden in web mode and the keyboard
   shortcut no-ops. The right long-term implementation is a server-side
   HTTP proxy at `/webpreview/*` that forwards requests to the target
   origin and injects a URL-rewriting script into proxied HTML
   (rewriting `fetch` / `XHR` / `element.src/.href` / `setAttribute` /
   `window.open`). The browser pane then becomes a regular `<iframe>`
   pointed at `/webpreview/<sessionId>/...` instead of a `<webview>`.
   Reference implementation: `~/dev/MidTerm/src/Ai.Tlbx.MidTerm/
   Services/WebPreview/WebPreviewProxyMiddleware.cs` (≈3,000 lines).
   This is a substantial chunk of work and not in PoC scope.

## Files added / changed

- `src/web-bridge/` — frontend shim + mock backend (new).
- `src/main/web-gateway/` — backend gateway (new).
- `src/main/index.ts` — wire the gateway behind `ORCA_WEB_GATEWAY=1` env.
- `config/vite.web.config.ts` — standalone browser-target Vite config (new).
- `src/renderer/src/assets/main.css` — add `@source` so Tailwind v4 scans the
  renderer source from the new build root.
- `package.json` — `web:build` and `web:dev` scripts.

Roughly **400 LOC of new bridge code** + ≈30 LOC of wiring. Everything else is
unchanged.
