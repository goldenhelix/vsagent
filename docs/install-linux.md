# Installing VSAgent on Linux

VSAgent ships upstream Orca's native `serve` mode as a self-hosted Linux x64
web service. A single Electron process runs headless on the server; it exposes
one port that carries both the runtime WebSocket API and the browser web
client (`/web-index.html`). Users open VSAgent in any browser — no desktop app
to distribute.

This page covers:

- How access works (pairing URLs)
- The one-liner install
- Manual install (download + extract)
- Upgrade flow
- Managing the systemd user service
- Firewall + reverse-proxy notes

## How access works: pairing URLs

On every start, `serve` prints (rebranded to `VSAgent server ready` by the
`vsagent-serve` launcher):

```
[serve] Bound to 0.0.0.0: reachable from the network. Anything that can reach this port can attempt pairing. Pass --host <address> to bind one interface instead.
VSAgent server ready
Bound endpoint: ws://0.0.0.0:6768
Advertised endpoint: ws://<host>:6768
Web client URL: http://<host>:6768/web-index.html#pairing=<token…>
Pairing URL: orca://pair?code=<token…>
```

The first line is a stderr warning (only shown when bound to a wildcard
address like the `0.0.0.0` default — pass `--host` to silence it); everything
else is stdout. `journalctl` interleaves both, but only the `Web client URL:`
line is saved to the state file below.

The **web client URL embeds a pairing token** in the URL fragment (it never
hits proxy logs or Referer headers). Opening it in a browser pairs that
browser with the server.

- Each `serve` start mints a **new** pairing offer, so the printed URL differs
  across restarts.
- Browsers that already paired **stay valid** across restarts — you only need
  the current URL to pair a *new* browser/device.
- The launcher records the most recent URL to
  `${XDG_STATE_HOME:-~/.local/state}/vsagent/web-url`, so you can always
  recover it without scrolling journald:

```bash
cat ~/.local/state/vsagent/web-url
```

## Prerequisites

- Linux x64 (Debian 12+ / Ubuntu 22.04+ / RHEL 9+; glibc new enough for
  Electron 43)
- **Node.js 24** (`node --version`) — used for `pnpm install` and the native
  rebuild; the running service uses the bundled Electron binary
- `pnpm` — bootstrapped automatically by the installer via corepack if absent
- A build toolchain (`gcc`, `g++`, `make`, `python3`) — `node-pty` is rebuilt
  against the bundled Electron ABI on install
- Electron's shared libraries. On Debian/Ubuntu:

  ```bash
  sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libgtk-3-0 libasound2t64 unzip
  ```

- **Xvfb — recommended.** With Xvfb installed (`sudo apt-get install xvfb`),
  serve runs a virtual display and in-app browser panes work. **Without a
  display, `serve` exits (code `1`) rather than starting** — set
  `VSAGENT_ALLOW_DISPLAYLESS_SERVE=1` to opt into a display-less boot instead
  (terminals and agents work fully, browser panes are off). See
  [Hosts that cannot run Xvfb](./reference/headless-linux-server.md#hosts-that-cannot-run-xvfb)
  for the full explanation of why this requires an explicit opt-in.
- **GL/Mesa libraries — required for the display-less fallback.** The Ozone
  headless boot still initializes GPU-process GL through Mesa; without these
  the serve segfaults at startup even in headless mode:

  ```bash
  sudo apt-get install -y libgl1 libegl1 libgles2 libglx-mesa0 libgl1-mesa-dri
  ```
- Outbound HTTPS to `github.com` for the download step
- Port 6768 reachable from the user's network (override with `--port`)

## One-liner install

```bash
curl -fsSL https://github.com/goldenhelix/vsagent/releases/latest/download/install.sh | bash
```

The script:

1. Downloads the latest `vsagent-linux-x64-*.tar.gz` from GitHub Releases.
2. Unpacks it into `~/.local/share/vsagent`.
3. Runs `pnpm install --prod` to materialise `node_modules`, fetch the
   Electron binary, and rebuild `node-pty` against Electron's ABI.
4. Symlinks `~/.local/bin/vsagent` (the CLI — `vsagent status`,
   `vsagent serve`, `vsagent file open`, ... — running on the bundled Electron
   runtime, no system Node required), `~/.local/bin/orca` (compat alias for
   the same CLI), and `~/.local/bin/vsagent-serve` (the server launcher used
   by the systemd unit).
5. Writes a systemd **user** unit at `~/.config/systemd/user/vsagent.service`,
   starts it, and prints the tokenized web client URL.

### Flags

Pass flags by feeding the script directly:

```bash
curl -fsSL https://github.com/goldenhelix/vsagent/releases/latest/download/install.sh \
  | bash -s -- --port=9000 --no-systemd
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--version=vX.Y.Z` | latest | Pin to a specific release tag. Accepts `v1.2.3` or `1.2.3`. |
| `--port=N` | `6768` | The serve port (WebSocket runtime + web client over HTTP, same port). Becomes `VSAGENT_PORT`. |
| `--host=IP` | `0.0.0.0` | Interface to bind. Set to a single IP (e.g. a Tailscale address) to expose serve only on that interface. Becomes `VSAGENT_HOST`. The pairing/web-client URL then advertises that IP unless `--pairing-address` overrides it. |
| `--pairing-address=HOST` | auto | Hostname/IP written into printed pairing / web client URLs. Set it to the DNS name users will actually reach (e.g. behind a proxy). Becomes `VSAGENT_PAIRING_ADDRESS`. |
| `--install-dir=DIR` | `~/.local/share/vsagent` | Where the unpacked tarball lives. Also `VSAGENT_HOME` env. |
| `--repo=owner/repo` | `goldenhelix/vsagent` | Override the release source (forks / mirrors). |
| `--no-systemd` | off | Skip writing/enabling the unit. Run under tmux, supervisord, etc. |
| `--no-start` | off | Don't start the service at the end. |

Note: serve binds `0.0.0.0` (all interfaces) on the chosen port by default.
Restrict exposure with `--host` (bind a single interface, e.g. a Tailscale IP),
a firewall, or a reverse proxy (below). `--pairing-address` only changes the
address *advertised* in URLs, not the bind — use `--host` to change what serve
actually listens on. The WebSocket/web-client server is the only externally
bound listener; everything else (daemon, CLI socket, agent hooks, browser
proxies) binds a unix socket or loopback.

Two caveats when pinning `--host` to a specific interface IP:

- **The interface must be up before serve starts.** Binding an IP that does
  not yet exist fails with `EADDRNOTAVAIL` and the web server won't come up
  (the runtime still runs on its local socket, but no browser can reach it).
  Under systemd, order the unit after the interface — e.g. for Tailscale add
  `After=tailscaled.service` and a readiness check, or restart serve once the
  address is assigned.
- **TLS + a pinned IP needs a matching cert.** With `--serve-https` the
  default self-signed certificate does not include the bound IP in its SAN, so
  browsers will warn. Supply a cert that covers that IP/hostname via
  `--serve-cert` / `--serve-key`, or terminate TLS at a reverse proxy.

### Environment variables

| Var | Meaning |
| --- | --- |
| `VSAGENT_DATA_DIR` | Absolute path for all server + CLI state (profiles, pairing trust, runtime metadata). Default for a tarball install: `~/.config/vsagent` — the CLI resolves the same dir, so `vsagent status` finds the server with no configuration. Keep it short: unix sockets under it break past ~107 bytes. |
| `VSAGENT_PORT`, `VSAGENT_PAIRING_ADDRESS` | Serve launcher port / advertised address (see Flags). |
| `VSAGENT_HOST` | Interface to bind (default `0.0.0.0`). Set to a single IP to restrict exposure to that interface. |
| `VSAGENT_SERVER_NAME` | Display name embedded in pairing offers — web clients use it as the default saved-server name (also `--serve-name`). Default: the server's hostname. |
| `VSAGENT_STORAGE_NAMESPACE` | Browser-storage namespace for the served web client (also `--serve-storage-namespace`). Set per app (e.g. the workspace slug) when several VSAgent apps share one browser origin under sub-URL routes — otherwise they share pairings/settings in localStorage. Without it, the client falls back to scoping by its URL path. |
| `VSAGENT_SERVE_OPEN_PAIRING=1` | Trusted-proxy mode: `GET /` redirects with an embedded pairing offer (see Reverse proxy). |
| `VSAGENT_SERVE_PAIRING_PROXY_SECRET` | Header-gated variant of open pairing. |
| `VSAGENT_GITEA_TOKEN`, `VSAGENT_GITEA_API_BASE_URL` | Gitea task-source auth. |
| `VSAGENT_TELEMETRY_DISABLED=1`, `VSAGENT_DIAGNOSTICS_DISABLED=1` | Disable telemetry/diagnostics (container images usually want both). |
| `VSAGENT_ALLOW_DISPLAYLESS_SERVE=1` | Opt into booting without Xvfb/`DISPLAY` (see Prerequisites). Off by default: `serve` exits rather than risk the crash this fallback exists to avoid on hosts where it isn't needed. Terminals/agents work; browser panes don't. |
| `VSAGENT_SERVE_KEEP_STALE_SINGLETON_LOCK=1` | Opt out of the automatic stale-`SingletonLock` reclaim (a container restart can leave one behind); see Troubleshooting. |

Legacy `ORCA_*` spellings of these keep working; when both are set, the
`VSAGENT_*` value wins.

### Running long after logout

systemd user services stop when your last login session ends, unless
**lingering** is enabled. One-time, requires sudo:

```bash
sudo loginctl enable-linger "$USER"
```

## Manual install

```bash
# 1. Pick a version
TAG=v0.6.0
VER=${TAG#v}

# 2. Download + verify
curl -fSL -o vsagent.tar.gz \
  https://github.com/goldenhelix/vsagent/releases/download/$TAG/vsagent-linux-x64-${VER}.tar.gz
curl -fSL -o vsagent.tar.gz.sha256 \
  https://github.com/goldenhelix/vsagent/releases/download/$TAG/vsagent-linux-x64-${VER}.tar.gz.sha256
sha256sum -c vsagent.tar.gz.sha256

# 3. Extract (the tarball contains a vsagent/ top-level dir)
mkdir -p ~/.local/share
tar -xzf vsagent.tar.gz -C ~/.local/share

# 4. Install runtime deps (one-time per host / per upgrade)
cd ~/.local/share/vsagent
pnpm install --prod --no-frozen-lockfile

# 5. Run (prints the web client URL on startup)
VSAGENT_PORT=6768 ./scripts/vsagent-serve
```

The launcher is a thin wrapper around:

```bash
cd <install-dir>
node_modules/electron/dist/electron <install-dir> --serve --serve-port $VSAGENT_PORT \
  [--serve-host $VSAGENT_HOST] [--serve-pairing-address $VSAGENT_PAIRING_ADDRESS]
```

plus capture of the printed `Web client URL:` line into
`${XDG_STATE_HOME:-~/.local/state}/vsagent/web-url`. Pass `--json` to get the
machine-readable ready line (`--serve-json`) instead of the human output.

To turn that into a permanent service, copy `scripts/vsagent.service`,
substitute `__PORT__`, `__PAIRING_ADDRESS__`, and `__INSTALL_DIR__`, and drop
it at `~/.config/systemd/user/vsagent.service`.

## Tarball layout

```
vsagent/
├── out/                 built artifacts (main, preload, renderer, cli,
│                        shared, relay, web — web-index.html lives here)
├── scripts/             vsagent-serve (launcher), vsagent.service (systemd
│                        template), install.sh (upgrades)
├── config/
│   ├── scripts/         rebuild-native-deps.mjs + the strict Electron
│   │                    installer (run by postinstall)
│   └── patches/         pnpm patches (node-pty, …)
├── resources/           runtime-loaded assets (skills metadata, icons)
├── package.json         slimmed runtime manifest (electron is a runtime dep)
├── pnpm-lock.yaml
└── VERSION
```

`node_modules` is not shipped — `pnpm install --prod` builds it on the host so
Electron and native modules match the local ABI.

## Upgrades

Re-run the installer:

```bash
curl -fsSL https://github.com/goldenhelix/vsagent/releases/latest/download/install.sh | bash
```

Idempotency notes:

- The install dir contents are replaced wholesale, **but** `node_modules` is
  preserved across upgrades so `pnpm install --prod` only resolves diffs.
- The systemd unit is regenerated from the shipped template.
- The service is restarted at the end; a fresh web client URL is printed (and
  recorded to the state file). Already-paired browsers stay signed in.

Pin a specific version with `--version=v1.2.3` to roll back.

## systemd management

```bash
systemctl --user status vsagent          # current state
systemctl --user restart vsagent         # bounce the service
systemctl --user stop vsagent
systemctl --user disable --now vsagent   # disable and stop
journalctl --user -u vsagent -f          # follow logs
cat ~/.local/state/vsagent/web-url       # current web client URL
```

The unit ships with `MemoryHigh=8G` / `MemoryMax=16G` and
`Restart=on-failure`: a leak or crash gets the service restarted before it can
exhaust the host. `RestartPreventExitStatus=3` is the one deliberate
exception — exit code `3` means another process already owns this
userData profile, so restarting could never succeed (see Troubleshooting).
Tune the limits in `~/.config/systemd/user/vsagent.service` to your
deployment's RAM. `docs/reference/headless-linux-server.md` documents the
same `serve` runtime for upstream's AppImage-based system-unit deployment in
more depth — its Systemd Service and Troubleshooting sections apply here too.

Server state (workspaces, settings, pairing trust) lives under Electron's
user-data dir (`~/.config/orca` by default), not the install dir — wiping the
install dir does not log users out.

## Firewall

The default port is **6768**:

```bash
# Debian / Ubuntu
sudo ufw allow 6768/tcp

# RHEL / Fedora
sudo firewall-cmd --add-port=6768/tcp --permanent
sudo firewall-cmd --reload
```

For internet-facing deployments put VSAgent behind a TLS-terminating reverse
proxy and firewall the serve port so it's only reachable from the proxy.

## Reverse proxy (nginx)

Everything (runtime WebSocket + web client HTTP) is on the one serve port, so
a single proxied location with WebSocket upgrade headers suffices. Set
`--pairing-address=vsagent.example.com` at install time so printed URLs point
at the proxy:

```nginx
upstream vsagent {
  server 127.0.0.1:6768;
  keepalive 32;
}

server {
  listen 443 ssl http2;
  server_name vsagent.example.com;

  ssl_certificate     /etc/letsencrypt/live/vsagent.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/vsagent.example.com/privkey.pem;

  # Large terminals / file transfers benefit from a bigger buffer.
  client_max_body_size 100m;
  proxy_read_timeout 1d;
  proxy_send_timeout 1d;

  location / {
    proxy_pass http://vsagent;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # WebSocket upgrade
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

The web client is built with relative asset URLs, so serving it under a path
prefix (e.g. `location /vsagent/`) also works.

### Trusted-proxy mode: no pairing token in the URL

When the proxy itself authenticates users (Tailscale serve, an SSO gateway,
VSWarehouse auth), the tokenized pairing URL adds nothing — whoever can reach
the port is already trusted. Set:

```ini
Environment=VSAGENT_SERVE_OPEN_PAIRING=1
```

on the systemd unit (or export it before launching `vsagent-serve`). Then
`GET /` on the serve port 302-redirects to the web client with a pairing
offer already embedded in the URL fragment — users just open
`https://vsagent.example.com/` and land paired. The WebSocket endpoint in the
offer is derived per-request from `Host` / `X-Forwarded-Host` /
`X-Forwarded-Proto` (`https` → `wss`), so the same server works via any
hostname that reaches it, TLS or not. Fragments are resolved client-side and
never appear in proxy access logs.

All visitors share one persistent device entry ("Shared web access (trusted
proxy)") — revoking that device in the runtime's device list cuts everyone
off at once. Direct hits to `/web-index.html` still require a pairing
fragment; only `/` redirects.

If the serve port is reachable by machines that should NOT get access (shared
LAN without a firewall), use the header-gated variant instead: set
`VSAGENT_SERVE_PAIRING_PROXY_SECRET=<random>` on the service and have only the
proxy inject the matching header:

```nginx
    proxy_set_header X-VSAgent-Proxy-Auth "<random>";
```

Requests without the header are not redirected (they fall through to a 404),
so only proxy-authenticated traffic can mint a session.

## Uninstall

```bash
systemctl --user disable --now vsagent
rm -f ~/.config/systemd/user/vsagent.service
systemctl --user daemon-reload

rm -rf ~/.local/share/vsagent
rm -f  ~/.local/bin/vsagent ~/.local/bin/orca
rm -rf ~/.local/state/vsagent

# Optional: drop server state too. WARNING: deletes all workspaces,
# settings, and pairing trust.
rm -rf ~/.config/orca
```

## Troubleshooting

- **"The SUID sandbox helper binary was found, but is not configured
  correctly" / instant crash at boot** — the kernel restricts unprivileged
  user namespaces (Ubuntu 24.04 AppArmor default). Either
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (persist in
  `/etc/sysctl.d/`), or run the service with `ELECTRON_DISABLE_SANDBOX=1` in
  the unit's `Environment=` lines.
- **"node-pty was compiled against a different Node.js version"** — re-run
  `pnpm install --prod` inside the install dir; its postinstall rebuilds
  node-pty against the bundled Electron ABI.
- **"Electron failed to install correctly"** — re-run `pnpm install --prod`;
  the shipped postinstall runs a strict Electron installer that re-downloads
  and repairs a partial install (it needs `unzip` on the host).
- **Browser panes don't open** — install Xvfb
  (`sudo apt-get install xvfb`) and restart the service; look for the
  `[serve] Xvfb not found` warning in journald to confirm this is the cause.
- **"a usable display server" / exits with code 1 and no Xvfb available** —
  set `VSAGENT_ALLOW_DISPLAYLESS_SERVE=1` (see Prerequisites and
  [Hosts that cannot run Xvfb](./reference/headless-linux-server.md#hosts-that-cannot-run-xvfb))
  to start without browser panes instead. If the variable is already set and
  serve still exits, `--ozone-platform=headless` didn't reach Chromium's
  command line — confirm you're launching through `vsagent-serve` (it adds the
  switch itself) rather than execing Electron directly.
- **GPU/DRI warnings on a VPS** — keep `Environment=LIBGL_ALWAYS_SOFTWARE=1`
  in the unit (shipped by default in `scripts/vsagent.service`).
- **Lost the web client URL** — `cat ~/.local/state/vsagent/web-url`, or
  `journalctl --user -u vsagent | grep "Web client URL"`.
- **Address already in use** — another process owns the port. Pick a new one
  (`--port=9000` and re-run the installer) or stop the other process.
- **Journal shows "Another Orca instance is already running for this
  userData profile" and the unit exits `3`** — another process already owns
  the profile; `RestartPreventExitStatus=3` leaves the unit stopped on
  purpose rather than restart-looping. Find the owner with
  `systemctl --user status vsagent` and `pgrep -af vsagent-serve`. If no
  owner exists, the lock is stale (e.g. a container restart) — `serve`
  reclaims a provably-dead `SingletonLock` automatically on the next start,
  so this is normally self-healing; set
  `VSAGENT_SERVE_KEEP_STALE_SINGLETON_LOCK=1` to opt out and remove the
  files under the userData dir by hand instead.
- **`node not found`** — install Node 24 first (e.g. via NodeSource:
  `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -` then
  `sudo apt install nodejs`) and re-run the installer.
