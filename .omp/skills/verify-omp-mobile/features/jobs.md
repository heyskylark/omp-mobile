# Scheduled jobs

An agent creates a job with the extension's `schedule_job` tool, which posts to the loopback `POST /internal/jobs` with the extension token from `server.json`. The server keeps jobs in `<OMP_MOBILE_HOME>/jobs.db` and sends each job's `description` to its session on its cron schedule (croner, local time). The app lists jobs at `GET /v1/jobs` on the **Jobs** screen, opened by the `Jobs` clock button on a computer's session list.

## Sub-features

- `jobs-model-create`: asking a session to schedule something makes the agent call `schedule_job` (OMP exposes it as `xd://schedule_job`), and the job appears with that session's id. **Exercised** (API prompt, see below).
- `jobs-run`: at each fire the description arrives in the session as a user message; `lastRunAt` updates. **Exercised.**
- `jobs-recreate`: when the session's JSONL is deleted and its OMP process has closed, the next fire starts a new session in the job's folder and the job's `sessionId` changes to it. **Exercised.**
- `jobs-error`: a run that fails (for example its folder was deleted) shows `ERROR` with the reason; the job keeps firing. **Exercised.**
- `jobs-panel-list`: rows read `<name>, Active|Paused|Error` with a green dot for Active and red otherwise, the schedule, and `Next <time>`. **Exercised** (`jobs-pause.yaml`).
- `jobs-panel-pause` / `jobs-panel-resume`: swipe left, tap `Pause` or `Resume`. **Exercised** (`jobs-pause.yaml`, `jobs-resume-open-delete.yaml`).
- `jobs-panel-open`: tapping a row opens its session thread. **Exercised.**
- `jobs-panel-delete`: swipe left, tap `Delete`; the row disappears and `GET /v1/jobs` no longer lists it. **Exercised.**

## Driving it

Preconditions: app paired to this run's server.

Create a job through a real agent (one model turn, plus one per fire). The run's approval policy asks before `xd://schedule_job` and before each `bash`; approve with `POST /v1/sessions/<id>/interactions/<interactionId>/respond`.

```sh
# as the verify-probe device (token in <SCRATCH>/probe.json)
POST /v1/sessions {"operationId":"…","cwd":"<PROJECT>","prompt":"Please set up a scheduled job named 'Heartbeat' that runs every minute. Each run, append the current time to heartbeat.txt in this folder with one bash command. Just schedule it."}
```

For panel flows without model cost, create jobs directly on the loopback listener:

```sh
curl -X POST http://127.0.0.1:<PORT>/internal/jobs -H "x-omp-mobile-token: <extensionToken from <OMP_MOBILE_HOME>/server.json>" -H 'content-type: application/json' \
	-d '{"name":"Weekly report","description":"Write the weekly report","schedule":"0 9 * * MON","sessionId":"<an existing session id>","cwd":"<PROJECT>"}'
maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/jobs-pause -e MACHINE_NAME=<MACHINE_NAME> -e 'JOB_NAME=Weekly report' .omp/skills/verify-omp-mobile/flows/jobs-pause.yaml
maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/jobs-resume-open-delete -e MACHINE_NAME=<MACHINE_NAME> -e 'JOB_NAME=Weekly report' .omp/skills/verify-omp-mobile/flows/jobs-resume-open-delete.yaml
```

Screenshots `jobs-01-active` … `jobs-06-deleted`. Selectors: `Jobs` (header button), rows `<name>, Active|Paused|Error`, actions `Pause`, `Resume`, `Delete`, thread `Message OMP`, empty state `No jobs`.

- **Second observation:** `api.ts <RUN_ID> get /v1/jobs > <EVIDENCE>/jobs-after-<step>.json` after each flow. The job's `status` must match the row.

## Gotchas

- A job on `* * * * *` keeps prompting its session every minute; pause it once the run is proven.
- `GET /v1/sessions/<id>` can still answer for a deleted session while the server caches its actor. The job runner checks the transcript file through history, not that endpoint.
- A job whose folder is gone fails every minute but never reaches the model.
