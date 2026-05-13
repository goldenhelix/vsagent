#!/usr/bin/env bash
# VSAgent Linux installer.
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/goldenhelix/vsagent/vsagent/scripts/install.sh | bash
#
# What it does:
#   1. Downloads the latest (or pinned) Linux x64 release tarball.
#   2. Unpacks it under $VSAGENT_HOME (default: ~/.local/share/vsagent),
#      replacing any existing install in place.
#   3. Runs `pnpm install --prod` in the install dir so native modules
#      (better-sqlite3, node-pty, electron) are rebuilt against the
#      local Node/Electron ABI.
#   4. Writes a launcher at ~/.local/bin/vsagent and a backwards-
#      compatible ~/.local/bin/orca symlink.
#   5. Writes a systemd user unit at
#      ~/.config/systemd/user/vsagent.service (unless --no-systemd was
#      passed) and starts it.
#
# Supported flags (env vars in parens override the defaults but are
# overridden in turn by the flag if both are set):
#   --version=<vX.Y.Z>          (VSAGENT_VERSION) pin a specific release tag
#                               (default: latest published release)
#   --port=<N>                  (VSAGENT_PORT)    HTTP port (default: 8081)
#   --user-data-path=<dir>      (VSAGENT_USER_DATA_PATH) state dir
#                               (default: ~/.vsagent)
#   --install-dir=<dir>         (VSAGENT_HOME)    install root
#                               (default: ~/.local/share/vsagent)
#   --no-systemd                            skip writing/enabling the
#                                           systemd user unit
#   --no-start                              don't start the service at
#                                           the end (implies --no-systemd
#                                           if the unit isn't installed)
#   --repo=<owner/repo>         (VSAGENT_REPO)    release repo
#                               (default: goldenhelix/vsagent)

set -euo pipefail

# --------- defaults ---------
VERSION="${VSAGENT_VERSION:-latest}"
PORT="${VSAGENT_PORT:-8081}"
USER_DATA_PATH="${VSAGENT_USER_DATA_PATH:-$HOME/.vsagent}"
INSTALL_DIR="${VSAGENT_HOME:-$HOME/.local/share/vsagent}"
BIN_DIR="$HOME/.local/bin"
REPO="${VSAGENT_REPO:-goldenhelix/vsagent}"
USE_SYSTEMD=1
START_SERVICE=1

log()  { printf '[vsagent-install] %s\n'   "$*"; }
warn() { printf '[vsagent-install] WARN: %s\n' "$*" >&2; }
die()  { printf '[vsagent-install] ERROR: %s\n' "$*" >&2; exit 1; }

# --------- arg parsing ---------
for arg in "$@"; do
  case "$arg" in
    --version=*)        VERSION="${arg#*=}" ;;
    --port=*)           PORT="${arg#*=}" ;;
    --user-data-path=*) USER_DATA_PATH="${arg#*=}" ;;
    --install-dir=*)    INSTALL_DIR="${arg#*=}" ;;
    --repo=*)           REPO="${arg#*=}" ;;
    --no-systemd)       USE_SYSTEMD=0 ;;
    --no-start)         START_SERVICE=0 ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg (try --help)" ;;
  esac
done

# --------- platform check ---------
OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"
if [[ "$OS" != "Linux" ]]; then
  die "VSAgent currently ships only for Linux (detected: $OS). On macOS use the .dmg, on Windows the .exe."
fi
case "$ARCH" in
  x86_64|amd64) ;;
  *) die "Unsupported arch '$ARCH'. Linux x64 only for now." ;;
esac

# --------- required tools ---------
for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done

# --------- node / pnpm bootstrap ---------
# We rely on the user having a recent Node available. The Electron 41
# binary that pnpm pulls in needs glibc 2.31+ (Debian 11 / Ubuntu 20.04
# and newer); Node 22+ is recommended. We don't try to install Node for
# the user — bastion hosts almost always have a curated runtime.
if ! command -v node >/dev/null 2>&1; then
  die "node not found in PATH. Install Node 22+ first (https://nodejs.org or use your distro's nodesource setup)."
fi
NODE_VER="$(node -p 'process.versions.node' 2>/dev/null || true)"
case "${NODE_VER%%.*}" in
  22|23|24|25) ;;
  *) warn "node version $NODE_VER may not be supported (expected 22+); continuing anyway." ;;
esac

# Why: we want a working pnpm without forcing the user to install one
# globally. corepack ships with Node ≥16.10 and can materialise the exact
# pnpm version package.json pins. If corepack is unavailable, fall back
# to `npm i -g pnpm` and finally to a no-op (the user must install pnpm
# themselves).
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    log "enabling corepack to provide pnpm…"
    corepack enable >/dev/null 2>&1 || true
  fi
fi
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v npm >/dev/null 2>&1; then
    log "installing pnpm via npm i -g (one-time)…"
    npm i -g pnpm >/dev/null 2>&1 || warn "npm i -g pnpm failed; please install pnpm manually"
  fi
fi
command -v pnpm >/dev/null 2>&1 || die "pnpm not found and could not be bootstrapped. Install pnpm (https://pnpm.io/installation) and re-run."

# --------- resolve version ---------
if [[ "$VERSION" == "latest" ]]; then
  TARBALL_URL="https://github.com/$REPO/releases/latest/download/vsagent-linux-x64-latest.tar.gz"
  # GitHub redirects /releases/latest/download/<asset> to the actual
  # versioned asset. We can't predict the exact name client-side, so we
  # rely on the `*-latest.tar.gz` convenience asset the release workflow
  # uploads alongside the versioned one.
  log "resolving latest release from $REPO"
else
  # Allow the user to pass either `v1.2.3` or `1.2.3`.
  TAG="$VERSION"; [[ "$TAG" != v* ]] && TAG="v$TAG"
  ASSET_VERSION="${TAG#v}"
  TARBALL_URL="https://github.com/$REPO/releases/download/$TAG/vsagent-linux-x64-${ASSET_VERSION}.tar.gz"
  log "pinning to version $TAG"
fi

# --------- download tarball ---------
TMP_DIR="$(mktemp -d -t vsagent-install.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT
TARBALL_PATH="$TMP_DIR/vsagent.tar.gz"

log "downloading $TARBALL_URL"
if ! curl -fSL --retry 3 --retry-delay 2 -o "$TARBALL_PATH" "$TARBALL_URL"; then
  die "download failed. If you pinned an old version, double-check the tag. URL: $TARBALL_URL"
fi
[[ -s "$TARBALL_PATH" ]] || die "downloaded tarball is empty"

# --------- unpack ---------
mkdir -p "$INSTALL_DIR"
# Idempotent install: wipe the previous install's code but keep
# node_modules so an upgrade only has to re-resolve, not re-fetch.
# `pnpm install --prod` will reconcile the lockfile.
log "unpacking into $INSTALL_DIR"
NEW_DIR="$TMP_DIR/extracted"
mkdir -p "$NEW_DIR"
tar -xzf "$TARBALL_PATH" -C "$NEW_DIR"
SRC_DIR="$NEW_DIR/vsagent"
[[ -d "$SRC_DIR" ]] || die "tarball did not contain expected vsagent/ top-level dir"

# Preserve node_modules across upgrades to skip a slow cold install.
if [[ -d "$INSTALL_DIR/node_modules" ]]; then
  log "preserving existing node_modules from $INSTALL_DIR"
  mv "$INSTALL_DIR/node_modules" "$TMP_DIR/node_modules.preserved"
fi

# Replace install dir contents.
rm -rf "$INSTALL_DIR"/* "$INSTALL_DIR"/.[!.]* 2>/dev/null || true
cp -a "$SRC_DIR"/. "$INSTALL_DIR"/

if [[ -d "$TMP_DIR/node_modules.preserved" ]]; then
  mv "$TMP_DIR/node_modules.preserved" "$INSTALL_DIR/node_modules"
fi

# --------- install production deps ---------
mkdir -p "$USER_DATA_PATH"

log "installing production dependencies (this may take a minute)…"
(
  cd "$INSTALL_DIR"
  # --frozen-lockfile would be nice for reproducibility, but the
  # shipped package.json is rewritten by build-release-tarball.mjs and
  # no longer matches the lockfile exactly. We accept the speed/safety
  # trade-off in exchange for being able to ship a tighter manifest.
  pnpm install --prod --no-frozen-lockfile
)

# --------- wrapper scripts ---------
mkdir -p "$INSTALL_DIR/bin" "$BIN_DIR"

# The internal launcher (called by both the user-facing wrapper and the
# systemd unit). Centralising it here means we can swap the launch
# strategy without touching every install site.
cat > "$INSTALL_DIR/bin/vsagent" <<EOF
#!/usr/bin/env bash
# VSAgent launcher (managed by install.sh)
set -euo pipefail
export VSAGENT_USER_DATA_PATH="\${VSAGENT_USER_DATA_PATH:-$USER_DATA_PATH}"
export ORCA_WEB_PORT="\${ORCA_WEB_PORT:-$PORT}"
cd "$INSTALL_DIR"
exec node "$INSTALL_DIR/config/scripts/web-serve.mjs" "\$@"
EOF
chmod +x "$INSTALL_DIR/bin/vsagent"

# User-facing PATH entry.
ln -snf "$INSTALL_DIR/bin/vsagent" "$BIN_DIR/vsagent"
# Why: legacy users / docs reference `orca`. Keep a symlink so muscle
# memory keeps working. The CLI itself is also installed via `pnpm
# install --prod` (package.json `bin`), but the launcher symlink is
# what runs the web server.
ln -snf "$INSTALL_DIR/bin/vsagent" "$BIN_DIR/orca"

# Also expose the CLI binary.
if [[ -x "$INSTALL_DIR/out/cli/index.js" ]]; then
  ln -snf "$INSTALL_DIR/out/cli/index.js" "$BIN_DIR/vsagent-cli"
fi

# --------- systemd unit ---------
if [[ "$USE_SYSTEMD" -eq 1 ]]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found; skipping systemd setup (you can re-run with --no-systemd to silence this)"
    USE_SYSTEMD=0
  fi
fi

if [[ "$USE_SYSTEMD" -eq 1 ]]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  UNIT_PATH="$UNIT_DIR/vsagent.service"

  TEMPLATE_PATH="$INSTALL_DIR/scripts/vsagent.service"
  if [[ ! -f "$TEMPLATE_PATH" ]]; then
    warn "shipped systemd template missing from $TEMPLATE_PATH; writing a minimal one"
    cat > "$UNIT_PATH" <<EOF
[Unit]
Description=VSAgent web service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=ORCA_WEB_PORT=$PORT
Environment=VSAGENT_USER_DATA_PATH=$USER_DATA_PATH
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/bin/vsagent
Restart=on-failure
RestartSec=5
SyslogIdentifier=vsagent

[Install]
WantedBy=default.target
EOF
  else
    sed \
      -e "s|__PORT__|$PORT|g" \
      -e "s|__USER_DATA_PATH__|$USER_DATA_PATH|g" \
      -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
      "$TEMPLATE_PATH" > "$UNIT_PATH"
  fi

  log "wrote $UNIT_PATH"
  systemctl --user daemon-reload
  if [[ "$START_SERVICE" -eq 1 ]]; then
    systemctl --user enable --now vsagent.service
  else
    systemctl --user enable vsagent.service || true
    log "skipping service start (--no-start)"
  fi
fi

# --------- final report ---------
HOSTNAME_FQDN="$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo localhost)"
INSTALLED_VERSION="$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo unknown)"

cat <<EOF

=== VSAgent installed ===
install dir:       $INSTALL_DIR
state dir:         $USER_DATA_PATH
launcher:          $BIN_DIR/vsagent  (and: $BIN_DIR/orca)
version:           $INSTALLED_VERSION
listen port:       $PORT

Open VSAgent at:   http://$HOSTNAME_FQDN:$PORT

EOF

if [[ "$USE_SYSTEMD" -eq 1 ]]; then
  cat <<EOF
Systemd commands:
  systemctl --user status vsagent
  systemctl --user restart vsagent
  systemctl --user stop vsagent
  journalctl --user -u vsagent -f       # follow logs

If you log out and want the service to keep running, enable
lingering for your user (one-time, requires sudo):
  sudo loginctl enable-linger \$USER

EOF
else
  cat <<EOF
Foreground launch:
  $BIN_DIR/vsagent

Background under tmux / supervisor of your choice — point it at the
launcher above.

EOF
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not in PATH; add it to your shell rc, e.g. \`export PATH=\"$BIN_DIR:\$PATH\"\`" ;;
esac

log "done"
