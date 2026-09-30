# New session from the phone

The user picks a project folder on the computer (a recent project or one found by browsing the configured roots), types a prompt, and the computer starts an OMP session there that the phone follows live.

## Sub-features

- `new-browse`: `Browse` → `Choose folder` → folder row → `Use this folder` → prompt → `Send`. **Exercised** (`new-session-approve.yaml`).
- `new-recent`: tap a recent project row (name, path, session count). **Exercised** (`new-session-recent.yaml`).
- `new-parent`: `Parent folder` and breadcrumb segments in `Choose folder`. The server never lists outside the configured `roots`. Breadcrumb segments above a root are still tappable and end in `Directory is outside the allowed roots`. Recipe-only (the browse flow shows the breadcrumb; the server check is below).
- `new-created`: success replaces New session with the transcript; header subtitle `<project> · Running` or `· Needs you` while active, no badge once idle. **Exercised.**

## How to get to it (user POV)

- Computers → computer → `+` in the session-list header → `New session` (`PROJECT` label, `Browse`, recent projects, composer `Message OMP`).
- `Send` stays disabled until a project is selected and the prompt is non-blank. New session pre-selects the most recent project.

## Driving it with Maestro

Preconditions: app paired to this run's server; the run's `config.json` restricts `roots` to `<SCRATCH>/work`, which holds the git repo `project`. Recent projects are filtered to those roots, so only scratch projects appear.

- **Browse + approve:**

  ```sh
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/new-session -e MACHINE_NAME=<MACHINE_NAME> -e TOKEN=<unique-word> .omp/skills/verify-omp-mobile/flows/new-session-approve.yaml
  ```

  The flow browses to `project`, sends `Run bash: echo <TOKEN>. Then reply with the single word done.`, waits for `Allow tool: .*`, taps `Approve`, waits for `done` and the composer's `Send`, then expands the only tool card and asserts `OUTPUT, <TOKEN>`. Screenshots: `new-01-folder-browser` … `new-05-tool-output`.
- **Recent project:**

  ```sh
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/recent -e MACHINE_NAME=<MACHINE_NAME> -e 'PROJECT=<regex-escaped PROJECT path>' -e 'PROMPT=Reply with the single word ready.' .omp/skills/verify-omp-mobile/flows/new-session-recent.yaml
  ```

  `recent-01-project-selected` shows the `project` row with its path and session count; `recent-02-session-created` shows the transcript with the reply. This session is the starting point for `live-session-interactions.md`.
- **Roots confinement (server):** `api.ts <RUN_ID> get '/v1/fs/dirs?path=/etc'` must fail with HTTP 403 `Directory is outside the allowed roots`.
- **Second observation:** find the session whose title contains `<TOKEN>` in `api.ts <RUN_ID> get '/v1/sessions?limit=5'`, then save `api.ts <RUN_ID> get '/v1/sessions/<id>?limit=50' > <EVIDENCE>/new-session-api-snapshot.json`. It must show `session.project.path == <PROJECT>` and a `bash` tool item with `state: "succeeded"` whose `output` starts with `<TOKEN>`.

## Gotchas

- Maestro matching ignores case. A token containing `approve` makes `".*Approve.*"` match the composer before any card exists; the flow waits for `Allow tool: .*` and taps the exact `Approve`.
- Use a new `TOKEN` per attempt. `done` also appears in the prompt, so its assertion is a full match (`(?i)done\.?`) that only the reply satisfies.
- Every attempt starts a real OMP process and model turn; the server keeps it (`live.server` in `status`) until the turn settles and no phone is watching.
- Sessions created here are written to `~/.omp/agent/sessions/-.cache-omp-mobile-verify-<RUN_ID>-work-project/`; `cleanup.sh` deletes that bucket, so save any transcript evidence first.
- `prepare-run.sh` puts `--no-title` in `rpcArgs`, so sessions keep their prompt as the title and the `<TOKEN>` lookups above work. The extension otherwise gives phone sessions OMP's generated auto title (an extra title-model call); to verify that, drop `--no-title` from `<OMP_MOBILE_HOME>/config.json` before starting the server, then expect the JSONL title slot (line 1) and `/v1/sessions` to show the generated title. A low-signal first prompt (`hi`) stays untitled until a later descriptive prompt.
