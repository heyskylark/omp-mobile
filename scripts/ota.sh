#!/bin/sh
set -eu

cd "$(dirname "$0")/../app"

: "${1:?Usage: scripts/ota.sh \"<what changed>\"}"

# The production environment on EAS holds EAS_PROJECT_ID, EXPO_OWNER, and APPLE_TEAM_ID, so the update's fingerprint is
# computed from the same app config as the TestFlight builds it targets.
exec bunx eas-cli update --channel production --environment production --platform ios --message "$1"
