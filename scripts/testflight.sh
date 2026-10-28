#!/bin/sh
set -eu

cd "$(dirname "$0")/../app"

: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID to your Apple Developer team ID (developer.apple.com > Membership).}"
: "${EAS_PROJECT_ID:?Run 'bunx eas-cli init' in app/ once, then export EAS_PROJECT_ID with the printed project ID.}"

# EAS treats CI=true as non-interactive and then refuses to create signing credentials, which the first build needs.
# Pass --non-interactive explicitly to build unattended.
unset CI

exec bunx eas-cli build --platform ios --profile production --auto-submit "$@"
