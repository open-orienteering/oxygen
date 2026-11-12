# E2E Sharding — How Full Suite Runs Got Fast

The Playwright suite is intentionally serial: one worker, one Chromium,
one shared database. Almost every spec mutates the shared `itest` seed
event, several call `reseed()` (a global wipe of all three seed events),
and many assert exact row counts. Turning on Playwright worker
parallelism would race those mutations and produce flaky failures.

Instead, full runs are parallelized at the **process level** by
`scripts/e2e-sharded.mjs`: N fully isolated stacks run in parallel, and
each one executes a subset of the spec files with exactly the same serial
semantics the suite has always had.

```
pnpm test:e2e
   │
   └── scripts/e2e-sharded.mjs  (N = min(4, cores/2) by default, override with E2E_SHARDS)
         ├── shard 1: playwright test <files>  → vite :4201 → api :4101 → db oxygen_e2e_1 (+ eventor stub :4301)
         ├── shard 2: playwright test <files>  → vite :4202 → api :4102 → db oxygen_e2e_2 (+ eventor stub :4302)
         ├── shard 3: playwright test <files>  → vite :4203 → api :4103 → db oxygen_e2e_3 (+ eventor stub :4303)
         └── shard 4: playwright test <files>  → vite :4204 → api :4104 → db oxygen_e2e_4 (+ eventor stub :4304)
```

All shard databases live in the existing `postgres-oxygen-test` container
on `:5433` (`pnpm test:db:up`). Each shard's `global-setup` creates its
database if missing, applies Prisma migrations, and seeds the three
reference events — nothing to provision manually.

## Commands

| Command | What happens |
|---------|--------------|
| `pnpm test:e2e` | Full suite, sharded across `min(4, floor(cores/2))` stacks — 4 on a 16-core dev box (~3-5 min), 2 on a 4 vCPU GitHub runner |
| `pnpm test:e2e e2e/kiosk.spec.ts` | Selective run — single plain Playwright process on its own isolated stack (API :4100, web :4200, eventor stub :4300, db `oxygen_e2e`), no sharding. Works while `pnpm dev` is running, and from any worktree: it starts all three servers itself, so it always tests the checkout it is run from |
| `E2E_DB_PREFIX=oxygen_e5 pnpm test:e2e` | The same runs on databases named `oxygen_e5` / `oxygen_e5_<i>` instead of the default prefix's. For a branch whose migration drops columns: every worktree migrates and reuses the shared databases, so a destructive migration applied there breaks the other worktrees' runs. Create the copies first (`CREATE DATABASE oxygen_e5_1 TEMPLATE <the shard database>`, under the verify lock); row E5 was verified this way |
| `E2E_SHARDS=2 pnpm test:e2e` | Fewer shards (lower peak CPU/RAM) |
| `pnpm test:e2e:serial` | Escape hatch: plain `playwright test` — the same 4100/4200/4300 stack as a selective run |

| `E2E_SHARD_TOTAL=6 E2E_SHARD_INDEX=3 pnpm test:e2e` | Only shard 3 of the same split into 6, on stack 3 (`:4103`/`:4203`/`:4303`, db `oxygen_e2e_3`). What each CI matrix job runs; replays one CI shard locally |
| `pnpm test:e2e --plan` | Prints the split (honours `E2E_SHARDS`, `E2E_SHARD_TOTAL`) and exits; starts nothing |

Any argument that doesn't start with `-` is treated as a file filter and
triggers the unsharded selective path, so `-g "name"` filters also run
unsharded.

## CI

GitHub's `ubuntu-latest` runner has 4 vCPU, room for two stacks, and
standard runners cost nothing on a public repository. So CI does not run
the shards side by side on one runner: the E2E job in
`.github/workflows/ci.yml` is a matrix, `e2e-shard`, of one runner per
shard. Each job sets `E2E_SHARD_TOTAL` (the matrix size,
`strategy.job-total`) and `E2E_SHARD_INDEX` (its `matrix.shard`) and runs
`pnpm test:e2e`: every job computes the same LPT split
(`partition` in `scripts/e2e-weights.mjs`, a pure function of the spec
files and the weights) and runs its own entry on one stack. A shard with
no files passes; the runner never hands Playwright an empty file list,
which would run the whole suite.

- **The check.** A gate job `e2e` keeps the check name the merge flow
  reads, **E2E tests**. It needs the matrix, runs even when a shard failed
  (`!cancelled()`) and passes only when every shard did. Shards do not
  cancel each other (`fail-fast: false`), so one run reports every
  failure and every flake.
- **The count.** The shard count is the length of the matrix's `shard`
  list, `1..N` with no gaps (`scripts/__tests__/e2e-shards.test.mjs`
  checks it). Six today: about 230 s of tests per shard. Free runners
  allow 20 concurrent jobs per account and several PRs often run at once,
  so more shards trade a minute per PR for queueing when PRs pile up; the
  per-job setup (~45 s) and server start (~20 s) do not shrink with them.
- **No `needs: unit`.** The shards start at once, beside lint, build and
  unit tests, instead of after them.
- **Per job.** Postgres (`docker-compose.test.yml`) starts before the
  browser install, so its image pull overlaps it, and is waited for
  healthy just before the tests. The Chromium download is cached
  (`~/.cache/ms-playwright`, keyed on the Playwright version); on a hit
  only its OS libraries are installed (`playwright install-deps
  chromium`). A failing shard uploads its own artifact,
  `playwright-<run>-<attempt>-shard-<n>` (`playwright-report/shard-<n>`,
  `test-results/shard-<n>`). Each shard also writes its time and weight to
  the job's summary page.
- **Docs-only changes** (`docs/**`, `**/*.md`) run no CI at all
  (`paths-ignore` on `pull_request` and `push`): such a PR shows no checks.

To rebalance after a CI run, read each shard's time from the job summaries
and the per-test times from its log (the `list` reporter), and adjust
`WEIGHTS`; `pnpm test:e2e --plan` with `E2E_SHARDS=6` shows the split the
matrix will use.

## How the pieces fit

### Env-var plumbing

`playwright.config.ts` reads five variables (all optional). The port
defaults live in `e2e/helpers/ports.ts` — the sharded runner's 4100 / 4200
/ 4300 bases without a shard suffix, so a run that sets nothing is a
selective stack of its own:

| Variable | Default | Used for |
|----------|---------|----------|
| `E2E_API_PORT` | `4100` | API webServer port + `PORT`/`DATABASE_URL` env |
| `E2E_WEB_PORT` | `4200` | Vite webServer port + Playwright `baseURL` |
| `E2E_EVENTOR_PORT` | `4300` | Eventor stub port + the API's `EVENTOR_API_BASE_URL` |
| `E2E_DB_NAME` | `oxygen_e2e` | Database on `:5433` (global-setup + reseed too) |
| `E2E_SHARD` | unset | Artifact dirs: `test-results/shard-<n>`, `playwright-report/shard-<n>` |

The Vite dev server accepts `WEB_PORT` (deliberately *not* `PORT`, which
`pnpm dev` uses for the API) and `API_PROXY_PORT` for the `/trpc` + `/api`
proxy target — both passed by the Playwright webServer config.

Specs never hardcode the API origin; they import `API_BASE` from
`e2e/helpers/api-base.ts`, which derives it from `E2E_API_PORT`.

### Projects

Every event reads the vector pipeline since E3 (`docs/map-pipeline-switch.md`,
history note), so there is one desktop run: project `mobile` runs
`MOBILE_SPECS` (`field-mode.spec.ts` and `course-editor-phone.spec.ts`,
the course editor's phone subset) on a Pixel 7 profile, and project
`chromium` runs every other spec. The per-pipeline projects `map-legacy` /
`map-vector` of slices B–D are gone. Every file runs in exactly one
project today. Until the course editor's spec was split for the CI shards
(below), `course-editor.spec.ts` ran under both, the desktop describes
skipping on the phone and the touch describe on the desktop; the split
moved the phone's describes into their own file.

### File partitioning

The runner assigns spec files to shards with an LPT (longest processing
time first) heuristic over a static weight table in
`scripts/e2e-weights.mjs` (`WEIGHTS`, `weightOf`, `partition`). One unit
is one second of a CI shard: the file's summed test durations on one
`ubuntu-latest` runner with one stack, as the CI matrix runs it. A file
missing from the table weighs `DEFAULT_WEIGHT` (10). A file run by one
project has a number (or `{ mobile: n }` for the phone's files), a file run
by several would have one per project and weigh their sum: a shard runs a
file once per project that matches it. `scripts/__tests__/e2e-config.test.mjs`
(`pnpm test:scripts`) loads the config's projects and fails when an
object entry does not name exactly the projects that run its file, or when
a weight names a spec that no longer exists.

LPT can only balance what it is given: a shard is never shorter than its
heaviest file. `course-editor.spec.ts` once held all of the editor's
describes, ~515 s of a ~1,290 s suite on a CI runner, and its shard ran
533 s while the others ran 114–269 s. It is now seven files of 23–132 s
along its describes (`docs/course-editor.md` "Tests"), sharing
`e2e/helpers/course-editor-spec.ts`; each file reseeds once in
`beforeAll`, as the one file did. Keep any new file under about half a
shard's share; split it along its describes when it grows past that.

### Single-process seeding

`e2e/global-setup.ts` and `e2e/helpers/reseed.ts` run all three seed
builders (`e2e/seed-builder/*.ts`) in **one** spawned tsx process via
`e2e/seed-builder/seed-all.ts`. Previously each builder was its own
`pnpm exec tsx` child process (~4-6s of startup overhead per `reseed()`
call, of which there are 7 across the suite). Fully in-process seeding
is not possible: the generated Prisma client lives in the ESM
`packages/api` package, which Playwright's CJS test transform cannot
load. The builders remain runnable standalone:

```bash
DATABASE_URL="postgresql://oxygen:oxygen@localhost:5433/oxygen_e2e?schema=oxygen" \
  pnpm exec tsx e2e/seed-builder/build-itest.ts
```

### Eventor stub

Each stack runs a third webServer, `e2e/eventor-stub.mjs`, and the API
process gets `EVENTOR_API_BASE_URL=http://127.0.0.1:<port>/` so every
Eventor call stays inside the stack. See
[`docs/e2e-eventor-stub.md`](e2e-eventor-stub.md) for what it serves and
why the suite can no longer talk to the real Eventor.

### Kiosk watchdog test hook

The kiosk registration-waiting watchdog (production: 15s) can be
shortened per-test via
`localStorage.setItem("oxygenKioskWatchdogMs", "4000")` in an init
script. `registration-dialog.spec.ts` uses this so the "heartbeat keeps
registration watchdog alive" test waits 6s instead of 18s — the 2s admin
heartbeat it verifies is unchanged.

## Ports

| Stack | API | Web | Eventor stub | Database |
|-------|-----|-----|--------------|----------|
| Selective run / `test:e2e:serial` (no suffix) | 4100 | 4200 | 4300 | `oxygen_e2e` |
| Shard `n` | 410`n` | 420`n` | 430`n` | `oxygen_e2e_<n>` |

These ports deliberately avoid the dev servers (3002/5173) and the Docker
stack (3001/8080), so any E2E run can go while `pnpm dev` is up.

**A run never attaches to a server it did not start.** Every `webServer`
entry in `playwright.config.ts` has `reuseExistingServer: false`. The rule
exists because the main checkout's `pnpm dev` (5173/3002) is the user's
and runs *that* checkout's code: a worktree run that attached to it would
report on the wrong code and still look green. If something already
listens on a stack port, Playwright stops with `http://localhost:<port> is
already used` instead. That also covers an orphaned Vite from a crashed
run, and `E2E_WEB_PORT=5173`. The details of how this was found are in
[`bugfix-e2e-reuses-dev-server.md`](bugfix-e2e-reuses-dev-server.md);
`scripts/__tests__/e2e-config.test.mjs` (`pnpm test:scripts`) pins the
defaults and the no-reuse rule.

## Troubleshooting

- **A shard fails, the rest pass** — open its report:
  `playwright-report/shard-<n>/index.html`; traces/screenshots are in
  `test-results/shard-<n>/`. Re-run just the failing files with
  `pnpm test:e2e e2e/<file>.spec.ts`.
- **Port already in use** (`http://localhost:<port> is already used`) — a
  previous run crashed without cleanup; kill leftover `tsx`/`vite`
  processes bound to 41xx/42xx/43xx ports. Do not work around it by
  pointing `E2E_WEB_PORT` at a running dev server: that is the case the
  error is there to stop.
- **Machine too loaded** — `E2E_SHARDS=2 pnpm test:e2e`.
- **Traces for a full sharded run** — `pnpm test:e2e --trace=retain-on-failure`.
  Write option values with `=`: any argument not starting with `-` counts
  as a file filter, so `--trace retain-on-failure` silently runs one
  unsharded process instead.
- **A test flakes only in full runs** — see
  `docs/bugfix-e2e-kiosk-and-editor-flakes.md` for the patterns found so
  far (batched tRPC URLs, cold second tabs, post-write refetches on a
  loaded database) and how they were diagnosed.
- **Timeouts only in CI** — each shard is a whole stack (API + Vite +
  eventor stub + Chromium) and wants about two cores. Four shards on a
  4 vCPU runner ran every shard at half speed (6-10 min instead of 3-5)
  and pushed tests with 5 s `expect` budgets over the edge; the default
  now scales with `os.availableParallelism()`. Tests that are
  legitimately long (many round trips, tile rendering in the background)
  should say so with `test.slow()` rather than the whole suite growing
  its timeouts. Tests that create named records must also be
  **retry-safe**: Playwright retries twice in CI, and a retry that finds
  the previous attempt's runner / card in place fails for a different
  reason than the first attempt did (`phase2.spec.ts` derives its names
  and card number from `testInfo.retry`).
