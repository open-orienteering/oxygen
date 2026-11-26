# The event backup was incomplete, failed silently and could not be restored

Fixed 2026-11-26 (full code review package 14: DB-13, API-12, MC-11, SYNC-09, BLD-01, DB-14, SYNC-10, SYNC-36, MC-50, DB-36, DB-35).

## What happened

The per-event **Download backup** ([ops/backup-restore.md](../ops/backup-restore.md)) is the only recovery path for an event on a venue box, and it had several faults that together made it unreliable:

- **The journal was never in it.** The dump still named `event_log`, which was renamed to `journal` in `20260601130000_journal_rename`. psql ran without `ON_ERROR_STOP`, printed the error, carried on, and exited 0, so the section came out empty and nothing said so. Any later rename would have emptied a section just as quietly.
- **It was not a snapshot.** Each of the `\copy` statements ran in its own transaction, so a dump taken during readout could hold a card from one moment and its readout from another.
- **On Cloud Run it could not reach the database, and still downloaded as a file.** `backup.ts` parsed `DATABASE_URL` by hand and used the host name (`localhost`) and port 5432. The Cloud SQL socket is in the URL's `?host=/cloudsql/…` parameter, which `pg` honours and the backup ignored. The header was written before psql started, so the browser received a normal 200 attachment containing only the header and a `-- BACKUP FAILED (exit 2)` line.
- **The documented restore could not succeed for an event with readouts.** The section order was not foreign-key order: `runners` came before `cards` (`runners.card_id`), `cards` before `card_readouts` (`cards.readout_id`) and `punches` before `control_units` (`punches.unit_id`), none of them deferrable. `map_templates` was not dumped although `classes.sheet_template_id` references it, and `course_maps`, `graphics`, `card_readout_backups`, `event_permissions` and the colour settings were missing. There was no committed restore for the race data; the doc said to `sed` the event id and `\copy` each section by hand.
- **The stream had no backpressure** (`stdout.on("data") → write`), and a client that went away left psql running.
- **Venue boxes and self-hosted installs had no automatic backup**, and Cloud SQL had no point-in-time recovery, so a bad write at 14:00 on race day could only be undone to 03:00.

## How it was fixed

- `BACKUP_TABLES` (`packages/api/src/backup.ts`) is in real foreign-key order and holds every event-scoped table except the per-node sync state, editor presence and transient upload/import rows, which are listed with their reason in `BACKUP_EXCLUDED`. An integration test reads the migrated schema and fails if an event-scoped table is in neither list, if a listed table does not exist, or if a table comes before one it references.
- The dump script stops at the first error, reads every section in one `REPEATABLE READ READ ONLY` transaction, and ends with `-- BACKUP COMPLETE`. psql's stderr goes to the server log.
- `parseDatabaseUrl` (exported, unit-tested with the `provision.sh` URL) takes the host from `?host=` when present and passes `sslmode` on.
- The route waits for psql's first output: a dump that fails before that answers 502 with an error, which the Event page shows. A later failure writes the `-- BACKUP FAILED` line and aborts the transfer. psql's stdout is piped with backpressure, and psql is killed when the response closes early. The page now calls `/api/backup/event` (the `/competition` alias stays for one release).
- A committed restore, `pnpm event:restore <file> [--replace]` (`packages/api/src/restore.ts`, `src/cli/restore-event.ts`). It loads each section through a header-built temp table so columns match by name, rewrites `event_id`, keeps the other ids and moves serial sequences past them, and handles a reference to a user or group the target lacks as the foreign key's `ON DELETE` action would. It reuses the existing map, GPS track and seq-counter scripts. It refuses a failed or cut-short dump, and an event that already exists unless `--replace` is given. An integration test dumps an event with readouts, cards, runners, punches, units, a course variant, templates, course maps, the journal, a logo, permissions and a map, deletes it, restores it and compares every row.
- `docker-compose.venue.yml` and `docker-compose.release.yml` run a `backup` service (`docker/pg-backup.sh`): a custom-format `pg_dump` of the oxygen schema every 15 minutes into `./backups` (or `BACKUP_DIR`), keeping 48.
- `scripts/gcp/provision.sh` creates the Cloud SQL instance with point-in-time recovery and 7 days of transaction logs. Turning it on for an existing instance restarts it, so that is a manual step between events ([deploy-gcp-cloud-run.md](../ops/deploy-gcp-cloud-run.md) "Backups and restore").

What was left out is in [backup-restore-followups.md](backup-restore-followups.md).
