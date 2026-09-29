#!/bin/bash
# Clicks the menu bar panel's Remove button for one paired device of a menu bar app process.
# The SwiftUI Remove buttons have no accessibility name; each is the element right after its device's name text.
# Needs Accessibility permission for the calling terminal/app.
# Usage: menubar-remove.sh <pid> <device-name>
set -euo pipefail

PID=${1:?usage: menubar-remove.sh <pid> <device-name>}
NAME=${2:?usage: menubar-remove.sh <pid> <device-name>}
osascript - "$PID" "$NAME" <<'APPLESCRIPT'
on run argv
	set targetPID to (item 1 of argv) as integer
	set deviceName to item 2 of argv
	tell application "System Events"
		tell (first process whose unix id is targetPID)
			if (count of windows) is 0 then click menu bar item 1 of menu bar 2
			delay 0.5
			set items_ to UI elements of UI element 1 of window 1
			repeat with i from 1 to (count of items_) - 1
				set e to item i of items_
				if role of e is "AXStaticText" and name of e is deviceName then
					set b to item (i + 1) of items_
					if role of b is not "AXButton" then error "No Remove button after " & deviceName
					click b
					return "clicked Remove for " & deviceName
				end if
			end repeat
			error "Device row not found: " & deviceName
		end tell
	end tell
end run
APPLESCRIPT
