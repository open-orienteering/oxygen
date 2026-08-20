# Bugfix: deleting a control left ghost references in courses

## Symptoms

Deleting a control that was part of a course (course editor, contextual
**Delete**) looked successful — the circle disappeared — but the course
kept limping along with a dead reference:

- The course route still ran **via the deleted position**, with no
  control circle at the bend.
- The **description sheet** still listed the control's row, but with no
  symbols (the overlay row was gone, so nothing resolved).
- The in-map sequence panel showed the ghost entry — sometimes as a raw
  id that collided with another control's code, so the same number
  appeared **twice** in the list.
- Trying to remove the ghost from the sequence failed with
  *"Control N not found"*.

## Cause

`control.delete` was a bare soft delete:

```ts
await tx.control.update({ where: { id }, data: { removed: true } });
```

The `course_controls` rows pointing at the control survived, and the
stored course geometry (built earlier, when the control was alive) was
never rebuilt. Everything that renders a course — route legs,
description sheet, sequence panel — walked the stale sequence and hit a
control that no longer resolves.

The removal error came from `course.update`, which (correctly) resolves
the submitted control ids against **active** controls only: the ghost id
404s, so the sequence edit that would have cleaned it up was rejected.

## Fix

`control.delete` now cascades inside the same transaction
(`packages/api/src/routers/control.ts`):

1. Compute the dependent course ids **before** marking the control
   removed (the start/finish lowest-seq default must see the pre-delete
   world) — via `courseIdsUsingControl()`, the same helper
   `control.update` uses for position moves (`course_controls` visits
   plus startName / finishControlId / default-role references).
2. Soft-delete the control.
3. `deleteMany` its `course_controls` rows.
4. `rebuildCourseGeometry` + `emitCourseUpserted` for the affected
   courses.

Client side (`CourseEditorPage.handleDelete`), the undo entry now
captures the sequences of every course that visited the control and
replays them after `control.restore` — otherwise undo would bring the
control back but not its course memberships.

The same change added the missing contextual action: a control that is
in the selected course now offers **Remove from &lt;course&gt;**
(membership only, the control survives) next to Add / Edit description /
Delete.

## Tests

- Integration (`integration/control-editor.test.ts`): *deleting a
  control cascades it out of course sequences and rebuilds geometry* —
  sequence string, geometry points/legs, and a follow-up `course.update`
  (the previously-404ing path).
- E2E (`e2e/course-editor.spec.ts`): *deleting a control in a course
  cascades out of the sequence; remove-from-course action* — sequence
  row disappears with the control, undo restores control **and**
  membership, and the remove-from-course action drops the row while the
  control stays on the map.
