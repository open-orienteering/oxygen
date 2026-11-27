-- Where a course's stored climb comes from (docs/course-elevation.md §6).
-- 'manual': typed (Courses page); 'file': an imported file stated it;
-- 'computed': Oxygen computed it from the map's height field along the
-- course (cleared by every re-derivation of the course's geometry and
-- written again after it). NULL: no climb — or a climb written before
-- this column or by an older image, which readers treat as typed
-- (NULL with climb_m <> 0), so a computed value never replaces it.
-- Additive: a nullable column an older image never reads. It is stripped
-- from `course.upserted` payloads like `length_source` (it travels with
-- the checkout snapshot), so the journal is unchanged.
ALTER TABLE "oxygen"."courses" ADD COLUMN "climb_source" TEXT;
ALTER TABLE "oxygen"."courses"
  ADD CONSTRAINT "courses_climb_source_check" CHECK ("climb_source" IS NULL OR "climb_source" IN ('manual', 'file', 'computed'));
-- Every climb stored so far was typed or imported (idempotent).
UPDATE "oxygen"."courses" SET "climb_source" = 'manual' WHERE "climb_m" <> 0 AND "climb_source" IS NULL;
