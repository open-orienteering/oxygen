-- Setter maps (slice F, row F10; docs/course-layout.md §8, research 08
-- §4.6 "Setter maps"): `course_maps.kind` gains 'setter'. A setter sheet
-- belongs to the event (`course_id` NULL, `layout.setterMaps {}`) or to one
-- course (`layout.setterMaps { courseId }`); its group is
-- `props { setter, controlIds }`. Only the two CHECK constraints change:
-- `kind` is TEXT in the Prisma model, so an older image reads a setter row
-- as an unknown kind and resolves it without an overlay.
ALTER TABLE "oxygen"."course_maps" DROP CONSTRAINT "course_maps_kind_check";
ALTER TABLE "oxygen"."course_maps"
  ADD CONSTRAINT "course_maps_kind_check" CHECK ("kind" IN ('course', 'all_controls', 'setter'));
ALTER TABLE "oxygen"."course_maps" DROP CONSTRAINT "course_maps_course_kind_check";
ALTER TABLE "oxygen"."course_maps"
  ADD CONSTRAINT "course_maps_course_kind_check" CHECK (
    ("kind" = 'course' AND "course_id" IS NOT NULL)
    OR ("kind" = 'all_controls' AND "course_id" IS NULL)
    OR "kind" = 'setter'
  );
