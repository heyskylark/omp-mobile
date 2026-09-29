# Live session, questions, and approvals

The user follows a running session, answers the agent's `ask` questions and tool approvals pinned above the composer (or from a notification), sends follow-up prompts, stops a turn, and hands a server-run session back to the terminal. Terminal sessions are driven through OMP Collab at the same time.

## Sub-features

- `live-approve`: approval card `Allow tool: <tool>` with `Deny` / `Approve`. **Exercised** (Approve, in `new-session-approve.yaml`).
- `live-deny`: tap `Deny`; the tool item ends not succeeded. Recipe-only.
- `live-question`: `ask` card with option buttons; `Other…` or `Your response` field plus `Send` for text. Recipe-only.
- `live-followup`: type in `Message OMP`, tap `Send` on an existing session. Recipe-only.
- `live-stop`: composer shows `Stop` while a turn runs; tapping it aborts (`POST /v1/sessions/<id>/abort`). Recipe-only.
- `live-handoff`: `Session menu` → alert `Hand off to computer?` → `Hand off`; session becomes idle. Recipe-only.
- `live-terminal`: a session started in a terminal shows `In terminal` and accepts phone prompts/approvals over Collab. Recipe-only (API path covered by `bun run e2e` phase C).
- `live-notification-actions`: long-press notification → `Approve` / `Deny` / `Reply` / `Open`. Physical device only for real APNs; see Gotchas.

## How to get to it (user POV)

- Open any session whose liveness is `Running`, `Needs you`, or `In terminal`; pending interactions sit directly above the composer.
- Session header ellipsis (`Session menu`) appears only for server-managed sessions.
- Notifications arrive from the computer via APNs when `apns` is configured; tapping opens the session.

## Driving it with Maestro

Preconditions: app paired; a live session exists. Create one with `new-session-approve.yaml` or a partial copy of it that stops at the pending card.

- **Approve (exercised):** wait for `".*Approve.*"`, screenshot, `tapOn: ".*Approve.*"`, wait for the reply, then `Send` visible (turn settled). Server check: tool item `state: "succeeded"` and `pending: []` in `api.ts <RUN_ID> get '/v1/sessions/<id>?limit=50'`.
- **Deny:** same prompt with a new token; `tapOn: ".*Deny.*"`; the snapshot's bash item must not be `succeeded` and no `OUTPUT, <TOKEN>` appears.
- **Question:** prompt `Use the ask tool to ask me one question titled Color with options Red and Blue. Then reply with the color I picked.` (the prompt `scripts/e2e.ts` uses); wait for `".*Blue.*"` inside the card, tap it, assert the reply. Snapshot `pending` empties.
- **Follow-up / Stop:** `tapOn: "Message OMP"`, `inputText`, `tapOn: "Send"`; for stop, send a long-running prompt, wait for `"Stop"`, tap it, wait for `"Send"`.
- **Hand off:** `tapOn: "Session menu"`, `tapOn: "Hand off"`; then `api.ts … get '/v1/sessions/<id>?limit=5'` shows `liveness.kind: "idle"` after the turn settles.
- **Terminal session:** start a supervised PTY process (OMP `bash` with `name: omp-mobile-verify-tui-<RUN_ID>`, `pty: true`, no `&`):
  `cd <PROJECT> && OMP_MOBILE_HOME=<OMP_MOBILE_HOME> omp --config <SCRATCH>/collab.yml -e <REPO>/extension/omp-mobile.ts --approval-mode always-ask --model openai-codex/gpt-5.6-terra:medium --no-lsp --no-title`.
  Wait until `api.ts … get '/v1/sessions?limit=20'` lists an item with `project.path == <PROJECT>` and `liveness.kind: "terminal"`; open it in the app (`In terminal`), send a prompt, approve from the phone, and read the TUI with `read proc://omp-mobile-verify-tui-<RUN_ID>`. Stop it with `write proc://omp-mobile-verify-tui-<RUN_ID>/kill` before cleanup.

## Gotchas

- Composer accessibility labels are exactly `Send` and `Stop`; the placeholder is `Message OMP`. `Send` visible is the reliable "turn settled" signal.
- `--approval-mode always-ask` in the run's `rpcArgs` makes every tool call wait for approval; a flow that does not answer leaves the server session in `Needs you`.
- Card and output elements concatenate text; assertions must full-match (`(?s).*OUTPUT, <TOKEN>\b.*`), otherwise they match the user's own prompt.
- Notifications: the run's server has no `apns` config (`APNs not configured`), so nothing is pushed. `xcrun simctl push <SIM_UDID> com.heyskylark.ompmobile app/dev/push-sample.apns` delivers a sample, but per the README the notification service extension does not run for `simctl` pushes, and the sample is sealed for machine `test-machine`, not this run's pairing. Decryption and action proof needs a physical device.
- The server closes its own OMP process once a turn settles and no phone is watching; `live.server` in `status` drops back to 0 on its own.
