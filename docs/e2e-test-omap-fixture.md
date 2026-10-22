# The `e2e/test.xmap` fixture is generated

`e2e/test.xmap` is a synthetic OpenOrienteering Mapper file (XML format
version 9, the pretty-printed `.xmap` form) produced by
`scripts/generate-test-omap.mjs`. It is **not** a real map export.

## Why

Same reason as `e2e/test.ocd` (`docs/e2e-test-ocd-fixture.md`): real
`.omap` / `.xmap` files carry georeferences, template paths and often the
author's notes, none of which belong in a public repository. The generator
writes exactly the constructs the OMAP import path (`docs/map-import.md`
§4) has a rule for, so every rule has a fixture object behind it.

## What the generated file contains

| Aspect | Value |
|--------|-------|
| Format | `<map xmlns="http://openorienteering.org/apps/mapper/xml/v2" version="9">`, with Mapper's `<barrier>` wrapper around everything after `<colors>` |
| Colours | Purple (opacity 0.5, spot `PURPLE`), Black, Brown, Blue, Green, Yellow, White (component-only spot composition, knockout) — priority 0 = top |
| Georeference | 1:10 000, UTM `33 N`, `grid_scale_factor 0.9996`, grivation 2.5°, map reference point (50, 40) mm → projected (500 000, 6 600 000). Round, non-identifying values (~15°E, 59.5°N, generic Sweden) |
| Symbols (ids 0–20) | 101 contour, 102 index contour, 106 earth bank (pointed cap, `pointed_cap_length` = offsets = 0.6 mm, as Mapper writes it), 204 boulder, 301.1 / 301.4 + combined 301 (lake = area + line), 403, 311 (hatch), 412 (rotatable point pattern), 505 (dashed), 508.1 (dashed + halo), 509 (railway: bordered + background band), 511 (dash symbol), 516 (width-0 carrier with mid symbols), 701 (text, bold, framing), 999 helper, 998 hidden, 502 (bordered), 418 (rotatable point), 702 (text, Sans Serif) |
| Objects (24, two parts) | yellow background, an object with the hidden symbol, a contour with a curve and a dash point, a footpath with a dash point, a power line with dash points, a lake with a hole, a cultivated area with pattern rotation 0.3 rad, a marsh, ride / railway / road / fence, a tagged helper line, a boulder, a rotated 418 (0.523599 rad), five texts (two 701 centred, 702 left / right-with-vertical-alignment / boxed — imported as formatted text with four corners since `omap-7`), one object with the dangling symbol id 77, and a boulder in the second part "Course" |
| Dropped-with-warning material | template `ortho.png`, print area 0 / 0 / 100 / 80 mm, an undo step, object tags |
| Expected import | 21 source symbols all rendered plus one alignment variant of 702 (right / middle, `src:20/right/middle`, `docs/map-import.md` §4.4), `#77` as the only missing symbol, `paperOrigin ≈ (499 518.116, 6 600 421.26)`, `crs` EPSG:32633, factor ×1, warning codes `COLOUR_OPACITY_IGNORED`, `HELPER_SYMBOLS_HIDDEN`, `MISSING_SYMBOL`, `OBJECT_TAGS_DROPPED`, `PARTS_MERGED`, `TEMPLATES_DROPPED`, `FONT_SUBSTITUTED` |

## Consumers

- `packages/shared/src/import/__tests__/omap-source.test.ts` — one test
  per normalisation rule, reads the fixture directly.
- `packages/api/src/__tests__/import-omap.test.ts` — reader → document,
  determinism, provenance, symbolisation, kind sniff.
- `packages/api/src/__tests__/map-import-jobs.test.ts` and the integration
  suite of the same name — the worker and the import job on a Mapper
  source.
- `e2e/map-gl-doc.spec.ts` — the dev page loads it client-side without
  the OCAD reader.

## Regenerating

```bash
node scripts/generate-test-omap.mjs
```

The generator is deterministic: running it again without script changes
produces a byte-identical file. If you change the script, re-run the
consumers above before committing, and keep the expected-import row of
the table in step. Do not edit `e2e/test.xmap` by hand and never replace it
with a real map export.
