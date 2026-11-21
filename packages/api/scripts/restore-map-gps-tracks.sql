-- Restore the GPS tracks section of a per-event dump (docs/map-gps-tracks.md
-- §1.3, docs/map-storage.md §7.3, docs/ops/backup-restore.md) into the event
-- `event_id`. Rows keep their id, points, trim, ranges and token;
-- `created_by` is kept only when that user exists in this database, so a
-- dump restores into another instance. Idempotent: a row whose id is
-- already present is skipped, so running it twice changes nothing.
--
--   cd <dir with the dump split into <table>.csv files>
--   psql "$DATABASE_URL" -v event_id=<new id> -f <repo>/packages/api/scripts/restore-map-gps-tracks.sql
--
-- Reads map_gps_tracks.csv (the lines after `--- map_gps_tracks ---`,
-- header row included; a header-only section is fine). A dump written
-- before G24 has no such section and needs no step.

\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE restore_map_gps_tracks (LIKE oxygen.map_gps_tracks) ON COMMIT DROP;
\copy restore_map_gps_tracks FROM 'map_gps_tracks.csv' WITH (FORMAT csv, HEADER true)

INSERT INTO oxygen.map_gps_tracks (id, event_id, name, source_name, points, point_count, recorded_at,
                                   trim_start, trim_end, derived_from, single_pass, converted_op,
                                   created_by, created_at, version)
SELECT r.id, :event_id, r.name, r.source_name, r.points, r.point_count, r.recorded_at,
       r.trim_start, r.trim_end, r.derived_from, r.single_pass, r.converted_op,
       (SELECT u.id FROM oxygen.users u WHERE u.id = r.created_by), r.created_at, r.version
FROM restore_map_gps_tracks r
ON CONFLICT (id) DO NOTHING;

COMMIT;
