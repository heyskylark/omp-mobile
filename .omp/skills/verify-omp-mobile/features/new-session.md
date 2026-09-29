# New session from the phone

The user picks a project folder on the computer (a recent project or one found by browsing the configured roots), types a prompt, and the computer starts an OMP session there that the phone follows live.

## Sub-features

- `new-browse`: `Browse` → `Choose folder` → folder row → `Use this folder` → prompt → `Send`. **Exercised** (`new-session-approve.yaml`).
- `new-recent`: tap a recent project row (name, path, session count) instead of browsing. Recipe-only.
- `new-parent`: `Parent folder` and breadcrumb segments in `Choose folder`; the browser never leaves the configured `roots`. Recipe-only.
- `new-created`: on success the screen is replaced by the new transcript, header subtitle `<project> · Running` / `Needs you`. **Exercised.**

## How to get to it (user POV)

- Computers → computer → `+` in the session-list header → `New session` screen (`PROJECT` label, `Browse`, recent projects, composer `Message OMP`).
- `Send` stays disabled until a project is selected and the prompt is non-blank.

## Driving it with Maestro

Preconditions: app paired to this run's server; the run's `config.json` restricts `roots` to `<SCRATCH>/work`, which holds the git repo `project` — so `Choose folder` opens at `work` and shows `project`.

```sh
maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/new-session -e MACHINE_NAME=<MACHINE_NAME> -e TOKEN=<unique-word> .omp/skills/verify-omp-mobile/flows/new-session-approve.yaml
```

- The flow browses to `project`, sends `Run bash: echo <TOKEN>. Then reply with the single word done.`, approves the bash call (see `live-session-interactions.md`), waits for the reply `done` and the composer's `Send`, then expands the tool card and asserts `OUTPUT, <TOKEN>`.
- Screenshots: `new-01-folder-browser`, `new-02-composer`, `new-03-approval-pending`, `new-04-turn-finished`, `new-05-tool-output`.
- Second observation: find the session whose title contains `<TOKEN>` in `api.ts <RUN_ID> get '/v1/sessions?limit=5'`, then save `api.ts <RUN_ID> get '/v1/sessions/<id>?limit=50' > <EVIDENCE>/new-session-api-snapshot.json`; it must show `session.project.path == <PROJECT>` and a `bash` tool item with `state: "succeeded"` whose `output` starts with `<TOKEN>`.
- **Recent project (recipe):** after one session exists in `<PROJECT>`, the New session screen lists it; select with `".*<PROJECT>.*"` instead of `Browse`.

## Gotchas

- Use a new `TOKEN` per attempt; the prompt text also contains the token and `done`, so assertions must be full-match regexes that only the reply (`(?i)done\.?`) or the expanded card (`(?s).*OUTPUT, <TOKEN>\b.*`) satisfy.
- Every attempt starts a real OMP process and model turn; the server keeps it (`live.server` in `status`) until the turn settles and no phone is watching.
- While the approval is pending, the transcript may show only the tool card; the user bubble appears after the snapshot refresh.
- Sessions created here are written to `~/.omp/agent/sessions/-.cache-omp-mobile-verify-<RUN_ID>-work-project/`; `cleanup.sh` deletes that bucket, so save any transcript evidence first.
