# Live session, questions, and approvals

The user follows a running session, answers the agent's `ask` questions and tool approvals pinned above the composer (or from a notification), sends follow-up prompts, stops a turn, and hands a server-run session back to the terminal. Terminal sessions are driven through OMP Collab at the same time.

## Sub-features

- `live-approve`: approval card `Allow tool: <tool>` (title from OMP) with detail `Command: …` and buttons `Deny` / `Approve`. **Exercised** (`new-session-approve.yaml`, `prompt-approve.yaml`).
- `live-deny`: `Deny`; the tool item ends `failed` with output `Tool call denied by user: bash`. **Exercised** (`live-interactions.yaml`).
- `live-question`: question card with one button per option; `Other…` or `Your response` field plus `Send` for text answers. **Exercised** (option `Blue`, `live-interactions.yaml`); custom text recipe-only.
- `live-followup`: `Message OMP` + `Send` on an existing session. **Exercised** (every step of `live-interactions.yaml`).
- `live-stop`: the composer shows `Stop` only while a *server* session is starting, working, or settling; tapping it aborts the turn. **Exercised.**
- `live-outgoing`: a sent message shows at once after the transcript as of sending (and after every message the transcript already holds) as `<text>, Sending…`, then `<text>, Sent`, until the transcript holds it; replies that stream in meanwhile show below it, including a new session's first reply, which streams before OMP records the first prompt. A steer stays `Sent` while OMP queues it. **Exercised** (`optimistic-send.yaml`).
- `live-outgoing-failed`: `<text>, Not sent. Tap to retry.` when the request fails; `<text>, Not delivered. Tap to retry.` when the computer took it but the session went idle for 4 seconds without it. A failed bubble keeps its place while later replies arrive; `Try Again` moves it to the bottom. Tapping opens `Not sent` or `Not delivered` with `Try Again`, `Edit`, `Delete`, and `Cancel`. **Exercised** (`optimistic-recover.yaml`, `Try Again` only); `Edit` and `Delete` recipe-only.
- `live-handoff`: `Session menu` (server-managed sessions only) → `Hand off to computer?` → `Hand off` → toast `Ready to resume on your computer`; the session becomes idle. **Exercised.**
- `live-terminal`: a session started in a terminal shows `In terminal` and accepts phone prompts and approvals over Collab. **Exercised** (`prompt-approve.yaml` against a supervised TUI).
- `live-notification-actions`: approval notifications offer `Approve` / `Deny`; question notifications offer `Reply` (text field, `Send`) / `Open`. Physical device only.

## How to get to it (user POV)

- Open any session whose liveness is `Running`, `Needs you`, or `In terminal`; pending interactions sit directly above the composer.
- The header ellipsis (`Session menu`) appears only when the server manages the session.
- Notifications arrive from the computer via APNs when `apns` is configured; tapping opens the session.

## Driving it with Maestro

Preconditions: app paired; the transcript of a server-managed session is open, e.g. right after `new-session-recent.yaml`.

- **Deny → question → stop → hand off** (several small model turns, one flow):

  ```sh
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/live -e TOKEN=<unique-word> .omp/skills/verify-omp-mobile/flows/live-interactions.yaml
  ```

  Screenshots `live-01-approval-pending` … `live-08-handed-off`. Second observation: `api.ts <RUN_ID> get '/v1/sessions/<id>?limit=80'` must show the denied `bash` item `failed`, an `ask` item `succeeded` with `User selected: Blue`, the story turn with no text (aborted), `pending: []`, and `liveness.kind: "idle"`.
- **Outgoing messages, failure, and retry** (three small model turns, one server restart):

  ```sh
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/optimistic -e MACHINE_NAME=<MACHINE_NAME> -e 'PROJECT=<regex-escaped PROJECT path>' -e TOKEN=<unique-word> .omp/skills/verify-omp-mobile/flows/optimistic-send.yaml
  ```

  Then `write proc://omp-mobile-verify-server-<RUN_ID>/kill`, run `optimistic-recover.yaml` with `-e PHASE=offline -e TOKEN=<another-word>`, start the server again as in Launch step 2, and run `optimistic-recover.yaml` with `-e PHASE=online` and the same `TOKEN`. Stopping the server ends its OMP process with the steer still queued, so the steer reads `Not delivered` once the phone sees the session idle. Screenshots `optimistic-01-after-send` … `optimistic-03-steer-queued` and `recover-01-not-sent` … `recover-04-delivered`. Second observation: `api.ts <RUN_ID> get '/v1/sessions/<id>?limit=80'` holds each user message exactly once: the first prompt, `Also say the word pelican.`, and `Reply with the single word <TOKEN>.`. Maestro settles the screen before each step, so it misses the first prompt's own bubble, which lasts until OMP records the prompt with the first reply. To see it, record the screen with `xcrun simctl io <SIM_UDID> recordVideo <EVIDENCE>/optimistic.mp4` during the first flow.
- **Terminal session:** start a supervised PTY process (OMP `bash` with `name` `omp-mobile-verify-tui-<RUN_ID>`; `ready` log `collab:`). The PTY replaces `scripts/pty-run.py`, which only exists because `Bun.spawn` has no PTY:

  ```sh
  cd <PROJECT> && env -u BUN_BE_BUN OMP_MOBILE_HOME=<OMP_MOBILE_HOME> omp --config <SCRATCH>/collab.yml -e <REPO>/extension/omp-mobile.ts --approval-mode always-ask --cwd <PROJECT> --model openai-codex/gpt-5.6-terra:medium --no-lsp --no-title
  ```

  `api.ts <RUN_ID> get '/v1/sessions?limit=20'` lists it with `project.path == <PROJECT>`, title `New session`, and `liveness: {"kind":"terminal"}`. Then:

  ```sh
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/terminal-open -e MACHINE_NAME=<MACHINE_NAME> -e 'SESSION_TITLE=New session' .omp/skills/verify-omp-mobile/flows/open-session.yaml
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/terminal -e TOKEN=<unique-word> .omp/skills/verify-omp-mobile/flows/prompt-approve.yaml
  ```

  `read proc://omp-mobile-verify-tui-<RUN_ID>` shows `«omp-mobile» ›`, the phone's prompt, the approved command's output, and `<TOKEN>-done`; the snapshot's newest `bash` item output starts with `<TOKEN>`. Stop it with `write proc://omp-mobile-verify-tui-<RUN_ID>/kill` before cleanup.

## Gotchas

- Composer accessibility labels are exactly `Send` and `Stop`; the placeholder is `Message OMP`. `Send` is the "turn settled" signal for server sessions only. Terminal sessions always show `Send`, so `prompt-approve.yaml` waits for its unique `<TOKEN>-done` reply instead.
- Wait on the card title `Allow tool: .*` and tap exact `Deny` / `Approve`: Maestro matching ignores case, and the prompts contain `-deny` / `approve`.
- In a reused transcript, earlier replies (`done`) and tool cards with the same model-written title already exist. Use per-attempt reply words, and prove tool output through the API rather than by tapping `.*, bash, .*` (that taps the first matching card).
- `--approval-mode always-ask` in the run's `rpcArgs` makes every tool call wait for approval; a flow that does not answer leaves the server session in `Needs you`.
- Notifications: the run's server has no `apns` config (`apnsConfigured: false`), so nothing is pushed. `xcrun simctl push <SIM_UDID> com.heyskylark.ompmobile app/dev/push-sample.apns` delivers a sample, but per the README the notification service extension does not run for `simctl` pushes, and the sample is sealed for machine `test-machine`. Decryption and action proof needs a physical device.
- The server closes its own OMP process once a turn settles and no phone is watching; `live.server` in `status` drops back to 0 on its own.
