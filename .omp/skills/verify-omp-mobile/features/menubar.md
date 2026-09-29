# Menu bar app

On the Mac, the `OMP Mobile` menu bar item shows the server's status (machine name and URL, Terminal/Server/Waiting counts, push and other problems, paired devices) and opens a `Connect a device` window with a one-time QR code and link. Once a phone uses the code, the window confirms which device connected.

## Sub-features

- `bar-pairing-window`: `Connect a device…` → window `Connect a device` with `Connect your iPhone`, QR (`Pairing QR code`), code, `Expires in m:ss`, `Copy link`, `New code`. After the code is used, within one 5 s poll: `Connected <device>`, `Your device is ready to use with OMP.`, `New code`. **Exercised.**
- `bar-status-panel`: machine name, URL (help `Copy server URL`), `Terminal` / `Server` / `Waiting`, `Push notifications are not configured` (once), server `problems`, `PAIRED DEVICES` with `Remove`, `Connect a device…`, `Restart server`, `Open logs`, `Quit OMP Mobile`. **Exercised.**
- `bar-status-item`: accessibility name always `OMP Mobile`; value `Offline` (fetch failed) > `Waiting` (pending > 0) > `Warning` (problems or no APNs) > `Online`. **Exercised** (`Warning`, `Offline`).
- `bar-remove-device`: `Remove` next to a device → `DELETE /admin/devices/<id>`. **Exercised** (`menubar-remove.sh`).
- `bar-offline`: server stopped → `Server offline` plus the error text. **Exercised.**
- `bar-restart`: `Restart server` kickstarts the LaunchAgent `com.heyskylark.omp-mobile.server`. Out of scope: it targets the installed server, never the run's.

## How to get to it (user POV)

- Click the `OMP Mobile` icon in the macOS menu bar; the panel drops down.
- `Connect a device…` opens the pairing window; scan with the phone or `Copy link`.

## Driving it with the menu bar harness (supervised process + System Events + window-shot.sh)

Preconditions: run server started and doctor `ok`; `macos/build.sh` succeeded; the app runs as the supervised process `omp-mobile-verify-menubar-<RUN_ID>` with `OMP_MOBILE_HOME=<OMP_MOBILE_HOME> OMP_MOBILE_OPEN_PAIRING=1` (SKILL.md Launch step 5). Get its pid from `read proc://omp-mobile-verify-menubar-<RUN_ID>`. The terminal needs Screen Recording and Accessibility permission.

- **Pairing window:** about a second after launch it opens by itself.

  ```sh
  .omp/skills/verify-omp-mobile/bin/window-shot.sh <pid> <EVIDENCE>/menubar-01-code
  ```

  `read` the PNG for the code, pair the Simulator with it (`pairing.md`, typed link or deep link), wait more than 5 s, and capture again: `Connected iPhone`. `api.ts <RUN_ID> status` shows `pairings[].consumedBy.name == "iPhone"`.
- **Status item and panel:**

  ```sh
  osascript -e 'tell application "System Events" to tell (first process whose unix id is <pid>) to get {name, value} of menu bar item 1 of menu bar 2'
  osascript -e 'tell application "System Events" to tell (first process whose unix id is <pid>) to click menu bar item 1 of menu bar 2'
  .omp/skills/verify-omp-mobile/bin/window-shot.sh <pid> <EVIDENCE>/menubar-panel
  ```

  Expect `OMP Mobile, Warning` without APNs. Compare the captured counts and devices with `api.ts <RUN_ID> status`. Close the panel with `osascript -e 'tell application "System Events" to key code 53'`.
- **Remove device:** `.omp/skills/verify-omp-mobile/bin/menubar-remove.sh <pid> verify-probe` (it opens the panel if needed). Capture the panel again and check `status`: the device is gone. Removing `verify-probe` is safe, because `api.ts … get` re-pairs it; removing `iPhone` disconnects the Simulator.
- **Offline:** stop the run's server (`write proc://omp-mobile-verify-server-<RUN_ID>/kill`), wait more than 5 s, then query the status item (`OMP Mobile, Offline`) and capture the panel (`Server offline`). Do this last, just before Cleanup.

## Gotchas

- The app reads `<OMP_MOBILE_HOME>/server.json` for port and admin token; without `OMP_MOBILE_HOME` it talks to the installed server in `~/.omp-mobile`.
- The built bundle and an installed `~/Applications/OMP Mobile.app` share bundle id `com.heyskylark.ompmobile.bar`; launch the executable directly as a supervised process, never with `open`.
- When the panel is open, System Events exposes it as `window 1` (subrole `AXSystemDialog`) containing one `AXGroup`. The `Remove` buttons have no name or title; each follows its device's `AXStaticText`, which is what `menubar-remove.sh` relies on. With the panel closed, `count of windows` is 0.
- The pairing window may sit on another Space; `window-shot.sh` captures it anyway. Never use full-screen `screencapture`.
- The menu bar app prints nothing, so its supervised process has no `ready` signal; the window capture is the readiness proof.
- `macos/dev/fake-admin.ts` serves fixed sample data for README screenshots; it is not a verification target.
