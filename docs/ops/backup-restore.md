# Event Backup & Restore

Oxygen has two kinds of backup:

- **The per-event download**: the **Download backup** button on the **Event** page streams a dump of the selected event to the browser; nothing is stored on the server. `pnpm event:restore` loads it back. This is how an event moves between databases and how one lost event comes back.
- **Whole-database backups**: Cloud SQL's daily backups with point-in-time recovery on the cloud ([deploy-gcp-cloud-run.md](deploy-gcp-cloud-run.md) "Backups and restore"), and the compose files' `backup` service on a venue box or a self-hosted install ([Automatic backups](#automatic-backups) below).

## What the event backup holds

A single event: its rows in these tables of the `oxygen` schema, in this order, which is foreign-key order (every table after each dumped table it references, so the sections restore in file order):

`events`, `graphics`, `controls`, `courses`, `course_controls`, `map_templates`, `classes`, `class_course_pools`, `course_objects`, `course_maps`, `card_readouts`, `cards`, `runners`, `teams`, `control_units`, `punches`, `card_readout_backups`, `journal`, `map_sources`, `map_documents`, `map_document_colour_settings`, `club_symbol_decisions`, `map_files`, `map_patches`, `map_gps_tracks`, `map_colour_settings`, `tracks`, `routes`, `event_permissions`, `event_seqs`.

The list is `BACKUP_TABLES` in `packages/api/src/backup.ts`. An integration test checks it against the migrated schema: every table with an `event_id` column is dumped or listed in `BACKUP_EXCLUDED` with its reason, and the order agrees with the schema's foreign keys.

Most sections are filtered to the event's id. `course_controls` and `class_course_pools` follow their course and class. `map_sources` and `map_documents` are not event-scoped: they hold the content-addressed map blobs, shared by every event and club map that pins the same bytes ([map-storage.md](../map-storage.md) §1). The dump carries the rows this event's `map_files` and `map_patches` pin, by hash (the source file and the imported document), and the per-document colour settings of those documents. `club_symbol_decisions` (the club's reviewed symbol outcomes, which a re-match of the restored map reads, [map-symbols.md](../map-symbols.md) §8.5) is instance-global and travels whole. `bytea` columns appear as Postgres `\x` hex in the CSV.

Left out:

- Other events on the same server.
- Global and shared rows: users, user groups and permission groups, club maps and their versions, `runner_directory`, `club_directory`, `eventor_event_meta`, `settings`.
- Event-scoped tables in `BACKUP_EXCLUDED`: `event_lease` and `journal_sync_state` (per-node sync state; a restore would misstate which node holds the event and what was shipped), `course_presence` (ephemeral editor presence), `map_uploads` and `map_import_jobs` (transient upload and import plumbing).
- Caches: `map_previews`, `map_heightfields` and `map_dem_jobs`, regenerated on demand.

For a whole-database snapshot use the [automatic backups](#automatic-backups), or run `pg_dump --schema=oxygen` yourself.

## File format

The downloaded file is UTF-8 text: a header comment (its second line `-- Format:     2` says the file ends with the completion line below), then one `--- <table> ---` section per table holding that table's rows as CSV with a header row, then the line `-- BACKUP COMPLETE`.

```sql
-- Oxygen backup
-- Format:     2
-- Created:    2026-04-25T20:14:55.123Z
-- Event:      Vinterserien
-- Name:       Vinterserien
-- Date:       2026-03-15
-- ZeroTime:   324000
-- TimeZone:   Europe/Stockholm
-- Annotation:
--
-- This is a per-event dump filtered to event_id = 42.
-- …
--- events ---
id,name_id,name,annotation,date,zero_time,...
42,Vinterserien,Vinterserien,,2026-03-15,324000,...
--- controls ---
id,event_id,seq,name,codes,...
...
--- event_seqs ---
event_id,table_name,next_seq
...
-- BACKUP COMPLETE
```

The filename follows the pattern `<NameId>_backup_<YYYYMMDD_HHMMSS>.sql`.

**A dump is one consistent snapshot.** psql reads every section inside one `REPEATABLE READ READ ONLY` transaction, so a backup taken during readout never holds a runner whose card is from a later moment than the card's readout.

**A failed dump is never a quiet file.** psql runs with `ON_ERROR_STOP`, so the first failing section stops it, and its error output goes to the server log.

- When psql fails before writing anything (the database is unreachable, the credentials are wrong), the server answers `502` with an error, and the Event page shows "The backup failed: …" instead of saving a file.
- When it fails part way, the transfer is aborted, so the browser reports a failed download. The server first writes a `-- BACKUP FAILED (exit N): <error>` line, which reaches a file saved by other means (curl) unless the client is reading too slowly to take it within 10 seconds.
- Only a file that ends with `-- BACKUP COMPLETE` is whole; the restore refuses any file with the `-- Format:` line that lacks it, wherever it was cut.
- When the browser goes away, before or during the dump, the server stops psql. psql gives up connecting after 10 seconds.

On Cloud Run the dump reaches Cloud SQL through the unix socket named by the `?host=/cloudsql/…` parameter of `DATABASE_URL`, the same way the app does.

## Restoring an event

```bash
# 1. The target database must be on the current schema.
pnpm db:migrate

# 2. Restore. DATABASE_URL (the app's, `?schema=oxygen` and all) names the target.
pnpm event:restore ~/Downloads/Vinterserien_backup_20260425_201455.sql

# Inside the API image: the service is `api` in docker-compose.venue.yml,
# `oxygen` in docker-compose.release.yml.
docker compose -f docker-compose.venue.yml --env-file .env.venue cp Vinterserien_backup_20260425_201455.sql api:/tmp/backup.sql
docker compose -f docker-compose.venue.yml --env-file .env.venue exec api node packages/api/dist/cli/restore-event.js /tmp/backup.sql
```

The event comes back under a new `events.id` with every row of the dump. Refresh the Oxygen UI and it is in the event picker.

**When the event already exists** in the target (same `name_id`), the restore refuses. `--replace` deletes the existing event, with everything that belongs to it, and restores the backup in its place: use it to roll an event back to a backup, or to rerun a restore that failed part way. Its lease and shipping state go with it, so on a venue box the event must be checked out again afterwards.

**What the restore does** (`packages/api/src/restore.ts`), in five phases, each one transaction:

1. The event row (a fresh id) and every race-data section, in dump order, which is foreign-key order. Each section loads through a temp table built from its CSV header, so columns match by name: a backup from an older release loads (its columns this schema no longer has are left out with a warning, columns it lacks take their defaults). `event_id` is rewritten to the new event. The global serial ids, which another database may already use, come from the target's sequences: `tracks.id`, `routes.id`, `journal.ingest_seq` (the journal keeps its order) and `graphics.id`, whose new numbers are also written into the layout JSON that draws them (`graphicId` in templates' and sheets' objects and in course objects). Every other id (the UUIDs) is kept. A reference to a row the target does not hold (a user, a user group, a club map, a map source the backup did not carry) is handled as the foreign key's `ON DELETE` action would handle a deleted row: `SET NULL` clears the column (the user who granted a permission), `CASCADE` skips the row (the permission of a user the target does not have). Either way the restore prints a warning.
2. The map blobs, symbol decisions and the event's `map_files` row, through `packages/api/scripts/restore-map-blobs.sql` (below).
3. The sections that need the blobs: the per-document colour settings (a row already present is kept), the map patch and the event's colour settings.
4. The GPS tracks, through `restore-map-gps-tracks.sql`: `created_by` is kept only when that user exists.
5. The seq counters, through `restore-event-seqs.sql`. Restoring the tables made the `allocate_event_seq()` trigger create a counter per table at the highest seq + 1; the script merges the dump's counters in, keeping the higher of the two (a counter can be ahead of the rows: deleted rows keep their numbers).

When phase 1 fails nothing is restored. When a later phase fails the event is partly restored; fix the cause and rerun with `--replace`.

The restore refuses a file with a `-- BACKUP FAILED` line, and a file with the `-- Format:` header line but without the `-- BACKUP COMPLETE` line (it was cut short). A file from an older release, which has neither, loads with a warning to check that it is the whole file. Its `event_log` section (the journal before it was renamed, which always came out empty) and `rendered_maps` section are skipped.

Restoring a copy of an event beside its original in the same database is not supported: the backup's UUIDs are kept, so they collide with the original's, and the restore stops with a duplicate-key error. Restore the copy into another database (UUIDs do not collide across databases).

**The map sections restore idempotently on hash.** `restore-map-blobs.sql` loads `map_sources`, `map_documents` and `club_symbol_decisions` through temporary tables and inserts them `ON CONFLICT DO NOTHING`: a blob the database already holds (another event or a club map pins the same file) keeps its row, nothing is ever overwritten, and running the script twice changes nothing. It refuses the whole load if any row's bytes do not hash to its `file_hash` / `hash`. `uploaded_by` and `club_map_version_id` are kept only when that user or club map version exists in the target database, else NULL. `created_at` / `last_referenced_at` restart at the restore, so the storage GC's 30-day grace ([map-storage.md](../map-storage.md) §8) counts from then. Decisions merge by key: the newer `decided_at` wins and nothing is deleted, so restoring an old dump never undoes a decision made since (but brings back one reset since). A promoted club map version's document carries the corrections it was built with (`map_documents.patch`, [map-patches.md](../map-patches.md) §5); the script restores the column, and loads a dump written before it existed with the column left empty.

**Dumps written before v0.6.1.** Their `map_files` section carries the map's bytes in `file_data` (a pre-vector dump has no hashes and no `map_sources` / `map_documents` sections at all). The restore loads it through `restore-legacy-map-files.sql`, which makes the bytes a `map_sources` row and pins it, and then says to run the re-match, which imports whatever has no document yet ([map-storage.md](../map-storage.md) §6.7, §7.3):

```bash
pnpm map:rematch --event <name_id>
```

Their `events` and `courses` sections carry columns v0.6.1 dropped (`map_pipeline`, `overprint_cuts_version`, `geometry`, `geometry_source`); the restore leaves them out by name.

## Automatic backups

`docker-compose.venue.yml` (venue box) and `docker-compose.release.yml` (self-hosted) run a `backup` service beside Postgres: every 15 minutes it writes a `pg_dump --schema=oxygen --format=custom` of the whole database to `./backups/oxygen_<UTC time>.dump` next to the compose file, and keeps the newest 48 (twelve hours). A dump is written as `.partial` and renamed when `pg_dump` succeeded, so every `*.dump` file is complete. The service uses the same Postgres image as the database, so `pg_dump` always matches the server.

| Variable | Default | |
| --- | --- | --- |
| `BACKUP_DIR` | `./backups` | Where the dumps go on the host. Point it at a USB stick to keep a copy off the box's disk. |
| `BACKUP_INTERVAL_SECONDS` | `900` | Time between dumps. |
| `BACKUP_KEEP` | `48` | Dumps kept; older ones are deleted. |

`docker compose logs backup` shows each dump written, `pg_dump FAILED` when one was not, and and what it does when space runs short: before each dump it wants twice the last dump's size free, deletes the oldest dumps (never the newest two) until there is, and skips the round (`SKIPPED`) only if that is not enough, so the service never fills the disk the database lives on. Each dump is the whole database, map blobs included, so 48 of them take about 48 times one dump: check one dump's size before race day and lower `BACKUP_KEEP` if the disk is small. A `.partial` left by a stopped container is deleted on the next round. The script is `docker/pg-backup.sh` (inlined in the release compose file, which runs without a checkout).

When `BACKUP_DIR` points at a USB stick that is not mounted, the dumps go to the empty mount-point directory on the box's own disk: check with `df` that the directory is on the stick.

To restore the whole database from one of them, stop the app and load the dump into a freshly created database (a dump from before a migration does not `--clean` cleanly over a migrated schema), then run the migrations and start the app:

```bash
C="docker compose -f docker-compose.venue.yml --env-file .env.venue"
$C stop api
$C exec -T postgres sh -c 'dropdb -U oxygen --if-exists oxygen && createdb -U oxygen oxygen'
$C exec -T postgres pg_restore -U oxygen -d oxygen --no-owner < backups/oxygen_20260501_120000.dump
$C run --rm migrate
$C start api
```

To get one event out of a whole-database dump, restore it into a scratch database, download the event's backup from an Oxygen pointed at it (or run the dump there), and `pnpm event:restore` that file into the live database.

## Before an upgrade

The rotating dumps are the safety net for a crash, not for an upgrade: a bad
migration or an image that cannot run it leaves the newest dump taken from
a database the new code may already have touched, and the rotation deletes
the oldest dumps. Before every upgrade of a box (venue or release compose),
pull the new image first, then take a dump the rotation will not delete
(`pre-upgrade_*` does not match `oxygen_*.dump`), then start the new version:

```bash
C="docker compose -f docker-compose.release.yml"   # or -f docker-compose.venue.yml --env-file .env.venue
$C pull                       # release compose; the venue box rebuilds with `up --build`
$C run --rm --entrypoint pg_dump backup --schema=oxygen --format=custom \
  --file=/backups/pre-upgrade_$(date -u +%Y%m%d_%H%M%S).dump
$C up -d                      # migrate runs first, then the app
```

The dump lands in `BACKUP_DIR` (default `./backups`) and has the same format
as the automatic ones. To go back, restore it as described above with the
previous image. `docker-compose.release.yml` no longer pulls on `up` by
itself (`OXYGEN_PULL_POLICY` defaults to `missing`), so a version change is
always a deliberate `pull`.

## Security and access control

The endpoint (`GET /api/backup/event?name=<NameId>`, with `GET /api/backup/competition` kept as a legacy alias for one transition release) needs the `event.manage` capability on the event. When the event's map came from the club map library, it also needs an admin: the dump carries the map's source file, which stays club property.

The PostgreSQL password is passed to `psql` in the `PGPASSWORD` environment variable rather than on the command line, so it does not appear in process listings.

The automatic backups hold every event, users included: keep the backup directory (and any USB stick it points at) as safe as the box.

## Implementation

- API: `packages/api/src/backup.ts`: the route, the dump script (`BACKUP_TABLES`, `BACKUP_EXCLUDED`), the connection parameters (`parseDatabaseUrl`), the stream.
- Restore: `packages/api/src/restore.ts` and the CLI `packages/api/src/cli/restore-event.ts` (`pnpm event:restore`); the phase scripts `packages/api/scripts/restore-map-blobs.sql`, `restore-legacy-map-files.sql`, `restore-map-gps-tracks.sql`, `restore-event-seqs.sql`.
- Web: the `DatabaseBackup` component in `packages/web/src/pages/EventPage.tsx`.
- Docker: the `api` stage of `Dockerfile` installs `postgresql-client` so `psql` is on `PATH` in production; `docker/pg-backup.sh` and the compose files' `backup` service.
- Tests: `packages/api/src/__tests__/backup.test.ts` (script, order, connection parsing, the stream's failure and backpressure handling), `restore.test.ts` (vetting a dump, the generated scripts, the phases), `integration/backup-restore-roundtrip.test.ts` (the table list against the schema, a whole event with readouts, cards, runners, punches and its map lost and restored, `--replace`, a cut-short dump, the 502), `integration/backup.test.ts` (the map sections byte-exact, idempotent, tampered bytes refused; a pre-v0.6.1 `map_files` section), `e2e/backup.spec.ts` (the download, the map sections, the error on a failed backup).
