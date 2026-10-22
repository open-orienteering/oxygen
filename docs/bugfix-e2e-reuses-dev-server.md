# Bugfix: E2E runs could attach to a server they did not start

Found 2026-10-22 by the B10 session (library drawing defects). Fixed in
`playwright.config.ts`, `e2e/helpers/ports.ts`, `e2e/helpers/api-base.ts`.

## What happened

B10's first map-gl golden run failed against *stale library code*. The
run had attached to the Vite dev server on `:5173` — the user's `pnpm dev`
in the main checkout — and so rendered the main checkout's web code, not
the worktree's. It worked around it with `E2E_WEB_PORT=5188`. Nothing in
the run said so: the tests ran, against the wrong code.

## Why

`playwright.config.ts` started three servers per stack (API, Eventor stub,
Vite). Two had `reuseExistingServer: false`; the **web server had
`true`**, with the comment "the default port keeps reusing an
already-running dev server". Together with the defaults:

| | API | Web | Eventor |
|---|---|---|---|
| Config default (before) | 3002 | **5173** | 4300 |
| Dev servers / user's `pnpm dev` | 3002 | **5173** | — |

the config's default stack *was* the dev stack's ports. Whenever the web
port was the default (or set to a port with something on it), the run
attached to whatever Vite answered there.

What the run did *not* do — and this narrows the exposure — is attach
silently in the common case. The API entry has been
`reuseExistingServer: false` since 2026-05-22 (`35439ff`; it was `true` in
the initial commit), before the ports were parameterised and before the
worktree workflow, so a run on the default ports with the
user's API up on 3002 stopped with `http://localhost:3002 is already
used`, and `pnpm test:e2e e2e/foo.spec.ts` never used 5173 at all: the
sharded runner's selective path sets `E2E_API_PORT=4100`,
`E2E_WEB_PORT=4200`, `E2E_EVENTOR_PORT=4300` itself (verified on
2026-10-22 against a live `pnpm dev`, see below). The silent attach needs
the API port moved away from 3002 while the web port stayed on 5173 (or
the user's API being down while their Vite was up), or an orphaned Vite on
the stack's own web port (4200, 420`n`) from a crashed run of any
worktree — the same `true` flag attached to it just the same.

## Fix

* **Own defaults.** `e2e/helpers/ports.ts` holds the default ports:
  4100 / 4200 / 4300 — the sharded runner's bases without a shard suffix.
  `playwright.config.ts` and `e2e/helpers/api-base.ts` both read them
  (`api-base.ts` previously carried its own `3002` fallback). No other
  default overlaps the dev servers (3002 / 5173) or Docker (3001 / 8080).
* **Never reuse.** The Vite entry is now `reuseExistingServer: false` like
  the other two. A busy port stops the run with `... is already used`.
* **Unchanged:** the sharded runner's port scheme (4100+n / 4200+n /
  4300+n, `oxygen_e2e_<n>`), the dev servers' ports, and the
  `E2E_API_PORT` / `E2E_WEB_PORT` / `E2E_EVENTOR_PORT` / `E2E_DB_NAME` /
  `E2E_SHARD` overrides. The selective path in `scripts/e2e-sharded.mjs`
  still passes its ports explicitly (only comments changed).
* **Cost:** a run always cold-starts Vite (a few seconds); the old shortcut
  of running `playwright test` against an already-running dev Vite is gone
  on purpose.

Regression test: `scripts/__tests__/e2e-config.test.mjs`
(`pnpm test:scripts`) loads the config and asserts the default triple, that
no server reuses an existing one (default and shard-style ports), and that
the `E2E_*_PORT` overrides still reach the servers and `baseURL`.

## Verification (2026-10-22, user's `pnpm dev` up on 3002 / 5173)

* `pnpm test:e2e e2e/event.spec.ts` — own stack on 4100/4200/4300, 5/5
  pass, dev servers untouched.
* `pnpm test:e2e:serial e2e/event.spec.ts` — before: `http://localhost:3002
  is already used`; after: runs on 4100/4200/4300, 5/5 pass.
* `E2E_WEB_PORT=5173 pnpm test:e2e e2e/event.spec.ts` — now stops with
  `http://localhost:5173 is already used` instead of attaching.

## Which earlier runs could have been affected

Only a run that attached to a Vite it had not started, and only the web
side: the API under test was always the run's own, on its own database.

* **Could be affected:** a selective or serial run from a worktree while
  `pnpm dev` was up on 5173, *with the API port overridden* away from
  3002 (or the user's API stopped) — it tested the main checkout's web
  code. That is what B10 hit, and what its note warns about; B10's notes
  record the `E2E_WEB_PORT=5188` workaround before the status line with
  its results (22 affected specs, full run 274/275), so those presumably
  post-date it; the notes do not state the ordering. Also, any run — sharded or not — on a
  web port where an orphaned Vite from a crashed earlier run was still
  listening (4200 / 420`n`): it tested whichever checkout started that
  orphan.
* **Not affected:** full sharded runs (`pnpm test:e2e` without a file
  filter) and the merge verifications, which were sharded, are not exposed
  to the dev server on 5173 — their Vite runs on 4200+n; they are exposed
  only to an orphan on their own shard's web port, as above. A plain
  `pnpm test:e2e e2e/foo.spec.ts` with nothing stale on 4200. Server-side
  and database assertions in any run.
* **Could not be reconstructed:** which individual worktree runs set
  `E2E_API_PORT` by hand without `E2E_WEB_PORT`, or met an orphan on 4200 —
  no log records it. The sibling notes name only B10 as having seen it, so
  B10 is the only session known to have had a failing or misleading run;
  any other session whose notes cite a selective E2E result obtained that
  way should re-run the spec with this fix if the claim matters.

## Lesson

"Reuse a server if one is there" is only safe when you know whose server it
is. On a machine where the dev servers, several worktrees and the Docker
stack share ports, you don't, so a test run must start its own and fail
when it cannot.
