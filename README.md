<h1 align="center">
  <img src="resources/vsagent.svg" alt="VSAgent" width="64" valign="middle" /> VSAgent
</h1>

<p align="center">
  <strong>An agentic-IDE you run on a Linux server and use from any browser.</strong><br/>
  Fork of <a href="https://github.com/stablyai/orca">Orca</a> by <a href="https://www.goldenhelix.com">Golden Helix</a>.<br/>
  Built to put VarSeq engineers and friends in front of Claude Code, Codex, and Gemini without giving up the multi-worktree, multi-agent workflow Orca pioneered.
</p>

<p align="center">
  <a href="#install"><strong>One-line install</strong></a> ·
  <a href="#what-changed-from-orca"><strong>What changed</strong></a> ·
  <a href="#why-the-fork"><strong>Why</strong></a> ·
  <a href="#operating">Operating</a>
</p>

---

## Why the fork

The upstream Orca app is a desktop Electron client. Brilliant, but it runs on the box in front of you. We needed:

- a way for many Golden Helix engineers to point Claude Code / Codex / Gemini at our VSWarehouse codebases without installing Electron everywhere;
- the agents to run on a shared Linux server (`bastion01` and friends) close to the source and the build toolchain, not on individual laptops;
- the heavy lifting — worktrees, PTYs, file watchers — to keep working across browser refreshes and reconnects;
- one VarSeq engineer's browser tab and another's to see the same workspace state in real time.

So we forked Orca and added a **web mode**: the same Electron renderer ships as a static bundle, the same main process runs headless on the server, and a WebSocket gateway bridges the two. State persists under `~/.vsagent/`. PTYs live in a long-running daemon that survives browser close. Browse to `http://your-server:8081`, do your work, walk away, come back hours later in a different tab — your tabs, terminals, and editor state are still there.

We're shipping it as **VSAgent** for now. The internal `orca-*` URL paths and env vars are left alone for compatibility; user-visible branding is rebranded.

---

## What changed from Orca

The core IDE is unchanged. What we added (most recent first):

### Web mode

- **Headless backend** (`pnpm web:serve`): Electron runs `--headless=new`, no display required. A WebSocket gateway at `/__orca/ws` brings the renderer surface to any browser.
- **WS-bridged ipcRenderer**: `src/web-bridge/` polyfills Electron's `ipcRenderer` and `contextBridge` over WebSocket so the existing preload/renderer code runs unchanged inside a browser tab.
- **Daemon-PTY**: terminals are owned by a separate Node process (`out/main/daemon-entry.js`) over a Unix socket. Browser disconnect doesn't kill them. xterm.js replays scrollback + alt-screen cleanly on reattach.
- **Cross-browser session sync**: tabs, workspace state, editor drafts, and browser-pane URLs broadcast across every connected client via `session:set` → `session:changed`. Two engineers can see each other's UI live.
- **Timestamp-aware merge on hydrate** (`src/renderer/src/lib/session-hydrate-clock.ts`): concurrent tab opens / file edits in multiple browsers no longer clobber each other.

### In-app browser pane

A full HTTP proxy at `/__orca/webpreview/<sid>/...`:

- Server-side redirect following with cross-origin support (the address bar tracks the final URL after http→https or apex→www).
- HTML attribute rewriting + JS import rewriting at request time, plus a runtime script that patches `fetch`, `XHR`, `location.href`, `Location.prototype.assign/replace`, element `src`/`href`, etc.
- Self-origin URLs (page constructs URLs against `location.origin` which is the gateway) are re-routed back to the configured target so pages don't recursively load the VSAgent app inside the iframe.

### Remote folder picker

Onboarding's "Open a folder" Browse, the Add Project flow, and Settings → General → Workspace Directory all use a path-input picker (`RemoteFolderPicker`) with backend-driven autocomplete + interactive file-browser fallback. Replaces the no-op native Electron file dialog in web mode.

### Branding & state

- Default workspace dir: `$HOME` (was `~/orca/workspaces`). Override with `VSAGENT_WORKSPACE_DIR`.
- Default user-data path: `~/.vsagent/` (was `~/.orca-web`). Override with `VSAGENT_USER_DATA_PATH` (legacy `ORCA_USER_DATA_PATH` still honoured).
- Persistence files: `vsagent-data.json`, `vsagent-runtime.json`, `vsagent-e2ee-keypair.json`.
- User-visible "Orca" strings swapped to "VSAgent" across onboarding, settings, dialogs, status bar, HTML titles.
- Logo: `resources/vsagent.svg` (Golden Helix–branded).

### Cross-platform polish for the web case

- Shell-host detection: PowerShell / Command Prompt options are no longer offered when the backend is on Linux.
- `crypto.randomUUID` polyfill for non-HTTPS contexts.
- Workspace-dir migration: legacy `~/orca/workspaces` default flips to `$HOME` on first load.
- Friendly upstream-error pages inside the iframe instead of a blank webpreview.

For the full commit log: `git log 19d11db8..HEAD` (the fork point is upstream Orca v1.3.49-rc.2).

---

## Install

For a server (Linux x64) — one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/goldenhelix/vsagent/vsagent/scripts/install.sh | bash
```

That downloads the latest release tarball, installs to `~/.local/share/vsagent`, drops a `vsagent` CLI shim in `~/.local/bin`, writes a systemd `--user` unit, and starts it. Point a browser at `http://<your-server>:8081`.

For manual install, upgrade, or systemd commands, see [`docs/install-linux.md`](docs/install-linux.md).

---

## Operating

### Where state lives

| Path | Contents |
|------|----------|
| `~/.vsagent/` | All persistent state (override with `VSAGENT_USER_DATA_PATH`) |
| `~/.vsagent/vsagent-data.json` | Settings, repos, worktrees, onboarding, session |
| `~/.vsagent/vsagent-runtime.json` | RPC endpoint + auth token for the CLI |
| `~/.vsagent/daemon/` | PTY daemon Unix socket + token |
| `~/.vsagent/terminal-history/` | Scrollback buffers (one file per terminal) |

### Environment variables

| Var | Purpose | Default |
|-----|---------|---------|
| `VSAGENT_USER_DATA_PATH` | Where state lives | `~/.vsagent` |
| `VSAGENT_WORKSPACE_DIR` | Default worktree parent dir | `$HOME` |
| `ORCA_WEB_PORT` | Gateway HTTP/WS port | `8080` (install.sh sets 8081) |
| `ORCA_WEB_TOKEN` | Optional shared bearer token | unset |
| `ORCA_WEB_PICKER_ROOTS` | Colon-separated roots the folder picker may traverse | `$HOME` |
| `ORCA_WEBPREVIEW_DEBUG=1` | Log every upstream hop of the in-app browser proxy | off |

The legacy `ORCA_*` names for user-data / workspace are still read as fallbacks.

### Diagnostic flags (browser DevTools)

```js
localStorage.VSAGENT_AUTOSAVE_DEBUG = '1'      // editor auto-save flow
localStorage.VSAGENT_EDITOR_SYNC_DEBUG = '1'   // fs:changed → editor reload
location.reload()
```

### Logs

- `~/.vsagent/logs/web-serve.log` — backend stdout/stderr
- `journalctl --user -fu vsagent` — when running under systemd

---

## Building from source

```bash
git clone https://github.com/goldenhelix/vsagent.git
cd vsagent
git checkout vsagent
pnpm install
pnpm run build:electron-vite   # main + renderer
pnpm web:build                 # static web bundle into out/web
pnpm run build:cli             # the orca/vsagent CLI
ORCA_WEB_PORT=8081 pnpm web:serve
```

To package a release tarball (matches what GitHub Actions ships):

```bash
node config/scripts/build-release-tarball.mjs
# → dist/vsagent-linux-x64-<version>.tar.gz
```

---

## Upstream sync

The fork tracks `stablyai/orca` as the upstream. When upstream lands something worth pulling:

```bash
git remote add upstream https://github.com/stablyai/orca.git    # one-time
git fetch upstream
git checkout -b sync/upstream-<date>
git merge upstream/main
# resolve, build, smoke-test web mode, then PR back to vsagent
```

---

## Acknowledgements

VSAgent is a thin layer on top of [Orca](https://github.com/stablyai/orca) by stably.ai. The hard parts — the multi-worktree workflow, the unified tab model, the agent-aware terminal layer, the editor + SCM panel — are theirs. We just taught it to run on a server.

VSAgent is built and maintained by [Golden Helix](https://www.goldenhelix.com).
