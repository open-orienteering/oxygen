# IOF 3.0 CourseData export

Oxygen can write every course of an event as an IOF 3.0 **CourseData**
XML document. The practical point is printing: Oxygen does not print maps
itself, so the course set is handed to Condes, Purple Pen or OCAD, which
do. The same file re-imports into Oxygen (any event, any installation)
through the existing course importer.

## Using it

Courses page → **Export** → **IOF XML 3.0 (.xml)** (next to *Import courses*).
The menu is hidden when the event has no courses. The same dropdown also
offers **Purple Pen (.ppen)** — see [ppen-import-export.md](ppen-import-export.md).

Under the hood it is a plain download link:

```
GET /api/export/course-data?name=<nameId>
GET /api/export/course-data?name=<nameId>&format=iofxml
→ 200 application/xml; charset=utf-8
  Content-Disposition: attachment; filename="<nameId>-courses.xml"
```

`format` defaults to `iofxml` (`xml` is accepted as an alias). `400` when
`name` is missing or not `[A-Za-z0-9_-]+`, or when `format` is unknown;
`404` when no such event. Registered next to the backup route in
`packages/api/src/index.ts`.

```bash
curl -OJ 'http://localhost:3002/api/export/course-data?name=itest'
```

## What ends up in the file

| XML | Source |
|-----|--------|
| `Event > Name` | `events.name` |
| `RaceCourseData > Map > Scale` | the map file's CRS scale (`loadEventCrs`), 15000 when there is no map |
| `Map > MapPositionTopLeft` / `BottomRight` | bounding box of the exported controls — the schema wants image corners and we ship no image |
| `Control` (one per **placed** site) | `Id` = primary punch code (name, then `seq`, as fallbacks — a code-less crossing point's is its name, "Passeringspunkt 1"); `@_type` = `Start` / `Control` / `Finish` / `CrossingPoint` from `controls.kind`, else `controls.status`; `MapPosition @_x/@_y` in paper mm; `Position @_lat/@_lng` from the stored WGS84, or derived via the map CRS; a map exchange site carries `Extensions/ox:MapExchange` (below) |
| `Course` | one per course — a course with variations is written as its **variants** (below); `Name`, `CourseFamily` (a variant's root), `Length`, `Climb` (omitted when 0). A `derived` course's `Length` is the stored `length_m` formula: the legs' millimetres (below) summed and rounded once × map scale; untouched imports keep their declared `courses.length_m` so intentional extra distance survives |
| `CourseControl` | the full display sequence: start row, the course's items in order, finish row; `LegLength` is the leg along its bends and through its crossing point, from current coordinates × map scale — the course layer's legs (`loadCourseSequences` → `editorCourseLayer` → `legDistancesMm`, `course-geometry.ts`), the very numbers `rebuildCourseLengths` stores in `courses.legs`, so the file equals the stored legs. Free-order courses emit `randomOrder="true"` on every Control-type row and omit `LegLength` — see [free-order-courses.md](free-order-courses.md) |
| `CourseControl type="CrossingPoint"` | a leg through a crossing point (`LegProps.crossing`, `docs/course-layer.md` §10.3): an unnumbered row before the leg's end row, `specialInstruction="MandatoryCrossingPoint"` (`MandatoryOutOfBoundsAreaPassage` for a passage, `crossing.section`), **no `LegLength`** — the end row carries the whole leg |
| `specialInstruction="TapedRoute"` + `tapedRouteLength` | on the end row of a leg with `style: "marked_route"` (707 along the leg, §10.1); the length is the row's `LegLength`. `style: "line"` and `"none"` have no XML |
| `ClassCourseAssignment` | every `classes` row with a non-null `course_id`; a class on a root with variants gets one assignment per variant (its pool, §12.4) |

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

### Variants (course families)

A course with variations or loops (`docs/course-layer.md` §12) is not
written itself: each of its live materialised variants is a `<Course>`,
`Name` = the variant's stored name (`<root> <key>`, "Lång AC"),
`CourseFamily` = the root's name, in the root's place and key order —
08 §4.3 "the IOF export emits one `<Course>` per variant with the root's
name as the family". Each variant is an ordinary linear course, so its
sequence, legs and length are its own row's. A root without variants is
an ordinary course.

### The map exchange (08 §12 "IOF XML", verified for F9)

IOF 3.0 has **no map-exchange field**: `ControlType` is `Control` /
`Start` / `Finish` / `CrossingPoint` / `EndOfMarkedRoute`, `Course` has
no map-change element (`MapId` names one map per course), and
`CourseControl`'s attributes are `type`, `randomOrder`,
`specialInstruction` (`None`, `TapedRoute`, `FunnelTapedRoute`,
`MandatoryCrossingPoint`, `MandatoryOutOfBoundsAreaPassage`),
`tapedRouteLength` and `modifyTime`. This reading of IOF.xsd 3.0 is from
knowledge of the schema — the repository has no copy of the XSD and F9
did not download one (the user's rule) — so it is for review: if the
published schema has a map-exchange field after all, the marker below is
a one-line swap in the builder and the parser.

Of the three candidates 08 §12 named — the schema's own element, an
`Extensions` element, a `MapText` — the exchange is written as an
**`Extensions` marker on the exchange site's `Control`**:

```xml
<CourseData xmlns="http://www.orienteering.org/datastandard/3.0"
            xmlns:ox="urn:oxygen:iof:extensions" …>
  …
  <Control type="Control">
    <Id>80</Id>
    <MapPosition x="70" y="10" unit="mm"/>
    <Extensions><ox:MapExchange>true</ox:MapExchange></Extensions>
  </Control>
```

The schema's `Extensions` takes elements of any other namespace, so the
file still validates and other tools ignore the marker (they see a
control with a code, which an exchange is). Nothing goes on the
`CourseControl` rows: in Oxygen the parts are the site's kind
(`sectionsOf`, `docs/course-layer.md` §11), so one marker per site is the
whole fact. `MapText` was rejected: it is the text consumers print next
to the control circle.

## Importing it back

`parseIOFCourseData` (`iof-course-parser.ts`) and `importCourses` read
what the export writes, and the same from other tools:

| CourseData | Import |
|------------|--------|
| `CourseFamily` | `ParsedCourse.family`, shown as `family` on the `previewImport` course rows; the variants import as **separate linear courses** — no variation group is inferred |
| `Control type="CrossingPoint"` | a `crossing_point` site: code-less, named by its `Id`, seq above `MARK_SEQ_BASE` as `control.create` allocates it; matched on a re-import by name among the crossing points |
| `CourseControl type="CrossingPoint"` / `"EndOfMarkedRoute"` | not a row of the course: it folds into the next row — a crossing point becomes that leg's `crossing` (`section` for `MandatoryOutOfBoundsAreaPassage`), a split `LegLength` is summed; a fold before the first or after the last row joins no leg. An `EndOfMarkedRoute` point is not imported |
| `specialInstruction="TapedRoute"` / `"FunnelTapedRoute"` | the leg's `style: "marked_route"` |
| `Extensions/…:MapExchange` = `true` | a newly created site is `kind: "map_exchange"`; an existing site keeps its kind |

A re-import over an existing course carries the stored leg props the file
is silent on (bends, gaps) where the leg still runs between the same
sites; the file's style and crossing win where it has them (`carryLegs`)
— a file cannot remove a stored crossing point or marked route, and a
carried bend stays where it was if the file moved the leg's controls
(`docs/course-layer.md` §6.4).

## Code layout

| File | Role |
|------|------|
| `packages/api/src/iof-course-export.ts` | `buildCourseDataXml(input)` — pure: plain data in, XML string out (`XMLBuilder` from `fast-xml-parser`, same setup as the Eventor ResultList writer) |
| `packages/api/src/course-export.ts` | `buildEventCourseDataXml(db, event)` maps Prisma rows onto that input (variants, crossing rows, taped routes, lengths from the layer); `registerCourseExportRoute` is the Fastify route |
| `packages/api/src/iof-course-parser.ts` | the reader, folds included |
| `packages/web/src/pages/CoursesPage.tsx` | the download link |

Splitting the builder from the DB mapping is what makes the round-trip
test cheap: the unit tests feed hand-written data straight into
`buildCourseDataXml`.

## Testing

- `packages/api/src/__tests__/iof-course-export.test.ts` — structure
  assertions plus a **round-trip** through `parseIOFCourseData`: control
  ids/types/positions, course sequences, lengths, class assignments.
  Edge cases: `firstAsStart` / `lastAsFinish`, free-order `randomOrder`
  round-trip, missing lat/lng, unplaced controls, duplicate ids, an
  empty event. Row F9: `CourseFamily` after `Name`, the crossing point's
  control and row (no `LegLength`, the passage variant), `TapedRoute` +
  `tapedRouteLength`, the exchange marker, each round-tripped; a foreign
  file's crossing / end-of-marked-route rows folded with a split
  `LegLength`.
- `packages/api/src/__tests__/integration/course-export.test.ts` — seeds
  an event with the OCD fixture as its map, exports, re-parses, and
  checks the synthesized start/finish rows, derived WGS84 coordinates and
  the class assignment. Also covers the attachment filename sanitizer.
  Row F9: a bent course's exported `LegLength`s and `Length` equal the
  stored `legs` / `length_m` (IOF and Purple Pen); a forked event with a
  crossing point and a map exchange — variants with their family, the
  root omitted, the class on each variant, the crossing row, the taped
  route, the marker, no map-issue point, every variant's legs equal its
  stored ones.
- `packages/api/src/__tests__/integration/course-import-structure.test.ts`
  — an IOF file with a family, a crossing point, a taped route and the
  exchange marker imports as two linear courses, a `crossing_point` site
  the finish's leg runs through, a `map_exchange` site; a re-import
  creates no second crossing point.
- `e2e/courses.spec.ts` — clicks the button, catches the download and
  asserts the payload contains `<CourseData` and a seeded course name.

## Not exported

Control descriptions (they have no place in CourseData; the description
sheet is a print artefact), leg bends and corridors (CourseData has no
leg geometry: a leg's bends shape its `LegLength` only — along the
curve when they carry Bézier handles (F13, `course-layer.md` §10.1), so
`LegLength` stays the stored `legs` entry; Purple Pen's `<leg>` carries
them, a curve flattened at 0.1 mm, [ppen-import-export.md](ppen-import-export.md)),
map-issue points (no `ControlType`; a setter's note), map files
themselves. Consumers that need the map read the OCD file.
