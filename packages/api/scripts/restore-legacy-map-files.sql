-- Restore the map_files section of a per-event dump written before v0.6.1
-- (docs/backup-restore.md "Dumps from before v0.6.1", docs/map-storage.md
-- §7.3). Such a section carries the map's bytes in `file_data` (and, from
-- slice A on, `source_hash`), a column v0.6.1 dropped (E5); a dump from
-- before the vector pipeline has no hashes at all. This script makes each
-- row's bytes a content-addressed `map_sources` row and inserts the
-- event's `map_files` row pinning it. A row whose document the dump also
-- carried (restored by restore-map-blobs.sql first) keeps it; any other
-- is imported by `pnpm map:rematch --event <name_id>` afterwards, which
-- imports every sourced row still without a document (§6.9). It replaces
-- the retired `pnpm map:backfill` for old dumps.
--
--   cd <dir with the dump split into <table>.csv files>
--   psql "$DATABASE_URL" -v event_id=<new id> -f <repo>/packages/api/scripts/restore-legacy-map-files.sql
--
-- The section's columns differ between releases, so the temp table is
-- built from the CSV's own header row (read with `head`, so psql needs a
-- POSIX shell). Idempotent: sources are inserted ON CONFLICT DO NOTHING
-- and a map_files row already present for the event (same upload time and
-- source) is skipped.

\set ON_ERROR_STOP on
-- ADD COLUMN IF NOT EXISTS notices for columns the dump already has.
SET client_min_messages = warning;
\if :{?event_id}
\else
  \echo 'restore-legacy-map-files.sql needs -v event_id=<the restored event''s id>'
  \quit
\endif

\set header `head -n 1 map_files.csv`

BEGIN;

SELECT set_config('oxygen.restore_header', :'header', true);

-- Every column of the dump's header, in its order, as text.
DO $$
DECLARE
  cols TEXT[] := string_to_array(trim(both E'\r' from current_setting('oxygen.restore_header')), ',');
BEGIN
  IF NOT ('file_data' = ANY (cols)) THEN
    RAISE EXCEPTION 'map_files.csv has no file_data column: a v0.6.1 or later dump, restore it with restore-map-blobs.sql';
  END IF;
  EXECUTE format('CREATE TEMP TABLE restore_legacy_map_files (%s) ON COMMIT DROP',
                 (SELECT string_agg(format('%I text', x), ', ') FROM unnest(cols) AS x));
END $$;

\copy restore_legacy_map_files FROM 'map_files.csv' WITH (FORMAT csv, HEADER true)

-- The columns this script reads that the dump's release did not have yet, as NULLs.
DO $$
DECLARE
  c TEXT;
BEGIN
  FOREACH c IN ARRAY ARRAY['file_name', 'uploaded_at', 'scale', 'bounds', 'north_offset', 'calibration',
                           'rotation_correction', 'north_detection', 'from_club_library', 'source_hash',
                           'document_hash', 'club_map_version_id'] LOOP
    EXECUTE format('ALTER TABLE restore_legacy_map_files ADD COLUMN IF NOT EXISTS %I text', c);
  END LOOP;
END $$;

-- bytea travels as `\x` hex in the dump.
CREATE TEMP TABLE restore_legacy_rows ON COMMIT DROP AS
SELECT r.*, b.bytes, encode(sha256(b.bytes), 'hex') AS computed_hash
FROM restore_legacy_map_files r
CROSS JOIN LATERAL (SELECT decode(substr(r.file_data, 3), 'hex') AS bytes) b;

-- A slice-A-or-later row names its source: the bytes must be those.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM restore_legacy_rows WHERE source_hash IS NOT NULL AND source_hash <> computed_hash) THEN
    RAISE EXCEPTION 'map_files: a row''s file_data does not match its source_hash';
  END IF;
END $$;

-- The source rows. The kind is sniffed as the upload route does (OCAD
-- magic, else a Mapper XML file).
INSERT INTO oxygen.map_sources (file_hash, kind, bytes, size_bytes, file_name, uploaded_by, created_at)
SELECT DISTINCT ON (computed_hash)
       computed_hash,
       CASE WHEN octet_length(bytes) >= 2 AND get_byte(bytes, 0) = 173 AND get_byte(bytes, 1) = 12 THEN 'ocad' ELSE 'omap' END,
       bytes, octet_length(bytes), file_name, NULL, now()
FROM restore_legacy_rows
ORDER BY computed_hash, uploaded_at
ON CONFLICT (file_hash) DO NOTHING;

-- The event's rows: the dump's quick-access columns, the source just
-- stored, its document when this database holds it for that source, the
-- club library version only when it exists here.
INSERT INTO oxygen.map_files (event_id, file_name, uploaded_at, scale, bounds, north_offset, calibration,
                              rotation_correction, north_detection, from_club_library,
                              source_hash, document_hash, club_map_version_id)
SELECT :event_id, coalesce(r.file_name, ''), coalesce(r.uploaded_at::timestamptz, now()), r.scale::double precision,
       r.bounds::jsonb, r.north_offset::double precision, r.calibration::jsonb,
       coalesce(r.rotation_correction::double precision, 0), r.north_detection::jsonb,
       coalesce(r.from_club_library::boolean, false),
       r.computed_hash,
       (SELECT d.hash FROM oxygen.map_documents d WHERE d.hash = r.document_hash AND d.source_hash = r.computed_hash),
       (SELECT v.id FROM oxygen.club_map_versions v WHERE v.id::text = r.club_map_version_id)
FROM restore_legacy_rows r
WHERE NOT EXISTS (
  SELECT 1 FROM oxygen.map_files m
  WHERE m.event_id = :event_id
    AND m.uploaded_at = coalesce(r.uploaded_at::timestamptz, m.uploaded_at)
    AND m.source_hash = r.computed_hash
);

COMMIT;
