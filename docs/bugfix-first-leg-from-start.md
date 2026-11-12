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
its first (last) control when that one is positioned, as before; otherwise the event
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

## Found on the way (fixed in F32)

A control's public id is its first punch code, else its `seq`
(`packages/api/src/control-id.ts`). Starts and finishes used to be
code-less, so a start placed with `S` was addressed by its seq, and
`control.create` did not check that seq against the codes already in use.
Once an event's seq reached a punch code (in a full E2E run of
`course-editor.spec.ts` the new start got seq 80 beside the seed control
coded 80), two controls shared one public id. The web then saw two
`editor-site`s keyed `80` (React's duplicate-key warning), the course read
the start as control 80, and a reuse or a filter could hit the wrong
control. The P5 describe reseeds in its `beforeAll` so it doesn't depend
on how many controls earlier tests created.

**Fixed in F32** (`docs/course-layer.md` §6.3 "Starts and finishes take a
code", decision log `decisions/slice-f.md` 2026-11-12). The fix follows
the user: a start or finish is a physical unit programmed with a code, so
it gets one. `control.create` for a start or finish without codes stores
the lowest free code in 3–10, then 11–30 (1 is clear, 2 normally check),
and refuses when 3–30 are all used; "free" also excludes the seq of any
code-less row still addressed by its seq, and the duplicate check refuses
such a seq as a new code. A kind change to start / finish and the course
import allocate the same way. The new start's public id is its code, so it
can no longer meet a control's. Labels, sheets and the IOF / Purple Pen
export keep showing the start by its name ("Start 1"). No migration:
existing code-less starts and finishes are left as they are (user
decision) and keep the seq fallback. Tests:
`packages/api/src/__tests__/integration/start-finish-codes.test.ts` (the
seq counter at 80 beside a control coded 80; the new start takes 3 and
every id is unique), `packages/api/src/__tests__/control-id.test.ts`, and
ids 3 / 4 / 5 plus unique `editor-site` ids in
`e2e/editor-start-finish.spec.ts`.
