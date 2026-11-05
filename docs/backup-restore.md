# Event Backup & Restore

Oxygen ships with a one-click backup of the currently selected event, exposed on the **Event** page as a **Download backup** button. The endpoint streams a per-event PostgreSQL dump directly to the browser; nothing is stored on the server.

## What gets backed up

A single event — its rows in these tables of the `oxygen` schema, in this order: `events`, `controls`, `courses`, `course_controls`, `classes`, `class_course_pools`, `course_objects`, `runners`, `teams`, `cards`, `card_readouts`, `punches`, `control_units`, `event_log`, `map_sources`, `map_documents`, `club_symbol_decisions`, `map_files`, `rendered_maps`, `tracks`, `routes`, `event_seqs`.

Most are filtered to the event's id. `map_sources` and `map_documents` are not event-scoped: they hold the content-addressed map blobs, shared by every event and club map that pins the same bytes ([map-storage.md](map-storage.md) §1). The dump carries the rows this event's `map_files` pin, by hash — the source file and the imported document — ahead of `map_files`, so the sections restore in foreign-key order ([map-storage.md](map-storage.md) §7.3). `club_symbol_decisions` — the club's reviewed symbol outcomes, which a re-match of the restored map reads ([map-symbols.md](map-symbols.md) §8.5) — is instance-global and travels whole. `bytea` columns appear as Postgres `\x` hex in the CSV.

The dump is text — `psql \copy ... TO STDOUT WITH (FORMAT csv, HEADER true)` per table, with `\echo --- <table> ---` separator lines that make the file both human-readable and machine-parseable. Each table's section starts with the CSV header row and contains only that event's rows.

What is **not** in the backup:

- Other events on the same server
- Global / shared rows: `runner_directory`, `club_directory`, `eventor_event_meta`, `oxygen_settings`
- `map_tiles` and `map_previews`: render caches, keyed by content rather than by event, regenerated on demand
- `map_templates`, `course_maps`, `graphics`, the journal and lease tables (a pre-existing gap, not covered by this dump)

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
# DATABASE_URL here is a libpq URL: drop Prisma's `?schema=oxygen`
# parameter, which psql rejects.

# 1. Ensure the target database is on the current schema.
pnpm db:push

# 2. Recreate the event row. Copy the commented INSERT from the
#    backup file's header and run it (Postgres assigns a fresh id).
psql "$DATABASE_URL" -c "INSERT INTO oxygen.events (name_id, name, date, zero_time, annotation)
                         VALUES ('Vinterserien', 'Vinterserien', '2026-03-15', 324000, '');"

# 3. Capture the new event id.
NEW_ID=$(psql "$DATABASE_URL" -tAc "SELECT id FROM oxygen.events WHERE name_id = 'Vinterserien'")

# 4. Split the file by the `--- <table> ---` separator lines into one
#    <table>.csv per section (header row included).

# 5. The map sections: blobs by hash, then the event's map_files rows
#    with event_id rewritten to NEW_ID. Run from the directory with the
#    CSV files.
psql "$DATABASE_URL" -v event_id=$NEW_ID -f <repo>/packages/api/scripts/restore-map-blobs.sql

# 6. Every other section: rewrite the dump's event_id references from the
#    original id to NEW_ID, then re-import it (there is no committed
#    helper for these yet):
psql "$DATABASE_URL" -c "\copy oxygen.<table> FROM '<table>.csv' WITH (FORMAT csv, HEADER true)"

# 7. Only for a dump taken before the vector map pipeline existed
#    (no map_sources / map_documents sections, empty source_hash):
pnpm map:backfill --event <name_id>      # or Settings → Maintenance → Map documents
```

After the import, refresh the Oxygen UI and the event reappears in the picker with all data intact.

**The map sections restore idempotently on hash.** `restore-map-blobs.sql` loads `map_sources.csv`, `map_documents.csv` and `club_symbol_decisions.csv` through temporary tables and inserts them `ON CONFLICT DO NOTHING`: a blob the database already holds (another event or a club map pins the same file) keeps its row, nothing is ever overwritten, and running the script twice changes nothing. It refuses the whole load if any row's bytes do not hash to its `file_hash` / `hash`. `uploaded_by` and `club_map_version_id` are kept only when that user or club map version exists in the target database, else NULL. `created_at` / `last_referenced_at` restart at the restore, so the storage GC's 30-day grace ([map-storage.md](map-storage.md) §8) counts from then. Decisions merge by key: the newer `decided_at` wins and nothing is deleted, so restoring an old dump never undoes a decision made since (but brings back one reset since). Without `-v event_id=…` it loads only the blobs and decisions. Load a post-pipeline `map_files` section with step 5 rather than step 6: a plain `\copy` would fail on its foreign keys (the blobs must exist first; `club_map_version_id` may point at a club map version the target lacks) and, in the same database, on its `id`.

**Pre-vector dumps.** A dump taken before the pipeline has no `map_sources` / `map_documents` sections, and its `map_files` rows carry no hashes, so no blob is needed: skip step 5 and load its `map_files` section with step 6. Then step 7 — `pnpm map:backfill --event <name_id>` — gives the restored map its source and document rows and pins them ([map-storage.md](map-storage.md) §6.7, research 09 §5).

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
- Map restore: `packages/api/scripts/restore-map-blobs.sql`.
- Tests: `packages/api/src/__tests__/backup.test.ts` (script order and filters, section splitting), `packages/api/src/__tests__/integration/backup.test.ts` (dump → lose the event and its blobs → restore into another event; byte-exact, idempotent, tampered bytes refused), `e2e/backup.spec.ts` (UI download, map sections by hash).
