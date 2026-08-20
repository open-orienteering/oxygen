# IOF 3.0 CourseData export

Oxygen can write every course of an event as an IOF 3.0 **CourseData**
XML document. The practical point is printing: Oxygen does not print maps
itself, so the course set is handed to Condes, Purple Pen or OCAD, which
do. The same file re-imports into Oxygen (any event, any installation)
through the existing course importer.

## Using it

Courses page → **Export IOF XML** (next to *Import courses*). The button
is hidden when the event has no courses.

Under the hood it is a plain download link:

```
GET /api/export/course-data?name=<nameId>
→ 200 application/xml; charset=utf-8
  Content-Disposition: attachment; filename="<nameId>-courses.xml"
```

`400` when `name` is missing or not `[A-Za-z0-9_-]+`, `404` when no such
event. Registered next to the backup route in `packages/api/src/index.ts`.

```bash
curl -OJ 'http://localhost:3002/api/export/course-data?name=itest'
```

## What ends up in the file

| XML | Source |
|-----|--------|
| `Event > Name` | `events.name` |
| `RaceCourseData > Map > Scale` | the map file's CRS scale (`loadEventCrs`), 15000 when there is no map |
| `Map > MapPositionTopLeft` / `BottomRight` | bounding box of the exported controls — the schema wants image corners and we ship no image |
| `Control` (one per **placed** control) | `Id` = primary punch code (name, then `seq`, as fallbacks); `@_type` = `Start` / `Control` / `Finish` from `controls.status`; `MapPosition @_x/@_y` in paper mm; `Position @_lat/@_lng` from the stored WGS84, or derived via the map CRS |
| `Course` | `Name`, `Length` (`courses.length_m`), `Climb` (omitted when 0) |
| `CourseControl` | the full display sequence: start row, `course_controls` in order, finish row; `LegLength` from `courses.legs` when the leg count matches the sequence |
| `ClassCourseAssignment` | every `classes` row with a non-null `course_id` |

Two deliberate omissions:

- **Unplaced controls** (`xpos`/`ypos` both 0) are skipped, and course
  controls referring to them are dropped from the sequence. A leg to
  (0, 0) would be worse than a shorter course.
- **Duplicate control ids** collapse to the first one. Ids are the
  document's reference keys, so a duplicate would make course controls
  ambiguous.

Start and finish rows are synthesized the same way the geometry builder
does it (`course-geometry.ts`): the event start control (matched on
`courses.start_name` when set) unless the course has `first_as_start`,
and `courses.finish_control_id` or the event's first finish control
unless it has `last_as_finish`. When the course carries them itself, the
first and last rows are typed `Start` / `Finish` — IOF encodes the role
in the attribute, not in a separate element.

Coordinates are **paper millimetres** with `unit="mm"`, which is exactly
what `controls.xpos/ypos` store, so a round-trip through the importer is
lossless rather than "close enough".

## Code layout

| File | Role |
|------|------|
| `packages/api/src/iof-course-export.ts` | `buildCourseDataXml(input)` — pure: plain data in, XML string out (`XMLBuilder` from `fast-xml-parser`, same setup as the Eventor ResultList writer) |
| `packages/api/src/course-export.ts` | `buildEventCourseDataXml(db, event)` maps Prisma rows onto that input; `registerCourseExportRoute` is the Fastify route |
| `packages/web/src/pages/CoursesPage.tsx` | the download link |

Splitting the builder from the DB mapping is what makes the round-trip
test cheap: the unit tests feed hand-written data straight into
`buildCourseDataXml`.

## Testing

- `packages/api/src/__tests__/iof-course-export.test.ts` — structure
  assertions plus a **round-trip** through `parseIOFCourseData`: control
  ids/types/positions, course sequences, lengths, class assignments.
  Edge cases: `firstAsStart` / `lastAsFinish`, missing lat/lng, unplaced
  controls, duplicate ids, an empty event.
- `packages/api/src/__tests__/integration/course-export.test.ts` — seeds
  an event with the OCD fixture as its map, exports, re-parses, and
  checks the synthesized start/finish rows, derived WGS84 coordinates and
  the class assignment. Also covers the attachment filename sanitizer.
- `e2e/courses.spec.ts` — clicks the button, catches the download and
  asserts the payload contains `<CourseData` and a seeded course name.

## Not exported

Control descriptions (they have no place in CourseData; the description
sheet is a print artefact), high-fidelity leg geometry (bends around
uncrossable features — CourseData carries straight legs only), map files
themselves, and the fork-only `ClassCoursePool` many-to-many. Consumers
that need the map read the OCD file.
