#!/bin/bash
# Installs or updates bee-linux, the agent of beekeeper for a Linux server (Debian, Ubuntu; systemd, Node.js 18+).
#
#   sudo ./install.sh --token <enrollment token> [options]       first installation
#   sudo ./install.sh                                            update: keeps the settings
#   sudo ./install.sh --uninstall [--purge]                      remove (--purge also the enrollment and the settings)
#
# Options (first installation, or to change one setting later):
#   --token T          one-time enrollment token from the portal (asset, "Gerät anmelden"); or BEE_TOKEN in the environment
#   --url URL          the beekeeper server (default https://beekeeper.one)
#   --comment TEXT     shown in the portal, e.g. "Webserver Kunde Müller"
#   --console / --no-console        allow the console in the portal (shell as user bee; default off)
#   --apt / --no-apt                allow updates of packages from the portal (default on)
#   --reboot / --no-reboot          allow a restart from the portal (default on)
#   --docker / --no-docker          report the containers of Docker (default on if Docker is installed)
#   --pm2-user USER                 report the processes of pm2 of this user ("" : off)
#   --source DIR|URL   where bee-linux.cjs and bee-root come from (default: next to this script, else GitHub)
#
# What it sets up: the system user bee (groups systemd-journal and adm, to read the journal and the logs), the
# program in /opt/bee-linux (owned by root), the settings in /etc/bee-linux, the data in /var/lib/bee-linux, a sudo rule
# for the helper /opt/bee-linux/bee-root only, and the service bee-linux.
set -euo pipefail

USER_NAME=bee
OPT=/opt/bee-linux
ETC=/etc/bee-linux
DATA=/var/lib/bee-linux
UNIT=/etc/systemd/system/bee-linux.service
SUDOERS=/etc/sudoers.d/bee-linux
DEFAULT_SOURCE=https://raw.githubusercontent.com/ioSofting/bee-linux/main

say() { echo "bee-linux: $*"; }
die() {
    echo "bee-linux: $*" >&2
    exit 1
}

TOKEN=${BEE_TOKEN:-}
URL=
COMMENT=
COMMENT_SET=0
CONSOLE=
APT=
REBOOT=
DOCKER=
PM2_USER=
PM2_SET=0
SOURCE=
UNINSTALL=0
PURGE=0

while [ $# -gt 0 ]; do
    case "$1" in
        --token) TOKEN=${2:-}; shift 2 ;;
        --url) URL=${2:-}; shift 2 ;;
        --comment) COMMENT=${2:-}; COMMENT_SET=1; shift 2 ;;
        --console) CONSOLE=true; shift ;;
        --no-console) CONSOLE=false; shift ;;
        --apt) APT=1; shift ;;
        --no-apt) APT=0; shift ;;
        --reboot) REBOOT=1; shift ;;
        --no-reboot) REBOOT=0; shift ;;
        --docker) DOCKER=1; shift ;;
        --no-docker) DOCKER=0; shift ;;
        --pm2-user) PM2_USER=${2:-}; PM2_SET=1; shift 2 ;;
        --source) SOURCE=${2:-}; shift 2 ;;
        --uninstall) UNINSTALL=1; shift ;;
        --purge) PURGE=1; shift ;;
        -h | --help) sed -n '2,25p' "$0"; exit 0 ;;
        *) die "unknown option $1 (--help)" ;;
    esac
done

[ "$(id -u)" = 0 ] || die "please run as root (sudo)"

if [ "$UNINSTALL" = 1 ]; then
    systemctl disable --now bee-linux 2>/dev/null || true
    rm -f "$UNIT" "$SUDOERS"
    systemctl daemon-reload
    rm -rf "$OPT"
    if [ "$PURGE" = 1 ]; then
        rm -rf "$ETC" "$DATA" /var/log/bee-linux
        userdel "$USER_NAME" 2>/dev/null || true
        say "removed, with settings, enrollment and user $USER_NAME"
    else
        say "removed; settings in $ETC and the enrollment in $DATA are kept (--purge removes them)"
    fi
    exit 0
fi

# ------------------------------------------------------------------ what the server needs
command -v systemctl >/dev/null || die "systemd is needed"
NODE=$(command -v node || true)
[ -n "$NODE" ] || die "Node.js 18 or newer is needed (node not found)"
NODE=$(readlink -f "$NODE")
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18 or newer is needed, found $("$NODE" -v)"
command -v sudo >/dev/null || say "warning: sudo is not installed: no updates, restart, pm2 and Docker from the portal"
command -v script >/dev/null || say "warning: script (util-linux) is missing: no console"
command -v apt-get >/dev/null || say "warning: no apt: updates of packages are not reported"

# ------------------------------------------------------------------ the program
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
HERE=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")
if [ -z "$SOURCE" ]; then
    if [ -n "$HERE" ] && [ -f "$HERE/dist/bee-linux.cjs" ] && [ -f "$HERE/bee-root" ]; then
        SOURCE=$HERE
    else
        SOURCE=$DEFAULT_SOURCE
    fi
fi
fetch() {
    # $1: path in the source (dist/bee-linux.cjs, bee-root), $2: target
    case "$SOURCE" in
        https://*)
            command -v curl >/dev/null || die "curl is needed to download from $SOURCE"
            curl -fsSL --proto '=https' "$SOURCE/$1" -o "$2" || die "download of $SOURCE/$1 failed"
            ;;
        *) cp "$SOURCE/$1" "$2" || die "$SOURCE/$1 not found" ;;
    esac
}
fetch dist/bee-linux.cjs "$TMP/bee-linux.cjs"
fetch bee-root "$TMP/bee-root"
head -c 64 "$TMP/bee-root" | grep -q '^#!/bin/bash' || die "bee-root from $SOURCE is not the helper"
VERSION=$(grep -oE 'AGENT_VERSION = ["'"'"'][0-9][^"'"'"']*' "$TMP/bee-linux.cjs" | head -1 | sed -E 's/.*= .//' || true)
[ -n "$VERSION" ] || die "bee-linux.cjs from $SOURCE is not the agent"

# ------------------------------------------------------------------ user
if ! id "$USER_NAME" >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin --comment "bee-linux (beekeeper)" "$USER_NAME"
    say "user $USER_NAME created"
fi
for g in systemd-journal adm; do
    if getent group "$g" >/dev/null; then
        usermod -aG "$g" "$USER_NAME"
    fi
done
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0750 "$DATA"
install -d -o root -g root -m 0755 "$OPT"
install -o root -g root -m 0644 "$TMP/bee-linux.cjs" "$OPT/bee-linux.cjs"
install -o root -g root -m 0755 "$TMP/bee-root" "$OPT/bee-root"

# ------------------------------------------------------------------ settings
install -d -o root -g "$USER_NAME" -m 0750 "$ETC"
ENV_FILE=$ETC/bee-linux.env
ROOT_CONF=$ETC/root.conf
FIRST=0
if [ ! -f "$ENV_FILE" ]; then
    FIRST=1
    [ -n "$TOKEN" ] || [ -s "$DATA/device.json" ] || die "first installation: --token <enrollment token from the portal> is needed"
    cat >"$ENV_FILE" <<'EOF'
# Settings of bee-linux (systemctl restart bee-linux after a change)
BEE_URL=https://beekeeper.one
BEE_TOKEN=
BEE_COMMENT=
BEE_CONSOLE=false
# BEE_CHECK=60
# BEE_HEARTBEAT=300
# BEE_APT_UPDATE=6
EOF
fi
chown root:"$USER_NAME" "$ENV_FILE"
chmod 0640 "$ENV_FILE"
set_env() {
    # $1 key, $2 value: replaces the line, or adds it
    local tmp
    tmp=$(mktemp)
    grep -v "^$1=" "$ENV_FILE" >"$tmp" || true
    printf '%s=%s\n' "$1" "$2" >>"$tmp"
    cat "$tmp" >"$ENV_FILE"
    rm -f "$tmp"
}
[ -n "$TOKEN" ] && set_env BEE_TOKEN "$TOKEN"
[ -n "$URL" ] && set_env BEE_URL "${URL%/}"
[ "$COMMENT_SET" = 1 ] && set_env BEE_COMMENT "$(printf '%s' "$COMMENT" | tr -d '\n\r')"
[ -n "$CONSOLE" ] && set_env BEE_CONSOLE "$CONSOLE"

if [ ! -f "$ROOT_CONF" ]; then
    cat >"$ROOT_CONF" <<'EOF'
# What bee-linux may do as root through /opt/bee-linux/bee-root (read by it, owned by root)
# APT=1: apt-get update and upgrade of single packages from the portal
# REBOOT=1: restart of the server from the portal
# DOCKER=1: list the containers (name, image, state)
# PM2_USER=name: list the processes of pm2 of this user (name, status, restarts)
APT=1
REBOOT=1
DOCKER=0
PM2_USER=
EOF
    command -v docker >/dev/null && [ -z "$DOCKER" ] && DOCKER=1
fi
chown root:root "$ROOT_CONF"
chmod 0644 "$ROOT_CONF"
set_conf() {
    local tmp
    tmp=$(mktemp)
    grep -v "^$1=" "$ROOT_CONF" >"$tmp" || true
    printf '%s=%s\n' "$1" "$2" >>"$tmp"
    cat "$tmp" >"$ROOT_CONF"
    rm -f "$tmp"
}
[ -n "$APT" ] && set_conf APT "$APT"
[ -n "$REBOOT" ] && set_conf REBOOT "$REBOOT"
[ -n "$DOCKER" ] && set_conf DOCKER "$DOCKER"
if [ "$PM2_SET" = 1 ]; then
    if [ -n "$PM2_USER" ] && ! id "$PM2_USER" >/dev/null 2>&1; then
        die "user $PM2_USER (--pm2-user) does not exist"
    fi
    set_conf PM2_USER "$PM2_USER"
fi

# ------------------------------------------------------------------ sudo: only the helper
if command -v visudo >/dev/null; then
    cat >"$TMP/sudoers" <<EOF
# bee-linux: the user $USER_NAME may run the helper only; it allows fixed actions ($ROOT_CONF)
Defaults:$USER_NAME !requiretty
$USER_NAME ALL=(root) NOPASSWD: $OPT/bee-root
$USER_NAME ALL=(root) NOPASSWD: $OPT/bee-root *
EOF
    visudo -cqf "$TMP/sudoers" || die "the sudo rule does not pass visudo -c"
    install -o root -g root -m 0440 "$TMP/sudoers" "$SUDOERS"
fi

# ------------------------------------------------------------------ service
# No ProtectSystem and no NoNewPrivileges: sudo (and through it apt-get) must keep working.
cat >"$TMP/unit" <<EOF
[Unit]
Description=bee-linux, the agent of beekeeper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=$DATA
EnvironmentFile=$ENV_FILE
Environment=BEE_DATA_DIR=$DATA
ExecStart=$NODE $OPT/bee-linux.cjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
install -o root -g root -m 0644 "$TMP/unit" "$UNIT"
runuser -u "$USER_NAME" -- "$NODE" -v >/dev/null 2>&1 || die "the user $USER_NAME cannot run $NODE (installed in a home folder, e.g. with nvm?)"
systemctl daemon-reload
systemctl enable bee-linux >/dev/null 2>&1
systemctl restart bee-linux

if [ "$FIRST" = 1 ]; then
    say "$VERSION installed and started"
else
    say "$VERSION installed, service restarted"
fi
say "can as root: $(runuser -u "$USER_NAME" -- sudo -n "$OPT/bee-root" can 2>/dev/null | tr '\n' ' ' || echo 'nothing (sudo)')"
say "log: journalctl -u bee-linux -f"
