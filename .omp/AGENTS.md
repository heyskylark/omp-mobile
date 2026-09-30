# OMP Project Instructions

## Workspace boundaries

- Keep one deliverable in each top-level Git worktree.
- Never have separate top-level sessions edit the same checkout. Before editing,
  check `git status` and file modification times; uncommitted work you did not
  write may belong to another live session. Leave it alone and work in a new
  worktree instead of switching branches, resetting, stashing, or committing in
  that checkout.
- Treat the primary checkout (the repository root on `main`) as read-only
  except for fast-forwarding `main`. Make every change, however small, in the
  deliverable's own worktree at `../omp-mobile-<branch-slug>`, so overlapping
  tasks never share a working tree, index, or `node_modules`.
- Reuse an existing worktree only when it belongs to the same deliverable;
  `git worktree list` shows which branch each one holds. Never edit, reset, or
  remove another deliverable's worktree. Remove your own
  (`git worktree remove ../omp-mobile-<branch-slug>`) only after its pull
  request is merged or closed.
- Concurrent tasks also share machine resources. Give each verification run
  its own ports, simulator, and scratch home (see `verify-omp-mobile`), and do
  not run `bun run e2e` while another task is running it: it binds the fixed
  ports 18787/18788.
- Use OMP subagents for bounded slices within the current deliverable; agree on
  shared interfaces before parallel implementation.

## Required branch, commit, and pull request workflow

- Perform every deliverable on a dedicated feature branch. Never commit to or
  push `main`.
- Name branches `<type>/<short-slug>`, where the type is `feat`, `fix`,
  `refactor`, `docs`, `test`, or `chore`.
- Before editing, inspect the current branch, worktrees (`git worktree list`),
  open pull requests, and active remote branches, then choose the branch point
  deliberately. Fetch the chosen parent immediately before creating the branch
  and branch from its remote-tracking ref, never a potentially stale local
  branch:
  - Independent work starts from `origin/main`:
    `git worktree add -b <branch> ../omp-mobile-<branch-slug> origin/main`.
  - Work that belongs to an in-flight feature starts from that feature's remote
    branch:
    `git worktree add -b <branch> ../omp-mobile-<branch-slug> origin/<parent>`.
    Record the dependency and target the pull request at the parent branch.
  - Run `bun install` in a new worktree before running any `bun run` command.
- Leave the primary `main` checkout on `main`. If you are already in a worktree
  on the deliverable's feature branch, keep using it rather than creating
  another.
- If intended changes were made on `main` by mistake, move them: unpublished
  commits go onto a new branch (`git branch <branch> <commit>`, then
  `git reset --keep origin/main`); uncommitted changes are transferred as a
  patch plus untracked files into a new worktree. Never use a destructive reset
  or a repository-wide stash that could capture someone else's work.
- Before every commit and push, fetch the parent and make sure the feature
  branch contains its latest commits. Rebase an unpublished branch when safe.
  Do not rewrite published or shared history without explicit approval; merge
  the parent into a published branch instead. Resolve conflicts and rerun
  applicable verification before continuing.
- Split changes into logical, single-purpose commits. Stage by file or hunk and
  inspect the staged diff before each commit. Follow the history's style: a
  short imperative subject line describing the outcome, optionally followed by
  a body explaining why.
- After implementation and verification, commit every intended change, push the
  branch with `git push -u origin <branch>`, and create or update its pull
  request with `gh pr create`/`gh pr edit` without waiting for further
  approval. The pull request body states scope, verification evidence, risks,
  and a test plan. Never fabricate results.
- If the pull request has checks, wait for them (`gh pr checks <pr> --watch`).
  Fix failures caused by the branch, push, and wait again. Report verified
  external or unrelated blockers instead of hiding them.
- Never merge a pull request or push directly to `main`.
- Report the worktree path, branch, commit hashes, and pull-request URL.

## Subagent isolation

- Request isolated subagents for independent editing slices.
- Read-only research does not need filesystem isolation.
- Do not isolate tightly coupled slices that must repeatedly edit the same
  symbols.

## Autonomous side quests

- Commit and push feature branches and create or update pull requests without
  waiting for additional approval. This section is standing approval to
  dispatch side quests without asking.
- Treat worthwhile out-of-scope findings (dead code, stale documentation, a
  reproducible bug, a confirmed TODO, or a development-workflow failure) as
  side-quest candidates. Keep them out of the current diff unless the fix is
  trivial and already inside a file you are editing.
- Dispatch a side quest automatically when the finding is verified or
  reproducible, the work is bounded and independent, and no unresolved product
  or scope decision is required. If evidence is incomplete, send a read-only
  scout first and authorize an editing side quest only after it confirms the
  issue.
- Before dispatching, check open and closed pull requests plus active branches
  for the same path or symbol. Do not duplicate work already in flight; report
  the existing item instead.
- Run each side quest as an isolated OMP background agent or standalone OMP
  session with its own worktree and branch. Give it a standalone prompt with
  committed file paths, evidence, acceptance criteria, required verification,
  and any dependency on unmerged work.
- The side-quest agent owns the work end to end: reproduce or verify the issue,
  implement the fix, run focused verification, commit, push its own branch, and
  open a dedicated pull request. It must leave the primary checkout and branch
  untouched, never merge its pull request, and never push to `main`.
- If a side quest depends on unmerged work, give the agent the dependency
  branch and pull-request number and require a stacked pull request, or hold
  the dispatch until the dependency is stable.
- Batch independent side quests concurrently and keep the primary session
  moving on the main deliverable instead of waiting. Report each side quest's
  pull-request URL and verification evidence separately; never merge or copy
  its patch into the primary branch.
- Failures owned by an external service or the agent/tool platform are not
  repository side quests. Report them through that platform instead of opening
  a repository pull request.

## Mandatory verification-failure triage

- The documented commands are `bun run typecheck`, `bun run test`,
  `bun run e2e`, `bun run format:check`, `macos/build.sh`, and
  `scripts/simulator.sh`, run from the repository root.
- Whenever one of them exits nonzero, classify the failure before marking
  verification complete:
  - Fix failures caused by the current deliverable on the current branch.
  - Treat repository-internal failures independent of the current deliverable
    as side quests: missing configuration, broken package scripts,
    incompatible dependencies, or commands that fail from their documented
    working directory.
  - Report failures owned by an external service or the agent/tool platform
    through that platform.
- A narrower command may verify the current deliverable, but it does not waive
  or resolve a failure of the documented command.
- For every confirmed repository-internal independent failure: reproduce it
  from the documented working directory, check pull requests and remote
  branches for existing work, and if none exists, dispatch an isolated
  side-quest agent to fix it, rerun the originally failing command
  successfully, commit, push, and open a dedicated pull request. Report the
  existing work or the side-quest pull-request URL and evidence in the final
  response.
