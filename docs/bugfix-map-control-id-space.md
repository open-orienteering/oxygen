# Bugfix: Map control circles vanish when a selection is active

## Symptom

With no selection, the competition map drew every control circle and code
label correctly. As soon as a class, course, or control was selected on any
page (Classes, Courses, Controls, Dashboard class filter), all control
circles and code labels disappeared — only the course leg lines kept
rendering.

## Root cause: three ID spaces pretending to be one

`MapPanel` builds its control overlays from `course.controlCoordinates` and
decides visibility by comparing ids coming from three different endpoints:

| Source | What it returned |
|--------|------------------|
| `course.controlCoordinates` → `id` | **`seq`** (per-event sequence number) |
| `course.list` → per-course `controls` string (`"31;45;60"`) | **first punch code** per control |
| `control.list` → row `id` (what the Controls page passes as `highlightControlId(s)`) | **public control id** = first punch code, `seq` fallback |

The "show only relevant" filter (on by default whenever a selection exists)
does set-membership checks across these:

```255:264:packages/web/src/components/MapPanel.tsx
      if (showOnlyRelevant) {
        if (filterMode === "course" && courseControlIds.size > 0) {
          visible = courseControlIds.has(id) || c.status === 4 || c.status === 5;
          // Extra punch controls are not in the course but should still be visible
          if (!visible && punchStatusByCode?.[c.code] === "extra") visible = true;
        } else if (filterMode === "single-control" && effectiveControlIds.size > 0) {
          // Keep start/finish visible so the map still has useful anchor points
          // when the user is just inspecting a handful of regular controls.
          visible = effectiveControlIds.has(c.id) || c.status === 4 || c.status === 5;
        }
      }
```

`courseControlIds` holds punch codes; `effectiveControlIds` holds public
control ids (codes). But `c.id` was `seq`. On any event whose controls were
created through the `allocate_event_seq()` trigger — every Eventor import,
every OCD/XML course import — `seq` is `1, 2, 3…` while codes are `31+`, so
**no control ever matched and everything except start/finish got
`visible: false`**. Course leg lines draw from the course GeoJSON
(`course.courseGeometries`) and never consult this filter, hence
"lines yes, circles no".

The mismatch was invisible in the seed/migrated events used by the E2E
suite because the legacy MeOS convention set `Id == code`, making
`seq == code` hold by accident.

Two more things were broken by the same mismatch:

- **Map → Controls page navigation**: clicking a control on the dashboard
  map navigates to `controls?control=<id>`. It passed `seq`, but the
  Controls page keys rows by public control id, so the wrong (or no) row
  expanded.
- **Fallback leg renderer**: for highlighted courses without stored
  geometry, `MapPanel` resolves the `course.list` tokens (codes) against a
  position map keyed by overlay id (seq) — so those legs silently never
  drew either.

## Fix

Standardize on the **public control id** (first punch code, `seq`
fallback — the same convention as `control.list` / `control.detail`, see
`AGENTS.md` §15.5) at the API boundary:

- `course.controlCoordinates` now returns `id = publicControlId(control)`.
- `course.controlCompletionStatus` now returns `controlId` in the same
  space so MapPanel's completion-ring join keeps working.
- `publicControlId()` is exported from
  `packages/api/src/routers/control.ts` and shared by both routers.

No web-side changes were needed: every MapPanel/MapViewer comparison
becomes consistent once the overlay ids are in code space.

### Bonus fix: cross-event leak in `controlCompletionStatus`

While writing the regression test, the no-`courseId` path turned out to
query `course_controls` **without any event filter**, aggregating bindings
from every event in the database (this feeds the dashboard progress bar).
It is now scoped with `where: { course: { eventId } }`.

## Tests

- `packages/api/src/__tests__/integration/map-control-id-space.test.ts` —
  pins the cross-endpoint contract: `controlCoordinates` ids are punch
  codes, `course.list` tokens resolve against them, and
  `controlCompletionStatus.controlId` joins against them. Uses controls
  created without explicit `seq` so `seq ≠ code` is guaranteed.
- `e2e/map-control-circles.spec.ts` — full repro: imports courses from
  `test.ocd` (fresh seqs), uploads it as the map, selects a course, and
  asserts the course's control code labels stay visible on the map.
  Verified to fail against the pre-fix code.
