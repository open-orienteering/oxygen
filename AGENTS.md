# Oxygen — Development Rules for AI Agents

These rules apply to all AI coding tools (Claude Code, Cursor, Copilot, Windsurf, etc.) working on this codebase. They are non-negotiable unless the user explicitly overrides a specific rule.

## 1. Project Overview

Oxygen is an orienteering competition management system. It is a pnpm monorepo with three packages:

- `packages/api/` — Fastify 5 + tRPC 11 backend (Node.js 20, ESM)
- `packages/web/` — React 19 PWA frontend (Vite, React Router v7, Tailwind CSS v4)
- `packages/shared/` — Shared types and utilities
- `e2e/` — Playwright E2E tests

Database: PostgreSQL 18, single database `oxygen`, all tables in the `oxygen` schema. UUIDv7 PKs for client-mintable entities + per-event `seq INT` for human-friendly URLs. The legacy MeOS-compatible MySQL layout was retired in May 2026 (see `docs/migrations/2026-drop-meos.md`).

See `docs/architecture.md` for the full system architecture.

## 2. Commands Reference

| Task | Command | Notes |
|------|---------|-------|
| Start dev servers | `pnpm dev` | API on :3002, Web on :5173 |
| TypeScript build | `pnpm build` | All 3 packages must compile cleanly |
| Unit tests | `pnpm test` | Vitest across shared, api, web (518+ tests) |
| Integration tests | `pnpm --filter api exec vitest run --config vitest.integration.config.ts` | 69 tests, requires the test Postgres container (`pnpm test:db:up`) |
| E2E tests | `pnpm test:e2e` | 195 tests, Playwright — full runs are sharded across 4 isolated stacks (see `docs/e2e-sharding.md`); `pnpm test:e2e e2e/foo.spec.ts` runs a single spec unsharded |
| E2E tests (serial) | `pnpm test:e2e:serial` | Escape hatch: plain single-stack `playwright test` |
| Test coverage | `pnpm test:coverage` | V8 coverage reports (HTML + LCOV) |
| Lint | `pnpm lint` | ESLint |
| Rebuild Docker | `docker compose -f docker-compose.host-db.yml up --build -d` | Rebuilds and restarts containers |
| Generate Prisma client | `pnpm db:generate` | After schema.prisma changes |
| Apply migrations | `pnpm --filter @oxygen/api exec prisma migrate deploy` | Apply pending Prisma migrations to the configured DATABASE_URL |
| Push schema to DB | `pnpm db:push` | Push schema changes to Postgres without creating a migration file |
| Test DB up | `pnpm test:db:up` | Start the isolated Postgres test container (`:5433`) |
| Test DB down | `pnpm test:db:down` | Stop the isolated test container |

## 3. Development Environment

### Port Map

| Service | Dev Server | Docker |
|---------|-----------|--------|
| Web (Vite / nginx) | 5173 | 8080 |
| API (Fastify) | 3002 | 3001 |
| PostgreSQL (dev) | 5432 | 5432 (shared) |
| PostgreSQL (test) | 5433 | 5433 (isolated, integration + E2E only) |

### Dev vs Docker

- **All development happens on the dev servers** (`pnpm dev`). Do not restart or interact with Docker during active development.
- Dev servers and Docker share the same PostgreSQL instance on `localhost:5432`, database `oxygen`, schema `oxygen`. They use different API ports (3002 vs 3001) so they do not conflict.
- A separate `localhost:5433` Postgres container (`postgres-oxygen-test`) hosts the integration test (`oxygen_test`) and E2E (`oxygen_e2e`, plus per-shard `oxygen_e2e_1..4`) databases so tests never touch the working dev data.
- Docker containers are only rebuilt as a final verification step after all tests pass (see §6).
- The Vite dev server proxies `/trpc` and `/api` requests to the API dev server at port 3002.
- Never commit `.env` files or credentials.

### Database

- Connection: `postgresql://oxygen:oxygen@localhost:5432/oxygen?schema=oxygen` (dev default).
- Single database `oxygen`, single schema `oxygen`. Every event lives in the same set of tables, scoped by `event_id`.
- Global directories (`runner_directory`, `club_directory`, `eventor_event_meta`, `oxygen_settings`) live in the same schema and are shared across events.
- The dev database is shared between dev servers and the Docker stack on port 5432 — changes made during dev are visible to both.
- Tests run against the isolated `postgres-oxygen-test` container on `:5433` so they never touch dev data.

## 4. Test-Driven Development

This is a TDD-first project. All new features and bug fixes must be developed test-first.

### Rules

1. Write tests before or alongside the implementation, not as an afterthought.
2. For bug fixes, write a failing test that reproduces the bug before writing the fix.
3. Unit tests must cover all important business logic: algorithms, computations, data transformations, validation rules, and protocol parsing.
4. Integration tests are required for any new tRPC procedure that modifies database state or has non-trivial query logic.
5. E2E tests are required for any change that affects UI, navigation, API routes, or data flow visible to the user.
6. Tests should serve as documentation of expected behavior, not just be checkboxes.

### Test Pyramid

| Change type | Unit | Integration | E2E |
|------------|------|-------------|-----|
| New algorithm / computation | Required | — | — |
| New tRPC procedure | If has pure logic | Required | If user-facing |
| New UI page / component | — | — | Required |
| Full-stack feature | Required | Required | Required |
| Bug fix | Required (regression) | If DB-related | If UI-related |
| Refactor (no behavior change) | Existing must pass | Existing must pass | Existing must pass |

### Test Structure

- **Unit tests**: `packages/*/src/__tests__/*.test.ts` — Vitest, jsdom (web) / node (api). Fast, deterministic, no database.
- **Integration tests**: `packages/api/src/__tests__/integration/*.test.ts` — Vitest against the dedicated `postgres-oxygen-test` container on `:5433`. The harness (`helpers/load-env.ts`) refuses to run if `DATABASE_URL` resolves to port 5432 (dev DB) — set `INTEGRATION_DATABASE_URL` to override. Per-suite isolation comes from giving each suite its own `Event` row and relying on `ON DELETE CASCADE`.
- **E2E tests**: `e2e/*.spec.ts` — Playwright, Chromium, single worker, sequential within a stack. Full user flows through the browser. Full runs are parallelized by `scripts/e2e-sharded.mjs`, which launches 4 isolated stacks (own DB `oxygen_e2e_<n>`, own API, own Vite server) and splits the spec files across them — serial semantics are preserved inside each shard. See `docs/e2e-sharding.md`.

## 5. Flaky Test Policy

- If you encounter a flaky test during development, **fix it immediately**. Do not skip, retry-loop, or mark it as known-flaky.
- Common causes in this project: missing `waitFor` on async UI updates, race conditions between BroadcastChannel messages and DOM rendering, timing-dependent assertions on polling data.
- Fix flakiness with explicit waits (`page.waitForSelector`, `expect(...).toBeVisible()`), not arbitrary `sleep()` calls.
- If you discover missing test coverage in areas adjacent to your work, mention it to the user and suggest adding it.

## 6. Verification Checklist

Run this sequence before declaring any task complete. Every step is
mandatory — there is no "optional" step. If you skip one, say so explicitly
in your final message and explain why.

1. **`pnpm build`** — Zero TypeScript errors across all three packages.
2. **`pnpm test`** — All unit tests pass. Always required.
3. **Integration tests** — Run for any DB-related changes. Always required for features: `pnpm --filter api exec vitest run --config vitest.integration.config.ts`
4. **E2E tests** — During iterative development, run only the spec files covering the affected area (`pnpm test:e2e e2e/specific-file.spec.ts` — runs unsharded against the default stack). Before declaring a task complete, run the full suite once: `pnpm test:e2e` (sharded across 4 isolated stacks, ~2-3 min; see `docs/e2e-sharding.md`). For minor fixes confined to `docs/` or other non-shipping files, E2E can be skipped — state so in your final message.
5. **Rebuild Docker** — Run `docker compose -f docker-compose.host-db.yml up --build -d` so the running stack reflects the latest code. **Required for every change that touches `packages/api/`, `packages/web/`, `packages/shared/`, `docker/`, any `Dockerfile`, `docker-compose*.yml`, or `pnpm-lock.yaml`.** You may skip it only for changes confined to `docs/`, `AGENTS.md`, `.claude/`, or test fixtures that don't ship in either image — and when you skip it, state so in your final message. Verify the output ends with both `Image oxygen-api Built` / `Image oxygen-web Built` and both containers `Started`; treat anything else as a failure.
6. **Major-version drift report** — After all other steps pass, run `pnpm outdated -r --long` and list any **direct** dependencies (production or dev) with a major-version update available. Format each as `package: current → latest — one-line note on what changes / "no notable changes documented"`. Informational only; do not bump majors as part of an unrelated PR. The user decides whether to act.

Never push code that fails any of steps 1–5. "It built fine locally" is not a substitute for step 5 — the Docker images use a different build path (multi-stage, production `NODE_ENV`, no dev dependencies) and routinely catch things `pnpm build` misses. Step 6 is informational and never gating.

## 7. Database Schema Conventions

Oxygen runs on PostgreSQL 18 with a single database (`oxygen`) and a single
schema (`oxygen`). The MeOS bidirectional-compatibility constraint that
shaped the original layout was retired in May 2026
(see `docs/migrations/2026-drop-meos.md`).

### Primary Keys

- **Event-scoped, client-mintable entities** (`controls`, `courses`,
  `course_controls`, `classes`, `class_course_pools`, `runners`, `teams`,
  `cards`, `control_units`) use
  `id UUID PRIMARY KEY DEFAULT uuidv7()` plus a per-event
  `seq INT NOT NULL` populated by the `allocate_event_seq()` trigger from
  `oxygen.event_seqs`. URLs and tRPC inputs use `seq`; joins use `id`.
- **Append-only / immutable** (`card_readouts`, `punches`, `event_log`) use
  UUID PK only.
- **Pure server-side** (`map_files`, `rendered_maps`, `map_tiles`,
  `tracks`, `routes`) use `BIGSERIAL`.
- **Top-level entity** (`events`) uses `BIGSERIAL` — there is no offline-
  authored event.
- **Global directories** (`runner_directory`, `club_directory`,
  `eventor_event_meta`) use their natural external IDs from Eventor.

### Coordinates

- `xpos` / `ypos` are stored as `DOUBLE PRECISION` in meters (no x10 scaling).
- `lat` / `lng` are stored as `DOUBLE PRECISION` in degrees (no x1e6 scaling).

### Time storage

- Times are stored as **ZeroTime-relative deciseconds** (`INT`, default
  `0`). Default `events.zero_time` is `324000` (09:00:00).
- All API inputs and outputs use **absolute deciseconds**. Conversion
  happens at the boundary via `toAbsolute` / `toRelative` in
  `packages/api/src/timeConvert.ts`. Internal calculations stay in
  deciseconds.
- `cards.punches_raw` stores the legacy MeOS punch-list format
  `code-seconds.tenths;...` so the `parsePunches` round-trip is stable
  with the kiosk / matcher code that has not been ported yet.

### Statuses

- `runners.status` and `controls.status` are native PostgreSQL ENUM types
  (`runner_status`, `control_status`). The API converts to/from the legacy
  integer codes at the boundary via `statusConvert.ts`.

### Triggers

- `oxygen.set_updated_at()` keeps `updated_at` current on every UPDATE.
- `oxygen.allocate_event_seq()` fills `seq` from `oxygen.event_seqs` on
  INSERT. Passing an explicit `seq` value is allowed (and is how the
  migration tool preserves legacy IDs).

### Conventions

- Every event-scoped table has `event_id BIGINT REFERENCES oxygen.events(id) ON DELETE CASCADE`.
  This is what gives integration tests their isolation: each suite owns
  one `Event` row and cleanup is automatic.
- JSONB columns are used for structured metadata (routes, courses
  geometry, owner data, ROC raw payloads). Keep top-level keys
  snake_case to match the rest of the schema.

### When in Doubt

Read the Prisma schema (`packages/api/prisma/schema.prisma`) and the
initial migration (`packages/api/prisma/migrations/20260514_initial_pg_schema/`).
They define the canonical column types, defaults, and triggers.

## 8. Code Conventions

### TypeScript

- Strict TypeScript throughout. No `any` types unless absolutely necessary (and documented with a comment explaining why).
- Use Zod for all tRPC input validation. Keep Zod schemas co-located with the router that uses them.
- Import shared types and utilities from `@oxygen/shared`. Never duplicate type definitions across packages.

### API (`packages/api/`)

- **ESM with `.js` extensions**: All relative imports must use `.js` extensions (`import { foo } from "../bar.js"`), even though source files are `.ts`.
- Use the shared Prisma singleton via `prisma()` from `packages/api/src/db.ts`. Inside a tRPC procedure use `ctx.db` (which is the same instance). Do not create additional `PrismaClient` instances.
- Inside event-scoped procedures use `eventProcedure` from `trpc.ts`; it parses the `x-event-id` (or legacy `x-competition-id`) header and exposes `ctx.event` with `id`, `nameId`, `name`, `zeroTime`.
- Always convert times at the boundary: API inputs are absolute deciseconds, storage is `toRelative(input, ctx.event.zeroTime)`, reads multiply by `toAbsolute(row, zt)`.
- Error handling: throw `TRPCError` with appropriate codes (`NOT_FOUND`, `BAD_REQUEST`, `CONFLICT`, `PRECONDITION_FAILED`).
- Router files live in `packages/api/src/routers/` and are registered in `packages/api/src/routers/index.ts`.

### Web (`packages/web/`)

- Pages in `src/pages/`, components in `src/components/`, hooks in `src/hooks/`, contexts in `src/context/`, library code in `src/lib/`.
- Use `trpc.router.procedure.useQuery()` / `useMutation()` for data fetching.
- Use `trpc.useUtils()` for imperative cache invalidation.
- Tailwind CSS v4 for all styling. No CSS modules, no inline style objects.

### Error Handling

- API: use `TRPCError` for all expected error conditions. Unexpected errors are logged by the tRPC error middleware in `trpc.ts`.
- Web: use TanStack Query's error states. Show user-facing errors in the UI — do not silently swallow errors.
- Never use bare `try/catch` that ignores the error. At minimum, log it.

## 9. Internationalization (i18n)

- All user-facing strings must be internationalized using react-i18next.
- Supported languages: English (`en`) and Swedish (`sv`). Both must always have complete translations.
- 17 namespaces organized by feature area. Use the appropriate namespace: `const { t } = useTranslation("runners")`.
- Locale files: `packages/web/src/i18n/locales/{en,sv}/*.json`.
- When adding new strings, add the key to **both** `en` and `sv` JSON files. Never leave a language incomplete.
- Typed keys via `packages/web/src/i18n/i18next.d.ts` — the TypeScript compiler catches missing keys.
- Use `useRunnerStatusLabel()` / `useControlStatusLabel()` hooks for translated status text, not the raw English-only `runnerStatusLabel()` function.
- Technical identifiers that are intentionally untranslated (SI, Eventor, Livelox, LiveResults, ROC) are exempt.

## 10. Documentation

- Every feature or significant change must include documentation updates as part of the same PR.
- Documentation lives in `docs/` as Markdown files.
- Style: pragmatic, implementation-focused. Use code blocks, ASCII diagrams, and embedded SQL/bash examples. See `docs/architecture.md` and `docs/receipt-printer-setup.md` for the expected format.
- Bug fix documentation: create `docs/bugfix-<descriptive-name>.md` explaining what happened, why, and how it was fixed. See `docs/bugfix-card-linking-and-meos-times.md` for an example.
- Keep `docs/features.md` up to date when adding new user-facing features.

## 11. Code Review Checklist

After completing a feature, perform a self-review covering these areas:

1. **Correctness** — Does the code do what it claims? Are edge cases handled? Are error paths covered?
2. **Schema discipline** — Do new columns have explicit defaults? Are FK references using `ON DELETE CASCADE` where appropriate? Does any new event-scoped table include an `event_id` column? Do migrations match the running Prisma schema?
3. **Type safety** — Are there `any` types? Do Zod schemas cover all inputs? Do tRPC types flow end-to-end?
4. **Security** — No SQL injection (use Prisma or parameterized queries for raw SQL). No XSS (watch `dangerouslySetInnerHTML`). No secrets in code or logs.
5. **Performance** — Are queries efficient? No N+1 patterns? Do list endpoints paginate or limit?
6. **i18n** — Are all new user-facing strings in both locale files? Are translation keys semantic and descriptive?
7. **Tests** — Do tests cover happy path and key edge cases? Are tests readable and maintainable?
8. **Documentation** — Is the change documented? Do code comments explain "why", not "what"?

## 12. E2E Test Hygiene

- Tests must be self-contained: create any data they need, clean up after themselves.
- If a test creates an event, prefix the `nameId` with `E2E_` or `Delete_` for automatic cleanup by global setup.
- Use `data-testid` attributes for stable selectors. Prefer `data-testid` over text matching.
- Never hard-code counts that could drift — use flexible assertions.
- Use existing helpers from `e2e/helpers/` (`selectCompetition`, `tabButton`, `getMockWebSerialScript`, `reseed`, etc.) rather than reimplementing.
- The OCAD fixture `e2e/test.ocd` is a synthetic file generated by `scripts/generate-test-ocd.mjs` (see `docs/e2e-test-ocd-fixture.md`). Never commit real club map or course-setting exports — they carry georeferences and metadata paths. Regenerate the fixture via the script instead of editing it.
- WebSerial is mocked via `page.addInitScript()` with the mock from `e2e/helpers/mock-webserial.ts`. Mock punch times are in **seconds since midnight** (matching the SI hardware protocol); the API contract is **absolute deciseconds**, so the WebSerial decoder + `DeviceManager` handle the conversion automatically.
- Playwright runs sequentially: `fullyParallel: false`, `workers: 1`. Tests share a single Chromium instance.
- Three seed events (`itest`, `itest_multirace`, `meos_20251222_001121_2BC`) are recreated fresh by `e2e/global-setup.ts` via the programmatic seed builders in `e2e/seed-builder/*.ts`. Selective runs use the dedicated `oxygen_e2e` database on `:5433`; full sharded runs use one database per shard (`oxygen_e2e_1..4`, provisioned automatically). The dev DB on `:5432` is never touched by tests.
- For spec files that mutate seed data (create / delete events, controls, runners), call `await reseed()` in `test.beforeAll` so subsequent suites get a clean state. The helper at `e2e/helpers/reseed.ts` deletes all `E2E_` / `Delete_` rows + the three seed events and re-runs the builders.
- Integration tests run against the same `oxygen_e2e` container but use a separate database (`oxygen_test`). Each suite owns one `Event` row; cleanup is automatic via `ON DELETE CASCADE`.

## 13. Git Conventions

- Commit messages: short imperative first line (under 72 chars), optional body explaining "why".
- Work on feature branches. PR into `main`.
- Do not force-push to `main`.
- Do not commit generated files (`dist/`, `node_modules/`, `prisma/generated/`), test artifacts, or `.env` files.

## 14. Dependency Management

Dependency hygiene is developer- and agent-driven, not Dependabot-driven. Dependabot in this repo is configured to surface alerts in the GitHub Security tab only; it does not open update or security PRs. The day-to-day loop runs through `pnpm run audit:prod` (a thin client for npm's bulk advisory endpoint — see `scripts/audit-prod.mjs`). It enumerates the production tree by walking `pnpm-lock.yaml`, so it does not depend on an installed `node_modules` or a fully populated pnpm store.

### On every PR that touches deps

- Run `pnpm run audit:prod` locally before pushing (npm retired the legacy audit endpoint `pnpm audit` ≤10.x used; the script queries the bulk advisory endpoint directly). PRs must not introduce new high or critical advisories in the production tree. The same check runs in `.github/workflows/audit-pr.yml` and will fail the PR.
- If a transitive dep is vulnerable and upstream has no fix, pin via `pnpm.overrides` in the root `package.json`. The block currently covers `undici`, `minimatch`, `flatted`, `serialize-javascript`, `effect`, `postcss`, `rollup`, `picomatch`, `defu`, and `vite`; add new entries with a one-line comment explaining why.
- Direct deps follow `^` ranges. Patch and minor bumps can land in any PR. Major bumps require a dedicated PR with the migration documented in `docs/`.

### After every push

The §6 verification checklist's step 6 (`pnpm outdated -r --long`) reports major-version drift. Do not act on it inside the same PR — surface it to the user so they can plan a dedicated bump.

### Vulnerability backstop

- Weekly: `.github/workflows/audit-weekly.yml` runs Mondays at 06:00 UTC. If any production high/critical advisory is unresolved, it opens (or comments on) a single open issue labelled `security-audit`. No issue → no notification.
- Manual sweep: `pnpm run audit:prod` at any time tells you the current state in seconds.

### Repository settings (one-time, manual)

The following must be set by a repo admin in **Settings → Code security**, since the API endpoint requires admin scope:

- Dependabot alerts: **ON** (so the Security tab and the weekly workflow have data to read).
- Dependabot security updates: **OFF** (no auto-PRs).
- Dependabot version updates: **OFF** (no `dependabot.yml` is committed; do not add one).
- Grouped security updates: **OFF**.

If those settings drift back on, you'll start getting Dependabot PRs; fix the settings, don't fight the bot.

### ocad2geojson fork

`ocad2geojson` upstream (`perliedman/ocad2geojson`) still bundles a deprecated `xmldom@0.6.0` (one critical and several high CVEs) plus an old `uuid@3.4.0` and `protocol-buffers-schema` chain. Oxygen consumes a fork at [`open-orienteering/ocad2geojson@v2.2.2-oxygen.0`](https://github.com/open-orienteering/ocad2geojson/tree/v2.2.2-oxygen.0) that tracks upstream master (v2.1.23 merged Aug 2026), replaces `xmldom` with `@xmldom/xmldom`, bumps `uuid` and `vt-pbf`, inlines the previously-patched color-fallback fix, and fixes a scrambled SVG render order caused by order-less debug nodes in the no-fill double-line branch (see `docs/bugfix-powerline-render-order.md`). The fork's working branch is `fix/security-2026`; a local checkout lives at `../ocad2geojson` with `upstream` (perliedman) and `marcus-kempe` (previous fork, retired) remotes. Upstream PR for the security part: [perliedman/ocad2geojson#34](https://github.com/perliedman/ocad2geojson/pull/34). When upstream merges it, switch back to the npm release and drop the fork reference from `packages/api/package.json` and `packages/web/package.json`.

## 15. Common Pitfalls

1. **Time units in the kiosk pipeline**: SI hardware (and the WebSerial mock) speak **seconds since midnight**. The API contract is **absolute deciseconds**. `DeviceManager` multiplies by 10 before calling `cardReadout.storeReadout`. The API then converts to ZeroTime-relative deciseconds via `toRelative` before storage. Don't bypass either conversion.

2. **Time display**: All times in the database are **ZeroTime-relative deciseconds**. The API returns **absolute deciseconds**. Use `formatMeosTime()` for `HH:MM:SS` display, `formatRunningTime()` for `M:SS` or `H:MM:SS`.

3. **Start time priority**: Assigned (draw) start time takes priority over card start punch. The card start punch is only used when the runner has no assigned start time (punch-start events).

4. **Stale punch detection**: SI cards retain punches from previous races. Three-layer detection: client DOW check, server foreign-control check, server course matching. Do not bypass these checks.

5. **Public control IDs are codes, not seqs**: After the May 2026 refactor, `control.list` / `control.detail` / `control.update` / `control.delete` accept the **primary punch code** (e.g. `50`) as the public id, with a fallback to `seq` for legacy clients. Internally the router resolves via `getControlByCode`. When wiring new endpoints that take a control id, use the same helper so behaviour stays consistent.

6. **Prisma client singleton**: The Prisma client is exposed via `prisma()` in `packages/api/src/db.ts` and via `ctx.db` inside tRPC procedures. Do not create additional `PrismaClient` instances; doing so leaks connections and breaks transactional consistency.

7. **API `.js` import extensions**: The API package uses ESM with TypeScript. All relative imports in `packages/api/src/` must use `.js` extensions, even though the source files are `.ts`.
