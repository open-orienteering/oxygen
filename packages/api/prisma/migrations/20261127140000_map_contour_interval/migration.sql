-- The contour interval of a map, confirmed by a person (docs/course-elevation.md §0.43, review package 23).
-- NULL = not confirmed: the contour field is derived at the scale guess and a climb on it is an estimate that is not stored.
-- A club map's value follows every event that uses it; an event's own map file carries its own (the venue box reads that one).
ALTER TABLE "oxygen"."club_maps" ADD COLUMN "contour_interval_m" DOUBLE PRECISION;
ALTER TABLE "oxygen"."club_maps" ADD CONSTRAINT "club_maps_contour_interval_check"
  CHECK ("contour_interval_m" IS NULL OR ("contour_interval_m" > 0 AND "contour_interval_m" <= 100));
ALTER TABLE "oxygen"."map_files" ADD COLUMN "contour_interval_m" DOUBLE PRECISION;
ALTER TABLE "oxygen"."map_files" ADD CONSTRAINT "map_files_contour_interval_check"
  CHECK ("contour_interval_m" IS NULL OR ("contour_interval_m" > 0 AND "contour_interval_m" <= 100));

-- Climbs computed before the interval could be confirmed (only a database that ran the course elevation branch before
-- this migration has any): cleared; a ground-model climb is written again at the course's next edit or opening.
UPDATE "oxygen"."courses" SET "climb_m" = 0, "climb_source" = NULL WHERE "climb_source" = 'computed';
