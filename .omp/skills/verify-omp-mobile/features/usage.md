# Usage

`/usage` in any composer opens a sheet with the subscription limits of every provider account signed in to OMP on the computer. The server answers `GET /v1/usage` by running `omp usage --json`. The command never reaches the agent.

## Sub-features

- `usage-new-session`: `/usage` + `Send` on New session opens the sheet, even before a project is picked (Send is otherwise disabled). **Exercised** (`usage.yaml`). The run's roots hold no sessions until the flow creates one, so only the flow's first pass on a run starts with no project picked.
- `usage-session`: `/usage` + `Send` in an open session opens the sheet and sends no prompt. **Exercised.** Sending it while a turn runs (the button reads `Send`, not `Steer`) is recipe-only.
- `usage-close`: the top-left `Close` button dismisses the sheet. **Exercised.**
- `usage-swipe`: swiping the sheet down dismisses it. **Exercised.**
- `usage-empty`: a computer with no signed-in subscription provider shows `No usage data`. Recipe-only: it needs an OMP agent dir without credentials.

## Driving it with Maestro

Preconditions: app paired to this run's server. Costs one small model turn.

```sh
maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/usage -e MACHINE_NAME=<MACHINE_NAME> -e 'PROMPT=Reply with the single word ready.' .omp/skills/verify-omp-mobile/flows/usage.yaml
```

Screenshots `usage-01-typed` … `usage-05-swiped-down`. Selectors: `Close` (sheet header), limit rows `<label>, <N>% used`.

- **Second observation:** `api.ts <RUN_ID> get /v1/usage > <EVIDENCE>/usage-api.json`. Its limits must match the sheet's rows and `omp usage` in a terminal. The new session from `api.ts <RUN_ID> get '/v1/sessions/<id>?limit=50'` must hold one user message (the prompt) and no `/usage` text.

## Gotchas

- The server reads the invoking user's real OMP credentials, so the rows are the user's real accounts and limits. Screenshots show account emails.
