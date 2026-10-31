# The `e2e/test.ocd` fixture is generated

`e2e/test.ocd` is a synthetic OCAD 2018 course-setting file produced by
`scripts/generate-test-ocd.mjs`. It is **not** a real map export.

## Why

The fixture is generated so the repository never needs to contain real
map or course-setting exports. Real OCAD files carry georeferences and
metadata (file paths, layout references) that don't belong in a public
repo; a synthetic file gives the tests the exact shape they need with
none of that.

## What the generated file contains

| Aspect | Value |
|--------|-------|
| Format | OCAD 2018, file type "course setting" |
| Courses | `A`–`E` with 18 / 15 / 11 / 10 / 8 controls (same shape as the original) |
| Controls | Codes `61`–`88`, start `S1`, finish `M1`, deterministic jittered-grid layout |
| Class records | None (strType 3 absent) — the class-name-fallback tests depend on this |
| Georeference | String 1039: grid id 13002 (SWEREF99 TM / EPSG:3006 in the reader's grid table, so the map document resolves its CRS; until 2026-10-19 it was 1000, which is no OCAD id and only worked through the legacy coordinate-range inference), easting 500000, northing 6500000, scale 1:7500 — round, non-identifying values (~15°E, 58.6°N, generic inland Sweden) |
| Terrain | One yellow area (403) and three black paths (505), purely so map tiles render something visible |
| North lines | Twelve ISOM 601 magnetic-north lines (blue, 12 mm apart, exactly along paper +Y with ScalePar `a=0`). The real declination at the georeference is ≈ 6.5° E, so north detection reports the lines as ≈ 6.5° stale — the club-map-library E2E asserts the warning badge. Zero tilt keeps the display orientation of every other consumer unchanged |
| Autodetect features | A boulder (ISOM 204) at 68 / 42 mm and a building (ISOM 521) spanning 48–58 / 39–46 mm, both in the corner the yellow blob doesn't reach, so a description-autodetect search around either returns exactly that feature |
| Text and rectangle | A spot-height value (`603.0`, black 4.3 pt, white line framing 0.1 mm — a fifth colour, `White`) at 62 / −49 mm and a rectangle frame (`850.1`, black 0.25 mm) spanning −73…−61 / −49.5…−46.5 mm, both below the yellow area and the bottom control row. The text auto-matches ISOM 603.b and the frame gets a geometry suggestion, so the fixture still has no unmatched symbol; `import-ocad.test.ts` asserts the halo and the outline (`docs/map-import.md` §3.3). Line text and formatted (box) text are left out to keep the file's consumers unchanged — `buildSymbolTypesOcad()` covers them (a justified, rectangle-framed formatted text with a tab stop, and a line text; `import-ocad.test.ts` runs both through reader → document → stage, B8) |
| Overprint-cut targets | Two more boulders placed relative to the jittered control layout: one exactly 2.5 mm north of control 79 (on its circle rim) and one exactly on the midpoint of the 79→80 leg — the course-editor E2E builds a course through 79 and 80 and asserts the automatic circle slit and leg gap render |

## Consumers that constrain the format

- `packages/api/src/ocd-course-parser.ts` — Oxygen's own binary parser
  (course import). Reads the header offsets, string-parameter index
  (courses from strType 2 records), and 700-series objects; control codes
  come from `a<code>` object text.
- `ocad2geojson` (`readOcad`, `ocadToSvg`, `getCrs`, `getBounds`) — map
  tile rendering and map-mm → WGS84 conversion.
- E2E specs: `competition`, `courses`, `map-control-circles`,
  `map-multicourse` (course import + map upload flows), `course-editor`
  (the overprint-cut targets above), `map-vector-layer` (a black 505 path
  on white paper, top right, for the lower-purple probe).
- The colour table puts Yellow above Blue (`DEFAULT_COLORS`). Since
  `ocad-16` (C14) the aligned stack has lower purple above the yellow and
  the Blue line colour left under it is a `COLOUR_ORDER_CONFLICT`
  (`docs/map-symbols.md` §9.2); before, lower purple went under the yellow
  and the fixture's courses were hidden where the 403 area covers them
  (`docs/bugfix-lower-purple-under-areas.md`). Specs read course numbers
  from the viewer's mirror, not from pixels; the vector-layer spec probes
  a crossing of a black path on white paper and a leg over the yellow.
- Integration tests: `course-import-class-fallback`, `course-import-coords`,
  `map-tiles`, `course-export`, `description-autodetect` (asserts the
  boulder/building coordinates above), `overprint-cuts` (rim slit and
  leg gap over the 68/42 boulder; no gap through the building).

## Regenerating

```bash
node scripts/generate-test-ocd.mjs
```

The writer lives in `scripts/lib/ocad-fixture.mjs` and is also used for the
Demo Competition backing map (`buildShowcaseOcad()`). That file is **not**
`e2e/test.ocd`: it uses the showcase CRS (SWEREF99 TM, 1:15000, easting
679000, northing 6572000) and paper extent so cached overview tiles still
line up. Both fixtures are generated; do not commit a source map export for either.

The generator is deterministic (seeded PRNG): running it again without
script changes produces a byte-identical file. If you change the script,
re-run the consumers listed above (`pnpm test`, the three integration
suites, and the four E2E specs) before committing.
