# Model roles and the composer

The composer switches a session between the OMP `smol`, `default`, and `slow` model roles (the user's `modelRoles`, thinking level included). It is a one-line pill while the keyboard is closed and the field is empty, and a panel with a toolbar under the text otherwise.

## Sub-features

- `composer-compact`: keyboard closed and no text or images → pill with `Attach image`, the field, and only `Send` (or `Stop` while a turn runs); no model button. **Exercised** (`model-role.yaml`, working-state run below).
- `composer-expanded`: keyboard open or content present → toolbar with `Attach image` on the left and `Model: <Smol|Default|Slow|Custom>`, `Steer` (running with content), `Send`/`Stop` on the right. Dragging the transcript closes the keyboard. **Exercised.**
- `role-new`: New session starts on the role chosen before `Send`; the server applies it before the first prompt. **Exercised** (slow).
- `role-switch`: an open session switches roles; the server starts an rpc child if the session is idle. **Exercised** (slow → smol while idle). Mid-turn switching is recipe-only.
- `role-picker`: tap the model button → blurred overlay above the composer (keyboard stays up) with the role title and a three-stop slider; drag or tap a stop; it springs to the stop, fires once, and closes. **Exercised** (drag and tap).
- `role-terminal`: a session running in a terminal refuses the switch (`This session is open in a terminal…`) and disables the button. Recipe-only.

## Driving it with Maestro

Preconditions: app paired to this run's server. Costs one small model turn on the user's `slow` role model.

```sh
maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/model-role -e MACHINE_NAME=<MACHINE_NAME> -e 'PROMPT=Reply with the single word ready.' .omp/skills/verify-omp-mobile/flows/model-role.yaml
```

Screenshots `role-01-compact` … `role-08-session-smol`. Selectors: `Model: <Role>` (button), `Model role Smol|Default|Slow` (slider stops; a tap on one selects it), `Dismiss model picker` (backdrop). Swipe from `Model role Default` with `direction: RIGHT` drags the knob to `slow`.

- **Second observation:** find the new session in `api.ts <RUN_ID> get '/v1/sessions?limit=5'`, then `api.ts <RUN_ID> get '/v1/sessions/<id>?limit=50'` must show `"modelRole": "smol"` and an assistant item whose `model` is the slow role's model. The session file under `~/.omp/agent/sessions/-.cache-omp-mobile-verify-<RUN_ID>-work-project/` records each switch as `model_change`, `thinking_level_change`, then a `custom` entry `omp-mobile-model-role` with `{ "role": … }`.

## Gotchas

- `hideKeyboard` does not reliably close the iOS keyboard in an open transcript; drag the transcript instead (`swipe: start: 50%, 35% end: 50%, 60%`).
- The run's `rpcArgs` `--model` only sets the model a new session starts on; picking a role replaces it with the user's real role model, so role runs cost real `smol`/`slow` turns.
