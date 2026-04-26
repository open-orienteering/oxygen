# Database Backup & Restore

Oxygen ships with a one-click backup of the currently selected competition database, exposed on the **Event** page as a **Download backup** button. The endpoint streams a `mysqldump` directly to the browser; nothing is stored on the server.

## What gets backed up

A single competition database — every `o*` (MeOS) and `oxygen_*` (Oxygen-specific) table, with both schema and data. The backup also captures the metadata of the competition's row in the registry (`MeOSMain.oEvent`), but **only as a commented header**. The MeOSMain registry itself is never modified by a backup.

What is **not** in the backup:

- Other competitions on the same server
- The `MeOSMain` database itself (club logos in `oxygen_club_db`, runner cache in `oxygen_runner_db`, remote-connection table, etc.)
- Map tile cache files outside the database

If you need a system-wide snapshot, run `mysqldump --databases MeOSMain <NameId> ...` from the host instead.

## File format

The downloaded file is a plain SQL script in `mysqldump` format, with a header block prepended by Oxygen:

```sql
-- Oxygen backup
-- Created:    2026-04-25T20:14:55.123Z
-- Database:   Vinterserien
-- Name:       Vinterserien
-- Date:       2026-03-15
-- ZeroTime:   324000
-- Version:    96
-- Annotation:
--
-- To restore:
--   1. Recreate the database (drop first if it exists):
--        mysql -e "CREATE DATABASE \`Vinterserien\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
--   2. Load the dump:
--        mysql Vinterserien < this-file.sql
--   3. Re-register in MeOSMain by uncommenting and running the INSERT below:
--
-- INSERT INTO MeOSMain.oEvent (Name, Date, NameId, Annotation, ZeroTime, Version, Removed) VALUES (...);

-- MySQL dump 10.13 ...
DROP TABLE IF EXISTS `oCard`;
CREATE TABLE `oCard` (...) ENGINE=InnoDB ...;
...
```

The filename follows the pattern `<NameId>_backup_<YYYYMMDD_HHMMSS>.sql`, matching the convention used by manual backups in this project.

If the underlying `mysqldump` exits with a non-zero status (e.g. credentials wrong, server unreachable), the stream is terminated with a `-- BACKUP FAILED (exit N): <stderr>` line so a partial download is detectable.

## Restoring a competition

```bash
# 1. Recreate the empty database
mysql -u meos -e "DROP DATABASE IF EXISTS \`Vinterserien\`;
                  CREATE DATABASE \`Vinterserien\`
                    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

# 2. Load the dump
mysql -u meos Vinterserien < Vinterserien_backup_20260425_201455.sql

# 3. Re-register the competition in MeOSMain so it shows up in the UI.
#    Open the .sql file and copy the INSERT statement from the header
#    (it's the line starting with `-- INSERT INTO MeOSMain.oEvent (...)`),
#    drop the leading `-- `, and run it against MeOSMain:
mysql -u meos MeOSMain
```

After step 3, refresh the Oxygen UI and the competition will reappear in the picker with all data intact.

### Why the registry INSERT is required

Oxygen's UI lists competitions from `MeOSMain.oEvent`. A raw restore of just the competition database recreates all the data, but `MeOSMain` is a separate database that is **not** touched by the backup file. The header INSERT exists so a restore is fully self-contained — no need to remember the exact `Name`, `Date`, `ZeroTime`, or `Version` values from before.

If the restore is meant to overlay an existing MeOSMain row (e.g. you only lost the competition data, not the registry pointer), you can skip step 3 and the row already in MeOSMain will pick up the restored database transparently.

## Security and access control

The endpoint (`GET /api/backup/competition?name=<NameId>`) is reachable to anyone who can hit the API — same access model as the other `/api/...` routes. If you expose Oxygen on a public network, place it behind your usual auth proxy.

The MySQL password (when set) is passed to `mysqldump` via the `MYSQL_PWD` environment variable rather than the command line, so it does not appear in process listings.

## Implementation

- API: `packages/api/src/backup.ts` — Fastify route handler, header construction, `mysqldump` spawning.
- Web: the `DatabaseBackup` component in `packages/web/src/pages/EventPage.tsx`.
- Docker: the `api` stage of `Dockerfile` installs `default-mysql-client` so `mysqldump` is on `PATH` in production.
- Tests: `packages/api/src/__tests__/integration/backup.test.ts` + `e2e/backup.spec.ts`.
