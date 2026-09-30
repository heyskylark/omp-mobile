---
name: verify-omp-mobile
description: Verify OMP Mobile end to end — the Expo iOS app in a dedicated iOS Simulator driven by Maestro, paired to an isolated Bun server (loopback admin API + Tailscale app URL), plus the macOS menu bar app. Use when proving app, server, pairing, session, approval, or menu bar behavior after a change in this repository.
---

# Verify OMP Mobile

Every command runs from the repository root. `$RUN_ID` / `<RUN_ID>` is the run id chosen under Scope (tool calls may not share shell variables, so substitute it literally); other `<ANGLE_BRACKETS>` values come from the run's `run.env` or a previous step's output.

## Scope

- **Surfaces:** iOS app (`app/`, bundle `com.heyskylark.ompmobile`) in the iOS Simulator; Bun server (`server/src/main.ts`) through its public `/v1/*` API and loopback `/admin/*` API; macOS menu bar app (`macos/`).
- **Runtimes:** macOS, Xcode with an iOS 26.x runtime and the `iPhone 17 Pro` device type, Bun, `omp` on `PATH` (18.4.x), Maestro CLI (`/opt/homebrew/bin/maestro`, 2.10.0) with a JDK on `PATH`, Tailscale optional.
- **Isolation:** each run owns a run id (`RUN_ID=$(date +%Y%m%d-%H%M%S)`), a server home + scratch project under `~/.cache/omp-mobile-verify/$RUN_ID/`, ports `28787`/`28788` (or another free pair), and a simulator named `omp-verify-$RUN_ID` created for the run. Concurrent runs need distinct ports. Never drive the installed LaunchAgent server (`com.heyskylark.omp-mobile.server`, ports 8787/8788), the e2e ports 18787/18788, or a simulator the run did not create.
- **Not isolated:** the server always reads `$HOME/.omp/agent/sessions` (`server/src/main.ts`), i.e. the invoking user's real history. History recipes read real sessions read-only; sessions the run creates land in buckets named `-.cache-omp-mobile-verify-$RUN_ID-*`, which cleanup removes. For an empty history (e.g. `No sessions yet`), start a second run's server with `HOME=<that run's SCRATCH>` in front of its command.
- **One computer per Mac:** the server's `machineId` is a hash of the Mac's hostname, so every run's server on this Mac is the *same computer* to the app. Pairing a second run's server replaces the first one's entry on the phone (removing it then leaves the Computers list empty). Re-pair the run you need next.
- **Cost:** new-session and interaction recipes run real model turns with `openai-codex/gpt-5.6-terra:medium` (`rpcArgs` in the run's `config.json`).
- **Non-goals / physical-device only:** QR scanning (Simulator has no camera), APNs delivery and notification-service decryption, TestFlight/Release-on-device behavior, performance.

## Launch

Run from the checkout under test (a feature worktree per `.omp/AGENTS.md`). In a fresh worktree run `bun install` first. `app/ios` is not committed; `scripts/simulator.sh` reruns `expo prebuild --clean` whenever it is missing or was generated from other inputs (for example cloned into a new worktree from another checkout, or built with a different `OMP_BUNDLE_ID`). Helpers resolve the repository from their own location, so invoke the copies inside the checkout under test.

1. Prepare scratch, config, and evidence root (refuses busy ports or an existing run id):

   ```sh
   .omp/skills/verify-omp-mobile/bin/prepare-run.sh "$RUN_ID"          # optional 2nd arg: base port
   ```

   It prints `run.env` (`PORT`, `OMP_MOBILE_HOME`, `PROJECT`, `EVIDENCE`, `MACHINE_NAME=omp-verify-$RUN_ID`, …) stored at `~/.cache/omp-mobile-verify/$RUN_ID/run.env`. Write down the printed values; later commands use them literally.

2. Start the server as a supervised long-lived process (OMP `bash` with `name` + `ready`; never `&`/`nohup`):

   - `name`: `omp-mobile-verify-server-$RUN_ID`
   - `command`: `OMP_MOBILE_HOME=<OMP_MOBILE_HOME> bun server/src/main.ts`
   - `ready`: `{"log": "OMP Mobile server listening at", "port": <PORT>, "timeout": 60}`

   The ready line prints the pairing URL host: `http://<mac>.<tailnet>.ts.net:<PORT>` when Tailscale is connected, `http://127.0.0.1:<PORT>` otherwise. Both work from the Simulator on this Mac. Logs: `read proc://omp-mobile-verify-server-$RUN_ID`.

3. Create and boot the run's simulator on the newest installed iOS 26.x runtime (prints its UDID, appends `SIM_UDID` to `run.env`; exits naming the missing runtime if no iOS 26.x runtime is available). Never let `simctl` pick the newest runtime: the Release app crashes at launch on iOS 27.

   ```sh
   .omp/skills/verify-omp-mobile/bin/sim-create.sh "$RUN_ID"            # optional 2nd arg: device type name
   ```

4. Build the Release app (JS bundle embedded, no Metro) and install/launch it on that UDID only:

   ```sh
   scripts/simulator.sh <SIM_UDID>
   ```

   ~3 min first build; ends with `Installed and launched OMP on <SIM_UDID>`. Set `OMP_BUNDLE_ID` identically for build and flows if you use a non-default bundle id.

5. Menu bar app (only for `features/menubar.md`): `macos/build.sh` (prints `Built …/macos/build/OMP Mobile.app`), then a supervised process with `name` `omp-mobile-verify-menubar-$RUN_ID` and `command` `OMP_MOBILE_HOME=<OMP_MOBILE_HOME> OMP_MOBILE_OPEN_PAIRING=1 "macos/build/OMP Mobile.app/Contents/MacOS/OMP Mobile"`. It prints nothing, so give no `ready`; readiness is its pairing window captured by `window-shot.sh` (see menubar recipe). Never `open` the bundle: LaunchServices would own the process and may activate an installed copy with the same bundle id.

## Doctor

Read-only. Run before the first drive and after any surprising failure:

```sh
.omp/skills/verify-omp-mobile/bin/doctor.ts "$RUN_ID"                  # --no-sim before step 3 of Launch
```

Every line must be `ok`. It proves: `omp --version`; `server.json` pid is the listener on the run port; `GET /admin/status` answers with this run's machine name and a non-null `ompVersion`; paired devices/live counts/problems; the simulator is this run's, `Booted`, and on an iOS 26.x runtime; the app is installed with an embedded `main.jsbundle` newer than every file in `app/src` and `packages/protocol/src` (else rebuild); Maestro and Java work. A `FAIL` names the fix.

## Drive

Harness: Maestro CLI flows shipped in `.omp/skills/verify-omp-mobile/flows/`, always with the explicit device and a per-flow output dir inside the evidence root:

```sh
maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/<flow> -e KEY=value … .omp/skills/verify-omp-mobile/flows/<flow>.yaml
```

- Pair first (every fresh simulator) through the deep link — the same `ompmobile://pair` link the QR code encodes. It needs no clipboard and answers iOS's `Open in “OMP”?` and notification-permission prompts:

  ```sh
  .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> pair-link
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/deeplink -e 'PAIR_LINK=<link>' -e MACHINE_NAME=<MACHINE_NAME> .omp/skills/verify-omp-mobile/flows/pair-deeplink.yaml
  .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> status > <EVIDENCE>/pair-admin-status.json
  ```

  The status file must list a new `iPhone` device. The Add computer paste button is a separate recipe (`features/pairing.md`) because it reads the pasteboard, which Simulator.app may overwrite with the Mac's.

- Feature recipes and their flows: `features/README.md`.
- Selectors: Maestro text selectors are **full-match, case-insensitive regexes** against each element's accessibility text. Many elements expose iOS-synthesized text that is not in product source: SF Symbol names (`add` for the `plus` header icon, `More` for `ellipsis.circle`, `paste` for the clipboard icon) and concatenated rows (`add, Add computer`; `Computer, <name>, Online, Forward`; `<title>, <project>, · <age>, <preview>`; `wrench.and.screwdriver, <title>, <tool>, selected`). Use `.*` anchors, escape `? . ( ) [ ] * + |` in dynamic values, and never wait on a word that also appears in your own prompt or token (`".*Approve.*"` matches a token containing `approve`). Wait on card titles such as `Allow tool: .*` instead.
- Inspect the live screen when a selector misses:

  ```sh
  maestro --device <SIM_UDID> hierarchy | .omp/skills/verify-omp-mobile/bin/texts.ts
  .omp/skills/verify-omp-mobile/bin/texts.ts <EVIDENCE>/maestro/<flow>/<ts>/<flow>/screen-hierarchy/<step>.json
  ```

- Server-side second observation (read-only GETs as a separate `verify-probe` device, paired once per run on first use):

  ```sh
  .omp/skills/verify-omp-mobile/bin/api.ts "$RUN_ID" status
  .omp/skills/verify-omp-mobile/bin/api.ts "$RUN_ID" get '/v1/sessions?limit=5'
  .omp/skills/verify-omp-mobile/bin/api.ts "$RUN_ID" get '/v1/sessions/<sessionId>?limit=50'
  ```

  The probe appears as a paired device named `verify-probe` in the app-facing server and in the menu bar; account for it when asserting device lists. If a recipe removed it, the next `get` pairs a new probe automatically.

## Evidence

- Root: `.verify-evidence/<RUN_ID>/` in the repository (git-ignored, outside scratch; cleanup never touches it).
- Maestro writes each flow's named screenshots to `<EVIDENCE>/maestro/<flow>/<timestamp>/<flow-name>/takeScreenshot/*.png`, plus `commands.json`, logs, and on failure the failing step's screenshot and `screen-hierarchy/*.json`. `takeScreenshot` paths must be relative; absolute paths are rejected.
- Each recipe captures the action (before/pending screenshot) **and** the result, then saves a read-only server observation next to it, e.g. `api.ts "$RUN_ID" status > <EVIDENCE>/pair-admin-status.json`.
- Look at every screenshot you cite with OMP `read` on the PNG path. A passing Maestro exit code alone is not visual proof; neither is a `visible` assertion whose regex could match the user's own prompt.
- Menu bar evidence comes only from `window-shot.sh`, which captures the process's own windows; never full-screen `screencapture` (it records unrelated private windows).

## Performance

No performance acceptance exists for this repository. Simulator runs use a Release JS bundle but prove function only; timing, memory, and push latency need a physical device with a TestFlight/Release build and Instruments, which this skill does not cover.

## Cleanup

Same steps after success or failure:

1. `write proc://omp-mobile-verify-menubar-$RUN_ID/kill` (if started), then `write proc://omp-mobile-verify-server-$RUN_ID/kill`. Stop only names this run started.
2. `.omp/skills/verify-omp-mobile/bin/cleanup.sh "$RUN_ID"` — refuses while the run port listens; shuts down and deletes only the simulator named `omp-verify-$RUN_ID`; removes `~/.omp/agent/sessions/-.cache-omp-mobile-verify-$RUN_ID-*` and `~/.cache/omp-mobile-verify/$RUN_ID`; prints `Evidence kept: … (N files)`.
3. Confirm the evidence files you cite still open with `read`.

## Helpers

All in `.omp/skills/verify-omp-mobile/bin/`, executable, invoked exactly as above:

| Helper | Does |
|---|---|
| `prepare-run.sh <run-id> [port]` | scratch home/config/project, `collab.yml`, evidence root, `run.env` |
| `sim-create.sh <run-id> [device type]` | create + boot `omp-verify-<run-id>` on the newest iOS 26.x runtime, record `SIM_UDID` |
| `doctor.ts <run-id> [--no-sim]` | read-only readiness check |
| `api.ts <run-id> pair-link \| status \| get </v1/…>` | one-time pairing link; admin status; probe-device GETs |
| `texts.ts [hierarchy.json]` | compact Maestro hierarchy (stdin or file) |
| `window-shot.sh <pid> <prefix>` | capture only that process's windows (Screen Recording permission) |
| `menubar-remove.sh <pid> <device-name>` | click the menu bar panel's `Remove` for one device (Accessibility permission) |
| `cleanup.sh <run-id>` | remove run scratch, simulator, session buckets; keep evidence |

Repository-native commands reused: `scripts/simulator.sh <udid>`, `macos/build.sh`, `bun run e2e` (API-level regression over real OMP on ports 18787/18788; run it too after OMP upgrades).
