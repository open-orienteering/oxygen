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
| Georeference | String 1039: grid id 1000 (SWEREF99 TM / EPSG:3006), easting 500000, northing 6500000, scale 1:7500 — round, non-identifying values (~15°E, 58.6°N, generic inland Sweden) |
| Terrain | One yellow area (403) and three black paths (505), purely so map tiles render something visible |

## Consumers that constrain the format

- `packages/api/src/ocd-course-parser.ts` — Oxygen's own binary parser
  (course import). Reads the header offsets, string-parameter index
  (courses from strType 2 records), and 700-series objects; control codes
  come from `a<code>` object text.
- `ocad2geojson` (`readOcad`, `ocadToSvg`, `getCrs`, `getBounds`) — map
  tile rendering and map-mm → WGS84 conversion.
- E2E specs: `competition`, `courses`, `map-control-circles`,
  `map-multicourse` (course import + map upload flows).
- Integration tests: `course-import-class-fallback`, `course-import-coords`,
  `map-tiles`.

## Regenerating

```bash
node scripts/generate-test-ocd.mjs
```

The generator is deterministic (seeded PRNG): running it again without
script changes produces a byte-identical file. If you change the script,
re-run the consumers listed above (`pnpm test`, the three integration
suites, and the four E2E specs) before committing.
