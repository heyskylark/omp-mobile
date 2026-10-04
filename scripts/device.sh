#!/bin/bash
# Builds the app in Release, signed for APPLE_TEAM_ID, and installs it on an iPhone that Xcode can reach over a cable
# or the local network. Pass the phone's UDID to pick one; otherwise the first paired iPhone is used. Release embeds
# the JS bundle, so no Metro server is needed. `expo run:ios --device` fails here looking up the Simulator app.
set -euo pipefail

if [ -z "${APPLE_TEAM_ID:-}" ]; then
	echo "Export APPLE_TEAM_ID (and OMP_BUNDLE_ID, OMP_PERSONAL_TEAM=1 for a free Apple Account) first. See the README." >&2
	exit 1
fi
BUNDLE_ID=${OMP_BUNDLE_ID:-com.heyskylark.ompmobile}
DEVICES=$(mktemp)
trap 'rm -f "$DEVICES"' EXIT
xcrun devicectl list devices --quiet --json-output "$DEVICES" >/dev/null
DEVICE=${1:-$(python3 -c '
import json, sys
for device in json.load(open(sys.argv[1]))["result"]["devices"]:
	hardware = device.get("hardwareProperties", {})
	if hardware.get("reality") == "physical" and hardware.get("platform") == "iOS" \
			and device.get("connectionProperties", {}).get("pairingState") == "paired":
		print(hardware["udid"])
		break
' "$DEVICES")}
if [ -z "$DEVICE" ]; then
	echo "No paired iPhone found. Connect it with a cable once, or join the Mac's Wi-Fi, and trust this computer." >&2
	exit 1
fi

source "$(dirname -- "$0")/ios-prebuild.sh"
cd ios
xcodebuild -workspace OMP.xcworkspace -scheme OMP -configuration Release -destination "id=$DEVICE" \
	-derivedDataPath build/device -allowProvisioningUpdates DEVELOPMENT_TEAM="$APPLE_TEAM_ID" build | tail -3

APP=build/device/Build/Products/Release-iphoneos/OMP.app
xcrun devicectl device install app --device "$DEVICE" "$APP" >/dev/null
xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE_ID" >/dev/null
echo "Installed and launched OMP on $DEVICE"
