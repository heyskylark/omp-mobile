# OMP Mobile verification map

Maintained source for proving OMP Mobile's user-facing behavior. Read this index, then the matching recipe. Launch, Doctor, Evidence, and Cleanup live in `../SKILL.md`.

## Baseline preconditions

- A run prepared with `prepare-run.sh`, its server supervised as `omp-mobile-verify-server-<RUN_ID>`, its own simulator from `sim-create.sh` with the current Release build installed by `scripts/simulator.sh <SIM_UDID>`, and `doctor.ts <RUN_ID>` all `ok`.
- Every recipe except the first pairing starts with the app paired to this run's server (`pairing.md`, deep link via `pair-deeplink.yaml`).
- Never drive the LaunchAgent server, another run's ports, or a simulator the run did not create.
- Scratch state (`~/.cache/omp-mobile-verify/<RUN_ID>/`) is disposable; evidence (`.verify-evidence/<RUN_ID>/`) is not.

## Driving conventions

- Maestro CLI with `--device <SIM_UDID>` and `--test-output-dir <EVIDENCE>/maestro/<flow>`; flows live in `../flows/`.
- Selectors are full-match, case-insensitive regexes on accessibility text. Use the concatenated forms recorded in each recipe; escape regex metacharacters in titles and links; never wait on a word your own prompt or token also contains.
- Prefer visible labels and the SF Symbol names iOS exposes (`add`, `More`, `paste`, `Send`, `Stop`, `Session menu`) over coordinates. No app element has a `testID`.
- `launchApp` restarts the app at the Computers list; recipes navigate from there.
- Put device clipboard content with `xcrun simctl pbcopy <SIM_UDID>`; Maestro's `setClipboard` never reaches the app.

## Proof and skip reporting

- Capture the action (pending/before screenshot) and its result; `read` every screenshot you cite.
- Pair every mutation with a read-only server observation from `api.ts <RUN_ID> status` or `api.ts <RUN_ID> get …`, saved under the evidence root.
- Report feature/sub-feature id, entry point, simulator name + iOS version, build (`Release`, simulator), and evidence paths.
- An unreachable entry point is reported with the attempted route and the unmet prerequisite (e.g. "QR scan: Simulator has no camera"). A convenient alternate path does not prove it.
- Each recipe notes which sub-features have been exercised by a real run and which remain recipe-only.

## Features

- [Pairing a computer](./pairing.md) — deep link, typed link, paste button, QR, rejected links, re-pair replacement, remove computer.
- [Session history](./session-history.md) — session list, transcript, older-page loading, thought and tool expansion, empty history.
- [New session from the phone](./new-session.md) — folder browser or recent project, first prompt, roots confinement.
- [Live session, questions, and approvals](./live-session-interactions.md) — approve/deny, questions, follow-up, stop, hand off, terminal (Collab) sessions, notification actions.
- [Menu bar app](./menubar.md) — pairing window and consumed-code confirmation, status panel and status item, remove device, offline.
