# Session history

The user browses every OMP session on a paired computer, newest first, and opens any transcript; long transcripts load older pages as the user scrolls up, and thoughts and tool calls expand in place.

## Sub-features

- `history-list`: computer row → session list grouped `TODAY` / `YESTERDAY` / `EARLIER` (source `Today`/`Yesterday`/`Earlier`, styled uppercase), each row with title, project, age, preview, and liveness (`Needs you`, `In terminal`, `Running`, `Conflict`, `Unavailable`). The app asks for 30 sessions per page. **Exercised.**
- `history-search`: `Search sessions` field (debounced fuzzy title search on the Mac) and a horizontal project chip row (`All` + recent projects) above the list. A query lists matches as one flat, relevance-ordered section; a chip narrows to that project's cwd; no results show `No matching sessions` (distinct from `No sessions yet`). `GET /v1/sessions?limit=30&project=<cwd>&q=<query>`; a cursor reused with another filter returns 400 `invalid_cursor`. **Exercised** (`session-search.yaml`).
- `history-open`: tap a row → transcript titled with the session title and project, composer `Message OMP`. **Exercised** (`open-session.yaml`).
- `history-paging`: scrolling up in a long transcript loads 40 older items (`GET /v1/sessions/<id>/items?before=<olderCursor>&limit=40`); `Loading earlier messages…` shows while it loads. **Exercised** (`transcript-expand-page.yaml`).
- `history-expand-thought`: `Thought ▾` → `Thought ▴` plus the thinking text (or `Reasoning was redacted.`). **Exercised** (`transcript-expand-page.yaml`).
- `history-expand-tool`: tapping a tool card shows `INPUT` / `OUTPUT` (source `Input` / `Output` / `Output · truncated`, styled uppercase). **Exercised** (`new-session-approve.yaml`).
- `history-expand-anchor`: expanding a thought or tool card keeps its header at the same height on screen and opens the content below it; collapsing keeps the header still, or, when the header has scrolled off the top, brings the collapsed card back to the top of the screen. Agent threads use the same list. **Exercised** in the session transcript (`transcript-anchor.yaml`); agent threads recipe-only.
- `history-jump-bottom`: once the transcript is scrolled more than 160 pt away from the newest message, a round `Scroll to bottom` button (down arrow) floats above the composer; tapping it scrolls to the newest message and the button disappears. **Exercised** (`transcript-anchor.yaml`).
- `history-empty`: a computer whose history is empty shows `No sessions yet`. **Exercised** (second run's server with `HOME=<SCRATCH>`).

## How to get to it (user POV)

- Computers screen → tap the computer row (`<name>`, `Online`).
- Session list header: machine name, `+` (new session), ellipsis (computer settings).
- Tap a session → transcript; newest content at the bottom, older pages above.

## Driving it with Maestro

Preconditions: app paired to this run's server.

- Pick a session from the server's view. These are the user's real sessions; choose one that is not running, sits within the first screen of rows, has an `olderCursor`, and has at least one non-redacted thinking block:

  ```sh
  .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> get '/v1/sessions?limit=8' > <EVIDENCE>/history-api-sessions.json
  .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> get '/v1/sessions/<id>?limit=40' > <EVIDENCE>/history-api-snapshot.json
  .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> get '/v1/sessions/<id>/items?before=<url-encoded olderCursor>&limit=40' > <EVIDENCE>/history-api-older.json
  ```

  From the older page, pick a tool title that is unique across both pages as `<older title>`.
- Open, expand, and page:

  ```sh
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/history -e MACHINE_NAME=<MACHINE_NAME> -e 'SESSION_TITLE=<escaped title>' .omp/skills/verify-omp-mobile/flows/open-session.yaml
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/transcript -e 'OLDER_TEXT=.*<escaped older title>.*' .omp/skills/verify-omp-mobile/flows/transcript-expand-page.yaml
  ```

  Pass: `history-02-transcript` shows the transcript, `transcript-01-thought-expanded` shows `Thought ▴` with text matching the snapshot's newest thinking block, and `transcript-02-older-page` shows `<older title>`, which exists only in the older page.
- **Anchored expansion and jump button:** from the same snapshot pick a finished tool card whose output is taller than the screen (about 2,000+ characters) as `<tool title>`, reopen the session, and run:

  ```sh
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/history-anchor -e MACHINE_NAME=<MACHINE_NAME> -e 'SESSION_TITLE=<escaped title>' .omp/skills/verify-omp-mobile/flows/open-session.yaml
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/anchor -e 'TOOL_TITLE=<escaped tool title>' .omp/skills/verify-omp-mobile/flows/transcript-anchor.yaml
  ```

  Pass: the card header sits at the same height in `anchor-01-collapsed` and `anchor-02-expanded`, with `INPUT`/`OUTPUT` below it; `anchor-03-header-off-screen` shows only output; `anchor-04-collapsed-in-view` shows the collapsed card at the top of the transcript; `anchor-01` through `anchor-04` show the `Scroll to bottom` button above the composer, and `anchor-05-newest` shows the newest message without it.
- **Search and project filter:** project chips come from `GET /v1/projects/recent`, which only lists projects inside the server's `roots`; `prepare-run.sh` confines roots to the run's `WORK`, so for real history set the run's `config.json` `roots` to `["$HOME"]` and restart the server before this recipe (only read-only GETs follow). Pick values from the server's view and save it:

  ```sh
  .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> get '/v1/projects/recent' > <EVIDENCE>/search-api-projects.json
  .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> get '/v1/sessions?limit=30&q=<typo query>' > <EVIDENCE>/search-api-query.json
  .omp/skills/verify-omp-mobile/bin/api.ts <RUN_ID> get '/v1/sessions?limit=30&project=<url-encoded cwd>' > <EVIDENCE>/search-api-project.json
  maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/search -e MACHINE_NAME=<MACHINE_NAME> -e 'QUERY=<typo query>' -e 'QUERY_TITLE=<escaped matching title>' -e 'OTHER_TITLE=<escaped first-screen title the query and chip both hide>' -e 'PROJECT_NAME=<chip label visible without scrolling the chip row>' -e 'PROJECT_TITLE=<escaped title in that project>' -e NO_MATCH=zzqxv .omp/skills/verify-omp-mobile/flows/session-search.yaml
  ```

  Pass: `search-01-list` shows the field and chips over the dated list, `search-02-query` only the API's matches for the typo, `search-03-project` only that project's sessions, `search-04-no-match` `No matching sessions`. For the cursor binding, take `nextCursor` from a small filtered page (`limit=2&project=…`) and reuse it with another `project` or `q`: `api.ts` exits 1 printing `HTTP 400: {"code":"invalid_cursor",…}`.
- **Empty history:** prepare a second run (`prepare-run.sh <RUN_ID>-empty <other port>`) and start its server supervised with `HOME=<its SCRATCH> OMP_MOBILE_HOME=<its OMP_MOBILE_HOME> bun server/src/main.ts`. Pair it with `pair-deeplink.yaml`; its session list shows `No sessions yet`, and `api.ts <RUN_ID>-empty get '/v1/sessions?limit=5'` returns no items. This replaces the first run's computer on the phone (SKILL.md Scope).

## Gotchas

- Rows expose one accessibility string: `<title>, <project>, · <age>, <preview>`; select with `"<title>,.*"`. Titles repeat (`Untitled`, e2e prompts), so prefer a unique one.
- The list is the invoking user's real `~/.omp/agent/sessions`, including sessions other agents are writing right now; their transcripts change while you look. Compare against a snapshot fetched at the same time.
- Expanding a thought or tool card keeps its header where it was tapped and opens the content below it. Collapsing a card whose header has scrolled off the top brings the collapsed card back to the top of the screen. Maestro counts off-screen elements as visible, so prove these positions from screenshots.
- The expanded thought element reads `brain, Thought ▴, <text>`, so match `(?s).*Thought ▴, .+`, not `.*Thought ▴`.
- A long final reply can push every thought above the first screen; the flow scrolls up to the newest `Thought ▾` first.
- On `main` at `3a90835`, the expanded thought renders inside a `rounded-full` pill that becomes a large ellipse across the text (fix in PR #9). Do not treat the ellipse as harness noise.
