# Oxygen — Development Rules for AI Agents

These rules apply to all AI coding tools (Claude Code, Cursor, Copilot, Windsurf, etc.) working on this codebase. They are non-negotiable unless the user explicitly overrides a specific rule.

## 1. Project Overview

Oxygen is an orienteering competition management system. It is a pnpm monorepo with three packages:

- `packages/api/` — Fastify 5 + tRPC 11 backend (Node.js 20, ESM)
- `packages/web/` — React 19 PWA frontend (Vite, React Router v7, Tailwind CSS v4)
- `packages/shared/` — Shared types and utilities
- `e2e/` — Playwright E2E tests

Database: MySQL 8 with full bidirectional MeOS compatibility (see §7).

See `docs/architecture.md` for the full system architecture.

## 2. Commands Reference

| Task | Command | Notes |
|------|---------|-------|
| Start dev servers | `pnpm dev` | API on :3002, Web on :5173 |
| TypeScript build | `pnpm build` | All 3 packages must compile cleanly |
| Unit tests | `pnpm test` | ~371 tests across shared, api, web |
| Integration tests | `pnpm --filter api exec vitest run --config vitest.integration.config.ts` | 62 tests, requires live MySQL |
| E2E tests | `pnpm test:e2e` | 139 tests, Playwright (Chromium, single worker) |
| Test coverage | `pnpm test:coverage` | V8 coverage reports (HTML + LCOV) |
| Lint | `pnpm lint` | ESLint |
| Rebuild Docker | `docker compose -f docker-compose.host-db.yml up --build -d` | Rebuilds and restarts containers |
| Generate Prisma client | `pnpm db:generate` | After schema.prisma changes |
| Push schema to DB | `pnpm db:push` | Push schema changes to MySQL |

## 3. Development Environment

### Port Map

| Service | Dev Server | Docker |
|---------|-----------|--------|
| Web (Vite / nginx) | 5173 | 8080 |
| API (Fastify) | 3002 | 3001 |
| MySQL | 3306 | 3306 (shared) |

### Dev vs Docker

- **All development happens on the dev servers** (`pnpm dev`). Do not restart or interact with Docker during active development.
- Dev servers and Docker share the same MySQL instance on `localhost:3306`. They use different API ports (3002 vs 3001) so they do not conflict.
- Docker containers are only rebuilt as a final verification step after all tests pass (see §6).
- The Vite dev server proxies `/trpc` and `/api` requests to the API dev server at port 3002.
- Never commit `.env` files or credentials.

### Database

- Connection: `mysql://meos@localhost:3306/itest` (dev default)
- Two-tier design: **MeOSMain** (competition registry, global caches) + **per-competition databases** (MeOS schema)
- The database is shared between dev servers and Docker — changes made during dev are visible to both.

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
- **Integration tests**: `packages/api/src/__tests__/integration/*.test.ts` — Vitest with live MySQL. Test tRPC routers with real data.
- **E2E tests**: `e2e/*.spec.ts` — Playwright, Chromium, single worker, sequential. Full user flows through the browser.

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
4. **`pnpm test:e2e`** — Full suite for features and significant changes. For minor, isolated fixes, selective tests covering the affected area are acceptable: `pnpm test:e2e -- e2e/specific-file.spec.ts`
5. **Rebuild Docker** — Run `docker compose -f docker-compose.host-db.yml up --build -d` so the running stack reflects the latest code. **Required for every change that touches `packages/api/`, `packages/web/`, `packages/shared/`, `docker/`, any `Dockerfile`, `docker-compose*.yml`, or `pnpm-lock.yaml`.** You may skip it only for changes confined to `docs/`, `AGENTS.md`, `.claude/`, or test fixtures that don't ship in either image — and when you skip it, state so in your final message. Verify the output ends with both `Image oxygen-api Built` / `Image oxygen-web Built` and both containers `Started`; treat anything else as a failure.
6. **Major-version drift report** — After all other steps pass, run `pnpm outdated -r --long` and list any **direct** dependencies (production or dev) with a major-version update available. Format each as `package: current → latest — one-line note on what changes / "no notable changes documented"`. Informational only; do not bump majors as part of an unrelated PR. The user decides whether to act.

Never push code that fails any of steps 1–5. "It built fine locally" is not a substitute for step 5 — the Docker images use a different build path (multi-stage, production `NODE_ENV`, no dev dependencies) and routinely catch things `pnpm build` misses. Step 6 is informational and never gating.

## 7. MeOS Database Compatibility

Oxygen must maintain **full bidirectional compatibility** with MeOS. A database created by Oxygen must be openable by MeOS, and vice versa. This is a hard constraint that overrides convenience.

### Schema Rules

- The Prisma schema (`packages/api/prisma/schema.prisma`) must match MeOS column types, nullability, and defaults exactly.
- All `MEDIUMTEXT` columns must be `NOT NULL` with `@default("")`.
- All `Modified` columns must be `DateTime @default(now()) @updatedAt`.

### Control IDs

- Start controls: ID = `211100 + N`, Name = `"Start N"`
- Finish controls: ID = `311100 + N`, Name = `"Mål N"`
- Regular controls: `Name = ""`, `Numbers = code`

### Coordinates

- `xpos` / `ypos` store values × 10 (1 decimal place precision).
- `latcrd` / `longcrd` store values × 1e6 (6 decimal place precision).

### Counters

- Increment the `Counter` column and update `oCounter` on every record create/update.
- Use `incrementCounter()` from `packages/api/src/db.ts`.

### Data Normalization

- **BirthYear**: MeOS may store `YYYYMMDD` (> 9999) or `YYYY`. Always normalize with `normalizeBirthYear()`.
- **Organizer**: Store as plain text name, not `"name\tclubId"`.

### Defaults

- `ZeroTime`: `324000` (09:00:00 in deciseconds) on competition creation.
- `Features`: `"SL+BB+CL+CC+RF+NW+TA+RD"` on competition creation.

### Tables

- Competition databases must include `dbRunner`, `dbClub`, and `oImage` tables (created during init).
- Oxygen-only tables must use the `oos_` prefix to avoid collisions with MeOS tables.

### When in Doubt

Reference MeOS source code from [melin.nu/meos](http://www.melin.nu/meos), especially `MeosSQL.cpp`, `oEvent.cpp`, and `oDataContainer.cpp`.

## 8. Code Conventions

### TypeScript

- Strict TypeScript throughout. No `any` types unless absolutely necessary (and documented with a comment explaining why).
- Use Zod for all tRPC input validation. Keep Zod schemas co-located with the router that uses them.
- Import shared types and utilities from `@oxygen/shared`. Never duplicate type definitions across packages.

### API (`packages/api/`)

- **ESM with `.js` extensions**: All relative imports must use `.js` extensions (`import { foo } from "../bar.js"`), even though source files are `.ts`.
- Get the competition database client with `const client = await getCompetitionClient()`. Do not create additional PrismaClient instances.
- Use `incrementCounter(client)` after any write operation that modifies MeOS tables.
- Error handling: throw `TRPCError` with appropriate codes (`NOT_FOUND`, `BAD_REQUEST`, `CONFLICT`).
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
- Technical identifiers that are intentionally untranslated (SI, MeOS, Eventor) are exempt.

## 10. Documentation

- Every feature or significant change must include documentation updates as part of the same PR.
- Documentation lives in `docs/` as Markdown files.
- Style: pragmatic, implementation-focused. Use code blocks, ASCII diagrams, and embedded SQL/bash examples. See `docs/architecture.md` and `docs/receipt-printer-setup.md` for the expected format.
- Bug fix documentation: create `docs/bugfix-<descriptive-name>.md` explaining what happened, why, and how it was fixed. See `docs/bugfix-card-linking-and-meos-times.md` for an example.
- Keep `docs/features.md` up to date when adding new user-facing features.

## 11. Code Review Checklist

After completing a feature, perform a self-review covering these areas:

1. **Correctness** — Does the code do what it claims? Are edge cases handled? Are error paths covered?
2. **MeOS compatibility** — Do database writes maintain MeOS interop? Are counters incremented? Are column types correct? Do new tables use `oos_` prefix?
3. **Type safety** — Are there `any` types? Do Zod schemas cover all inputs? Do tRPC types flow end-to-end?
4. **Security** — No SQL injection (use Prisma or parameterized queries for raw SQL). No XSS (watch `dangerouslySetInnerHTML`). No secrets in code or logs.
5. **Performance** — Are queries efficient? No N+1 patterns? Do list endpoints paginate or limit?
6. **i18n** — Are all new user-facing strings in both locale files? Are translation keys semantic and descriptive?
7. **Tests** — Do tests cover happy path and key edge cases? Are tests readable and maintainable?
8. **Documentation** — Is the change documented? Do code comments explain "why", not "what"?

## 12. E2E Test Hygiene

- Tests must be self-contained: create any data they need, clean up after themselves.
- If a test creates a competition database, prefix the `NameId` with `E2E_` for automatic cleanup by global setup.
- Use `data-testid` attributes for stable selectors. Prefer `data-testid` over text matching.
- Never hard-code counts that could drift — use flexible assertions.
- Use existing helpers from `e2e/helpers/` (`selectCompetition`, `tabButton`, `getMockWebSerialScript`, etc.) rather than reimplementing.
- WebSerial is mocked via `page.addInitScript()` with the mock from `e2e/helpers/mock-webserial.ts`.
- Playwright runs sequentially: `fullyParallel: false`, `workers: 1`. Tests share a single Chromium instance.
- Three seed databases (`itest`, `itest_multirace`, `meos_20251222_001121_2BC`) are recreated fresh by `e2e/global-setup.ts` before every run.
- `MeOSMain.oxygen_settings` is shared with the developer's running stack. The Eventor API key rows (`eventor_api_key`, `eventor_api_key_test`) are snapshotted by `e2e/global-setup.ts` and restored by `e2e/global-teardown.ts` so tests can freely call `eventor.clearKey` / `eventor.validateKey` without wiping real credentials. If you add another mutation that writes a globally-scoped row in `oxygen_settings`, extend the snapshot list in the same place.

## 13. Git Conventions

- Commit messages: short imperative first line (under 72 chars), optional body explaining "why".
- Work on feature branches. PR into `main`.
- Do not force-push to `main`.
- Do not commit generated files (`dist/`, `node_modules/`, `prisma/generated/`), test artifacts, or `.env` files.

## 14. Dependency Management

Dependency hygiene is developer- and agent-driven, not Dependabot-driven. Dependabot in this repo is configured to surface alerts in the GitHub Security tab only; it does not open update or security PRs. The day-to-day loop runs through `pnpm audit`.

### On every PR that touches deps

- Run `pnpm audit --prod --audit-level=high` locally before pushing. PRs must not introduce new high or critical advisories in the production tree. The same check runs in `.github/workflows/audit-pr.yml` and will fail the PR.
- If a transitive dep is vulnerable and upstream has no fix, pin via `pnpm.overrides` in the root `package.json`. The block currently covers `undici`, `minimatch`, `flatted`, `serialize-javascript`, `effect`, `postcss`, `rollup`, `picomatch`, `defu`, and `vite`; add new entries with a one-line comment explaining why.
- Direct deps follow `^` ranges. Patch and minor bumps can land in any PR. Major bumps require a dedicated PR with the migration documented in `docs/`.

### After every push

The §6 verification checklist's step 6 (`pnpm outdated -r --long`) reports major-version drift. Do not act on it inside the same PR — surface it to the user so they can plan a dedicated bump.

### Vulnerability backstop

- Weekly: `.github/workflows/audit-weekly.yml` runs Mondays at 06:00 UTC. If any production high/critical advisory is unresolved, it opens (or comments on) a single open issue labelled `security-audit`. No issue → no notification.
- Manual sweep: `pnpm audit --prod --audit-level=high` at any time tells you the current state in seconds.

### Repository settings (one-time, manual)

The following must be set by a repo admin in **Settings → Code security**, since the API endpoint requires admin scope:

- Dependabot alerts: **ON** (so the Security tab and the weekly workflow have data to read).
- Dependabot security updates: **OFF** (no auto-PRs).
- Dependabot version updates: **OFF** (no `dependabot.yml` is committed; do not add one).
- Grouped security updates: **OFF**.

If those settings drift back on, you'll start getting Dependabot PRs; fix the settings, don't fight the bot.

### ocad2geojson fork

`ocad2geojson` upstream (`perliedman/ocad2geojson@2.1.20`) bundles a deprecated `xmldom@0.6.0` (one critical and several high CVEs) plus an old `uuid@3.4.0` and `protocol-buffers-schema` chain. Oxygen consumes a fork at [`marcus-kempe/ocad2geojson@v2.2.0-oxygen.0`](https://github.com/marcus-kempe/ocad2geojson/tree/v2.2.0-oxygen.0) that replaces `xmldom` with `@xmldom/xmldom`, bumps `uuid` and `vt-pbf`, and inlines the previously-patched color-fallback fix. Upstream PR: [perliedman/ocad2geojson#34](https://github.com/perliedman/ocad2geojson/pull/34). When the upstream merges, switch back to the npm release and drop the fork reference from `packages/api/package.json` and `packages/web/package.json`.

## 15. Common Pitfalls

1. **MySQL DATETIME timezone**: MySQL `DATETIME` has no timezone. Prisma treats it as UTC. If MySQL uses local time (e.g. CET), timestamps get double-shifted. Use `getUTC*()` methods for server-side formatting (see `fmtDatetimeLocal` in `control.ts`).

2. **Time format**: All times in the database are **deciseconds since midnight** (seconds × 10). Use `formatMeosTime()` for `HH:MM:SS` display, `formatRunningTime()` for `M:SS` or `H:MM:SS`.

3. **Start time priority**: Assigned (draw) start time takes priority over card start punch. Card punch is only used for punch-start events.

4. **Stale punch detection**: SI cards retain punches from previous races. Three-layer detection: client DOW check, server foreign control check, server course matching. Do not bypass these checks.

5. **Raw SQL tables**: Some Oxygen-specific tables (`oxygen_control_config`, `oxygen_competition_config`) use raw SQL via mysql2, not Prisma, because they are not in the Prisma schema. Follow the existing `ensureXxxTable()` pattern in `db.ts`.

6. **Prisma client singleton**: The competition Prisma client is managed by `getCompetitionClient()` in `db.ts`. Do not create additional PrismaClient instances.

7. **API `.js` import extensions**: The API package uses ESM with TypeScript. All relative imports in `packages/api/src/` must use `.js` extensions, even though the source files are `.ts`.
