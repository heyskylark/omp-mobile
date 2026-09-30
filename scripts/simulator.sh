#!/bin/bash
# Builds the app in Release for an iOS Simulator and installs it. Pass a simulator UDID to target that device;
# otherwise the first booted simulator is used. Release embeds the JS bundle, so no Metro server is needed.
# Simulator builds are signed ad hoc so the keychain entitlements work.
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
BUNDLE_ID=${OMP_BUNDLE_ID:-com.heyskylark.ompmobile}
DEVICE=${1:-$(xcrun simctl list devices booted | grep -oE '\([0-9A-F-]{36}\)' | head -1 | tr -d '()' || true)}
if [ -z "$DEVICE" ]; then
	echo "Boot a simulator first, for example: xcrun simctl boot 'iPhone 17 Pro' && open -a Simulator" >&2
	exit 1
fi

cd "$ROOT/app"
# app/ios is generated and gitignored, so an existing copy may come from other inputs: cloned into a new worktree from
# another checkout, generated with a different OMP_BUNDLE_ID, or older than native files added since. Regenerate it
# whenever the resolved app config or the native sources it is built from differ from the ones recorded at prebuild.
STAMP=ios/.omp-prebuild-inputs
INPUTS=$({
	bunx expo config --type public --json
	find app.config.ts package.json ../bun.lock plugins targets modules -type f ! -name .DS_Store -print0 | sort -z | xargs -0 shasum
} | shasum | cut -d' ' -f1)
if [ "$(cat "$STAMP" 2>/dev/null || true)" != "$INPUTS" ]; then
	bunx expo prebuild -p ios --clean --no-install
	# Run pod install here rather than inside prebuild, which reports success even when CocoaPods aborts (it does without
	# a UTF-8 locale), leaving no workspace to build.
	(cd ios && LC_ALL=en_US.UTF-8 pod install)
	echo "$INPUTS" >"$STAMP"
fi
cd ios
xcodebuild -workspace OMP.xcworkspace -scheme OMP -configuration Release -sdk iphonesimulator \
	-destination "id=$DEVICE" -derivedDataPath build/simulator \
	CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES DEVELOPMENT_TEAM= build | tail -3

APP=build/simulator/Build/Products/Release-iphonesimulator/OMP.app
xcrun simctl terminate "$DEVICE" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$DEVICE" "$APP"
xcrun simctl launch "$DEVICE" "$BUNDLE_ID" >/dev/null
echo "Installed and launched OMP on $DEVICE"
