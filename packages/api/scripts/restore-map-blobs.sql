-- Restore the map sections of a per-event dump (docs/backup-restore.md,
-- docs/map-storage.md §7.3). Idempotent: blobs are content-addressed and
-- inserted ON CONFLICT DO NOTHING, map_files rows already present for the
-- event are skipped, so running it twice changes nothing.
--
--   cd <dir with the dump split into <table>.csv files>
--   psql "$DATABASE_URL" [-v event_id=<new id>] -f <repo>/packages/api/scripts/restore-map-blobs.sql
--
-- Reads map_sources.csv and map_documents.csv from the current directory,
-- and with event_id also map_files.csv. Each file is one section of the
-- dump (the lines after `--- <table> ---`, header row included); a
-- header-only section is fine. (\copy takes its file name literally, so
-- the names are fixed rather than psql variables.)

\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE restore_map_sources (LIKE oxygen.map_sources) ON COMMIT DROP;
\copy restore_map_sources FROM 'map_sources.csv' WITH (FORMAT csv, HEADER true)

CREATE TEMP TABLE restore_map_documents (LIKE oxygen.map_documents) ON COMMIT DROP;
\copy restore_map_documents FROM 'map_documents.csv' WITH (FORMAT csv, HEADER true)

-- The hash is the row's identity: refuse bytes that do not match it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM restore_map_sources
             WHERE encode(sha256(bytes), 'hex') <> file_hash OR octet_length(bytes) <> size_bytes) THEN
    RAISE EXCEPTION 'map_sources: a row''s bytes do not match its file_hash or size_bytes';
  END IF;
  IF EXISTS (SELECT 1 FROM restore_map_documents
             WHERE encode(sha256(bytes), 'hex') <> hash OR octet_length(bytes) <> size_bytes) THEN
    RAISE EXCEPTION 'map_documents: a row''s bytes do not match its hash or size_bytes';
  END IF;
END $$;

-- created_at / last_referenced_at restart at the restore: the GC grace
-- (map-storage.md §8) counts from when this database first held the row.
INSERT INTO oxygen.map_sources (file_hash, kind, bytes, size_bytes, file_name, uploaded_by, created_at)
SELECT r.file_hash, r.kind, r.bytes, r.size_bytes, r.file_name,
       (SELECT u.id FROM oxygen.users u WHERE u.id = r.uploaded_by), now()
FROM restore_map_sources r
ON CONFLICT (file_hash) DO NOTHING;

INSERT INTO oxygen.map_documents (hash, bytes, size_bytes, format_version, importer_version, library_version,
                                  source_hash, header, report, created_at, last_referenced_at)
SELECT r.hash, r.bytes, r.size_bytes, r.format_version, r.importer_version, r.library_version,
       r.source_hash, r.header, r.report, now(), now()
FROM restore_map_documents r
ON CONFLICT (hash) DO NOTHING;

\if :{?event_id}
CREATE TEMP TABLE restore_map_files (LIKE oxygen.map_files) ON COMMIT DROP;
\copy restore_map_files FROM 'map_files.csv' WITH (FORMAT csv, HEADER true)

-- A fresh id from the target's sequence, the new event id, and the club
-- library version only when it exists here (it is SET NULL on delete too).
INSERT INTO oxygen.map_files (event_id, file_name, file_data, uploaded_at, scale, bounds, north_offset, calibration,
                              rotation_correction, north_detection, from_club_library, color_profile, color_overrides,
                              north_lines_below, file_hash, render_key, source_hash, document_hash, club_map_version_id)
SELECT :event_id, r.file_name, r.file_data, r.uploaded_at, r.scale, r.bounds, r.north_offset, r.calibration,
       r.rotation_correction, r.north_detection, r.from_club_library, r.color_profile, r.color_overrides,
       r.north_lines_below, r.file_hash, r.render_key, r.source_hash, r.document_hash,
       (SELECT v.id FROM oxygen.club_map_versions v WHERE v.id = r.club_map_version_id)
FROM restore_map_files r
WHERE NOT EXISTS (
  SELECT 1 FROM oxygen.map_files m
  WHERE m.event_id = :event_id AND m.uploaded_at = r.uploaded_at AND m.file_hash IS NOT DISTINCT FROM r.file_hash
);
\endif

COMMIT;
