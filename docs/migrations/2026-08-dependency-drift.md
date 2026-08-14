# August 2026 dependency drift sweep

One PR (`deps-drift-2026-08`) clearing all outstanding minor, patch, and
major version drift in a single pass, staged as one commit per risk tier
so failures are bisectable.

## Minor / patch sweep

`pnpm up -r` across the workspace: tRPC 11.18, Fastify 5.12, TanStack
Query 5.101, react-router 7.18, Playwright 1.62 (new Chromium),
Vitest 4.1, Zod 4.4, mysql2 3.23, tailwind 4.3, and ~30 more.

Fallout handled:

- **mysql2 3.23** tightened `execute()`'s value typing — `unknown[]` is
  no longer assignable. `liveresults.ts` now types its parameter array
  as `(string | number)[]`.
- **vite-plugin-pwa 1.3** moved `workbox-build` / `workbox-window` to
  peer dependencies — now declared explicitly in `@oxygen/web`.
- The vestigial root `mysql2` devDependency (unused since the MeOS
  retirement; MySQL remains only for the LiveResults push and the
  MeOS→PG migration tool inside `packages/api`) was removed.

## jsdom 30, @types/jsdom 30, @types/node 26

Drop-in; no code changes needed.

## Vite 8 (+ @vitejs/plugin-react 6)

Rolldown-based build pipeline. One breaking change hit us: the object
form of `build.rollupOptions.output.manualChunks` was removed —
`packages/web/vite.config.ts` now uses the function form with the same
vendor-react / vendor-i18n / vendor-trpc chunking.

## Prisma 7

The big one. See the [official v7 upgrade guide](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7).
What changed here:

- **Generator**: `prisma-client-js` → `prisma-client` (Rust-free,
  TS + WASM query compiler). `output` is now mandatory; the client is
  generated into `packages/api/src/generated/prisma/` (gitignored,
  compiled together with the API by tsc). There is no postinstall
  generate anymore — run `pnpm db:generate` after `pnpm install` or a
  schema change; the Docker build runs it explicitly after copying the
  API sources.
- **Imports**: `@prisma/client` → the generated path
  (`.../generated/prisma/client.js`). The generated `client.ts`
  re-exports `PrismaClient`, the `Prisma` namespace, and the enums, so
  it is a pure specifier swap across ~19 files.
- **Driver adapter is mandatory**: `@prisma/adapter-pg` wraps the
  connection. `db.ts`'s lazy singleton reads `DATABASE_URL` at first
  use (unchanged semantics for test helpers that swap the env var).
  The `datasourceUrl` client option is gone — the two-node integration
  suites pass `adapter: new PrismaPg({ connectionString })` instead.
- **`prisma.config.ts`** (in `packages/api/`, where the CLI runs):
  schema path, migrations path, and the datasource URL now live there;
  the schema's `url = env(...)` line is removed. The CLI no longer
  auto-loads `.env`, so the config imports `dotenv/config` itself.
  `DATABASE_URL` from the process environment still wins — the
  integration/E2E harnesses that point the CLI at `:5433` databases
  keep working unchanged.
- Not applicable to us: `$use` middleware, `Prisma.validator`, metrics,
  auto-seeding (none were used).

Three gotchas worth remembering:

1. **Pool size**: node-postgres defaults to 10 connections — well below
   the old Rust engine's `2 × cores + 1`. Under E2E load this starved
   the pool and produced hung requests. `db.ts` now passes `max: 25`
   (override with `DATABASE_POOL_MAX`).
2. **`importFileExtension = "js"`** in the generator block is required:
   the extensionless default resolves under tsx/vitest but crashes plain
   Node ESM (`node dist/index.js` in the Docker image) with
   `ERR_MODULE_NOT_FOUND` on the generated client's internal imports.
3. **Docker generate step**: `prisma.config.ts` resolves `DATABASE_URL`
   eagerly, so the build stage passes a dummy URL to `db:generate`
   (generation never touches a database).

## Playwright 1.62: localhost vs 127.0.0.1

After the bump, every `page.request` / `request.newContext` call to
`http://localhost:...` stalled for ~10 s: Playwright's request stack
resolves `localhost` to `::1` first and only falls back to IPv4 after a
long timeout, while the dev servers listen on IPv4 only. Browsers and
curl do fast fallback, so pages loaded fine — only API-helper calls in
the E2E suite hung (30 s beforeEach timeouts, suites poisoned by pool
carry-over). Fix: `playwright.config.ts` baseURL and all E2E API
constants now use `http://127.0.0.1:...`. If you add E2E helpers, never
use `localhost` in URLs.

## TypeScript 6.0.3 — and why not 7.0.2

TS 6.0 is the JS-based bridge release aligning APIs and deprecations
for the native (Go) 7.x compiler. **typescript-eslint 8.67 caps its
peer range at `typescript <6.1.0`**, so jumping to 7.0.2 would break
the web package's lint toolchain. 6.0.3 compiled the whole workspace
with zero code changes. Revisit 7.x when typescript-eslint announces
support; the compile surface is already 7-aligned after this bump.
