-- Where a course's stored length comes from (slice E, row E6;
-- docs/course-controls-and-matching.md "Course length"). 'file': the
-- length an imported OCD / IOF / Purple Pen file published (Eventor's
-- start list may overwrite it); 'derived': the course was edited in
-- Oxygen, so its length is derived from the controls' positions (export
-- recomputes it, Eventor does not overwrite it). NULL: neither (no
-- positioned control, or a course without geometry written before E6).
-- It replaces what `geometry_source = 'editor'` meant to the export and
-- the Eventor sync, so `courses.geometry` / `geometry_source` can be
-- dropped in E5. Written beside `geometry_source` until then.
-- Additive: a nullable column an older image never reads. It is stripped
-- from `course.upserted` payloads like `geometry_source` (it travels with
-- the checkout snapshot), so the journal is unchanged.
ALTER TABLE "oxygen"."courses" ADD COLUMN "length_source" TEXT;
ALTER TABLE "oxygen"."courses"
  ADD CONSTRAINT "courses_length_source_check" CHECK ("length_source" IS NULL OR "length_source" IN ('file', 'derived'));
-- Backfill 1:1 from geometry_source (idempotent).
UPDATE "oxygen"."courses" SET "length_source" = CASE "geometry_source"
  WHEN 'editor' THEN 'derived'
  WHEN 'ocd' THEN 'file'
  WHEN 'xml' THEN 'file'
  ELSE NULL
END;
