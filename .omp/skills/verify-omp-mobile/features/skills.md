# Skill completion in the composer

Typing a `/skill:` command in the message field lists the skills OMP offers in the session's project (`GET /v1/skills?cwd=<project>`, answered by a short-lived `omp --mode rpc --no-session` child and cached per project for 30 s). Tapping one completes `/skill:<name> `; OMP expands the command when the prompt arrives, and the transcript shows the typed command instead of the skill body.

## Sub-features

- `skill-list`: `/`, a prefix of `/skill:`, or `/skill:` alone at the start of the field or after whitespace opens `Skill suggestions` with every skill: user-level, project `.omp/skills`, and plugin skills. **Exercised** (New session).
- `skill-fuzzy`: text after `/skill:` filters by name prefix, then name subsequence (`scrrev` → `scratch-review`), then description words (3+ characters). **Exercised** (name and description).
- `skill-complete`: tapping `Skill <name>` replaces the token with `/skill:<name> ` and moves the caret after the space; the menu closes. **Exercised** at the start of the field and mid-prompt.
- `skill-send`: New session and follow-up prompts with a `/skill:` command run the skill; the transcript's user bubble shows the typed command. **Exercised** (New session).
- `skill-probe-silent`: listing skills leaves no session behind even with the OMP Mobile extension installed globally. **Exercised** (`api.ts … get '/v1/sessions?project=…'` after a skills request).

## Driving it with Maestro

Preconditions: app paired to this run's server; a project skill in the scratch project, for example `<PROJECT>/.omp/skills/scratch-review/SKILL.md` with frontmatter `name: scratch-review` and a body telling the model to reply with one word; a user-level skill whose description contains `USER_QUERY`. Costs one small model turn.

```sh
maestro --device <SIM_UDID> test --test-output-dir <EVIDENCE>/maestro/skill-completion -e MACHINE_NAME=<MACHINE_NAME> -e PROJECT_SKILL=scratch-review -e PROJECT_QUERY=scrrev -e USER_SKILL=<user skill> -e USER_QUERY=<word from its description> .omp/skills/verify-omp-mobile/flows/skill-completion.yaml
```

Screenshots `skill-01-slash-lists-all` … `skill-06-mid-prompt-completed`. Selectors: `Skill suggestions` (menu), `Skill <name>` (rows).

- **Second observation:** `api.ts <RUN_ID> get '/v1/skills?cwd=<PROJECT>'` lists `PROJECT_SKILL` and `USER_SKILL`; `api.ts <RUN_ID> get '/v1/sessions/<id>?limit=50'` shows a `user` item whose text is `/skill:<PROJECT_SKILL> now` followed by the skill's reply.

## Gotchas

- `USER_QUERY` must not be a subsequence of `PROJECT_SKILL`'s name, or the filtered screenshot shows both.
- OMP drops images attached to a `/skill:` prompt.
