# Session agents

A session can start as one of the computer's agents: OMP's agent files in `~/.omp/agent/agents/<name>.md`, the same files `task` subagents use. The agent fixes the session's tools, instructions, skills, and (when the file pins them) model and thinking level for the session's lifetime. The **Agents** screen (`Agents` header button on a computer's session list, next to `Jobs`) lists, creates, edits, and deletes them through `GET`/`PUT`/`DELETE /v1/agents`.

## Sub-features

- `agents-list`: rows read `<name>, <description>, <details>`; details are `Default tools` or `<n> tools`, the model, and `Thinking <level>`. Agents declaring `output:` carry a `Subagent only` tag. **Exercised** (`agents-manage.yaml`).
- `agents-create`: `New agent` (header `+`) → name (checked against `AGENT_NAME_PATTERN` and existing names), description, tool chips from the computer's OMP, model text with `@smol`/`@default`/`@slow` chips, thinking level chips, skills, instructions → `Save`. **Exercised.**
- `agents-edit`: tapping a row opens the same editor with the name fixed. **Exercised** (reopened; fields shown).
- `agents-delete`: `Delete agent` → `Delete <name>?` alert → `Delete`; the row disappears. **Exercised.**
- `new-session-agent`: New session's `Agent` section lists `Default` and every agent without `output:`; an agent with a `model` shows `<name> always uses the model <model>, so the model choice below doesn't apply.` and disables the composer's model button. **Exercised** (`new-session-agent.yaml`).
- `agent-badge`: sessions started as an agent show an `Agent <name>` badge in the session header subtitle and on their session-list row; a job whose session has an agent shows the badge on its Jobs row. **Exercised** (session header and list; jobs row via the loopback job API).

## Driving it

Preconditions: app paired to this run's server, and the server started with `HOME=<SCRATCH>/userhome` so agent files land in scratch instead of `~/.omp/agent/agents`. `<SCRATCH>/userhome/.omp/agent` holds symlinks to the real `agent.db`, `models.db`, `config.yml` (and the other files except `agents`, `sessions`, `terminal-sessions`, `history.db*`) so OMP still signs in; `agents/` and `sessions/` are real scratch directories. Seed agents there, for example `reader.md` (`tools: read, grep, glob`), `quick.md` (`model: "@smol"`, `thinking-level: low`), and `summarizer.md` (with an `output:` schema).

With a scratch `HOME` the history is empty, so New session lists no recent projects; `new-session-agent.yaml` picks the scratch `project` through `Browse`.

```sh
maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/agents-manage -e MACHINE_NAME=<MACHINE_NAME> -e EXISTING=reader -e NEW_AGENT=notes .omp/skills/verify-omp-mobile/flows/agents-manage.yaml
maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/new-session-agent -e MACHINE_NAME=<MACHINE_NAME> -e PINNED=quick -e AGENT=reader -e 'PROMPT=Reply with the single word ready.' .omp/skills/verify-omp-mobile/flows/new-session-agent.yaml
```

Screenshots `agents-01-list` … `agents-07-deleted` and `agent-01-picker-pinned-model` … `agent-04-session-list`.

- **Second observation:** `api.ts <RUN_ID> get /v1/agents > <EVIDENCE>/agents-after.json` (the created agent is gone after the delete); `api.ts <RUN_ID> get '/v1/sessions?limit=5' > <EVIDENCE>/sessions-agent.json` lists the new session with `"agent": "<AGENT>"`.
- **Jobs badge:** create a job on the agent session through the loopback API (`jobs.md`), then open `Jobs`; the row shows the badge.

## Gotchas

- Without `HOME=<SCRATCH>/userhome` the server reads and writes the user's own agent files.
- The agent snapshot is taken when the session starts; editing the agent later only affects new sessions.
- `Subagent only` agents never appear in New session; `GET /v1/agents` still lists them with `structured: true`.
