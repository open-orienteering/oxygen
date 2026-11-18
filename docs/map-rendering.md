# Map rendering

Status: **draft** — chapter of the vector map pipeline specification,
started by spike S1 (steps 1–3: harness, pilot symbolisation stage,
WebGL2 backend with golden images); the symbolisation stage covers the
whole library since B1. Sections marked *not yet specified*
are filled in as slice B / C land. The research record this
chapter derives from is `docs/research/vector-map-pipeline/04-render-core.md`;
when the two disagree, this document wins.

This chapter is normative for the code in `packages/shared/src/render/`,
`packages/shared/src/print/operators.ts` (§5.3), `packages/api/src/render/`
and `packages/web/src/map-gl/`.

## 1. Shape of the pipeline

```
map document (02)  ──►  symbolisation stage  ──►  pass stream  ──►  backend
                        @oxygen/shared/render     paper µm,         WebGL2 (web)
                        pure TS, deterministic    Béziers intact    PDF (api)
                                                                     reference raster (api, tests)
```

One rule decides what belongs where:

> If it can be measured with a ruler on the printed map, it is decided in
> the symbolisation stage and appears in the pass stream. If it depends on
> pixels, it is the backend's business.

So dash positions, glyph placements, pattern grids, hatch geometry, halo
widths and text glyph positions are in the stream; Bézier flattening,
stroke extrusion, triangulation, anti-aliasing and minimum on-screen sizes
are not. Backends are deliberately dumb: they draw what the stream says,
in stream order, and nothing else.

## 2. Units and coordinates

- **Paper micrometres** (`µm`), integers for geometry, at the document's
  reference scale. 1 mm = 1000 µm.
- **y-up.** Paper space is mathematical: +y is north on an unrotated map.
  SVG and canvases are y-down; backends flip once, in their outermost
  transform, never per object.
- Angles in degrees, counter-clockwise from +x.
- The renderer never sees geographic coordinates. `geoToPaper` (02) is
  applied before symbolisation.

### 2.1 Paths and coordinate flags

A `RenderPath` is `coords: Int32Array` (x, y pairs), `flags: Uint8Array`
(one byte per point) and `closed: boolean`. Flags are the document
format's bits, unchanged:

| Bit | Name | Meaning |
|---|---|---|
| 1 | `bezierFirst` | First control point of a cubic segment |
| 2 | `bezierSecond` | Second control point |
| 4 | `corner` | Corner point: dash and glyph layout restart here |
| 8 | `dash` | Dash point: a dash is centred here and layout restarts |
| 16 | `hole` | First point of a hole ring (area objects) |
| 32 | `noLeft` | No left border line from this point |
| 64 | `noRight` | No right border line from this point |
| 128 | `gap` | Main line interrupted from here to the next gap point |

A cubic segment is encoded `anchor, control(1), control(2), anchor`. A
control point that is not followed by its partner and an anchor is
degraded to straight lines (OCAD does the same); it is never an error.

Rings: the path is split at `hole` points. The first ring is the outer
boundary, every subsequent ring is a hole. Ring winding carries no
meaning (§3.1).

`pathRings`, `ringSegments`, `pathSegments`, `pathBounds`, `segmentPoint`,
`segmentSub`, `segmentLength` and `sliceSegments` in `render/path.ts` are
the shared walkers. Both backends and all tests go through them so that
"what this path is" is decided in exactly one place.

## 3. The pass stream

```ts
interface PassStream {
  objectIdx: Uint32Array;  // pass i → owning object in the document
  symbolIdx: Uint32Array;  // pass i → source symbol
  passes: Pass[];          // canonical order, §3.3
  glyphTable: GlyphMesh[];
  fontTable: FontRef[];
  masks?: FilterMask[];    // filter masks, §3.8
  maskIdx?: Int32Array;    // pass i → mask, −1 = none
}
type Pass = FillPass | StrokePass | GlyphPass | HatchPass | TextPass;
```

Every pass has `kind` and `colour` (an index into the document's colour
stack; lower index is drawn first). The types are in
`packages/shared/src/render/pass-stream.ts`; this section states the
semantics the types cannot.

### 3.1 Fill

`{ kind: "fill", colour, path, rule: "evenodd" }`

Filled with the **even-odd** rule, always. OCAD and OMAP area objects
give no winding guarantee for hole rings, so even-odd is the only rule
under which a hole is a hole regardless of how it was drawn. `rule` is a
field, not an assumption, so no backend can pick its own default.

### 3.2 Stroke

`{ kind: "stroke", colour, path, slices?, widthUm, cap, join, taper? }`

- `widthUm` is the full width. A backend must render exactly this width
  on paper; the GL backend may clamp to a minimum *on screen* (that is a
  pixel decision), the PDF backend must not.
- `cap` is `butt | round | square | pointed`; `pointed` is drawn as butt
  plus the `taper`: the width falls linearly from `widthUm` to 0 over
  `startUm` from the path's start and over `endUm` towards its end,
  measured along the whole path (not per slice). The stage sets `taper`
  only from the IR's `StrokeSpec.taper` on a `pointed` stroke (user
  decision 2026-10-20: an explicit field, not `shortenStartUm/EndUm`
  reread); a `pointed` stroke without it is drawn butt, full length.
- `slices` is the dash layout. `undefined` means the whole path is one
  stroke. Each `Slice` is `{ seg0, t0, seg1, t1 }` in (segment index,
  curve parameter) space over `pathSegments(path)`. A slice on a Bézier is
  itself an exact Bézier (de Casteljau, `segmentSub`); backends never
  flatten before slicing. Each slice is stroked as its own open subpath
  with the pass's cap.
- Where a dash falls is decided by the stage (03 §6.9). The GL and PDF
  backends must produce identical dash positions because they read the
  same slices.

### 3.3 Glyph

`{ kind: "glyph", colour, glyphId, partIdx, instances, clip? }`

A glyph is the geometry of a point symbol, a line glyph or a pattern
element, in glyph-local µm with its origin at the symbol's anchor. A glyph
has one `GlyphMesh` per colour part; a pass draws one part for many
instances. `instances` is `x, y, cos, sin, scale` per instance:

```
x' = x + scale·(cos·gx − sin·gy)
y' = y + scale·(sin·gx + cos·gy)
```

`clip`, when present, restricts the instances to an area (pattern fills in
clip mode). Fills inside a glyph mesh use even-odd; mesh strokes are plain
strokes (no slices).

### 3.4 Hatch

`{ kind: "hatch", colour, path, widthUm, spacingUm, offsetUm, angleDeg }`

A family of parallel lines of width `widthUm`, running along `angleDeg`,
spaced `spacingUm` apart perpendicular to that direction, anchored so that
line *k* satisfies `(x·nx + y·ny) = offsetUm + k·spacingUm` with
`(nx, ny) = (−sin, cos)` of the angle. The family is in paper space, not
object space, so two adjacent areas with the same hatch symbol hatch
continuously. Lines are clipped to `path` (even-odd). `hatchLines()` in
`render/path.ts` is the reference generator; the GL stripe shader must
sample the same formula.

### 3.5 Text

`{ kind: "text", colour, fontId, sizeUm, glyphs, positions, angles?, haloWidthUm? }`

Shaped text: one glyph id, one baseline origin and (when `angles` is
present) one rotation in degrees, counter-clockwise, per glyph; absent
`angles` means every glyph is upright (user decision 2026-10-20: per
glyph rather than per pass, so line text along a path needs no new
field). A glyph's outline is rotated about its own origin. Em size in µm
(already derived from digit height where the symbol says so). A halo is a
**separate pass** in the halo colour with `haloWidthUm` set, sorted into
its own colour position like any other pass — it is not a backend effect.
Fonts are the four Liberation families (`FontRef.family`, with the
face's `bold` / `italic`); shaping is the stage's (§4.9). A text shadow
is likewise its own pass (§4.9).

### 3.6 Canonical order

Passes are sorted by `(colour, kind, symbolIdx)`, stable in insertion
order for ties. Kind order within a colour is
`fill < hatch < stroke < glyph < text`. `sortPassStream` is the single
implementation; `PassStreamBuilder.build()` applies it. A stream handed to
a backend is always sorted; backends iterate front to back and that *is*
the painter's order. Because the sort is colour-major, "all passes of
symbol S in colour C" is a small number of contiguous index ranges, which
is what filter regions and per-symbol hiding rely on.

### 3.7 JSON projection

`passStreamToJson` / `passStreamFromJson` (`render/stream-json.ts`) are a
lossless, Zod-validated view of a stream for fixtures and snapshots. Float
fields are quantised to 3 decimals (µm) in the projection — except a glyph
instance's `cos`, `sin` and `scale`, which are unitless and keep 6 (3 put
a 45° instance 1e-4 off, outside `diffPassStreams`' tolerance, B1);
typed arrays are canonical in memory. All-zero flag arrays are omitted.
`angles` (§3.5) and `taper` (§3.2) are projected when present and
compared by `diffPassStreams`; `angles` keep 6 decimals (degrees; 3 put
a line-text glyph's angle outside the 1e-4° comparison, B8). Parsing sorts.
`masks` / `maskIdx` (§3.8) are projected together when present (an
error when only one is, or an index points past `masks`) and compared:
a mask present on one side only, or a region path that moved.

### 3.8 Filter masks

`masks: { regions: RenderPath[] }[]`, `maskIdx: Int32Array` (D3)

A **masked** pass (`maskIdx[i] ≥ 0`) is drawn only **outside every
region** of its mask: each region is a closed path read even-odd (a
region's hole ring is outside the region), and the mask is the
intersection of their outsides. The stream carries no frame — what
"outside" is bounded by is each backend's own (the image frame, the PDF
window, the stencil buffer's clear value). Masks are what clip-mode
filter regions produce (§4.11); a stream without them omits both fields.
`sortPassStream` permutes `maskIdx` with the passes; `maskIdx` is a
function of (object, colour) by construction (§4.11), so a backend that
draws per range-table entry can apply it there. Backends: §5.1
(nested clip groups), §5.2 ("Filter regions"), §5.3 (`W* n`).

## 4. Symbolisation rules

Status: slice B rules (B1, 2026-10-20) — every field of the IR that the
shipped libraries and the OCAD / OMAP importers produce has a rule here.
Proven by
`packages/shared/src/render/__tests__/{measure,dash,placement,pattern,text,symbolise,library-fixtures}.test.ts`
and in image form by `packages/api/src/render/__tests__/pilot-raster.test.ts`
and the golden tier (§6.2). Rules marked **provisional** reproduce the
documented behaviour of OCAD / Mapper from their field semantics and wait
for S2's pixel comparison against OCAD output (§8); the *structure* of
each rule (what is computed where, what the stream carries) is not
provisional.

IR fields the stage does not read: `minimum` (a course-setting and
print concern, not drawn).

New IR fields are **optional without defaults**: a parsed symbol must
stay byte-identical when they are absent, because map document hashes
(`docs/map-document-format.md`) and review-decision fingerprints
(`docs/map-symbols.md` §8) are computed over the parsed IR.

The stage's entry point is `symbolise({ objects, symbols, fonts, regions?, regionObjectLimit? })` in
`render/symbolise.ts` (filter regions: §4.11). An object is `{ symbolIdx, path, angleDeg?, text?, textLayout? }`;
a symbol is a `RenderSymbol` (`render/symbol.ts`, Zod-validated; the IR of
03 §6.2 with defaults applied). Unknown symbols, empty geometry, text
without text and text without a font produce a warning per object and no
passes — the stage never throws on data.

### 4.1 Arc length and sections

- Lengths along a path are computed by `PathMeasure` (`render/measure.ts`):
  lines exactly, cubics by uniform parameter sampling with
  `max(8, min(256, ⌈controlPolygonLength / 100 µm⌉))` pieces and linear
  inversion inside a piece. This is a fixed rule of the stage, so two
  backends get the same positions regardless of how they flatten.
- A **section** is the run between consecutive split points. Corner (4)
  and dash (8) points both split; a closed path without split points is
  one *closed-loop* section; a closed path with split points is cut at
  them only, and the piece from the last split point through the start
  point to the first one is **one** section (the start point is not an
  implicit split; it is one when it carries a flag itself). Lengths on
  that section run past the path's end and are folded back to its start
  (`wrapIntervals`, `wrapLength` in `render/measure.ts`). A point with
  both flags is a dash point. Each section knows whether its start and
  end are dash points (`Section.dashStart` / `dashEnd`).
- **Drawn intervals** of all sections are sorted and touching intervals
  merged: the two end dashes meeting at a corner are one drawn dash and
  become one slice round the corner, joined with the stroke's join, and
  the two halves of a dash on a dash point are one slice. Nothing merges
  across the start point of a closed path (a slice never wraps, §3.2).
- `shortenStartUm` / `shortenEndUm` shrink the first / last section of an
  open path before layout.
- **Gap points** (128): from one gap point to the next, the main stroke is
  not drawn. Intervals are subtracted after dash layout, so dashes keep
  their phase across the gap. An unpaired gap point at the last point
  runs to the end of the line.

### 4.2 Dash layout — `layout: "ocad"`

Per section, with dash `D`, gap `G`, gap count `n`, and an end dash at
each end of the section: `Es` at its start, `Ee` at its end. At a line
end or a corner the end dash is `E` (= `D` unless `endDashUm` is given);
at a **dash point** it is `D/2`, so that the halves on the two sides form
one ordinary dash centred on the point (§2.1: "a dash is centred here").

1. `n = round((L − Es − Ee + D) / (D + G))`, then `n = max(n, minGaps)`.
   On a closed loop both ends are `D/2` and `n ≥ 1`, so the two half end
   dashes meet at the start point and form one ordinary dash.
2. If `n = 0` the section is one solid dash (cut by the end gap like an
   end dash, or, when it touches a dash point, an interior dash left
   whole).
3. *Provisional (S2).* Otherwise **gaps keep their nominal length** and all dashes are scaled
   by one ratio `r = (L − n·G) / (Es + Ee + (n − 1)·D)` so the section starts
   and ends with a full end dash. The last dash is snapped to the section
   end. If even the gaps do not fit (`L − n·G ≤ 0`), `n` is reduced until
   they do.
4. `secondaryGapUm` splits every **interior** dash into `dashesInGroup`
   (default 2) equal parts separated by the secondary gap; `endGapUm` is
   the secondary gap applied to the **end** dashes at line ends and
   corners (OCAD's "end gap" — 507 footpath: `secGap 25, endGap 25`; 0 /
   absent leaves the end dashes whole; *provisional (S2)* as an OCAD
   reading). A dash on a dash point or on a closed loop's seam is
   interior and is split **whole** — the cut lies symmetrically about the
   point — before each side keeps its half.
5. A secondary or end gap forces the virtual grid: a pattern with
   `gapUm 0` and `secondaryGapUm > 0` (517 ruined fence) lays out
   touching dashes and cuts each one, so the line reads as a solid line
   with a short gap every `D`.

What stretches (step 3) and the end-gap reading are the provisional
part: the implementation keeps gaps fixed (visibly uniform gaps, varying
dashes, which is what OCAD maps show); if S2's comparison with OCAD
output shows OCAD scaling gaps too, step 3 changes and nothing else does.
Steps 1, 2, 4 and 5 and the dash-point rule are the stage's rule (B1,
2026-10-20): the closed-loop halves are the only seam-free choice, and
the secondary-gap and virtual-grid rules reproduce the ISOM 2017-2
drawings of 507 and 517 that the library is authored from.

**Grid.** Internally a section's layout is a *dash grid*
(`dashGrid` in `render/dash.ts`): the dashes in section-relative
lengths, with a dash on a dash point or a loop seam listed whole, so it
reaches past the section's end. Drawing clips the grid to the section
(a closed loop wraps it); placement (§4.5) takes centres from the grid,
and a dash or gap centred on a dash point belongs to the section that
**starts** there, so it is placed once.

### 4.3 Dash layout — `layout: "omap"`

Mapper's adjustment: a group is `k` dashes (`dashesInGroup`) of `D`
with `secondaryGapUm` between them; `n` groups and the breaks `B`
between them are **all scaled by one factor** `f = L / nominal`.

- Without half outer dashes: `n = max(1, round((L + B) / (group + B)))`,
  nominal `n·group + (n − 1)·B`. A line too short for one group still
  gets one (scaled-down) dash unless `showAtLeastOne` is `false`, in
  which case it is drawn solid.
- `halfOuterDashes`: the pattern is `D/2, B, [group, B]×n, D/2` with
  `n = max(0, round((L − D − B) / (group + B)))`.
- Closed loop: `n = max(1, round(L / (group + B)))` groups around the
  loop with the first group centred on the start point (its negative
  half wraps to the end).
- **Dash points**: a section end at a dash point begins / ends with half
  a dash — one dash of the pattern centred on the point — when
  `dashesInGroup` is 1 (Mapper halves single dashes only; a group starts
  whole at a dash point). Generally, with `hs`, `he` ∈ {0, 1} the half
  ends (from a dash point, or from `halfOuterDashes` at the other ends),
  the pattern is `half?, B, [group, B]×n, half?` with
  `n = round((L − (hs + he)·D/2 − (hs + he − 1)·B) / (group + B))`,
  `n ≥ 0` when both ends are halves and `n ≥ 1` otherwise, and the two
  bullets above are its `hs = he = 0` and `hs = he = 1` cases.

These rules follow Mapper's documented dashed-line behaviour and its
symbol fields (`dashes_in_group`, `in_group_break_length`,
`half_outer_dashes`, `show_at_least_one_symbol`, dash points); they are
the stage's rule for `layout: "omap"`, not provisional. S2's pixel
comparison checks them along with §4.2.

### 4.4 Strokes, halos, borders

- A line symbol's `main` stroke becomes one `StrokePass` on the object's
  own path (Béziers intact), with `slices` from §4.2/4.3 when dashed,
  shortened or gapped, otherwise no slices. `cap: flat` maps to `butt`.
- **Pointed caps**: with `cap: "pointed"` and `main.taper { startUm?,
  endUm? }` the pass carries `cap: "pointed"` and that `taper` (§3.2); the
  halo pass carries the same taper. The line is not shortened. Without a
  taper, or with another cap, the pass has no `taper`.
- **Corner radius** (`cornerRadiusUm`, OCAD rectangle symbols): before
  anything else the path's polyline corners are rounded
  (`roundCorners` in `render/geometry.ts`): each anchor between two
  straight segments becomes a circular arc of that radius written as one
  cubic (handles `4/3·tan(θ/4)·r` for a turn of θ), tangent to both
  edges. The tangent length is capped at half of each adjacent edge (the
  radius shrinks to fit); anchors next to Bézier control points, the
  ends of an open path, collinear points and reversals stay sharp; the
  arc's first point keeps the corner's flags. The object's coordinates
  in the document are untouched — the rounding is a drawing rule (user
  decision 2026-10-20, A12).
- A `main.halo` (OCAD line framing, the club sets' 502 band) is a
  **separate** stroke pass in the halo colour, width
  `main.widthUm + 2·halo.widthUm`, same slices, same caps. With
  `halo.continuous` the halo ignores the main line's dashes and
  shortening (OCAD framing is one solid line under a dashed main line —
  509 railway); gap points still interrupt it. It sorts to its own
  colour's position (03 §6.9 item 9) — nothing fuses it with the main
  pass. With `continuous`, `halo.widthUm` may be **negative** — an OCAD
  framing line narrower than its main line (user decision 2026-10-20):
  the thin solid line lies under the dashed main line and shows only in
  its gaps. A total width ≤ 0 emits no halo pass.
- **Borders** (`borders.left` / `right`, 502/509-style double lines) are
  stroke passes on an **offset polyline**: the main path flattened at
  5 µm and offset by `±shiftUm` (left = +normal in y-up) with mitred
  joins limited to 4× the offset, then bevelled. Border paths are
  therefore polylines, not Béziers — a stage decision, identical in every
  backend and invisible on paper.
- A dashed border is laid out on the **main** line's sections and the
  intervals transferred to the offset path proportionally
  (`× L_border / L_main`), so both borders and a dashed main line share
  phase (item 6). `noLeft` (32) / `noRight` (64) points suppress the
  respective border from that point to the next point.
- `borders.backgroundColour` becomes a stroke of width
  `backgroundWidthUm` — default `left.shiftUm + right.shiftUm` — in that
  colour (on the main path when the shifts are symmetric or an edge is
  missing, else on the centre offset). OCAD's double-line fill is
  `dblWidth` wide, between the edges, so the importer sets
  `backgroundWidthUm` explicitly; a band without edges is allowed.
- `borders.extraPairs` (Mapper combined symbols with a second pair of
  borders, 502.2) are drawn exactly like `left` / `right`, each with its
  own shift, width and dash (phase from the main line), after the first
  pair; they take no part in the background band. A separate list rather
  than arrays on `left` / `right` keeps every existing reader of the IR
  (the matcher's fingerprints) unchanged.

### 4.5 Glyphs on lines

Placement (`render/placement.ts`) yields `(length, angle, scale)` per
glyph; the instance transform is the point at that length with
`cos/sin` of the angle (tangent angle when the glyph is `rotatable`,
0 otherwise).

| `placement.at` | Rule |
|---|---|
| `start` / `end` | the path's ends, tangent angle |
| `corners` / `dashPoints` | every point with flag 4 / 8, at the **bisector** of the incoming and outgoing tangents; an open path's ends only when they carry the flag (at the tangent angle), and never with `ignoreEnds` (user decision 2026-10-21, B9: OCAD's corner symbol and Mapper's dash symbol are drawn at flagged vertices only — Mapper's `line_symbol.cpp` draws flagged ends unless `suppress_dash_symbol_at_ends`; the earlier "ends unless `ignoreEnds`" put a pole on every end of club-2026's 510); on a closed path the start point only when it carries the flag. `scaleAtCorners` scales by `1 / cos(turn/2)` (mitre length), clamped at 4× |
| `dashCentres` / `gapCentres` | centres of the dashes / gaps of the main stroke's dash layout per section. The layout is run in *virtual* mode so a solid line (`gapUm 0`) with spaced symbols — OCAD's 516 power line — still gets positions: with zero gaps the dashes touch and the glyphs sit at the joints. Centres come from the section's dash grid (§4.2): a dash on a dash point, or on a closed loop's seam, gets **one** glyph, at the point |
| `dashGroupCentres` | centre of each dash **before** its secondary split, i.e. in the secondary gap (OCAD's main symbol on a line with `secGap` — 517 ruined fence); only dashes that are actually cut get a glyph (end dashes only with `endGapUm`); without any secondary gap it equals `dashCentres` |
| `sectionCentres` | once per corner-delimited section, at its midpoint (OCAD's secondary symbol) |
| `spaced` | Mapper semantics per **corner** section (dash points do not restart spacing): `first = firstUm ?? distance/2`, `last` likewise, `inner = L − first − last`; `n = round(inner / distance) + 1` (0 if `inner < 0`), `n = max(n, minCount)` (`minCountClosed` on closed paths); spots at `first + i·inner/(n − 1)`, a single spot centred. On a closed loop: `n = max(minCount, round(L / distance))` spots every `L/n` from the start point. `perSpot` glyphs are spread `spotSpacingUm` apart symmetrically around the spot |

### 4.6 Point symbols and the glyph table

- IR glyph parts become one `GlyphMesh` per part (`render/glyph-table.ts`):
  `fill` → closed path; `stroke` → path + width/cap/join; `disc` → a
  four-cubic Bézier circle fill; `ring` → the same circle stroked at
  radius `(diameter − width) / 2` (diameter is the outer diameter).
- A pass per part, in the part's colour, with one instance per
  placement; the same `Glyph` object registers once.
- A point object's angle applies only when `orientation` is `object`
  and the glyph is `rotatable`; otherwise the glyph is north-up. The
  OCAD importer turns a north-oriented symbol whose objects carry an
  angle into `object` (`map-import.md` §3.3, `ocad-15`, C10), so this
  rule and OCAD's drawing agree.

### 4.7 Areas: fill, hatch, pattern, border

- `fill` → one even-odd `FillPass` on the object's path; an open area
  path is treated as closed.
- Each `hatches[]` entry → one `HatchPass` with the symbol's width,
  spacing, offset and `angleDeg + objectAngle` (object angle ignored
  when `rotate: never`). Two directions are two passes.
- `patterns[]` → glyph passes with instances from `render/pattern.ts`
  (§4.8). In mode `clip` the pass carries the area as `clip`.
- `border` (OCAD border symbol / OMAP combined part) is symbolised as a
  line symbol on the closed path.

### 4.8 Pattern grids and clip modes

- The grid is anchored at the **paper origin**, rotated by
  `angleDeg + objectAngle` (object angle ignored when `rotate: never`),
  cell `(w, h)`, offsets `(offsetX, offsetY)`; `shiftedRows` moves every
  odd row by `w/2`. Because the anchor is the origin and not the object,
  adjacent areas with the same symbol and angle share one grid.
- Candidate cells are those over the area's bounds (in grid space,
  padded by the glyph's extent). Inclusion, with the glyph's ink extent
  as an axis-aligned box rotated with the grid:
  - `centreInside` — the cell centre is inside the area (even-odd over
    all rings);
  - `completelyInside` — all four box corners inside and no area edge
    crosses the box;
  - `partiallyInside` — the centre or any corner inside, or an area edge
    crosses the box;
  - `clip` — same predicate as `partiallyInside`; the backend clips the
    glyph geometry to the area (stencil / clip path).
  The inclusion polygon is the area flattened at 5 µm. Points exactly on
  the boundary are not defined (the ray-casting test decides); fixtures
  avoid them.
- Implementation: a **scanline in grid space**. The rings are rotated
  into grid space once; for each candidate row the ring/scanline
  crossings give the inside spans for the centre and corner tests, and
  the edges that intersect the row's band are projected onto the cells
  they cross (exact segment/box test). Cost is O(rows × edges) instead
  of O(cells × edges); on the Sprint map's 213 areas this took the
  pattern stage from 82 ms to 1.5 ms. Results are identical to the
  per-cell test — the predicates above are the contract, the scanline is
  how they are evaluated.

### 4.9 Text

- Font resolution: the first font in `fonts` whose `family` matches the
  symbol **and** whose face matches (`weight ≥ 600` is bold, `italic`),
  else the family's first font — silently, the face-level analogue of the
  importer's `FONT_SUBSTITUTED` (Sans ships Regular and Bold, Narrow Regular only, §4.10; a bold symbol of a family without a bold face draws regular). A face
  is read from `head.macStyle` (bit 0 bold, bit 1 italic) and recorded in
  the stream's `FontRef`. A family with no font loaded draws nothing
  (`NO_FONT`). Fonts are read by the
  shared TrueType reader (`render/truetype.ts`: `head`, `hhea`, `hmtx`,
  `maxp`, `cmap` 4/12, `kern` 0, `loca`/`glyf` incl. composites), so
  shaping and outlines come from the same numbers on every side.
- Em size: `digitHeightUm · unitsPerEm / font.digitHeight` when the
  symbol is specified by digit height (ISOM 704 "4.0 mm"), where
  `digitHeight` is measured from the outline of "0"; otherwise
  `fontSizeUm`.
- Shaping (`render/text.ts`): left-to-right, pen advance =
  `advance(glyph)·k + kerning(prev, glyph)·k + charSpacing·em`
  (+ `wordSpacing·em` after a space), `k = em / unitsPerEm`. Spaces
  advance but are not emitted. Lines split on `\n`, baseline-to-baseline
  `lineSpacing · em` downward. Alignment shifts each line by `0`,
  `−width/2`, `−width` for left / centre / right (justify = left for
  block text). Paragraph spacing and line breaking belong to box text
  (below).
- **Tabs** (U+0009): the pen jumps to the first of the symbol's
  `tabStops` (µm from the line start, before alignment) strictly beyond
  it, else to the next multiple of 8 space advances — *provisional
  (S2)* as OCAD's and Mapper's default interval. A tab draws nothing and
  is not kerned against its neighbours; a line ending in a tab is as
  wide as the pen after it.
- **Three layouts**, chosen per object by `RenderObject.textLayout`,
  which the render bridge sets from the object type
  (`map-document-format.md` §8): absent = **block text** from the first
  point (OCAD type 4, Mapper single-anchor text); `box` = **box text**
  (OCAD formatted text, type 5; Mapper box text, stored as type 5,
  `map-import.md` §4.2); `path` = **line text** (OCAD type 6). A box
  whose path has fewer than four points (or a zero width), and a path
  with fewer than two, fall back to block text from the first point,
  without a warning.
- **Box text**: the first four points are the corners bottom-left,
  bottom-right, top-right, top-left; the box is `|c1 − c0|` wide and
  `|c3 − c0|` high, its origin is the top-left corner `c3`, and it turns
  with the object angle (OCAD stores rotated corners, so the corners give
  only size and origin). Each `\n` starts a paragraph; a paragraph wraps
  greedily: a line ends before the word (a run between spaces / tabs)
  whose last glyph's ink would cross the width; a word wider than the
  box breaks per glyph (at least one glyph per line); spaces at a wrap
  are dropped, a tab is not (a tab that is the wrap point starts the
  next line and moves its first word to the stop, as Purple Pen does); a
  break before a line's first glyph does not count, so a line that
  starts with a space or tab and whose first word does not fit breaks
  per glyph. Lines are `lineSpacing · em` apart and paragraphs a
  further `paragraphSpacingUm`. Alignment is inside the width (`0`,
  `(W − w)/2`, `W − w`); `justify` widens every space of a line so the
  line fills the width, except on a paragraph's last line (which is
  left). Vertically the anchor is the box's top edge: absent, `baseline`
  and `top` put the first line's ascent on it; `middle` centres the
  block (first ascent to last descent) in the box height; `bottom` puts
  the last descent on the bottom edge — *provisional (S2)*: Mapper and
  Purple Pen read an OCAD box as starting one internal leading
  (`ascent + |descent| − em`, 0.12 em for Liberation Sans) lower (§8).
  Text that overflows the box is drawn, not clipped.
- **Line text**: one line along the path; `\n` and tabs read as
  spaces. Glyph cells are `advance·k + charSpacing·em` (+ `wordSpacing`
  for a space) plus the kerning to the next glyph. Each glyph's origin is
  the point at its pen distance along the path and the glyph turns to
  the chord from there to the point one cell further (clamped to the
  path end) — Purple Pen's reading of OCAD. Text longer than the path is
  truncated as OCAD does: cells are taken until their sum comes within
  10 µm of the path length (no sliver of a cell at the end); `left`
  keeps the cell that crosses it, `right` drops that cell, `centre` keeps
  it but centres without it. `justify` takes every cell and spreads
  `L − w` evenly over the gaps between cells (the last cell without its
  `charSpacing`) — negative when the text is longer than the path, so the
  cells close up rather than being cut. Start offset `0` / `(L − w)/2` /
  `L − w` for left / centre / right. `verticalAlign` moves the baseline
  across the path, turned with each glyph: `baseline` (absent) on it,
  `top` one digit height below, `middle` half that, `bottom` the
  descender above. Arc length is Euclidean — *provisional (S2)*:
  Purple Pen measures OCAD line text with `max + min/2` of the
  coordinate deltas (§8). The object angle is not used.
- **Rectangle frame** (`frame`, OCAD framing mode 3): one `fill` pass in
  `frame.colour`, a rectangle in the text's own frame grown by
  `leftUm` / `bottomUm` / `rightUm` / `topUm` and turned with the text.
  Its extent is the widest line's span (block text) or the box width
  (box text) horizontally, and from the first line's digit height above
  its baseline down to the last baseline vertically (Purple Pen's
  reading of OCAD, which frames from the cap height to the baseline).
  Line text has no frame. It sorts at its colour's position like a halo.
- **Vertical anchor** (`verticalAlign`, absent = `baseline`): the anchor
  is on the first line's baseline; `top` puts it at the first line's
  ascent (the first baseline drops by `ascender·k`), `bottom` at the last
  line's descent (the block rises by `(lines − 1)·lineSpacing·em +
  |descender|·k`), `middle` midway between those two. Ascender and
  descender are the font's `hhea` values (Liberation Sans 1854 / −434 at
  2048 units per em) — *provisional (S2)* as OCAD's and Mapper's reading
  of "top" and "bottom".
- **Rotation**: the whole block rotates about the anchor by the object
  angle — every glyph origin is rotated, and every glyph is turned by the
  same angle (`TextPass.angles`, §3.5; absent when the angle is 0).
- A `halo` is a separate `TextPass` in the halo colour with
  `haloWidthUm`, identical glyphs and positions. Sorted by colour it
  lands at the halo colour's stack position — the ISSprOM 704 white
  outline is "upper white", one below upper purple.
- A `shadow { colour, offsetXUm, offsetYUm }` is a separate `TextPass`
  in the shadow colour with every glyph origin moved by the offset —
  paper µm, y-up, turned by that glyph's own angle (so it follows line
  text round its path) — drawn as a plain fill (no `haloWidthUm`). It
  sorts at its colour's position like a halo.

### 4.10 Fonts shipped

`packages/shared/fonts/` holds Liberation Sans Regular, Liberation Sans
Bold and Liberation Sans Narrow Regular from the Liberation **1.07** series — the only series
with the Narrow face (metric-compatible with Arial Narrow, which the
corpus uses). Note the licence: 1.07 is GPLv2 with the font-embedding
exception, not the SIL OFL of Liberation 2.x as 04 §4.4 assumed; both are
compatible with Oxygen's AGPL and with embedding in PDFs. `LICENSE` in
the directory is the upstream text and covers all three files (the Bold
is taken from 1.07 too, byte-for-byte the series of the Regular, so one
licence covers the directory). Bold exists for Sans only; Narrow has no
bold face and a bold Narrow symbol draws in Narrow Regular (§4.9). The
server loads the faces through `packages/api/src/render/fonts.ts`
(`loadBundledFonts()` / `bundledPdfFaces()`, regular before bold), the
viewer through `packages/web/src/lib/map-fonts.ts`. A face is identified
by family **and** `bold`: the PDF writer embeds Sans Bold as its own font
object (`…+LiberationSans-Bold`), the arena path's glyph lookup keys
`family[/bold]/glyphId`, and the geometry caches likewise.

`packages/shared/fonts/msdf/` holds the WebGL2 backend's **text atlas**
(§5.2 "Text atlas"), generated from these three files and committed:

| Page | Code points | Image | Glyphs (Sans + Narrow + Bold) |
|---|---|---|---:|
| `text-atlas.latin.{png,json}` | ASCII U+0020–007E, Latin-1 Supplement U+00A0–00FF, Latin Extended-A U+0100–017F, general punctuation U+2010–2027, € U+20AC | 900 × 900 | 334 + 334 + 334 |
| `text-atlas.cyrillic.{png,json}` | Cyrillic U+0400–04FF (what the faces have: U+0400–045F, 0472–0473, 0490–0491) | 516 × 516 | 100 + 100 + 100 |

All three faces share each page; the Bold face is marked `"bold": true` in the JSON. MTSDF (RGB multi-channel signed distance,
A true signed distance), 32 px per em, distance range 8 px (0.25 em),
keyed by **glyph id** (what a `TextPass` carries); a glyph on the Latin
page is not repeated on the Cyrillic page; empty glyphs (space) have no
entry. The JSON records per face (`family`, `bold`) the TTF's SHA-256 and `unitsPerEm`,
and per glyph its plane bounds (em, y-up, relative to the glyph origin,
including half the range) and atlas bounds (px, top-left origin).

Regenerate after changing a font file or a page's ranges:

```bash
pnpm text-atlas:generate
```

`packages/web/scripts/generate-text-atlas.ts` computes each page's
glyph ids with the shared TrueType reader, runs `msdf-atlas-gen` v1.4
(Chlumsky, built from the pinned tag by
`packages/web/scripts/text-atlas/Dockerfile` in a throwaway image —
no native toolchain on the host, the same pages on every machine) with
`-type mtsdf -size 32 -pxrange 8 -yorigin top -seed 0 -threads 1`, and
turns its JSON into the committed table (`map-gl/text-atlas-build.ts`).
Output is byte-identical across runs. `map-gl/__tests__/text-atlas.test.ts`
fails when the committed pages no longer match the fonts (hash) or the
ranges (a glyph the font has that no page holds).

### 4.11 Filter regions

A **filter region** (research 04 §7, 08 §4.5 `filter_region`; D3)
removes chosen map symbols inside a polygon — "no contours in this
quarry", "no paths in the arena", or a map-simplification area that
shows only a few symbols. Regions are course-layer data: they enter the
stage with the course layer and act on the symbolised stream, so screen
and print get the same result by construction. `render/filter-region.ts`:

```ts
interface FilterRegion {
  path: RenderPath;                                   // closed polygon, paper µm; holes as `hole` rings
  mode: "clip" | "hide";
  symbols: "all" | number[] | { colours: number[] };  // the selection
  invert?: boolean;
}
```

**The props** — what D2 stores and D5's tool edits (coordinator decision
2026-10-31, the research reading of 08 §4.5):

- `symbols` **selects passes**: `"all"`; or the passes of the listed
  symbol indices (indices into the symbolised input's `symbols` — the
  document's own symbol list, which `courseRenderInput` keeps at the
  same indices); or the passes in the listed colour-stack indices.
- `invert` is the **complement of the selection**: the region acts on
  every pass the selection does *not* name — "map simplification: show
  only these symbols inside". It never flips the side: a region always
  removes **inside** itself.
- `mode: "clip"` cuts the selected passes at the boundary: each gets a
  mask (§3.8) whose regions are every clip region selecting it, so the
  pass draws only outside them. A clip region masks a pass only when the
  pass's object's symbolised bounds meet the region's bounds, which
  keeps masks off far-away objects and keeps `maskIdx` a function of
  (object, colour).
- `mode: "hide"` drops **whole objects**: an object is hidden when any
  of its passes is selected and its symbolised geometry **meets** the
  region. Its passes leave the stream; `symbolise` returns the object
  indices as `hidden`. A clip region does not mask a hidden object.

**The exact predicate** (`passMeetsRegion`): paths flattened at
`REGION_FLATTEN_UM` (10 µm), region rings likewise; a pass meets the
region when a vertex of its path lies inside the region (even-odd), an
edge of its path crosses or touches a region edge, or — areas only
(fills, hatches, a pattern pass's clip area) — a region vertex lies
inside the area. A stroke counts by its centre line (not its width), a
glyph pass by its instances' origins, a text pass by its glyph origins.
**The fast predicate** (`boundsMeetRegion`, 04 §7 "while dragging"):
the object's symbolised bounds (`objectBounds`: control-point bounds
grown by half a stroke width, glyphs by their mesh radius × scale, text
by each glyph origin grown by the em size plus the halo width) meet the
region — a bounds corner inside it, a region vertex inside the bounds, or
an edge crossing. `filterStream(stream, regions, { fast })` uses it for
`hide` while a region is dragged; the exact predicate runs on release
(08 §4.5). On the fixture scenes the two agree (§6.3).

**Only document objects** are filtered: `regionObjectLimit`
(`courseRenderInput` sets it to the document's object count) protects
the course layer drawn over the map. A region with fewer than three
points draws nothing and warns `FILTER_EMPTY_REGION` (`objectIdx` −1,
`region` its index). `filterStream` is pure and deterministic (masks
numbered in stream order); the WebGL2 worker runs the same function on
its document stream (§5.2 "Filter regions").

**Entry.** `CourseLayerInput.regions` (`docs/course-layer.md` §2) takes
regions in paper mm — rings of `MapPoint`, outer first — with document
colour indices; `courseLayer()` converts them to µm paths (hole flags on
the later rings) and re-indexes colours onto the completed stack
(`CourseLayer.regions`); `courseRenderInput()` returns them with
`regionObjectLimit`; the page composer passes them to `symbolise`
(`PageInput.course.regions`). Stored regions are `filter_region` course
objects (`docs/course-layer.md` §8): the layer appends each one in
`objects` to the explicit `regions`, so the viewer's request and the
print route carry them as objects. A corridor's white band is a
**generated** region the layer appends after those
(`docs/course-layer.md` §10.2): `clip`, `symbols: "all"`, the band's
rings — the map cut away there, the course drawn over it.

## 5. Backends

### 5.1 Reference raster (api: tests and previews)

`packages/api/src/render/reference-raster.ts`:
pass stream → SVG (`render/reference-svg.ts`, shared) → RGBA via
`@resvg/resvg-js`. The SVG serialiser has no symbolisation logic: every
pass becomes one element (or one `<g>`) in stream order, in µm, inside a
single `scale(1 −1)` group. Slices become subpaths of one `<path>`;
glyph parts become one `<g id>` per (glyph, part, colour) and one `<use>`
per instance; hatches are generated lines under a `<clipPath>`; text uses
caller-supplied glyph outlines or, without them, em boxes (debug only,
never an oracle). A `pointed` stroke with a `taper` is the shared
`strokeOutline()` (`render/geometry.ts`) filled non-zero, as the PDF
backend draws it (§5.3; SVG has no tapered stroke). A masked pass (§3.8)
is wrapped in one `<g clip-path>` per region of its mask, nested; each
`<clipPath>` is the image frame (the viewBox rectangle) with the region's
rings, `clip-rule="evenodd"` — so the pass shows outside every region.
A mask's clip paths are defined once.

This is the **oracle** of the golden-image tier. It is slow and simple on
purpose and is never used to draw a map for use. Its production jobs
are previews (04 §4.1, 06 §5.2): document thumbnails and symbol swatches,
rendered once and stored as cache (`docs/map-storage.md` §4.5). Its
second, interim job — the layout editor's `window.png` of a pinned
document — went with the route in E4a (`docs/course-print.md` §10). PNG
encoding is `encodePng` (sharp) in `render/reference-raster.ts`; the
preview renderers are `render/previews.ts`.

#### 5.1.1 Symbol swatches

One `RenderSymbol` drawn in isolation, so a reviewer compares a source
symbol with its canonical candidate like with like. The scene is built
by `swatchScene(symbol)` in `packages/shared/src/render/swatch.ts` —
pure, shared, the same function for a document's source symbol and a
library entry — and drawn by the reference raster. Nothing about the
symbol is special-cased: the scene is ordinary `RenderObject`s through
`symbolise`.

| Kind | Sample object (paper µm, y-up) | Minimum frame |
|---|---|---|
| point | one point at (0, 0), angle 0; the symbol is `scaleRenderSymbol(symbol, 3)` — every length ×3, so minimum-size rules scale with it | 12 × 12 mm centred on the point |
| line | open polyline (0, 0) → (12 000, 0) → (27 588, 9 000): 12 mm, a **corner** (`COORD_FLAG.corner`) at the second vertex, then 18 mm at 30° with a **dash point** (`COORD_FLAG.dash`) inserted 10 mm after the corner at (20 660, 5 000) — 30 mm in total | sample bounds |
| area | closed square (0, 0)–(15 000, 15 000), angle 0 (pattern and hatch angles as authored) | the square |
| text | one point at (0, 0) carrying the text `Abc 123`, angle 0, at the symbol's own size | — |

Frame: the union of the kind's minimum frame and the stream's bounds,
plus a 1 mm margin, grown symmetrically to a whole number of pixels as
`goldenFrame` does (§6.2). Density 10 px/mm (`GOLDEN_PX_PER_MM`), no
supersampling, background `#f0f0f0` — a light neutral grey rather than
paper white, so white ink, halos and knock-outs stay visible. Colours
are the caller's colour stack through `cmykToHex`: the document's own
stack for a source symbol, the library's palette edition for a library
entry. Fonts are the bundled faces (§4.10); a text symbol whose family
is not bundled draws nothing (the `NO_FONT` warning).

The thumbnail is not a swatch: it is the whole document, `docs/map-storage.md` §4.5.

**resvg abort.** `@resvg/resvg-js` 2.6.2 aborts the whole process (a
Rust panic in `geom.rs`, not a JavaScript error) on some clipped groups
lying wholly outside the canvas — first seen on the sprint corpus map's
print window. The serialiser therefore leaves out every hatch and every
clipped glyph pass whose clip bounds do not meet explicit `bounds`; such
a group draws nothing, so pixels are unchanged. Swatches cannot hit it
(their frame contains the stream); thumbnails of a print window can.

Tests: `packages/shared/src/render/__tests__/swatch.test.ts` (sample
geometry per kind, flags, 3× point, whole-pixel frame, determinism,
every entry of both shipped libraries symbolises without warnings);
`reference-svg.test.ts` (off-frame clip groups left out, partly
overlapping kept; a tapered pointed stroke is the `strokeOutline` path
filled non-zero, a pointed one without taper a butt stroke; a masked pass
nested in one frame-with-hole clip group per region, shared clip paths);
pixel probes in `packages/api/src/render/__tests__/previews.test.ts` and,
for the filter scenes, `reference-raster.test.ts` (a contour cut inside the
pentagon and drawn outside it; the hidden footpath absent along its whole
length; the 407 hatch cut by "show only").

### 5.2 WebGL2 (web)

`packages/web/src/map-gl/`, with hard lines between the files:

```
worker.ts      document bytes ──► stream ──► atlas, buckets,      pure TS, runs in a Web Worker
               resident layers; detail parts on request           (worker-entry.ts binds it)
prepare.ts     geometry builders: flattening, indexed strips,     pure TS, typed arrays, no GL
               even-odd earcut; the per-pass fan path (goldens)
mesh-atlas.ts  glyph parts ──► one float texture                pure TS
text-atlas.ts  committed MSDF pages ──► glyph lookup (worker),    pure TS
               glyph table (renderer), page selection
buckets.ts     cells, large bucket, per-part preparation +        pure TS
               range table, visible set, clip groups, LRU, gate
arena.ts       vertex arenas: free list, grow by re-upload        GL buffers
engine.ts      main thread: worker transport, residency,          no GL calls of its own
               visible-set rebuilds
renderer.ts    arena programs + visible-set draw loop;            WebGL2
               the per-pass path (`setStream` / `render`)
```

Status: B2 — strips, arenas, buckets, visible set, mesh atlas, worker,
screen-only LOD; B3 — MSDF text from the committed text atlas; B4 — the
viewer drives it (§5.4). Not yet: `WEBGL_multi_draw` (§8). The per-pass path (`setStream` / `render`: one draw per pass,
stencil fills) is kept unchanged as the backend's golden path
(`MapGlFixturePage`, §6.2) and as the reference the arena path is
compared with (`compare=1`, below). The S1 batch path (`batch.ts`,
`setBatches` / `renderBatches`) is gone; its measurements are the
"S1" columns of the tables below.

#### Preparation (CPU)

Backend decisions only — nothing here moves a dash or a glyph:

| Pass | Becomes | How |
|---|---|---|
| fill | fill-arena vertices + triangle indices | rings flattened (10 µm); **even-odd earcut**: rings grouped by containment depth (`triangulateEvenOdd`) — a ring inside an even number of others is an outer boundary, one inside an odd number a hole of its innermost container, so a "hole" ring outside every other ring is filled and separate contours are separate polygons, exactly §3.1's rule. A ring that crosses (or touches) a **convex** ring is resolved first (P7; the white-out outside's window quad and its shape). **Two rings** — every white-out outside, one pass per shape — are triangulated exactly without earcut holes (`convexPairTriangles`): the convex ring outside the shape is earcut of a box round both with the shape as a hole that touches nothing, each triangle clipped to the convex ring; the shape outside it is the shape's earcut triangles, each cut by the convex ring's edges (convex against convex, no bridges, no inset). **More rings**: the crossing ring is replaced by its parts inside and outside the convex ring (each line clip cut into simple rings at its crossings), a part inside equal to the whole convex ring toggling it out, and containment is probed at a boundary point of each ring that lies on no other ring instead of its first vertex; the parts inside touch the convex ring, which earcut may drop at fractional coordinates — best effort, no producer emits it. The crossing test returns at once when every vertex of the other ring lies strictly inside the convex ring, and otherwise filters that ring's edges against the convex ring's bounds first (a 5 000-vertex ring round 100 convex 32-vertex holes: 7.6 ms against 6.4 ms before P7; a 64-vertex hull inside its window: 13.5 µs against 12.4 µs). Without a crossing the rings are triangulated as before. Two non-convex rings that cross are earcut's failure mode and drawn as earcut decides (the reference raster is the oracle) |
| stroke | stroke-arena vertices + indices | each slice (or ring) flattened from its Bézier sub-range, then an **indexed strip** (`extrudeStrip`): per vertex the centre-line point and an offset direction; the shader multiplies by the half width |
| glyph | an instance per placement into the mesh atlas | the `GlyphMesh` in glyph-local µm at ¼ tolerance, fills triangulated even-odd, strokes as strips expanded to triangles; instance `x, y, cos, sin, scale` as in the stream plus the mesh's atlas `base, count, radius` |
| glyph with `clip` | instances + the clip area triangulated even-odd | drawn through the stencil (Drawing, below) |
| hatch | hatch-arena vertices + indices | the area triangulated like a fill; each vertex carries the stripe normal, spacing, offset and half width so hatches of one colour are one draw |
| text | a quad instance per glyph from the text atlas | the glyph's (family, glyph id) looked up in the loaded pages (Text atlas, below); instance `x, y` the glyph origin, `cos, sin` from the glyph's `angles` entry (§3.5; upright without), the em size, the glyph-table entry and the halo half width in em (0 on a fill pass); grouped by (colour, page). A glyph no loaded page holds is not drawn (`TEXT_GLYPH_NOT_IN_ATLAS`) |

**Indexed strips (S1 §4.1).** A polyline point shares **one vertex pair**
between its two segments — offset ± the mitre vector — when that is
within `JOIN_SHARE_TOLERANCE` (1 % of the half width; 0.7 µm on a
0.14 mm contour, 10 µm on a 2 mm line) of the exact join: always for a
mitre join inside the 4× limit, for a round join while `sec(θ/2) − 1 ≤ 1 %`
(turns up to ~16°), for a bevel while `sec(θ/2) − cos(θ/2) ≤ 1 %`, and
only while the inner mitre point stays on both neighbouring segments
(`hw · tan(θ/2) ≤` either segment's length). Flattened curves are almost
all such points, so a stroke is ~2 vertices per point. At a real corner
the segments get their own pairs and a join wedge: mitre (4× limit, then
bevel), bevel, or round at 8 steps per π. Caps: butt, square (end pairs
pushed out by a half width), round (half-circle fan); `pointed` is drawn
butt until the taper is consumed (§8). Coverage equals S1's
triangle-list extrusion everywhere except within the 1 % band at shared
joins (the unit test compares coverage outside a band of 3 % of the half
width: the 1 % plus the sampling step). The flattening tolerance stays 10 µm at every zoom.

**Coordinates** (decided with the user, 2026-10-21). Arena positions
are float32 **relative to the document origin** — the centre of the
bucket grid — with one origin for every bucket; the view matrix (Drawing)
is built relative to it in float64 on the CPU. On Club-full (± 585 mm
from the origin) the float32 step is 0.06 µm: ≈ 0.03 px at 20× paper on
a 2.625-DPR phone (unit test, in float32 arithmetic). This replaces
04 §6.10's int16 bucket-relative positions: a visible-set draw spans
many buckets, so there is no per-bucket draw to carry a bucket matrix,
and the large-object bucket spans the whole map, which int16 at 10 µm
(± 327 mm) cannot hold. The precision fixture of 04 §8 ("+ Precision")
is the trigger to revisit.

Vertex layouts (`buckets.ts`):

| Arena | Bytes | Layout |
|---|---:|---|
| fill | 8 | f32 x, y |
| stroke | 16 | f32 x, y · i16 ox, oy normalised by the mitre limit · u16 half width in ½ µm (≤ 32.7 mm) · u16 pad |
| hatch | 28 | f32 x, y, nx, ny, spacing, offset (origin-relative), half width |
| atlas | 32 per mesh vertex | two RGBA32F texels: (x, y, ox, oy), (half width, 0, 0, 0); fill vertices have zero offset and width |
| instance | 32 | glyph: f32 x, y, cos, sin, scale, atlas base, count, radius · text: f32 x, y, cos, sin, em size (µm), glyph-table entry, halo (em), 0 |
| glyph table | 64 per text glyph | four RGBA32F texels: plane l, b, r, t (em) · uv u0, v0, u1, v1 · page, range (em), 0, 0 · 0 |
| text page | 4 per atlas pixel | RGBA8, `LINEAR`, no mipmaps: Latin 3.2 MB, Cyrillic 1.1 MB (three faces, C8) |

The stroke vertex is 16 B rather than 04 §6.2's 8 B: widths mix inside
one visible-set draw, so the half width is a per-vertex µm value rather
than a uniform × factor, and the position is float32 (above). Against
S1's 20 B × 6 vertices per segment the strip stores ~2 × 16 B per point
(measured below).

#### Arena and buckets

Constants (`buckets.ts`; 04 §6.11):

| Constant | Value | Rule |
|---|---|---|
| `CELL_UM` | 50 000 µm | paper cell, aligned to multiples of 50 mm from the paper origin, every scale |
| `LARGE_CELLS` | 2 | an object whose bounds exceed 2 cells in x or y goes to the large-object bucket |
| `DRAW_MARGIN_CELLS` | 1 | cells meeting the viewport (bounding box of the rotated canvas) + 1 are drawn — an object reaches at most one cell beyond the cell of its centre |
| `PREFETCH_MARGIN_CELLS` | 2 | cells meeting the viewport + 2 have their detail requested, nearest first |
| zoom gate | 0.14 mm line < 0.15 device px | `140 µm × pxPerUm < 0.15`: ordinary cells' detail is neither drawn nor prepared — 0.28× paper at 1× DPR, 0.14× at 2× |
| budget | 30 MB event map, 150 MB club map | `EVENT_BUDGET_BYTES`, `CLUB_BUDGET_BYTES`; the caller picks (B4 from the document's provenance); default 150 MB |
| hairline floor | 1 device px | strokes thinner are drawn 1 px wide with alpha × true width (Drawing) |
| glyph skip | 2 device px | instances whose mesh diameter × scale is smaller are not drawn |
| text skip | 4 device px | text whose em (`sizeUm × pxPerUm`) is smaller is not drawn (04 §6.11); `minTextPx` |
| hatch tint | 1.5 device px | stripes closer than this become a tint of coverage `width / spacing` |
| `ARRIVAL_REBUILD_MS` | 150 ms | arriving detail rebuilds the visible set at most this often while more drawn detail is pending |
| arena growth | 1.25× | into a new buffer by re-uploading every live range from the views `put` received; offsets never move. Not `copyBufferSubData`: ANGLE on Adreno copies zeros from a buffer with in-flight draws (`docs/bugfix-adreno-arena-grow.md`) |

**Assignment.** Every object goes, whole, to the cell holding the centre
of its symbolised bounds (`passBounds`: path bounds + half width × the
mitre limit for strokes, mesh radius × scale for glyphs, the em box and
halo for text — for turned text, a pass with `angles`, a square of
√2 em + halo round each origin, since a glyph turned up to 180° along a
path reaches its em box's far corner in any direction, B8), or to the
large-object bucket. All of an object's passes
share its bucket, in stream order. An object is never duplicated into
the cells it overlaps; the draw margin is what makes that correct.

**Layers.** A cell is prepared as two parts: `base` — its fills and
hatches, prepared for every cell when the document loads and always
resident (the "fill set" of 04 §6.11) — and `detail` — strokes, glyphs,
text, clipped patterns — prepared on demand above the zoom gate and
evicted LRU. The large bucket is one `all` part, prepared at load and
always resident. Below the gate a frame draws the base parts of the
cells in view and the large bucket.

**Range table (04 §7).** A part keeps, per kind, its geometry and a
table of entries `(colour, group, object, start, count)`: colour-major
(the stream's order), one entry per run of an object's indices — or
instances, where `group` is the atlas size class (glyphs) or the text
atlas page (text). Entries of one colour
are contiguous, so a colour of a part is one span. `object` is the
document's effective `objectIndex` ("Object identity and the patch"
below); the course part's start at `COURSE_OBJECT_BASE`.

**Visible set (04 §6.8 point 2).** `buildVisibleSet(parts, hidden)`
concatenates the drawn parts' spans per (colour, kind) into one index
buffer per indexed kind (rebased onto each part's arena offset) and one
instance buffer per instanced kind, grouped by (colour, size class) —
for text (colour, page). Draws per frame = colours in view × kinds
present + size classes + text pages + 3 per clip group — independent of how many buckets are in view. It is rebuilt
when the drawn cell set or the gate state changes, when detail of a
drawn cell arrives (coalesced, `ARRIVAL_REBUILD_MS`), and when the
hidden set changes; never while zooming within the same cells. Hidden
objects (`engine.setHidden`, effective `objectIndex`; a patch's hidden
objects and a filter's join them) are skipped entry by entry. With a filter (`buildVisibleSet(parts, hidden, filter)`, "Filter
regions" below) an entry goes to the draw of its mask: per colour the
unmasked draw first, then one per mask, masks ascending — every kind in
that order, which `VisibleSet.layers` lists as the draw loop's
`(colour, mask)` steps.

**Clip groups.** Pattern-clipped glyph passes of one colour are merged
into groups whose footprints (clip area ∪ instance extents) do not meet,
greedily in stream order: no instance of one member can fall inside
another member's area, so one stencil mark, one instanced draw and one
clear serve the group with the same pixels as one per pass. Before
grouping, Sprint envelope drew 161 per frame, 155 of them clip
stencil passes; after, 17.

**Residency and the budget.** The engine counts the always-resident
bytes (base parts, large bucket, mesh atlas, text atlas pages and glyph
table, the visible-set buffers — which
hold every index, instance and clip-group array on the GPU) plus the
resident detail parts' arena vertices against the budget — and the dynamic
bucket's vertices, which count as fixed (below). After every arrival and
view change it evicts the least recently drawn detail parts until the
total fits, never one in the drawn set; if the drawn set alone does not
fit, the engine reports over budget (`EngineStats.overBudget`) rather
than drop drawn cells. A view's want list is sent once: the same view
does not re-request what the budget evicted (a new view sends a new
list), and a part that arrives twice keeps its first upload. Arena
capacity is reported next to live bytes (the slack is at most the
growth factor).

#### Worker

`worker.ts` is the pure message handler (unit-tested without a Worker;
`inlineTransport()` runs it on the main thread for `worker=0`);
`worker-entry.ts` binds it to the worker scope. Protocol:

| Message | Payload | Reply |
|---|---|---|
| `load` | document bytes + `DocumentRenderOptions` + the event's patch (or, dev only, render objects + symbols, or a symbolised stream), font files, the text atlas pages (JSON, in the renderer's page order), optional first view (a view, or "fit into w × h"), gate flag | `loaded`: summary (bounds, origin, grid, detail cells, the first view resolved, stage times, bytes, text: pages, glyphs resolved, glyphs missing), mesh atlas, every cell's base part, the large part — then, without a further request, the first view's detail parts unless it is below the gate |
| `prepare` | bucket ids, most urgent first | replaces the queue; one `part` per id |
| `patch` | a generation number, the patch (or `null`) and the cells whose detail the engine holds | `patched`: the generation, the patch state (hidden ids, issues), the touched buckets' fresh parts, the detail cells, the bytes, the mesh atlas when it grew — "Object identity and the patch" below |
| `course` | a generation number and the course layer's input without the document (`CourseLayerRequest`: structure, sites, objects, appearance, view options, filter regions, `fastFilter`), or `null` | `course`: the generation, the dynamic bucket's part (or `null`), the stack to draw with, the derivation and symbol sizes, warnings, the mesh atlas when it grew, and the filter over the static buckets (or `null`) — "Dynamic bucket" and "Filter regions" below |
| `hit` (G5) | an id, a paper point (µm) and a tolerance | `hit`: the id and the effective document's objects under the point, topmost first (`DocumentHit`s) — §5.5 "Document objects" |
| `terrain` (H6) | a generation number, a height field's header and its int16 grid | `terrain`: the generation, the mesh's prepared part (filled heights, height range, chunk ranges) and the normals, transferred — §5.6 "Worker"; needs no loaded document |
| `edit` (G5) | a generation number and the edit input (selected refs, a draft of patch ops), or `null` | `edit`: the generation, the edit part (`EDIT_BUCKET`, or `null`), the static copies to hide, the selected refs' indices and the count drawn highlighted, the draft's issues, the mesh atlas when it grew — §5.5 "Document objects"; a `patched` reply carries the same state as `edit` while an input is held |
| — | | `error` on a failed load; on a `course` request whose derivation throws, with that request's generation (F20b); on a `patch` request that throws, with `patch` = its generation; on a `hit` with `hit` = its id; on an `edit` with `edit` = its generation; on a `terrain` request with `terrain` = its generation |

Every typed array goes back as a transferable. The worker decodes,
bridges (`documentRenderInput`), symbolises, builds the atlas, assigns
buckets and prepares; it prepares queued parts in slices of about 8 ms
(`PREPARE_SLICE_MS`) scheduled through a `MessageChannel` (not
`setTimeout`, whose nesting clamp adds 4 ms per part), so a newer
`prepare` overtakes a stale queue between slices. Fonts arrive as
`ArrayBuffer`s and are parsed in the worker. Reading OCAD / OMAP and
normalising to a document stays outside it (the import pipeline's job;
the dev page does it on the main thread). The caller creates the worker
when the view mounts, before a document is known: under Vite dev its
module graph takes ~150 ms to load (Sprint envelope `load` 314 → 147 ms
once the dev page pre-warmed it).

#### Dynamic bucket (C4)

The course layer (`docs/course-layer.md`) is drawn by this backend as
one more part — the **dynamic bucket** of 04 §7 — beside the static
buckets, so map and course are one colour-ordered picture: lower purple
under black, brown and blue line art, white-outs above the map's ink,
upper purple on top. The viewer's use of it is §5.4 "Overlay". Since G5
the dynamic bucket has a second part, the **edit part** (`E`,
`EDIT_BUCKET`): Map mode's selection highlight and the document objects
under edit, with its own request (§5.5 "Document objects").

**Stack at load.** A load with `courseLayer: true` (the viewer's; the
dev page and the bench leave it off) builds the static buckets on the
**course-completed stack** `courseColourStack(header.colours)`
(`course-layer.md` §1): when the document lacks upper white the row is
inserted below upper purple and the bridged symbols are re-indexed
(`remapRenderColours`) before `symbolise`, so every pass at or above
upper purple carries the shifted index. The stack is a function of the
document alone, so showing, changing or hiding a course never
re-prepares a static part and the draw needs no index translation.
`LoadSummary.colourStack` is the stack the parts index (the document's
own without `courseLayer`) and `LoadSummary.courseLayer` says whether a
course can be drawn: `{ supported: true, cutFeatures }`, or — a stack
without both purples, `CourseStackError` — `{ supported: false, reason }`
with the document drawn on its own stack, unchanged. The same load
extracts the automatic-cut features (`cutFeaturesOfDocument`,
`course-layer.md` §3.4) of the effective document — again with every
patch change ("Object identity and the patch") — and keeps the decoded
context, the parsed fonts, the text pages and the mesh atlas builder for
the course requests.

**A course request.** `course { generation, input }` runs, in the worker,
`courseLayer({ ...input, document, cutFeatures })`, `symbolise` on the
layer's objects and symbols alone (its symbols already index the
completed stack) and `prepareBucketPart(…, COURSE_BUCKET, every pass,
"all")` — one part with every kind, bucket id `COURSE_BUCKET` (−2).
Its range-table object ids start at `COURSE_OBJECT_BASE` (2³⁰; "Object
identity and the patch"), so `setHidden` can address document and course
objects in one set and a patch's added objects never shift them. Glyph parts (701, 706) join the
**same mesh atlas**, keyed by their geometry (the course stream's glyph
ids are local to each run); growth is append-only, so the reply carries
the whole atlas only when a mesh was added and every resident instance
keeps its `base`. Numbers (704) are MSDF text resolved against the
loaded pages like the document's (§"Text atlas"), `TEXT_*` warnings
counted in the reply. The reply's `colours` is `layer.colours` — the
completed stack plus a row per hex-coloured layout object on top
(`course-layer.md` §3.6) — and it brings `derivation` (sites, labels,
legs) and `metrics` (circle, start and finish radii, line width, digit
height in paper mm) for the UI layer, and `hit` — the layer's hit index:
the symbolised stream with layer-local object ids (before the offset)
and each object's `ref`, which the editor hit-tests on the main thread
(§5.5). `input: null` clears; a load
without course support answers `part: null`, `hit: null` and `COURSE_UNAVAILABLE`.
The worker answers a request at once, between prepare slices. A request
whose derivation throws answers `error` (F20) carrying the request's
`generation` (F20b), so the engine ends that request — and only it.

**Page part** (D7, `course-layout.md` §1). A request with `page` (the
sheet's paper height, frame, window, layout objects, text values and
description block) also answers `pagePart`: the composer's page layer
(`course.pageLayer`, the stream `composePage` writes) through `T_map⁻¹`
into paper µm (`pageStreamInMap`), prepared as one `all` part with bucket
id `PAGE_BUCKET` (−3), its object ids after the course's and its glyph
meshes in the same atlas. Every pass's colour index is offset by
`colourBase` = the page layer's table length, and the reply's `colours`
is that table followed by a copy of it for the page (ids `page:…`): so
the visible set sorts every page draw after every map draw — the PDF's
page layer after its map layer, a page white-out over upper purple — and
`page { colourBase, frameRingUm }` tells the engine where the map stops.
The engine uploads the page part under key `P` beside `C` (always
resident, fixed bytes) and passes `pageClip { fromColour, ringUm }` to the
renderer, which scissors every colour below `fromColour` to the frame's
screen box (exact while the page is upright, which Layout mode keeps).

**Engine.** `MapGlEngine.setCourse(input | null)` keeps **one request in
flight** (F20, `docs/bugfix-course-drag-redraw.md`): with none, it posts
the input with a new generation; during one it records the input — the
latest call wins, `null` included — and posts it when the reply is in, so
a drag re-derives at the worker's rate, every reply of a posted request is
drawn and no input a newer one replaced is ever derived. One made before
the load waits for it and is sent right after the load message; a `load`
during a request posts the current input at once with a new generation,
and a reply whose generation is not the latest posted is dropped. A
course `error` (with a generation, F20b) ends the request in flight when
the generations match — the recorded input goes — and is otherwise stale
and ignored; it never touches a load in flight. An `error` without a
generation (a failed load, a real worker's `onerror`) rejects the load in
flight and ends the request in flight, as before F20b. The current reply's part is uploaded under key `C` —
through `GpuArena.put` like any part, so a grow re-uploads it with the
rest and nothing goes through `copyBufferSubData`
(`docs/bugfix-adreno-arena-grow.md`) — and the previous one released;
`setAtlas` replaces the mesh texture when the reply carries an atlas.
The part is **always resident and always drawn**: appended to the
visible set after the drawn cells and the large bucket at every zoom,
gated or not, never evicted, its arena bytes counted as fixed. A reply
rebuilds the visible set on the next `render` at once (not held by
`ARRIVAL_REBUILD_MS`) and calls `onChange` for the redraw and `onCourse`
with the derivation, sizes, stack and warnings. Within one colour the
course draws after the map's own objects of that colour (it is the last
part). `engine.colours` is the stack to draw with: the latest reply's,
else the load's.

**Cost.** A dragged control re-symbolises the whole layer (tens of
objects): the 04 §7 budget of < 1 ms is the symbolisation's; the reply
is one worker round trip, one part upload and one visible-set rebuild.
The derivation is the larger part since F13: on 25 controls with one
smooth bend per leg it was ~400 ms, 376 of them the number placer's, and
with a request per pointer move a second of drag queued ~24 s of worker
time. F20 culls the placer (`course-layer.md` §3.5; ~70 ms for the whole
derivation on the budget fixture) and keeps one request in flight; the
corridor and cut-feature cost per request is F20b's (`course-layer.md`
§10.2 Pending). Main-thread symbolisation for the drag is pending (§8).

#### Filter regions (D3)

Filter regions (§4.11) act on the **static buckets** — the document —
without re-preparing anything: a hidden object is skipped entry by entry
like `setHidden`'s, and a mask is a stencil test on the entries it
selects (04 §7: "nothing is re-tessellated when the region moves").

**Worker.** A `course` request's `regions` (paper mm, document colours)
go through `courseLayer()` like the rest of the input; the worker then
runs `render.filterStream(stream, layer.regions, { fast: fastFilter,
objectBounds })` on the **effective document** — the document stream it
loaded, whose results for the objects a patch changed are dropped, and
the patch's own stream ("Object identity and the patch"), the two
replies concatenated (the patch's masks after the document's) — so a
moved object is filtered where it is now and an added one is filtered
too. The course part is never filtered. The objects' symbolised bounds
are computed once per stream on the first filter request and kept. The reply's `filter` (`FilterReply`)
carries the hidden object ids, the masked range-table entries as
`(object, colour, mask)` triples (a mask is a function of the pair,
§4.11), and each mask's region triangles: every region flattened at the
load tolerance and triangulated even-odd (`triangulateEvenOdd`),
origin-relative, concatenated per mask (a mask's regions may overlap —
the stencil takes their union). No regions → `filter: null`, which
clears it. `fastFilter: true` is what a drag sends; the request on
release leaves it off for the exact result. A `stream` source (the dev
page, the golden arena tier) that carries masks gets the same `filter`
on its `loaded` reply, from the stream's `maskIdx`.

**Engine.** The latest reply's (or the load's) filter is kept; its
hidden ids join `setHidden`'s for the visible set, and its entries become
`VisibleFilter.entryMask` (`filterEntryKey(object, colour)` → mask) with
the triangles passed through to `VisibleSet.filter`. A reply rebuilds
the visible set at once, as any course reply does.

**Drawing.** The renderer uploads the mask triangles with the visible
set (`maskPos` / `maskIdx` buffers, one VAO) and walks `vs.layers`:
for a masked step it writes the mask's triangles into stencil bit
`REGION_BIT` (0x04) with `REPLACE` and no colour, draws the step's
fills, hatches, strokes, glyphs, clip groups and text with
`stencilFunc(EQUAL, 0, REGION_BIT)` (a clip group: `EQUAL, CLIP_BIT,
CLIP_BIT | REGION_BIT`), and clears the bit over the same triangles —
two extra draws per masked step. Unmasked steps draw as before, without
the stencil. Masked draws of a colour come after its unmasked draws of
every kind; ink of one colour is opaque, so the order within a colour
does not show.

**Per-pass path.** `prepareStream` gives each prepared item of a masked
pass the mask's regions as stencil fans (`Prepared.mask`, one
`FanGeometry` per region); `draw()` marks each region's even-odd parity
in the parity bit and moves it into `REGION_BIT` under the region's
cover (union over regions), adds `REGION_BIT` to every stencil test of
the item (fill and hatch covers, instanced covers, strokes, pattern
clips), and clears the bit after the item.

#### Object identity and the patch (G4)

**Object identity.** For a document source the range tables' `object`
is the document's own **effective `objectIndex`** (`map-patches.md`
§2.2). The bridge keeps only drawn objects (objects of hidden symbols,
dropped and textless ones are left out), so the worker rewrites the
symbolised stream's `objectIdx` — an index into the bridge's object
list — through `documentRenderInput`'s `docIdx`. `setHidden`, a filter
reply's `hidden` and `entries`, and a patch's hidden ids all speak these
ids; objects a patch adds are `N …` (from the pinned count up). The
course part's ids start at `COURSE_OBJECT_BASE` = 2³⁰ and the page
part's after the course's, so a patch that adds objects never shifts
them; the edit part's start at `EDIT_OBJECT_BASE` = 0x6000_0000 (G5, §5.5),
so its copies are never skipped with the static objects they draw. The
dev `objects` and `stream` sources keep the stream's ids.

**The patch.** The viewer draws the event's patch over the pinned
document (`map-patches.md` §2) — hide, modify, resymbol, add — without
reloading the document:

- **In.** The `load` message's document source takes `patch`
  (`MapPatch | null`), so the first frame is the effective document. A
  change is a `patch { generation, patch, detail }` message, `detail`
  being the cells whose detail part the engine holds. The caller pairs
  the patch with the document by hash (`patchForDocument`, §5.4 "Host");
  the worker applies it to the pinned document it decoded
  (`applyPatch`), **always from the pinned state**: a patch is a set of
  keyed states (`map-patches.md` §1.1), so what is drawn is a function of
  its content, not of the changes before it. A null, disabled or empty
  patch is the document itself (§2.1).
- **Hide is ids only.** The reply's `patch.hidden` (effective indices)
  joins `setHidden`'s and the filter's in the engine; nothing is
  re-prepared (04 §7: hiding is skipping ranges). A hidden object that is
  also modified stays hidden, and its modify re-prepares nothing.
- **Modify, resymbol, add.** The *changed* set is the objects the applied
  modify and resymbol ops target (unless hidden) and every added object.
  The worker bridges and symbolises the changed set alone
  (`documentRenderInput { only }`, the load's options and colour remap),
  its ids rewritten through `docIdx`; its glyph meshes join the mesh atlas
  by content (`c/<geometry>`, as the course's), its text resolves against
  the loaded pages. Each changed object goes to the load's grid by the
  centre of its symbolised bounds (`assignToGrid`); one larger than
  `LARGE_CELLS`, or centred outside the grid (the grid is the load's and
  its cell ids are fixed), goes to the large bucket. A bucket's part is
  then its pinned passes **without the changed objects'**, merged by
  colour with the patch's passes in it (`prepareBucketPartFrom`: two
  sources, the pinned one first within a colour; ink of one colour is
  opaque, so the pixels are those of one symbolisation of the effective
  document). One id per object: a replaced object is drawn again under
  its own index, never as a hidden one plus a copy.
- **Touched buckets.** Per bucket the overlay keeps a signature: the
  pinned objects the bucket loses and, for each object it gains, its
  index, its ops' states and — for a patch symbol — the symbol. A change
  re-prepares only the buckets whose signature differs from the previous
  overlay's: a second change elsewhere leaves the first's cells alone,
  and the toggle off touches the cells the patch had touched and gives
  back parts deep-equal to the unpatched load's.
- **Reply.** `patched { generation, patch, touched, base, detail,
  large?, detailCells, bytes, atlas?, ms }`: every touched cell's fresh base
  part (a touched cell absent from `base` has none now), the fresh
  detail parts of the touched cells the request said the engine holds,
  the large part when touched (`null`: empty now), every cell's detail
  membership now, the base and large bytes, and the whole atlas when it
  grew (append-only, so resident instances keep their `base`). `patch` is
  `PatchState { hidden, changed, added, issues, cutFeatures? }`;
  `applyPatch`'s issues are reported, never thrown. A request that
  throws answers `error { patch: generation }` and leaves the worker as
  the engine still has it: the overlay, the cut features and the byte
  counts are put back, so the next change is diffed against the last
  reply, and an atlas the failed request grew goes with the next reply
  (growth is measured against the meshes last sent). A worker error
  without a generation (`onerror`) ends the engine's patch request in
  flight too, rejecting its callers, and the waiting input is sent. The `prepare` queue goes
  on with the new content: every part is prepared from the current
  overlay.
- **Engine.** `setPatch(patch | null)`: before the load the patch goes
  with the load message; after it, one request is in flight and the
  latest input waits, as with `setCourse`. It resolves with the
  `PatchState` once a reply covering its input is applied. A reply
  releases each touched cell's resident parts and uploads the fresh ones
  in the same step, so a cell's line art never blinks; replaces `L` when
  touched; takes `detailCells`, the bytes and the hidden ids; rebuilds
  the visible set at once; and re-sends the view's want list — a touched
  cell whose detail was in transit when the request went (prepared before
  the change) is dropped and asked for again. It re-posts the course
  input, since the cuts and the filter read the effective document. No
  `load`, no new context, no document request.
- **Readers.** With a course layer the cut features are recomputed from
  the effective document (`cutFeaturesOfDocument` skips hidden objects
  and reads modified ones where they are); filter regions act on the
  effective document ("Filter regions").
- **Cost.** A change costs one `applyPatch` (linear in the document,
  `map-patches.md` §2.4), a bridge and symbolisation of the changed
  objects only, and the preparation of the touched buckets. A changed
  object that lands in the large bucket re-prepares the whole large
  bucket; that cost is not measured on Club-full (§8).

#### Text atlas (B3)

Text on the arena path is drawn from the committed MTSDF pages of §4.10
(04 §6.7: MSDF for the screen, outlines in PDF; both place glyphs from
the same shaping result, so only rasterisation differs). The atlas is a
**session asset**, not a document asset: a document never carries it,
and one page serves every document.

- **Which pages.** `textAtlasPagesFor(header.strings)`: the Latin page
  always; the Cyrillic page only when a string of the document has a
  code point in U+0400–04FF (S1 §5's "only when the header lists such
  characters" — `strings` is that list; the header is read before the
  worker starts). Pages are generated at build time and *fetched* on
  demand; nothing generates glyphs in the browser.
- **Loading.** `loadTextAtlas(pages)` (`lib/map-fonts.ts`): JSON and PNG
  per page via Vite `?url`, once per session per page (a failed page is
  retried on the next call), the PNG decoded with `createImageBitmap(…,
  { premultiplyAlpha: "none", colorSpaceConversion: "none" })` — the
  field is data — and uploaded without premultiplication or colour-space
  conversion. The viewer falls back to the Latin page alone, then to no
  text, when a page fails: the map still draws.
- **Two consumers, one order.** `engine.load({ …, textAtlas })` gives the
  decoded images to the renderer (`setTextAtlas`: one RGBA8 texture per
  page + the glyph table, session-scoped — it survives `setDocument` and
  is not re-uploaded for the same pages) and the page JSONs to the
  worker, in the same order: a text instance's draw group is its page's
  index there.
- **Worker.** `buildTextGlyphs(pages)` turns the JSON into a
  (family, glyph id) → (entry, page) lookup; every text pass is resolved
  once at load (`TextPassGlyphs`: entry and page per glyph, the halo in
  em). Only the Regular faces ship, so the family is the key (§4.9 font
  resolution). Without pages no text is drawn and each text pass counts
  `TEXT_ATLAS_MISSING`; a glyph no loaded page holds counts
  `TEXT_GLYPH_NOT_IN_ATLAS` (unless it has no outline or is `.notdef`,
glyph 0 — §8 tabs); a halo wider than
  half the range (0.125 em) is clamped and counts `TEXT_HALO_CLAMPED`.
  The counts join the stage's warnings in `LoadSummary.warnings`;
  `LoadSummary.text` has the pages, glyphs resolved and glyphs missing.
- **Halos.** The halo pass is its own pass at its colour's stack
  position (§3.5, §4.9), drawn from the same quads with the halo band on
  the alpha channel (Drawing). Library text halos are 0.14–0.155 mm on a
  ≥ 4 mm em — about 0.03 em, far inside the 0.125 em the field holds.
- **Bounds.** `passBounds` keeps the em-box + halo rule for text; a
  glyph quad reaches at most half the range (0.125 em) past its outline,
  inside the one-cell draw margin.

#### Drawing (GPU)

Arena path (`renderDocument(view, opts, target?)`): for each colour in
stack order, fill → hatch → stroke → glyph size classes and that
colour's clip groups → text; one `drawElements` per indexed kind, one
`drawArraysInstanced` per size class. The stream is colour-major, so no
sorting happens here.

* **Projection** — one `mat4` uniform `u_view`, model (origin-relative
  paper µm) → clip, column-major, built per frame by `viewMatrix(view,
  origin)` (`view.ts`) in float64: `S · R(rotationDeg) · (p − (centre −
  origin))`, y-up throughout. `DocumentRenderOptions.viewMatrix`
  replaces it with any other camera — a perspective one for terrain
  draping (research topic 10) — without touching the shaders. The
  screen-only rules (floor, glyph skip, hatch tint) read the view's
  `pxPerUm`, and cell selection reads the `View`'s rectangle; under a
  perspective camera both need the camera's footprint (§8).
* **Render target** — a `RenderTarget { framebuffer, width, height }`;
  default the canvas at the view's size. A framebuffer target needs a
  stencil attachment (pattern clips). `compare=1&target=fbo` on the dev
  page draws into an offscreen 4× MSAA framebuffer and the E2E compares
  it with the per-pass path like the canvas. The editor's **loupe**
  (§5.5) draws into `renderer.insetTarget(size)` — the supersample
  path's recipe, a `size`² framebuffer with 4× MSAA `RGBA8` and
  `DEPTH24_STENCIL8`, kept until the size changes or `releaseInset()` —
  and `compositeInset(box)` resolves it into a texture and draws that
  into the circle inscribed in `box` (top-left, device px) of the canvas
  with the blit program (fragments outside the circle discarded; blend,
  stencil and scissor off); the rest of the canvas is untouched.
  `engine.renderInset(view, opts, box)` is the pair over the visible set
  `render` last built (no cell selection, no request, no rebuild; the
  page clip forwarded); its view is `loupeView(main, point, scale, size)`
  (`view.ts`): centre the point, `pxPerUm × scale`, `size`² device px,
  the main rotation — a `ViewRect` rather than a bare `viewMatrix`
  option, because the screen-only rules read its `pxPerUm`. The GPU
  timer counts each `renderDocument` as a frame, so during a loupe drag
  `gpuMs` may be the loupe's draw (only the dev page reads it).

* **Fills** — earcut triangles, opaque. No stencil.
* **Strokes** — `halfWidth × offset` in the vertex shader. **Hairline
  floor** (04 §6.2, §8 row 10): when the stroke is under `minStrokePx`
  (1 device px) on screen it is drawn that wide with alpha × (true width
  / floor), so zoomed-out contours fade to a tint instead of aliasing.
  Triangles that overlap at join wedges blend twice under the floor; the
  area is sub-pixel at the zooms where the floor applies.
* **Instanced glyphs** — vertex pulling: the instance carries
  its mesh's atlas `base` and `count`; the draw pulls `2^class` vertices
  per instance (a whole number of triangles) and vertices past `count`
  are moved outside clip space. Mesh strokes get the same floor. An
  instance whose mesh diameter × scale is under `minGlyphPx` (2 px) is
  collapsed the same way. Fills inside meshes are triangles, so
  overlapping instances of one pass no longer XOR (the per-pass path's
  caveat).
* **MSDF text** — six vertices per instance, one `drawArraysInstanced`
  per (colour, page) with that page's texture bound; the vertex shader
  makes the quad from the glyph table's plane bounds × em size, rotated
  by the instance's `cos, sin`. Fragment, with `t` the page texel, `r`
  the range in em and `s = sizeUm · pxPerUm` screen px per em:
  a fill pass covers `clamp((median(t.rgb) − ½) · r · s + ½, 0, 1)`; a
  halo pass `clamp((halo − |(t.a − ½) · r|) · s + ½, 0, 1)` — the band
  within `halo` of the outline on the true distance, i.e. the outline
  stroked round/round at twice the halo width, exactly what the
  reference raster draws (§5.1: `stroke-width = 2 · haloWidthUm`). The
  ramp is one screen pixel (analytic AA on top of MSAA, 04 §6.9). Text
  whose em is under `minTextPx` (4 px) collapses in the vertex shader.
* **Pattern clip** — per clip group: the areas into stencil bit 0
  (`REPLACE`, colour masked), the group's instances where the bit is
  set (`EQUAL`), the areas again with `ZERO`.
* **Hatch** — the area's triangles with a stripe shader (`d = dot(p, n)
  − offset`, distance to the nearest multiple of `spacing`, one-pixel
  ramp); under `hatchTintPx` (1.5 px) spacing on screen, a tint of alpha
  `width / spacing`.
* **Anti-aliasing** — the context's MSAA (4× in practice; the dev page
  reports `SAMPLES`). The analytic 1-px edge feather on strokes and glyph
  strokes (04 §6.2, §6.9) is not built yet (§8): MSAA alone keeps the
  arena path pixel-comparable with the per-pass golden path (`compare=1`,
  ≤ 0.5 % at §6.2's tolerance), which a feather would not be.

Per-pass path (`setStream` / `render`, goldens): unchanged from S1 —
even-odd fills by the stencil trick (fan with `INVERT`, cover where
`stencil == 1`), strokes with a widen-only 0.75 px minimum, instanced
glyphs and text over stencil fans (overlapping instances of one pass
XOR), pattern clip with two stencil bits, hatch through the stencil,
optional `supersample: 2` into an offscreen MSAA buffer resolved and
box-filtered onto the canvas.

`FrameStats { drawCalls, cpuMs, gpuMs? }`: GPU time from
`EXT_disjoint_timer_query_webgl2`, resolved a frame or two late.

#### Loading an OCAD document (`ocad-objects.ts`, shared, dev-only)

Documents reach the stage through the render bridge
(`map-document/render-bridge.ts`, `docs/map-document-format.md` §8); its
per-kind proxies live in `render/proxy-symbols.ts`. What follows is the
S1 reader path, kept for `/dev/map-gl-doc?via=reader` and the S1
measurements; nothing outside the dev page uses `ocadObjectsToRender`.

To feed real maps in before the 02 document format exists,
`render.ocadObjectsToRender(objects, symbols, { mode })` turns
`ocad2geojson`'s object list into `RenderObject`s: OCAD 1/100 mm → µm,
coordinate flags mapped to §2.1's (`bezierFirst/Second`, `corner`,
`hole`, `noLeft/noRight`, `gap`, `dash`), symbol matched on
`floor(sym / 1000)` with a kind check. Object types map as in the
document bridge: 4–6 (including line text) are text, 7 (rectangle) is a
closed line. Two modes:

- `pilot` — objects whose symbol is not in the supplied set are
  **dropped**. This is the pilot family's true coverage: 11–18 % of the
  objects on every corpus map (501/520/521 roads, 103/109 contour
  variants, 202/204 rock, 401/406/410 vegetation dominate the rest).
- `envelope` — unmatched objects are drawn with a **proxy symbol per
  kind** (`proxy:line` 140 µm, `proxy:area` plain fill, `proxy:point`
  0.5 mm disc, `proxy:text` 3 mm Liberation Sans) so that *every*
  object is in the stream. Geometry and pass counts are a realistic
  upper bound for a full symbol library; the picture is not.

#### Measurements (B2)

Measured through `/dev/map-gl-doc` with `scripts/measure-gl.mjs`
(headed Chromium on the dev laptop's Alder Lake-P iGPU, GPU timer
available) against a Vite server started from the worktree; the corpus
is read by absolute path through the file input. Mode `pilot` /
`envelope`, path `via=document` as in S1. "S1" is the S1 batch path
(`batch.ts`, removed by B2) re-measured on 2026-10-20 — its numbers
match the S1 report within run-to-run noise. B2 values are from
2026-10-21 after syncing onto B1's full-library stage (median of three
runs on the laptop; single runs vary by up to ±25 % in the load times).
B1 left the pass counts of these two modes unchanged (they draw the
pilot family and proxies; its dash-layout changes move slices) — next
to the pre-B1 B2 runs the laptop numbers are within noise, except the
club maps' complete first view (Club-full envelope 1.86 → 1.48 s); on
the phone proxy the complete first views dropped 12–56 % (single runs;
symbolise got 10–35 % faster on the throttled thread). Columns:

- **Draws**: the most of any frame of both bench scenarios.
- **GPU MB**: resident GPU bytes after the first view is complete
  (arena capacity + atlas + visible-set buffers; S1: its buffers), and
  the most resident bytes the budget counted during the bench.
- **after read**: ms from the document bytes being ready to the first
  frame (S1: its only frame; B2: base layers + large bucket) and to the
  complete first view (B2). `read` (OCAD decode and normalise on the
  page) is left out as in S1: in the product the client fetches a
  document, not an OCAD file.
- **Frame GPU** avg / p95, ms, in the `fit` scenario (zoom 1→4→1) and the
  `paper1x` scenario (dense viewport at 1× paper, 04 §6.12).
- **Frame CPU** p95, ms (setView + visible-set rebuild + draw calls).
- **Bucket prepare** p95 / max, ms, per detail part in the worker.

Desktop, 1280 × 800 @ 1×:

| Map | Mode | Draws S1 → B2 | GPU MB S1 → B2 (bench max) | after read, ms: S1 → B2 first / complete | Frame GPU fit S1 → B2 | Frame GPU 1× S1 → B2 | Frame CPU p95 B2 fit / 1× | Bucket prepare p95 / max |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Sprint | pilot | 325 → **15** | 5.0 → **2.5** (1.8) | 68 → 80 / **85** | 3.7 / 4.0 → 2.3 / 3.0 | 3.8 / 4.1 → 2.5 / 2.7 | 2.4 / 0.8 | 0.8 / 0.9 |
| Sprint | envelope | 328 → **17** | 19.4 → **8.0** (7.5) | 200 → 142 / **181** | 7.1 / 8.1 → 5.6 / 7.3 | 8.2 / 8.6 → 7.2 / 9.4 | 7.0 / 0.8 | 3.1 / 3.6 |
| Crop-B | pilot | 15 → **12** | 6.0 → **3.1** (2.2) | 80 → 52 / **69** | 1.4 / 1.7 → 1.1 / 1.7 | 1.4 / 1.5 → 1.1 / 1.2 | 0.5 / 0.5 | 5.6 / 5.6 |
| Crop-B | envelope | 76 → **21** | 16.5 → **6.2** (5.3) | 393 → 76 / **113** | 3.5 / 3.9 → 2.7 / 4.1 | 3.1 / 3.5 → 3.1 / 3.2 | 0.7 / 0.6 | 14.1 / 14.1 |
| Crop-A | pilot | 22 → **11** | 8.2 → **4.0** (3.1) | 231 → 58 / **82** | 1.8 / 2.0 → 1.3 / 1.6 | 1.9 / 2.1 → 1.5 / 1.5 | 0.6 / 0.5 | 7.5 / 7.5 |
| Crop-A | envelope | 47 → **18** | 19.8 → **7.3** (6.4) | 149 → 84 / **146** | 4.7 / 5.3 → 3.4 / 4.2 | 4.7 / 5.0 → 4.2 / 4.3 | 0.6 / 0.5 | 14.9 / 14.9 |
| Club-2026 | pilot | 100 → **12** | 70.0 → **26.9** (25.6) | 420 → 157 / **320** | 9.6 / 10.8 → 4.8 / 7.8 | 9.5 / 12.1 → 4.4 / 6.0 | 10.6 / 7.5 | 5.5 / 9.9 |
| Club-2026 | envelope | 207 → **21** | 153.4 → **51.7** (50.8) | 871 → 358 / **653** | 10.3 / 11.2 → 5.9 / 8.4 | 11.0 / 11.9 → 6.4 / 8.3 | 18.1 / 0.8 | 11.8 / 13.8 |
| Club-full | pilot | 191 → **15** | 156.5 → **59.4** (57.2) | 850 → 308 / **668** | 9.6 / 10.4 → 5.0 / 8.2 | 10.8 / 11.5 → 3.2 / 4.3 | 22.6 / 0.6 | 5.0 / 7.8 |
| Club-full | envelope | 330 → **24** | 336.0 → **118.6** (112.1) | 2 136 → 728 / **1 481** | 21.9 / 22.7 → 8.8 / 13.1 | 23.7 / 26.4 → 5.0 / 7.7 | 46.9 / 0.6 | 11.0 / 16.7 |

Phone proxy — 412 × 915 @ 2.625× (Pixel-7 metrics) with CDP
`Emulation.setCPUThrottlingRate(4)`. CDP throttles the page's main
thread only, not a Web Worker, so the B2 rows run the worker's handler
inline (`worker=0`): every stage is throttled, and frames and
preparation share one thread — an upper bound for a phone, where the
worker runs on another core. GPU columns remain the laptop iGPU:

| Map | Mode | Draws S1 → B2 | GPU MB S1 → B2 (bench max) | after read, ms: S1 → B2 first / complete | Frame GPU fit S1 → B2 | Frame GPU 1× S1 → B2 | Frame CPU p95 B2 fit / 1× | Bucket prepare p95 / max |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Sprint | pilot | 325 → **15** | 5.0 → **2.5** (1.8) | 252 → 219 / **330** | 4.6 / 8.2 → 2.7 / 3.2 | 4.6 / 7.4 → 2.5 / 2.8 | 3.0 / 2.4 | 4.9 / 6.7 |
| Sprint | envelope | 328 → **17** | 19.4 → **8.0** (7.5) | 788 → 460 / **729** | 7.2 / 8.8 → 4.4 / 8.7 | 8.3 / 8.8 → 4.5 / 5.4 | 9.2 / 7.5 | 8.9 / 9.7 |
| Crop-B | pilot | 15 → **12** | 6.0 → **3.1** (2.2) | 230 → 113 / **212** | 1.7 / 2.0 → 1.4 / 1.9 | 1.7 / 1.9 → 1.5 / 1.7 | 0.9 / 0.9 | 16.0 / 16.0 |
| Crop-B | envelope | 76 → **21** | 16.5 → **6.2** (5.3) | 480 → 230 / **407** | 4.3 / 4.9 → 3.5 / 4.9 | 4.3 / 4.8 → 3.6 / 4.5 | 1.0 / 1.0 | 40.8 / 40.8 |
| Crop-A | pilot | 22 → **11** | 8.2 → **4.0** (3.1) | 333 → 174 / **322** | 2.2 / 2.5 → 1.6 / 2.0 | 2.1 / 2.2 → 1.6 / 2.0 | 0.9 / 0.9 | 34.6 / 34.6 |
| Crop-A | envelope | 47 → **18** | 19.8 → **7.3** (6.4) | 558 → 275 / **549** | 5.1 / 5.5 → 4.3 / 5.2 | 5.1 / 5.4 → 4.0 / 5.0 | 1.0 / 0.8 | 40.7 / 40.7 |
| Club-2026 | pilot | 100 → **12** | 70.0 → **26.9** (25.6) | 1 540 → 542 / **1 572** | 8.0 / 9.4 → 3.7 / 6.2 | 9.9 / 10.6 → 1.7 / 2.6 | 16.2 / 1.2 | 21.1 / 22.3 |
| Club-2026 | envelope | 207 → **21** | 153.4 → **51.7** (50.8) | 3 180 → 1 268 / **3 226** | 10.7 / 11.4 → 5.9 / 10.5 | 11.2 / 11.7 → 3.5 / 6.7 | 40.6 / 1.4 | 39.4 / 42.9 |
| Club-full | pilot | 191 → **15** | 156.5 → **59.4** (57.2) | 5 985 → 1 084 / **3 588** | 12.3 / 15.4 → 5.2 / 7.2 | 11.7 / 12.8 → 2.1 / 3.2 | 53.3 / 1.3 | 19.2 / 24.2 |
| Club-full | envelope | 330 → **24** | 336.0 → **21.9** (91.8) | 7 236 → 2 717 / **2 730** | 21.5 / 22.3 → 7.5 / 10.5 | 21.2 / 21.8 → 2.9 / 4.9 | 74.7 / 11.0 | 0.0 / 0.0 |

**Source mode** (2026-10-21, after B1): each map's own symbols through
the matcher and the canonical library (`mode=source`), symbolised by
B1's full-library stage — the case S1 could only bracket between pilot
and envelope. One run each, laptop; phone proxy as above (inline):

| Map | Passes | Draws | GPU MB (bench max) | after read: first / complete | Frame GPU fit / 1× | Frame CPU p95 fit / 1× | Bucket prepare p95 | Phone proxy: first / complete | Phone proxy: frame GPU 1× · CPU p95 1× |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Sprint | 14 416 | 54 | 9.4 (8.7) | 183 / **220** | 7.0 / 7.4 | 8.8 / 0.8 | 3.1 | 577 / **966** | 5.7 · 9.5 |
| Crop-B | 3 308 | 62 | 6.7 (5.8) | 88 / **125** | 2.6 / 3.0 | 0.7 / 0.6 | 15.1 | 279 / **464** | 3.8 · 1.0 |
| Crop-A | 5 355 | 63 | 7.8 (7.0) | 102 / **155** | 3.1 / 4.0 | 0.7 / 0.7 | 16.6 | 310 / **539** | 4.2 · 1.0 |
| Club-2026 | 52 169 | 111 | 61.3 (54.6) | 440 / **834** | 6.2 / 6.8 | 22.6 / 1.1 | 11.4 | 1 493 / **3 765** | 4.2 · 1.7 |
| Club-full | 115 972 | 167 | 126.3 (122.5) | 853 / **1 715** | 11.4 / 8.9 | 54.5 / 16.6 | 12.9 | 3 112 / **9 710** | 6.1 · 32.2 |

Every draw count stays under 300 (more colours and kinds than the pilot
family: up to 167 on Club-full at fit), resident memory inside the
budgets with everything resident (Club-full 126 MB), event maps complete
in 125–220 ms on the laptop and club maps in 0.83–1.7 s. Over budget:
Club-full's frame GPU at 1× paper on the iGPU (8.9 ms) and its 1× frame
CPU p95 (16.6 ms laptop: visible-set rebuilds of a dense viewport as the
pan crosses cells — the §8 rebuild item), and on the phone proxy the
event maps' complete first view (464–966 ms) and Club-full's first frame
(3.1 s: at the phone's fit view it sits just above the zoom gate, so its
whole detail is wanted).

#### Measurements (B3)

Source mode, laptop, one run each (2026-10-22, after B4, B9 and B10;
same script, settings and columns as the source-mode table above —
single runs vary by up to ±25 % in the load times). Text is now MSDF
quads (the Latin page; no corpus map needs Cyrillic):

| Map | Passes | Text glyphs | Draws B2 → B3 | GPU MB (bench max) | after read: first / complete | Frame GPU fit / 1× | Frame CPU p95 fit / 1× | Bucket prepare p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Sprint | 14 416 | 0 | 54 → **53** | 11.5 (10.7) | 219 / **229** | 6.9 / 8.5 | 7.8 / 0.8 | 3.1 |
| Crop-B | 3 306 | 81 | 62 → **52** | 8.6 (7.6) | 118 / **153** | 2.6 / 3.2 | 0.6 / 0.6 | 13.6 |
| Crop-A | 5 354 | 24 | 63 → **54** | 9.7 (9.0) | 110 / **152** | 3.0 / 4.1 | 0.7 / 0.7 | 12.1 |
| Club-2026 | 51 466 | 906 | 111 → **91** | 62.7 (56.1) | 451 / **883** | 6.3 / 6.8 | 15.8 / 1.0 | 18.2 |
| Club-full | 114 139 | 3 096 | 167 → **115** | 125.8 (122.1) | 860 / **1 690** | 10.1 / 8.3 | 51.5 / 18.3 | 11.9 |

- **Draws** fall on every map with text: one draw per (colour, page)
  instead of one per (colour, size class) — on Club-full 52 fewer at fit.
- **GPU**: the Latin page (2.0 MB) and the glyph table are always
  resident, so every map is ~2 MB above B2 (the mesh atlas now holds
  glyph parts only: 0.12–0.28 MB). All maps stay inside 30 / 150 MB.
- Frame GPU, frame CPU and load times are within B2's run-to-run noise;
  the over-budget items of the table above (Club-full 1× frame CPU,
  `fit` frame CPU on club maps) are unchanged — they are visible-set
  rebuilds (§8), not text.
- `TEXT_GLYPH_NOT_IN_ATLAS` is 0 on every map once `.notdef` is
  excluded: Club-2026 has 1 and Club-full 12 tab characters, which the
  stage shaped to `.notdef` at the time (since B8 a tab advances to its
  stop and emits no glyph, §4.9).

Per build step (S1 §6's order; runs before the B1 sync):

| Step | What it moved | Before → after |
|---|---|---|
| 1 Indexed strips | stroke bytes per vertex/segment; resident GPU for a whole club map | contour line: ≥ 3× fewer bytes (unit test); Club-full envelope fully resident 336 → 119 MB (arenas 73 MB, visible set 51 MB) |
| 2 Visible set per (colour, kind) | frame GPU on the phone viewport at 1× paper | Club-full envelope 21.2 → 3.1 ms, Club-2026 envelope 11.2 → 3.7 ms, Sprint envelope 8.3 → 4.2 ms |
| 3 Mesh atlas + clip groups | draws per frame | Sprint 325 / 328 → 15 / 17 (161 before clip groups); every map ≤ 24 |
| 4 Buckets, gate, LRU | the gated first frame on the phone (Club-full envelope, fit = 0.03× paper) | no gate → gate: first frame 3.8 → 3.1 s, complete 7.3 → 3.1 s, resident 118.6 → 21.9 MB; a 0.05 MB budget evicts and keeps drawing (E2E) |
| 5 Worker | main-thread long tasks during a load (laptop, envelope) | inline → worker: Sprint 235 → 71 ms, Club-2026 603 → 170 ms, Club-full 1 255 → 446 ms; what stays is the dev page's OCAD read (Club-full 383 ms) — none of it is the renderer's |
| 6 Hairline floor + LOD skips | frame GPU at fit (laptop) | within run-to-run noise (`lod=0` vs on, avg: Sprint envelope 5.96 vs 5.7 ms, Club-full envelope 8.5 vs 8.9 ms); the iGPU is not limited by these fragments here. The floor changes the picture (fade, not alias), not the cost |

Against the budgets (04 §9):

| Budget | Event maps (Sprint, Crop-A/B) | Club maps | Verdict |
|---|---|---|---|
| draw calls ≤ 300 | 11–21 | 12–24 | ✓ everywhere (S1: up to 330) |
| resident GPU ≤ 30 / 150 MB | 2.5–8.0 MB | 27–119 MB laptop fit (fully resident), 22 MB gated on the phone | ✓ (S1: Club-full 157 / 336 MB ✗) |
| frame CPU ≤ 4 ms, dense viewport at 1× | ≤ 0.8 ms laptop, ≤ 7.5 ms phone proxy (Sprint envelope, frames sharing the thread with inline preparation; ≤ 2.4 elsewhere) | ≤ 0.8 ms laptop except Club-2026 pilot (p95 7.5 ms: visible-set rebuilds as the pan crosses cells), ≤ 1.4 ms phone proxy (Club-full envelope 11.0 with inline preparation) | ✓ laptop except that one row; ✓ phone with the worker off-thread (the proxy's outliers are the inline preparation). Not met at overview zooms of club maps above the gate: `fit` p95 11–47 ms laptop — visible-set rebuilds of a whole club map (§8) |
| frame GPU ≤ 8 ms, dense viewport at 1× | 1.1–7.2 avg laptop, 1.5–4.5 phone viewport | 3.2–6.4 laptop, 1.7–3.5 phone viewport (iGPU) | ✓ on the iGPU; the phone GPU is B0 / B-gate |
| first frame ≤ 500 ms event | complete first view 69–181 ms laptop; phone proxy 212–330 pilot, 407–729 envelope | — | ✓ laptop; phone proxy ✓ pilot, envelope ✓ Crop-B, ✗ Sprint and Crop-A (S1 558–788 there): the inline proxy serialises frames and preparation; the envelope is the deliberately pessimistic upper bound |
| first frame ≤ 2.5 s club | — | laptop: first 157–728 ms, complete 320–1 481 ms; phone proxy: first 542–2 717 ms, gated Club-full envelope 2.7 s | ✓ laptop; phone proxy ✓ except Club-full envelope (2.7 s; S1 7.2 s) — symbolise 1.16 s (shared stage) and the base layer's earcut of every fill dominate |
| symbolise whole document in worker ≤ 100 / 800 ms | 15–36 ms laptop | 69–289 ms laptop; 1.16 s Club-full envelope throttled | ✓ laptop; ✗ throttled Club-full envelope (shared stage) |
| prepare one bucket ≤ 5 / 10 ms | Sprint p95 0.8–3.1 ms laptop ✓; Crop-A/B (club density) p95 6–15 ms | p95 5–12 ms, max 17 ms laptop; 19–43 ms phone proxy | ✓ Sprint; club-density cells at the limit on the laptop (p95 ≤ 10 ms for pilot, 12–15 for envelope), ✗ on the throttled proxy (§8) |

#### Dev pages

`/dev/map-gl?fixture=<golden scene>[&path=arena]` (`pages/dev/MapGlFixturePage.tsx`,
routed only when `import.meta.env.DEV`) draws one golden scene into a
canvas sized by `render.goldenFrame` (§6.2) with
`preserveDrawingBuffer`, sets `data-ready` when done and shows the
timings. Fonts are fetched from `packages/shared/fonts/` via Vite `?url`.
By default it draws through the per-pass path (supersampled 2×);
`path=arena` loads the scene's stream into an engine over the inline
worker handler (gate off, Latin text page) and draws through the arena
path at the context's MSAA — the §6.2 MSDF text tier and the filter
scenes' arena tier (a stream with masks brings its filter on `loaded`).

`/dev/map-gl-doc?mode=source|pilot|envelope[&via=document|reader][&worker=0][&gate=0][&budget=<MB>][&lod=0][&kinds=…][&compare=1][&url=…][&bench=1]`
(`pages/dev/MapGlDocPage.tsx`) runs the whole pipeline on an OCAD,
Mapper or `.oxvm` file chosen with the file input (or fetched from
`url`, e.g. a Vite `/@fs/` path) and shows the `LoadReport`: main-thread
read time, the worker's stage times, `load` (posted → resident layers
uploaded), `firstFrame` (base layers + large bucket drawn), `complete`
(the first view's detail drawn), cells, resident bytes per layer, GPU
bytes (arena capacity, atlas, visible set), bucket preparation
percentiles, draws, and main-thread long tasks. `via=document` (default)
goes through the map document — read → normalise → encode on the page,
decode → render bridge in the worker (`docs/map-document-format.md`) —
and reports the document's size, sections, hash and codec timings;
`via=reader` posts the S1 converter's render objects
(`ocadObjectsToRender`) to the worker instead. A `.oxvm` file skips the
reader. `mode=source` (default) draws the file's own symbol definitions
(`docs/map-import.md` §3.3) in the document's colour stack, proxies for
whatever stayed `null`; `pilot` / `envelope` swap in the S1 pilot family
by symbol code. "Bench" runs two 240-frame scenarios: `fit` (zoom 1→4→1
with a pan across a third of the map) and `paper1x` (1× paper at the
device pixel ratio — 96 CSS px per inch — centred on the densest cell,
panning one cell either way), each with CPU / GPU percentiles, the most
draws and resident bytes of any frame, visible-set rebuilds, evictions
and frames drawn with drawn detail still pending. Switches, for
measurement only: `worker=0` runs the worker's handler on the main
thread, `gate=0` prepares detail at every zoom, `budget=` sets the
residency budget (MB, default 150), `lod=0` turns off the glyph skip,
the text skip and the hatch tint, `kinds=fill,stroke,…` draws only those kinds; `compare=1`
also draws the same stream through the per-pass golden path into a
second canvas at a zoom where every stroke is ≥ 1.5 px and publishes
the fraction of pixels differing by more than 16 levels (§6.2's channel tolerance); `pick=1` (G5)
makes a click hit-test the document (`hitDocument`, 6 CSS px) and select the top hit through the
edit part, publishing the hits and the edit state as `__mapGlDoc.pick` once the frame that draws it
is drawn (the canvas's `data-pick`), and `window.__mapGlDocLines()` lists every line object's first
segment mid-point in client px. Pan by drag, zoom by wheel or pinch. Reports and the encoded document bytes are
published on `window.__mapGlDoc` for Playwright.

#### Tests

| Test | Covers |
|---|---|
| `map-gl/__tests__/strip.test.ts` | strip coverage = S1 extrusion away from edges for every cap × join × open/closed; 2 vertices per point on straight lines and flattened arcs; mitre limit; short-segment fallback; dots; dash slices with caps; ≥ 3× fewer bytes on a contour; even-odd earcut (hole order and winding, outside "hole", nested island); P7: rings crossing a convex ring — the shape's first vertex outside on the left, crossing the bottom with it inside, a band beyond both sides, a non-convex L over a rotated window's corner, a hole touching the outer's edge, a shape covering the window whole, one wholly outside (area and point coverage); a U and an E whose arms cross one edge, at fractional offsets and turns, and two nested non-convex rings covering the window (a grid parity oracle) |
| `map-gl/__tests__/buckets.test.ts` | assignment (centre, straddling, large by either dimension incl. stroke width), passes of an object together in stream order, `passBounds` (turned text: √2 em round each origin, B8); visible cells (margin, clamp, nearest first, rotation); zoom gate at 04's reference zooms; range table colour-major, contiguous, complete, layers, origin-relative positions and hatch offset, stroke packing; visible set (one draw per colour across buckets, rebasing, union of parts, hidden objects, instances by size class); clip groups (merge, separation, hidden); mesh atlas packing; LRU eviction |
| `map-gl/__tests__/arena.test.ts` | free list: first fit, exact accounting, coalescing, growth |
| `map-gl/__tests__/worker-protocol.test.ts` | `loaded` contents and transfer list; `prepare` queue replacement and slicing; first-view queue and the gate; base + detail + large covers every kind; load errors |
| `map-gl/__tests__/engine.test.ts` | residency through the real worker handler and a fake renderer: drawn + prefetch requested and uploaded; drawn parts never evicted, over budget reported; the same view never re-requests what was evicted; rebuild on drawn-set change but not on zoom within the cells; below the gate only base + large, queue cancelled; hidden objects |
| `map-gl/__tests__/view.test.ts` | view matrix: centre → clip origin, canvas edges → ±1, y-up, rotation; sub-pixel precision far from the origin in float32 arithmetic; `loupeView`: the point → clip origin, distances × scale, rotation kept |
| `map-gl/__tests__/prepare.test.ts` | per-pass path (fans, S1 extrusion), unchanged |
| `map-gl/__tests__/text-atlas.test.ts` | the committed pages are current (TTF hashes, 32 px / 8 px range, PNG size = recorded size, every glyph of the ranges on a page, none on two pages, Nordic / Baltic / Cyrillic letters found); plane bounds around the origin, atlas bounds inside the image, same scale both ways, 'H' plane bounds = outline bounds ± half the range; generator JSON → page (ids, y-up, empty glyphs dropped, refuses MSDF-only / bottom origin / code-point keys); glyph table layout and entry order; page selection; halo clamp |
| `map-gl/__tests__/buckets.test.ts` (text) | one quad instance per atlas glyph (origin-relative position, cos / sin from `angles`, em size, entry, halo), missing glyphs skipped, one draw per (colour, page), hidden objects skipped, unresolved pass draws nothing |
| `map-gl/__tests__/worker-protocol.test.ts` (text) | no pages → `TEXT_ATLAS_MISSING`, no text; Latin page → every glyph resolved, halos carried; Cyrillic not on the Latin page (counted) and drawn from page 1 when loaded; the dev `stream` source |
| `map-gl/__tests__/engine.test.ts` (text) | images to the renderer and the same pages to the worker; text bytes resident; no pages clears the renderer's atlas |
| `lib/__tests__/map-fonts.test.ts` | `loadTextAtlas`: only the pages asked for, in order, decoded as data; once per session; a failed page retried |
| `e2e/map-gl-doc.spec.ts` | the arena path through the real worker on `e2e/test.ocd` (pilot, envelope): buckets, complete frame, ≤ 300 draws on every bench frame of both scenarios; worker = inline; a 0.05 MB budget evicts, reports over budget and still draws; **arena = per-pass golden path within 0.5 % pixels** (envelope and source on the canvas, envelope into an offscreen framebuffer target, source on `test.xmap`); document vs reader path, native `.oxvm`, source mode, `.xmap`, decode error |
| `e2e/map-gl-golden.spec.ts` | the per-pass path against the reference raster; the **MSDF text tier**: `text-with-halo`, `lib-text`, `lib-halos` through the arena path (§6.2); the **filter-region arena tier** (D3, §6.2) |
| `e2e/map-gl-doc.spec.ts` (text) | arena = per-pass compare also on `e2e/test.xmap` (text, MSDF vs outlines) within 0.5 %; its text resolves on the Latin page with nothing missing |
| `e2e/map-vector-layer.spec.ts` (text) | the viewer requests the Latin page and not the Cyrillic one |
| `map-gl/__tests__/worker-course.test.ts` | dynamic bucket: static parts on the completed stack (upper white below upper purple, rows above it +1 with their CMYK), the document's stack without `courseLayer`, an unaligned stack unsupported and unchanged; a course request → one `all` part at `COURSE_BUCKET` on the completed stack (lower-purple strokes, text instances, glyph meshes in the grown atlas, earlier meshes in place, object ids after the document's, everything transferable); no atlas when nothing was added; lower purple drawn under black in one visible set; `null` and unsupported replies; a white-out at upper white above black; a toner saver's white the last colour drawn, after the document's top row and upper purple (P1); a request whose derivation throws answers `error` with its generation (F20b) and the next is answered (F20) |
| `map-gl/__tests__/engine.test.ts` (dynamic bucket) | `setCourse` uploads `C`, drawn below the zoom gate too, rebuilt at once, `onCourse` / `onChange`, `engine.colours` = the reply's; one request in flight (F20): of three calls during one request the first and the last are posted, both replies drawn in order, the middle never sent; `null` recorded and posted like any input, releasing `C`; the inputs before the load → one request with the last, right after the load message; a `load` during a request re-posts at once with a new generation and the older reply is dropped; a worker `error` ends the request and the recorded input goes; F20b: a course `error` of an overtaken generation ends nothing and leaves the load in flight standing, the matching one ends the request (its late reply dropped, the waiting input drawn), one of an older generation leaves the request in flight; course bytes fixed |
| `map-gl/__tests__/buckets.test.ts` (filter regions) | per colour the unmasked draw then one per mask, the same indices regrouped, `layers` in draw order, hidden objects win over masks, no `filter` without entries; instance draws and clip groups split by mask |
| `map-gl/__tests__/worker-course.test.ts` (filter regions) | a `hide` region hides the document object meeting it, exact and `fastFilter` alike, never a course object; a far region hides nothing; a clip region by document colour → `(object, colour, mask)` on the completed stack and the region's triangles origin-relative; the course part stays unmasked in the visible set; no regions / `null` → no filter |
| `map-gl/__tests__/worker-protocol.test.ts` (filter regions) | a `stream` source with masks → `loaded.filter`, one entry per (object, colour), transferable; none without masks |
| `map-gl/__tests__/engine.test.ts` (loupe) | `renderInset`: one more `renderDocument` with the loupe view into the inset target, the page clip forwarded, `compositeInset` at the box; no rebuild, no worker message; nothing before the load; `releaseInset` forwarded |
| `map-gl/__tests__/engine.test.ts` (filter regions) | a clip region masks the black line's draw, a hide region removes it, the reply's hidden ids join `setHidden`'s, `null` clears mask and hidden set |
| `map-gl/__tests__/prepare.test.ts` (filter regions) | every item of a masked pass carries one fan per region, shared by the passes of one mask |
| `map-gl/__tests__/worker-patch.test.ts` (G4) | object identity: range-table ids are the `objectIndex`, though the bridge drops an object of a hidden symbol; a load without a patch, with `null`, a disabled or an empty patch → the identity state and the same parts; hide → ids only, nothing touched; modify within a cell → that cell only, the object under its own id at its new place, the queue preparing the new content; a move across cells → both touched, the old cell out of the detail set; add → id N in its cell; add outside the grid → the large bucket, `null` once removed; resymbol to a patch symbol with a new glyph → the atlas grown, earlier meshes in place, the instance on the new mesh; hide + modify → hidden wins, nothing touched; a second change elsewhere → its cell only, the toggle off → parts deep-equal to the unpatched load's; detail only for the held cells; issues reported; transferables; a patch with the load drawn from the first frame; a request before the load → `error { patch }`; a request whose symbolisation throws → `error`, the next change diffed against the last reply; `worker-patch-failure.test.ts`: a request that throws while preparing puts the overlay, bytes and cut features back, the atlas it grew goes with the next reply; with a course layer: cut features skip a hidden boulder, course ids from `COURSE_OBJECT_BASE`, a hide region acts where a moved object is now and on an added one, clip regions over pinned and patch objects → the document's masks first, the patch's after, each with its own triangles |
| `map-gl/__tests__/buckets.test.ts` (G4) | `prepareBucketPartFrom`: two streams merged by colour into one colour-major range table, the first source first within a colour, each source's own glyph meshes; left-out passes absent; one source = `prepareBucketPart`; `sourcesHaveLayer`; `assignToGrid`: the load's grid by centre, outside it or large → the large bucket |
| `map-gl/__tests__/engine.test.ts` (G4) | `setPatch` before the load goes with it and the first frame hides the object; a change posts `patch`, never `load`, hide skips the object's ranges and the toggle off restores the same visible set; a touched cell's resident detail swapped in the same reply, a cell that left the detail set released and not asked for; a touched cell's detail in transit when the request went dropped and asked again (old part, then the new one); one request in flight, the latest next, a failed one rejecting only its callers; a worker `error` without a generation ends the request in flight and the waiting input is sent; a reply's atlas reaches the renderer, `L` replaced and cleared with its bytes; a reply re-posts the course |
| `e2e/map-gl-golden.spec.ts` (filter regions) | the four `filter-*` scenes on the per-pass path at the contract budget, and through the arena path at `ARENA_FILTER_MAX_RATIO` with pixel probes on both sides of each region (§6.2) |

### 5.4 Viewer

`MapViewer` hosts one base layer — the map document drawn by §5.2's arena
path (`VectorMapLayer`) — and keeps everything else it had: gestures,
measure, compass and rotation lock, GPS, the editor's gestures. The course
itself is drawn by the renderer in colour order with the map (C4,
"Overlay" below) and the React SVG keeps the UI layer. The PNG tiles
(`TileLayer`, `MapLoupe`, the tile-progress poll, the Web Mercator
viewport and the calibration affine) were the other base layer until E3
and were deleted in E4b; `documentHash` is a required prop.

#### Selecting the layer

```
panel = no map ? upload prompt : documentHash ≠ null ? viewer (vector layer) : import state
```

Since E3 there is no per-event switch (`docs/map-pipeline-switch.md`,
history note): every event draws its pinned document.
`documentHash` is `course.mapMetadata.documentHash` (the event's pinned
document, `docs/map-storage.md` §6.4); `MapPanel` passes it to
`MapViewer` (keyed on the event, the upload and the hash), and the viewer
draws its paper view. `data-map-pipeline` went with the tile path (E4b);
specs wait for `map-vector-layer` instead.

**A map without a pinned document** — its import queued or running,
failed, finished with a document the event does not use (an import that
waits for review), or a row restored from a pre-v0.6.1 dump the re-match
has not imported yet (§7.3 of `map-storage.md`) — mounts no viewer. `MapPanel`
shows `MapImportState` (`data-testid="map-import-state"`) from
`mapImport.latestForEvent`, `data-state` by `mapImportView`
(`lib/map-import-view.ts`):

| Latest job | `data-state` | Shows |
|---|---|---|
| loading, `queued`, `running` | `pending` | "The map is being prepared…" and the progress; polled every 2 s |
| `done` with a document | `review` | "imported and waiting for review", a link to `/:nameId/map-review/:hash` (`map-import-review-link`); the panel re-reads `mapMetadata` once, so a pin made meanwhile mounts the viewer |
| `failed` | `failed` | the job's error |
| none, or not readable (a kiosk without `courses.view`) | `unknown` | "not prepared yet — upload the map again" (the Maintenance → Map documents hint until the backfill went in E5) |

Decided overnight by the E3 session (for user review): the review link
is the `done` job's document, not the failed one's — a failed job has no
document to review.

#### Viewport

`lib/map-viewport.ts` holds the viewport model, the paper view (the Web
Mercator `mercator` view of the tiles went in E4b):

| | `PaperViewport` |
|---|---|
| State | `centreX`, `centreY` in paper µm (y-up), `pxPerUm` (CSS px per µm) |
| Map mm ↔ inner px | `x = w/2 + (1000·mmX − centreX)·pxPerUm`, `y = h/2 − (1000·mmY − centreY)·pxPerUm` |
| WGS 84 ↔ inner px | `mapGeo.wgs84ToPaper` / `paperToWgs84` on the document's paper frame, then the row above |
| Zoom limits | 0.05 … 100 CSS px per paper mm |
| Fit | `header.bounds` in paper mm (`boundsMm`) |

"Inner px" is `MapViewer`'s rotated inner frame (size
`rotatedBoundingBox(container, rotation)`, centred on the container). The
operations are `geoToInner`, `innerToGeo`, `mmToInner`, `innerToMm`,
`zoomAt(vp, ctx, anchor, Δlog2, target)` (the point under the anchor moves
to the target: wheel = same point, pinch = the fingers' midpoint),
`panBy`, `centreOnGeo` (GPS follow), `centreShiftPx` (the measure tap's
drift test), `fitMm`, `pxPerMapMm` (the overlay's symbol scale),
`metresPerPx` (scale bar, GPS accuracy ring) and `mercatorEquivalentZoom`;
distances (scale bar, measure, GPS accuracy ring, a dragged control's leg
lengths, `data-zoom`) use the frame's `header.mapScale`, the scale its
transform uses (the viewer takes no `mapScale` prop). The view starts from `fitMm(boundsMm(header),
container, 5 % padding)` — the legacy fit's padding; fits to controls take
the controls' own paper mm plus the 2.5 mm ring, focus on one control the
legacy one-sixth extent around it.

**One transform (10 §6 point 3).** Map mm are paper mm (× 1000 = µm),
and every WGS 84 input — the GPS position and its accuracy ring,
`gpsRoutes`, controls known only by lat/lng, GPS follow, the
`data-center-*` attributes — goes through `mapGeo` and nothing else (the
calibration affine of the tiles went with them, E4b).
`gpsRoutes` are converted to paper mm once per route set (`useMemo`), so
a pan or zoom scales them without calling proj4. The paper frame is
`paperFrameOf(header, rotationCorrection)`: `unitsPerMm`, `mapScale`,
`georeferencing` from the header, `correctionDeg` from
`map_files.rotation_correction` (`mapMetadata.rotationCorrection`). A
document without a usable CRS still draws; the geo inputs are then
omitted (no GPS marker, no tracks, no `data-center-*`).

**Rotation.** The inner frame's clockwise CSS angle is

```
−(northOffset − cutRotationDeg) + userBearing     (0 tilt when either is null)
```

`northOffset` is the display bearing (paper +Y from true north plus the
drawn meridians' tilt, `mapGeo.mapFileMetadata`) and `cutRotationDeg` its
paper-north part, so their difference is the meridian tilt from paper +Y.
The paper view is paper-north-up, so only the tilt is undone: the drawn
meridians stand vertical. The user's two-finger bearing adds on top.

#### Layer

`VectorMapLayer` (`components/VectorMapLayer.tsx`) draws into a canvas the
size of the container's content box, **not rotated**: the rotation is in
the GL view. `glView(paperView, containerW, containerH, dpr, rotDeg)` is
the §5.2 `ViewRect` — the same centre, `pxPerUm · dpr`, the container at
device pixels, `rotationDeg = −rotDeg` (the view matrix is
counter-clockwise). Canvas and inner frame share their centre, so the
overlay's `mmToInner` composed with the CSS rotation and the canvas's view
matrix agree to < 0.5 CSS px at every point, rotation and DPR included
(unit test). Nothing is resampled at any angle.

Lifecycle: on mount the layer creates the `MapGlRenderer` and the engine
over `workerTransport()` with the budget, then loads the fonts
(`lib/map-fonts.ts`, the three Liberation faces of §4.10, fetched once per
session) and the text atlas pages the document's strings need (§5.2
"Text atlas"; Latin alone, then none, if a page fails) and calls
`engine.load` with the document bytes (a copy: the
original stays with the cache), `{ unmatched: "proxy", proxyColours }`
(the stack's darkest colour for lines, points and text, its lightest
non-white for areas — `render.stackProxyColours`, since I5 also the
render bridge's default, so print and thumbnails draw proxies alike,
`map-document-format.md` §8), the event's patch (`patch` prop, §5.2 "Object
identity and the patch") and the current view as `firstView`. A change of
`patch` goes to `engine.setPatch` without remounting the canvas or
reloading the document. Every view
change and every `engine.onChange` asks for one redraw on the next
animation frame (`setView` then `render`; a canvas resize happens in the
same frame). With the `loupe` prop (`VectorLoupe`: the point in paper µm,
the circle's centre and diameter in container CSS px, the scale) the same
frame then calls `engine.renderInset` (§5.2 "Render target"; CSS → device
px by the canvas's ratio), and the first frame without it releases the
inset target (§5.5 "Loupe"). Colours are the document's stack, `render.cmykToHex` of
each `header.colours[i].cmyk`. Unmount disposes the engine (terminating
the worker) and the renderer.

The canvas carries `data-testid="map-vector-layer"`,
`data-document-hash`, `data-patch-version` (the patch version last drawn,
`"0"` for none; absent until the load), `data-status` (`loading` → `drawn` → `complete`;
`error`, `webgl`) and `data-ready="true"` once the first view's detail is
resident (`engine.whenComplete()`). A failed load shows a message with
*Try again*; a browser without WebGL2 (the renderer fails to construct)
shows "cannot draw the map" (`data-status="webgl"`) — there is no tile
fallback since E3. **A lost context** (`webglcontextlost`) remounts the
canvas once (`key` = the attempt, a fresh element and context; the canvas
carries `data-attempt`) and loads again; a second loss in the layer's
life shows the same message. Every phone and desktop browser the club
uses has WebGL2 (B-gate, D-mobile).

**Budget** by the document's provenance (§5.2 "Arena and buckets"):
`course.mapMetadata.clubMapVersionId` (additive, the event's
`map_files.club_map_version_id`, null for an event's own upload; user
decision 2026-10-22) set → `mapBudget="club"`, 150 MB
(`CLUB_BUDGET_BYTES`); null → `"event"`, 30 MB (`EVENT_BUDGET_BYTES`).
`MapPanel` maps the one to the other; `MapViewer` defaults to `"event"`.

#### Host

`MapViewer`:

- fetches the document through `useMapDocument(hash, nameId)` (delivery:
  `docs/map-storage.md` §7.1) and shows *Loading map…* until the header
  is there, or the error with *Try again* (offline and not cached,
  no access, not found, unreadable);
- fetches the event's patch beside it (G4; `useMapPatch(nameId,
  patchVersion)`, `lib/map-document-cache.ts`): `GET
  /api/maps/:nameId/patch` (`map-patches.md` §3.3) with the kiosk key as
  a header, revalidated with `If-None-Match`, kept per event for the
  session; asked again when `mapMetadata.patchVersion` (`MapPanel`'s
  `patchVersion` prop) differs from the session's copy and when the page
  regains focus, becomes visible or comes back online — there is no live
  channel. The layer gets the patch paired with its document
  (`patchForDocument`: none when `documentHash` is another document's)
  and does not wait for it: until it answers, the document is drawn as
  pinned. A failed fetch keeps the session's copy, else none; an
  unparseable patch is none, with a warning. `setMapPatch` replaces the
  copy for every viewer of the event (Map mode's writes, G6:
  `course-editor.md` §13). Viewer,
  kiosk and editor all mount `MapViewer` through `MapPanel`, so all three
  draw the effective document;
- needs no map bounds or calibration (a map without a CRS draws without
  geo inputs); the editor's loupe is drawn by the layer (§5.5
  "Loupe");
- needs no ink split: the vector layer draws the course layer in the
  map's own colour order ("Overlay");
- exposes `data-centre-x`, `data-centre-y` (µm), `data-px-per-um` and
  `data-rotation` on `map-viewer`, and `data-center-lat` /
  `data-center-lng` (the view centre through `paperToWgs84`) and
  `data-zoom` (the Web Mercator zoom with the same ground resolution at
  the centre), the meaning they had over tiles.

#### Overlay (C4)

Under `vector` the course is **part of the drawing**: `MapViewer` turns
what it already has into the course layer's input and `VectorMapLayer`
hands it to the engine's dynamic bucket (§5.2 "Dynamic bucket"), so the
7xx symbols sort into the document's stack — lower purple (701, 703,
705, 706, 708) under black, brown and blue line art, white-outs
at upper white above the map's ink, upper purple (704, 707, 709,
711) on top, and a toner saver's white above everything of the map
layer (`course-layer.md` §3.6, P1). What the layer draws and what it does not:

| GL course layer (dynamic bucket) | SVG UI layer (React, screen widths) |
|---|---|
| start triangles (turned to the first control), circles with automatic and authored gaps, finish, legs clipped at circles and gapped at compact features, control numbers placed by the shared placer with manual offsets and leaders, imported courses' authored leg pieces and bends, circle gaps, 707 / 708 / 711 lines and 709 areas | selection ring, phantom, action-bar anchors, move warnings; status rings (readout punch state `ok` / `missing` / `extra`, highlighted control) around the GL symbol; completion rings, punch-count badges; the editor's faded off-course controls (left out of the layer, drawn as plain circles at 0.3 opacity, `control-faded`); class leg pills (multi-course); GPS position, and tracks in 2D (in 3D the GL frame draws them on the terrain, §5.4 "3D mode", H8); measure; the description sheet; the editor's tool shapes |

The SVG draws no course symbol, leg, route or number: E4b deleted the
legacy SVG course paths (the GeoJSON of `course.courseGeometries`, a
procedure E6 deleted with `course.geometry`; the
straight fallback legs, `placeControlLabels` on screen, the broken
circles) with the editor's SVG hit targets. The description sheet reads
the courses and the control rows only (`ControlOverlay.description`,
`CourseOverlay` length, climb and instructions).

**Input.** `courseLayerRequest()` (`lib/course-layer-request.ts`, pure;
`course-layer.md` §5) from the viewer's props: sites are the visible,
positioned controls at their own paper mm (the editor's dragged control
and round-tripping moves applied), the structure is
the highlighted courses (one or an array; `null` when none), label offsets
are the single course's (stored, pending or being dragged — only with the
description sheet or the editor, as before), `labelMode` is `sequence`
for one ordered course with the sheet or the editor and `code` otherwise,
`allControls` when a drawn site is on no highlighted course, `objects:
[]` (no layout objects reach the viewer) and `appearance: {}` — the
library's sizes × the document factor (`course-layer.md` "Decisions":
ISOM at 1:7 500 draws 5 mm-radius circles where the SVG drew 2.5 mm).
`course.courseGeometries` is no longer an input (D1): the stored legs
(gaps, style, bends, corridor — F2), hidden numbers and circle cuts come
from the stored structure and the controls (`course.list` `legs` /
`hiddenNumbers`, `controlCoordinates`
`circleGaps`; `course-layer.md` §5, §6.4), and 707 / 708 / 709 / 711 are
course objects. The worker cuts the rest from the document's own
features (`cutFeaturesOfDocument`, extracted once per load) — unless the
request's `viewOptions.autoCuts` is `false`, the event's **Auto cuts**
toggle off, which `MapPanel` reads from `course.getOverprintCuts`
(kiosk-readable) and passes to `MapViewer` (`course-layer.md` §3.4, D17).
`MapPanel` passes what it passed before; every 09 §1 call site — kiosk,
`CardReadout`, `CardMapPreview`, dashboard, `TracksPage`, the editor —
follows through it.

**UI layer geometry.** The engine's `onCourse` reply carries the layer's
derivation (sites, number positions, legs), the symbol sizes in paper mm
and the hit index (§5.5); the UI layer sizes its status, selection and
completion rings by those sizes, and the editor's targets are the hit
index's (§5.5 "Editor targets"). A move or a label drag is a new input
per pointer move; the engine keeps one request in flight (§5.2 "Engine"),
so the layer re-derives at the worker's rate and every reply redraws.

**Fallback.** A document whose stack has no lower and upper purple
(`LoadSummary.courseLayer.supported === false`, `CourseStackError`) draws
the map and **no course**, and says so: a one-line notice over the map
(`data-testid="map-course-layer-unsupported"`, "This map's colours are
not aligned for the course layer, so no course is drawn. Re-import the
map to show it."). The UI layer still draws (status rings, badges, GPS, the description
sheet); the editor has no hit index, so on such a map it cannot select,
drag or click a leg. The map shows its course again once it is
re-imported with an aligned stack. Before the load answers, the viewer
assumes support. E0 found no such document on prod. Decided overnight by
the E3 session (for user review): the notice, not GL fallback colours;
E4b deleted the SVG course paths that drew the course under the notice
until then, and the notice's wording with them (it had said the course
is drawn on top of the map) — decided overnight by the E4b session, for
user review.

**Attributes.** `map-viewer` carries `data-course-layer="gl"` (the
layer draws the course) or `"none"` (the fallback above). Under `gl` the
viewer mirrors the layer as a hidden list: `course-layer` > one
`course-site` per drawn site (`data-site-id`, `data-role`, `data-x/y` in
paper mm) holding its `course-label` (`data-text`, `data-x/y`), and one
`course-leg` per drawn leg piece (`data-course`, `data-leg`,
`data-points` in paper mm) — what the canvas draws, for tests (`hidden`:
not in the accessibility tree; an accessible map description is slice
D's editor work). With an editor, `data-editor-hit="shared"`.

#### 3D mode (H7)

The viewer's 2D / 3D switch: the same canvas, engine and context draw the
document draped over its height field (§5.6) under a perspective camera.
Research 10 §5 step 3, §8; slice H answers 6 and 7.

**Decided with the user (H7, 2026-11-15)**

1. **Exaggeration**: default **2×**, a control from 1× to 5× in steps of
   0.5 (`EXAGGERATION`), remembered per browser
   (`oxygen.map.exaggeration`). The H-gate's club member may move the
   default. §5.6 decision 2 left it here.
2. **The sheet beyond the field** (§5.6 decision 4): the viewer pads the
   field with **no-data cells out to the document's bounds** (`boundsMm`
   of the header) before it reaches the engine. §5.6 "No-data" draws them
   at the nearest data cell's height with flat normals, so the title,
   legend and margins are drawn in 3D in their printed colours and the
   field's edge has no wall. A truly flat apron (decision 4's word) would
   leave a step wherever the edge is not at the apron's height.
3. **The field's share of the budget** (§5.6 decision 5 counts it, sets no
   limit): the viewer **coarsens** the padded field by the smallest whole
   factor `f` for which `W · H · 5 ≤ budget / 3` and both sides ≤
   `min(4096, MAX_TEXTURE_SIZE)` — a cell of the result is the mean of the
   data cells of its `f × f` block, no-data when more than half of the
   block is no-data, confident when most of its data cells are. A club
   map's 150 MB never coarsens a corpus field; an event map's 30 MB takes
   a sprint's 0.2 mm cells to 0.4 mm. The drape keeps its own third
   (decision 5), so field + drape stay within two thirds.

**Decided with the user (H11, 2026-11-15)** — choosing the surface; the
rules are in "Surface (H11)" below.

4. **"The map's terrain" when a DEM is ready**: the viewer draws the
   **DEM-anchored contour field** (`terrain.dem.anchored`,
   `contours.<provider>-<res>`, `docs/map-terrain.md` §7) when
   `terrain.dem.state` is `ready` and its `decided` ≥
   `TERRAIN_3D_MIN_DECIDED`, else the plain `contours` field. The 80 %
   gate (answer 7) is read on the field that is drawn. The anchored
   field's heights derive from the provider's data, so it shows the
   provider's attribution like ground does (answer 16).
5. **"Tracks default to the DEM"**: with GPS routes shown and ground
   (`terrain.dem.ground`) ready, entering 3D draws **ground** — the coarse
   GLO-30 ground too, labelled with its resolution (answer 13). Without
   routes, 3D opens on the map's terrain. Tracks always take their height
   from the surface that is drawn, never from the other one.
6. **Ground below the contour gate**: a ready ground surface **opens 3D
   on its own** when the map's contour field is below the gate; the
   map's-terrain choice is then disabled and names its percent. H7's
   offer row "`ready`, `decided` < 0.8 → unavailable" applies only where
   no ground is ready.

**Where it is offered** (answer 6): every `MapPanel` mount except the
editor (`editor` set) and the kiosk (`MapPanel allow3d={false}` from
`KioskPage`) — the viewer, the shell's map pane, the readout and runner
previews, the dashboard and the Tracks page. A viewer with
`hideControls` has no buttons, so no toggle either.

**The offer** (`terrain3dOffer(terrain, host)`, `lib/map-3d.ts`) reads
`course.mapMetadata.terrain` (`docs/map-storage.md` §4.7 "Descriptor")
through `terrain3dSurfaces(terrain)` ("Surface (H11)" below): the map's
terrain first, else ground. Without a ready DEM (`terrain.dem` absent,
or any state but `ready`) there is no ground and the table is H7's:

| Descriptor | Toggle (`map-3d-toggle`) | Reason (`data-terrain-reason`) |
|---|---|---|
| null, `none`; no ground | not shown | `no-contours` |
| `over-cap`; no ground | shown, unavailable | `over-cap` |
| `ready`, `decided` < `TERRAIN_3D_MIN_DECIDED` (0.8) on the field drawn (decision 4); no ground | shown, unavailable | `low-confidence` (the floored percent of the plain field, as the review's line) |
| `pending` | shown | — (the click fetches, which derives; the descriptor is read again and the gate applied) |
| `ready`, `decided` ≥ 0.8 on the field drawn | shown | — |
| the map's terrain unavailable, ground ready (decision 6) | shown | — (3D opens on ground) |

An unavailable toggle is `aria-disabled`; a click shows the reason
(`map-3d-notice`) and stays in 2D. A `pending` document is not derived
until someone asks for 3D (a derive is up to ~20 s of server time).

**Fallback.** Whatever refuses or loses 3D leaves the 2D view drawn and
names the reason in `map-3d-notice` for a few seconds:

| Reason | When |
|---|---|
| `low-confidence` | after a `pending` fetch, the re-read descriptor is below the gate |
| `no-contours`, `over-cap` | a `pending` descriptor's fetch answered 404 with that `reason` (the derive found no contours, or the cap); the descriptor is read again and hides or disables the toggle |
| `unavailable` | the field cannot be had: offline and not stored, 401 / 403, another 404, 503, unreadable bytes |
| `webgl` | `engine.setTerrain` rejects (a field over the texture limit, a lost context) |
| `unavailable` | after a `pending` fetch, the descriptor read again is still `pending` or the read fails |
| `ground-unavailable` | ground cannot be had (any error above) where the map's terrain can: 3D stays, on the map's terrain (H11) |

**Field** (`hooks/useHeightField.ts`): `loadHeightField(url, opts)` fetches
the descriptor's `url` as given (`/api/map-documents/:hash/height.bin?v=`,
with `&source=ground.<p>` / `&source=contours.<p>` for the DEM's fields)
through `venueAwareFetch` with the document's headers
(`x-event-id`, `x-kiosk-key`), decodes it with `decodeHeightField` from
the field's client entry, and keeps it like the document (§5.4 "Host"):
one request per URL shared by concurrent callers, **three** decoded
fields in memory (`FIELD_MEMORY_ENTRIES`: a document's plain, anchored
and ground fields, so a surface switch asks nothing again, H11), a copy in Cache Storage `map-heightfields` under the full URL
(app-written; the service worker has no route for it) that serves it
offline, failures not cached. `useHeightField(url, eventId)` asks only
while `url` is non-null — the viewer sets it on the first switch to 3D —
and returns `{ state: idle | loading | ready | error (kind), retry }`.
`viewerField(field, boundsMm, budgetBytes, maxTextureSize)`
(`lib/map-3d-field.ts`) pads and coarsens it (answers 2 and 3), on the
main thread, once per field, budget and texture limit (kept per URL,
as many as the memory entries, for a re-entry and a surface switch).

**State.** The 2D state stays the state: `PaperViewport` (centre, zoom)
and `userBearing`, plus `pitchDeg`. Zoom buttons, fit, GPS follow, the
compass and the `data-centre-*` attributes work on it unchanged in 3D.
The view is `View3d { centreX, centreY, pxPerUm, bearingDeg, pitchDeg }`
with `bearingDeg` the GL view's `rotationDeg` (−the inner frame's angle).

- **Entering** 3D (the toggle, once the field's mesh is up) sets pitch
  **45°**; pitch is clamped to [0, **70**] (`PITCH`: H6 measured at 60°;
  beyond 70° the footprint reaches the whole map, §8 "Club-full tilted
  close up"). No animation.
- **Leaving** keeps centre and zoom; the bearing is kept when the rotation
  lock is off and reset to north up when it is on (the lock's promise in
  2D). The engine gets `setTerrain(null)`: 2D pays no field bytes, and a
  re-entry prepares the field again in the worker (the decoded field
  stays in memory).
- The mode is not remembered; the exaggeration is.

**Camera** (`camera3d(view, scene)`): the target is the view centre (model
µm, the arenas' origin removed) at **`targetZ`, the mesh box's mid-height
at the drawn exaggeration** — constant while the field and exaggeration
are, so pans, zooms and orbits are exact on the target's plane and the
camera does not bob over the ground; `distanceUm =
distanceForPxPerUm(pxPerUm · dpr)`; `bearingDeg`; `pitchDeg`; the canvas's
device size. At pitch 0 this is the 2D view (the §5.6 hand-over), so
entering and leaving 3D at pitch 0 changes no pixel (§5.6 "Drape layers").

**Drawing** (`VectorMapLayer`): props `heightField` (the fitted field,
`null` in 2D) and `terrain` (`{ camera, exaggeration }`, `null` in 2D),
`onTerrain` (`{ mesh, field }` once the mesh is up — the model origin is
`mesh.originUm` — and `null` when it goes: the field dropped, or the
engine remounted) and `onTerrainError`. After the load (and after a remount) the
layer calls `engine.setTerrain(heightField)`; a superseded rejection is
ignored. A frame with `terrain` and a mesh is `engine.renderTerrain(terrain,
opts)` with the colours and `background` paper white; every other frame
is the 2D `setView` + `render` (+ loupe), which re-selects the 2D view
by itself. Every camera change and every `onChange` (settle timer,
arrivals, §5.6 "Settling") is one redraw. The renderer is made with `{
depth: true }` (the mesh's depth test). The canvas carries `data-mode`
(`2d` / `3d`, the frame last drawn) and `data-terrain-ready="true"` once
the camera has been still for 250 ms, `whenComplete()` has resolved and a
3D frame followed; a 2D frame forgets it, so a re-entry waits again.

**Gestures** (`lib/map-3d.ts`, pure, `reduceGesture3d(state, event,
scene)`): the 3D view takes the pointer, touch and wheel events on the
viewer in the capture phase, before they reach the UI layer or the 2D
handlers, wherever they start — on the canvas or on a ring of the UI
layer — except on the viewer's own controls (buttons, inputs, labels).
A gesture's moves are followed on the window, without pointer capture,
so a click on a ring still reaches the ring. `map-3d-surface`, a layer
over the canvas under the UI layer, carries the cursor and the
`touch-action`. The 2D handlers are not involved.

| Input | 3D |
|---|---|
| left drag, one finger | pan: the grabbed ground point (the pick, else the target's plane) stays under the pointer (ray ∩ the horizontal plane at its height) |
| wheel | zoom by ±0.15 log₂ about the ground point under the cursor (same rule), within the 2D zoom limits |
| right drag, ctrl / ⌘ + left drag | orbit: 180° of bearing per container width, 90° of pitch per container height (drag up tilts towards the horizon) |
| two fingers | classified in their first 8 px and held: **tilt** when both move vertically the same way (each ≥ 8 px, the fingers' distance and angle steady) — pitch by the midpoint's vertical motion; otherwise **pinch** — zoom about the midpoint and pan with it, plus **twist** of the bearing once the angle passes 8°, whatever the 2D rotation lock (orbiting is what the mode is for) |
| compass | bearing to north up (as in 2D); pitch kept |

One finger follows 2D's rule: on a coarse pointer outside fullscreen it
scrolls the page (`touch-action: pan-y`) and the map takes two fingers.
A gesture breaks GPS follow as in 2D. Measuring and the editor's
gestures are 2D-only: the measure button is hidden in 3D and entering 3D
ends a measurement.

**UI layer** (the SVG over the canvas): in 3D the overlay frame is
unrotated and container-sized, and every paper point reaches it through
the camera (`projector3d`: the surface height at the point — `surfaceZ`,
`targetZ` off the mesh — then the camera matrix, CSS px; null behind the
eye) instead of `mmToInner`; screen points go back through `screenRay` +
`pickTerrain`. WGS 84 inputs still reach paper mm through `mapGeo` only.

- Rings that circle a draped symbol (status, completion, click targets)
  take the anchor's ground affine (the projection's 2 × 2 Jacobian there,
  over the centre's scale) as an SVG transform, so they lie on the ground
  around the drawn circle; at pitch 0 the affine is a rotation, which
  leaves a circle as it is.
- Markers and labels stay upright and unscaled at their projected anchor:
  punch badges, leg pills, the GPS dot and its accuracy ring (radius at
  the anchor's scale).
- GPS tracks (`gpsRoutes`) are not in the SVG in 3D: the GL frame draws
  them on the terrain (H8, "Tracks on the terrain" below).
- The course is in the drape (§5.4 "Overlay"): no SVG course symbol in 3D
  either. Control numbers are part of it, foreshortened with the ground.
- No occlusion test: a marker behind a hill is drawn over it (§8).
- The scale bar is hidden at pitch > 0 (the scale varies over the screen).

**Tracks on the terrain (H8).** In 3D the viewer's `gpsRoutes` are
`TerrainLine`s (§5.6 "Lines") that `MapViewer` hands to `VectorMapLayer`
(`terrainLines`), and the GL frame draws them after the mesh: lifted a
constant above the surface and depth-tested against it, so a hill hides
the part of a track behind it. In 2D they stay the SVG `<path>` they
were (`data-testid="gps-route"`).

- Input: the same paper mm as 2D (`gpsRoutesMm`, WGS 84 through `mapGeo`
  once per route set); colour the route's (`#rrggbb` or `#rgb`; any other
  CSS colour, which no caller passes, falls back to the single-track red
  `#e6194b`), opacity 0.8, width 4.5 CSS px — the 2D path's.
- Height: the surface the frame draws (`surfaceHeight` of the engine's
  mesh — whichever field "Surface (H11)" chose; a switch is a new mesh,
  which re-lifts the lines).
- `VectorMapLayer` passes them with the frame (`renderTerrain({ …, lines,
  pxRatio })`); a new array is one redraw and one re-upload, a camera
  change neither. The canvas carries `data-terrain-lines` (the lines the
  last 3D frame drew; absent in 2D).
- For tests the overlay mirrors each 3D track as an empty
  `<g data-testid="gps-route-3d" visibility="hidden">` whose `data-points`
  are the projected CSS px of its points through `projector3d` (the
  ground line, not raised).

Decided with the user (H8, 2026-11-15):

1. **The GPS position stays H7's** upright SVG marker in 3D, not a GL
   line and not depth-tested: a person following their own position
   must not lose it behind a hill. The row's "the GPS position … become
   3D polylines" is read as the tracks only; marker occlusion stays its
   own Pending item (§8).
2. **No replay view is built**: none exists ("replay tails" in the row);
   H8 draws `gpsRoutes`, and §8 records where a replay's tails would go.

**Surface (H11).** Decisions 4–6 above; research 10 §1 (two surfaces),
§3 (attribution); blending them is later (§8).

`terrain3dSurfaces(terrain)` (`lib/map-3d.ts`, pure) reads the
descriptor's `dem` block (`docs/map-storage.md` §4.7; `DemDescriptorLike`)
into two surfaces:

| Surface | Field | When |
|---|---|---|
| the map's terrain (`map`) | `terrain.dem.anchored.url` (`contours.<p>`) | `dem.state` `ready` and `anchored.decided` ≥ 0.8 (decision 4) |
| | `terrain.url` (`contours`) | otherwise, by H7's table (`pending` derives on the fetch) |
| | — (`none` / `unavailable` with the reason and the plain field's percent) | H7's rows that offer nothing |
| ground (`ground`) | `terrain.dem.ground.url` (`ground.<p>`) | `dem.state` `ready` with a provider; else none |

- **Default** (`defaultSurface(surfaces, tracksShown)`): ground when it
  exists and either GPS routes are shown (`gpsRoutes` non-empty; the GPS
  dot alone does not count) or the map's terrain is not available
  (decisions 5, 6); otherwise the map's terrain.
- **The choice** (`map-3d-surface-choice`, in `Map3dToggle` while 3D is
  drawn, above the exaggeration control): two buttons,
  `map-3d-source-map` "Map terrain" / "Kartans terräng" and
  `map-3d-source-ground` "Ground" / "Mark" — "Ground (30 m)" / "Mark
  (30 m)" for a `coarse` provider (answer 13) — with `aria-pressed`;
  shown only where ground exists and the map's terrain is not `none`. A
  map's terrain below the gate is `aria-disabled` and its title names the
  reason and percent (decision 6). The choice holds for the mount, across
  re-entries, until the tracks come or go (the default changes with
  them); it is not remembered, as the mode is not. On the Tracks page a
  switch from one runner to the next keeps the previous track drawn until
  the next one is in (`getRoutePreview`'s `placeholderData`, dropped when
  the row is collapsed), so the tracks never blink out and neither the
  default nor the choice flips per runner.
- **Switching** stays in 3D: the fitted field drawn stays the layer's
  `heightField` while the other loads (the engine keeps its mesh until
  the new one is in, §5.6), every field handed to the layer counts as 3D
  (`in3d`) while its mesh is drawn, and centre, zoom, bearing, pitch and
  exaggeration are the 2D state's, so they are unchanged. The camera's
  `targetZ` follows the new mesh. Switching back asks nothing (three
  fields in memory, fitted per URL).
- **Ground that cannot be had** (any `useHeightField` error) where the
  map's terrain can: the choice goes back to the map's terrain and
  `map-3d-notice` says `ground-unavailable`; 3D stays. Where ground was
  the only surface it is H7's fallback (2D, `unavailable`).
- **A pending DEM** (`dem.state` `pending`): no ground; entering 3D asks
  `dem.ground.url` once in the background, which queues the job for a
  document imported before H10 (the route's 503, `docs/map-storage.md`
  §4.7). The descriptor is not read again for it (§8).
- **Attribution** (answer 16): while the drawn field is DEM-based — its
  header's `source` is not `contours`, i.e. ground or the anchored field
  — `map-dem-attribution` shows the header's `provider.attribution` and
  `provider.licence` ("Elevation data © Lantmäteriet, CC BY 4.0" /
  "Höjddata © Lantmäteriet, CC BY 4.0") in the map's bottom-left corner
  (`fieldAttribution(header)`). It is read from the field drawn, not the
  descriptor: the notice travels with the bytes (offline too). 2D, the
  kiosk, the editor and print draw no DEM-based field, so they show none.

**Attributes.** `map-viewer` adds `data-view-mode` (`2d` / `3d`),
`data-pitch`, `data-exaggeration` (3D only), `data-terrain-reason`
(the last fallback's reason until 3D is asked for again, else the
offer's), and in 3D `data-surface` (`map` / `ground`, of the field drawn)
and `data-surface-source` (its header's `source`: `contours`,
`contours.<p>`, `ground.<p>`; H11). `data-rotation` stays the GL
view's angle in both modes.

#### Call sites

Every 09 §1 call site reaches the base layer through `MapPanel` →
`MapViewer`; the only direct `<MapViewer>` mount is `MapPanel`, which
mounts it only with a pinned document.

| Call site | Path |
|---|---|
| `CompetitionShell` persistent pane | `MapPane` → shell-owned `MapPanel` |
| `KioskPage` | `MapPanel` (kiosk key from `?k=` → `x-kiosk-key`) |
| `CardReadout` + `CardMapPreview` | `MapSlot` → `MapPanel` |
| `RunnerMapPreview` (results, start list, runners) | `MapSlot` → `MapPanel` |
| `CompetitionDashboard` | `MapSlot` → `MapPanel` |
| `TracksPage` (GPS routes) | `MapSlot` → `MapPanel`; tracks through `mapGeo` |
| `EditorPage` (the course editor) | `MapPanel` with `editor` |

#### Tests

| Test | Covers |
|---|---|
| `lib/__tests__/map-viewport.test.ts` | centre, y flip, mm round trip, WGS 84 through `mapGeo` (1e-6 mm), no CRS, wheel and pinch anchors, clamp, pan, GPS centre, fit, scale, Mercator-equivalent zoom; rotation by the meridian tilt; a +3° tilted meridian vertical on the overlay and through `viewMatrix`; overlay = GL canvas < 0.5 px on 200 random views (rotation, DPR) |
| `lib/__tests__/legacy-caches.test.ts` | the retired `map-tiles` Cache Storage is deleted on start; no Cache Storage, a refused delete |
| `lib/__tests__/map-import-view.test.ts` | `mapImportView`: pending while loading / queued / running, review for a done job with a document, failed, unknown without a job or a document |
| `lib/__tests__/map-document-cache.test.ts` | route regex (documents, not previews); URL without query, `x-event-id` / `x-kiosk-key` headers; one request shared, same bytes; bounded memory; 401/403/404/5xx → kinds, failures not cached; offline; unreadable bytes; `storage.persist()` once, absent API; the patch (G4): the event's route with the kiosk key, kept for the session, `If-None-Match` revalidation (304 keeps the copy, a 200 replaces it and tells subscribers), no row = `NO_PATCH`, a failure keeps the copy else none and never rejects, one request per event, a wanted version joining a stale in-flight request asks once more (`refreshMapPatch`), an unparseable patch is none |
| `lib/__tests__/vector-map.test.ts` | paper frame with correction, bounds in mm, stack colours, proxy colours, budgets; `patchForDocument` pairs by hash |
| `e2e/map-vector-layer.spec.ts` | the pinned document by hash (no query, `x-event-id`), canvas ready and drawn, container-sized, `data-*` attributes; **the event's patch** (G4): on a black line on white paper, `mapPatch.applyChange` hides the objects there (`e2e/helpers/map-objects-at-cli.ts`) and adds a 2 mm line of the same symbol 2.5 mm off — after a `focus` the canvas's `data-patch-version` is the new version, the line's pixels are white and the added one is ink, with no new document request and the same `data-attempt`; `setEnabled(false)` restores both; wheel zoom keeps the paper point under the cursor (< 0.5 px); a GPS fix → follow centres it and the marker is at the viewer's centre; **lower purple under black**: a leg made across a black path on white paper (two controls through the API) is black at the crossing and lower purple 2 mm to either side, zoomed to ≥ 0.02 px/µm, with no SVG control label (fails with the course drawn on the top row); **without WebGL2** `data-status="webgl"`, the message; **a lost context** remounts once (`data-attempt` 1, ready again), a second shows the message; **no pin** (`map_files.document_hash` cleared): `map-import-state` `review` with the review link, no viewer; **an unaligned stack** (a palette-stripped copy of the document pinned by `e2e/helpers/stackless-document-cli.ts`): the layer draws, `data-course-layer="none"`, `map-course-layer-unsupported` shown, no `course-layer` mirror and no SVG `control-label`; in the editor a click on a control selects nothing (no hit index) |
| `lib/__tests__/course-layer-request.test.ts` | sites from visible positioned controls with kinds; highlighted courses as items (by flag or name, one or several, none → `null`); all-controls when a drawn site is on no course; sequence numbers only for one ordered course with the sheet or editor; single-course label offsets, pending ones winning; positions as given; faded controls left out; an imported course's preclipped legs → pieces, its cuts → circle gaps, extras; generated legs: bent path kept, automatic gaps and cuts not read, a leg count that does not match ignored |
| `e2e/map-control-circles.spec.ts`, `e2e/map-multicourse.spec.ts` | code labels of the selected course (the GL layer's `course-label` mirror), sequence numbers for one course with descriptions, codes for several; pills and the sheet SVG text; `data-course-layer="gl"` |
| `e2e/map-viewer-gestures.spec.ts`, `mobile-layout.spec.ts`, `course-editor*.spec.ts`, `wide-screen-map-pane.spec.ts`, `webserial.spec.ts`, `kiosk*.spec.ts` | the paper view's gestures, measure, event switching (vector layer ready) and the readout map, once in `chromium` (E3: no per-pipeline projects) |
| `lib/__tests__/map-3d.test.ts` (H7) | the offer table (hidden, unavailable with the floored percent, pending, available; editor and kiosk hidden); exaggeration clamp; the camera at pitch 0 = `viewMatrix` on the target's plane (50 random views, DPRs, bearings); `targetZ` mid-height; the projector at pitch 0 on flat ground = `mmToInner` + the CSS rotation < 0.5 px (200 random views); tilted over a cone, project → unproject within a cell; the ground affine a rotation at pitch 0, foreshortened by cos(pitch) along the view tilted; null behind the eye; pan and wheel zoom keep the ground point under the pointer < 0.5 px (flat and tilted); zoom limits; orbit rates and pitch clamp; two-finger classification (tilt, pinch by distance, angle, midpoint, null in the slop); the reducer: one-finger pan and the page-scrolling finger, orbit drag, wheel, pinch ×2, twist from its activation without a jump, tilt, two → one finger; bearing ↔ user bearing |
| `lib/__tests__/map-3d-field.test.ts` (H7) | padding by whole no-data cells on the grid to the bounds, `sampleHeight` unchanged inside, no copy when covered; coarsening means, the more-than-half no-data rule, confidence by majority, the corner kept; the smallest factor; a club budget pads only, an event map's coarsens by 2, a 1024-texel device |
| `hooks/__tests__/useHeightField.test.ts` (H7) | the descriptor's URL with `x-event-id` / `x-kiosk-key`, decoded; one request shared, the field kept; the Cache Storage copy serves offline and replaces the document's other versions of the same source; 403 / 404 with `reason` / 503 / 500 / unreadable / offline classified, failures not kept |
| `lib/__tests__/map-3d.test.ts` "terrain3dSurfaces" (H11) | no ground for every `dem` state but `ready` (and an absent or null `dem`), H7's offer then; ground when ready; the anchored field as the map's terrain at ≥ 0.8, the plain one below it or with no decided share, the plain percent when both are below; ground opens 3D below the gate and the gate holds without it; pending, `none`, `over-cap` as H7; the default (ground with tracks, or alone); `surfaceOfSource`; `fieldAttribution` (none for `contours`, the provider's for `contours.<p>` and `ground.<p>`) |
| `hooks/__tests__/useHeightField.test.ts` "three sources" (H11) | a document's `contours`, `contours.<p>` and `ground.<p>` kept side by side in memory and in Cache Storage; switching between them asks nothing again |
| `e2e/map-viewer-3d.spec.ts` (H11) | the descriptor's `dem` rewritten to `ready`, the DEM fields answered from the real `contours` field (`helpers/dem-field.ts`: the same grid, a DEM `source` and provider, ridges for ground): 3D opens on the anchored field with "© Lantmäteriet" and "CC BY 4.0" shown; ground is one request with `x-event-id`, changes the pixels, never passes through 2D (a `MutationObserver` on `data-view-mode`), keeps centre, zoom, pitch, bearing and exaggeration; back to the map's terrain asks nothing; 2D shows no attribution; no DEM (the stack's): no choice, no attribution; ground below the contour gate opens 3D, the map's terrain `aria-disabled` with 80 % / 50 %; ground aborted: `ground-unavailable`, never through 2D, still 3D on the plain field, which shows no attribution; ground as the only surface aborted: 2D with `unavailable`; the coarse provider labelled "Ground (30 m)" with its own attribution; leaving and re-entering 3D keeps the choice and asks nothing; a pending DEM: no choice, its ground asked once with `x-event-id` on the first entry only; on the Tracks page with a track shown 3D opens on ground with the track drawn (`data-terrain-lines="1"`), the map's terrain on request re-lifts it, and the next runner's track keeps that choice and 3D throughout |
| `e2e/map-viewer-3d.spec.ts` (H7) | the seed map (no contours): no toggle, `data-terrain-reason="no-contours"`; the demo map imported and pinned: one `height.bin?v=` request with `x-event-id`, `data-view-mode="3d"`, canvas `data-mode="3d"` and `data-terrain-ready`, pitch 45, exaggeration 2, the frame differs from 2D and carries the map's ink, measure hidden; a right-drag raises the pitch and turns the bearing, the compass resets it; a right-drag and a wheel that start on a control's ring of the UI layer orbit and zoom the 3D view (not the 2D handlers); exaggeration 5 changes the frame; two CDP touches moving up raise the pitch; back to 2D the frame equals the 2D one (< 0.5 % of pixels), re-entry asks for neither field nor document; a followed GPS fix on the screen's vertical centre line; the descriptor rewritten below the gate (79.6 %): the toggle `unavailable`, `aria-disabled`, its title the reason, a click shows `low-confidence` and stays 2D; the descriptor first `pending`: the switch fetches, the descriptor is read again and 3D is drawn; an aborted field: `map-3d-notice` `unavailable`, 2D drawn; **a GPS track (H8)**: a route inserted for `itest` (`e2e/helpers/gps-route.ts`) expanded on the Tracks page in the wide screen's pane — in 2D one SVG `gps-route` and no `data-terrain-lines`; in 3D `data-terrain-lines="1"`, no SVG path, the canvas route-red on or just above > 70 % of the mirror's projected points and > 300 route-red pixels, collapsing the row leaves under a tenth of them in the same view; back in 2D the SVG path. `MAP_3D_SHOT=1` writes `docs/screenshots/map-3d.png` and `map-3d-track.png` (the latter cropped and reduced to 256 colours for the docs) |

### 5.5 Editor

What the course editor (`docs/course-editor.md`) adds to the viewer.
Research: 04 §7 ("Editing and overlay hooks").

**Hit-testing on the shared stage.** `render.hitTest(stream, x, y,
{ toleranceUm, objects?, closedStrokeInterior? })`
(`packages/shared/src/render/hit-test.ts`) answers which objects of a
pass stream are under a paper point (µm), topmost first — backends draw
front to back (§3.6), so a later pass is on top — one hit per object
with its distance to the drawn shape (0 on or inside):

| Pass | Hit when |
|---|---|
| fill, hatch | inside, even-odd (§3.1), or within the tolerance of its outline |
| stroke | the flattened centre line (10 µm) within half the width + tolerance; a closed path's interior too with `closedStrokeInterior` |
| glyph | within the mesh radius × instance scale of an instance (a pattern-clipped glyph pass: its clip area) |
| text | within a glyph box: 0.65 em wide (the course layer's estimate, `course-layer.md` §3.5), 0.2 em below to 0.8 em above the baseline, turned with the glyph (`angles`, §3.5) about its origin (G5: the document's rotated and line text) |

Bounding boxes reject first. No GPU readback: the same function serves
the editor and the tests (pixel-exact GPU picking stays 04 §7's fallback).
`passes` restricts the test to some pass indices; `hitTestStreams`
tests several streams at once — the effective document's pinned stream
and its patch's — and orders their hits as the GL backend draws: colour,
kind, the later stream over the earlier, stream order (G5).

**Editor targets.** The course reply's `hit` index (§5.2) reaches the
viewer with `CourseInfo`; with an `editor` and the GL course layer
drawn, pointer-down resolves through `editorHitAt`
(`packages/web/src/lib/editor/hit.ts`): tolerance 6 CSS px converted to
paper at the current zoom, circles by their interior, the nearest target
(topmost of equally near) mapped by `ref` — `site` → the control drag,
`number` / `leader` → the label drag, `leg` (`<courseId>:<index>`) → the
leg click, `object` (`course-object:<seq>`) → the course object (D5,
`course-editor.md` §7; regions and toner savers, not drawn on screen, hit
by their UI-layer outline); imported extras do not hit. Controls the editor fades
are drawn by the UI layer, not the layer, and hit as plain circles below
it. This is the only hit-testing: the SVG hit targets and the
`sharedHitTest` opt-in went with the legacy editor (E4b). The viewer
mirrors every editor site as a hidden `editor-site` (paper mm) for
tests. Without the course layer (§5.4 "Fallback") there is no hit
index and no target. The hit index is the course part only; the
document's objects are hit through the worker (G5, "Document objects").
The filter region's eyedropper (P3, `course-editor.md` §5 / §6.4) is the
one hit-test over the map document: on the main thread, over the few
objects whose stored box holds the click, symbolised for the purpose
(`documentRenderInput { only }`, no fonts) — topmost hit wins, nothing
goes to the worker.
Snapping (D5, `course-editor.md` §6.2) does not hit-test the document's
stream: point centres and vertices are geometry, read once per document
into a main-thread grid (`lib/editor/snap.ts`); a worker request over the
document stream is Map mode's (G5, "Document objects" below).
Both main-thread indices are of the **effective document** (G4,
`map-patches.md` §2.4): `snapIndexForDocument(hash, bytes, patch)` and
`pickIndexForDocument(…)` apply the event's patch (`useMapPatch`), kept
per hash and patch version. Hidden objects neither snap nor are picked
or counted; modified and added objects are where the patch puts them. An
object drawn with a patch symbol is not picked by symbol — a filter
region stores document symbol indices (§4.11) and a patch symbol's index
moves with the patch — so a click on it picks what is under it (§8).

**Document objects** (G5; 04 §7 "Editing and overlay hooks"). Map mode
(slice G, `course-editor.md` §13) selects and edits objects of the map
document itself. Three pieces, all in the viewer's worker and engine:

- **Hit-test over the document.** `MapGlEngine.hitDocument(x, y,
  toleranceUm)` (paper µm) posts `hit { id, x, y, toleranceUm }`; the
  worker answers `hit { id, hits, ms }` — the **effective document's**
  objects under the point, topmost first, by the symbolised shape.
  Candidates are the passes of the point's grid cell and its eight
  neighbours (an object's reach is within one cell of its centre's cell,
  §5.2 "Assignment") and of the large bucket — the bucket grid stands in
  for 04 §7's R-tree — from both sources of the effective document: the
  pinned stream without the objects the patch changed or hides, and the
  patch's own stream. `render.hitTestStreams` tests them exactly
  (the table above) and orders them by colour, kind (§3.6), the patch's
  stream over the pinned one, then stream order — the GL backend's order
  up to its part order within one (colour, kind), which does not show
  (ink of one colour is opaque).
  `closedStrokeInterior` is off: a contour ring is not grabbed by its
  inside. A `DocumentHit` is `{ objectIndex, ref, symbol, type, colour,
  distanceUm }`: the effective `objectIndex` (valid for the patch drawn
  now), a stable `ref` — `{ source: sourceIndex }` or `{ added: id }`
  (`map-patches.md` §1.2; `null` for the dev `objects` / `stream`
  sources) — the drawn symbol as a `PatchSymbolRef`, the object type and
  the colour of the topmost pass that hit. A patch-hidden object is never
  hit; a modified one only where the patch draws it. The engine drops hits
  on objects it does not draw (`setHidden`'s, a filter region's, an object
  under edit's static copy); masked objects still hit. Before the load it
  resolves `[]`; a request that throws answers `error { hit: id }` and
  rejects that call only; one in flight when the engine is disposed is
  rejected. Several may be in flight.
- **Highlight through the dynamic bucket.** `MapGlEngine.setEdit({
  selected, draft? } | null)` posts `edit { generation, input }`. The
  worker copies each selected object's passes from the stream that draws
  it (the pinned stream, the patch's, or the draft's below) into the
  **edit part** — `EDIT_BUCKET` (−4), one `all` part, its range-table ids
  from `EDIT_OBJECT_BASE` (0x6000_0000, above the course's and the
  page's) — in the reserved colour `HIGHLIGHT_COLOUR` (0xFFFF). The
  engine resolves that index to its highlight colour (`EngineOptions.
  highlight`, default `#2563eb`, the editor's selection blue), so it sorts
  after every map, course and page colour and draws on top of everything,
  unclipped by a page frame. Strokes, glyphs and text are redrawn as
  they are (text halos are left out); **a fill or hatch is drawn as a
  150 µm outline** (`HIGHLIGHT_OUTLINE_UM`) of its area, and a
  pattern-clipped glyph pass as the outline of its clip — the stream has
  no alpha (§8 "Alpha"), and a flooded area would hide what is selected
  inside it (user decision 2026-11-14; deviation from 04 §7's "passes
  redrawn in a highlight colour"). Selecting re-symbolises and
  re-prepares nothing static: the copies keep their tessellation input,
  the static parts are untouched.
- **An object under edit.** `draft { ops, symbols? }` are patch ops
  (`map-patches.md` §1.1: modify, resymbol, add, hide) the host is
  editing and has not written. The worker merges them over the drawn
  patch (`mergePatch`), applies the result to the pinned document and
  bridges and symbolises the draft's targets alone (`documentRenderInput
  { only }`, the load's options and colour remap; glyph meshes join the
  atlas by content, text resolves against the loaded pages). Their passes
  join the edit part **in their own colours**, so they are drawn in colour
  order with the static buckets (04 §7 "Dynamic bucket"); each target's
  static copy — its index in the drawn effective document; none for a new
  add — is in the reply's `hidden`, which the engine joins to the hidden
  set: skipped through the range table, nothing re-prepared. A selected
  object the draft draws is highlighted from the draft's passes. The
  draft's copy is drawn under an edit-part id, so `setHidden` and filter
  regions, which address the static id, do not reach it (§8).
  `applyPatch`'s issues for the merged patch are reported.

**Edit replies.** `edit { generation, part, hidden, selected,
highlighted, issues, atlas?, ms }`: `selected[k]` is the effective index
of `selected[k]` in the drawn document, −1 when it is not drawn there
(hidden, absent, or a draft's add); `highlighted` counts the selected refs
drawn highlighted (a draft's add included). The engine keeps one edit request in flight and the latest
input next, as `setCourse` (F20), re-posts the input after a `load`,
uploads the part under key `E` — after the course and before the page,
always resident, drawn at every zoom, never evicted, its bytes fixed —
rebuilds the visible set at once and calls `onEdit` with the state. The
worker keeps the last edit input: a `patched` reply carries `edit`, the
edit state recomputed against the new effective document, applied in the
same step, so no frame shows a highlight or a hidden id of the previous
patch; if recomputing it throws, the reply carries an empty edit state
(nothing highlighted, nothing hidden) and the patch is drawn. `null`
clears. A request that throws answers `error { edit:
generation }`, ends that request only and leaves the part drawn as it
was. Committing is the host's: it keeps the draft until `setPatch`
resolves with the written patch, then clears it — the object moves to
its static bucket without a frame missing it (04 §7 "on commit").

**In the viewer.** `MapViewerEditorProps.mapObjects { selected?, draft?,
onHitTest? }` reaches `VectorMapLayer`'s `edit`: `onHitTest` hands the
page `hit(pt, toleranceMm)` (paper mm in, `DocumentHit`s out) once the
layer has loaded — or when `mapObjects` arrives after that — and `null`
to that callback when it is replaced, the layer reloads or unmounts — the
request is asynchronous,
so it cannot ride `ToolPointer.target`, and Map mode's tools decide when
to ask (click, drag start, Tab; user decision 2026-11-14). The canvas
carries `data-selected-objects`: the latest edit state's `highlighted`
count. Without
`mapObjects` nothing is posted. `mapObjects.onPatchDrawn(version)` (G6)
is called with each patch version the canvas comes to show (its
`data-patch-version`): the host's signal that the patch carrying a
committed draft is drawn, since the patch reaches the layer through the
session's copy (`setMapPatch`) rather than from the host. Map mode
(`course-editor.md` §13) is the first editor user: it asks the hit-test
on a click (Tab steps the answer's stack), tests a press on the selected
object on the main thread, and with `MapViewerEditorProps.hideCourse`
(its `H`) the viewer requests no course layer, mirrors no course sites
and draws no description sheet.

**Tools.** `MapViewerEditorProps.tool` (D5, `course-editor.md` §6): the
viewer offers pointer-down to the active tool first, routes clicks of an
exclusive tool to it, and draws its `ToolShape`s (paper mm → the rotated
overlay) in `editor-tool-layer` — circles, lines, handles, text and (D7)
`image`, a raster by its three corners; `draftObjects` replace stored course
objects in the layer request, with `fastFilter` while a filter region is
dragged (§4.11).

**Drag.** Unchanged from §5.4 "Overlay": a layer input per move, one
request in flight (§5.2 "Engine"); the dragged object is not symbolised
on the main thread.

**Loupe** (D9b, F24; `course-editor.md` §10 "Loupe"). While a control —
or, on a tablet, a bend or a grip of the selected leg (F23: the point the
tool's `onPointerDrag` returns) — is dragged by touch, or a control, a
bend, a grip or an object's vertex or grip is dragged with the
mouse (F24; a number is dragged with none, F30), the viewer hands `VectorMapLayer` a `loupe` (the dragged
point; the circle `loupePlacement` puts 16 px above the lifted handle by
touch, 16 px above the cursor with no lift by mouse; 120 CSS px, ×2.5)
and draws `editor-loupe` — a ring and a crosshair, no fill,
`data-pointer` `touch` / `mouse` — over it; the layer draws the magnified map into that circle of
the canvas in the same frame as the map (§5.4 "Layer", §5.2 "Render
target"). It shows the resident visible set: what the main view drew,
the dynamic bucket with the dragged circle included, no detail requested
for the loupe's footprint (below the zoom gate it is the base parts).
The UI layer's SVG is above the canvas, so its shapes under the circle
are not magnified. The prop does not depend on the pointer: the mouse
path only supplies the cursor (container px) and a lift of 0. The
placement loupe (F27, `course-editor.md` §10 "Loupe") is the same prop
without a drag: with its toggle on and a placing tool armed, the point is
the binding's `hoverPoint` (what a click would place) and the circle sits
16 px above the cursor, or above the pin-drop crosshair at the view
centre on a coarse pointer (lift 0 both); `editor-loupe` gains
`data-mode` `hover` / `drag`. While it shows, a hover costs one inset
render per frame, as a drag does; no worker request.

**Action bar.** `actionLayout: "bar"` lays the contextual entries out
horizontally under the selection (`editor-action-bar`) instead of the
popover beside it; same entries and ids.

#### Tests

| Test | Covers |
|---|---|
| `packages/shared/src/render/__tests__/hit-test.test.ts` | the table above: order, reach, even-odd, interior on request, glyph discs, text boxes, object filter, distance; G5: hit order over fill / stroke / glyph / text by the colour stack whatever the kinds, kind order within one colour, a pass subset, turned text in its turned box, `hitTestStreams` (colour, kind, then the patch's stream over the pinned one; each source's own passes and objects) |
| `map-gl/__tests__/worker-hit.test.ts` (G5) | `hit` over the effective document: index, ref, symbol, type, colour; reach and tolerance; an object of a hidden symbol not hit; topmost first across the pinned and the patch's stream (an added line over an area); a patch-hidden object never hit, a moved one only at its new place, the toggle off; an object centred in the neighbour cell and one in the large bucket; a request before the load → `error { hit }` |
| `map-gl/__tests__/worker-edit.test.ts` (G5) | the edit part at `EDIT_BUCKET`: a selected line's strokes in `HIGHLIGHT_COLOUR` under edit-part ids; an area as its outline (no fill); a point's glyphs; several refs with an unknown and a patch-hidden one (−1); `null` / empty clear; an added object by its id; `highlightPasses` (text kept, halo dropped, fill and clipped pattern as outlines); a modify draft at its new place in its own colour with its static copy hidden; a new add with none; a selected draft object highlighted where the draft draws it; a draft over the drawn patch's add, a hide draft; the draft's own issues; a draft glyph grows the atlas; a patch change carries the edit state; a request before the load → `error { edit }`, the next answered |
| `map-gl/__tests__/engine.test.ts` (document objects, G5) | `hitDocument`: the worker's hits, `[]` before the load, hits on `setHidden`'s objects, on a hide region's (filter regions test) and on an object under edit dropped, several in flight by id, a worker error and `dispose` reject them; `setEdit`: `E` uploaded and drawn, the highlight index resolved to `EngineOptions.highlight`, bytes fixed, `null` releases it; a draft's static copy skipped, nothing re-prepared; one request in flight, the latest next, an input before the load right after it; an edit error ends that request only, the part kept; a patch reply's edit state applied in the same step |
| `e2e/map-gl-doc.spec.ts` "a click on the fixture's path reports its object…" (G5) | `/dev/map-gl-doc?pick=1` on `e2e/test.ocd`: a click on the first Path (505) reports it on top (source index, symbol code) with the area under it; the edit part selects it and the frame has the highlight blue round it, none before; a click elsewhere moves the highlight and the path's blue goes |
| `map-gl/__tests__/worker-course.test.ts`, `engine.test.ts` | the reply's hit index and its way to the host |
| `lib/editor/__tests__/hit.test.ts` | editor targets over the real worker's index |
| `lib/editor/__tests__/snap.test.ts`, `symbol-pick.test.ts` (G4) | over the effective document: a hidden object neither snaps nor is picked or counted; a modified or added one snaps and is picked where the patch puts it; an added object of a patch symbol is neither picked nor counted |
| `e2e/course-editor.spec.ts` | selecting, dragging and leg clicks on the canvas with no SVG targets |
| `lib/editor/__tests__/touch.test.ts` (loupe) | `loupePlacement`: above the handle, flipped below the finger at the top, kept inside sideways; with no lift (F24) above the cursor, flipped and clamped the same way |
| `e2e/course-editor-legs.spec.ts` "F24: the loupe on mouse drags" | the loupe during a mouse drag of a control (the magnified map: purple, differing from the 1× circle) and a bend (F30: none on a number): `data-pointer="mouse"`, its bottom 16 px above the cursor, no stem; gone on release, on the mouseleave cancel and on Escape (which cancels the drag, nothing written); none for a click; "…object's vertex drag": the loupe during an object's vertex drag |
| `e2e/course-editor-legs.spec.ts` "F23: bend drags on a tablet" | the loupe during a tablet's bend and grip drags (the point `onPointerDrag` returns): its bottom 16 px above the lifted bend, gone on lift |
| `e2e/field-mode.spec.ts` (`mobile`) | the loupe during a long-press drag: 120 px above the handle; the canvas inside it differs from the same circle after release (the 1× map) and has the map's purple; gone on release |

### 5.6 Terrain (web)

The 3D drawing side of research topic 10 §5 step 2 (H5): a height field
(`docs/map-terrain.md` §5) drawn as a mesh under a perspective camera,
textured and lit. H6 makes the map the texture and runs this on the
renderer's context; H7 puts it in the viewer. The terrain side lives in
`packages/web/src/map-gl/terrain/`; H6 joins it to the arena path through
`renderer.ts` (the drape target, the terrain program on the renderer's
context), `engine.ts` (the 3D frame: footprint, cells, settling, budget)
and `worker.ts` (the field's CPU preparation).

#### Decided with the user (2026-11-14)

1. **Shading: flat ground is exactly 1, both ways** (10 §8's open
   lighting question). The light comes from the north-west, 45° up, as in
   T1's hillshade: in paper space (x right, y up, z up) the direction to
   the light is `l = (−½, ½, √½)`. With `n` the unit normal at the
   drawn exaggeration, `s = max(0, n·l) / l.z` and
   `shade = clamp(s, 0.4, 1.25)`; the drawn colour is
   `min(1, colour · shade)` per channel, no tint. Flat terrain, the
   sheet's margin and the legend keep the 2D and printed colours exactly;
   slopes away from the light darken, slopes towards it brighten (white
   cannot). The light is fixed in paper space, not the camera's, so
   relief reads the same from every bearing.
2. **Vertical exaggeration is a draw parameter with no default here.**
   The dev page and the E2E pass it explicitly; the viewer's default (2×)
   and range (1–5×) are §5.4 "3D mode" decision 1 (H7).

#### Decided with the user (H6, 2026-11-14)

3. **Two drape layers, near and far, split by need.** One orthographic
   texture has one texel density, and a tilted camera needs several times
   more at the near edge of the screen than at the far edge (≈ 3.4× at
   pitch 60). `TerrainFrame` takes `drapes[]` (1–2), the first whose uv
   is inside wins. Rendering the map through the perspective matrix every
   frame was rejected: it needs a per-vertex screen density (§8
   "perspective cameras") and contradicts "re-rendered when the camera
   settles".
   - *As first decided*: the far layer at the density the cap allows, a
     near layer only where the cap left the far one below 0.7 of the need.
   - **Amended after the bench (user, 2026-11-14)**: on Club-full at 1×
     paper tilted 60° the camera sees the whole map to the horizon, and a
     far layer at the nearest point's density (the cap allowed 96 %)
     rendered all of its detail — 200 ms per re-render, 166 MB resident
     against 150 MB. Now, **whenever the footprint's depth range is wide**
     (far / near depth > `DRAPE_SPLIT_RATIO` = 2), the near layer covers
     the ground up to a depth D at the nearest point's density and the far
     layer covers the whole footprint at `focalPx / D` — what the ground
     beyond D needs — with D chosen to minimise the texels; both are then
     scaled down together if over the cap. Pitch 0 (depth range 1) stays
     one layer, the 2D view. Distant ground falls below the zoom gate as
     it would in 2D at that density.
4. **The drape is clipped to the mesh.** The height field covers the
   contours' bounding box + 2 mm (`map-terrain.md` §2.4, §5), so sheet
   parts outside it — a title, a legend, a margin beyond the field — are
   not drawn in 3D by the engine. The viewer pads the field with no-data
   cells to the document's bounds before it gets there (H7, §5.4 "3D
   mode" decision 2), so the sheet is drawn at the edge's heights.
5. **The cap is inside the residency budget.** The height and normal
   textures and the drape layers count against the existing budget
   (30 MB event maps, 150 MB club maps; `budgetBytes()`); the drape
   layers together may take at most a third of it (10 / 50 MB, mip chain
   included) and at most 4096 texels per side. On a phone at an event
   map that is ≈ 1.9 M drape texels against a 2.6 M-pixel canvas (0.85×
   linear at pitch 0). Revisited only if the measurements or the H-gate
   show it.

#### Input

A `HeightField` (`docs/map-terrain.md` §5.1), imported from the field's
client entry `@oxygen/shared/src/terrain/field/read.js` (types, codec,
`sampleHeight`, `heightNormals` — not the derivation, so the web bundle
carries none of `graph/` or `solve/`; `map-terrain.md` §5.4 "Client
entry").

#### Units

Model space is the arenas' (§5.2 "Projection"): origin-relative paper µm,
x right, y up — and z up in the same µm, so the texture H6 renders with
the 2D `viewMatrix` lands on the mesh through that matrix alone. For
cell (ix, iy) and int16 height h:

```
x = (x0 + (ix + ½) · cellMm) · 1000 − originX      (likewise y)
z = (h − zMin) · unitUm · exaggeration
unitUm = zScaleM · 1000 / groundMPerMm              (metres → paper µm through the map scale)
```

The lowest drawn height sits at z = 0 for both datums (`zBaseM = zMin ·
zScaleM + zOffsetM` is the metres there), which keeps z small in float32
for an absolute field. Metres reach the GPU only through `unitUm`.

#### Camera (`camera.ts`, `mat4.ts`)

`TerrainCamera { target {x, y, z} (model µm), distanceUm, bearingDeg,
pitchDeg, fovYDeg = 35, widthPx, heightPx }` → `terrainCamera(cam,
bounds?)`: one column-major model → clip `Float32Array(16)`, composed in
float64 (`mat4.ts`) and converted once, as `viewMatrix` is (10 §6 point
1). An orbit: the eye is `distanceUm` from the target, opposite the view
direction.

- `pitchDeg` 0 looks straight down; it is clamped to [0, 85].
- `bearingDeg` turns the view as `View.rotationDeg` does
  (counter-clockwise on screen); at pitch > 0 the camera looks along the
  ground direction that is screen-up at pitch 0.
- **2D ↔ 3D hand-over**: at pitch 0 and `distanceUm = focalPx / pxPerUm`
  (`distanceForPxPerUm`, `focalPx = (heightPx / 2) / tan(fovY / 2)`) the
  target's z plane is drawn exactly as `viewMatrix` draws it with
  `rotationDeg = bearingDeg` (tested to 1e-6 in clip space).
- Near and far enclose `bounds` (the mesh's box at the drawn
  exaggeration) by depth along the view direction: far at the box's
  largest depth, near at **0.8 of its smallest** (`NEAR_HEADROOM`; both at
  corners — depth is linear), no closer than far / 10⁴ (a 24-bit depth
  buffer). The headroom is H8's: lines are drawn above the surface
  ("Lines": raised by their screen half width and biased towards the eye,
  up to several per cent of the distance), and with near at the box's top
  a track on a summit or on flat ground was clipped away (found by the
  opacity test on the flat dev field). Euclidean
  distance to the box would not do: an off-axis point at distance D lies
  at depth D · cos φ, in front of such a near plane (spec review).
- `cameraFrame` also returns the eye, the camera's basis and `focalPx`;
  `screenRay(cam, px, py)` is the ray through a canvas pixel (y down),
  the inverse of the projection; `projectToScreen(m, …)` the forward map.

#### Mesh and level of detail (`mesh.ts`)

The vertices are the field's cell centres; the mesh spans the outer
centres (the half-cell rim, 0.1 mm at 0.2 mm cells, is not drawn).

- **Chunks** of `CHUNK` = 64 × 64 quads tile the grid from (0, 0); an
  edge chunk that runs past the grid clamps its vertices to the last
  column / row, so its outer quads collapse to degenerate triangles.
- **One vertex grid for all chunks**: 65 × 65 vertices of three bytes
  (i, j, skirt = 0) plus a ring of 256 skirt vertices (skirt = 1) on the
  border. Each chunk is an instance `(ix0, iy0, zMin)`.
- **Levels** 0 … 6: level l takes every 2^l-th vertex, (64 / 2^l)² quads
  as triangles (a, b, c), (a, c, d) counter-clockwise from the lower-left,
  plus 4 · 64 / 2^l skirt quads; level 6 is one quad. All levels' indices
  sit in one `Uint16` buffer.
- **Choice of level**: `chunkLevel(d) = clamp(⌊log2(lodPx · d / (focalPx
  · cellUm))⌋, 0, 6)` with d the eye's distance to the chunk's box — the
  coarsest level whose quad edge, at the chunk's nearest point, is at
  most `lodPx` = 8 screen px. Level 0 at the eye, monotone in distance,
  independent of bearing. Geometry this coarse is enough because the
  lighting comes per pixel from the full-resolution normal map, and the
  drape is a texture.
- **Cracks**: each chunk hangs a skirt from its border down to its own
  lowest height. Where a coarse edge (a straight line between every
  2^l-th border height) and a fine edge differ, the higher of the two
  has a skirt reaching the lower: both edges' heights are border heights
  of both chunks, so each chunk's `zMin` lies below the other's edge
  (tested on a noise field for every pair of levels).
- **Culling**: a chunk is dropped when its box (xy extent × its height
  range at the exaggeration) lies wholly outside one clip plane.
- **Draws**: one `drawElementsInstanced` per level in use — at most 7 per
  frame, against 04 §9's 300 for the whole frame.

#### No-data

No-data cells are drawn, at the height of the nearest data cell
(breadth-first over four neighbours, `meshHeights`; all at `zMin` when
nothing has data): the sheet's margin, the legend and the area outside
the mapped area are part of the drape, and holes or walls at the mapped
area's edge would be artefacts. The field itself is not changed; the pick
reports such a point with `data: false`.

#### Pick (`pick.ts`)

`pickTerrain(mesh, field, ray, exaggeration)` → `{ x, y }` paper mm, the
model point, `heightM` (exaggeration removed), `data` and the ray
distance, or null on a miss. A CPU march over the level-0 triangles the
mesh draws (`surfaceZ`), clipped to the mesh's box, in steps of half a
cell in plan, the first crossing refined by bisection; a vertical ray is
one step. It runs without the GPU, so H7's gestures and H8's lines use it
as the tests do. Where `data` is true, `heightM` agrees with
`sampleHeight` within one height unit (the triangles and §5.3's bilinear
differ by less inside a quad).

#### Lines (`lines.ts`, H8)

GPS tracks on the terrain (research 10 §5 step 3, row H8): polylines in
paper mm drawn by the GL frame after the mesh, on its surface and
depth-tested against it, so a track behind a hill is hidden by the hill.

```ts
interface TerrainLine {
  points: readonly { x: number; y: number }[];   // paper mm (WGS 84 reached them through mapGeo)
  colour: [r, g, b];                             // 0…1
  opacity: number;                               // 0…1, uniform over the line
  widthPx: number;                               // CSS px; the frame's pxRatio makes it device px
}
type LineSurface = (xUm: number, yUm: number) => number | null;   // model µm → int16 height units
liftPolyline(points, mesh, { surface = surfaceHeight(mesh, ·), stepUm = mesh.cellUm }?): Float32Array[];
lineInstances(lines, mesh, surface?): { data: Float32Array; ranges: { first; count }[]; segments };
lineVertex(p: [x, y, h], frame: { matrix; eye; zUnit; widthPx; heightPx; focalPx; halfPx }): [x, y, z];
class TerrainLines {
  constructor(gl: WebGL2RenderingContext);
  draw(lines, mesh, frame: { matrix; eye; focalPx; exaggeration; pxRatio }, target): { lines; draws; segments };
  dispose(): void;
}
```

- **Lifting** (`liftPolyline`, pure): each point goes to model µm (the
  mesh's `originUm` removed); every segment is cut into equal steps no
  longer than the mesh's `cellUm` in plan, the original points kept, so
  a chord between two GPS fixes follows the ground over a ridge instead
  of cutting through it. Each vertex carries `(x, y, h − zMin)` in
  model µm and **height units** — the exaggeration is applied in the
  shader (`u_zUnit = unitUm · e`, as the mesh), so changing it re-uploads
  nothing. The height is the **drawn surface** (`surfaceHeight`, the
  level-0 triangles with no-data filled, §5.6 "Pick"): the surface the
  depth test runs against; where the field has data it is
  `sampleHeight` within one height unit. A point outside the mesh's cell
  centres (only beyond the sheet: H7 pads the field to the document's
  bounds) breaks the line into runs; a run of fewer than two vertices is
  dropped. Over `MAX_LINE_SEGMENTS` (200 000) segments for one set the
  step doubles until it fits.
- **The height source is a parameter** (`surface`): the default reads
  the engine's current mesh, and a new field (H11's choice of surface)
  is a new mesh, which re-lifts the lines (below). Nothing else in the
  lines knows which field it is.
- **Geometry**: one instance per segment `(p0, p1)`, a unit quad
  expanded in the vertex shader to a screen-space **capsule** of
  `widthPx · pxRatio` about the projected segment, one pixel wider for
  the edge's antialiasing; the fragment shader keeps the pixels within
  half the width of the segment (screen px, `gl_FragCoord`), so joins
  and ends are round as the 2D `<path>`'s. The width is the 2D track's
  4.5 CSS px, not foreshortened: the track is an overlay on the ground,
  as it was in 2D. A segment with an end behind the eye (w ≤ 0) is not
  drawn.
- **Lift and depth** (`lineVertex`, the vertex shader's twin in
  TypeScript): the ground point `(x, y, h · unitUm · e)` is raised by
  - **`LINE_LIFT_UM` (200 model µm, 2 m at 1:10 000)**, not scaled by the
    exaggeration, plus
  - **its half width on screen**: as much as moves it `halfPx + ½` device
    px on screen (the screen rise of a vertical step at the point,
    measured through the matrix), at most `LINE_RISE_CAP` (4) times that
    in the distance's px-equivalents (`focalPx / w`) — looking straight
    down a rise does not move the point, and the cap keeps it bounded.
    The capsule is centred on the raised line, so its lower edge lies on
    the ground line and every pixel of it covers terrain at or beyond the
    ground point: at a grazing view, where the terrain under a capsule
    centred on the ground would be nearer than the line, it is not
    swallowed (found on the dev cone: a far flank at 1× seen 20° above
    the horizon lost half the line's width).

  then moved towards the eye by **`LINE_DEPTH_BIAS` (0.003) of its
  distance** — screen position unchanged, depth reduced — because coarse
  levels of detail lie above level 0 by up to a quad's height change far
  from the eye (§5.6 "Mesh and level of detail"), which the lifts alone do
  not cover. On screen a tilted track is drawn up to its half width (and
  the constant lift's few pixels) above its ground line; looking straight
  down it is on it under the eye and moved outwards by at most that
  elsewhere. Depth test `LEQUAL` against the mesh's depth,
  `depthMask(false)`: lines never occlude one another or the mesh. A
  track within the lift and bias behind a crest shows through it.
- **Opacity once**: a line's overlapping capsules (every join) must not
  blend twice, so each line is drawn with the stencil — cleared to 0 at
  the pass's start, line i's reference `i + 1` — in two draws: the
  capsules' interiors (full coverage), then their antialiased edges where
  no interior is, both `NOTEQUAL` / `REPLACE`: a fringe pixel two capsules
  share takes the first one's coverage, once. Blending is
  `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`. Two draws per line;
  the mesh's draw count (≤ 7) is reported apart.
- **Buffers**: the instance data is rebuilt only when the `lines`
  array or the mesh changes (identity); a camera or exaggeration change
  only sets uniforms.
- **State**: it binds the frame's target again (the mesh's depth is
  still in it), sets the viewport, and leaves what `TerrainRenderer`
  leaves: depth test off and `depthFunc(LESS)`, `depthMask(true)`, blend
  and stencil test off, `stencilMask(0xff)`, no program, vertex array,
  buffer or framebuffer bound.
- **Frame**: `renderer.drawTerrain(frame, target, lines?)` draws them
  after the mesh inside the GPU timer, with the mesh's matrix (the near
  and far planes from the mesh box), eye and focal length
  (`TerrainDrawStats.eye`, `focalPx`); the stats carry `lines: { lines,
  draws, segments }`.

#### Shading (`shade.ts`)

Decision 1 above, written once in TypeScript (`shade`, `shadeColour`) and
emitted into the fragment shader from the same constants (`SHADE_GLSL`).
Normals are `heightNormals(field, 1)`, uploaded once; the shader applies
the exaggeration as `normalize(n.xy · e, n.z)`, which is
`heightNormals(field, e)` — so changing the exaggeration (H7's control)
costs no upload.

#### Drawing (`program.ts`)

```ts
class TerrainRenderer {
  constructor(gl: WebGL2RenderingContext);        // the caller's context
  setField(field: HeightField, originUm: { x; y }, prepared?: PreparedField): TerrainMesh;
  setOrigin(originUm: { x; y }): TerrainMesh;      // the same field in a new document's model space, no upload
  clearField(): void;
  get mesh(): TerrainMesh | null;
  get bytes(): number;                             // fieldTextureBytes(W, H) = W · H · 5
  draw(frame: TerrainFrame, target: RenderTarget): TerrainDrawStats | null;
  dispose(): void;
}
interface TerrainFrame {
  camera: TerrainCamera; exaggeration: number;
  drapes: { texture: WebGLTexture; matrix: Float32Array }[];   // 1–2 (MAX_DRAPES), priority order
  background: [r, g, b]; lodPx?: number; level?: number;
}
```

- `setField` uploads the filled int16 grid as an `R16I` texture (read
  with `texelFetch` in the vertex shader — `map-terrain.md` §5.1's "as it
  is"; 4096 per side is the phone texture limit §4.0 answer 3 sized the
  grid to) and the normals as `RGB8_SNORM`, linear. A field over
  `MAX_TEXTURE_SIZE` throws.
- `setField` without `prepared` does the CPU work itself (the dev page's
  synthetic mode); the engine passes the worker's (§5.6 "Worker").
- `draw` clears `target` (colour to `background`, depth to 1), draws with
  depth test `LEQUAL`, and samples each drape at `uv = (matrix · (x, y,
  0, 1)).xy / w · ½ + ½`; the **first drape whose uv lies in [0, 1]** is
  drawn (H6: the near layer, then the far one — decision 3). Both
  samplers are read outside the branch so the mip level's derivatives
  stay defined; an absent second drape binds the first and is never
  chosen. Outside every drape the `background` colour stands in and is
  **shaded like it** — it is ground no texture covers (the footprint ends
  before the field does, and the camera moved before the drape followed,
  "Settling"), and an unlit patch would read as a hole. The colour is
  `min(1, colour · shade)`, opaque.
- It sets what it draws with — blend, face culling, scissor and stencil
  off, every colour channel written — since the arena path leaves blend
  on after a 2D frame.
- **The seam**: a drape is any texture plus the matrix it was drawn
  with, so the map rendered into framebuffer textures with the 2D
  `viewMatrix` over the camera's footprint (below) and the dev page's
  checker go through the same path. The renderer takes a context, not a
  canvas, and leaves it as the arena path expects: depth test off and
  `depthFunc(LESS)`, no program, vertex array, framebuffer or texture of
  its own bound, `TEXTURE0` active, unpack alignment 4. The viewport,
  clear colour, clear depth and `depthMask(true)` stay as drawn; the
  arena path sets its own each frame. `MapGlRenderer` owns one
  (`renderer.terrain`, made on first use) on its own context.

#### Footprint (`footprint.ts`, H6)

The research's step 1 (10 §5) renders the map "to a texture … at the
view's resolution"; under a perspective camera the screen has no single
resolution on the ground, so the drape is **orthographic textures over
the camera's ground footprint**, rendered with the unchanged arena path
and `viewMatrix` (10 §6 points 1–2: one matrix, an explicit target).

`groundFootprint(cam, box)` is the plan region whose surface the camera
can see: the four side planes of the frustum (through the eye; with
`tanY = tan(fovY / 2)`, `tanX = tanY · width / height`, inside where
`|p·right| ≤ tanX · depth`, `|p·up| ≤ tanY · depth`) clip each face of
`box` — the mesh's box at the drawn exaggeration (`meshBox`) — and the
xy convex hull of what is left (plus the eye, where it lies inside the
box) is the footprint, counter-clockwise, model µm; empty when the
frustum misses the box. Clipping the **box** rather than the z = 0 plane:

- a hilltop seen beyond the flat-ground trapezoid is covered (the drape
  is a vertical projection: a surface point takes the texel of its
  plan position, whatever its height);
- the box bounds the footprint at the horizon, so a camera looking over
  the field has a finite footprint without a far plane.

Tested: the screen rectangle at pitch 0, the analytic trapezoid when
tilted, every on-screen surface point of random cameras inside the
polygon and inside a layer, the box clip, empty when looking away.

#### Drape layers (H6, decision 3)

`drapeLayers(cam, box, originUm, limits)` → one or two `DrapeLayer {
role: "near" | "far", view: ViewRect, needPxPerUm }`, priority order:

- **Rectangle**: the footprint's bounding box in the camera's bearing
  frame (`u` along screen-right at pitch 0, `v` along screen-up — the
  frame `viewMatrix` turns by `rotationDeg`), grown by `DRAPE_MARGIN` =
  5 % of its extent per side (small moves stay covered and bilinear
  filtering has its neighbours at the edge), clipped to the box's extent
  in that frame. The view's `rotationDeg` is the camera's `bearingDeg`.
- **Density**: what the screen needs at the footprint's nearest point:
  `need = focalPx / depth`, depth along the view direction of the
  footprint's vertices placed at the target's z (`depth` is linear, so
  its minimum is at a vertex). At pitch 0 every point is at the same
  depth and `need = focalPx / distanceUm` — the 2D `pxPerUm`
  (`distanceForPxPerUm`'s inverse).
- **Cap** (decision 5): the density is lowered until the layer's sides
  are at most `limits.maxSide` and its texels at most `limits.maxPixels`.
  The rectangle's edges are snapped outward to the screen's pixel grid
  at pitch 0 (`u = u_t + (k − width / 2) / ρ` about the target, k
  whole), so at pitch 0 the texel centres fall on the pixel centres —
  also where the field's edge clips the layer off the screen's centre
  (review finding; H7 hands over on maps whose sheet passes the field).
  A size loop under the texel allowance is bounded: snapping keeps at
  least a texel a side.
- **The 2D ↔ 3D hand-over**: at pitch 0 with the budget's room the one
  layer *is* the 2D view, grown by the margin and snapped to its pixel
  grid (centre within a texel, same `pxPerUm` and rotation), so the 3D frame over flat ground equals the 2D frame —
  exactly on a GPU (max 1 level, north up), to the MSAA resolve's
  rounding in SwiftShader (E2E). Turned, the texel grid is turned
  against the pixels and the frame is a bilinear resample of the 2D one
  (< 1 % of pixels, all on edges, differ by more than 2 levels).
- **Split by need** (decision 3 as amended): with `dMin`, `dMax` the
  footprint's smallest and largest depth, a footprint with `dMax / dMin
  ≤ DRAPE_SPLIT_RATIO` = 2 (pitch 0, a slight tilt) is one layer at
  `need`. A wider one is two: for split depths D in 12 geometric steps
  between `dMin` and `dMax`, the near layer is the rectangle of the
  footprint clipped to `depth ≤ D` (the depth is linear: one half-plane)
  at `need`, the far layer the whole rectangle at `focalPx / D` — enough
  for every point beyond D — and the D with the fewest texels is taken
  (when it beats one layer). Over the cap both densities are scaled by
  the same factor and each layer gets its share of the texels. Every
  on-screen ground point is then drawn at least at the density it needs,
  times that factor (tested on a grid of points); `needPxPerUm` is the
  near layer's `need` and the far layer's `focalPx / D`, and a layer's
  `ratio` in the stats is its density over that.

`drapeTiles(view, tile)` partitions a layer's texels into views of at
most `tile` per side: each is the layer's density and rotation, centred
on its rectangle, so its pixels are the layer's pixels shifted by a
whole number (tested: the partition, and every texel where the layer's
matrix puts it).

#### Rendering the drape (`renderer.ts`, H6)

`renderer.renderDrape(slot, view, opts)` renders the visible set with
`renderDocument` into drape slot `slot`'s texture, `view.widthPx ×
view.heightPx` texels (made, or remade at a new size, as `RGBA8` with a
full mip chain via `texStorage2D`; `LINEAR_MIPMAP_LINEAR`, anisotropy up
to 8 with `EXT_texture_filter_anisotropic`):

- tile by tile (`drapeTiles`, `DRAPE_TILE` = 1024): each tile is drawn
  into one square target of `min(DRAPE_TILE, the layer's longer side)`
  (remade when that changes) with 4× MSAA colour and
  `DEPTH24_STENCIL8` (the loupe's recipe: pattern clips need the
  stencil), resolved into that target's own texture with a blit of the
  same rectangle (a multisampled blit cannot move pixels), then blitted
  into its rectangle of the drape. A 4096² MSAA target would hold
  ~512 MB; the tile target holds 36 MB (`drapeScratchBytes`);
- then `generateMipmap`: far ground is minified several times at a tilt,
  and a line map shimmers without mips.

The screen-only rules (hairline floor, glyph and text skips, hatch tint)
read the layer's `pxPerUm` — the drape is drawn as the 2D map at its
density. `drape(slot)` is the texture, `releaseDrapes(from)` frees slots
from `from` on (the tile target with the last), `drapeBytes` is the
budget's count (`drapeTextureBytes`: 4 bytes per texel over the chain,
≈ 4/3). `drawTerrain(frame, target)` draws the mesh under the GPU timer.

#### Settling (`engine.ts`, H6)

The drape is re-rendered **when the camera settles, or when what it
shows changes** — never per camera frame:

- `renderTerrain` keys the camera (target, distance, bearing, pitch,
  field of view, size, exaggeration). A change restarts a
  `DRAPE_SETTLE_MS` = 150 ms timer that calls `onChange` (the host draws
  a frame: the camera has settled).
- While the camera moves, the frame is the mesh alone over the drape
  last rendered; ground it does not reach is the shaded background
  (§5.6 "Drawing").
- Once the camera has been still for 150 ms, the layers are re-selected
  for the footprint; if any view differs, the drawn cells are the
  layers' (below) and the drape is stale. The first 3D frame after a
  field, a load or a 2D frame selects at once; a camera that sees none
  of the mesh selects no layer once, not every frame.
- Whatever makes the 2D visible set dirty — a course or edit reply, a
  patch, `setHidden`, a filter — rebuilds it and makes the drape stale
  at once, over the layers it has: a course drag does not wait for the
  camera. `invalidateDrape()` is the host's (other colours, say).
- **Detail arrivals** alone, while more of the layers' detail is still
  pending, re-render the drape at most every `DRAPE_ARRIVAL_MS` = 500 ms,
  or `DRAPE_ARRIVAL_FACTOR` = 4 × the last re-render's JS time where that
  is longer (a club map's drape takes 100–300 ms); a held frame still
  draws the mesh, and a timer calls `onChange` when the hold ends. The
  arrival that completes the layers' detail re-renders at once.
- A stale drape is rendered at the start of the frame, every layer, then
  the mesh: **one frame = map-to-texture + mesh**.

#### Budget (H6, decision 5)

- The field's textures (`W · H · 5` bytes: R16I and RGB8_SNORM) and the
  drape layers' (`drapeBytes`, mips included) join the engine's fixed
  bytes, so the LRU evicts detail around them as it does around the
  course part.
- `drapeLimits()`: `maxSide = min(DRAPE_MAX_SIDE = 4096,
  MAX_TEXTURE_SIZE)`, `maxPixels = budget · DRAPE_BUDGET_SHARE (⅓) /
  DRAPE_TEXEL_BYTES (16 / 3)` — 1.97 M texels at an event map's 30 MB,
  9.8 M at a club map's 150 MB.
- Not counted: the tile target (as the canvas's own MSAA buffers and the
  loupe's target are not) — reported in the stats.
- A drape re-render is not a frame for 04 §9's "≤ 300 draws": its draws
  and time are reported apart ("Measurements (H6)"); mesh frames are held
  to the frame budget.

#### Engine API (H6)

```ts
engine.setTerrain(field: HeightField | null): Promise<TerrainMesh | null>;
engine.terrainMesh / engine.terrainField;           // for H7's pick and camera bounds
engine.renderTerrain(frame: { camera; exaggeration; lodPx?; level?; lines?; pxRatio? }, opts: DocumentRenderOptions, target?): TerrainFrameStats;
                                                    // lines: TerrainLine[] (H8, "Lines"), drawn after the mesh; stats.lines
engine.invalidateDrape(): void;
engine.drapeLimits(): { maxSide; maxPixels };
engine.stats().terrain  // fieldBytes, drapeBytes, scratchBytes, layers (role, size, pxPerUm, ratio = density / need),
                        // drapeRenders, lastDrapeMs / Draws / Tiles, the worker's prepareMs, uploadMs
```

- `setTerrain` posts the field to the worker (a copy of the grid; the
  engine keeps the field for the pick, and `terrainField` turns to it
  only with its mesh, so the pair always matches), uploads the reply in the
  document's model space (the arenas' origin; a later `load` moves the
  mesh with `setOrigin`) and resolves with the mesh; a later call
  rejects one in flight; `null` drops the textures and the drape and
  returns the drawn set to the 2D view.
- **Cells for the drape**: `setView`'s selection takes several views
  (`selectViews`): the drawn cells are the union of each layer's cells
  with the draw margin, a layer's detail is drawn and requested only
  above the zoom gate *at its own density* (with the draw margin as the
  prefetch), and the LRU protects the detail drawn. A 2D view is the
  one-view case, unchanged. `render` after a 3D frame re-selects the 2D
  view; `renderTerrain` after a 2D frame re-selects the layers.
- `whenComplete()` resolves once every layer's ungated detail is
  resident; the next 3D frame then renders the complete drape.

#### Worker (H6)

`setField`'s CPU work moved to the map worker (§8's choice between the
worker and GPU normals: `RGB8_SNORM` is not colour-renderable in WebGL2,
and the chunk ranges are needed on the CPU anyway): the request
`terrain { generation, header, z }` answers `terrain { generation,
terrain: PreparedTerrain, normals, ms }` — `prepareTerrain(field)` (the
no-data fill, the height range, the chunks' ranges: `buildTerrainMesh`
without the origin) and `heightNormals(field, 1)`, both arrays
transferred. It needs no loaded document. The main thread keeps the
assembly (`assembleTerrainMesh`) and the two uploads (`uploadMs`).

#### Dev page

`/dev/map-terrain?field=cone|slope|noise[&n=<W>x<H>]&texture=checker|grey|white[&drape=half]&pitch=&bearing=&e=&lod=auto|0…6&zoom=&w=&h=&bg=<hex>[&bench=1]`
(`pages/dev/MapTerrainPage.tsx`, routed only when `import.meta.env.DEV`)
builds a synthetic field (`map-gl/terrain/synthetic.ts`: a 1 : 4 cone
45 m high on flat ground with a no-data margin, a plane, seeded value
noise tapered to 0 at the border), round-trips it through the `OXHF`
codec, and draws it with a checker (`CHECKER`, 2 mm squares), flat grey
or white drape over the field's paper extent (`drape=half`: its west
half only, the rest in the background colour), the camera fitted to the
field at `zoom` 1. The canvas (`data-testid="map-terrain-canvas"`,
`preserveDrawingBuffer`) gets `data-ready`; a click picks and sets
`data-pick`. `window.__mapTerrain` publishes the draw stats, `project(xMm,
yMm)` (canvas px of the surface point) and `pick(px, py)` / `lastPick`.
`bench=1` draws 60 frames, each synced by a one-pixel read, and reports
the p50 / p95.

`?doc=course[&field=cone|flat&x=&y=&budget=<MB>&worker=1][&line=x,y;x,y|…&lineColour=<hex>&lineOpacity=]` (H6,
`pages/dev/terrainDoc.ts`) loads the course fixture document
(`map-gl/fixtures/course-document.ts`: an aligned ISOM stack, a black
line, a top-row line, the four-control course the dynamic-bucket tests
use) into a real `MapGlEngine` with its course layer, sets a field over
the 80 × 60 mm sheet and a 10 mm rim (`docField`: flat, or a 45 m cone
of 22 mm radius at (35, 25) mm), and draws `renderTerrain` frames — the
map and the course in the drape, then the mesh — redrawing on the
engine's `onChange` (an animation frame, or a 50 ms timer where frames
do not run). The camera looks at (`x`, `y`) mm, `zoom` 1 fitting the
sheet. `window.__mapTerrainDoc` publishes the last frame, the engine's
stats, `project`, `pick`, `setCamera(…)` and `compare2d()` (the same view
drawn by `engine.render` and compared pixel by pixel). `line=` (H8)
draws lines on the terrain through the frame's `lines` (§5.6 "Lines"):
`|` between lines, `;` between points in paper mm, 8 px, `lineOpacity` (default 1),
`lineColour` (default `e6194b`, published as `lineRgb`).

`/dev/map-gl-doc?…&terrain=1[&pitch=60&e=2]` (H6): its "Bench" runs the
3D scenarios on a loaded map instead of the 2D ones — "Measurements
(H6)".

#### Measurements (H5)

A 4096 × 4096 field (the §4.0 cap) at 1920 × 1080, exaggeration 2
(`mesh.test.ts`, snapshot):

| Camera | Triangles | Chunks drawn / culled | Chunks per level 0–6 | Draws |
|---|---|---|---|---|
| overview, pitch 0, field fitted | 247 904 | 4096 / 0 | 0/0/0/0/3740/356/0 | 2 |
| 60° tilt, 2× | 336 576 | 3063 / 1033 | 0/0/0/1098/1965/0/0 | 2 |
| close-up, 45°, 4 px per cell | 324 352 | 63 / 4033 | 28/35/0/0/0/0/0 | 2 |

The table is the unit test's sinusoid (pinned by its snapshot). The dev
page's noise field at the same size and cameras: 98 304, 330 624 and
346 624 triangles. CPU per frame, chunk selection on the 4096 chunks: 0.66 ms p50 / 1.0 ms p95
(Node, laptop). `setField` on 16 M cells: the mesh (no-data fill, chunk
ranges) 0.26 s; `heightNormals` 1.9 s — main-thread work H6 moves (§8).
Headless Chromium draws in software (SwiftShader), 64–200 ms a frame
here; GPU frame times are H6's, on the bench harness with the map
texture.

#### Measurements (H6)

`scripts/measure-gl.mjs --terrain --modes=source` on the corpus through
`/dev/map-gl-doc?terrain=1` (2026-11-14): headed Chromium on the laptop's
iGPU (Intel ADL GT2, Mesa); desktop 1280 × 800 at DPR 1, and the phone
profile 412 × 915 at DPR 2.625 with the main thread CPU-throttled 4×
(the worker is not throttled; the GPU is the laptop's — a real phone is
the H-gate's). The field is seeded noise over the map's bounds at 0.2 mm
(the 4096-cell cap coarsens Club-full's to 0.23 mm), exaggeration 2,
pitch 60. Each scenario is 240 frames orbiting 360°, holding still past
`DRAPE_SETTLE_MS` every 60 frames: **orbit** at the fit view, **close**
at 1× paper over the densest cell. Mesh frames and drape re-renders are
reported apart (a re-render's wall time is synced by a one-pixel read).
Club budget (150 MB; the drape's third is 50 MB).

The field (once per map): the worker's preparation (fill + normals) and
the main thread's upload.

| Map | Field | Textures | Worker fill + normals | Upload, desktop / phone |
|---|---|---|---|---|
| Sprint | 2127 × 1946 | 19.7 MB | 57 + 224 ms | 21 / 43 ms |
| Crop-B | 756 × 703 | 2.5 MB | 12 + 26 ms | 5 / 8 ms |
| Club-2026 | 1642 × 2196 | 17.2 MB | 48 + 192 ms | 8 / 16 ms |
| Club-full | 4096 × 2153 | 42.1 MB | 95 + 451 ms | 23 / 92 ms |

Mesh frames (p50 / p95 ms) and drape re-renders:

| Map, scenario | Mesh CPU desktop / phone | Mesh GPU desktop / phone | Draws | Re-renders | Re-render wall p50 / max, desktop / phone | Layers (desktop / phone) | Drape MB d / p | Resident max MB d / p |
|---|---|---|---|---|---|---|---|---|
| Sprint orbit | 0.8/1.5 · 1.0/1.9 | 1.9/2.5 · 2.8/3.7 | 2 | 4 | 40/56 · 44/78 | far / far | 5.8 / 7.0 | 33 / 34 |
| Sprint close | 0.9/1.6 · 1.5/2.2 | 2.3/3.4 · 4.0/8.1 | 3 | 3 | 66/77 · 75/78 | near + far / near + far | 14.5 / 48.1 | 47 / 77 |
| Crop-B orbit | 0.5/0.9 · 0.8/1.3 | 1.9/2.2 · 2.5/3.4 | 2 | 4 | 17/22 · 19/31 | far / far | 5.6 / 7.1 | 15 / 16 |
| Crop-B close | 0.4/0.6 · 0.6/1.0 | 1.0/1.2 · 4.1/5.3 | 2 | 3 | 11/14 · 23/25 | far / far | 2.6 / 16.4 | 15 / 26 |
| Club-2026 orbit | 0.6/0.9 · 1.2/1.9 | 1.4/3.0 · 2.6/4.5 | 2 | 4 | 43/43 · 57/66 | far / far | 3.1 / 10.0 | 56 / 64 |
| Club-2026 close | 0.8/1.4 · 1.4/2.1 | 2.2/3.7 · 2.9/6.3 | 3 | 3 | 75/131 · 93/105 | near + far / near + far | 11.7 / 37.5 | 65 / 94 |
| Club-full orbit | 1.2/1.8 · 1.6/2.5 | 1.9/3.8 · 1.4/2.8 | 2 | 4 | 107/158 · 69/108 | near + far / far | 8.1 / 4.1 | 125 / 121 |
| Club-full close | 1.5/2.4 · 2.4/3.3 | 3.1/4.9 · 2.9/6.6 | 3 | 62 / 63 | 193/225 · 299/336 | near + far @100 % / @86 % | 31.4 / 50.0 | **156 / 155** |

- **Mesh frames are inside 04 §9** everywhere: CPU ≤ 3.3 ms p95, GPU
  ≤ 8.1 ms p95 (the phone profile's Sprint close-up, 437 k triangles at
  2.6 M pixels), ≤ 3 draws, and frame p95 ≤ 17.4 ms — 60 fps — on every
  run but Club-full's close-up.
- **A drape re-render is a hitch** of 11–131 ms on desktop and 19–105 ms
  on the phone profile for the event maps and Club-2026 (6–12 tiles,
  50–840 draws), once per settle. It is not a frame for the ≤ 300 draws
  rule ("Budget").
- **Club-full's close-up streams the whole map**: tilted at 1× paper the
  camera sees the map to the horizon; split by need, the far layer is at
  0.3–0.5× paper, above the zoom gate, so the whole map's detail is
  requested. While it streams, arrivals re-render the drape
  (`DRAPE_ARRIVAL_MS`, 62–63 times in the run, 193–336 ms each), the frame
  p95 is 259 ms (desktop) / 488 ms (phone), and residency peaks at
  155–156 MB against 150 (the field's 42 MB and the drape's 31–50 MB are
  fixed bytes; drawn detail is protected; the engine reports over budget).
  Before the split (decision 3 as first decided) it was 120 re-renders,
  280 ms p95 and 166 MB, with one 3874 × 2536 layer. §8 has the remedy.
- The phone profile's close-ups take more texels (2.6 M canvas pixels):
  Club-full's is capped at 86 % of its need.
- The tile target is 36 MB (19 MB for Crop-B's single 692-texel tile
  side), not in the budget.

#### Tests

| Test | Covers |
|---|---|
| `packages/shared/src/terrain/field/__tests__/read.test.ts` | the client entry reaches no derivation module; the read side exported |
| `map-gl/terrain/__tests__/camera.test.ts` | `mat4` (multiply, invert, perspective depth and field of view); the target → clip origin at any bearing and pitch; one `Float32Array(16)`; pitch 0 = `viewMatrix` with `rotationDeg = bearingDeg` to 1e-6; a raised point projected higher and depth monotone in distance at pitch > 0; bearing 90 looks east; near / far enclose the bounds within 10⁴, near with 20 % headroom in front of them (H8); sub-pixel precision 585 mm from the origin in float32 arithmetic; `screenRay` inverts the projection |
| `map-gl/terrain/__tests__/mesh.test.ts` | chunk geometry: 65² + 256 vertices, every quad covered exactly once at every level, counter-clockwise, index counts, 4 · 64 / 2^l skirt quads; `meshHeights` fills from the nearest data cell without changing the field, all no-data flat at 0; vertex placement in origin-relative µm and `zUnitUm`; a partial edge chunk clamped; `chunkLevel` (0 at the eye, monotone, capped, quad edge ≤ lodPx); culling and a straddling chunk kept, the same levels at another bearing, mixed levels when tilted; skirts close every crack between any two levels on a noise field; the 4096² budget (≤ 600 000 triangles, the numbers above as a snapshot) |
| `map-gl/terrain/__tests__/pick.test.ts` | the analytic cone met within half a cell at pitch 0, 60 (exaggeration 1, 3) and grazing; surface point → project → `screenRay` → pick within half a cell; `heightM` = `sampleHeight` within one unit at two exaggerations; `data` false on the margin; misses |
| `map-gl/terrain/__tests__/lines.test.ts` (H8) | `liftPolyline`: origin removed, height units above `zMin`; densified to the cell with the original points kept; every vertex on the drawn surface and `sampleHeight` within one unit; a chord across the cone's apex goes over it; the filled height on the no-data margin; broken off the mesh, single points and empty input dropped, a repeated fix skipped; another `surface` sampled (H11's seam). `lineInstances`: one instance per segment, one range per line, none across a gap, the step doubled to fit `MAX_LINE_SEGMENTS`. `lineVertex`: tilted (45°–70°, three exaggerations) the vertex projects its half width + ½ px (plus the lift) above its ground point and in front of it; the bias moves it along its ray only; looking straight down it is on its ground point under the eye and the rise capped |
| `map-gl/terrain/__tests__/shade.test.ts` | flat = 1; sin θ + cos θ facing the light, cos θ − sin θ away, cos θ across; the clamps; exaggeration in the shader = `heightNormals(field, e)`; the colour product; the GLSL's constants |
| `map-gl/terrain/__tests__/footprint.test.ts` (H6) | footprint → view: the screen rectangle at pitch 0, the analytic trapezoid tilted, every on-screen surface point of 40 random cameras inside the footprint and a layer, the box clip, empty when looking away; the pitch-0 layer is the 2D view grown by the margin (same pixel offsets, screen parity) at any bearing; limits never exceeded over 60 random cameras; split by need on a wide depth range — each layer at its need when the cap allows, the far one at the split depth's, fewer texels than one layer, the near one inside the far one and over the ground beyond the screen's bottom edge, every on-screen ground point at least at its need; both scaled together under the cap; one layer on a narrow depth range and at pitch 0 when capped; a tiny texel allowance terminates; at pitch 0 the texels lie on the pixels even where the screen crosses the field's edge; tiles partition the layer and draw every texel where its matrix puts it |
| `map-gl/__tests__/worker-terrain.test.ts` (H6) | the `terrain` request's prepared mesh and normals equal `buildTerrainMesh` and `heightNormals` on a cone and a noise field, without a document; the two arrays transferred; an error names its generation |
| `map-gl/__tests__/engine.test.ts` "terrain" (H6) | the field prepared in the worker and uploaded at the document's origin; drape before mesh, the layer's matrix = `viewMatrix` of its view, the hand-over view at pitch 0; mesh only while the camera moves, the settle timer's `onChange`, one re-render after it and none for the same camera; a content change and `invalidateDrape` re-render at once over the same layers; the layers' cells requested and drawn, detail arrivals re-render, gated per layer; the field and drape in `residentBytes`, the drape ≤ ⅓ of a small budget; `setTerrain(null)` drops both; a 2D render after a 3D frame draws the 2D view's cells; a superseded `setTerrain` rejects; arrivals held to `DRAPE_ARRIVAL_MS` and the last at once; a near layer above the gate and a far one below (detail drawn and requested for the near one's cells only, `whenComplete` on them); a load moves the mesh to the new origin and re-selects; a worker failure rejects and keeps the field and mesh; `dispose` rejects a request in flight; a camera that sees no mesh renders no drape |
| `e2e/map-terrain.spec.ts` | on the dev page in headless Chromium: the lit cone top-down with a grey drape — facing flank, far flank and flat ground at §5.6's analytic values ± 10 levels, ≤ 7 draws; the checker at pitch 60 — two adjacent squares on flat ground in their own colours, the apex projected above its foot; a south-flank point at pitch 60 at its slope's shade for e = 2 and e = 1 (the mesh lifted by the R16I heights and the exaggeration applied in the shader — a flat mesh or an ignored e would show another value); with `drape=half`, the background colour beyond the drape, flat at full strength and on the far flank shaded; no background pixel inside the noise field's projected outline at mixed levels, and auto LOD within 2 % of level 0; a click picks the point under the cursor within 0.2 mm. H6 (`doc=course`): at pitch 0 over flat ground the 3D frame equals `engine.render`'s 2D frame (north up: max 10 levels, < 0.5 % over 2 — SwiftShader's MSAA resolve; turned 25°: < 1 % over 2); tilted 60° over the cone, the leg 31–32 purple on the flank, the map's black line, paper white on the south flank at §5.6's shade for its slope, ≤ 7 draws; moved to control 32 the old drape does not reach (no purple — the frame read in the same task as the move, H8: a second round trip outlasted the 150 ms settle on CI) and no re-render happens until the camera settles, then the course is there; close and tilted, a near layer and a coarser far one (> 1.5×), each at its need, the course from the near one, texels within a third of the budget, and a 2 MB budget's third respected |
| `e2e/map-terrain.spec.ts` "lines on the terrain" (H8) | `doc=course&field=cone&line=…`: two opaque 8 px lines across the cone, 8 mm south and north of the apex. From above both are drawn; ≤ 7 mesh draws, 2 lines in 4 draws. 20° above the horizon at 5× the near one is drawn on its flank and the far one is hidden — no line colour where it would be, and the pick there meets the cone in front of it; at 1× the far flank faces the camera and the same line is drawn to its full width (≥ 6 of the 8 px rows in the column through it: the shader's half-width rise — centred on the ground line the terrain would swallow half). An X at half opacity on the flat field, from above: at the crossing and on a single stretch the colour is one blend of the line over the frame without it (± 8 levels; twice would be three quarters) — and on flat ground at the box's top, so it is in front of the near plane (`NEAR_HEADROOM`) |
| `e2e/map-gl-doc.spec.ts` "terrain=1" (H6) | the 3D bench on `e2e/test.ocd` at the event budget: the field prepared in the worker, 240 frames per scenario, drape re-renders only at the start and after the pauses, ≤ 7 mesh draws, drape ≤ 10 MB |

### 5.3 PDF (shared/print)

`packages/shared/src/print/operators.ts` (C1, 2026-10-23):
`passStreamOperators(stream, { colours, mode, resources, originUm })`
turns a sorted stream into one content-stream fragment, pass by pass in
stream order — the stream order *is* the painter's order (§3.6), so no
reordering and no decision of the backend's own. `docs/course-print.md`
owns everything around it: the writer, colour modes, fonts, the page.

**Units** (05 §5.2; C11 2026-10-24). Coordinates are the stream's paper
µm minus `originUm`, written as **integers in a layer unit `u`**
(`unitUm`; `passStreamOperators` defaults to 1 µm). `mapLayerOperators`
picks `u = layerUnitUm(matrix)` = 10 µm ÷ *n*, *n* the smallest whole
number that keeps `u` at most **5 µm on the printed paper**
(`PRINT_QUANTUM_UM`): 10 µm for a map reduced to half, 5 µm at 1:1,
10/3 µm for a 1:15 000 map at 1:10 000, 10/6 µm at 1:5 000. Being a
whole fraction of OCAD's 10 µm grid (`PRINT_GRID_UM`), and with the
origin moved onto that grid, the source vertices of an OCAD map are
written **exactly**; only computed points (dash-slice Béziers,
`strokeOutline` rings, glyph and text origins, hatch ends) round, by at
most ½ `u` per axis — ½√2 × 5 µm = 3.5 µm on paper, 0.035 px at the
golden tier's 10 px/mm, ≤ 9 of its 16 levels on one edge. A 10 µm
printed unit (7 µm worst case, ≈ 18 levels) was measured and moved
`lib-borders` to 0.84 % and `lib-hatch` to 0.45 % (budget 0.5 %); at
5 µm every golden ratio stays within 0.014 pp of the µm encoding
(`course-print.md` §9.2). Widths (`w`) and text sizes (`Tf`) are written
in `u` with up to 3 decimals. `mapLayerOperators` wraps the fragment as
`q <matrix′> cm 4 M … Q`, where `matrix′` folds `u` and the origin's move
onto the grid into the caller's matrix, so every point lands where the
caller's matrix puts its µm; `layerMatrix({ scaleRatio, rotationDeg,
atPt })` is `scaleRatio · 72 / 25 400` with the rotation
(counter-clockwise), the origin landing on `atPt` — so a 1:15 000 map
printed at 1:10 000 gets its 0.21 mm contours from the matrix, not the
data. The layer `cm` is written with 9 decimals (6 would put the far
edge of a 1 m window 0.25 mm off); instance matrices and `Tm` with 6
(the JSON projection's precision, §3.7). The page composer (C2) picks
origin, angle and point.

**Anchors** (C11). Every `fill`, `stroke` and pointed outline is written
under its own anchor — `q 1 0 0 1 ax ay cm <path> f* Q` — at the lower
left corner of the path's control-point bounds (dash slices lie inside
that hull), so its numbers are short and never negative: PDF path
operands are absolute, and a translation per object is the relative
encoding the grammar allows. The anchor is an integer in `u`, so the
rounding is the unanchored one's; an anchor of `0 0` writes no `q … Q`. Colour and line style are set before
the `q`, so the tracker is unaffected.

| Pass | Operators |
|---|---|
| `fill` | fill colour; per ring `x y m`, `l` / `c` (Béziers kept, nothing flattened), `h`; then **`f*`** — even-odd, §3.1 (05's table said `f`, written before the rule was fixed). A ring whose last segment is a line back onto its start (as written) leaves that line to `h` — the same edge (C11); likewise every clip ring (`W n` / `W* n`) and every glyph-form fill ring. A closed *stroke* keeps it: its join at the start is the stream's |
| `stroke` | stroke colour; `w J j` (cap butt / round / square / pointed → `J` 0 / 1 / 2 / 0; join miter / round / bevel → `j` 0 / 1 / 2); rings (`h` when closed); `S`. The mitre limit is `4 M` once per layer (`STROKE_MITRE_LIMIT`: the reference raster's and the GL strips' 4×, not 05's "`M 2`-ish") |
| `stroke` with `slices` | one subpath per slice from `sliceSegments` (de Casteljau, exact Béziers) and **one** `S` for the pass — each subpath gets its own caps; never PDF's `d` dash array (§3.2) |
| `stroke`, `cap: "pointed"` with a `taper` | `strokeOutline(path, { widthUm, join, taper, slices })` (`render/geometry.ts`) as fill colour + rings + **`f`** (non-zero: the outline is a union of counter-clockwise quads and join wedges, flattened at 5 µm, integers in `u`, under its anchor). The reference raster fills the same outline (§5.1). Without a taper: a butt `S` |
| `glyph` | fill colour if the part has fills, stroke colour if it has strokes (a form inherits both); instances by their **turn class** (`c·k`, `s·k` to 6 decimals; C11): the unturned class, and any class used by ≥ `GLYPH_FORM_REUSE` (16) instances of the pass, draws a form whose `/Matrix` is that turn and scale ÷ `u` — `q 1 0 0 1 x y cm /Gn Do`, then per next instance of the class `1 0 0 1 dx dy cm /Gn Do` (integer translation from the one before; `cm` concatenates, `Do` brackets the form's own drawing), re-anchored by `Q` + a new absolute `q` every `CHAIN_LENGTH` (32) instances or when the class changes, so a reader that concatenates in single precision drifts ≤ ~0.1 µm; any other instance `q c·k s·k −s·k c·k x y cm /Gn Do Q` on the form whose `/Matrix` is `1/u` alone. Instances stay in stream order. `/Gn` is a **form XObject per glyph part and `/Matrix`**, shared by every colour that draws it: the mesh in glyph-local µm — fills `… h f*`, strokes `w J j … S`, no colour — with a `BBox` of the mesh bounds plus 4 × half the widest stroke. Below 16 uses an own form costs more (object, dictionary, a second copy of the mesh) than the instances' `cm` operands save: on the corpus, 2 → +7 %, 4 → +0.3 %, 8–16 → −1.2 % against no per-class forms |
| `glyph` with `clip` | `q <clip rings> W* n` (even-odd, like the oracle's clip path), the instances, `Q` |
| a run of passes with a filter mask | `q`, `<frame + region rings> W* n` per region, the passes, `Q` ("Filter masks" below) |
| `hatch` | stroke colour; `q <area rings> W* n`, `w 0 J 0 j`, the `hatchLines()` set (§3.4, the reference generator) as `m l` pairs, `S`, `Q` |
| `text` | `BT /Fn size Tf` (size in `u`) with `0 Tr` (fill: fill colour) or `1 Tr` (halo: stroke colour, `2 × haloWidthUm w 1 J 1 j`); per glyph `cos sin −sin cos x y Tm <gid> Tj` (`1 0 0 1 x y` without `angles`); `ET`. Glyph ids are the shaper's, written unchanged (Identity-H, `course-print.md` §3.1); one `Tm` per glyph because positions are absolute in the stream (no `TJ`). A halo pass sits at its own colour position because the stream is sorted (§3.5) |
| `text`, outline fallback | per glyph `q k·cos k·sin −k·sin k·cos x y cm <outline rings> f* Q` with `k = sizeUm / unitsPerEm`; a halo strokes the outline at `2 · haloWidthUm / k` with round caps and joins — what the reference raster draws |

**Graphics state.** A colour (`k` / `K` or `rg` / `RG`, `course-print.md`
§2), `w`, `J`, `j` or `Tr` is written only when it changes; `q … Q`
appears only around a clip, an anchor, an instance chain and an
instance, and the tracker restores its state at a clip's `Q` (anchors and
instances change nothing but the CTM). Consecutive passes of one colour share one colour operator
(05 Appendix B's size arithmetic).

**Frame culling** (C13, 2026-11-03). The print window takes whole
objects within 20 mm of the frame, so a page holds long contours and
large areas that cross it and rings, dashes and instances far outside it
(44 % of Club-full A4's points lie more than 5 mm outside). The page
composer passes the printed frame (`writePage` → `mapLayerOperators`'s
`frame`, page points); `frameInStream` takes its four corners back
through the layer matrix into the stream's coordinates — for a turned map
the axis-aligned box of the turned frame, which contains it — and
`passStreamOperators` gets it as `cull` (grown by `CULL_MARGIN_UM` =
100 µm, so rounding at the clip edge never decides). It omits, by the
*control-point* bounds (a Bézier lies inside its hull, so a miss is a
miss) and without moving any point that is written:

| Pass | Omitted when its padded bounds miss the frame |
|---|---|
| `fill` | a **ring**, bounds as is. Even-odd: a ring that covers no point of the frame cannot change the parity inside it, outer or hole. The anchor follows the rings that stay |
| `stroke` | an open stroke: a **segment**, grown by `STROKE_MITRE_LIMIT × widthUm / 2` (mitre, the farthest a join paints). The kept segments form runs, one subpath each; a closed ring cut this way loses its `h`, and its last run joins its first when both reach the start vertex, so the join there stays a join. A dropped neighbour of a kept segment lies outside by the same padding, so a join or cap cut at the shared vertex paints nothing inside. A stroke with no dropped segment is written as before |
| `stroke` with `slices` | a **slice**, grown by the same padding |
| `stroke`, pointed + taper | the whole **outline**, bounds as is |
| `glyph` | an **instance**: its position grown by the form's reach (the farthest corner of `glyphFormBBox` from the origin, strokes and mitres in) × the instance's scale — a turn cannot take the form farther. Turn classes are counted over all instances, so the form choice is the unculled one's; a pass with no instance left writes nothing, not even its colour |

Not culled: `text` and `hatch` (a text is one pass of few glyphs; a
hatch is clipped to its area, whose bounds would be the test — both left
for a measurement that asks for them), clips and filter-mask frames. A
page is unchanged but for its bytes: the golden tier and the corpus
pages' shapes and ratios are equal to C11's.

**Clips.** `clipOperators(path, rule)` writes `<rings> W n` or `W* n` —
the primitive for the composer's frame clip.

**Filter masks** (§3.8, 05 §5.3; D3). A run of consecutive passes
under one mask is written inside `q`, one `<frame + region> W* n` per
region of the mask (successive clips intersect: outside every region),
the passes, `Q` — closed before the next pass with another mask or none,
and the tracker restores its state at the `Q` like at any clip. The
clip path is `filterClipPath(frame, region)`: the frame rectangle with
the region's rings as holes, always even-odd (`W*`), for the reason
fills are (§3.1). The frame is the stream's bounds (`passStreamBounds`)
united with every region's, grown by `FILTER_FRAME_MARGIN_UM` (10 mm) —
any rectangle containing what the passes draw gives the same pixels; the
page's own frame clip bounds what shows.

Tests: `packages/shared/src/print/__tests__/operators.test.ts` (tier 1,
05 §7) on the contract fixtures and the library scenes — a fill's exact
operators (holes as closed subpaths, `f*`, the stack's CMYK); origin
subtraction; `w J j` and `c` for a Bézier stroke; four slices → four
subpaths and one `S`, no `d`; pointed + taper → the `strokeOutline`
rings and `f`, pointed alone → butt; glyph instances as `cm … Do` with
rotation and scale, one form per part, form content and `BBox`; one
`q … W* n … Q` block per clip-mode pattern pass of `lib-pattern`; the
hatch block; the `1 Tr` halo pass before the `0 Tr` fill; per-glyph `Tm`
with angles; the outline fallback; per scene no `rg` in `cmyk` and no
`k` in `rgb`; one colour operator per colour change with the stack's
values; the layer `cm` for a 1:15 000 map at 1:10 000 and a rotation,
never in exponent notation (a 0.01° tilt is `0.000000495`, not `4.95e-7`);
round caps and joins on the fallback halo;
`W n` / `W* n`. C13 adds ("Frame culling"): a ring, slice, tapered outline and glyph instance outside the frame omitted, one partly inside kept whole, the stroke padding (mitre × half width), open-stroke segment runs and the wrap-around run of a cut closed ring, a stroke with nothing to drop still closed by `h`, `frameInStream` under translation, scale and a quarter turn. C11 adds: the anchor (`q 1 0 0 1 ax ay cm … Q`) on a
fill, a Bézier stroke, a dash pass and a pointed outline, none at `0 0`;
a fill ring's closing line left to `h`, a closed stroke's kept; `layerUnitUm` per
scale ratio (≤ 5 µm printed, a whole fraction of 10 µm); `w` / `Tf` /
`Tm` in the unit; the map layer's `cm` folding the unit and the origin's
move onto the 10 µm grid (a point lands where the caller's matrix puts
it), grid coordinates written exactly; **every fixture and library
scene round-trips** — decoded (anchors, chains and `Tm` resolved) at a
10 µm unit, the same operator sequence as the µm encoding and every point
within ½ unit of it; a turn class used `GLYPH_FORM_REUSE` times → one form
with that `/Matrix` and a relative chain; re-anchoring every
`CHAIN_LENGTH`; the unturned form carrying `1/u`; rarer turns under a full
`cm`. D3 adds the filter masks: `filterClipPath` (frame ring, region as
a hole), one `q` block per run of equally masked passes with one `W* n`
per region and `Q` before the next run, never `W n`, the frame round the
stream's bounds by the margin, the colour written again after a block's
`Q`, no clip operators without masks. `writer.test.ts`: a form's `/Matrix`, absent for the identity, one
form per part and matrix. `render/__tests__/stroke-outline.test.ts`: width inside
and outside the tapers (a vertex at the taper length), counter-clockwise
rings only, round / miter / bevel joins at a corner, a Bézier within the
flattening tolerance, the taper measured along the whole path across
slices, deterministic integer output.

## 6. Determinism and fixtures

### 6.1 Pass-stream assertions

Unit tests in `packages/shared/src/render/__tests__/`. A fixture object
plus its symbol is symbolised and the stream is compared with
`diffPassStreams(expected, actual, { lengthToleranceUm })`. The comparison
is structural: same pass count, same canonical order, same `objectIdx` /
`symbolIdx`, geometry equal coordinate by coordinate within the tolerance
(default 1 µm), slice parameters within 1e-6, instance transforms within
1 µm / 1e-4. The result is a list of `{ pass, what }` differences so a
failure says which pass moved and how.

Default tolerance is 1 µm: the stage is expected to be *deterministic*,
not merely equivalent. A test that needs a larger tolerance is a sign the
rule it tests is under-specified.

**Stream snapshots.** The library fixtures (§6.3) commit the whole stream
of each scene as `__fixtures__/streams/library/<scene>.stream.json` (the
JSON projection, one pass per line so a review diff names the pass that
moved) and compare it with `diffPassStreams` at the default tolerance. A
snapshot is rewritten only on purpose:
`UPDATE_STREAMS=1 pnpm --filter @oxygen/shared exec vitest run src/render/__tests__/library-fixtures.test.ts`,
and the diff is reviewed with the PR like a golden.

### 6.2 Golden images

Three-way. The reference raster (§5.1) renders the fixture at 10 px/mm
(254 dpi). The WebGL2 backend renders the same stream in headless
Chromium (Playwright) and the PDF backend's page is rasterised with
poppler's `pdftocairo` at the same density (C3; `docs/course-print.md`
§9.2). Each is compared with the oracle by
`diffImages(a, b, channelTolerance = 16)`: a pixel differs when any
channel differs by more than 16/255; the fixture passes when the fraction
of differing pixels is ≤ 0.5 % (04 §9 budget). Backends are compared
with the oracle, never with each other.

**Golden scenes** are the six contract fixtures (§6.3), the
`pilot-scene` (`__fixtures__/pilot-scene.ts`: one object per pilot
symbol, hand-placed), the twelve library fixtures (`lib-*`, §6.3,
coloured from the library's palette through `cmykToHex`) and the six
course scenes (`course-*`, §6.3, C0 and F1: a library base map and
`courseLayer()` merged into one stream, coloured from the completed
stack). The three **page scenes** (`page-*`, C2,
`docs/course-print.md` §7.5) are separate: a composed page drawn by the
page oracle (`render/page-raster.ts`), compared by the PDF tier only (C3)
— the WebGL2 spec does not draw pages. `render.goldenScene(name, fonts)` resolves a name
to `{ stream, colour }` identically on every side, and
`render.goldenFrame(stream)` fixes the image frame: bounds + 1 mm
margin, grown symmetrically to a **whole number of pixels** (a 57.5 px
viewBox leaves quarter-pixel rows that are background on one side and
transparent on the other).

Mechanics of the WebGL2 leg:

```
pnpm --filter @oxygen/api golden:render      scripts/render-golden.ts
      │  reference raster at 4× density, box-filtered to 10 px/mm
      ▼
e2e/__golden__/map-gl/<scene>.png            committed, reviewed in the PR
      ▲                           ▲
      │ must equal the oracle     │ ≤ 0.5 % differing pixels
packages/api/src/render/          e2e/map-gl-golden.spec.ts
  __tests__/golden-files.test.ts    /dev/map-gl?fixture=<scene> → canvas.toDataURL
```

The api unit test fails whenever a committed golden no longer matches
the current oracle, so a stale golden cannot be what the browser test
compares against; the browser test is the only place the GPU output is
judged, and on failure it attaches the actual image and a red-marked
diff.

Why the oracle is **supersampled 4×** for goldens (`GOLDEN_SUPERSAMPLE`):
resvg flattens curves to ~¼ px chords and both rasterisers round edge
coverage differently; at 1× those two effects alone put 1–6 % of the
pixels of a curve-heavy scene outside the 16-level tolerance, with the
backend drawing the right thing. Zooming the same SVG 4× (exactly 4× the
pixel size, same centring) and averaging 4×4 blocks pushes the oracle's
own error below the tolerance so the comparison measures the backend.
The GL side renders the goldens with `supersample: 2` (16 effective
samples). Measured ratios, headless Chromium / SwiftShader (B1 run,
2026-10-21; the first seven were 0.000 / 0.206 / 0.038 / 0.009 / 0.000 /
0.441 / 0.293 % in S1):

| Scene | Differing pixels |
|---|---|
| `fill-with-holes` | 0 / 48 400 (0.000 %) |
| `dashed-bezier-stroke` | 136 / 66 000 (0.206 %) |
| `glyph-instances` | 10 / 26 076 (0.038 %) |
| `hatch-area` | 6 / 67 200 (0.009 %) |
| `colour-order` | 0 / 48 400 (0.000 %) |
| `text-with-halo` | 20 / 5 220 (0.383 %) |
| `pilot-scene` | 1 151 / 385 640 (0.298 %) |
| `lib-dash-ocad` | 4 / 36 900 (0.011 %) |
| `lib-dash-omap` | 0 / 17 500 (0.000 %) |
| `lib-line-glyphs` | 26 / 15 930 (0.163 %) |
| `lib-pattern` | 202 / 55 000 (0.367 %) |
| `lib-hatch` | 0 / 34 000 (0.000 %) |
| `lib-borders` | 0 / 25 760 (0.000 %) |
| `lib-holes` | 0 / 30 800 (0.000 %) |
| `lib-text` | 82 / 23 560 (0.348 %) |
| `lib-halos` | 15 / 21 160 (0.071 %) |
| `lib-colour-order` | 79 / 26 199 (0.302 %) |
| `lib-precision` | 178 / 64 566 (0.276 %) |

B9 (2026-10-21) changed `lib-line-glyphs` and `lib-precision` (one more
510 object, no glyphs on unflagged ends — §4.5); B10 (2026-10-22, library
2026.10.3) changed them again (510 bars ±0.37 mm) and `lib-borders` (the
509.1 railway's new construction). All three pass the budget in those
runs; their ratios are not re-measured here.

What remains is coverage quantisation: every residual differs by 17–26
levels and the GL values are multiples of 16. **The ratio therefore
depends on the edge density of the scene**, not only on the backend —
`text-with-halo` is 90 × 58 px of glyph edges and sits near the budget
while the pilot scene has margin. Two consequences for the spec: the
golden tier certifies *geometry* (right thing, right place, right
colour, right order) under the backend's high-quality mode; it does not
certify production anti-aliasing (4× MSAA at 1× cannot meet a 16-level
tolerance on edge pixels and is not asked to). And a 3× supersample is
*worse* than 2× with the linear resolve (4 of 9 texels sampled) — a
higher factor needs a real box-filter pass.

**MSDF text tier** (B3; user decision 2026-10-22: a text tier at a
provisional ≤ 2 %, tightened to the observed ratio + margin once
measured, plus `compare=1` on `e2e/test.xmap`).
The per-pass golden path draws text from exact outlines; the arena path
draws it from the 32 px MSDF atlas, at the context's MSAA only. At the
golden density (`text-with-halo`: a 57 px em, 1.8× the atlas) MSDF
cannot be held to 0.5 % on scenes that are all glyph edges, so the text
scenes are drawn a second time through the arena path
(`/dev/map-gl?fixture=<scene>&path=arena`) against the **same goldens**
at **≤ 1 %** differing pixels (`TEXT_TIER_MAX_RATIO`; the provisional
2 % tightened to the largest measured 0.69 % + margin). Measured at
introduction (headless Chromium, 2026-10-22), arena vs per-pass:

| Scene | Arena (MSDF) | Per-pass (outlines) |
|---|---|---|
| `text-with-halo` | 19 / 5 220 (0.364 %) | 20 / 5 220 (0.383 %) |
| `lib-text` | 162 / 23 560 (0.688 %) | 82 / 23 560 (0.348 %) |
| `lib-halos` | 50 / 21 160 (0.236 %) | 15 / 21 160 (0.071 %) |
| `lib-text-layout` (B8) | 433 / 151 506 (0.286 %) | 553 / 151 506 (0.365 %) |

`lib-text-layout` (B8) is drawn at 1.5× (a 3.75 mm em): at 2.5 mm the
scene, nearly all glyph edges, measured 0.537 % on the per-pass path —
edge quantisation spread over every glyph, the density effect above —
so it is scaled, not thinned. `lib-text`'s residual is the smallest text (≈ 15–20 px em, under the
atlas's 32 px), spread along edges with no systematic offset. The whole
document compare (`compare=1`) holds MSDF to the per-pass path at the
ordinary 0.5 % on `e2e/test.xmap`: 0.217 %.

**Filter-region arena tier** (D3). The `filter-*` scenes (§6.3) pass
the per-pass path at the contract budget; they are drawn a second time
through the arena path, where the masks are the visible set's
per-(colour, mask) draws (§5.2 "Filter regions"). That path is MSAA
only, and these scenes are mostly hairlines — 0.14 mm contours and the
407's 0.12 mm hatch lines at 10 px/mm — whose edges step in quarter
coverage, so the whole image is held to **≤ 1.5 %**
(`ARENA_FILTER_MAX_RATIO`, the largest measured 1.05 % + margin): the
scene without a mask (`filter-hide-505`) measures the same as the masked
ones. What the masks decide is checked by **pixel probes** instead: per
scene, a point or segment in paper mm on each side of the region with
the colour expected drawn or absent, asserted on the golden and on the
arena image (a 5 × 5 px window, Σ|Δ| ≤ 90). Measured at introduction
(headless Chromium, 2026-10-31):

| Scene | Per-pass | Arena |
|---|---|---|
| `filter-clip-brown` | 304 / 260 400 (0.117 %) | 2 305 / 260 400 (0.885 %) |
| `filter-hide-505` | 348 / 260 400 (0.134 %) | 2 320 / 260 400 (0.891 %) |
| `filter-moved` | 267 / 260 400 (0.103 %) | 1 875 / 260 400 (0.720 %) |
| `filter-show-only` | 373 / 260 400 (0.143 %) | 2 723 / 260 400 (1.046 %) |

**PDF leg** (C3, `packages/api/src/render/__tests__/pdf-golden.test.ts`;
the method and the full table are `docs/course-print.md` §9.2). Every
golden scene is written as a one-page PDF covering its golden frame,
every page scene through the composer, in `rgb` and `cmyk`; `pdftocairo`
rasterises at the oracle's own supersample (4× scenes, 2× pages) and the
result is box-filtered down. Budgets as above: **≤ 0.5 %** for every
scene, and for a scene with text the same 0.5 % with text written as
glyph outlines; the embedded-font run of a text scene is the PDF's text
tier of the golden scenes at a provisional **≤ 2.5 %** (page
scenes stay at 0.5 %) (user decision 2026-10-24: the
measured 1.21 % / 1.96 % below are the values to tighten towards once
CI's poppler is measured; the rasteriser draws embedded fonts through
FreeType's glyph renderer, not the outlines the oracle fills — the PDF
counterpart of the MSDF tier). `cmyk` pages are compared against the
oracle drawn in the rasteriser's own CMYK → RGB conversion of each stack
colour. `pdftoppm` (Splash) is not used: its stroke adjustment snaps
fills and hairlines to the pixel grid (2–5 % on geometry-exact library
scenes). Measured at introduction (`rgb`, poppler 22.02):

| Scene | PDF, embedded fonts | PDF, text as outlines |
|---|---|---|
| contract fixtures and `lib-*` without text | ≤ 0.036 % | — |
| page scenes (held to 0.5 % with fonts) | ≤ 0.073 % | — |
| `pilot-scene` | 0.038 % | 0.000 % |
| `text-with-halo` | 0.000 % | 0.000 % |
| `lib-text` | 1.210 % | 0.000 % |
| `lib-halos` | 0.369 % | 0.000 % |
| `lib-text-layout` | 1.964 % | 0.000 % |
| `lib-colour-order` | 0.118 % | 0.000 % |
| `course-*` | 0.013–0.478 % | 0.000 % |

**Designing a golden scene.** Two layouts turn that quantisation into a
failure without any geometry being wrong, and the library scenes avoid
both (B1; first measured at 0.66 % and 0.505 %): a thin **axis-aligned**
edge at a fractional pixel offset puts every pixel of a column at the
same partial coverage, so the whole column sits 17–24 levels off (the
vertical 505 track of `lib-colour-order` — now diagonal); and a pattern
whose cell is a whole number of pixels puts every instance at the same
sub-pixel phase, so one glyph's residual is copied to all of them (208's
12 px cells, 213's 1.6 px dots — now on small areas). The stream
assertions (§6.1) carry the rule; the golden only has to show the backend
draws the same geometry.

The oracle itself is checked by **pixel probes**: hand-computed paper
coordinates where a given colour must appear (`sampleAt(img, xUm, yUm)`),
e.g. the evaluated point of a Bézier at t = 0.5 is ink, the middle of a
dash gap is paper, the k-th hatch line at a given x is ink. The probes in
`packages/api/src/render/__tests__/reference-raster.test.ts` are the
acceptance test of the oracle; they are kept as they are the only
hand-measured truth in the chain.

### 6.3 Fixture set

Hand-built streams live in
`packages/shared/src/render/__fixtures__/streams/index.ts` and are
exported as `render.renderFixtures`. They exercise the *contract*, not
symbolisation, and every backend must draw all of them:

| Fixture | Exercises |
|---|---|
| `fill-with-holes` | even-odd fill, two hole rings, same winding as the outer ring |
| `dashed-bezier-stroke` | a whole Bézier stroke; the same curve dashed via four slices |
| `glyph-instances` | a two-part glyph, instanced unrotated, rotated 45° × 1.5, scaled × 0.75 |
| `hatch-area` | 45° hatch with offset, clipped to a pentagon |
| `colour-order` | passes pushed out of order; the sort decides what covers what |
| `text-with-halo` | halo pass under text pass, same positions, different colours |

The symbolisation rules of §4 are proven by the **pilot symbol family**
(`packages/shared/src/render/__fixtures__/pilot-symbols.ts`, exported as
`render.pilotSymbols` / `render.PILOT` / `render.pilotColours`): 101, 505
(OCAD and OMAP), 502, 503 with framing, 516, 529, 418, 403, 407, 213,
709, 714, 704. Its stream-level assertions are in
`__tests__/symbolise.test.ts`; its pixel probes through the oracle in
`packages/api/src/render/__tests__/pilot-raster.test.ts`.

The **library fixtures** (B1) are the 04 §8 table drawn with the
canonical library: `__fixtures__/library/index.ts` (`render.libraryScene`,
`librarySceneNames`), each scene a set of objects plus the library
entries it uses, resolved through the library's palette. Where the
library has no entry for a rule, the scene uses a **hand variant** — the
named entry with the stated fields replaced. Hand-computed assertions per
row are in `__tests__/library-fixtures.test.ts`; the whole stream of each
scene is a snapshot (§6.1) and a golden (§6.2).

| Scene | 04 §8 row | Objects (library entries; *variant*) | Asserted |
|---|---|---|---|
| `lib-dash-ocad` | 1 | ISOM 505 with a corner and a dash point; 505 closed (18 mm loop); 507; 505 short, solid and *`minGaps: 2`* | slice boundaries as arc lengths: 1.8 mm dashes, corner dash one slice round the corner, a 1.8 mm dash centred on the dash point; loop seam dash on the start point; 507's secondary cut; forced gaps |
| `lib-dash-omap` | 2 | ISOM 505 *as `layout: "omap"`*: single, *`halfOuterDashes`*, *groups of 2*, *`showAtLeastOne: false`* on a 0.8 mm line, with a dash point | interval lists at `f = 1`; the dash point centres one dash |
| `lib-line-glyphs` | 3 | ISOM 516, 201, *529 at corners with `ignoreEnds` and `scaleAtCorners`*, *510 at dash points* (dash point inside, plain ends; a hand variant since B10), 416 on a closed loop, 510 (corners — the library's placement since B10 and the OCAD import's shape, B9) with a plain start and a corner-flagged end | instance positions, angles (bisector 45°), mitre scale √2, no glyph on an unflagged end, one on a flagged end, `minCountClosed` |
| `lib-pattern` | 4 | ISOM 402 on two adjacent squares, *402 turning with the object* at 30°, 208 (shifted rows), *213 at 0° in the four clip modes* | one origin-anchored lattice; rotated lattice; half-cell row shift; completelyInside ⊂ centreInside ⊂ partiallyInside = clip, `clip` path only in clip mode |
| `lib-hatch` | 5 | ISOM 709 on two adjacent areas, 407, *709 crossed (second hatch at 135°)* | pass parameters and order; every `hatchLines` endpoint on `x·nx + y·ny = offset + k·spacing` |
| `lib-borders` | 6 | ISSprOM 509.1, 505 round a corner, *505 with a 0.2 mm right edge at 0.3 mm* | 509.1 (B10): an unsliced black 0.45 band under white 1.0 / 1.5 dashes shortened 1.5 mm at both ends (black ends, 1.5 mm black between dashes); both dashed borders keep the main line's phase at their own lengths; asymmetric edges |
| `lib-holes` | 7 | ISOM 401: two holes, one reversed; a self-touching ring | one even-odd fill each, rings passed through untouched (earcut deviation is the GL backend's, image tier) |
| `lib-text` | 8 | ISOM 704 "31"; 603.b *left / centre / right*; a two-line 603.b | em from the digit height (Liberation "0" = 1430 units → 5.73 mm), advances with kerning ("AV"), alignment shifts, line spacing |
| `lib-text-layout` | 8 (cont., B8) | the scene at 1.5× (`TEXT_LAYOUT_SCALE`, §6.2); ISOM 603.b *at 3.75 mm em*: *justify + 0.6 mm paragraph spacing* in a 12 × 12 mm box; *centre + middle* in a 12 × 6 mm box; *a white (`white-over-green-brown`) rectangle frame* on text turned 8° over 406; *a 5 mm tab stop*; *centred* along a Bézier arc | box: first ascent on the top edge, three wrapped lines inside the width, 1.2 em apart, 0.6 mm more before the second paragraph, justified lines reach the width and a paragraph's last line does not; middle box centred in its height; frame = widest line × (digit height … baseline) grown by the margins and turned with the text, sorted above the green; the word after the tab at the stop; line-text origins on the arc, angles decreasing along it |
| `lib-halos` | 9 | ISSprOM 704.b over 521; *508 with a continuous white band* over 406 | the white outline between the building's black and upper purple; the band its own pass over the green |
| `lib-colour-order` | + | ten ISSprOM colours, lower and upper purple among them, pushed in reverse | colour-major order; lower purple under black, upper purple last |
| `lib-precision` | + | `lib-dash-ocad` and `lib-line-glyphs` moved to (1 200 000, 1 200 000) µm | every pass the near pass translated, to 1 µm |

The **course scenes** (C0, `docs/course-layer.md`) draw a small base
map from the canonical library on its palette stack and a course layer
from `courseLayer()`, merged by `courseRenderInput()` into one stream —
exactly what a backend does: `__fixtures__/course/index.ts`
(`courseScene`, `courseSceneNames`), snapshots in `streams/course/`,
assertions in `packages/shared/src/course/__tests__/scenes.test.ts`.
WebGL2 per-pass path against the golden, measured at introduction
(headless Chromium, 2026-10-24): `course-legs` 0.085 %, `course-cuts`
0.239 %, `course-objects` 0.076 %, `course-sprint` 0.039 %,
`course-all-controls` 0.056 %.

| Scene | Objects | Asserted |
|---|---|---|
| `course-legs` | ISOM 401, 505, 101, 306, 516 under S → 31 → 32 → 33 → F | lower purple under black, brown and blue line art, above yellow; start turned to 31; sequence numbers in upper purple above the ink |
| `course-cuts` | ISOM 204 on a rim and on a leg, 109 on a rim, 201; an authored gap and authored leg pieces on 33; a manual number position | automatic cuts from the features, authored gap and pieces kept, number at its offset, cut circles as open arcs |
| `course-objects` | ISOM 406, 505, 106; white-out rectangle, toner-saver ring, 709 rectangle, 709.b triangle, 707 / 708 / 711 extras, a map text in its own colour with `{course}` | the white-out at upper white above all ink and below upper purple, the toner-saver ring in its own white row on top of the stack (P1: the 709.b border past its edge is covered); 709 / 707 / 711 upper, 708 lower; the text's row on top of the stack |
| `course-sprint` | ISSprOM 401, two 521 buildings; `numberStyle: "knockout"` | 6 mm circles; upper-white halo under upper-purple numbers, above the buildings' black |
| `course-all-controls` | ISOM 403, 304; all controls with a free-order course | every site drawn, codes, no legs, start north |
| `course-leg-styles` | ISOM 401, 505, 516; S → 31 a bent 705, 31 → 32 a bent 707 marked route over the 516, 32 → F `style: "none"` with a stored gap (F1, `course-layer.md` §10.1) | the 705 piece runs through its bend; the route in upper purple, dashed, after black; nothing for the `none` leg, which keeps its pieces; numbers unchanged |
| `course-corridor` | ISOM 401, 505, 101, 516; S → 31 → 32 one 60 m run (4 mm, h 2 < R 2.5) with its `edge` and a 3 mm band, bent at (36, 10); 32 → 33 a 150 m corridor without edge with a 2 mm band; 33 → F plain (F2, re-shaped in F19, `course-layer.md` §10.2) | the band one generated `clip` region: every base pass masked, no course pass; clear inside every corridor (at the bend, at the change of width at 32) and inside the mouths (31's circle across, the 701's back corner), the band round them, nothing behind the 701's base; at 33, the corridor's only terminal end, the band stops on the line through its centre with rounded corners and the map shows behind it (F22, `course-layer.md` §10.2 "Ends"); the edge lower purple `705/edge` along S → 31 → 32 only, over the 401; 31's circle opened towards both legs (two arcs), 32 and 33 whole (the wide corridor covers the junctions; h ≥ R), no cut in the derivation; no 705 along the three corridor legs, 33 → F the only leg line (F14). Drawn on the default GL path (the arena path's MSAA edge steps exceed `ARENA_FILTER_MAX_RATIO` on this many edges: 2.0 %, D3's filter scenes cover the arena masks) |

The **filter scenes** (D3, 04 §8 row "Filter regions", §4.11) draw one
ISOM base map — a 407 area (0–60 × 0–40 mm), 101 contours (a straight
one and a Bézier through the region, one below it), 505 footpaths (one
through the region, one right of it, one above) — under one pentagon of
radius 10 mm round (24, 20) mm, turned 12°, entered through
`courseLayer({ regions })` and `courseRenderInput()`:
`__fixtures__/filter/index.ts` (`filterScene`, `filterSceneNames`),
snapshots in `streams/filter/`, assertions in
`render/__tests__/filter-fixtures.test.ts`. Each is a golden in all three
tiers (raster, WebGL2 per-pass and arena, PDF).

| Scene | Regions | Asserted |
|---|---|---|
| `filter-clip-brown` | clip `{ colours: [brown] }` | the two contours through the pentagon masked, nothing else; nothing hidden; image: contours stop at the boundary, footpaths and hatch run through |
| `filter-hide-505` | hide `[505]` | the footpath through the pentagon hidden, whole; the others drawn |
| `filter-moved` | clip brown + hide 505, the pentagon moved 10 mm (half its width) right | the other footpath hidden instead; the contours cut further right |
| `filter-show-only` | clip `[101, 505]`, `invert` | "show only": the 407 hatch is the one masked pass; contours and paths inside drawn |
| (all four) | — | `filterStream`'s fast bbox predicate gives the exact result's hidden set and masks |

The **page scenes** (C2, `@oxygen/shared/print` `pageScene`,
`print/__fixtures__/pages.ts`) are whole pages through `composePage`:

| Scene | Page | Asserted |
|---|---|---|
| `page-sprint-a4` | A4 portrait, ISSprOM map 1:4 000 printed at 1:3 000, six-site course, IOF header block with pictograms, page title | map layer under `T_map` (×4/3) clipped to the frame; block geometry and pictograms; page text on top |
| `page-ring` | 120 × 90 mm, ISOM 1:10 000; a toner saver course object (a map-anchored white-out outside until F12), page white-out box over the frame edge, page text and dashed line | white margin and ring, map inside the ring, page objects above the map |
| `page-rotated` | 120 × 90 mm, ISOM, window rotated 20° clockwise; map text | map, course and text turned together, corners outside the frame white |

Not in the table: 04 §8 row 10 (minimum sizes) is a screen-backend rule
(the stream is the same at every zoom), and the georeference row belongs
to A11's `mapGeo`.

### 6.4 Corpus parity

The B-gate's parity check (09 §4 B: "visual parity on the corpus against
tiles for the sanctioned differences only") and the instrument for
triaging a user's "this looks wrong" on a real map (B9).

**Retired in E4a.** The tool (`packages/api/src/render/parity.ts`,
`scripts/measure-parity.mjs`) and its tests went with the tile renderer
it compared against (decision log 2026-11-06); it is in git history up
to v0.5.0. This section is the record of its method, sanctioned codes
and corpus results.

**Method.** `runParity` (`packages/api/src/render/parity.ts`) takes an
OCAD file and a paper window (mm, y-up, snapped outwards to whole mm) and
renders, for every symbol with objects within 10 mm of the window, two
images on the same pixel grid at a whole px/mm (default 10, the golden
density):

- *legacy* — the tiles' raster: `readOcad` → `ocadToSvg({ objects })`
  with only that symbol's objects → the window's `viewBox`
  (`map-window.ts`) → resvg on white, exactly as `map-tiles.ts` draws a
  window (no IOF colour stack);
- *new* — the document path: `importMapToDocument` →
  `documentRenderInput` (canonical rendering on, or off with `--source`)
  → `symbolise` with only that symbol's objects → reference raster
  (§5.1), coloured with the **legacy RGB** of each stack entry's source
  colour so the diff measures geometry, not the CMYK conversion. The
  conversion is reported once, apart (colours whose shared `cmykToHex`
  differs from `ocad2geojson`'s by more than 16).

Every other symbol is absent on both sides, so a difference belongs to
the row. Hidden, proxy-drawn (`render: null`), missing and graphic
symbols are listed, not compared.

**Measures and verdict.** Per row: *differing* (the §6.2 channel
tolerance 16), *ink* (pixels inked on either side) and *unexplained* —
pixels inked (some channel more than 48 below white, about a fifth of
full coverage) on one side with no ink within one pixel on the other,
and differing beyond the channel tolerance there (C7: a tone on the
threshold — Crop-A's 214.0 at 206 against 207 — otherwise counted as a
whole missing shape; `docs/bugfix-parity-ink-threshold.md`). The corpus
tables below were measured before that rule; it only removes counts, so
none of their verdicts would flip to `diverges`.
Anti-aliasing shades and sub-pixel placement never count: at 10 px/mm a
0.1 mm line is one pixel, and a 0.05 mm offset flips every pixel of it
at the channel tolerance. The verdict is `close` when unexplained ≤ 10 %
of ink, `diverges` otherwise, `empty` without ink. Rows are ranked by
unexplained ÷ ink, then differing ÷ ink.

**Sanctioned differences.** Places where the new pipeline is right and
the legacy is not (03 §4.1 lists the legacy's gaps; §4 here pins the
replacement). A row carries the codes its IR and its objects' flags
trigger; the tool cannot prove a divergence *is* the sanctioned one, so
the images are always read.

| Code | Difference |
|---|---|
| `dash-fitting` | OCAD dashes fitted per section (§4.2); legacy: one uniform `stroke-dasharray` |
| `dash-points` | dash points centre a dash and split sections; legacy ignores them |
| `secondary-symbols` | OCAD secondary symbols once per section; legacy draws none |
| `corner-angle` | corner glyphs on the bisector (§4.5); legacy: the incoming segment |
| `glyph-spacing` | spaced line symbols by the §4.5 rule per corner section; legacy rounds its own way |
| `curve-glyphs` | symbols along curved lines placed and turned on the curve; legacy walks the Bézier control polygon — more spots, off the line, polygon angles |
| `border-flags` | double-line `noLeft` / `noRight` vertices interrupt a border (§4.4); legacy ignores them |
| `gap-flags` | vertex gap flags interrupt the line; legacy ignores them |
| `pointed-caps` | pointed ends taper; legacy: flat |
| `pattern-origin` | hatches and structure patterns anchored at the paper origin (03 §6.9 item 4), patterns with their clip mode; legacy: the SVG viewport's origin, always clipped |
| `text-fonts` | text as Liberation outlines (§4.9–4.10); legacy: SVG `<text>` in system fonts |
| `rectangle-symbols` | OCAD rectangle symbols drawn; legacy draws none |
| `line-end-symbols` | OCAD start / end symbols only where `useSymbolFlags` enables them (`map-import.md` §3.3); legacy draws any present |
| `corner-ends` | corner / dash-point glyphs on flagged line ends (§4.5); legacy never draws one on an end |
| `main-symbol-count` | an OCAD main symbol only with `nPrimSym > 0` (`map-import.md` §3.3, 518.3 "Utan tagg"); legacy draws it as if 1 |

The print counterpart — a whole course page through the PDF backend
against the page oracle and the legacy rsvg page, with this tool
attributing the base map's divergences per symbol — is
`docs/course-print.md` §11.

**Invocation.**

```
node scripts/measure-parity.mjs <map.ocd> [--window=x0,y0,x1,y1] [--px-per-mm=10] [--source] [--codes=a,b] [--out=<dir>]
```

writes `<code>.old.png`, `<code>.new.png`, `<code>.diff.png` (red: ink
only in the legacy; blue: only in the new; magenta: both, different
colour) per compared symbol and `summary.md`, by default into
`.local/parity/<map>/` (corpus output is never committed, AGENTS.md
§12). Exit 0 when every diverging row carries a sanctioned code, 1
otherwise. `--source` takes the library out of the comparison
(renderer and importer against the legacy); the default shows the map
as users see it, so canonical rows also measure library entries against
the mapper's own definitions.

Tests (deleted with the tool in E4a): `packages/api/src/render/__tests__/parity.test.ts` (pixel grid,
isolation, agreement on `e2e/test.ocd`, the frame as a sanctioned
divergence, ranking, shape measure, tags; a 510 power line from
`buildParityOcad` with its poles at the corner points only; Club-full's
north-oriented barrier, footbridge and tunnel with rotated objects from
`buildRotatedPointsOcad`, every kind `close` with canonical rendering on
and off, the footbridge laid across on both images — C10) and
`scripts/__tests__/measure-parity.test.mjs` (CLI, `pnpm test:scripts`).
**Fonts on the legacy side.** The tiles leave the mapper's font names
("Arial") to the system font stack, which in the Docker image resolves
to Liberation 1.07 — the outlines `@oxygen/shared` bundles (§4.10). The
tool pins that outcome rather than inheriting the machine's fonts: it
maps each `font-family` through `ocadFontFamily` and hands resvg only
the bundled files (`loadSystemFonts: false`). Before this, a GitHub
runner (Liberation 2.x, different glyph shapes) reported the 603 spot
height as a 24 % divergence that no local machine with 1.07 saw.

**Corpus results (B9, 2026-10-21, `ocad-9`, 10 px/mm, whole maps plus
the club-2026 review windows).** Compared symbols and the ones that
diverge (unexplained > 10 %):

| Map | Compared | Diverging, `--source` | Diverging, canonical | Unsanctioned |
|---|---|---|---|---|
| Sprint | 86 | 7 | 9 | canonical 101.1 / 103.1 slope lines (fixed in B10) |
| Crop-B | 94 | 4 | 10 | canonical 101.1 / 103.1 (fixed in B10); 522 canopy tone |
| Club-2026 | 186 | 23 | 26 | canonical 101.2 / 103.3 slope lines (fixed in B10) |

Drawn from source definitions, every divergence on all three maps is
sanctioned (exit 0): pattern and hatch phase, text fonts, OCAD dash
fitting, glyphs along curves, and 518.3's tags. What the run found and
what became of it:

- **Fixed in the importer (`ocad-9`).** OCAD 9+ circle diameters are
  centre-line (every ring was one line width small: the 702 / 706
  circles); `useSymbolFlags` bit 1 is the end symbol, bit 2 the start
  symbol (`map-import.md` §3.3).
- **Fixed in the stage.** Corner and dash-point glyphs sit on flagged
  vertices only, ends included when flagged (§4.5): club-2026's 510.0
  had a pole on each of its 44 object ends; 7 of those ends are corner
  points and keep theirs. The 510 window at 20 px/mm is now `close`.
- **Fixed in the library (B10, 2026.10.3).** 101.b / 103.b slope ticks
  pointed to −y (uphill on imported maps); 510 / 511 / 511.b poles were
  placed `atDashPoints`, which no importer produces. Canonical,
  unexplained ÷ ink before → after: club-2026 101.2 54.85 → 0.00 %,
  103.3 51.65 → 0.00 %; Sprint 101.1 65.67 → 0.00 %, 103.1 62.31 →
  0.00 %; Crop-B 101.1 52.41 → 0.00 %, 103.1 52.91 → 0.00 %. 510.0 on
  club-2026 and Crop-B now matches the library (was drawn from source,
  `suggested`) at the same 4.49 % / 0.85 %; Sprint's 509.100 railway
  now matches ISSprOM 509.1 at 0.00 % (differing 38.67 %: OCAD dash
  phase and the black ends); ISOM 111 on club-2026 now matches at
  0.00 %. Auto matches per map: club-2026 85 → 87, Sprint 101 → 105,
  Crop-B 100 → 102, club-full 98 → 100, Crop-A 101 → 103. Whole maps
  after B10, canonical: club-2026 24 diverging, Sprint 7, Crop-B 8, all
  sanctioned except Crop-B's 522 canopy tone.
- **Fixed in the importer (`ocad-15`, C10, found by C7).** North-oriented
  OCAD point symbols whose objects carry an angle are drawn turned, as
  OCAD and Mapper draw them (`map-import.md` §3.3): Club-full has 23 such
  symbols; its 504.5 / 504.7 barriers, 512.3 footbridge and 519.0 tunnel
  — every object turned — diverged 24.92 / 36.28 / 26.65 / 31.96 %, and
  519.3 21.31 %, 208.4 15.04 %; all 23 are `close` since, with canonical
  rendering on and off (`docs/bugfix-ocad-point-rotation.md`).
- **Spec-faithful, kept.** Cliffs: every 201.x / 202.x variant matches
  the legacy at 40 px/mm from source (0 % unexplained); canonically
  matched 202.2 / 201.5 get ISOM's flat ends (the "small houses"),
  as Mapper's ISOM set does. `ocadLineStyle` equals the legacy's
  `stroke-linejoin` / `linecap` table. 522 canopy: the library's 20 %
  black is darker than the source's grey — a tone, not a shape.
- **Not reproduced: missing line sections on GL.** No bucket defect:
  club-2026's grid has 62 non-empty cells of 70, all resident at the
  review view; an object at most 2 × 2 cells wide reaches at most one
  cell from its centre cell, which the 1-cell draw margin covers; the
  arena path equals the per-pass path to 0.1 % (`compare=1`,
  10.7 px/mm). The 511.2 line through Brotorp breaks where the source
  has gaps between objects (5.1 and 4.5 mm, at the road crossing) and
  the reference raster matches the legacy there (0.3 %).

### 6.5 Colour-order parity

Slice I's oracle (`SLICES.md` I1; `map-symbols.md` §9.3 "Acceptance"):
the whole map drawn in two colour orders, every pixel that changes named
by the two layers involved and classified, as §6.4 and
`course-print.md` §11 did for their slices. It measures what a
candidate order does to a map; it does not decide the order.

**The two orders.** Each map is imported as the import worker does on a
first import (`importMapToDocument`, no decisions) and drawn twice
through `documentRenderInput` → `symbolise` → the reference raster
(§5.1):

- *source* — the document imported in the `source` colour order (§9.2 of
  `map-symbols.md`: the mapper's table, purples placed by rule; since
  I5, `colourOrder: "source"`, which is no longer the importer's
  default);
- *candidate* — the same map on another stack. The candidate is a
  parameter of the tool (`--candidate`): `layers` (the default, from I3)
  or `permutation` (I1's baseline).

  **`layers`** is the layered stack (`map-symbols.md` §9.3 "Layers",
  `buildColourLayers`). **Since I5 it is the importer's own**: the same
  file imported a second time in the default `iof` order
  (`importedCandidate`): rows correspond by colour id (a source colour
  keeps `src:<n>` on its lowest row of its own, an inserted row its
  `<edition>:<paletteId>`), else by the palette id a source row carries,
  and the layers are named from the import report's `colourStack.layers`.
  A map whose `iof` import falls back to the source order
  (`COLOUR_LAYERS_FAILED`) is a map error. Until I5 the harness built the
  stack from the imported document itself (`layeredCandidate`, kept for
  the unit tests' hand-made stage 7 documents, and shown equal to the
  importer's on `e2e/test.ocd`): the source table is the stack's
  rows with a `sourceNumber` (stage 7 inserts rows without one and never
  reorders the source's; `sourceTableOf`), each source symbol's IR is
  mapped back onto it, roles are read from the symbols' matches
  (`symbolColourUses`, with `library` from each symbol's match state),
  `needed` from the applied ones, and every source
  symbol is re-indexed per reference (`reindexRenderColours`). Canonical
  symbols follow their palette ids; proxy-drawn objects take the row
  source row 0 became (`rowOfAligned`; the source drawing passes its
  proxies row 0 explicitly, I1's rule, since the bridge's own default
  goes by ink from I5, `map-document-format.md` §8). From I4 the stack has its
  exceptions (own order, deviations at their defaults, source order;
  `map-symbols.md` §9.3); the harness passes no overrides.

  **`permutation`** is the 2026-11-14
  experiment's (`permutationOrder`): every row at its
  highest role's place in the alignment palette (`alignmentPalette`,
  `map-symbols.md` §9.2); a row with no role by the symbol kind drawing
  most objects in it — an area colour just under lower purple, anything
  else just under upper purple; ties keep the stack order. Source
  symbols are re-indexed through the permutation; canonical symbols
  follow their palette ids; objects whose symbol has no IR, which the
  render bridge draws with its proxies in stack row 0 (§5.2), are drawn
  in the row that row 0 moved to (`permutedRenderOptions`). The
  experiment missed that last part and recoloured them: Crop-B's
  frame bars, drawn by graphic objects without IR, came out yellow.

A row's *roles* are the palette ids it stands for (`paletteIds`, plus
the id stage 7 identified for it, §9.2 step 2) that the alignment
palette has. In the permutation a colour serving several roles stays one
row, ranked by its highest role. A layered row has one role (its
report's), or none.

**Tiles and the diff.** The map's bounds are cut into square tiles
(`--tile-mm`, default 60 mm) drawn at `--px-per-mm` (default 6); a tile
draws every object whose bounding box comes within 5 mm of it (line
widths and glyphs reach past a bounding box). A pixel *changes* when one
of its RGB channels differs by more than the tolerance between the two
drawings (`changedMask`; default 16, §6.2's; the experiment used 24).
Measures per map: changed pixels ÷ all pixels and ÷ the source's ink
(non-white pixels), tiles with any change and with more than 1 %.

**Naming.** A changed pixel's *kind* is `"<from> → <to>"`: the layer on
top there in the source drawing, then in the candidate. Layers are read
from a second raster per order, the *paint image*: the same stream with
every (row, pass kind, symbol) in its own colour (`paintStream`: id + 1
as 24-bit RGB, ids rising with the canonical sort key so the painter's
order is kept) on black, rasterised by resvg with `crispEdges`
(`rasterisePaints`; every pixel decodes to one paint or nothing).
Naming by paint rather than by the visible colour keeps rows that share
an ink apart (a split colour, one black serving buildings and dots) —
the experiment's naming by exact colour named about a third of
puit-de-laven's changed pixels. In order, a pixel takes the first of:

1. the two top layers when they differ (`viewKind`);
2. where both orders have the same layer on top (an anti-aliased edge —
   a 0.14 mm line is under one pixel wide at 6 px/mm — over a change),
   the pair of layers on top anywhere in its 3 × 3 neighbourhood, in
   either image, whose order differs between the two stacks, named by
   the one above in the source, then the one above in the candidate;
   several: the most often seen, ties by name (`flipKind`);
3. steps 1–2 again on paint images with that shared top layer peeled
   off (`withoutRows`; `namePeeled`, one pair of images per distinct
   set of peeled layers, never the same layer twice), up to three
   layers deep: a change under a black
   area that covers all but a sliver of the pixel (Club-2026: the road
   outline and the paved brown swapped under a building);
4. (I4) steps 1–2 on the full paint images drawn at `FINE_FACTOR` (3) ×
   the resolution, drawn only for a tile with a pixel left: the most
   frequent kind among the sub-pixels of the pixel's block and a margin
   of one sub-pixel round it, ties by name (`fineKindOf`) — a change
   under a pixel no layer covers the centre of, a hairline or a sliver
   of an edge (the crisp paint image at 6 px/mm showed one layer over
   the paper there, in both orders);
5. the most frequent kind of its changed 8-neighbours (ties by name),
   else `(unattributed)`.

Kinds sum to the changed pixels; the *named share* is the part not
`(unattributed)`.

**Naming with `layers`.** A source row may become several layers, so
both drawings are named in the *candidate's* layers. A *joint document*
(`jointDocument`) has one stack row per pair (source row, candidate row)
of the two documents' colour references, zipped symbol by symbol and
reference by reference, canonical entries through the palette ids both
stacks carry; drawn over the tile, each of its passes says where it
draws in either order (`paintCorrespondence`). A source paint (row, pass
kind, symbol) takes the name of the candidate layer most of its passes
draw in (`correspondingNamer`; a paint the tile lacks, its row's lowest
layer); a layer's place in the source drawing, for step 2, is the source
row most of its passes come from; step 3 peels a source layer by its
passes (`withoutPasses`), not by its row. With `permutation` each order
names its own rows, as in I1.

A layer's **name** is its roles joined by `+` in palette order
(`brown50-paved+brown50-road`: a multi-role colour shows as one in the
permutation; a layered row has at most one), else
`none:<colour class>:<kind>` (`none:white:area`, `none:purple40:area`);
repeats in one stack get `#2`, `#3`… in stack order; a paint drawn by a
graphic object's synthesised symbol (`origin: "graphic"`,
`map-import.md` §3.2) is prefixed `graphic:`. Names never carry the
map's own colour names, so standard output and this section can quote
them; `summary.json`, which lists the map's unidentified colours by
name, stays in `.local/`.

**Classes.** Every kind is one of `multi-role` (one source colour, several
roles, one place), `mask` (a white that is no palette white),
`layout` (logos, frame bars: graphic objects), `deviation-kept`,
`deviation-dropped` (a pair of roles the source orders against the
palette, kept or dropped by the candidate, `map-symbols.md` §9.3),
`no-role`, `residue` (I4: unattributed pixels, below) — or
`unclassified`. The classification is a JSON file
(`--classes`, `parseClassification`):

```json
{ "version": 1, "rules": [
  { "map": "sprint", "from": "black50-building", "to": "brown30-paved+brown30-road", "class": "multi-role", "note": "…" },
  { "from": "*", "to": "graphic:*", "class": "layout" },
  { "from": "*", "to": "*", "class": "deviation-dropped", "reported": true },
  { "map": "nacka", "from": "(unattributed)", "to": "(unattributed)", "class": "residue", "maxPx": 46, "note": "…" } ] }
```

— rules in file order, the first whose `map` (absent: every map),
`from`, `to` and `maxPx` (absent: any size; else the kind's pixels on
the map at most) match decides (`classify`); `from` and `to` are a layer
name, `*` (any layer) or a prefix ending in `*` (`graphic:*`: every
graphic object's paint) (`namePatternMatches`).

**Reported rules** (I4; decided overnight on the user's standing
instruction, 2026-11-17, for review). A rule with `"reported": true` matches only
where the layered candidate's own report gives the kind that class
(`reportedClasses`, from the stack's layers and its report): `layout`,
`mask` or `no-role` when either layer's row stands by the source order
for that reason (`sourceOrdered`); `deviation-dropped` when both are
palette-placed rows of two roles the report lists as a dropped
deviation — by default, or blocked — and the kind's `from` row is the
higher source colour, so the source drew it on top. No report (the
permutation) matches no reported rule. A kept deviation has no reported
class: its rows draw in the source's order, so a change between them
fails the gate.

**Residue** (I4; decided overnight on the user's standing instruction,
2026-11-17, for review). `(unattributed)` is classified only by a `residue`
rule, which must name the map, `(unattributed)` as `from` and `to`, and
a `maxPx` (the schema rejects anything else); no pattern classifies it.
A map's residue over its cap fails the gate, so it can only be what was
looked at.

The corpus's file is committed as `scripts/colour-order-classes.json`
by I4 (decided overnight on the user's standing instruction, 2026-11-17,
for review: maps by their spec labels, layers by palette id): the four
reported rules (`layout`, `mask`, `no-role`, `deviation-dropped`) and a
`residue` rule per map with unattributed pixels, capped at the I4
measurement (the table below). The labels are the spec's: `sprint`,
`club-full`, `club-2026`, `crop-a`, `crop-b`, `mortsjon`, `erstavik`,
`puit-de-laven`, `ski-o`, `nacka` (the `--maps` file that gives them
paths stays in `.local/`). Rules that classified nothing on a map are
listed (a stale or mistyped rule). The run prints per map the kinds with
their class and the **unclassified share** (unclassified ÷ changed
pixels) — the gate I4 and I5 close (0 on the ten maps).

Each run also writes `classes.suggested.json` per map, a hint never
counted (`suggestClass`): `layout` when a `graphic:` paint is involved,
`multi-role` when either layer has several roles, `mask` for a white
without a role, `no-role` for another layer without one,
`deviation-dropped` when both have one role and the palette puts the
candidate's layer above the source's. A person reads the images and
writes the classification — from I4 the reported rules, which the
stack's report confirms kind by kind, and a residue rule per map for
what was looked at; the suggestion is where to start.

**Census** per map (`colourCensus`): colours, used colours, used
colours without a palette entry and the objects drawn in them, rows
serving several roles with their uses, symbols with objects by match
state (`auto` / `suggested` / `unmatched` / no match record; reviewed;
graphic), the rows of lower and upper purple.

**Invocation.**

```
node scripts/measure-colour-order.mjs <file|dir>… [--maps <tsv>] [--out <dir>] [--classes <json>]
     [--candidate layers|permutation] [--tile-mm 60] [--px-per-mm 6] [--tolerance 16]
     [--worst 3] [--worst-px-per-mm 12] [--window x0,y0,x1,y1]
```

`--maps` reads `<label>\t<path>` lines (a bare path is labelled by its
file name; blank lines and `#` comments skipped); labels name the output
directories. `--out` must lie under a `.local/colour-order/` directory
(default `<repo>/.local/colour-order/`); per map it writes
`<label>/summary.json` (settings, census, the layered stack's summary —
rows, split colours by their roles, no-role and unreferenced rows,
inserted and aliased ids, and from I4 the source-ordered rows by reason
(and how many stand above lower purple), the moved parts' rows, the
deviations kept, implied, blocked and dropped — measures, kinds with class and suggestion,
the class totals, unused rules, the worst tiles),
`tiles.json` (per tile: paper bounds, pixels, changed, unattributed),
`classes.suggested.json` and `worst-<n>-tile-<x>-<y>.png` — source |
candidate | difference (red where changed, the source at a quarter of
its contrast elsewhere) at `--worst-px-per-mm` — and `run.json` for the
run. `--window` (paper mm, y-up) keeps the tiles it meets; a map it
meets no tile of is an error, not a pass. Exit 0 when every map ran —
imported, a tile in the window — and nothing is unclassified, 1
otherwise, 2 on usage errors. A map's error goes to standard error as
its message only (an importer's message may quote the map's names). The corpus and every output stay in `.local/` (AGENTS.md §12).

**Baseline (I1, 2026-11-17).** The experiment's permutation on the ten
maps of the slice (the five corpus maps, Mörtsjön, the Erstavik crop and
the three Mapper files, puit-de-laven the CC0 one), importers `ocad-18` /
`omap-11`, default settings, nothing classified. Pixels and ink are
whole-map totals over 60 mm tiles at 6 px/mm.

| Map | Library | Tiles: changed / > 1 % | Changed px | ÷ pixels | ÷ ink | Named | Suggested: multi-role / deviation-dropped / mask / no-role / layout / none / unattributed | Colours: used / no entry (uses) / multi-role | Symbols used: auto / suggested / unmatched / no match |
|---|---|---|---|---|---|---|---|---|---|
| Sprint | ISSprOM2019-2 (iof2024) | 56: 30 / 23 | 176 218 | 2.428 % | 8.355 % | 97.7 % | 97.4 / 0.1 / 0.0 / 0.1 / 0.0 / 0.0 / 2.3 % | 33 of 46 / 1 (6 of 13 672) / 2 | 86: 54 / 14 / 18 / 0 |
| Club-full | ISOM2017-2 (iof2022) | 460: 107 / 67 | 275 747 | 0.463 % | 2.933 % | 97.7 % | 72.0 / 25.6 / 0.0 / 0.0 / 0.0 / 0.0 / 2.3 % | 55 of 85 / 6 (231 of 109 633) / 1 | 268: 95 / 57 / 113 / 3 |
| Club-2026 | ISOM2017-2 (iof2022) | 48: 41 / 21 | 86 100 | 1.384 % | 2.752 % | 98.0 % | 83.7 / 13.7 / 0.0 / 0.6 / 0.0 / 0.0 / 2.0 % | 43 of 72 / 4 (95 of 48 157) / 2 | 202: 77 / 45 / 80 / 0 |
| Crop-A | ISOM2017-2 (iof2022) | 6: 5 / 2 | 5 061 | 0.651 % | 1.390 % | 97.8 % | 70.3 / 27.5 / 0.0 / 0.0 / 0.0 / 0.0 / 2.2 % | 25 of 158 / 1 (2 of 5 058) / 1 | 97: 58 / 16 / 23 / 0 |
| Crop-B | ISOM2017-2 (iof2022) | 9: 5 / 0 | 2 678 | 0.230 % | 1.006 % | 98.5 % | 66.1 / 32.3 / 0.0 / 0.0 / 0.0 / 0.0 / 1.5 % | 27 of 127 / 1 (2 of 3 076) / 2 | 99: 61 / 15 / 19 / 4 |
| Mörtsjön | ISOM2017-2 (iof2022) | 45: 10 / 0 | 3 398 | 0.058 % | 0.225 % | 99.6 % | 0.0 / 99.6 / 0.0 / 0.0 / 0.0 / 0.0 / 0.4 % | 24 of 55 / 0 (0 of 15 075) / 0 | 112: 64 / 19 / 29 / 0 |
| Erstavik crop | ISOM2017-2 (iof2022) | 42: 23 / 9 | 30 168 | 0.554 % | 2.014 % | 98.5 % | 77.9 / 20.7 / 0.0 / 0.0 / 0.0 / 0.0 / 1.5 % | 27 of 127 / 1 (11 of 18 271) / 2 | 134: 72 / 27 / 35 / 0 |
| puit-de-laven (Mapper, CC0) | ISOM2017-2 (iof2022) | 16: 10 / 0 | 957 | 0.046 % | 0.075 % | 99.8 % | 99.6 / 0.2 / 0.0 / 0.0 / 0.0 / 0.0 / 0.2 % | 16 of 43 / 1 (1 of 1 090) / 4 | 45: 33 / 7 / 5 / 0 |
| ski-O map (Mapper) | ISOM2017-2 (iof2022) | 20: 16 / 12 | 91 175 | 3.518 % | 11.984 % | 98.9 % | 5.4 / 93.5 / 0.0 / 0.0 / 0.0 / 0.0 / 1.1 % | 25 of 63 / 0 (0 of 7 097) / 1 | 127: 56 / 31 / 37 / 3 |
| Nacka exercise map (Mapper) | ISOM2017-2 (iof2022) | 460: 107 / 65 | 260 927 | 0.438 % | 2.778 % | 97.7 % | 75.5 / 22.2 / 0.0 / 0.0 / 0.0 / 0.0 / 2.3 % | 51 of 89 / 4 (66 of 107 090) / 1 | 267: 90 / 62 / 114 / 1 |

Over the ten maps 932 429 of 150 595 200 pixels change (0.619 %; 3.14 %
of 29 710 294 inked), 2.1 % of them unattributed. Every named kind has
a suggestion. Exit 1 on every map: nothing is classified yet, by
design. Reading the table:

- **One colour, several roles** is most of the change on eight maps, as
  the experiment found: the brown 50 % (30 % on Sprint) serving paved
  area and road infill ranks at the road infill's place and buries the
  road outlines (`black-road-outline → brown50-paved+brown50-road` is
  the largest kind on Club-2026, Club-full, Crop-B, Sprint and the Nacka
  map), on Sprint also the buildings and canopy. I3's split removes this
  class.
- **Deviations dropped**: road infill and paved brown over the contour
  brown (`brown50-road → brown100-line` on Club-2026, Club-full and the
  Nacka map), the class answer 2 keeps by default (I4); all of
  Mörtsjön's change.
- The ski-O map's largest kinds start from its mask white, which §9.1
  identifies as `white-over-green-brown`; the hint therefore says
  `deviation-dropped` where a person classifies `mask` (I4's
  source-order rule).
- **Against the experiment**: before proxy-drawn objects kept their row
  (above), the tool reproduced the experiment's changed pixels at
  `--tolerance 24` on every map within 0.14 % (puit-de-laven 742, Crop-A
  4 513 and Mörtsjön 3 189 exactly; the rest by the 5 mm tile margin).
  Keeping the proxies' row removes the experiment's artefact where
  graphic objects without IR exist: Crop-B 23 247 → 2 678 changed pixels
  at the default tolerance (its largest kind had been black frame bars
  turned yellow), the ski-O map 94 009 → 91 175, the Nacka map 267 473 →
  260 927; Club-full gains 195.

**I3: the layered stack (2026-11-18).** The same ten maps, importers
and settings, candidate `layers` (`map-symbols.md` §9.3 "Layers": no
source-order exceptions or deviations yet, a use with no role placed by
kind), nothing classified. Kinds are named in the layered stack's layers
(one role each), so the permutation's `multi-role` suggestion cannot
occur. "Road outline" is the share of changed pixels in kinds from
`black-road-outline` (any `#n`) to a brown road or paved layer.

| Map | Tiles: changed / > 1 % | Changed px (I1 → I3) | ÷ pixels | ÷ ink | Named | Suggested: deviation-dropped / mask / no-role / layout / multi-role / none / unattributed | Road outline | Layers: rows / split colours / no-role rows / unreferenced |
|---|---|---|---|---|---|---|---|---|
| Sprint | 56: 27 / 5 | 176 218 → 19 759 | 0.272 % | 0.937 % | 90.4 % | 87.4 / 0.2 / 2.8 / 0.0 / 0.0 / 0.0 / 9.6 % | 78.1 % | 66 / 16 / 7 / 3 |
| Club-full | 460: 114 / 57 | 275 747 → 224 660 | 0.377 % | 2.390 % | 97.2 % | 94.5 / 0.4 / 2.2 / 0.0 / 0.0 / 0.0 / 2.8 % | 75.4 % | 103 / 14 / 22 / 0 |
| Club-2026 | 48: 45 / 19 | 86 100 → 79 516 | 1.278 % | 2.541 % | 97.6 % | 94.2 / 0.2 / 3.2 / 0.0 / 0.0 / 0.0 / 2.4 % | 81.7 % | 87 / 13 / 15 / 0 |
| Crop-A | 6: 6 / 2 | 5 061 → 4 142 | 0.533 % | 1.137 % | 97.4 % | 97.4 / 0.0 / 0.0 / 0.0 / 0.0 / 0.0 / 2.6 % | 76.9 % | 171 / 10 / 7 / 116 |
| Crop-B | 9: 5 / 0 | 2 678 → 1 977 | 0.169 % | 0.742 % | 97.9 % | 97.9 / 0.0 / 0.0 / 0.0 / 0.0 / 0.0 / 2.1 % | 70.7 % | 141 / 12 / 8 / 85 |
| Mörtsjön | 45: 24 / 5 | 3 398 → 27 009 | 0.463 % | 1.790 % | 97.4 % | 81.3 / 16.1 / 0.0 / 0.0 / 0.0 / 0.0 / 2.6 % | 80.9 % | 72 / 12 / 6 / 14 |
| Erstavik crop | 42: 24 / 7 | 30 168 → 25 707 | 0.472 % | 1.716 % | 98.2 % | 96.2 / 2.0 / 0.0 / 0.0 / 0.0 / 0.0 / 1.8 % | 78.1 % | 140 / 11 / 7 / 85 |
| puit-de-laven (Mapper, CC0) | 16: 13 / 0 | 957 → 2 293 | 0.111 % | 0.179 % | 99.9 % | 99.7 / 0.0 / 0.2 / 0.0 / 0.0 / 0.0 / 0.1 % | 0.0 % | 54 / 9 / 3 / 2 |
| ski-O map (Mapper) | 20: 16 / 12 | 91 175 → 90 544 | 3.493 % | 11.901 % | 99.1 % | 91.5 / 1.9 / 5.8 / 0.0 / 0.0 / 0.0 / 0.9 % | 0.3 % | 89 / 19 / 15 / 7 |
| Nacka exercise map (Mapper) | 460: 114 / 60 | 260 927 → 234 966 | 0.394 % | 2.501 % | 97.3 % | 95.3 / 0.1 / 1.9 / 0.0 / 0.0 / 0.0 / 2.7 % | 72.9 % | 107 / 14 / 17 / 9 |

Over the ten maps 710 573 pixels change (I1: 932 429; 0.472 % of all,
2.39 % of ink), 2.6 % of them unattributed (18 711 px; I1: 19 605).
Exit 1, nothing classified. Reading the table:

- **The multi-role class is gone.** Every split colour is drawn on one
  layer per role. The buildings and canopy that the permutation buried
  under the paved brown come back: kinds from `black50-building` or
  `black20-canopy` to another layer, Sprint 10 103 → 63 px (Club-2026
  36 → 40, Club-full and the Nacka map 0 in both).
- **The road outlines are the largest kind left** (71–82 % of the change
  on eight of the ten maps), now for another reason: the
  roads there are drawn *inside out* (§9.3 "Roles", Q3). Their symbol is
  a brown 50 % *main* line as wide as the distance between the black side
  borders' centres, with the borders over it; the source draws the black
  row above the brown, and on the layers the main's `brown50-road` ranks
  above the borders' `black-road-outline` and covers the inner half of
  each border. The permutation buried the same outlines under the whole
  multi-role brown. On Mörtsjön, which has no multi-role colour, the
  permutation kept its black on top and the layers do not: its change
  rises 3 398 → 27 009 px, 81 % of it road outlines. Row I4's (the
  general inside-out case, fixed against this harness).
- **Deviations the layers drop** are the rest of the named change:
  road infill and paved brown under the contours (answer 2 keeps them,
  I4), and pairs the permutation hid by ranking a split colour at its
  highest role — puit-de-laven's second blue serving lakes, now under
  the contour brown (957 → 2 293 px), its cultivated-land black under
  the contours and the greens.
- **The ski-O map** is unchanged in size (91 175 → 90 544): its mask
  white, §9.1's `white-over-green-brown`, sinks to that row's place
  (`white-over-green-brown#4 → blue100-area#3` and the contours, black
  and track rows) — I4's source-order rule for masks.
- Sprint's named share falls to 90.4 % only because its change shrank:
  1 895 unattributed pixels against 4 091 in I1.

The run took 20 min (Club-full and the Nacka map 7.5 and 6.5 min).

**I4: own order, deviations, source order (2026-11-18).** The same ten
maps, importers and settings, candidate `layers` with I4's exceptions
(`map-symbols.md` §9.3 "Own order", "Deviations", "Source order"; the
deviations at their defaults), classified by the committed
`scripts/colour-order-classes.json`, labels as there. **The gate holds:
0 of 64 014 changed pixels unclassified, exit 0.**

| Map | Tiles: changed / > 1 % | Changed px (I3 → I4) | ÷ pixels | ÷ ink | Named | Classes: deviation-dropped / mask / no-role / layout / residue | Unclassified |
|---|---|---|---|---|---|---|---|
| Sprint | 56: 26 / 0 | 19 759 → 1 044 | 0.014 % | 0.049 % | 99.4 % | 1 038 / 0 / 0 / 0 / 6 | 0 |
| Club-full | 460: 88 / 4 | 224 660 → 17 684 | 0.030 % | 0.188 % | 99.8 % | 16 002 / 1 590 / 63 / 1 / 28 | 0 |
| Club-2026 | 48: 36 / 0 | 79 516 → 821 | 0.013 % | 0.026 % | 99.9 % | 814 / 0 / 6 / 0 / 1 | 0 |
| Crop-A | 6: 5 / 0 | 4 142 → 416 | 0.053 % | 0.114 % | 99.8 % | 415 / 0 / 0 / 0 / 1 | 0 |
| Crop-B | 9: 5 / 0 | 1 977 → 214 | 0.018 % | 0.080 % | 99.5 % | 213 / 0 / 0 / 0 / 1 | 0 |
| Mörtsjön | 45: 15 / 0 | 27 009 → 75 | 0.001 % | 0.005 % | 100.0 % | 75 / 0 / 0 / 0 / 0 | 0 |
| Erstavik crop | 42: 21 / 0 | 25 707 → 1 677 | 0.031 % | 0.112 % | 99.7 % | 1 672 / 0 / 0 / 0 / 5 | 0 |
| puit-de-laven (Mapper, CC0) | 16: 13 / 0 | 2 293 → 2 288 | 0.110 % | 0.179 % | 100.0 % | 2 288 / 0 / 0 / 0 / 0 | 0 |
| ski-O map (Mapper) | 20: 15 / 5 | 90 544 → 12 826 | 0.495 % | 1.686 % | 100.0 % | 12 826 / 0 / 0 / 0 / 0 | 0 |
| Nacka exercise map (Mapper) | 460: 94 / 5 | 234 966 → 26 969 | 0.045 % | 0.287 % | 99.8 % | 25 270 / 1 590 / 63 / 0 / 46 | 0 |

| Map | Layers: rows / split colours | Source order: no-role / graphic / mask (above lower purple) | Own-order rows | Deviations: kept / implied / blocked / dropped | Kept by default |
|---|---|---|---|---|---|
| Sprint | 67 / 17 | 8 / 0 / 1 (7) | 3 | 2 / 1 / 0 / 43 | `black-road-outline>brown100`, `brown30-road>brown100` |
| Club-full | 110 / 16 | 22 / 3 / 1 (10) | 3 | 3 / 14 / 0 / 180 | `brown50-road`, `black-road-outline`, `brown50-paved` `>brown100-line` |
| Club-2026 | 90 / 14 | 15 / 0 / 0 (8) | 4 | 3 / 5 / 0 / 138 | the same three |
| Crop-A | 175 / 11 | 21 / 0 / 1 (13) | 2 | 2 / 1 / 0 / 59 | `black-road-outline`, `brown50-road` `>brown100-line` |
| Crop-B | 145 / 13 | 16 / 1 / 1 (9) | 2 | 2 / 1 / 0 / 45 | the same two |
| Mörtsjön | 74 / 14 | 8 / 0 / 0 (4) | 2 | 3 / 6 / 0 / 41 | the same three as Club-full |
| Erstavik crop | 144 / 12 | 16 / 0 / 1 (7) | 2 | 2 / 2 / 0 / 71 | the same two as Crop-A |
| puit-de-laven | 57 / 10 | 3 / 0 / 0 (2) | 4 | 0 / 0 / 0 / 25 | — |
| ski-O map | 92 / 20 | 16 / 0 / 3 (9) | 4 | 0 / 0 / 0 / 67 | — |
| Nacka exercise map | 111 / 16 | 19 / 0 / 1 (5) | 3 | 3 / 11 / 0 / 184 | the same three as Club-full |

Over the ten maps 64 014 pixels change (I3: 710 573; 0.043 % of all,
0.22 % of ink): deviation-dropped 60 613, mask 3 180, no-role 132,
layout 1, residue 88 (0.14 % of the change; I3 left 2.6 % unattributed),
unclassified 0. Reading the tables:

- **The road outlines are gone** (own order): Mörtsjön 27 009 → 75 px,
  Club-2026 79 516 → 821, Erstavik 25 707 → 1 677. What remains on the
  OCAD club maps is small dropped deviations: the contour brown and
  green points over each other, a black screen or yellow area the table
  draws over black.
- **What is left is the palette's order where the table had another**
  (deviation-dropped, every kind a deviation the report lists): on
  Club-full and the Nacka map yellow areas the table draws over
  cultivated-land dots, the black screen and a lake (about 6 000 px
  each); on the ski-O map the ski green over contours and black
  (7 736 and 4 586 px), which §12.3 puts there on purpose; on
  puit-de-laven its second blue under the contours (1 682 px).
- **The ski-O map's mask holds** (90 544 → 12 826 px): its white,
  by hint `white-over-green-brown`, stands by the source order over its
  black, contours and ski green. Club-full's and the Nacka map's `mask`
  kind (1 590 px each) is a white at the bottom of their table that the
  source draws over a one-object lake: the gap that fits the source
  best puts it under that lake.
- **Residue**: 88 isolated pixels no paint image names even at 3× —
  a feature finer than a third of a pixel, or a change at a tile's edge
  caused just outside it (probed on Sprint, Erstavik and Club-2026).
  Each map's residue rule is capped at its count here.
- puit-de-laven is unchanged in size: its change is dropped deviations
  that I3 already showed; its library-drawn points and cultivated dots,
  which the source stack draws in another colour, now carry their
  colour's place (the carrier rule, `map-symbols.md` §9.3 "Palette ids")
  and so are named as the deviations they are.

The run took 8 min (Club-full and the Nacka map 2.6 and 3.2 min: fewer
tiles change, so fewer paint images).

**I5: the importer builds the stack (2026-11-18).** The same ten maps
and settings, `ocad-19` / `omap-12`, the candidate the importer's own
`iof` import (`importedCandidate`), the source the `source` import,
`scripts/colour-order-classes.json` unchanged. **The gate holds: 0 of
64 014 changed pixels unclassified, exit 0** — and every map's changed
pixels and classes are I4's to the pixel (the first table above), so
the importer builds exactly the stack the harness built at I4. What I5
adds to the stack draws nothing a map draws: rows carrying identified
palette ids (`map-symbols.md` §9.3 "Palette ids"; Sprint 67 → 69 rows,
Club-full 110 → 113, Club-2026 90 → 93, ski-O map 92 → 94, Nacka map
111 → 114, the others unchanged); and a library-drawn symbol now counts
on its entry's palette ids, which leaves every map's kept, implied,
blocked and dropped deviations as in the second table. The run took
7 min.

A run of the ten maps takes 8 to 20 min on the development machine,
by how much changes (Club-full and the Nacka map, 460 tiles each, the
longest); paint images, peeling and the 3× fine view are drawn only for
tiles that changed, the fine view only for a tile with a pixel left.

Tests:

| Test | Asserts |
|---|---|
| `packages/api/src/render/__tests__/colour-order-diff.test.ts` | the tolerance boundary and ink count; the side-by-side image; the tile grid, a window, ranking; paint ids rising with the sort key, the id colour round trip, crisp paint images on five contract fixtures (every pixel decodes, the reference raster's grid), an overlap of one ink named by the upper row; `viewKind`, `flipKind` (a thin line over a swapped pair, no flip, the paper and a missing layer taking no part), `sharedTop`, `withoutRows`, `namePeeled` (a swap under a shared top layer, one view per peel set, no layer peeled twice, the depth limit), `nameChanges` (neighbour vote, unattributed, counts); layers (roles, uses, kind, class, names, `#n`, `graphic:`); the permutation (palette rank, roleless areas and others, ties), `permuteStack` re-indexing, `inverseOrder`, the proxies' row (`permutedRenderOptions`) and its effect — an IR-less object on an encoded document drawn in the same colour in both orders, and not without the options; the census; `parseClassification`, `classify` (first match, map scope, `*`, a `graphic:*` prefix, unattributed never classified, unused rules, share), `suggestClass`; the layered candidate on an encoded stage 7 document — `sourceTableOf`, one brown split into paved area and road infill, the road re-indexed per reference, one role per layer name, `rowOfAligned` and the proxies' row, every object in the same ink in both orders, a symbol drawing in an inserted row rejected; `jointDocument` and `paintCorrespondence` (the brown's paints to the paved and the road layer, layers back to their source rows, mismatched symbol tables rejected), `correspondingNamer` (`graphic:` too), `withoutPasses`; I4: `namePeeled`'s fine view (a pixel no view tells named by its sub-pixels, the fine view drawn only when a pixel is left, a fine view of the wrong size rejected), `fineKindOf` (block and margin, ties by key); `classify` with `residue` (only `(unattributed)`, only by a rule naming the map and `maxPx`, over the cap or on another map unclassified, never a named kind; the schema's refusals), `maxPx`, `reported` rules and `reportedClasses` (a dropped deviation in the source's direction only, not a kept one, a mask, a graphic row, an unknown layer, no report) |
| `scripts/__tests__/measure-colour-order.test.mjs` (`pnpm test:scripts`) | on `docs/screenshots/fixtures/puit-de-laven.omap` from a `--maps` file, candidate `layers` by default: exit 1 with nothing classified, kinds summing to the changed pixels, named share ≥ 95 %, a change between two palette layers, no `+`-joined name; the layered summary (more rows than colours, split colours, both course purples inserted) and its standard-output line; `--candidate permutation` still runs, with a multi-role name; the census, tiles, suggestions and worst images written, none of the map's colour names on standard output; a window over one tile classified by a file → exit 0; I4: the layered summary's source-order, own-order and deviation counts and their standard-output lines; the committed `scripts/colour-order-classes.json` classifies every change on the CC0 map from the candidate's report → exit 0; a window that meets no tile → exit 1, the reason on standard error; usage errors (no maps, `--out` outside `.local/colour-order/`, an unknown candidate, a bad window or tile size, an unknown option, a missing file, a bad rule) → exit 2 |

## 7. Where things live

| Path | Contents |
|---|---|
| `packages/shared/src/render/pass-stream.ts` | types, flags, sort, builder |
| `packages/shared/src/render/path.ts` | path walkers, Bézier split, arc length, hatch lines |
| `packages/shared/src/render/stream-json.ts` | JSON projection, `diffPassStreams` |
| `packages/shared/src/render/reference-svg.ts` | SVG serialiser (oracle, stage 1) |
| `packages/shared/src/render/symbol.ts` | `RenderSymbol` IR, Zod schemas, colour stack types |
| `packages/shared/src/render/measure.ts` | arc length, sections, gap intervals |
| `packages/shared/src/render/dash.ts` | OCAD / OMAP dash layout |
| `packages/shared/src/render/placement.ts` | glyphs along lines |
| `packages/shared/src/render/pattern.ts`, `geometry.ts` | pattern grids, inclusion, offsetting, `strokeOutline()` (tapers) |
| `packages/shared/src/render/glyph-table.ts` | IR glyph → `GlyphMesh`, registry |
| `packages/shared/src/render/truetype.ts`, `text.ts` | font reader, shaping |
| `packages/shared/src/render/symbolise.ts` | the stage |
| `packages/shared/src/render/filter-region.ts` | filter regions: selection, exact and fast predicates, `filterStream` / `applyFilterRegions` (§4.11) |
| `packages/shared/src/render/__fixtures__/` | contract fixtures (`streams/`), library fixtures (`library/`, snapshots in `streams/library/`), course and filter scenes (`course/`, `filter/`, snapshots in `streams/course/`, `streams/filter/`), pilot symbols, `pilot-scene.ts`, `golden.ts` (scene list, frame) |
| `packages/shared/src/render/proxy-symbols.ts` | per-kind proxy symbols for the render bridge |
| `packages/shared/src/render/__fixtures__/course/` | course scenes (C0; snapshots in `streams/course/`) — the layer itself is `packages/shared/src/course/`, `docs/course-layer.md` |
| `packages/shared/fonts/` | bundled Liberation faces |
| `packages/api/src/render/reference-raster.ts` | resvg rasterisation, `sampleAt`, `diffImages`, `encodePng` |
| `packages/shared/src/render/swatch.ts` | symbol swatch scene (§5.1.1) |
| `packages/shared/src/print/operators.ts` | PDF backend: pass → content-stream operators, layer matrix, clips (§5.3) |
| `packages/shared/src/print/{colour,fonts,writer}.ts` | colour modes, font programs, `PdfWriter` (`docs/course-print.md` §1–3) |
| `packages/api/src/render/previews.ts` | swatch and thumbnail PNGs (`docs/map-storage.md` §4.5) |
| `packages/api/src/render/fonts.ts` | bundled-font loader for the server backends |
| `packages/api/src/render/golden.ts`, `scripts/render-golden.ts` | golden PNG generation (`pnpm --filter @oxygen/api golden:render`) |
| — | corpus parity against the legacy tiles (§6.4; `render/parity.ts` and `scripts/measure-parity.mjs` went in E4a) |
| `packages/api/src/render/colour-order-diff.ts`, `scripts/measure-colour-order.mjs` | colour-order parity (§6.5): paint images, naming, layers, the layered candidate (`layeredCandidate`, the joint document) and the permutation, census, classification; the corpus run |
| `packages/shared/src/render/ocad-objects.ts` | dev-only: `ocad2geojson` objects → `RenderObject`s (pilot / envelope modes); `ocadFlags` for the importers |
| `packages/web/src/map-gl/prepare.ts` | WebGL2 backend, geometry builders: flattening, indexed strips, even-odd earcut; the per-pass fan path |
| `packages/web/src/map-gl/mesh-atlas.ts` | glyph meshes in one float texture (vertex pulling) |
| `packages/web/src/map-gl/text-atlas.ts` | the MSDF text atlas: page ranges and selection, glyph lookup, glyph table, halo clamp (§5.2 "Text atlas") |
| `packages/web/src/map-gl/text-atlas-build.ts`, `packages/web/scripts/generate-text-atlas.ts`, `packages/web/scripts/text-atlas/Dockerfile` | atlas generation (`pnpm text-atlas:generate`, §4.10) |
| `packages/shared/fonts/msdf/` | the committed text atlas pages |
| `packages/web/src/map-gl/buckets.ts` | cells, large bucket, per-part preparation and range table, visible set, clip groups, zoom gate, LRU |
| `packages/web/src/map-gl/arena.ts` | vertex arenas: free list, growth by copy |
| `packages/web/src/map-gl/worker.ts`, `worker-entry.ts` | the worker's message handler and its binding |
| `packages/web/src/map-gl/engine.ts` | main-thread controller: worker transport, residency, visible-set rebuilds, the one course request in flight (F20), the document hit-test and the edit part (G5), the 3D frame (H6: `setTerrain`, `renderTerrain`, settling, the drape's budget) |
| `packages/shared/src/render/hit-test.ts` | `hitTest`, `hitTestStreams` on the symbolised shape (§5.5) |
| `packages/web/src/map-gl/view.ts` | the arena path's model → clip matrix, `RenderTarget`, `loupeView` |
| `packages/web/src/map-gl/renderer.ts` | WebGL2 backend, GPU stage (arena programs and draw loop; per-pass path, stencil, supersampling; the loupe's inset target and circle composite; the drape's tiled render target and textures and the terrain program on its context, H6; GPU timer) |
| `packages/web/src/pages/dev/MapGlFixturePage.tsx` | dev-only golden page `/dev/map-gl` |
| `packages/web/src/pages/dev/MapGlDocPage.tsx` | dev-only whole-document page `/dev/map-gl-doc` (load report, bench) |
| `packages/web/src/map-gl/terrain/` | the terrain (§5.6): `camera.ts` + `mat4.ts` (perspective orbit camera, rays), `mesh.ts` (chunked grid, levels, skirts, culling, no-data fill; `prepareTerrain` for the worker), `pick.ts`, `shade.ts`, `program.ts` (`TerrainRenderer`, one or two drapes), `footprint.ts` (H6: footprint, drape layers, tiles), `lines.ts` (H8: tracks lifted onto the surface, `TerrainLines`), `synthetic.ts` (dev, bench and test fields) |
| `packages/web/src/map-gl/fixtures/course-document.ts` | the small aligned ISOM document and course request the dynamic-bucket tests and the terrain dev page share |
| `packages/web/src/pages/dev/MapTerrainPage.tsx`, `pages/dev/terrainDoc.ts`, `e2e/map-terrain.spec.ts` | dev-only terrain page `/dev/map-terrain` (synthetic fields; `doc=course`: the course fixture draped through the engine; `line=`: lines on the terrain, H8) and its browser test |
| `e2e/__golden__/map-gl/`, `e2e/map-gl-golden.spec.ts` | committed goldens and the browser comparison |
| `e2e/map-gl-doc.spec.ts` | whole-document pipeline on `e2e/test.ocd`: arena path, worker, eviction, arena = per-pass path |
| `scripts/measure-gl.mjs` | corpus measurements through `/dev/map-gl-doc` (§5.2 Measurements; `--terrain`: §5.6 "Measurements (H6)") |
| `packages/web/src/components/VectorMapLayer.tsx` | the vector base layer in `MapViewer` (§5.4): canvas, engine and worker lifecycle, status; the course layer request and its replies; the editor's loupe; Map mode's document objects (`mapObjects`, G5); the 3D frame (`heightField`, `terrain`, H7; `terrainLines`, H8) |
| `packages/web/src/lib/course-layer-request.ts` | the viewer's course-layer input (§5.4 "Overlay", `course-layer.md` §5) |
| `packages/web/src/components/MapViewer.tsx` | the host: viewport state, gestures, the SVG UI layer, editor hit-testing; the 3D mode's state and the projected UI layer (H7) |
| `packages/web/src/components/Map3d.tsx`, `lib/map-3d.ts`, `lib/map-3d-field.ts`, `hooks/useHeightField.ts` | the 3D mode (§5.4 "3D mode", H7): toggle, exaggeration, notice and pointer surface; offer, camera, projector and gesture reducer; the field padded and coarsened; the field's loader. H11: the surface choice and the DEM attribution (`Map3d.tsx`), `terrain3dSurfaces` / `defaultSurface` / `fieldAttribution` (`lib/map-3d.ts`), three fields in memory |
| `packages/web/src/lib/map-viewport.ts` | the paper viewport model (§5.4 "Viewport"), `glView` |
| `packages/web/src/lib/vector-map.ts` | paper frame, bounds, colours, proxy colours, budget from a document header |
| `packages/web/src/lib/map-document-cache.ts`, `map-fonts.ts` | document, font and text atlas loading for the viewer (`docs/map-storage.md` §7.1) |
| `packages/web/src/lib/map-import-view.ts`, `components/MapImportState.tsx` | the import state of a map without a pinned document (§5.4 "Selecting the layer") |
| `e2e/map-vector-layer.spec.ts` | the vector layer in the viewer |

The shared module is exported as a namespace: `import { render } from
"@oxygen/shared"` → `render.PassStream`, `render.passStreamFromJson`, …
(namespaced to keep `Bounds`, `Segment` etc. from colliding with
`course-maps`).

## 8. Pending in this chapter

- **Alpha: a translucent corridor band** (`docs/course-layer.md` §10.2,
  F2). `LegProps.corridor.whiteOpacity` is stored but drawn opaque: the
  band is a clip region, which removes the map wholly. A band below 1
  needs a fill with alpha over the same rings — a pass colour opacity the
  stream, the three backends and the PDF (`ca` / an ExtGState) do not
  carry yet — drawn above every map colour and below the course.

- **§5.2 filter-region limits.** All masks share one stencil bit, so
  overlapping regions of different masks are fine (each masked step marks
  only its own); nothing is capped. A stroke counts as meeting a region
  by its centre line (§4.11), so a wide line grazing a region with its
  edge only is not hidden — the setter's case is a path *in* the area.

- **§6.4 Mapper sources.** The parity tool compares OCAD files only (the
  legacy tiles read nothing else); the corpus has no Mapper map.
- **§6.4 GL in the comparison.** The tool's new side is the reference
  raster; the WebGL2 backend is held to it by §6.2 and `compare=1`, not
  by a corpus run.

- **§5.2 rebuild-free visible set.** A visible-set rebuild is linear in
  the indices in view: tens of ms for a whole club map above the zoom
  gate (frame CPU p95 11–55 ms in the laptop `fit` bench on Club-2026 /
  Club-full, against ≤ 4 ms), and 16.6 ms p95 for Club-full in source
  mode even in the dense 1× paper viewport as the pan crosses cells
  (pilot / envelope: ≤ 1.5 ms).
  `WEBGL_multi_draw` over a resident index arena (04 §6.8 point 2) drops
  the rebuild where the extension exists; the copy path stays the
  fallback.
- **§5.2 bucket preparation on dense cells.** p95 over the 04 §9 budget
  on club-density cells (measurements); the shared flattening and earcut
  dominate what is left.
- **§5.2 the patch's large-bucket cost** (G4). A changed object that
  lands in the large bucket — larger than two cells, or centred outside
  the load's grid — re-prepares the whole large bucket. Its time on
  Club-full is not measured; if it is over the 04 §9 budget, such objects
  get a bucket of their own.
- **§5.5 the snap and pick indices per patch version** (G4). A new patch
  version decodes the document again and rebuilds the index on the main
  thread (once per hash before G4). Map mode (G6) writes a version per
  gesture; its own model keeps the decoded document per hash
  (`modes/map/model.ts`), the snap and pick indices still decode per
  version (a shared main-thread copy is a follow-up, `course-editor.md`
  Pending). The worker's `sourceIndex` map is built on the first patch.
- **§5.5 patch symbols in the eyedropper** (G4; decided overnight on the
  user's standing instruction, 2026-11-13, for review). An object drawn with a
  patch symbol is not picked by symbol: a filter region stores document
  symbol indices and a patch symbol's index `S + k` moves when another
  patch symbol is added. Needs a stable symbol key in the region props
  (a `course_objects` change); regions by `all` or by colour act on such
  objects already. No patch symbol exists before G8 / G9.
- **§5.5 document objects: cost on a club map** (G5). A `hit` tests the
  passes of nine cells and the large bucket, an `edit` with a draft runs
  one `applyPatch` of patch + draft (linear in the document, as a patch
  change) and symbolises the draft's targets — not 04 §7's "< 1 ms" for a
  single object. Neither is measured on Club-full; Map mode's drags (G6,
  G7) will say whether a draft needs the targets alone re-applied.
- **§5.5 an object under edit and the hidden set** (G5). A draft's copy
  is drawn under an edit-part id, so `setHidden` and a filter region's
  `hide` or mask, which address the object's static id, leave it drawn
  and unmasked while it is edited. Map mode (G6) does not turn the course
  overprint or filter regions off for a move (its `H` is the user's), so
  a moved object under a filter region's mask is drawn unmasked while it
  is dragged and until the write is drawn; if that matters, the worker maps
  the edit part's ids back to their targets for the visible set.
- **§5.5 course objects in the edit part.** The highlight is of document
  objects; the course editor's selection rings and object outlines stay
  in the UI layer (`course-editor.md` Pending).
- **§5.2 dynamic bucket: main-thread symbolisation.** A drag re-derives
  the layer in the worker (one request in flight, the latest input next —
  F20). If D's
  editor needs lower latency, the dragged object is symbolised on the
  main thread and only it is replaced.
- **§5.4 layout objects in the viewer** — resolved by D7 for Layout
  mode (`MapViewerEditorProps.layout`, `course-layout.md` §1); Course mode
  and the read-only viewer still draw no sheet.
- **§5.4 lower purple below an area colour — resolved in C14
  (`ocad-16` / `omap-9`).** Alignment now places an inserted lower purple
  above the area colours as a group and reports what stays on the wrong
  side (`COLOUR_ORDER_CONFLICT`, `COLOUR_AREA_ABOVE_LOWER_PURPLE`;
  `map-symbols.md` §9.2, `docs/bugfix-lower-purple-under-areas.md`). A map
  whose *own* lower purple sits under area colours keeps that order, so
  the layer still draws its course under them there.
- **§5.4 legacy colour settings.** `mapMetadata.colorOverrides` and
  `northLinesBelow` (the tiles' per-map colour-stack fixes) are not
  applied to the document's stack; the document's own order (and, for
  matched symbols, the library's) is drawn.
- **§5.4 a map whose colour stack is not aligned shows no course**
  ("Fallback"; E4b removed the SVG course that drew it until then). The
  fix is a re-import with an aligned stack; there is no in-place repair
  and no course in fallback colours. E0 found no such document on prod;
  a GL fallback (the course on its own stack above the map) is the
  option if one appears.
- **§5.4 `data-ready`** marks the first view's detail only; later views
  stream in without an attribute (the engine's `whenComplete()` is there
  for a spec that needs it).
- **§5.2 glyphs outside the text atlas pages** draw nothing on the arena
  path and count `TEXT_GLYPH_NOT_IN_ATLAS`, with no outline fallback
  (user decision 2026-10-22): Greek, symbols outside the Latin ranges,
  Cyrillic when its page failed to load. (Text in a `liberation-serif` /
  `liberation-mono` family never reaches the atlas: no file ships,
  §4.10, so the stage emits no pass and warns `NO_FONT`, §4.9.) None occurs in the
  corpus. Adding a page is a range in `TEXT_ATLAS_PAGE_RANGES` and a
  `pnpm text-atlas:generate`.
- **§5.2 MSDF at small sizes.** No mipmaps: text between the 4 px skip
  and ~16 px em samples the 32 px field bilinearly (the `lib-text`
  residual of §6.2). The B-gate visual review on the phone judges it;
  a 16 px page or mipmapped field is the remedy if needed.
- **§5.2 real-phone numbers** (B0 / B-gate): the GPU columns are the
  laptop iGPU, the phone column a CPU-throttle proxy.
- **§5.2 analytic stroke anti-aliasing** (04 §6.2, §6.9): the 1-px
  feather on strokes and glyph strokes on top of MSAA. Not built in B2 —
  the arena = per-pass pixel comparison relies on both paths using MSAA
  alone; the B-gate's parity check against tiles (§6.4) is where it is
  judged.
- **§5.2 perspective cameras — the vectors themselves** (research topic
  10 §5's alternative): H6 drapes orthographic textures (§5.6 "Drape
  layers"), so cell selection already follows the camera's footprint.
  Drawing the vectors through the perspective matrix would still need a
  per-vertex screen density for the screen-only rules instead of the one
  `pxPerUm`; nothing plans it.
- **§5.6 a drape re-render is one hitch** (H6): every layer is rendered
  in the frame the camera settles in (tiles, mips) — "Measurements (H6)"
  has its time per map. Spreading the tiles over frames, or keeping the
  old drape until the new one is complete, is the remedy if the H-gate's
  phone shows the hitch.
- **§5.6 Club-full tilted close up** (H6, "Measurements (H6)"): the far
  layer sees the whole map above the zoom gate, so its detail streams for
  seconds while arrivals re-render the drape (frame p95 259 / 488 ms,
  desktop / phone profile) and residency passes the club budget by
  ~6 MB. Remedies, none built: a drape-only zoom gate higher than 2D's
  for the far layer, rendering a re-render's tiles over several frames,
  or keeping the far layer's detail out of the protected set.
- **§5.6 the tile target is outside the budget** (H6): 36 MB while a drape
  exists (4× MSAA colour + depth/stencil at 1024², and its resolve
  texture), freed with the last drape; like the canvas's own MSAA
  buffers and the loupe's target it is not counted.
- **§5.6 `heightNormals` in the worker** (H6): the field's preparation is
  off the main thread now, but still 0.2–0.6 s of worker time on a
  corpus map ("Measurements (H6)"), during which the worker prepares no
  cells.
- **§5.4 3D mode — replay on the terrain** (H8, answer 2026-11-15): no
  replay view exists in the web app (`tracks.getClassRoutes` has no
  caller), so H8 draws `gpsRoutes` only. A replay's tails would be
  `TerrainLine`s through the same `terrainLines` prop (§5.6 "Lines"),
  re-cut per time step.
- **§5.4 3D mode — blending the two surfaces** (research 10 §3, later):
  the viewer draws one field, the map's terrain or ground; a blend (the
  map's micro-relief on the DEM's absolute ground) is not built.
- **§5.4 3D mode — a DEM that finishes during a session** (H11): the
  descriptor is read once per mount (`course.mapMetadata`, `staleTime:
  Infinity`), so ground offered by a job that ends while the viewer is
  open appears at the next read (a reload, an event switch). A pending
  DEM's ground is asked for once on entering 3D, which only queues the
  job.
- **§5.4 3D mode — fitted fields in memory** (H11): a viewer keeps up
  to three fitted fields (each up to a third of the map budget) beside
  the three decoded ones, evicted in insertion order; a phone switching
  surfaces on a club map holds two of them at once. Unmeasured on the
  S1 phone.
- **§5.4 3D mode — the review's 3D line and the DEM** (H11): the import
  review's terrain line (`MapReviewPage`) still says "3D needs 80 %" from
  the plain field; with an anchored field over the gate, or ground
  (decisions 4 and 6), the viewer offers 3D the line does not mention.
- **§5.4 3D mode — UI markers behind the terrain**: no occlusion test; a
  ring or the GPS dot behind a hill is drawn over it. A depth read-back
  or a CPU line-of-sight per marker (`pickTerrain` from the eye) would
  hide it.
- **§5.4 3D mode — camera animation**: entering and leaving 3D, and the
  compass's north-up, jump; a short tween of pitch and bearing is not
  built.
- **§5.4 3D mode — the field's fitting on the main thread**: padding and
  coarsening a field (`viewerField`) runs in the page, once per field; a
  club field near the 60 M-cell cap is tens of millions of cells and may
  be a hitch of its own on entering 3D. Not measured on the corpus;
  moving it to the map worker beside `prepareTerrain` is the remedy.
- **§5.4 3D mode — measuring in 3D**: the measure tool is 2D-only (hidden
  in 3D); plan distances through `unproject` would serve it.
- **§5.6 level-of-detail popping.** A chunk changes level in one frame
  (no geomorphing), and coarse levels point-sample the heights at their
  vertices rather than filtering them; with the normal map carrying the
  light, neither showed on the dev page's noise field (auto LOD within
  2 % of full detail), but a real field under a moving camera may.
- **§5.2 zoom-banded flattening tolerance** (S1 §4.1): not built; strips
  and the gate meet the memory budgets without it.
- **§5.2 earcut deviation check** (04 §6.1): polygons earcut gets wrong
  are not detected or redrawn by stencil-then-cover yet.
- **The WebGL2 backend drawing `taper`** — the stage emits it; the
  reference raster and the PDF backend fill the shared `strokeOutline()`
  (C1, §5.1 / §5.3). The WebGL2 backend draws it butt — on the arena
  path a stroke vertex carries its own half width, so a taper is that
  width scaled along the taper length. The golden *scenes* leave `taper`
  out until the WebGL2 backend draws it (the library contact sheet's 107
  swatches, reference-only, show it since C1). `angles` are drawn by
  every backend (`lib-text-layout` since B8; PDF: a per-glyph `Tm`).
- **S2 confirmation** of §4.2 step 3 (what stretches, the `round`
  threshold), of `endGapUm` and of the vertical anchor's metrics (§4.9),
  against OCAD exports; for text layout (§4.9, B8) also the default tab
  interval, OCAD's box top (Mapper and Purple Pen lower the first line
  by one internal leading for OCAD formatted text), line text's arc
  length (Purple Pen's `max + min/2` metric), line-text vertical
  alignment, and the frame's vertical extent. No corpus map has line
  text or a rectangle frame (Club-2026 / Club-full have 9 / 13 formatted
  texts and 1 / 2 texts with a tab).
- **Serif and mono faces** — `liberation-serif` / `liberation-mono` are
  in the IR and the importers map Times / Courier to them, but no face is
  shipped (§4.10), so such text draws nothing with `NO_FONT`.
- **Rectangle grids** (OCAD rectangle symbol cell lines and numbering) —
  a by-design drop (user decision 2026-10-20); not pending, listed so the
  reader does not look for it.
