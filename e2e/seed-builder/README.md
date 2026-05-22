# E2E Seed Builder

TypeScript scripts that build the E2E test events programmatically using
Prisma against the dedicated `oxygen_e2e` Postgres database on
`localhost:5433`. They are run automatically by `e2e/global-setup.ts`
before each Playwright run, so the committed builders are the single
source of truth for E2E fixtures.

## Why

The previous MeOS-MySQL world required hand-edited mysqldump output as
the source of truth — 731 lines of opaque INSERT statements per event,
impossible to diff meaningfully when the schema changed. The new layout
seeds via readable TypeScript with the same Prisma client the app uses,
so schema drift surfaces as compile errors instead of "the dump no
longer loads".

## Databases

| Builder | Event nameId | Notes |
|---------|--------------|-------|
| `build-itest.ts` | `itest` | "My example tävling" — main fixture: 3 classes, 3 courses, 23 controls, 54 runners, 44 card readouts. |
| `build-multirace.ts` | `itest_multirace` | "Multi-Race Series" — empty event, used for empty-state tests. |
| `build-test-competition.ts` | `meos_20251222_001121_2BC` | "Test competition" — empty event with non-default ZeroTime, used for error-path tests. |

All builders share `shared.ts` for MeOS-time helpers, status-enum
conversion, and the `recreateEvent` primitive that wipes an event and
re-creates it from scratch.

## Usage

### Automatic (typical)

```bash
pnpm test:e2e
```

`global-setup.ts` runs the builders in order against the dedicated
`oxygen_e2e` database before any test starts. No manual step required.

### Standalone (during development)

```bash
DATABASE_URL="postgresql://oxygen:oxygen@localhost:5433/oxygen_e2e?schema=oxygen" \
  pnpm exec tsx e2e/seed-builder/build-itest.ts
```

You can run a single builder this way to iterate on its fixture without
re-running the entire suite. The builder is idempotent (it deletes the
event row first, which cascades to all child tables).

### Adding a new fixture

1. Create `e2e/seed-builder/build-<name>.ts` mirroring the existing
   builders. Use `recreateEvent` so the script is re-runnable.
2. Add the new builder path to `runSeeds()` in
   `e2e/global-setup.ts`.
3. Add the new `nameId` to `SEED_NAME_IDS` in the same file so
   stale-cleanup keeps working.
