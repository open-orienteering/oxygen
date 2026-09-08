# Purple Pen (.ppen) import / export

Oxygen reads and writes Purple Pen's native **CourseScribe** XML
(`.ppen`). Import reuses the same preview / class-mapping pipeline as
IOF XML and OCAD; export sits next to IOF XML on the Courses page.

Purple Pen is open source ([purple-pen.org](https://purplepen.golde.org/));
the on-disk format is a flat XML document rooted at
`<course-scribe-event>`.

## Using it

### Import

Courses page → **Import courses** → drop or browse a `.ppen` file
(alongside `.xml` / `.ocd`). The server sniffs the
`<course-scribe-event>` root, so the client sends the file as
`xmlContent` like IOF XML.

### Export

Courses page → **Export** dropdown → **Purple Pen (.ppen)**. The IOF
XML option remains for Condes / OCAD / interchange.

```
GET /api/export/course-data?name=<nameId>&format=ppen
→ 200 application/xml; charset=utf-8
  Content-Disposition: attachment; filename="<nameId>-courses.ppen"
```

`format` defaults to `iofxml` (also accepted as `xml`). `400` for an
unknown format. See [iof-coursedata-export.md](iof-coursedata-export.md)
for the IOF path.

```bash
curl -OJ 'http://localhost:3002/api/export/course-data?name=itest&format=ppen'
```

## Coordinate conventions

| Field | Unit | Notes |
|-------|------|-------|
| `<location @_x/@_y>` | paper mm | Same as Oxygen `controls.xpos/ypos` and IOF `MapPosition` |
| `<map @_scale>` | denominator | e.g. `10000` for 1:10 000; used to derive leg lengths on import |
| WGS84 | — | Not stored in `.ppen`. Import leaves `lat/lng` at 0; the importer (and later export) derives them from the event map CRS when present |

### Paper mm are anchored to one specific map file

This is the part that bites. A `.ppen` carries no georeference — its
millimetres are measured from the **paper origin of the map file named in
`<map>`**, which is that file's georeference reference point. Two maps of
the same terrain normally have different reference points, so the same
control has different paper coordinates in each. Import a file set on
`Utsnitt nacka Brotorp.ocd` into an event whose map is
`Nackareservatet 260620.ocd` and every control lands off by the
difference between the two — kilometres, in practice.

Oxygen resolves this before writing anything
(`resolveImportAlignment`, `packages/api/src/course-import-align.ts`):

| Situation | Status | Behaviour |
|-----------|--------|-----------|
| `<map>` names the event's own map file (case- and suffix-tolerant) | `aligned` | Coordinates used as they are |
| Source map is in the **club map library** | `transformed` | Coordinates re-projected source paper mm → WGS84 → event paper mm; preview says which library map they came from |
| Source map unavailable, but positions land on the event map | `aligned` | Used as they are — covers a renamed copy of the same file |
| Source map unavailable and positions land off the map | `mismatch` | Preview warns, naming both maps, and offers **Import without control positions** (checked by default) |
| No `<map>` recorded, or the event has no map yet | `unknown` | Nothing to check; unchanged behaviour (IOF XML and OCAD always land here) |

The off-map test compares the centroid of the file's placed controls
against the event map's paper extent, padded by 5% of its longer side,
so a control just outside the printed edge is not treated as a mismatch.

`importCourses({ skipPositions: true })` imports codes, course sequences
and leg lengths — all still correct, since leg lengths are real metres
derived from the source map's own scale — but writes no coordinates:
new controls arrive unplaced for the course editor, existing controls
keep the positions they already had, and course geometry is rebuilt from
what the controls actually have rather than from the file.

A `kind="PDF"` or `kind="Bitmap"` map can never be re-projected: those
files have no georeference at all, so such a `.ppen` either lands
plausibly on the event map or gets the mismatch warning.

To get correct placement for a mismatched file, either upload the map the
courses were set on as the event's map, or add it to the club map library
and import again.

## What is imported

| Purple Pen | Oxygen |
|------------|--------|
| `<control kind="start/normal/finish">` | Control bank. Start/finish get synthesized public ids `STA1`… / `FIN1`…; normal controls use `<code>` |
| `<control kind="map-issue">` (and other non-punchable kinds) | Skipped from the control bank; course walks still follow their links so the sequence stays intact |
| `<course kind="normal">` + linked `<course-control>` | Course with ordered controls; leg lengths = map-mm distance × scale / 1000 |
| Class assignments | None in `.ppen`. Preview falls back to course-name class suggestions ([course-import-class-fallback.md](course-import-class-fallback.md)) |
| Descriptions, special objects, white-outs, print layout | Ignored |

Geometry is straight-line GeoJSON (`geometrySource: "xml"`), same as IOF
import.

## What is not supported (v1)

- **Relay / variation courses** — a `<course-control>` with more than one
  `<next>` is rejected with an error naming the course.
- **Score courses** and other non-`kind="normal"` courses — rejected.
- Round-tripping of control descriptions, number locations, leg gaps,
  or print-area / appearance settings (export writes sensible defaults
  so Purple Pen opens the file cleanly).

## Implementation

| Piece | File |
|-------|------|
| Parser | `packages/api/src/ppen-course-parser.ts` → `ParsedCourseData` (incl. `sourceMap`) |
| Alignment check | `packages/api/src/course-import-align.ts` |
| Paper-mm transfer | `packages/api/src/map-coordinate-transfer.ts` |
| Writer | `packages/api/src/ppen-course-export.ts` → `buildPpenXml` |
| DB gather + route | `packages/api/src/course-export.ts` (`gatherEventCourseExport`, `format=ppen`) |
| Import sniff | `parseCourseFile` in `packages/api/src/routers/course.ts` |
| UI | `CoursesPage` export dropdown; `CourseImportDialog` accepts `.ppen` |

Unit tests: `ppen-course-parser.test.ts`, `ppen-course-export.test.ts`
(round-trip), `map-coordinate-transfer.test.ts`,
`course-import-align.test.ts`. Integration: `ppen-import.test.ts`
(aligned / transformed / mismatch / `skipPositions`), ppen case in
`course-export.test.ts`. E2E: `e2e/courses.spec.ts` + fixtures
`e2e/fixtures/ppen-import.ppen` and `e2e/fixtures/ppen-other-map.ppen`.
