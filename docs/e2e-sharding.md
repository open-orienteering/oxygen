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
   └── scripts/e2e-sharded.mjs  (default N=4, override with E2E_SHARDS)
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
| `pnpm test:e2e` | Full suite, sharded across 4 stacks (~2-3 min) |
| `pnpm test:e2e e2e/kiosk.spec.ts` | Selective run — single plain Playwright process on its own isolated stack (ports 4100/4200, db `oxygen_e2e`), no sharding. Isolated ports mean it works while `pnpm dev` is running |
| `E2E_SHARDS=2 pnpm test:e2e` | Fewer shards (lower peak CPU/RAM) |
| `pnpm test:e2e:serial` | Escape hatch: plain `playwright test`, identical to the pre-sharding behavior |

Any argument that doesn't start with `-` is treated as a file filter and
triggers the unsharded selective path, so `-g "name"` filters also run
unsharded.

## How the pieces fit

### Env-var plumbing

`playwright.config.ts` reads five variables (all optional — defaults
reproduce the historical single-stack behavior):

| Variable | Default | Used for |
|----------|---------|----------|
| `E2E_API_PORT` | `3002` | API webServer port + `PORT`/`DATABASE_URL` env |
| `E2E_WEB_PORT` | `5173` | Vite webServer port + Playwright `baseURL` |
| `E2E_EVENTOR_PORT` | `4300` | Eventor stub port + the API's `EVENTOR_API_BASE_URL` |
| `E2E_DB_NAME` | `oxygen_e2e` | Database on `:5433` (global-setup + reseed too) |
| `E2E_SHARD` | unset | Artifact dirs: `test-results/shard-<n>`, `playwright-report/shard-<n>` |

The Vite dev server accepts `WEB_PORT` (deliberately *not* `PORT`, which
`pnpm dev` uses for the API) and `API_PROXY_PORT` for the `/trpc` + `/api`
proxy target — both passed by the Playwright webServer config.

Specs never hardcode the API origin; they import `API_BASE` from
`e2e/helpers/api-base.ts`, which derives it from `E2E_API_PORT`.

### File partitioning

The runner assigns spec files to shards with an LPT (longest processing
time first) heuristic over a static weight table in
`scripts/e2e-sharded.mjs`. Weights are rough run-time proportions; the
per-shard durations printed at the end of every run tell you when the
table needs rebalancing — edit `WEIGHTS` and re-run.

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

Shard ports (`4101-410N` API, `4201-420N` web, `4301-430N` Eventor stub)
deliberately avoid the dev servers (3002/5173) and the Docker stack
(3001/8080), so the full E2E suite can run while `pnpm dev` is up.

## Troubleshooting

- **A shard fails, the rest pass** — open its report:
  `playwright-report/shard-<n>/index.html`; traces/screenshots are in
  `test-results/shard-<n>/`. Re-run just the failing files with
  `pnpm test:e2e e2e/<file>.spec.ts`.
- **Port already in use** — a previous run crashed without cleanup; kill
  leftover `tsx`/`vite` processes bound to 41xx/42xx ports.
- **Machine too loaded** — `E2E_SHARDS=2 pnpm test:e2e`.
