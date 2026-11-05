-- Course structure, site fields and version tokens (slice D, row D0;
-- docs/course-layer.md §6 "Structure", §7 "Concurrency"; research 08 §4.2,
-- §4.3, §4.8). Additive: an older image ignores every new column.

-- What a site is (08 §4.2). Replaces inferring start / finish from
-- `status`; the two are kept in sync for one release (the API writes both).
-- map_exchange / crossing_point / map_issue are typed now, written in slice F.
CREATE TYPE "oxygen"."control_kind" AS ENUM
  ('control', 'start', 'finish', 'map_exchange', 'crossing_point', 'map_issue');

ALTER TABLE "oxygen"."controls"
  ADD COLUMN IF NOT EXISTS "kind" "oxygen"."control_kind" NOT NULL DEFAULT 'control',
  -- Manual circle gaps, compass degrees: [{ "start", "end" }].
  ADD COLUMN IF NOT EXISTS "circle_gaps" JSONB,
  ADD COLUMN IF NOT EXISTS "notes" TEXT NOT NULL DEFAULT '',
  -- Field-mode check-off (control.check). `checked_by` is the user id,
  -- deliberately without a foreign key (like journal.actor_id): the row is
  -- journaled and applied on nodes that have no users table rows.
  ADD COLUMN IF NOT EXISTS "checked_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "checked_by" UUID,
  -- Optimistic-concurrency token: the HLC of the control.upserted entry
  -- that last wrote the row; 0 for rows written before this migration.
  ADD COLUMN IF NOT EXISTS "version" BIGINT NOT NULL DEFAULT 0;

UPDATE "oxygen"."controls" SET "kind" = 'start' WHERE "status" = 'start';
UPDATE "oxygen"."controls" SET "kind" = 'finish' WHERE "status" = 'finish';

ALTER TABLE "oxygen"."courses"
  -- 08 §4.3 structure (CourseStructure v1); NULL until written by
  -- course.setStructure / course.update / an importer or the D1 backfill.
  ADD COLUMN IF NOT EXISTS "structure" JSONB,
  -- Token as on controls, from course.upserted entries that write the course.
  ADD COLUMN IF NOT EXISTS "version" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "oxygen"."course_controls"
  ADD COLUMN IF NOT EXISTS "number_hidden" BOOLEAN NOT NULL DEFAULT false;

-- Controller capability (SLICES.md slice D, decision (4)): control.check
-- and a control's notes. Granted to the Course setter and Event admin
-- system groups.
UPDATE "oxygen"."permission_groups"
   SET "capabilities" = "capabilities" || '["courses.review"]'::jsonb
 WHERE "id" IN ('01990e00-0000-7000-8000-000000000001', '01990e00-0000-7000-8000-000000000002')
   AND NOT ("capabilities" ? 'courses.review');
