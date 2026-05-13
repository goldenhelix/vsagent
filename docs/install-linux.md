# Installing VSAgent on Linux

VSAgent (the web-mode fork of Orca) ships as a single Linux x64 tarball
that runs the Electron renderer behind a headless WebSocket gateway.
Once installed, users open the agent in any browser — no Electron app
to distribute.

This page covers:

- The one-liner install
- Manual install (download + extract)
- Upgrade flow
- Managing the systemd user service
- Firewall + reverse-proxy notes

## Prerequisites

- Linux x64 (Debian 11+ / Ubuntu 20.04+ / RHEL 9+ tested)
- Node.js 22 or newer (`node --version`)
- `pnpm` — bootstrapped automatically by the installer via corepack if
  it isn't present
- A `build-essential` (gcc, g++, make) toolchain plus `python3` — the
  native modules (`better-sqlite3`, `node-pty`) are rebuilt on first
  install
- Outbound HTTPS to `github.com` for the download step
- Port 8081 reachable from the user's network (override with `--port`)

## One-liner install

```bash
curl -fsSL https://raw.githubusercontent.com/goldenhelix/vsagent/main/scripts/install.sh | bash
```

The script:

1. Downloads the latest `vsagent-linux-x64-*.tar.gz` from GitHub
   Releases.
2. Unpacks it into `~/.local/share/vsagent`.
3. Runs `pnpm install --prod` to materialise `node_modules` and rebuild
   native modules for the local ABI.
4. Writes `~/.local/bin/vsagent` (plus a backwards-compat
   `~/.local/bin/orca` symlink).
5. Writes a systemd **user** unit at
   `~/.config/systemd/user/vsagent.service` and starts it.

At the end it prints the install dir, state dir, version, and a URL
like `http://<host>:8081`.

### Flags

All flags can be passed by feeding the script directly:

```bash
curl -fsSL https://…/install.sh | bash -s -- --port=9000 --no-systemd
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--version=vX.Y.Z` | latest | Pin to a specific release tag. Accepts `v1.2.3` or `1.2.3`. |
| `--port=N` | `8081` | HTTP port served by the gateway. Becomes `ORCA_WEB_PORT`. |
| `--user-data-path=DIR` | `~/.vsagent` | State directory (sqlite DBs, logs, sockets). Becomes `VSAGENT_USER_DATA_PATH`. |
| `--install-dir=DIR` | `~/.local/share/vsagent` | Where the unpacked tarball lives. Also `VSAGENT_HOME` env. |
| `--repo=owner/repo` | `goldenhelix/vsagent` | Override the release source (forks / mirrors). |
| `--no-systemd` | off | Skip writing/enabling the unit. Run under tmux, supervisord, etc. |
| `--no-start` | off | Don't start the service at the end. Useful for cold-replicating an install. |

### Running long after logout

systemd user services stop when your last login session ends, unless
**lingering** is enabled. One-time, requires sudo:

```bash
sudo loginctl enable-linger "$USER"
```

## Manual install

```bash
# 1. Pick a version
TAG=v1.3.49
VER=${TAG#v}

# 2. Download + verify
curl -fSL -o vsagent.tar.gz \
  https://github.com/goldenhelix/vsagent/releases/download/$TAG/vsagent-linux-x64-${VER}.tar.gz
curl -fSL -o vsagent.tar.gz.sha256 \
  https://github.com/goldenhelix/vsagent/releases/download/$TAG/vsagent-linux-x64-${VER}.tar.gz.sha256
sha256sum -c vsagent.tar.gz.sha256

# 3. Extract
mkdir -p ~/.local/share/vsagent
tar -xzf vsagent.tar.gz -C ~/.local/share --strip-components=0

# 4. Install runtime deps (one-time per host / per upgrade)
cd ~/.local/share/vsagent
pnpm install --prod --no-frozen-lockfile

# 5. Run
ORCA_WEB_PORT=8081 \
VSAGENT_USER_DATA_PATH=$HOME/.vsagent \
  node config/scripts/web-serve.mjs
```

To turn that into a permanent launcher, copy
`scripts/vsagent.service`, substitute `__PORT__`, `__USER_DATA_PATH__`,
and `__INSTALL_DIR__`, and drop it at
`~/.config/systemd/user/vsagent.service`.

## Upgrades

Re-run the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/goldenhelix/vsagent/main/scripts/install.sh | bash
```

Idempotency notes:

- The install dir contents are replaced wholesale, **but** `node_modules`
  is preserved across upgrades so `pnpm install --prod` only resolves
  diffs rather than re-downloading every dep.
- The systemd unit is regenerated from the shipped template (so flag
  changes between releases land automatically).
- The service is restarted at the end if systemd is in play.

Pin a specific version with `--version=v1.2.3` to roll back.

## systemd management

```bash
systemctl --user status vsagent          # current state
systemctl --user restart vsagent         # bounce the service
systemctl --user stop vsagent
systemctl --user disable --now vsagent   # disable and stop
journalctl --user -u vsagent -f          # follow logs
```

Two log destinations to know about:

- **journald** — everything the process writes to stdout/stderr.
- **`$VSAGENT_USER_DATA_PATH/logs/web-serve.log`** — a rotating file
  written by `web-serve.mjs` itself, with the previous run preserved at
  `web-serve.prev.log`. Use this when journald rotated past the crash.

## Firewall

The default port is **8081**. If the host runs `ufw` or `firewalld`,
open it:

```bash
# Debian / Ubuntu
sudo ufw allow 8081/tcp

# RHEL / Fedora
sudo firewall-cmd --add-port=8081/tcp --permanent
sudo firewall-cmd --reload
```

For internet-facing deployments put VSAgent behind a TLS-terminating
reverse proxy (snippet below) and bind to localhost via `--port=8081
--no-systemd` + a wrapper, or just keep the default and lock down port
8081 with the firewall.

## Reverse proxy (nginx)

VSAgent uses WebSockets for everything interesting, so the proxy needs
the upgrade headers. Minimal config:

```nginx
upstream vsagent {
  server 127.0.0.1:8081;
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

## Uninstall

```bash
systemctl --user disable --now vsagent
rm -f ~/.config/systemd/user/vsagent.service
systemctl --user daemon-reload

rm -rf ~/.local/share/vsagent
rm -f  ~/.local/bin/vsagent ~/.local/bin/orca ~/.local/bin/vsagent-cli

# Optional: drop state too. WARNING: deletes all VSAgent workspaces,
# tabs, terminals, settings.
rm -rf ~/.vsagent
```

## Troubleshooting

- **"better-sqlite3 was compiled against a different Node.js version"**
  — re-run `pnpm install --prod` inside the install dir. The
  installer's `postinstall` should do this automatically, but a
  mismatched system Node + Electron rebuild can desync them.
- **Service fails immediately with `FATAL: Failed to shutdown`** — a
  previous crash left a stale singleton lock. `web-serve.mjs` clears
  these on startup; if it still fails, manually remove
  `~/.vsagent/SingletonLock`, `SingletonSocket`, `SingletonCookie`.
- **Address already in use** — another process owns the port. Either
  pick a new one (`--port=9000` and re-run the installer) or stop the
  other process.
- **`node not found`** — install Node 22+ first (e.g. via NodeSource:
  `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -` then
  `sudo apt install nodejs`) and re-run the installer.
