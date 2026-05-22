# Event Backup & Restore

Oxygen ships with a one-click backup of the currently selected event, exposed on the **Event** page as a **Download backup** button. The endpoint streams a per-event PostgreSQL dump directly to the browser; nothing is stored on the server.

## What gets backed up

A single event — every event-scoped row in the `oxygen` schema (`events`, `controls`, `courses`, `course_controls`, `classes`, `class_course_pools`, `runners`, `teams`, `cards`, `card_readouts`, `punches`, `control_units`, `event_log`, `map_files`, `rendered_maps`, `map_tiles`, `tracks`, `routes`, `event_seqs`), filtered to the active event's id.

The dump is text — `psql \copy ... TO STDOUT WITH (FORMAT csv, HEADER true)` per table, with `\echo --- <table> ---` separator lines that make the file both human-readable and machine-parseable. Each table's section starts with the CSV header row and contains only that event's rows.

What is **not** in the backup:

- Other events on the same server
- Global / shared rows: `runner_directory`, `club_directory`, `eventor_event_meta`, `oxygen_settings`
- Map tile files outside the database (there are none — tiles live in `map_tiles`)

If you need a system-wide snapshot, run `pg_dump --schema=oxygen oxygen > full.sql` from the host instead.

## File format

The downloaded file is a UTF-8 text file. Header (a single SQL comment block) followed by `\echo`-delimited per-table CSV sections:

```sql
-- Oxygen backup
-- Created:    2026-04-25T20:14:55.123Z
-- Event:      Vinterserien
-- Name:       Vinterserien
-- Date:       2026-03-15
-- ZeroTime:   324000
-- Annotation:
--
-- This is a per-event dump filtered to event_id = 42.
-- To restore:
--   1. Apply the latest oxygen schema migration on a fresh database.
--   2. Run the INSERT below to recreate the event row, capturing the
--      new id (BIGSERIAL): the dump references the original id, which
--      you'll need to rewrite via sed before loading the data.
--
-- INSERT INTO oxygen.events (name_id, name, date, zero_time, annotation) VALUES ('Vinterserien', 'Vinterserien', '2026-03-15', 324000, '');

--- events ---
id,name_id,name,date,zero_time,annotation,...
42,Vinterserien,Vinterserien,2026-03-15,324000,,...
--- controls ---
id,event_id,seq,name,codes,...
...
```

The filename follows the pattern `<NameId>_backup_<YYYYMMDD_HHMMSS>.sql`.

If the underlying `psql` exits with a non-zero status (credentials wrong, server unreachable, etc.), the stream terminates with a `-- BACKUP FAILED (exit N): <stderr>` line so a partial download is detectable.

## Restoring an event

A restore is more involved than the MeOS-era flat-file dump because Oxygen now uses a single database with foreign keys and a `BIGSERIAL` event id. The recommended path:

```bash
# 1. Ensure the target database is on the current schema.
pnpm db:push

# 2. Recreate the event row. Copy the commented INSERT from the
#    backup file's header and run it (Postgres assigns a fresh id).
psql "$DATABASE_URL" -c "INSERT INTO oxygen.events (name_id, name, date, zero_time, annotation)
                         VALUES ('Vinterserien', 'Vinterserien', '2026-03-15', 324000, '');"

# 3. Capture the new event id.
NEW_ID=$(psql "$DATABASE_URL" -tAc "SELECT id FROM oxygen.events WHERE name_id = 'Vinterserien'")

# 4. Rewrite the dump's event_id references from the original id to NEW_ID,
#    then re-import each table's CSV section with \copy ... FROM STDIN.
#    There is no committed restore helper yet — split the file by the
#    `--- <table> ---` separator lines, then for each section run:
psql "$DATABASE_URL" -c "\copy oxygen.<table> FROM '<section>.csv' WITH (FORMAT csv, HEADER true)"
```

After the import, refresh the Oxygen UI and the event reappears in the picker with all data intact.

### Why an id rewrite is needed

`oxygen.events.id` is a `BIGSERIAL`. A fresh database hands out a new id when the header INSERT runs, but every dependent row in the dump (controls, courses, runners, …) references the original event id via foreign key. The restore script's job is to map old id → new id while replaying the CSV sections.

If you're restoring into the *same* database where the event already exists (e.g. recovering from a botched delete), reuse the existing id instead — there's no need to rewrite anything.

## Security and access control

The endpoint (`GET /api/backup/event?name=<NameId>`, with `GET /api/backup/competition` kept as a legacy alias for one transition release) is reachable to anyone who can hit the API — same access model as the other `/api/...` routes. If you expose Oxygen on a public network, place it behind your usual auth proxy.

The PostgreSQL password (when set) is passed to `psql` via the `PGPASSWORD` environment variable rather than the command line, so it does not appear in process listings.

## Implementation

- API: `packages/api/src/backup.ts` — Fastify route handler, header construction, `psql \copy` spawning.
- Web: the `DatabaseBackup` component in `packages/web/src/pages/EventPage.tsx`.
- Docker: the `api` stage of `Dockerfile` installs `postgresql-client` so `psql` is on `PATH` in production.
- Tests: `packages/api/src/__tests__/integration/backup.test.ts` + `e2e/backup.spec.ts`.
