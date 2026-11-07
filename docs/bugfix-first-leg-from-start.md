# Bugfix: no pending leg from a just-placed start

**Reported:** 2026-11-07 (feedback after slice P, item 2; row P5).
**Area:** course editor, the map viewer's course list
(`packages/web/src/components/MapPanel.tsx`, `courseOverlays`).

## What happened

After placing a start with `S` the editor goes on with `K` from it
(`docs/course-editor.md` §6.1). Moving the pointer showed the length of
the first leg beside the cursor, but no line was drawn from the start.
Once the first control was placed the line appeared, and the pending leg
to the second control was drawn as it should be.

The pending leg is drawn by the course layer: the page hands the viewer a
provisional visit and `spliceProvisional` (`lib/course-layer-request.ts`)
inserts it into the course's id list, so the layer draws the legs into
and out of the cursor. That list comes from `MapPanel`'s `courseOverlays`
memo, which built it from `course.list`'s `controls` (the controls
between start and finish only) and then:

- prepended a start and appended a finish **only when the course had
  controls**, and
- picked **the start nearest the first control** (and the finish nearest
  the last), not the course's own `startControlId` / `finishControlId`.

A course with only a start therefore reached the layer as `[]`; with the
provisional visit spliced in it was `[provisional]`, a single site with no
leg. The length label is the UI layer's (`placement.ts` measures from the
chain's anchor, the start just placed) and does not read the overlay, so
it showed regardless. The same happened on a fresh course (no controls,
the event's default start) on the first `K` hover.

## The fix

A pure helper, `packages/web/src/lib/course-overlay-ids.ts`
(`courseOverlayIds`), builds each course's list: start?, controls,
finish?, whatever the control count. Each end is the course's explicit
`startControlId` / `finishControlId` when it names a live control of
that role; otherwise, for a legacy course with controls, the one nearest
its first (last) positioned control, as before; otherwise the event
default of `docs/course-layer.md` §6.2 (lowest id, the same
`effectiveRoleControlId` the inspector's rows use). `firstAsStart` /
`lastAsFinish` courses get no start / finish added, and an end already at
the head / tail of the controls is not repeated. `courseOverlays` calls
it; the rest of the overlay is unchanged. No API change.

Side effect: a course with no controls is now drawn with its start and
finish (one leg between them), as the inspector, print and export already
read it.

## How it is tested

- `packages/web/src/lib/__tests__/course-overlay-ids.test.ts`: a
  start-only course lists its start (the regression), a finish-only one
  its finish, explicit ends win over the nearest, the legacy nearest
  fallback, the event default without controls, stale or wrong-role ids,
  the `firstAsStart` / `lastAsFinish` flags, no duplicate ends.
- `e2e/course-editor.spec.ts` "P5: the pending leg from a just-placed
  start": on a fresh course the `K` hover draws a `course-leg` piece from
  the default start; `S` places a start and arms `K`; the hover shows
  `editor-leg-length` and a `course-leg` piece from the new start to the
  cursor; after the click and `Esc` the leg start → control stays. Run
  against the old memo, both leg assertions fail while the label passes.
