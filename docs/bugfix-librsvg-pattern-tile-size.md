# Missing OCAD hatch and structure fills in map PDFs

## Symptom

Map previews looked correct, but exported PDFs omitted patterned area symbols.
Affected symbols included marsh stripes, undergrowth hatching, cultivated rows,
rough-open dots, paved/gravel textures, railway hatching, and purple hatched
areas. The unpainted paper showed through as white.

## Cause

`ocad2geojson` represents these symbols as SVG
`patternUnits="userSpaceOnUse"` patterns in OCAD native units. Tiles can be as
small as 10 × 30 native units (0.1 × 0.3 map millimetres).

The editor preview uses resvg, which paints those sub-pixel patterns. PDF
export uses librsvg 2.54 through `rsvg-convert`. librsvg silently drops a
pattern when its tile is below approximately one output device pixel. Raising
`rsvg-convert`'s DPI does not affect vector PDF output and did not fix it.

## Fix

Before composition, Oxygen expands every user-space pattern tile eightfold in
each direction. The enlarged tile contains an 8 × 8 grid of clipped copies of
the original tile:

```text
original period: 10 × 30
PDF-safe tile:   80 × 240
contents:        64 clipped copies of the original 10 × 30 tile
```

The visible period and pattern transform remain unchanged, but librsvg now
sees a device-space tile large enough to retain in the PDF. Clipping each copy
also preserves patterns whose source geometry intentionally extends beyond
one tile.

Regression tests cover tile dimensions, replicated clipping, transform
preservation, PDF composition, and the unaffected object-bounding-box case.
