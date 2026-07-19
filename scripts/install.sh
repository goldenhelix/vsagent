#!/usr/bin/env bash
# VSAgent Linux installer.
#
# One-liner:
#   curl -fsSL https://github.com/goldenhelix/vsagent/releases/latest/download/install.sh | bash
#
# What it does:
#   1. Downloads the latest (or pinned) Linux x64 release tarball.
#   2. Unpacks it under $VSAGENT_HOME (default: ~/.local/share/vsagent),
#      replacing any existing install in place.
#   3. Runs `pnpm install --prod` in the install dir so Electron is fetched
#      and native modules (node-pty) are rebuilt against its ABI.
#   4. Symlinks ~/.local/bin/vsagent (the serve launcher) and
#      ~/.local/bin/orca (the Orca CLI).
#   5. Writes a systemd user unit at
#      ~/.config/systemd/user/vsagent.service (unless --no-systemd was
#      passed), starts it, and prints the tokenized web client URL.
#
# Supported flags (env vars in parens override the defaults but are
# overridden in turn by the flag if both are set):
#   --version=<vX.Y.Z>          (VSAGENT_VERSION) pin a specific release tag
#                               (default: latest published release)
#   --port=<N>                  (VSAGENT_PORT)    serve port (default: 6768).
#                               One port carries the WebSocket runtime AND the
#                               web client over HTTP.
#   --pairing-address=<host>    (VSAGENT_PAIRING_ADDRESS) hostname/IP written
#                               into the printed pairing / web client URLs.
#                               Default: Orca picks a reachable address.
#   --install-dir=<dir>         (VSAGENT_HOME)    install root
#                               (default: ~/.local/share/vsagent)
#   --no-systemd                            skip writing/enabling the
#                                           systemd user unit
#   --no-start                              don't start the service at
#                                           the end
#   --repo=<owner/repo>         (VSAGENT_REPO)    release repo
#                               (default: goldenhelix/vsagent)

set -euo pipefail

# --------- defaults ---------
VERSION="${VSAGENT_VERSION:-latest}"
PORT="${VSAGENT_PORT:-6768}"
PAIRING_ADDRESS="${VSAGENT_PAIRING_ADDRESS:-}"
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
    --version=*)          VERSION="${arg#*=}" ;;
    --port=*)             PORT="${arg#*=}" ;;
    --pairing-address=*)  PAIRING_ADDRESS="${arg#*=}" ;;
    --install-dir=*)      INSTALL_DIR="${arg#*=}" ;;
    --repo=*)             REPO="${arg#*=}" ;;
    --no-systemd)         USE_SYSTEMD=0 ;;
    --no-start)           START_SERVICE=0 ;;
    -h|--help)
      sed -n '2,37p' "$0"
      exit 0
      ;;
    *) die "unknown argument: $arg (try --help)" ;;
  esac
done

# --------- platform check ---------
OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"
if [[ "$OS" != "Linux" ]]; then
  die "VSAgent currently ships only for Linux (detected: $OS)."
fi
case "$ARCH" in
  x86_64|amd64) ;;
  *) die "Unsupported arch '$ARCH'. Linux x64 only for now." ;;
esac

# --------- required tools ---------
for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done
# Why: the strict electron installer extracts with host unzip when electron's
# own install script leaves a partial dist/ — only needed on that repair path.
command -v unzip >/dev/null 2>&1 || warn "unzip not found; the Electron install repair path needs it (apt-get install unzip)"

# --------- node / pnpm bootstrap ---------
# The tarball's build pins Node 24 (package.json engines). Node is needed for
# `pnpm install` and the postinstall rebuild; the running service uses the
# bundled Electron binary, not the system Node.
if ! command -v node >/dev/null 2>&1; then
  die "node not found in PATH. Install Node 24 first (https://nodejs.org or your distro's nodesource setup)."
fi
NODE_VER="$(node -p 'process.versions.node' 2>/dev/null || true)"
case "${NODE_VER%%.*}" in
  24|25) ;;
  *) warn "node version $NODE_VER may not be supported (expected 24); continuing anyway." ;;
esac

# Why: we want a working pnpm without forcing the user to install one
# globally. corepack ships with Node and can materialise the exact pnpm
# version package.json pins. Fall back to `npm i -g pnpm` otherwise.
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

# --------- optional-but-recommended: Xvfb ---------
# Xvfb enables in-app browser panes. Without it, serve falls back to a
# display-less headless boot: terminals and agents work, browser panes are off.
if [[ -z "${DISPLAY:-}" ]] && ! command -v Xvfb >/dev/null 2>&1; then
  warn "Xvfb not found: browser panes will be unavailable. Install it (apt-get install xvfb) to enable them."
fi

# --------- required for display-less boot: GL/Mesa ---------
# The Ozone headless fallback still initializes GPU-process GL through Mesa;
# without libGL/libEGL the serve segfaults at startup even in headless mode.
if command -v ldconfig >/dev/null 2>&1; then
  if ! ldconfig -p 2>/dev/null | grep -q 'libGL\.so\.1'; then
    warn "libGL not found: display-less serve will crash at boot. Install GL/Mesa (apt-get install libgl1 libegl1 libgles2 libglx-mesa0 libgl1-mesa-dri)."
  fi
fi

# --------- resolve version ---------
if [[ "$VERSION" == "latest" ]]; then
  # GitHub redirects /releases/latest/download/<asset> to the newest release.
  # The exact versioned asset name isn't predictable client-side, so we rely
  # on the `*-latest.tar.gz` alias the release workflow uploads.
  TARBALL_URL="https://github.com/$REPO/releases/latest/download/vsagent-linux-x64-latest.tar.gz"
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
log "unpacking into $INSTALL_DIR"
NEW_DIR="$TMP_DIR/extracted"
mkdir -p "$NEW_DIR"
tar -xzf "$TARBALL_PATH" -C "$NEW_DIR"
SRC_DIR="$NEW_DIR/vsagent"
[[ -d "$SRC_DIR" ]] || die "tarball did not contain expected vsagent/ top-level dir"

# Preserve node_modules across upgrades to skip a slow cold install;
# `pnpm install --prod` reconciles it against the new lockfile below.
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
log "installing production dependencies (this may take a few minutes)…"
(
  cd "$INSTALL_DIR"
  # --no-frozen-lockfile: the shipped package.json is rewritten by
  # build-release-tarball.mjs (electron promoted to a runtime dep) and no
  # longer matches the dev-inclusive lockfile exactly.
  pnpm install --prod --no-frozen-lockfile
)

# --------- launcher symlinks ---------
mkdir -p "$BIN_DIR"
chmod +x "$INSTALL_DIR/scripts/vsagent-serve" "$INSTALL_DIR/scripts/vsagent-cli" 2>/dev/null || true
# `vsagent` is the CLI (vsagent serve / status / file open ...), running on the
# BUNDLED Electron runtime — no system node required. `orca` stays as a compat
# alias. The server launcher keeps its own name for systemd/service use.
ln -snf "$INSTALL_DIR/scripts/vsagent-cli" "$BIN_DIR/vsagent"
ln -snf "$INSTALL_DIR/scripts/vsagent-cli" "$BIN_DIR/orca"
ln -snf "$INSTALL_DIR/scripts/vsagent-serve" "$BIN_DIR/vsagent-serve"

# --------- systemd unit ---------
if [[ "$USE_SYSTEMD" -eq 1 ]]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found; skipping systemd setup (pass --no-systemd to silence this)"
    USE_SYSTEMD=0
  fi
fi

WEB_URL_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/vsagent/web-url"

if [[ "$USE_SYSTEMD" -eq 1 ]]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  UNIT_PATH="$UNIT_DIR/vsagent.service"

  TEMPLATE_PATH="$INSTALL_DIR/scripts/vsagent.service"
  [[ -f "$TEMPLATE_PATH" ]] || die "shipped systemd template missing from $TEMPLATE_PATH"
  sed \
    -e "s|__PORT__|$PORT|g" \
    -e "s|__PAIRING_ADDRESS__|$PAIRING_ADDRESS|g" \
    -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
    "$TEMPLATE_PATH" > "$UNIT_PATH"

  log "wrote $UNIT_PATH"
  systemctl --user daemon-reload
  if [[ "$START_SERVICE" -eq 1 ]]; then
    # Why: each serve start mints a fresh pairing offer, so the web-url state
    # file only reflects THIS boot after the service restarts and prints it.
    rm -f "$WEB_URL_FILE" 2>/dev/null || true
    systemctl --user enable vsagent.service
    systemctl --user restart vsagent.service
  else
    systemctl --user enable vsagent.service || true
    log "skipping service start (--no-start)"
  fi
fi

# --------- final report ---------
INSTALLED_VERSION="$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || echo unknown)"

cat <<EOF

=== VSAgent installed ===
install dir:  $INSTALL_DIR
launcher:     $BIN_DIR/vsagent  (CLI: $BIN_DIR/orca)
version:      $INSTALLED_VERSION
port:         $PORT (WebSocket runtime + web client on the same port)

EOF

if [[ "$USE_SYSTEMD" -eq 1 && "$START_SERVICE" -eq 1 ]]; then
  # The web client URL embeds this boot's pairing token; the launcher records
  # it to the state file as soon as serve prints it.
  log "waiting for the service to publish its web client URL…"
  WEB_URL=""
  for _ in $(seq 1 30); do
    if [[ -s "$WEB_URL_FILE" ]]; then
      WEB_URL="$(cat "$WEB_URL_FILE")"
      break
    fi
    sleep 1
  done
  if [[ -n "$WEB_URL" ]]; then
    cat <<EOF
Open VSAgent in your browser:

  $WEB_URL

(The URL embeds a pairing token. Browsers that already paired against this
install stay signed in across restarts; new browsers need the current URL —
re-read it any time from: $WEB_URL_FILE)

EOF
  else
    warn "service did not publish a web client URL within 30s; check: journalctl --user -u vsagent -n 50"
  fi
fi

if [[ "$USE_SYSTEMD" -eq 1 ]]; then
  cat <<EOF
Systemd commands:
  systemctl --user status vsagent
  systemctl --user restart vsagent
  systemctl --user stop vsagent
  journalctl --user -u vsagent -f       # follow logs
  cat $WEB_URL_FILE                     # current web client URL

If you log out and want the service to keep running, enable
lingering for your user (one-time, requires sudo):
  sudo loginctl enable-linger \$USER

EOF
else
  cat <<EOF
Foreground launch:
  $BIN_DIR/vsagent

It prints the web client URL (with pairing token) on startup and also
records it to $WEB_URL_FILE.

EOF
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not in PATH; add it to your shell rc, e.g. \`export PATH=\"$BIN_DIR:\$PATH\"\`" ;;
esac

log "done"
