#!/bin/sh
set -eu

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in --dry-run) DRY_RUN=1 ;; *) echo "Unknown option: $arg" >&2; exit 2 ;; esac
done

DATA_DIR=${OMP_MOBILE_HOME:-"$HOME/.omp-mobile"}
STATE_DIR="$DATA_DIR/install-state"
PLIST="$HOME/Library/LaunchAgents/com.heyskylark.omp-mobile.server.plist"
EXT_LINK="$HOME/.omp/agent/extensions/omp-mobile.ts"
APP="$HOME/Applications/OMP Mobile.app"
BUN=$(command -v bun || true)
OMP=$(command -v omp || true)

run() {
  if [ "$DRY_RUN" -eq 1 ]; then printf '+ '; printf '%s ' "$@"; printf '\n'; else "$@"; fi
}

if [ "$DRY_RUN" -eq 1 ]; then
  run launchctl bootout "gui/$(id -u)/com.heyskylark.omp-mobile.server"
else
  launchctl bootout "gui/$(id -u)/com.heyskylark.omp-mobile.server" 2>/dev/null || true
fi

if [ -f "$STATE_DIR/launchagent.previous.plist" ]; then
  run cp "$STATE_DIR/launchagent.previous.plist" "$PLIST"
  run launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
  run rm -f "$PLIST"
fi

if [ -e "$STATE_DIR/extension-created" ]; then run rm -f "$EXT_LINK"; fi
if [ -e "$STATE_DIR/config-created" ]; then run rm -f "$DATA_DIR/config.json"; fi

restore_setting() {
  key=$1
  file=$2
  [ -f "$file" ] || return 0
  [ -n "$BUN" ] && [ -n "$OMP" ] || { echo "bun and omp are required to restore $key" >&2; exit 1; }
  value=$($BUN -e 'const x=await Bun.file(process.argv[1]).json(); if (x.value !== undefined && x.value !== null) process.stdout.write(String(x.value))' "$file")
  if [ -n "$value" ]; then run "$OMP" config set "$key" "$value"; else run "$OMP" config reset "$key"; fi
}
restore_setting collab.autoStart "$STATE_DIR/collab-autoStart.json"
restore_setting collab.relayUrl "$STATE_DIR/collab-relayUrl.json"

if [ -e "$STATE_DIR/menubar-installed" ]; then
  run osascript -e 'tell application "System Events" to delete every login item whose path is "'"$APP"'"'
  run rm -rf "$APP"
fi
run rm -rf "$STATE_DIR"
echo "OMP Mobile server uninstalled."
