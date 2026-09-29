#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/build/OMP Mobile.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"

swift build --package-path "$ROOT" --configuration release
BIN_DIR="$(swift build --package-path "$ROOT" --configuration release --show-bin-path)"

rm -rf "$APP"
mkdir -p "$MACOS" "$CONTENTS/Resources"
cp "$BIN_DIR/OMP Mobile" "$MACOS/OMP Mobile"
cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>OMP Mobile</string>
    <key>CFBundleIdentifier</key>
    <string>com.heyskylark.ompmobile.bar</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>OMP Mobile</string>
    <key>CFBundleDisplayName</key>
    <string>OMP Mobile</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>OMP Mobile</string>
</dict>
</plist>
PLIST

plutil -lint "$CONTENTS/Info.plist"
codesign --force --sign - --timestamp=none "$APP"
echo "Built $APP"
