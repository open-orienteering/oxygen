# Free-order courses

A course can declare that its controls may be visited in **any order**.
This is the club-requested “no specific order” mode and the foundation
for a later rogaining / score-O feature.

## Model

`courses.order_mode` is a PostgreSQL enum (`course_order_mode`):

| Value | Meaning |
|-------|---------|
| `ordered` (default) | Classic orienteering: controls must be punched in sequence |
| `free_order` | All listed controls must be punched, order does not matter |

A future `score` value is reserved for rogaining (points, time limit,
penalty) and can be added with `ALTER TYPE ... ADD VALUE` without
reshaping the table. Partial free-order *sections* inside an otherwise
ordered course are out of scope for now; `course_controls.position` still
stores a list so a per-row block column can land later.

Shared TypeScript type: `CourseOrderMode` in `@oxygen/shared`
(`"ordered" | "free_order"`). Surfaced on `CourseSummary`, `CourseDetail`,
and `CourseInfo` (dashboard / offline cache).

### Why not MeOS’s approach?

MeOS has no course-level free-order flag. It keeps every course a flat
list and pushes order into **control status**: a `Multiple` control with
codes `103 104 105` is one course slot satisfied when *all* codes are
punched in any order. Whole-course free order is done with Rogaining
point-limit mode. MeOS ignores IOF `randomOrder` entirely.

Oxygen uses a course-level enum because:

1. The same physical control can be ordered on one course and free on another.
2. Rendering (no leg lines, code labels) is course-scoped.
3. A third `score` value can add points/time-limit without changing the shape.

## Punch matching

`matchPunchesToCourse` in `packages/shared/src/readout.ts` takes an
optional `{ orderMode }` argument (default `"ordered"`).

- **ordered** — existing sequential greedy scan (unchanged).
- **free_order** — each punch claims the first unclaimed expected position
  whose codes include it. Ok matches are emitted in punch
  (chronological) order so split/cum times stay meaningful. Unclaimed
  *required* positions still raise `missingCount` → Missing Punch.
  `skipMatching` / `noTimingLeg` behave as before.

Wired through `cardReadout` (kiosk + apply), `lists` result times,
Eventor results upload, the competition dashboard `CourseInfo`, and the
offline local readout.

## Map and description sheet

For `free_order` courses:

| Surface | Behaviour |
|---------|-----------|
| On-screen map (`MapViewer`) | No connecting leg lines (geometry or fallback); labels show punch codes, not 1,2,3… |
| Print / PDF (`resolve-layout` + `renderCourseOverlaySvg`) | Same: legs filtered, `labelMode: "code"` |
| Description sheet | Control rows omit the A-column sequence number; thick rules still every third control row |
| Course editor geometry | `buildEditorGeometry(..., "free_order")` emits points only; auto length/legs left alone |
| Manual number offsets | Draggable in the editor and honoured in print for both modes — the offset is stored on `course_controls.label_dx/dy`, so it needs a selected course. There is no per-control slot for the all-controls view |

Marked routes / forbidden / restricted lines from OCD are kept.

## UI

- **Courses page** — create form and detail edit have an Order select;
  free-order courses show an amber badge in the list; bulk update can set
  the mode.
- **Course editor** — Visit order select next to the finish variant;
  free-order hides ↑/↓ reorder, leg metres, and total length; sequence
  column shows `•` instead of 1,2,3…

## IOF XML 3.0

| Direction | Behaviour |
|-----------|-----------|
| Export | Every Control-type `CourseControl` gets `randomOrder="true"`; `LegLength` omitted |
| Import | If **every** Control-type row has `randomOrder="true"` → `orderMode = free_order`. Partial runs stay ordered (documented limitation). Connecting legs are stripped from stored geometry |

This matches Purple Pen’s Score course export and Condes’s random-order
segment convention when the whole course is free. MeOS will ignore
`randomOrder` on import (as it does today).

## Rogaining roadmap

Hooks already in place:

- Enum can grow a `score` value.
- `course_controls` rows can later carry points / block ids.
- Matcher branch point is centralised in `matchPunchesToCourse`.

Still out of scope: per-control points, time limit + penalty, point-limit
“N of M”, Purple Pen `kind="score"` import, MeOS Multiple / Rogaining
control statuses.
