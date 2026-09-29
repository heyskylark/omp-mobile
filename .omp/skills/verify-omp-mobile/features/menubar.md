# Menu bar app

On the Mac, the `OMP Mobile` menu bar item shows the server's status (machine name and URL, Terminal/Server/Waiting counts, problems, paired devices) and opens a `Connect a device` window with a one-time QR code and link for pairing a phone.

## Sub-features

- `bar-pairing-window`: `Connect a device…` → window `Connect a device` with `Connect your iPhone`, QR (`Pairing QR code`), code, `Expires in m:ss`, `Copy link`, `New code`. **Exercised** (auto-opened, captured, and its code paired the Simulator via deep link).
- `bar-status-panel`: machine name, URL (`Copy server URL`), `Terminal` / `Server` / `Waiting`, `Push notifications are not configured`, server `problems`, `PAIRED DEVICES` with `Remove`, `Connect a device…`, `Restart server`, `Open logs`, `Quit OMP Mobile`. **Exercised** (opened and captured).
- `bar-remove-device`: `Remove` next to a device → `DELETE /admin/devices/<id>`. Recipe-only.
- `bar-offline`: server stopped → `Server offline`. Recipe-only.
- `bar-restart`: `Restart server` kickstarts the LaunchAgent `com.heyskylark.omp-mobile.server`. Out of scope: it targets the installed server, never the run's.

## How to get to it (user POV)

- Click the `OMP Mobile` icon in the macOS menu bar; the panel drops down.
- `Connect a device…` opens the pairing window; scan with the phone or `Copy link`.

## Driving it with the menu bar harness (supervised process + System Events + window-shot.sh)

Preconditions: run server started and doctor `ok`; `macos/build.sh` succeeded; the app runs as the supervised process `omp-mobile-verify-menubar-<RUN_ID>` with `OMP_MOBILE_HOME=<OMP_MOBILE_HOME> OMP_MOBILE_OPEN_PAIRING=1` (see SKILL.md Launch step 5). Get its pid from `read proc://omp-mobile-verify-menubar-<RUN_ID>`.

- **Pairing window:** about a second after launch the window opens by itself. Capture it:

  ```sh
  .omp/skills/verify-omp-mobile/bin/window-shot.sh <pid> <EVIDENCE>/menubar-pairing
  ```

  `read` the PNG; the code is live if the deep-link recipe in `pairing.md` pairs with it and `api.ts <RUN_ID> status` gains a device.
- **Status panel:** open it with System Events (needs Accessibility permission for the terminal), then capture:

  ```sh
  osascript -e 'tell application "System Events" to tell (first process whose unix id is <pid>) to click menu bar item 1 of menu bar 2'
  .omp/skills/verify-omp-mobile/bin/window-shot.sh <pid> <EVIDENCE>/menubar-open
  ```

  Compare the captured counts and devices with `api.ts <RUN_ID> status`. Close with `osascript -e 'tell application "System Events" to key code 53'`.
- **Remove device (recipe):** System Events did not expose the panel's buttons in the proof run (`count of windows` = 0), so there is no selector-based click yet. Until one exists, report `bar-remove-device` as not driven; do not substitute `DELETE /admin/devices/<id>`.

## Gotchas

- The app reads `<OMP_MOBILE_HOME>/server.json` for port and admin token; without `OMP_MOBILE_HOME` it talks to the installed server in `~/.omp-mobile`.
- The built bundle and an installed `~/Applications/OMP Mobile.app` share bundle id `com.heyskylark.ompmobile.bar`; launch the executable directly as a supervised process, never with `open`.
- The status item's accessibility name follows its icon state (it read `Warning` while problems existed), so address it by position (`menu bar item 1 of menu bar 2` of the pid), not by name.
- Without APNs, the panel shows both the app's `Push notifications are not configured` line and the server problem `APNs not configured`.
- The pairing window keeps showing a code after it has been used; press `New code` before a second pairing.
- The window may sit on another Space; `window-shot.sh` captures it anyway. Never use full-screen `screencapture`.
- `macos/dev/fake-admin.ts` serves fixed sample data for README screenshots; it is not a verification target.
