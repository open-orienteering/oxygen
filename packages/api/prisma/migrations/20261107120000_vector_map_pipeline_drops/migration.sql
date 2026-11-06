-- E5, the drops (v0.6.1; docs/migrations/2026-vector-map-pipeline.md).
--
-- The legacy map pipeline's storage goes: the tile and rendered-map
-- caches, the event map's OCAD bytes and colour-stack columns, the legacy
-- club library, the retired per-event pipeline switch, the overprint-cuts
-- version stamp and the course GeoJSON artifact. Every reader went in
-- v0.6.0 (rows E1–E4c, E6); v0.6.0 only kept writing them so that
-- `./deploy.sh v0.5.0` stayed a rollback.
--
-- DESTRUCTIVE and not reversible by image: v0.6.0's Prisma client selects
-- columns dropped here, so after this migration neither v0.5.0 nor v0.6.0
-- runs. The rollback is a database backup taken immediately before
-- (docs/release-slice-e.md §2). Prisma runs the file in one transaction:
-- a failed guard leaves the schema untouched.
--
-- The guard. Every map of a live event must have its bytes in
-- `map_sources` (`map_files.source_hash`), and every legacy club map must
-- belong to a `club_maps` series, or this would delete the only copy of
-- an OCAD file. The fix is the backfill on the v0.6.0 image
-- (`scripts/gcp/backfill.sh`), then deploy again. A soft-deleted event
-- (`events.removed`) is not guarded: its unsourced rows keep their file
-- name and lose their bytes (E0 found three such rows on production, all
-- of two soft-deleted test events; decided 2026-11-07, decision log).
DO $$
DECLARE
  unsourced BIGINT;
  unlinked BIGINT;
BEGIN
  SELECT count(*) INTO unsourced
    FROM "oxygen"."map_files" mf
    JOIN "oxygen"."events" e ON e."id" = mf."event_id"
   WHERE mf."source_hash" IS NULL
     AND e."removed" = false;
  IF unsourced > 0 THEN
    RAISE EXCEPTION 'E5 guard: % map_files row(s) of live events have no source_hash (their OCAD bytes would be lost); run the map backfill on the v0.6.0 image (scripts/gcp/backfill.sh), then retry', unsourced;
  END IF;

  SELECT count(*) INTO unlinked
    FROM "oxygen"."club_map_files"
   WHERE "club_map_id" IS NULL;
  IF unlinked > 0 THEN
    RAISE EXCEPTION 'E5 guard: % club_map_files row(s) have no club_map_id (the club map would be lost); run the map backfill on the v0.6.0 image (scripts/gcp/backfill.sh), then retry', unlinked;
  END IF;
END
$$;

-- Caches of the raster pipeline (517 MB of tiles on production at E0).
DROP TABLE "oxygen"."map_tiles";
DROP TABLE "oxygen"."rendered_maps";

-- The legacy club library; the series (`club_maps` / `club_map_versions`)
-- has been the authority since slice A.
DROP TABLE "oxygen"."club_map_files";

-- The event map's bytes live in `map_sources`; the colour stack and the
-- render key were the raster pipeline's.
DROP INDEX IF EXISTS "oxygen"."map_files_render_key_idx";
ALTER TABLE "oxygen"."map_files"
  DROP COLUMN "file_data",
  DROP COLUMN "render_key",
  DROP COLUMN "file_hash",
  DROP COLUMN "color_profile",
  DROP COLUMN "color_overrides",
  DROP COLUMN "north_lines_below";

-- The retired pipeline switch (E3) and the cuts version stamp of the
-- GeoJSON rebuild.
ALTER TABLE "oxygen"."events"
  DROP COLUMN "map_pipeline",
  DROP COLUMN "overprint_cuts_version";
DROP TYPE "oxygen"."map_pipeline";

-- The course GeoJSON artifact (E6 moved every reader to `structure` and
-- the course layer); `length_source` replaces what `geometry_source` told
-- the export and the Eventor sync.
ALTER TABLE "oxygen"."courses"
  DROP COLUMN "geometry",
  DROP COLUMN "geometry_source";
