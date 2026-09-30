#!/bin/bash
# Creates and boots a simulator owned by this run on the newest installed iOS 26.x runtime
# (the app crashes at launch on iOS 27), and records its UDID in run.env.
# Usage: sim-create.sh <run-id> [device type name, default "iPhone 17 Pro"]
set -euo pipefail

RUN_ID=${1:?usage: sim-create.sh <run-id> [device type]}
ENV_FILE="$HOME/.cache/omp-mobile-verify/$RUN_ID/run.env"
# shellcheck disable=SC1090
source "$ENV_FILE"
if [ -n "${SIM_UDID:-}" ]; then
	echo "run.env already records SIM_UDID=$SIM_UDID" >&2
	exit 1
fi

RUNTIME=$(xcrun simctl list runtimes -j | jq -r '
	[.runtimes[] | select(.isAvailable and .platform == "iOS" and (.version | startswith("26.")))]
	| if length > 0 then sort_by(.version | split(".") | map(tonumber)) | .[length - 1].identifier else empty end')
if [ -z "$RUNTIME" ]; then
	echo "No available iOS 26.x simulator runtime; install one in Xcode > Settings > Components." >&2
	exit 1
fi

UDID=$(xcrun simctl create "omp-verify-$RUN_ID" "${2:-iPhone 17 Pro}" "$RUNTIME")
echo "SIM_UDID=$UDID" >>"$ENV_FILE"
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null
echo "$UDID"
