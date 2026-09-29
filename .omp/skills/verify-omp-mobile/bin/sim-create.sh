#!/bin/bash
# Creates and boots a simulator owned by this run, and records its UDID in run.env.
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

UDID=$(xcrun simctl create "omp-verify-$RUN_ID" "${2:-iPhone 17 Pro}")
echo "SIM_UDID=$UDID" >>"$ENV_FILE"
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null
echo "$UDID"
