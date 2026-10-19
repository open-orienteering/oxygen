---
name: implement-sub-slice
description: Implement one row of docs/research/vector-map-pipeline/SLICES.md end to end — plan from the spec, TDD, AGENTS.md §6 verification under the shared lock, spec and decision-log updates, PR into vector-map-pipeline, spec review. Use as /implement-sub-slice <id>, e.g. /implement-sub-slice A8.
---

Implement sub-slice `$ARGUMENTS` of the vector map pipeline. The spec
chapters in `docs/map-*.md` are normative; the research directory is the
record of why. The base and target branch is `vector-map-pipeline`,
never `main`.

## 0. Claim

- Read the row in `docs/research/vector-map-pipeline/SLICES.md`. Stop if
  its status is not `ready`: report what blocks it.
- Confirm this worktree's branch was cut from `vector-map-pipeline`
  (`git merge-base --is-ancestor origin/vector-map-pipeline HEAD`).
- In a fresh worktree run `pnpm install --frozen-lockfile` and
  `pnpm db:generate` first.
- Set the row's status to `in progress: <session name>` and commit that
  one-line change on its own.

## 1. Plan

- Run the `slice-planner` agent with the row id. Read its plan.
- If it returns questions, **stop and ask the user** — all of them in one
  message, each with your recommendation. When the user answers, write
  the answer into the spec section it belongs to before writing code, so
  later sessions inherit it.
- Ask only what changes a schema, an interface, an acceptance rule or a
  recorded decision, or where spec and code genuinely conflict. Smaller
  choices (naming, file placement, an error code, a test fixture, which
  of two equivalent mechanisms) you decide yourself: pick what the spec
  and the surrounding code imply, say so in the plan, and record it in
  the decision-log row. Never ask for confirmation of something the spec
  already states.
- Keep the plan's acceptance criteria; they are what the reviewer checks.

## 2. Implement, test first (AGENTS.md §4)

- For each step: write the failing test, make it pass, commit. Unit tests
  in `packages/*/src/__tests__/`, integration in
  `packages/api/src/__tests__/integration/`, E2E in `e2e/`.
- Follow AGENTS.md §7 for any migration (additive only; nullable columns
  or new tables; `ON DELETE` per the spec; content-addressed rows are
  never updated) and §8 for code conventions (`.js` import extensions in
  `packages/api`, Zod at the boundary, `ctx.db`, no `any`).
- After every code change run `pnpm test`; after it passes, `pnpm build`.

## 3. Verify (AGENTS.md §6) — under the lock

Anything that uses the fixed ports or the shared databases must go
through the wrapper, or a hook blocks it:

```bash
scripts/with-verify-lock.sh pnpm test:integration
scripts/with-verify-lock.sh pnpm test:e2e e2e/<affected>.spec.ts
scripts/with-verify-lock.sh pnpm test:e2e
scripts/with-verify-lock.sh docker compose -f docker-compose.host-db.yml up --build -d
```

Run in this order: `pnpm build`, `pnpm test`, `pnpm lint`, integration
tests (always, for pipeline work), affected E2E specs during iteration,
the full E2E suite once before the PR, the Docker rebuild last. Then
`pnpm outdated -r --long` for the drift report. Never run `pnpm dev` from
a worktree; its ports are shared with the user's checkout.

## 4. Record

- Write or update the spec section named in the row; trim the chapter's
  "Pending in this chapter"; extend its "Tests" table.
- Add a decision-log row to `docs/research/vector-map-pipeline/README.md`
  in the existing shape (date, topic, decision, rationale), naming every
  deviation from the research decision and what forced it.
- Update `docs/features.md` only if something is user-visible.
- Set the `SLICES.md` row to `review`.

## 5. PR and review

- Push the branch; open a PR **against `vector-map-pipeline`** with: the
  row id in the title, the acceptance criteria as a checklist, the
  verification steps run and any skipped (with the reason), the drift
  report.
- Run the `spec-reviewer` agent. Fix `not ready` findings before
  reporting; carry `ready with notes` items into the PR description.
- Report to the user: what landed, deviations recorded, what the
  reviewer noted, what the user must still do (corpus run, staging,
  club instance).
