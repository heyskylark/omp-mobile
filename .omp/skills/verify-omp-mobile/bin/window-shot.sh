#!/bin/bash
# Captures only the windows owned by one process (e.g. the menu bar app's pairing window or its open menu panel),
# never the whole screen, including windows on another Space. Needs Screen Recording permission for the caller.
# Usage: window-shot.sh <pid> <output-prefix>   -> writes <output-prefix>-<n>.png per window, prints paths
set -euo pipefail

PID=${1:?usage: window-shot.sh <pid> <output-prefix>}
PREFIX=${2:?usage: window-shot.sh <pid> <output-prefix>}
IDS=$(osascript -l JavaScript -e '
ObjC.import("CoreGraphics");
function run(argv) {
	const ref = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0);
	const list = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
	return list
		.filter((w) => w.kCGWindowOwnerPID === Number(argv[0]) && w.kCGWindowBounds.Height > 40)
		.map((w) => w.kCGWindowNumber)
		.join(" ");
}' "$PID")
if [ -z "$IDS" ]; then
	echo "No on-screen window for pid $PID" >&2
	exit 1
fi
n=0
for id in $IDS; do
	n=$((n + 1))
	screencapture -x -o -l "$id" "$PREFIX-$n.png"
	echo "$PREFIX-$n.png"
done
