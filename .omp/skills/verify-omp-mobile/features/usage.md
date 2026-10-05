# Usage

The composer's `+` button (`Composer menu`) opens a menu with **Photos**, **Usage**, and the **Advisor** switch (`advisor.md`). **Usage** opens a sheet with the subscription limits of every provider account signed in to OMP on the computer. The server answers `GET /v1/usage` by running `omp usage --json`. Nothing reaches the agent, and typing `/usage` is an ordinary prompt.

## Sub-features

- `usage-menu`: tapping `Composer menu` opens a blurred card just above the composer, keyboard left as it was, with `Photos` (photo library; dimmed when four images are attached), `Usage`, and `Advisor`. Tapping outside closes it. **Exercised** (`usage.yaml`).
- `usage-new-session`: `Composer menu` → `Usage` on New session opens the sheet, even before a project is picked. **Exercised** (`usage.yaml`). The run's roots hold no sessions until the flow creates one, so only the flow's first pass on a run starts with no project picked.
- `usage-session`: `Composer menu` → `Usage` in an open session opens the sheet and sends no prompt. **Exercised.**
- `usage-close`: the top-left `Close` button dismisses the sheet. **Exercised.**
- `usage-swipe`: swiping the sheet down dismisses it. **Exercised.**
- `usage-empty`: a computer with no signed-in subscription provider shows `No usage data`. Recipe-only: it needs an OMP agent dir without credentials.

## Driving it with Maestro

Preconditions: app paired to this run's server. Costs one small model turn.

```sh
maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/usage -e MACHINE_NAME=<MACHINE_NAME> -e 'PROMPT=Reply with the single word ready.' .omp/skills/verify-omp-mobile/flows/usage.yaml
```

Screenshots `usage-01-menu` … `usage-05-swiped-down`. Selectors: `Composer menu`, `Usage` and `Photos` (menu rows), `Close` (sheet header), limit rows `<label>, <N>% used`.

- **Second observation:** `api.ts <RUN_ID> get /v1/usage > <EVIDENCE>/usage-api.json`. Its limits must match the sheet's rows and `omp usage` in a terminal. The new session from `api.ts <RUN_ID> get '/v1/sessions/<id>?limit=50'` must hold exactly one user message (the prompt).

## Gotchas

- The server reads the invoking user's real OMP credentials, so the rows are the user's real accounts and limits. Screenshots show account emails.
