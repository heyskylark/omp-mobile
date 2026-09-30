# Pairing a computer

The user adds a computer running the OMP Mobile server to the app with a one-time code (from the menu bar's QR code or link), re-pairs it later without leaving stale registrations behind, and can remove it. A paired computer appears on the Computers list as Online and opens its session list.

## Sub-features

- `pair-deeplink`: opening `ompmobile://pair?v=1&url=…&code=…&name=…` routes to `/pair` and connects. **Exercised** (`pair-deeplink.yaml`). This is the baseline pairing path.
- `pair-typed-link`: type the link into the `ompmobile://pair?…` field and press Go (Return) or tap `Connect`; the sheet scrolls the field and `Connect` above the keyboard. **Exercised** (`open-add-computer.yaml` + `pair-typed.yaml`, with the code shown in the menu bar window).
- `pair-paste-button`: the clipboard icon pastes the device pasteboard into the field and connects. Driven once in run `r1`; the recipe is gated by the Simulator pasteboard-sync check (see Gotchas).
- `pair-qr`: scan the menu bar QR code. Physical device only.
- `pair-rejected`: a malformed link shows `That is not a valid OMP pairing link.`; a used or expired code shows `Pairing code is invalid or expired`. **Exercised** (`pair-rejected.yaml`, both cases).
- `repair-replaces`: pairing again with a computer the phone already has (same server URL, valid saved token) replaces the phone's old server device instead of adding one. **Exercised** (`pair-deeplink.yaml` after `pair-typed.yaml`).
- `remove-computer`: computer → ellipsis → `Remove computer` → `Remove computer?` → `Remove`; the app sends `DELETE /v1/devices/me`, removes the computer, and returns to Computers. **Exercised** (`remove-computer.yaml`).
- `rename-computer`: computer → ellipsis → **Name** field → `Save`; the app sends `PUT /v1/machine/name`, the server writes `machineName` to its `config.json`, and the Computers row, the session list title, and the menu bar show the new name. **Exercised** (`rename-computer.yaml`).
- `computer-name-refresh`: a rename made elsewhere (another phone, or `config.json` plus a server restart) reaches this phone the next time the Computers list loads, without pairing again. **Exercised** (`computer-name-refresh.yaml` after a probe-device rename).

## How to get to it (user POV)

- First launch: Computers shows `Your computers, anywhere` and an `Add computer` button; with computers paired, a footer `Add computer` sits under the rows.
- `Add computer` opens a sheet titled `Add computer`: camera square, `Scan the code shown by OMP Mobile on your Mac, or paste its pairing link.`, the link field, a clipboard icon, and `Connect`.
- The link or QR comes from the Mac menu bar: `OMP Mobile` → `Connect a device…` → QR, code, `Copy link`.
- Success replaces the sheet with that computer's session list (header title = machine name). The first success on an install triggers iOS's `“OMP” Would Like to Send You Notifications`.
- Removal: open the computer, tap the ellipsis in the header.

## Driving it with Maestro

Preconditions: Launch + Doctor passed. Every pairing flow answers the notification prompt (`Allow`) and screenshots it when it appears.

- **Deep link (baseline):**

  ```sh
  .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> pair-link
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/deeplink -e 'PAIR_LINK=<link>' -e MACHINE_NAME=<MACHINE_NAME> .omp/skills/verify-omp-mobile/flows/pair-deeplink.yaml
  ```

  The flow taps `Open` on iOS's `Open in “OMP”?` prompt when it appears. Screenshots: `deeplink-00-notification-permission` (first pairing only), `deeplink-01-machine-sessions`.
- **Typed link with the menu bar's code:** launch the menu bar app (SKILL.md Launch step 5), capture its window with `window-shot.sh`, read the code, and build `<link>` as `ompmobile://pair?v=1&url=<percent-encoded server URL from doctor>&code=<code>&name=<MACHINE_NAME>`. Then:

  ```sh
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/pair-open .omp/skills/verify-omp-mobile/flows/open-add-computer.yaml
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/typed -e 'PAIR_LINK=<link>' -e MACHINE_NAME=<MACHINE_NAME> .omp/skills/verify-omp-mobile/flows/pair-typed.yaml
  ```

  `typed-01-link-above-keyboard` must show the field and `Connect` above the keyboard. After the next 5 s poll, the menu bar window shows `Connected iPhone` (`menubar.md`).
- **Rejected links:** a malformed link, then the same used link again:

  ```sh
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/rejected-malformed -e 'PAIR_LINK=ompmobile://pair?v=1&code=NOPE' -e 'EXPECT=That is not a valid OMP pairing link\.' .omp/skills/verify-omp-mobile/flows/pair-rejected.yaml
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/rejected-used -e 'PAIR_LINK=<already used link>' -e 'EXPECT=Pairing code is invalid or expired' .omp/skills/verify-omp-mobile/flows/pair-rejected.yaml
  ```

- **Re-pair:** with the computer paired, run the deep-link flow with a fresh `pair-link`. `api.ts <RUN_ID> status` must still show exactly one `iPhone` device, now with the newer `pairedAt`.
- **Paste button:** only when `defaults read com.apple.iphonesimulator PasteboardAutomaticSync` prints `0` or Simulator.app is not running; otherwise report it not driven and save that output as evidence:

  ```sh
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/pair-open .omp/skills/verify-omp-mobile/flows/open-add-computer.yaml
  printf %s '<link>' | xcrun simctl pbcopy <SIM_UDID>
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/pair -e MACHINE_NAME=<MACHINE_NAME> .omp/skills/verify-omp-mobile/flows/pair-paste.yaml
  ```

- **Rename computer:** `maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/rename -e MACHINE_NAME=<MACHINE_NAME> -e 'NEW_NAME=<new name>' .omp/skills/verify-omp-mobile/flows/rename-computer.yaml`. Then `api.ts <RUN_ID> status` must report the new `machineName`, and `<OMP_MOBILE_HOME>/config.json` must hold it next to the run's other keys. Rename back (or use the new name as `MACHINE_NAME`) before recipes that select the computer by name; `doctor.ts` checks the name against `run.env`.
- **Rename from elsewhere:** rename as the probe device, then relaunch the app:

  ```sh
  .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> get /v1/info   # pairs verify-probe once
  curl -sS -X PUT -H "authorization: Bearer $(jq -r .token ~/.cache/omp-mobile-verify/<RUN_ID>/probe.json)" -H 'content-type: application/json' -d '{"machineName":"<other name>"}' http://127.0.0.1:<PORT>/v1/machine/name
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/name-refresh -e 'NEW_NAME=<other name>' .omp/skills/verify-omp-mobile/flows/computer-name-refresh.yaml
  ```

- **Remove computer:** `maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/remove -e MACHINE_NAME=<MACHINE_NAME> .omp/skills/verify-omp-mobile/flows/remove-computer.yaml`. The computer's `status` must lose that `iPhone` device. Run it last, or on a second run's server: every run on this Mac is the same computer to the app (SKILL.md Scope).
- **Second observation:** after every step, `api.ts <RUN_ID> status > <EVIDENCE>/<step>-status.json`. Check `devices` (name, `pairedAt`, `lastSeenAt`) and `pairings[].consumedBy`, which names the device that used each code.

## Gotchas

- `setClipboard` sets Maestro's own clipboard; the app reads the device pasteboard, so the paste recipe uses `xcrun simctl pbcopy`.
- With Simulator.app's `PasteboardAutomaticSync = 1`, whatever is copied on the Mac replaces the simulator pasteboard. Earlier runs pasted unrelated Mac clipboard text, once an API key, into the link field, so failure screenshots and hierarchies can capture host secrets. Delete such artifacts immediately and fall back to the deep link.
- Re-pairing replaces the old device only when the phone's saved computer URL equals the new link's URL (ignoring one trailing slash) and its saved token is still valid. A different host form (Tailscale name vs `127.0.0.1`), port, or an already-invalid token still adds a device.
- A pairing flow that times out on the machine name may still have paired: check `status` before retrying.
- The Computers row reads `Computer, <name>, Online, Forward`; the empty-state button reads `add, Add computer`; the header ellipsis is `More`. These are iOS-synthesized labels (SF Symbol names), not source strings.
- Pairing codes are single-use and expire after 10 minutes; `api.ts … get` pairs `verify-probe` with its own code, so it also appears as a device.
- The pairing URL host is the Mac's Tailscale MagicDNS name when Tailscale is connected, else `127.0.0.1`; both reach the server from the Simulator. No config key overrides it.
