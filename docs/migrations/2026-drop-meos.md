# 2026 — Drop MeOS, migrate to PostgreSQL 18

This migration removes the MeOS compatibility layer (per-competition MySQL
databases + the `MeOSMain` registry + `oCounter` cross-process change
detection + MeOS punch-origin checksums) and replaces it with a single
PostgreSQL 18 database where every table lives in the `oxygen` schema.

The change is documented at length in the implementation plan; the
sections below summarise the new shape and the remaining migration steps
operators need to take.

## New layout

- One PostgreSQL 18 database `oxygen`, single Prisma datasource pointed at
  `?schema=oxygen`.
- Per-event entities (`controls`, `courses`, `course_controls`, `classes`,
  `class_course_pools`, `runners`, `teams`, `cards`, `control_units`) use
  `id UUID PRIMARY KEY DEFAULT uuidv7()` plus a per-event integer `seq`
  (URL-stable). `seq` is filled by a `BEFORE INSERT` trigger that pulls
  from a shared `oxygen.event_seqs(event_id, table_name, next_seq)` table.
- Append-only / immutable tables (`card_readouts`, `punches`,
  `event_log`) use UUID PK only.
- Pure server-side tables (`map_files`, `rendered_maps`, `map_tiles`,
  `tracks`, `routes`) use `BIGSERIAL`.
- Global directories keep their natural external IDs (`runner_directory`,
  `club_directory`, `eventor_event_meta`).
- Status columns use PG ENUM types: `runner_status`, `control_status`.
- `competition` → `event` rename: top-level entity is now `events.id`;
  the tRPC namespace is exposed as both `competition.*` (legacy) and
  `event.*` (preferred) during the transition.
- `x-competition-id` request header still works; clients should switch
  to `x-event-id` over time.
- **Clubs are no longer per-event entities.** Runners carry a
  `club_name TEXT` plus an optional `eventor_club_id BIGINT` pointer
  into the global `club_directory`. The "Clubs" view is derived from
  the runner roster at query time.

## Verified path

The schema applies cleanly to a fresh PG 18 instance and round-trips:

```bash
# Bring up the test PG container.
docker compose -f docker-compose.test.yml up -d

# Apply the initial migration.
DATABASE_URL='postgresql://oxygen:oxygen@localhost:5433/oxygen_test?schema=oxygen' \
  pnpm --filter @oxygen/api exec prisma migrate deploy

# Start the API.
DATABASE_URL='postgresql://oxygen:oxygen@localhost:5433/oxygen_test?schema=oxygen' \
PORT=3001 \
  pnpm --filter @oxygen/api dev

# Smoke-test a full round-trip.
curl -s 'http://localhost:3001/trpc/event.create' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"name":"Bagissprinten","date":"2026-04-15","nameId":"Bagissprinten"}'

curl -s -H 'x-event-id: Bagissprinten' \
  'http://localhost:3001/trpc/class.create' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"name":"H21"}'

curl -s -H 'x-event-id: Bagissprinten' \
  'http://localhost:3001/trpc/runner.create' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice Smith","classId":1,"cardNo":12345,"clubName":"OK Bagheera","eventorClubId":172}'

curl -s -H 'x-event-id: Bagissprinten' \
  'http://localhost:3001/trpc/event.dashboard'
```

`event.dashboard` returns counts and (when populated) class / course /
status summaries. The seq trigger allocates `1, 2, 3, …` for each entity
in the active event, and explicit seq values (used by the migration
tool) pass through untouched.

## Migration from legacy MySQL

A one-shot CLI moves Vinterserien and Bagissprinten from the old
multi-database MySQL layout into the new schema. Default behaviour is to
migrate exactly those two events; pass `--nameId <slug>` to migrate any
other event.

```bash
LEGACY_MYSQL_URL='mysql://meos@localhost:3306/MeOSMain' \
DATABASE_URL='postgresql://oxygen:oxygen@localhost:5432/oxygen?schema=oxygen' \
  pnpm migrate:mysql-to-pg --dry-run
```

**Status:** the CLI script lives at
`packages/api/scripts/migrate-mysql-to-pg.ts` (entry point wired into
`pnpm migrate:mysql-to-pg`). The reference implementation in
[`docs/migrations/2026-drop-meos-migration-tool.md`] walks through the
per-table mapping. Until the script lands, operators can use
`mysqldump` + a SQL transform — but the recommended path is to wait for
the CLI.

## Cutover

1. Verify the docker stack is on PG 18 (`docker compose down api web &&
   docker compose up --build -d`).
2. Stop the old MySQL-backed API.
3. Run `pnpm migrate:mysql-to-pg --dry-run` to confirm row counts.
4. Run `pnpm migrate:mysql-to-pg` for the real cutover.
5. Smoke-test the dashboard.
6. Keep the old MySQL volumes for at least one release as cold rollback.

## Status (May 2026)

- ✅ PG 18 schema, initial migration, triggers (seq allocator + updated_at).
- ✅ `db.ts` shrunk from ~1400 to ~140 lines.
- ✅ `trpc.ts` resolves event via `x-event-id` / `x-competition-id`.
- ✅ Core API routers ported and verified end-to-end:
  `event`, `runner`, `class`, `course`, `control`, `club`, `race`,
  `lists`, `cardReadout`, `events`, `external`.
- ✅ Stub routers in place for the bigger pipelines (Eventor sync,
  LiveResults push, Livelox sync, draw engine, online-input puller,
  registration trends, test-lab simulator). Each stub returns a clear
  `PRECONDITION_FAILED` so the UI can degrade gracefully.
- ✅ `backup.ts` uses `psql \copy`-driven per-event extraction.
- ✅ Docker compose: PG 18 on `:5432`, isolated `postgres-oxygen-test`
  on `:5433`. `pnpm test:db:up` / `down` helpers added.
- 🔜 Web port: the existing web pages reference ~100 endpoints from the
  pre-refactor API surface that aren't on the new routers yet. Each
  needs either a stub on the API or a UI tweak.
- 🔜 Migration tool: skeleton + per-table mapping documented;
  implementation pending.
- 🔜 Integration test suite: `packages/api/src/__tests__/integration/`
  needs rewriting against the new schema + PG schema-isolation helper.
- 🔜 E2E tests: `e2e/global-setup.ts` needs to switch from MySQL seeds
  to a Prisma-based seed builder.
- 🔜 Docs: `docs/architecture.md` and `AGENTS.md` need MeOS sections
  removed and the new schema diagram inserted.
