# OCAD course scale and stale IOF export lengths

## Symptom

Courses from a 1:15,000 OCAD file were imported at roughly half their
real length. In event 55754, U4 was stored as 1,200 m while its
published length was 2,480 m. The map measure tool was substantially
closer because it used the map's real CRS scale.

## Root cause

The OCAD course parser looked for a text fragment such as `m15000`
only in the first 50 kB of the binary file:

```ts
fileData.toString("utf8", 0, 50000).match(/\bm(\d+)\b/)
```

OCAD stores the canonical map scale in parameter string type 1039.
That record can occur anywhere in a multi-megabyte file. In the
affected map it was outside the first 50 kB, so the parser silently
used its 1:7,500 fallback. The same file's CRS correctly reports
1:15,000. This exactly explains the near-halving.

The IOF CourseData exporter had a second problem: it trusted the
stored `length_m` and `legs` values. Even after the map scale or
control coordinates were correct, an old imported row stayed wrong
in every export.

## Fix

- The OCAD parser walks the string-parameter index and reads scale
  from type 1039, wherever the record lives.
- OCAD legs are attached to their destination control, matching IOF
  CourseData semantics, so import persists the start leg instead of
  dropping it and retaining a zero-length finish entry.
- Export recalculates every leg from current control coordinates and
  the current OCAD CRS scale.
- For an Oxygen-edited course (`geometry_source = 'editor'`), export
  also recalculates the total length. This is defensive; control moves
  and course-sequence edits already call `rebuildCourseGeometry` and
  update `legs` and `length_m` transactionally.
- An untouched imported course keeps its declared total length.
  OCAD/IOF may include deliberate extra distance, marked routes or
  detours around forbidden terrain that cannot be reconstructed from
  straight control-to-control coordinates. Its exported individual
  legs are still refreshed from current coordinates.
- Eventor's published length may repair an untouched imported course,
  but Eventor sync never overwrites an editor-owned course.

## Regression coverage

- `ocd-course-parser.test.ts`: parameter 1039 beyond byte 50,000 is
  parsed as 1:15,000 rather than falling back to 1:7,500.
- `integration/course-export.test.ts`: stale editor length and legs
  are recomputed at export time.
- `integration/eventor-reentry.test.ts`: Eventor can repair an
  imported course but cannot overwrite an edited one.
