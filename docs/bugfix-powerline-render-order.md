# Bugfix: Power lines (and other black lines) hidden under area fills

## Symptom

On the Flaten map ("Flaten utsnitt U-serien 2026.ocd"), the power line
(ISOM 510) rendered correctly over forest (white background) but vanished
wherever it crossed open ground (yellow area fills, ISOM 401/403). The
printed PDF from OCAD showed the line the whole way. Power line pole
symbols rendered fine everywhere.

## Root cause

Not a data problem and not a deliberate z-index decision — a broken
z-order sort in the `ocad2geojson` dependency, triggered at runtime by a
single map object.

The map tile pipeline is:

```
map_files BLOB → readOcad() → ocadToSvg() → resvg → PNG tiles (map_tiles)
```

`ocadToSvg` flattens every drawable into one array and sorts it by the
OCAD color-table position:

```js
children.sort((a, b) => b.order - a.order)
```

The rendering branch for "double line without fill" symbols (ISOM 215
trench, 511 major power line, 532 stairs, ...) contained leftover debug
code that emitted red circles (`fill="red"`, r=3) at every vertex —
**without an `order` property**.

The Flaten map contains exactly one such object: a 2-point ISOM 215
"Skyttegrav/bergsspricka" at map coordinates (10739, −1039). Its four
debug circles made the sort comparator return `NaN`. An inconsistent
comparator makes `Array.prototype.sort` produce a partially unsorted
array — on this map, 71 yellow/green area fills ended up painted *after*
(on top of) the black line layer. Every 510 segment crossing open ground
was covered; over forest there was nothing to cover it. The four red
circles were also literally drawn on the map.

## Fix

Fixed in the `ocad2geojson` fork, released as
[`open-orienteering/ocad2geojson@v2.2.1-oxygen.0`](https://github.com/open-orienteering/ocad2geojson/tree/v2.2.1-oxygen.0):

1. Removed the debug circle emission from the no-fill double-line branch.
2. Made the sort NaN-safe — nodes without a valid numeric `order` sort
   deterministically to the bottom instead of poisoning the comparator:

```js
const nodeOrder = n =>
  typeof n.order === 'number' && !Number.isNaN(n.order)
    ? n.order
    : Number.MAX_SAFE_INTEGER
children.sort((a, b) => nodeOrder(b) - nodeOrder(a))
```

A regression test in the fork (`test/svg.test.js`) builds a minimal
synthetic map with a no-fill double-line object next to an area fill and
asserts that no debug circles are emitted and the fill stays below the
line strokes.

Oxygen switched both `packages/api` and `packages/web` from
`marcus-kempe/ocad2geojson#v2.2.0-oxygen.0` to
`open-orienteering/ocad2geojson#v2.2.1-oxygen.0` (same lineage plus this
fix), and shortly after to `v2.2.2-oxygen.0`, which additionally merges
upstream master (v2.1.23): pointed-end line style handling (silences the
"Unknown line join style 3" warnings this map produced), corner symbols
only on corner points, primary symbol placement per straight section,
filled double-line box fix, and a missing-point-symbol regression fix.
Cached `map_tiles` rows were deleted so tiles re-render with the fixed
library on next request.

## Upstream status

Upstream removed the debug circles independently in `c74a9bc0`
(June 2026, v2.1.23), but the NaN-unsafe sort is still present on
upstream master — one order-less node away from the same bug. The sort
hardening is a candidate for an upstream PR alongside the pending
security PR [perliedman/ocad2geojson#34](https://github.com/perliedman/ocad2geojson/pull/34).

## How it was diagnosed

1. Extracted the `.ocd` BLOB from `oxygen.map_files` and reproduced the
   exact SVG the tile renderer builds (same jsdom + options).
2. Confirmed the missing line's path *was* in the SVG with the correct
   color, but 71 yellow/green fills were serialized after it.
3. Ruled out color-table problems: power line black (renderOrder 7)
   should paint above open-ground yellow (renderOrder 37/38).
4. Found the four order-less `fill="red"` circles adjacent to the
   scrambled region; excluding the single ISOM 215 object produced a
   perfectly layered SVG — power line visible the whole way.
