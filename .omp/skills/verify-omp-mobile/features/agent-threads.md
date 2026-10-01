# Agent threads

When a session starts OMP `task` agents, the user sees how many run, lists them, opens any agent's read-only transcript, nested agents included, and returns to the session. Agent work never appears in the session's transcript.

## Sub-features

- `agents-indicator`: the session header subtitle adds `· N agents running`, and the header shows an agents button labeled `Agents, N running` (`Agents` once none run; hidden when the session has no agents). **Exercised** (`new-session-agents.yaml`, `agent-threads.yaml`).
- `agents-task-card`: the `task` call shows a spinner while any agent it started runs, plus one chip per agent (`<name>, <status>`), even though OMP reports the call itself as finished. **Exercised.**
- `agents-menu`: the agents button opens a list of the session's agents as a tree, nested agents indented, each with a status icon and its current activity, description, or status. **Exercised.**
- `agents-thread`: a menu row or a chip pushes the agent's read-only transcript (no composer), titled with the agent's name and its status; nested agents open from that thread's own chips or agents button; the header back button returns. **Exercised.**
- `agents-steps`: an open agent thread updates about once a second while the agent runs, including tool cards that flip from running to done. **Exercised** (Gamma's `bash` card between `agents-03-nested-from-menu` and `agents-05-nested-from-chip` of a running session).
- `agents-finished-row`: OMP's delivery of a finished agent's result shows as `Finished` plus the agent's chip instead of the full result text. **Exercised.**
- `agents-no-phantoms`: an agent's own OMP session never appears as a `New session` row in the session list. **Exercised** (server observation below).

## How to get to it (user POV)

- Open a session whose agent called `task` → agents button at the top right, or the chips on the `task` card.
- In an agent's thread → its own chips or agents button for agents it started; back returns one level.

## Driving it with Maestro

Preconditions: app paired to this run's server.

- Start a session whose agents run long enough to drive the UI (`SLEEP=90`), then walk the threads:

  ```sh
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/agents-new -e MACHINE_NAME=<MACHINE_NAME> -e TOKEN=<unique word> -e SLEEP=90 .omp/skills/verify-omp-mobile/flows/new-session-agents.yaml
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/agent-threads -e MACHINE_NAME=<MACHINE_NAME> -e 'SESSION_TITLE=<unique word>.*' -e AGENT=Alpha -e NESTED=Gamma .omp/skills/verify-omp-mobile/flows/agent-threads.yaml
  .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> get '/v1/sessions?limit=10' > <EVIDENCE>/agents-api-sessions.json
  .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> get '/v1/sessions/<id>?limit=40' > <EVIDENCE>/agents-api-snapshot.json
  ```

  Pass: `agents-new-02-running` shows the agents button with a count and a spinning `task` card with `Alpha` and `Beta` chips; `agents-02-menu` lists Alpha with Gamma indented under it, and Beta; `agents-03-nested-from-menu` and `agents-05-nested-from-chip` show Gamma's transcript without a composer; `agents-04-agent-from-chip` shows Alpha's transcript with a `Gamma` chip; `agents-06-back-to-main` shows the session with its composer. The snapshot's `agents` lists `Alpha`, `Beta`, and `Alpha.Gamma` with `parentId: "Alpha"`, its `task` item has `agentIds: ["Alpha","Beta"]`, and the session list has no `New session` rows.
- Run `agent-threads.yaml` again after the agents finish (about two minutes later): the chips and menu show `Done`, the button reads `Agents`, and `Finished` rows follow the `task` card.

## Gotchas

- A menu row and a chip of the same agent share their accessibility text (`Alpha, Running`), and the menu overlays the transcript. The flow opens Gamma from the main thread's menu (the main thread has no Gamma chip) and Alpha from its chip with the menu closed.
- `Finished` rows also carry agent chips and push the `task` card up; the flow scrolls up to the agent's chip before tapping it.
- Agents run on OMP's `task` model role, not the run's `rpcArgs` model, so they cost real model turns of that role.
- OMP holds `session_settled` while background agents run, so the session stays `Running` until they finish; the server keeps its OMP process up as long as agents run.
