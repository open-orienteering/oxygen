-- Materialised course variants (slice F, row F6; docs/course-layer.md §12,
-- research 08 §4.3 "Materialisation", §4.8). A course whose structure has
-- variation groups (the root) gets one child `courses` row per variant:
-- `parent_course_id` names the root, `variant_key` the variant ("AC",
-- "BA"). A child is an ordinary course for every reader (timing, results,
-- export, print); only the Courses page nests it and the writes refuse it.
-- A variant that disappears is soft-deleted (`removed`) and revived by key
-- when it returns, hence the unique pair (NULLs are distinct in Postgres,
-- so ordinary courses never collide).
-- Additive: two nullable columns an older image never reads.
ALTER TABLE "oxygen"."courses" ADD COLUMN "parent_course_id" UUID;
ALTER TABLE "oxygen"."courses" ADD COLUMN "variant_key" TEXT;
ALTER TABLE "oxygen"."courses"
  ADD CONSTRAINT "courses_parent_course_id_fkey" FOREIGN KEY ("parent_course_id")
  REFERENCES "oxygen"."courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "oxygen"."courses"
  ADD CONSTRAINT "courses_variant_key_check" CHECK (("parent_course_id" IS NULL) = ("variant_key" IS NULL));
CREATE UNIQUE INDEX "courses_parent_course_id_variant_key_key" ON "oxygen"."courses"("parent_course_id", "variant_key");
CREATE INDEX "courses_parent_course_id_idx" ON "oxygen"."courses"("parent_course_id");
