#!/bin/bash
# Removes one run's scratch state: its simulator, its OMP session buckets, and its scratch directory.
# Stop the run's supervised processes first; this script refuses while the run's port still listens.
# Evidence under .verify-evidence/<run-id> is never touched.
# Usage: cleanup.sh <run-id>
set -euo pipefail

RUN_ID=${1:?usage: cleanup.sh <run-id>}
case "$RUN_ID" in */* | "" | .*) echo "invalid run id: $RUN_ID" >&2; exit 1 ;; esac
ENV_FILE="$HOME/.cache/omp-mobile-verify/$RUN_ID/run.env"
if [ ! -f "$ENV_FILE" ]; then
	echo "No scratch for $RUN_ID ($ENV_FILE missing); nothing to clean." >&2
	exit 0
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

if lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
	echo "Port $PORT still listening; stop this run's supervised server first (write proc://<name>/kill)." >&2
	exit 1
fi

if [ -n "${SIM_UDID:-}" ]; then
	if xcrun simctl list devices | grep -F "$SIM_UDID" | grep -qF "omp-verify-$RUN_ID"; then
		xcrun simctl shutdown "$SIM_UDID" 2>/dev/null || true
		xcrun simctl delete "$SIM_UDID"
		echo "Deleted simulator omp-verify-$RUN_ID ($SIM_UDID)"
	else
		echo "Simulator $SIM_UDID is gone or not this run's; left untouched."
	fi
fi

# OMP stores sessions for cwd ~/.cache/omp-mobile-verify/<run-id>/work/... in buckets named from that path.
for bucket in "$HOME/.omp/agent/sessions/-.cache-omp-mobile-verify-$RUN_ID-"*; do
	[ -d "$bucket" ] || continue
	rm -rf "$bucket"
	echo "Removed session bucket $bucket"
done

rm -rf "$SCRATCH"
echo "Removed scratch $SCRATCH"

if [ -d "$EVIDENCE" ]; then
	echo "Evidence kept: $EVIDENCE ($(find "$EVIDENCE" -type f | wc -l | tr -d ' ') files)"
else
	echo "WARNING: evidence root $EVIDENCE does not exist" >&2
fi
