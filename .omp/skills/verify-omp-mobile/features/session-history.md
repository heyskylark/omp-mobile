# Session history

The user browses every OMP session on a paired computer, newest first, and opens any transcript; long transcripts load older pages as the user scrolls up.

## Sub-features

- `history-list`: computer row → session list grouped `TODAY` / `YESTERDAY` / `EARLIER` (source strings `Today`/`Yesterday`/`Earlier`, rendered uppercase), each row with title, project, age, preview, and liveness (`Needs you`, `In terminal`, `Running`, `Conflict`, `Unavailable`). **Exercised.**
- `history-open`: tap a row → transcript with the composer `Message OMP`. **Exercised** (`open-session.yaml`).
- `history-paging`: scroll up in a long transcript → `Loading earlier messages…` then older items. Recipe-only.
- `history-expand`: tap `Thought ▾` (→ `Thought ▴`) or a tool card (→ `INPUT` / `OUTPUT` / `Output · truncated`). Tool-card expansion **exercised** in `new-session-approve.yaml`; thought expansion recipe-only.
- `history-empty`: a computer with no sessions shows `No sessions yet`. Not reachable while the server reads the user's real history.

## How to get to it (user POV)

- Computers screen → tap the computer row (`<name>`, `Online`).
- Session list header: machine name, `+` (new session), ellipsis (computer settings).
- Tap a session → transcript titled with the session title and project subtitle; newest content at the bottom.

## Driving it with Maestro

Preconditions: app paired to this run's server.

- Pick a session from the server's view (these are the user's real sessions; avoid a session that is actively running unless that is the point):

  ```sh
  .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> get '/v1/sessions?limit=5' > <EVIDENCE>/history-api-sessions.json
  ```

- Open it (escape regex metacharacters in the title):

  ```sh
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/history -e MACHINE_NAME=<MACHINE_NAME> -e 'SESSION_TITLE=<title>' .omp/skills/verify-omp-mobile/flows/open-session.yaml
  maestro --device <SIM_UDID> hierarchy | .omp/skills/verify-omp-mobile/bin/texts.ts > <EVIDENCE>/history-transcript-texts.txt
  .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> get '/v1/sessions/<id>?limit=20' > <EVIDENCE>/history-api-snapshot.json
  ```

  Pass: `history-01-session-list.png` shows the row, `history-02-transcript.png` shows the transcript, and tool-card titles in the hierarchy dump (`wrench.and.screwdriver, <title>, <tool>, selected`) appear in the snapshot's newest `items`.
- **Paging (recipe):** in the transcript, `scrollUntilVisible` with `direction: UP` toward an item title present only in `GET /v1/sessions/<id>/items?before=<olderCursor>`; capture `Loading earlier messages…` if it shows.

## Gotchas

- Rows expose one accessibility string: `<title>, <project>, · <age>, <preview>`; select with `"<title>,.*"`. Titles repeat (`Untitled`, e2e prompts), so prefer a unique one.
- The list is the invoking user's real `~/.omp/agent/sessions`, including sessions other agents are writing right now; their transcripts change while you look. Compare against a snapshot fetched at the same time.
- A transcript is an inverted list: newest at the bottom, older pages above.
- Header icons have no custom labels; Maestro sees their SF Symbol names `add` and `More`.
