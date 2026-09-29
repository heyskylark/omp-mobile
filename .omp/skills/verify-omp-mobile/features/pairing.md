# Pairing a computer

The user adds a computer running the OMP Mobile server to the app with a one-time code, from the menu bar's QR/link or a pasted link, and later removes it. A paired computer appears on the Computers list as Online and opens its session list.

## Sub-features

- `pair-deeplink`: opening an `ompmobile://pair?v=1&url=…&code=…&name=…` link routes to `/pair` and connects. **Exercised** twice (`pair-deeplink.yaml`, once with the code shown in the menu bar window). This is the baseline pairing path.
- `pair-paste-button`: Add computer → clipboard button pastes the link and connects. Exercised once end to end (run `r1`, before the flow was split in two); the split flows paired server-side in the final run but were not re-run after adding the notification-prompt step, because this Mac syncs its pasteboard into the Simulator (see Gotchas).
- `pair-typed-link`: type/paste into the `ompmobile://pair?…` field, then tap Connect. Recipe-only; currently blocked (see Gotchas).
- `pair-qr`: scan the menu bar QR code. Physical device only.
- `pair-invalid`: a malformed link shows `That is not a valid OMP pairing link.`; a used or expired code is rejected by `POST /v1/pair` with `Pairing code is invalid or expired` (record what the sheet shows). Recipe-only.
- `remove-computer`: session list `More` → Computer screen → `Remove computer` → alert `Remove computer?` → `Remove`; returns to Computers. Recipe-only.

## How to get to it (user POV)

- First launch: Computers screen shows `Your computers, anywhere` and an `Add computer` button; later launches show computer rows plus an `Add computer` footer.
- `Add computer` opens a sheet titled `Add computer`: camera square, `Scan the code shown by OMP Mobile on your Mac, or paste its pairing link.`, the link field, a clipboard button, and `Connect`.
- The link or QR comes from the Mac menu bar: `OMP Mobile` → `Connect a device…` → `Copy link` / QR.
- Success replaces the sheet with that computer's session list (header title = machine name).
- Removal: open the computer, tap the ellipsis (`More`) in the header.

## Driving it with Maestro

Preconditions: Launch + Doctor passed; for a first pairing the app has no computers yet (fresh run simulator). Every successful pairing on a new install triggers iOS's `“OMP” Would Like to Send You Notifications`; both pairing flows tap `Allow` and screenshot the prompt.

- **Deep link (baseline):**

  ```sh
  .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> pair-link
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/deeplink -e 'PAIR_LINK=<link>' -e MACHINE_NAME=<MACHINE_NAME> .omp/skills/verify-omp-mobile/flows/pair-deeplink.yaml
  ```

  The flow taps `Open` on iOS's `Open in “OMP”?` prompt when it appears. Screenshots: `deeplink-00-notification-permission` (first pairing only), `deeplink-01-machine-sessions`. To prove a menu bar code is live, build `<link>` as `ompmobile://pair?v=1&url=<percent-encoded server URL>&code=<code in the pairing window>&name=<MACHINE_NAME>`.
- **Paste button:** first check `defaults read com.apple.iphonesimulator PasteboardAutomaticSync`; if it prints `1` and Simulator.app is running, report `pair-paste-button` as not driven (host-pasteboard hazard) rather than toggling the user's setting. Otherwise:

  ```sh
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/pair-open .omp/skills/verify-omp-mobile/flows/open-add-computer.yaml
  .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> pair-link
  printf %s '<link>' | xcrun simctl pbcopy <SIM_UDID>
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/pair -e MACHINE_NAME=<MACHINE_NAME> .omp/skills/verify-omp-mobile/flows/pair-paste.yaml
  ```

  Screenshots: `pair-01-computers-empty`, `pair-02-add-computer`, `pair-02b-notification-permission`, `pair-03-machine-sessions`.
- **Remove computer (recipe):** from the session list `tapOn: "More"`, wait for `Remove computer`, tap it, `tapOn: "Remove"` in the alert, assert `Your computers, anywhere`. The server keeps the device record (removal is phone-local, per the alert text); verify with `api.ts <RUN_ID> status`.
- **Second observation:** `api.ts <RUN_ID> status > <EVIDENCE>/pair-admin-status.json` must list a new device `"name": "iPhone"` with `pairedAt` after the action and a `lastSeenAt`.

## Gotchas

- The keyboard covers the link field and `Connect` in the Add computer sheet (KeyboardAvoidingView does not lift them), and Return does not submit. Maestro's `tapOn: "Connect"` then lands on a keyboard key and appends a letter to the link; `hideKeyboard` fails. Users hit the same wall; report it instead of driving around it with coordinates.
- `setClipboard` sets Maestro's own clipboard; the app reads the device pasteboard, so use `xcrun simctl pbcopy`.
- With Simulator.app's `PasteboardAutomaticSync = 1`, whatever is copied on the Mac replaces the simulator pasteboard. In the proof runs this pasted unrelated Mac clipboard text — once an API key — into the link field, so failure screenshots and hierarchies can capture host secrets. Delete such artifacts immediately and fall back to the deep link.
- A pairing flow that times out on the machine name may still have paired: check `status` before retrying, because every retry adds a device.
- The Computers row reads `Computer, <name>, Online, Forward`; the empty-state button reads `add, Add computer`.
- Re-pairing a computer that is already paired adds another server device record (several `iPhone` entries in `status` and the menu bar) while the app keeps one row. Count devices by `pairedAt`, not by name.
- Pairing codes are single-use and expire after 10 minutes; `api.ts … get` pairs `verify-probe` with its own code, so it also appears as a device.
- The pairing URL host is the Mac's Tailscale MagicDNS name when Tailscale is connected, else `127.0.0.1`; both reach the server from the Simulator. No config key overrides it.
