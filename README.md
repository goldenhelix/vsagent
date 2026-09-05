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
- **Pair with more than one server** — a single browser tab holds projects from several VSAgent servers at once; add, switch to, or remove a paired server without losing what's open in another.
- **Web folder picker** — browse and pick server-side directories from the browser; no native file dialog required.
- **Gitless "Open as Folder" projects** — point VSAgent at any directory, git repo or not, and work in it.
- **Terminals that survive** — PTYs are owned by a long-running daemon, so terminals live through browser refreshes, reconnects, and server restarts.
- **In-app browser that reaches the host** — browser panes, and "open in browser" links from the workspace-ports panel, are iframes backed by a server-side reverse proxy, so `localhost` dev servers running on the host "just work" from your remote browser tab.
- **Gitea as a task provider** — browse, triage, and comment on Gitea issues in the task page, alongside GitHub, GitLab, Linear, and Jira.
- **TLS and trusted-proxy pairing** — serve directly over HTTPS (`--serve-https`), or drop the pairing token entirely behind a proxy that already authenticates users.
- **Runs without a display if you need it** — opt into a display-less boot (`VSAGENT_ALLOW_DISPLAYLESS_SERVE=1`) on hosts with no Xvfb; terminals and agents keep working, only in-app browser panes go without.
- **Ops-friendly packaging** — Linux x64 tarball releases cut from `v*` tags, deployed as a systemd service.

## Install

For a Linux x64 server, see [`docs/install-linux.md`](docs/install-linux.md) — it covers installing from a release tarball, running under systemd, and upgrading. Upstream's [headless Linux server guide](docs/reference/headless-linux-server.md) covers the runtime prerequisites (e.g. Xvfb) for display-less machines.

Releases are published on [goldenhelix/vsagent](https://github.com/goldenhelix/vsagent/releases): pushing a `v*` tag builds the Linux tarball and publishes a GitHub Release.

## Building from source

Requires Node 24 (`node --version`) and pnpm — see [Prerequisites](docs/install-linux.md#prerequisites) for the full native-build toolchain list.

```bash
git clone https://github.com/goldenhelix/vsagent.git
cd vsagent
pnpm install
pnpm build:cli                 # the orca CLI → out/cli
pnpm build:electron-vite       # main process + preload + renderer
pnpm build:web-from-renderer   # static web client → out/web (projects the renderer build above)
./out/cli/index.js serve --port 8081
```

`orca serve` runs in the foreground and prints the runtime endpoint plus a ready-to-open browser URL (the web client is served from `out/web`). Use `--pairing-address` when clients connect through a LAN, Tailscale, SSH-forward, or public tunnel address, and `--host`/`--https` to control what interface serve binds and whether it terminates TLS itself. See `orca serve --help` for the full flag list.

## Upstream

VSAgent is a thin layer on top of [Orca](https://github.com/stablyai/orca) by stably.ai. The hard parts — the multi-worktree workflow, the agent-aware terminal layer, the headless `orca serve` runtime, the web client, the daemon-owned PTYs — are theirs.

The fork tracks upstream `main` and is kept **rebase-friendly on purpose**. The delta is small:

- a server-side **webpreview reverse proxy** so browser panes — and "open in browser" links from the workspace-ports panel — work as iframes in the web client (upstream's desktop app uses Electron webviews);
- **serve-mode hardening**: `--serve-host` / `--serve-https` / `--serve-cert` / `--serve-key` / `--serve-name` flags, a `pairing-url` CLI command, an opt-in trusted-proxy "open pairing" redirect for reverse-proxied deployments (`VSAGENT_SERVE_OPEN_PAIRING`), and an opt-in display-less boot fallback for hosts with no Xvfb (`VSAGENT_ALLOW_DISPLAYLESS_SERVE`);
- **Gitea** as a full task-source provider — issues, milestones, and comments — alongside upstream's GitHub, GitLab, Linear, and Jira support;
- **browser-client hardening**: pairing with several servers from one tab, browser-native notifications, per-deployment scoped `localStorage`, browser-safe keyboard shortcuts, and automatically hiding desktop-only shell integrations (reveal-in-file-manager, open-in-external-editor, …) that don't make sense from a browser;
- the **release pipeline** (`v*` tag → Linux tarball → GitHub Release), systemd deployment docs, and the install/upgrade scripts;
- **minimal branding** — the web client's title, favicon, and titlebar mark, the CLI help text (opt-in, `VSAGENT_BRAND_CLI=1`), and this README — all behind small seams so upstream component files stay untouched and rebases stay cheap;
- a handful of fixes we send upstream rather than carry as fork-only patches — stale `SingletonLock` reclaim, `node-pty` ABI-drift rebuild detection, multi-remote Git ref resolution, a defensive null check in `web-client-location.ts`, a null-result guard in the workspace-port scanner, and hiding host-only shell integrations for a browser client — look for `Upstream-candidate: yes` in the commit history.

Upstream is also prototyping [`orcad`](docs/reference/orcad-operations.md), a Node-only, Electron-free runtime built for exactly this always-on-server case. We're watching it as a possible future replacement for the Electron-based `serve` mode this fork builds on.

Syncing with upstream:

```bash
git remote add upstream https://github.com/stablyai/orca.git    # one-time
git fetch upstream
git rebase upstream/main
# build, smoke-test `orca serve` in a browser, push
```

VSAgent is built and maintained by [Golden Helix](https://www.goldenhelix.com).
