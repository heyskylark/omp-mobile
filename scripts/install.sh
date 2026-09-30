#!/bin/sh
set -eu

DRY_RUN=0
WITH_MENUBAR=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --with-menubar) WITH_MENUBAR=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DATA_DIR=${OMP_MOBILE_HOME:-"$HOME/.omp-mobile"}
CONFIG="$DATA_DIR/config.json"
LOG_DIR="$DATA_DIR/logs"
STATE_DIR="$DATA_DIR/install-state"
PLIST="$HOME/Library/LaunchAgents/com.heyskylark.omp-mobile.server.plist"
EXT_DIR="$HOME/.omp/agent/extensions"
EXT_LINK="$EXT_DIR/omp-mobile.ts"
BUN=$(command -v bun || true)
OMP=$(command -v omp || true)
TAILSCALE=$(command -v tailscale || true)
[ -n "$TAILSCALE" ] || [ ! -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] || TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale

[ -n "$BUN" ] || { echo "bun is required" >&2; exit 1; }
[ -n "$OMP" ] || { echo "omp is required" >&2; exit 1; }
[ -n "$TAILSCALE" ] || { echo "tailscale is required" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then printf '+ '; printf '%s ' "$@"; printf '\n'; else "$@"; fi
}
announce_write() { printf '+ write %s\n' "$1"; }

if [ "$DRY_RUN" -eq 1 ]; then
  run mkdir -p "$DATA_DIR" "$LOG_DIR" "$STATE_DIR" "$(dirname "$PLIST")" "$EXT_DIR"
else
  mkdir -p "$DATA_DIR" "$LOG_DIR" "$STATE_DIR" "$(dirname "$PLIST")" "$EXT_DIR"
  chmod 700 "$DATA_DIR" "$LOG_DIR" "$STATE_DIR"
fi

if [ ! -e "$CONFIG" ]; then
  announce_write "$CONFIG"
  if [ "$DRY_RUN" -eq 0 ]; then
    printf '{\n  "port": 8787,\n  "relayPort": 8788\n}\n' > "$CONFIG"
    chmod 600 "$CONFIG"
    : > "$STATE_DIR/config-created"
  fi
fi

RELAY_PORT=8788
if [ -f "$CONFIG" ]; then
  RELAY_PORT=$("$BUN" -e 'const c=await Bun.file(process.argv[1]).json(); console.log(c.relayPort ?? 8788)' "$CONFIG")
fi

if [ ! -e "$EXT_LINK" ] && [ ! -L "$EXT_LINK" ]; then
  run ln -s "$ROOT/extension/omp-mobile.ts" "$EXT_LINK"
  [ "$DRY_RUN" -eq 1 ] || : > "$STATE_DIR/extension-created"
elif [ "$(readlink "$EXT_LINK" 2>/dev/null || true)" != "$ROOT/extension/omp-mobile.ts" ]; then
  echo "$EXT_LINK already exists and is not the omp-mobile extension" >&2
  exit 1
fi

if [ ! -e "$STATE_DIR/omp-recorded" ]; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "+ record current OMP collab.autoStart and collab.relayUrl in $STATE_DIR"
  else
    "$OMP" config get collab.autoStart --json > "$STATE_DIR/collab-autoStart.json"
    "$OMP" config get collab.relayUrl --json > "$STATE_DIR/collab-relayUrl.json"
    : > "$STATE_DIR/omp-recorded"
  fi
fi
run "$OMP" config set collab.autoStart control
run "$OMP" config set collab.relayUrl "ws://127.0.0.1:$RELAY_PORT"

BUN_DIR=$(dirname "$BUN")
OMP_DIR=$(dirname "$OMP")
if [ -e "$PLIST" ] && [ ! -e "$STATE_DIR/launchagent.previous.plist" ]; then
  run cp "$PLIST" "$STATE_DIR/launchagent.previous.plist"
fi
announce_write "$PLIST"
if [ "$DRY_RUN" -eq 0 ]; then
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.heyskylark.omp-mobile.server</string>
<key>ProgramArguments</key><array><string>$BUN</string><string>$ROOT/server/src/main.ts</string></array>
<key>WorkingDirectory</key><string>$ROOT</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>$BUN_DIR:$OMP_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string><key>OMP_MOBILE_HOME</key><string>$DATA_DIR</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$LOG_DIR/server.log</string>
<key>StandardErrorPath</key><string>$LOG_DIR/server.err.log</string>
</dict></plist>
EOF
  chmod 600 "$PLIST"
fi
if [ "$DRY_RUN" -eq 1 ]; then
  run launchctl bootout "gui/$(id -u)/com.heyskylark.omp-mobile.server"
else
  launchctl bootout "gui/$(id -u)/com.heyskylark.omp-mobile.server" 2>/dev/null || true
fi
run launchctl bootstrap "gui/$(id -u)" "$PLIST"

if [ "$WITH_MENUBAR" -eq 1 ]; then
  if [ -e "$HOME/Applications/OMP Mobile.app" ] && [ ! -e "$STATE_DIR/menubar-installed" ]; then
    echo "$HOME/Applications/OMP Mobile.app already exists and is not owned by this installer" >&2
    exit 1
  fi
  run "$ROOT/macos/build.sh"
  run mkdir -p "$HOME/Applications"
  run pkill -x "OMP Mobile" || true
  run rm -rf "$HOME/Applications/OMP Mobile.app"
  run cp -R "$ROOT/macos/build/OMP Mobile.app" "$HOME/Applications/OMP Mobile.app"
  run osascript -e 'tell application "System Events" to delete every login item whose path is "'"$HOME"'/Applications/OMP Mobile.app"'
  run osascript -e 'tell application "System Events" to make login item at end with properties {path:"'"$HOME"'/Applications/OMP Mobile.app", hidden:false}'
  run open "$HOME/Applications/OMP Mobile.app"
  [ "$DRY_RUN" -eq 1 ] || : > "$STATE_DIR/menubar-installed"
fi

echo "OMP Mobile server installed."
