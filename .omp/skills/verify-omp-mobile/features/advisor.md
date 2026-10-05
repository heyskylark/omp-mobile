# Advisor

The composer's `+` menu (`Composer menu`) has an **Advisor** switch below **Usage**. It turns OMP's advisor on or off for one session: a second model, the user's `advisor` model role, that reviews each turn and adds notes. The server sends OMP's own `/advisor on|off` to the session's rpc child, then `/omp-mobile-advisor on|off` so the extension records an `omp-mobile-advisor` custom entry. OMP keeps the switch only in memory, so the server reads that entry and starts every later rpc child for the session with `--advisor`.

## Sub-features

- `advisor-menu`: the `Advisor` row shows a trailing switch; tapping it flips the switch, closes the menu, and applies the change. **Exercised** (`advisor.yaml`).
- `advisor-new`: on New session the switch is local until `Send`; the server turns the advisor on before the first prompt (`POST /v1/sessions` with `advisor: true`). **Exercised.**
- `advisor-switch`: an open session turns the advisor off or on (`POST /v1/sessions/:id/advisor`); the server starts an rpc child if the session is idle. **Exercised** (on → off).
- `advisor-restore`: after the rpc child closes, the session snapshot still reports the recorded switch, and the next prompt starts OMP with `--advisor` only when the switch is on. **Exercised** through the API (see Second observation).
- `advisor-no-model`: when no model has the `advisor` role, OMP answers `/advisor on` with `Advisor setting enabled, but no model is assigned to the 'advisor' role.`; the server sends `/advisor off`, records nothing, and the app shows that text as an error toast with the switch off. Recipe-only end to end: a server-started OMP still answered `Advisor enabled.` with a scratch `HOME` and an empty `PI_CODING_AGENT_DIR`, while a hand-started `omp --mode rpc-ui` with the same `HOME` gave the error. `live.test.ts` covers the server path with a fake OMP.
- `advisor-terminal`: a session running in a terminal refuses the change (`This session is open in a terminal…`) and disables the row. Recipe-only.

## Driving it with Maestro

Preconditions: app paired to this run's server. Costs one small model turn plus one advisor review on the user's `advisor` role model.

```sh
maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/advisor -e MACHINE_NAME=<MACHINE_NAME> -e 'PROMPT=Reply with the single word ready.' .omp/skills/verify-omp-mobile/flows/advisor.yaml
```

Screenshots `advisor-01-menu-off` … `advisor-05-session-menu-off`. Selectors: `Composer menu`, `Advisor` (the switch row), `Close menu` (backdrop).

- **Second observation:** `api.ts <RUN_ID> get '/v1/sessions/<id>?limit=50'` shows `"advisor": false` after the flow. The session file under `~/.omp/agent/sessions/-.cache-omp-mobile-verify-<RUN_ID>-work-project/` holds `custom` entries `omp-mobile-advisor` with `{ "enabled": true }`, then `{ "enabled": false }`. The session's folder beside it holds `__advisor.jsonl`, OMP's advisor transcript, once a turn ran with the advisor on.
- **Restore:** `POST /v1/sessions/<id>/handoff` closes the rpc child; the next prompt's `omp --mode rpc-ui` process carries `--advisor` only while the switch is on (`ps -axo args`), and `__advisor.jsonl` grows only then.

## Gotchas

- The switch flips at once and the menu closes before the server answers. A failure flips it back and shows a toast.
- OMP has no rpc command or `get_state` field for the advisor. The server reads the `command_output` text of `/advisor on`; only `Advisor enabled.` counts as on.
