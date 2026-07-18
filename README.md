<h1 align="center">
  <img src="resources/vsagent.svg" alt="VSAgent" width="64" valign="middle" /> VSAgent
</h1>

<p align="center">
  <strong>An agentic IDE you run on a Linux server and use from any browser.</strong><br/>
  Fork of <a href="https://github.com/stablyai/orca">Orca</a> by <a href="https://www.goldenhelix.com">Golden Helix</a>.<br/>
  Built to put VarSeq engineers and friends in front of Claude Code, Codex, and Gemini without giving up the multi-worktree, multi-agent workflow Orca pioneered.
</p>

---

## What it is

Upstream Orca is a desktop Electron app. VSAgent ships the same product as a **self-hosted web service**: the runtime lives on a shared Linux server close to the source and the build toolchain, and every engineer points a browser at it. Agents, worktrees, terminals, and editor state all live server-side, so closing the tab costs you nothing.

Earlier versions of this fork carried a custom WebSocket bridge that polyfilled Electron IPC into the browser. Upstream has since grown a first-class server mode — `orca serve` plus a static web client — so the fork was rebuilt directly on top of it. VSAgent now runs **upstream's own headless runtime and web client**, and the fork's delta is deliberately small (see [Upstream](#upstream)).

## Highlights

Everything the Orca desktop app does — parallel worktrees, side-by-side agents, the unified tab model, editor and source-control panels — served from your box:

- **Browser-native workflow** — `orca serve` starts the headless runtime and prints a browser URL with pairing baked in. No Electron on your laptop.
- **Web folder picker** — browse and pick server-side directories from the browser; no native file dialog required.
- **Gitless "Open as Folder" projects** — point VSAgent at any directory, git repo or not, and work in it.
- **Terminals that survive** — PTYs are owned by a long-running daemon, so terminals live through browser refreshes, reconnects, and server restarts.
- **In-app browser that reaches the host** — browser panes are iframes backed by a server-side reverse proxy, so `localhost` dev servers running on the host "just work" from your remote browser tab.
- **Ops-friendly packaging** — Linux x64 tarball releases cut from `v*` tags, deployed as a systemd service.

## Install

For a Linux x64 server, see [`docs/install-linux.md`](docs/install-linux.md) — it covers installing from a release tarball, running under systemd, and upgrading. Upstream's [headless Linux server guide](docs/reference/headless-linux-server.md) covers the runtime prerequisites (e.g. Xvfb) for display-less machines.

Releases are published on [goldenhelix/vsagent](https://github.com/goldenhelix/vsagent/releases): pushing a `v*` tag builds the Linux tarball and publishes a GitHub Release.

## Building from source

```bash
git clone https://github.com/goldenhelix/vsagent.git
cd vsagent
pnpm install
pnpm build:cli            # the orca CLI → out/cli
pnpm build:electron-vite  # main process + preload + renderer
pnpm build:web            # static web client → out/web
./out/cli/index.js serve --port 8081
```

`orca serve` runs in the foreground and prints the runtime endpoint plus a ready-to-open browser URL (the web client is served from `out/web`). Use `--pairing-address` when clients connect through a LAN, Tailscale, SSH-forward, or public tunnel address. See `orca serve --help` for the full flag list.

## Upstream

VSAgent is a thin layer on top of [Orca](https://github.com/stablyai/orca) by stably.ai. The hard parts — the multi-worktree workflow, the agent-aware terminal layer, the headless `orca serve` runtime, the web client, the daemon-owned PTYs — are theirs.

The fork tracks upstream `main` and is kept **rebase-friendly on purpose**. The delta is small:

- a server-side **webpreview reverse proxy** so browser panes work as iframes in the web client (upstream's desktop app uses Electron webviews);
- the **release pipeline** (`v*` tag → Linux tarball → GitHub Release) and systemd deployment docs;
- **minimal branding** — the web client's title and favicon, and this README. Upstream component files are untouched, so rebases stay cheap;
- a few fixes, which we prefer to send upstream rather than carry.

Syncing with upstream:

```bash
git remote add upstream https://github.com/stablyai/orca.git    # one-time
git fetch upstream
git rebase upstream/main
# build, smoke-test `orca serve` in a browser, push
```

VSAgent is built and maintained by [Golden Helix](https://www.goldenhelix.com).
