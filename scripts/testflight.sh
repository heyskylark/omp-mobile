#!/bin/sh
set -eu

cd "$(dirname "$0")/../app"

: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID to your Apple Developer team ID (developer.apple.com > Membership).}"
: "${EAS_PROJECT_ID:?Run 'bunx eas-cli init' in app/ once, then export EAS_PROJECT_ID with the printed project ID.}"

exec bunx eas-cli build --platform ios --profile production --auto-submit "$@"
