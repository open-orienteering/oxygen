-- Persist parsed OCAD metadata on map_files so course.mapMetadata is a
-- plain row read instead of a per-query OCAD parse (multi-second on real
-- club maps). Null on legacy rows; backfilled lazily on first read.
ALTER TABLE "oxygen"."map_files"
  ADD COLUMN "scale" DOUBLE PRECISION,
  ADD COLUMN "bounds" JSONB,
  ADD COLUMN "north_offset" DOUBLE PRECISION,
  ADD COLUMN "calibration" JSONB;
