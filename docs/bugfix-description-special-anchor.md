# Bugfix: a special instruction after a control was missing from the print

Found by the E3b session (2026-11-06) while adding the description
instructions to the course editor.

## What happened

`courses.description_instructions` anchors a special-instruction row
(13.x) after a control by its **public control id** — the first punch
code, falling back to the seq (`CourseDescriptionInstructions` in
`packages/shared/src/types.ts`). The on-map description sheet
(`MapViewer` → `buildDescriptionSheet`) and the pruning in
`course.update` / `course.setStructure` use that id. The print path did
not: `resolveMapLayout` (`packages/api/src/course-maps/resolve-layout.ts`)
handed `buildDescriptionSheet` each control's `seq` as its id, so a row
stored as "after 31" matched only a control whose seq happened to be 31.
On a real event (codes 31…, seqs 1…) such a row showed on the screen and
was silently left off Layout mode's block (`courseMap.resolveSheet`) and
the printed sheet (`maps.pdf`). Rows after the start and the finish
variant were not affected.

The unit test encoded the bug: its fixture anchored the special at `1`,
the seq of the control with code 31.

## Fix

`resolveMapLayout` passes the public id —
`firstCode(codes) || seq` (`control-id.ts`) — as `buildDescriptionSheet`'s
control id, the id space every other reader uses.

## Tests

- `packages/api/src/__tests__/course-map-layout.test.ts`: the special is
  anchored at `31` (the code; the control's seq is 1) and printed after it.
- `packages/api/src/__tests__/integration/course-maps.test.ts`: a special
  written through `course.update` after control 31 is in
  `courseMap.resolveSheet`'s block and in `courseMap.list`'s print rows.
- `e2e/course-editor.spec.ts` "description instructions": a special
  anchored in the editor's inspector after a fixture control is in
  `resolveSheet`'s block after that control.
