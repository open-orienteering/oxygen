-- Where a course object came from (slice D, row D1; docs/course-layer.md
-- §6.4). 'import' marks the 707 / 708 / 709 / 711 objects `course.importCourses`
-- and the structure backfill wrote, so a re-import replaces exactly those
-- and never an object drawn in the editor (NULL). Not on the wire.
-- Additive: a nullable column an older image never reads.
ALTER TABLE "oxygen"."course_objects" ADD COLUMN "source" TEXT;
ALTER TABLE "oxygen"."course_objects"
  ADD CONSTRAINT "course_objects_source_check" CHECK ("source" IS NULL OR "source" IN ('import'));
