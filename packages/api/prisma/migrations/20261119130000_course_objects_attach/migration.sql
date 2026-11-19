-- J10: a course object attached to a control (docs/course-layer.md §8.1 "Attachment"):
-- { "controlId": <controls.id uuid>, "at": { "x", "y" } }, NULL when unattached. Additive
-- and nullable, no foreign key (as `scope`): a deleted control leaves the object detached.
ALTER TABLE "oxygen"."course_objects" ADD COLUMN "attach" JSONB;
