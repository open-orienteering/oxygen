# Claude Code Instructions for Oxygen

Read and follow all rules in [`AGENTS.md`](../AGENTS.md) at the project root. That file is the single source of truth for development rules, test requirements, verification steps, and coding conventions.

## Claude-Specific Behavior

These are automatic behaviors that Claude Code should perform without being asked:

- **After any code change**: Run `pnpm test` immediately.
- **After tests pass**: Run `pnpm build` to verify zero TypeScript errors.
- **After completing a feature or fix**: Rebuild Docker automatically: `scripts/with-verify-lock.sh docker compose -f docker-compose.host-db.yml up --build -d`
- **Before pushing code**: Run the full E2E suite: `scripts/with-verify-lock.sh pnpm test:e2e`. Fix failures before pushing.

## Shared verification resources

Integration tests, E2E (`pnpm test:e2e*`, `playwright test`) and the Docker rebuild use fixed ports (4100–4303, 8080, 3001) and shared databases (`oxygen_test`, `oxygen_e2e*` on :5433). Several sessions run at once in separate worktrees, so these steps are serialised through `scripts/with-verify-lock.sh <command>`; a PreToolUse hook blocks bare invocations. The wrapper waits for the lock, so a blocked session simply queues.

- Never run `pnpm dev` from a worktree — ports 3002/5173 belong to the user's checkout.
- Never touch the dev database on :5432 from a worktree.
- A fresh worktree needs `pnpm install --frozen-lockfile` and `pnpm db:generate` before anything else.
- **AGENTS.md §6 step 5 (Docker rebuild) is split for worktrees.** `docker compose … up --build` must not run from a worktree: the host-db compose file points at the dev database on :5432 and the ports 8080/3001 are held by the user's stack. In a worktree, prove the images instead: `scripts/with-verify-lock.sh docker build --network host --target api .` and the same with `--target web`, and say in the PR that the stack bring-up is left to the main checkout. After the PR merges, the coordinator does the bring-up from the main checkout: `pnpm db:migrate` first (the image only runs node; `compose up` applies nothing), then the stack. With Compose v5.6 on this machine `docker compose … up --build` fails (`additional privileges requested: pass "--allow=network.host"`, from the compose file's build-time `network: host`, and there is no compose flag for it), so build the images under their compose names and start without a build:
  ```bash
  scripts/with-verify-lock.sh bash -c 'docker build --network host --target api -t oxygen-api . && docker build --network host --target web -t oxygen-web . && docker compose -f docker-compose.host-db.yml up -d --no-build'
  ```

## Vector map pipeline (branch `vector-map-pipeline`)

The map/course/print redesign runs on the long-lived branch `vector-map-pipeline`. Sub-slices are worktrees cut from it and PRs back into it; spike branches may be cut from it and merge back the same way. `main` is not a target until the user says so.

- **Specs are normative**: `docs/map-*.md` (and later `course-*.md`) state what is implemented and, in each chapter's "Pending in this chapter" section, what is not. The research directory `docs/research/vector-map-pipeline/` is the frozen record of why; its README carries the decision log.
- **Work queue**: `docs/research/vector-map-pipeline/SLICES.md`. One session per row; rows with overlapping areas are never in progress together. Use `/implement-sub-slice <id>`.
- **When code and spec disagree, or the spec is silent**: stop and ask the user. Record the answer in the spec section first, then implement. Every deviation from a research decision gets a decision-log row. Never deviate silently.
- **Done** means: spec section written, "Pending" trimmed, tests per AGENTS.md §4, decision-log row, `SLICES.md` row updated, PR open against `vector-map-pipeline`, `spec-reviewer` run.

## Documentation Requirement

**Every feature or significant change must include documentation updates** (AGENTS.md §10). This includes:
- Update `docs/features.md` for user-facing features
- Update the relevant technical doc in `docs/` (architecture, registration-and-readout, etc.)
- For bug fixes: create `docs/bugfix-<name>.md` explaining what happened and how it was fixed
- Do not consider a task complete until documentation is updated

## Known Pre-Existing Issues

- Build errors in `clubRouter.ts`, `eventor.ts`, and `index.ts` related to `oxygen_club_logo` are known Prisma schema issues — they do not block the build and are not caused by your changes.
