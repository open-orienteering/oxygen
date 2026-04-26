# Bugfix: Stale OCD course geometry after XML re-import

## Symptom

On Bagissprinten (and any other event under active course development),
selecting a class on the map showed control circles in the right place
but **leg lines tracing through the previous control positions**. The
lines and circles disagreed by tens of metres on legs whose endpoints had
been moved between imports. See the example screenshot for H21 in the
original report — controls 80, 110, 76, 113, 82 etc. all sit clearly off
the magenta lines connecting them.

## Root cause

The map renders two layers from two different sources:

1. **Control circles** come from `oControl.xpos`/`ypos`. The XML import
   path overwrites these on every run (`packages/api/src/routers/course.ts`,
   `oControl.update` in `importCourses`), so circles always reflect the
   latest XML.
2. **Course leg lines** come from a per-course GeoJSON FeatureCollection
   stored in the Oxygen-only table `oxygen_course_geometry`. Each row is
   tagged `Source = 'ocd' | 'xml'`.

`saveCourseGeometry` had a hard rule:

```ts
if (source === "xml" && currentSource === "ocd") continue;
```

The intent is sound — OCD imports give nicely *routed* legs (around
fences, through corridors, with dogleg cuts), and a later XML re-import
shouldn't downgrade those to plain straight lines. But the rule had no
escape hatch. Once an OCD had been imported, every subsequent XML import
silently kept the old OCD geometry forever, even when the course's
controls had been physically moved on the map. The circles followed the
XML, the lines stayed frozen at the OCD-time positions, and the map
showed the inconsistency.

## Fix

Replace the unconditional skip with a per-course staleness check.

For each course in the incoming XML, compare the freshly-built XML
straight-line geometry against the stored OCD geometry **using the Point
features both formats produce** (same map-mm coordinate space, both
tagged with `properties.code`):

- If the control sequence on the course differs (added / removed /
  reordered control), the OCD legs would connect the wrong endpoints →
  stale.
- If any control's position differs by more than 0.5 mm at map scale
  (about 2 m on the ground at 1:4000) → stale.
- Otherwise the OCD geometry is still consistent with the live control
  layout → keep it, preserving the higher-quality routed lines.

When stale, the row is overwritten with the XML straight-line geometry
for that course (`Source = 'xml'`). Other courses on the same import are
evaluated independently — moving a single control only invalidates the
courses that actually visit it.

The 0.5 mm tolerance is wide enough to absorb sub-mm floating-point
round-trip noise from IOF XML serialisation/parsing, and tight enough to
detect any real-world control move (a sprint control that has been
nudged a single metre will already trigger the rebuild).

The check lives in a new exported helper `isOcdGeometryStaleVsXml`
(`packages/api/src/routers/course.ts`), which is unit-tested in
isolation, and `saveCourseGeometry` calls it for the source/current
combination that previously short-circuited.

## Operational impact

- After deploying, the next time courses are re-imported from XML, any
  course with moved controls automatically switches its lines to the
  XML's straight-line view. To restore routed lines after the layout has
  stabilised, re-import the OCD file (which always wins the priority
  comparison and overwrites whatever is stored).
- Courses whose layouts have not changed continue to render the
  pre-existing OCD routed geometry.

## Files changed

| File | Change |
|------|--------|
| `packages/api/src/routers/course.ts` | New `isOcdGeometryStaleVsXml` helper; `saveCourseGeometry` now overwrites OCD with XML when stale |
| `packages/api/src/__tests__/courseGeometryStale.test.ts` | 10 unit tests covering tolerance, sequence changes, missing positions, custom tolerance |
| `packages/api/src/__tests__/integration/course-geometry-stale.test.ts` | 3 integration tests through `caller.course.importCourses` covering the OCD-preserved, OCD-overwritten, and unaffected-sibling-course cases |
| `docs/bugfix-stale-ocd-course-geometry.md` | This document |
