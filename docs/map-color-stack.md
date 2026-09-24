# Map colour stack (IOF lower/upper purple)

Oxygen prints and displays course maps with **colour-table stacking**, not
blend modes. That matches ISOM 2017 Appendix 1 / ISSprOM digital print
practice: lower purple (circles, legs, start, finish) sits under black,
brown and 100 % blue line/point colours so those features stay sharp;
upper purple (control numbers, marked/forbidden routes, out-of-bounds
hatch) sits on top.

## Why a raster ink layer

Cutting purple where map ink should win requires knowing where the ink
is. Vector outlining of every OCAD symbol is not realistic. Colour-
thresholding a composite fails (lake blue equals stream blue). So the
renderer ships a transparent **ink layer** — the colours classified above
lower purple — and draws it on top of the purple.

Drawing that ink a second time over the full composite is idempotent, so
legacy consumers that only show the composite still look correct.

## Profiles (`map-color-stack.ts`)

IOF *Printing and Colour Definitions* rev. 4, chapter 7 defines what sits
above lower purple per map specification. Oxygen exposes four profiles
plus **auto**:

| Profile | Above lower purple |
|---|---|
| `isom` | black 100 % (line/point/text), blue 100 % (line/point), brown 100 % (line/point), white (line/point), green 100 % (point only) |
| `issprom` | black 100 % (line/point/text), white (line/point), green 100 % (point only), purple 50 % area (18/43/0/0) — **no** brown/blue |
| `isskiom` | black 100 %, blue 100 % (line/point), green 100 % (line/point, Ski-O track green), white |
| `ismtbom` | black 100 %, blue 100 % (line/point), green 100 % (point), white, purple 50 % area |

`applyIofColorStack(file, { profile, overrides?, scale? })` returns
`{ boundary, above, below, warnings, resolvedProfile, resolvedBy }`.

### Auto detection order

1. A colour whose name matches `/lower\s*purple|undre\s*lila/i` → boundary
   is that colour's position in the file's own order (`resolvedBy:
   "file-colour"`).
2. Else `scale <= 5000` → `issprom`; otherwise `isom` (`resolvedBy:
   "scale"` or `"default"` when scale is missing).

Explicit profile selection sets `resolvedBy: "explicit"`.

### Overrides

`color_overrides` JSONB (`{ above?: number[]; below?: number[] }` —
OCAD colour numbers) is applied after classification on every path.
Data model + API only in this release; no UI yet.

### North lines under the course

`north_lines_below` (default `true`) is an **object** filter, not a
colour move: the blue 100 % line colour is shared with streams. Ink
renders pass
`objects: file.objects.filter(o => Math.floor(o.sym / 1000) !== 601)`
into `ocadToSvg` / `objectsInWindow`. The composite keeps all objects.

## UI / API

- Event map: `course.setMapColorStack` + MapPanel select
  (`data-testid="map-color-profile"`) and north-lines checkbox.
- Club library: `clubMap.setColorStack` + Settings → Maps card controls.
- `course.mapMetadata` exposes `colorProfile`, `northLinesBelow`,
  `resolvedProfile`, `resolvedBy`, and `renderKey`.

## Tiles (256×512 stacked PNG)

Each `map_tiles` row stores one PNG keyed by **render key** (content +
stack settings — see [map-tile-rendering.md](map-tile-rendering.md)):

```
+----------------+
| composite 256² |  ← opaque full map (top half)
+----------------+
| ink       256² |  ← transparent above-purple ink (bottom half)
+----------------+
```

Same row count and request count as before; ink compresses well (~+25 %
bytes). The viewer slices with an overflow clip (`TileLayer` `half`
prop). Two layers share one blob cache via `TileBlobCacheProvider`.
Client URLs carry `?v=<renderKey>` so a profile change busts the cache;
`f=2` remains for legacy-format safety.

## Print / layout editor

Order in the page SVG:

1. full map
2. lower purple (`course-overlay-lower`)
3. ink nested SVG (`map-ink`, transparent root fill)
4. whiteouts
5. upper purple (`course-overlay-upper`) + OOB hatch (no multiply)
6. descriptions, foreground layout objects

`window.png?layer=full|ink` feeds the layout editor the same sandwich.

## Out of scope

- Overrides UI (API + schema only)
- Print profiles (per-printer CMYK) and CMYK PDF output
- `rendered_maps` (still per-event)
