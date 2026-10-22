# Map rendering

Status: **draft** — chapter of the vector map pipeline specification,
started by spike S1 (steps 1–3: harness, pilot symbolisation stage,
WebGL2 backend with golden images); the symbolisation stage covers the
whole library since B1. Sections marked *not yet specified*
are filled in as slice B / C land. The research record this
chapter derives from is `docs/research/vector-map-pipeline/04-render-core.md`;
when the two disagree, this document wins.

This chapter is normative for the code in `packages/shared/src/render/`,
`packages/api/src/render/` and `packages/web/src/map-gl/`.

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
compared by `diffPassStreams`. Parsing sorts.

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

IR fields the stage reads and nothing else: `minimum` (a course-setting
and print concern, not drawn) and `paragraphSpacingUm` / `justify` (box
text, §8).

New IR fields are **optional without defaults**: a parsed symbol must
stay byte-identical when they are absent, because map document hashes
(`docs/map-document-format.md`) and review-decision fingerprints
(`docs/map-symbols.md` §8) are computed over the parsed IR.

The stage's entry point is `symbolise({ objects, symbols, fonts })` in
`render/symbolise.ts`. An object is `{ symbolIdx, path, angleDeg?, text? }`;
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
  and the glyph is `rotatable`; otherwise the glyph is north-up.

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
  importer's `FONT_SUBSTITUTED` (only Regular faces ship, §4.10). A face
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
  `−width/2`, `−width` for left / centre / right (justify = left until
  box text, §8). Paragraph spacing and line breaking inside boxes belong
  to box text (§8).
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
  paper µm, y-up, turned with the text — drawn as a plain fill (no
  `haloWidthUm`). It sorts at its colour's position like a halo.

### 4.10 Fonts shipped

`packages/shared/fonts/` holds Liberation Sans Regular and Liberation
Sans Narrow Regular from the Liberation **1.07** series — the only series
with the Narrow face (metric-compatible with Arial Narrow, which the
corpus uses). Note the licence: 1.07 is GPLv2 with the font-embedding
exception, not the SIL OFL of Liberation 2.x as 04 §4.4 assumed; both are
compatible with Oxygen's AGPL and with embedding in PDFs. `LICENSE` in
the directory is the upstream text. The server loads them through
`packages/api/src/render/fonts.ts`.

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
never an oracle).

This is the **oracle** of the golden-image tier. It is slow and simple on
purpose and is never used to draw a map for use. Its one production job
is previews (04 §4.1, 06 §5.2): document thumbnails and symbol swatches,
rendered once and stored as cache (`docs/map-storage.md` §4.5). PNG
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
overlapping kept); pixel probes in
`packages/api/src/render/__tests__/previews.test.ts`.

### 5.2 WebGL2 (web)

`packages/web/src/map-gl/`, with hard lines between the files:

```
worker.ts      document bytes ──► stream ──► atlas, buckets,      pure TS, runs in a Web Worker
               resident layers; detail parts on request           (worker-entry.ts binds it)
prepare.ts     geometry builders: flattening, indexed strips,     pure TS, typed arrays, no GL
               even-odd earcut; the per-pass fan path (goldens)
mesh-atlas.ts  glyph parts + text glyphs ──► one float texture   pure TS
buckets.ts     cells, large bucket, per-part preparation +        pure TS
               range table, visible set, clip groups, LRU, gate
arena.ts       vertex arenas: free list, grow by copy             GL buffers
engine.ts      main thread: worker transport, residency,          no GL calls of its own
               visible-set rebuilds
renderer.ts    arena programs + visible-set draw loop;            WebGL2
               the per-pass path (`setStream` / `render`)
```

Status: B2 — strips, arenas, buckets, visible set, mesh atlas, worker,
screen-only LOD. Not yet: MSDF text (B3; text is drawn from outline
meshes in the atlas until then), the viewer (B4), `WEBGL_multi_draw`
(§8). The per-pass path (`setStream` / `render`: one draw per pass,
stencil fills) is kept unchanged as the backend's golden path
(`MapGlFixturePage`, §6.2) and as the reference the arena path is
compared with (`compare=1`, below). The S1 batch path (`batch.ts`,
`setBatches` / `renderBatches`) is gone; its measurements are the
"S1" columns of the tables below.

#### Preparation (CPU)

Backend decisions only — nothing here moves a dash or a glyph:

| Pass | Becomes | How |
|---|---|---|
| fill | fill-arena vertices + triangle indices | rings flattened (10 µm); **even-odd earcut**: rings grouped by containment depth (`triangulateEvenOdd`) — a ring inside an even number of others is an outer boundary, one inside an odd number a hole of its innermost container, so a "hole" ring outside every other ring is filled and separate contours are separate polygons, exactly §3.1's rule. Rings that cross are earcut's failure mode and drawn as earcut decides (the reference raster is the oracle) |
| stroke | stroke-arena vertices + indices | each slice (or ring) flattened from its Bézier sub-range, then an **indexed strip** (`extrudeStrip`): per vertex the centre-line point and an offset direction; the shader multiplies by the half width |
| glyph | an instance per placement into the mesh atlas | the `GlyphMesh` in glyph-local µm at ¼ tolerance, fills triangulated even-odd, strokes as strips expanded to triangles; instance `x, y, cos, sin, scale` as in the stream plus the mesh's atlas `base, count, radius` |
| glyph with `clip` | instances + the clip area triangulated even-odd | drawn through the stencil (Drawing, below) |
| hatch | hatch-arena vertices + indices | the area triangulated like a fill; each vertex carries the stripe normal, spacing, offset and half width so hatches of one colour are one draw |
| text | an instance per glyph into the mesh atlas | outline in font units, filled even-odd; a halo pass is the outline stroked round/round at `haloWidthUm / k`; instance scale `k = sizeUm / unitsPerEm`, instance `cos, sin` from the glyph's `angles` entry (§3.5; upright without); meshes keyed by (font, glyph, tolerance, halo width) |

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
| instance | 32 | f32 x, y, cos, sin, scale, atlas base, count, radius |

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
| hatch tint | 1.5 device px | stripes closer than this become a tint of coverage `width / spacing` |
| `ARRIVAL_REBUILD_MS` | 150 ms | arriving detail rebuilds the visible set at most this often while more drawn detail is pending |
| arena growth | 1.25× | by `copyBufferSubData` into a new buffer; offsets never move |

**Assignment.** Every object goes, whole, to the cell holding the centre
of its symbolised bounds (`passBounds`: path bounds + half width × the
mitre limit for strokes, mesh radius × scale for glyphs, the em box and
halo for text), or to the large-object bucket. All of an object's passes
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
instances, where `group` is the atlas size class. Entries of one colour
are contiguous, so a colour of a part is one span.

**Visible set (04 §6.8 point 2).** `buildVisibleSet(parts, hidden)`
concatenates the drawn parts' spans per (colour, kind) into one index
buffer per indexed kind (rebased onto each part's arena offset) and one
instance buffer per instanced kind, grouped by (colour, size class).
Draws per frame = colours in view × kinds present + size classes + 3 per
clip group — independent of how many buckets are in view. It is rebuilt
when the drawn cell set or the gate state changes, when detail of a
drawn cell arrives (coalesced, `ARRIVAL_REBUILD_MS`), and when the
hidden set changes; never while zooming within the same cells. Hidden
objects (`engine.setHidden`, stream `objectIdx`) are skipped entry by
entry.

**Clip groups.** Pattern-clipped glyph passes of one colour are merged
into groups whose footprints (clip area ∪ instance extents) do not meet,
greedily in stream order: no instance of one member can fall inside
another member's area, so one stencil mark, one instanced draw and one
clear serve the group with the same pixels as one per pass. Before
grouping, Sprint envelope drew 161 per frame, 155 of them clip
stencil passes; after, 17.

**Residency and the budget.** The engine counts the always-resident
bytes (base parts, large bucket, atlas, the visible-set buffers — which
hold every index, instance and clip-group array on the GPU) plus the
resident detail parts' arena vertices against the budget. After every arrival and
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
| `load` | document bytes + `DocumentRenderOptions` (or, dev only, render objects + symbols), font files, optional first view (a view, or "fit into w × h"), gate flag | `loaded`: summary (bounds, origin, grid, detail cells, the first view resolved, stage times, bytes), mesh atlas, every cell's base part, the large part — then, without a further request, the first view's detail parts unless it is below the gate |
| `prepare` | bucket ids, most urgent first | replaces the queue; one `part` per id |
| — | | `error` on a failed load |

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
  it with the per-pass path like the canvas.

* **Fills** — earcut triangles, opaque. No stencil.
* **Strokes** — `halfWidth × offset` in the vertex shader. **Hairline
  floor** (04 §6.2, §8 row 10): when the stroke is under `minStrokePx`
  (1 device px) on screen it is drawn that wide with alpha × (true width
  / floor), so zoomed-out contours fade to a tint instead of aliasing.
  Triangles that overlap at join wedges blend twice under the floor; the
  area is sub-pixel at the zooms where the floor applies.
* **Instanced glyphs and text** — vertex pulling: the instance carries
  its mesh's atlas `base` and `count`; the draw pulls `2^class` vertices
  per instance (a whole number of triangles) and vertices past `count`
  are moved outside clip space. Mesh strokes get the same floor. An
  instance whose mesh diameter × scale is under `minGlyphPx` (2 px) is
  collapsed the same way. Fills inside meshes are triangles, so
  overlapping instances of one pass no longer XOR (the per-pass path's
  caveat).
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

`/dev/map-gl?fixture=<golden scene>` (`pages/dev/MapGlFixturePage.tsx`,
routed only when `import.meta.env.DEV`) draws one golden scene into a
canvas sized by `render.goldenFrame` (§6.2) with
`preserveDrawingBuffer`, sets `data-ready` when done and shows the
timings. Fonts are fetched from `packages/shared/fonts/` via Vite `?url`.

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
residency budget (MB, default 150), `lod=0` turns off the glyph skip and
hatch tint, `kinds=fill,stroke,…` draws only those kinds; `compare=1`
also draws the same stream through the per-pass golden path into a
second canvas at a zoom where every stroke is ≥ 1.5 px and publishes
the fraction of pixels differing by more than 16 levels (§6.2's channel tolerance). Pan by drag,
zoom by wheel or pinch. Reports and the encoded document bytes are
published on `window.__mapGlDoc` for Playwright.

#### Tests

| Test | Covers |
|---|---|
| `map-gl/__tests__/strip.test.ts` | strip coverage = S1 extrusion away from edges for every cap × join × open/closed; 2 vertices per point on straight lines and flattened arcs; mitre limit; short-segment fallback; dots; dash slices with caps; ≥ 3× fewer bytes on a contour; even-odd earcut (hole order and winding, outside "hole", nested island) |
| `map-gl/__tests__/buckets.test.ts` | assignment (centre, straddling, large by either dimension incl. stroke width), passes of an object together in stream order, `passBounds`; visible cells (margin, clamp, nearest first, rotation); zoom gate at 04's reference zooms; range table colour-major, contiguous, complete, layers, origin-relative positions and hatch offset, stroke packing; visible set (one draw per colour across buckets, rebasing, union of parts, hidden objects, instances by size class); clip groups (merge, separation, hidden); mesh atlas packing; LRU eviction |
| `map-gl/__tests__/arena.test.ts` | free list: first fit, exact accounting, coalescing, growth |
| `map-gl/__tests__/worker-protocol.test.ts` | `loaded` contents and transfer list; `prepare` queue replacement and slicing; first-view queue and the gate; base + detail + large covers every kind; load errors |
| `map-gl/__tests__/engine.test.ts` | residency through the real worker handler and a fake renderer: drawn + prefetch requested and uploaded; drawn parts never evicted, over budget reported; the same view never re-requests what was evicted; rebuild on drawn-set change but not on zoom within the cells; below the gate only base + large, queue cancelled; hidden objects |
| `map-gl/__tests__/view.test.ts` | view matrix: centre → clip origin, canvas edges → ±1, y-up, rotation; sub-pixel precision far from the origin in float32 arithmetic |
| `map-gl/__tests__/prepare.test.ts` | per-pass path (fans, S1 extrusion), unchanged |
| `e2e/map-gl-doc.spec.ts` | the arena path through the real worker on `e2e/test.ocd` (pilot, envelope): buckets, complete frame, ≤ 300 draws on every bench frame of both scenarios; worker = inline; a 0.05 MB budget evicts, reports over budget and still draws; **arena = per-pass golden path within 0.5 % pixels** (envelope and source on the canvas, envelope into an offscreen framebuffer target); document vs reader path, native `.oxvm`, source mode, `.xmap`, decode error |
| `e2e/map-gl-golden.spec.ts` | unchanged: the per-pass path against the reference raster |

### 5.3 PDF (api)

*Not yet specified.* Slice C (`docs/course-print.md` owns the page model;
this chapter owns how a pass is emitted as PDF content).

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
`pdftoppm` at the same density. Each is compared with the oracle by
`diffImages(a, b, channelTolerance = 16)`: a pixel differs when any
channel differs by more than 16/255; the fixture passes when the fraction
of differing pixels is ≤ 0.5 % (04 §9 budget). Backends are compared
with the oracle, never with each other.

**Golden scenes** are the six contract fixtures (§6.3), the
`pilot-scene` (`__fixtures__/pilot-scene.ts`: one object per pilot
symbol, hand-placed) and the eleven library fixtures (`lib-*`, §6.3,
coloured from the library's palette through `cmykToHex`). `render.goldenScene(name, fonts)` resolves a name
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
| `lib-halos` | 9 | ISSprOM 704.b over 521; *508 with a continuous white band* over 406 | the white outline between the building's black and upper purple; the band its own pass over the green |
| `lib-colour-order` | + | ten ISSprOM colours, lower and upper purple among them, pushed in reverse | colour-major order; lower purple under black, upper purple last |
| `lib-precision` | + | `lib-dash-ocad` and `lib-line-glyphs` moved to (1 200 000, 1 200 000) µm | every pass the near pass translated, to 1 µm |

Not in the table: 04 §8 row 10 (minimum sizes) is a screen-backend rule
(the stream is the same at every zoom), and the filter-region and
georeference rows belong to slice B's viewer (B4) and A11's `mapGeo`.

### 6.4 Corpus parity

The B-gate's parity check (09 §4 B: "visual parity on the corpus against
tiles for the sanctioned differences only") and the instrument for
triaging a user's "this looks wrong" on a real map (B9).

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
full coverage) on one side with no ink within one pixel on the other.
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

Tests: `packages/api/src/render/__tests__/parity.test.ts` (pixel grid,
isolation, agreement on `e2e/test.ocd`, the frame as a sanctioned
divergence, ranking, shape measure, tags; a 510 power line from
`buildParityOcad` with its poles at the corner points only) and
`scripts/__tests__/measure-parity.test.mjs` (CLI, `pnpm test:scripts`).
The CLI test needs Liberation Sans installed as a *system* font: the
legacy side renders `<text>` through the system font stack while the
canonical side draws the bundled outlines, so a machine without
`fonts-liberation` sees the 603 spot height diverge (24 % on a bare
GitHub runner) and the test fails. The Docker image installs the
package; `.github/workflows/ci.yml` installs it before the helper
script tests.

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
| `packages/shared/src/render/pattern.ts`, `geometry.ts` | pattern grids, inclusion, offsetting |
| `packages/shared/src/render/glyph-table.ts` | IR glyph → `GlyphMesh`, registry |
| `packages/shared/src/render/truetype.ts`, `text.ts` | font reader, shaping |
| `packages/shared/src/render/symbolise.ts` | the stage |
| `packages/shared/src/render/__fixtures__/` | contract fixtures (`streams/`), library fixtures (`library/`, snapshots in `streams/library/`), pilot symbols, `pilot-scene.ts`, `golden.ts` (scene list, frame) |
| `packages/shared/src/render/proxy-symbols.ts` | per-kind proxy symbols for the render bridge |
| `packages/shared/fonts/` | bundled Liberation faces |
| `packages/api/src/render/reference-raster.ts` | resvg rasterisation, `sampleAt`, `diffImages`, `encodePng` |
| `packages/shared/src/render/swatch.ts` | symbol swatch scene (§5.1.1) |
| `packages/api/src/render/previews.ts` | swatch and thumbnail PNGs (`docs/map-storage.md` §4.5) |
| `packages/api/src/render/fonts.ts` | bundled-font loader for the server backends |
| `packages/api/src/render/golden.ts`, `scripts/render-golden.ts` | golden PNG generation (`pnpm --filter @oxygen/api golden:render`) |
| `packages/api/src/render/parity.ts`, `scripts/measure-parity.mjs` | corpus parity against the legacy tiles (§6.4) |
| `packages/shared/src/render/ocad-objects.ts` | dev-only: `ocad2geojson` objects → `RenderObject`s (pilot / envelope modes); `ocadFlags` for the importers |
| `packages/web/src/map-gl/prepare.ts` | WebGL2 backend, geometry builders: flattening, indexed strips, even-odd earcut; the per-pass fan path |
| `packages/web/src/map-gl/mesh-atlas.ts` | glyph and text meshes in one float texture (vertex pulling) |
| `packages/web/src/map-gl/buckets.ts` | cells, large bucket, per-part preparation and range table, visible set, clip groups, zoom gate, LRU |
| `packages/web/src/map-gl/arena.ts` | vertex arenas: free list, growth by copy |
| `packages/web/src/map-gl/worker.ts`, `worker-entry.ts` | the worker's message handler and its binding |
| `packages/web/src/map-gl/engine.ts` | main-thread controller: worker transport, residency, visible-set rebuilds |
| `packages/web/src/map-gl/view.ts` | the arena path's model → clip matrix, `RenderTarget` |
| `packages/web/src/map-gl/renderer.ts` | WebGL2 backend, GPU stage (arena programs and draw loop; per-pass path, stencil, supersampling; GPU timer) |
| `packages/web/src/pages/dev/MapGlFixturePage.tsx` | dev-only golden page `/dev/map-gl` |
| `packages/web/src/pages/dev/MapGlDocPage.tsx` | dev-only whole-document page `/dev/map-gl-doc` (load report, bench) |
| `e2e/__golden__/map-gl/`, `e2e/map-gl-golden.spec.ts` | committed goldens and the browser comparison |
| `e2e/map-gl-doc.spec.ts` | whole-document pipeline on `e2e/test.ocd`: arena path, worker, eviction, arena = per-pass path |
| `scripts/measure-gl.mjs` | corpus measurements through `/dev/map-gl-doc` (§5.2 Measurements) |

The shared module is exported as a namespace: `import { render } from
"@oxygen/shared"` → `render.PassStream`, `render.passStreamFromJson`, …
(namespaced to keep `Bounds`, `Segment` etc. from colliding with
`course-maps`).

## 8. Pending in this chapter

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
- **§5.2 object identity across the bridge.** The range table keys on
  the stream's `objectIdx` — an index into the bridge's filtered object
  list; hiding a *document* object needs the bridge to expose that
  mapping (B4).
- **§5.2 real-phone numbers** (B0 / B-gate): the GPU columns are the
  laptop iGPU, the phone column a CPU-throttle proxy.
- **§5.2 analytic stroke anti-aliasing** (04 §6.2, §6.9): the 1-px
  feather on strokes and glyph strokes on top of MSAA. Not built in B2 —
  the arena = per-pass pixel comparison relies on both paths using MSAA
  alone; B4 / the B-gate's parity check against tiles is where it is
  judged.
- **§5.2 perspective cameras** (terrain draping, research topic 10):
  the projection is already one matrix and the target any framebuffer;
  still needed are cell selection from the camera's footprint instead of
  the `View` rectangle, and a per-vertex screen density for the
  screen-only rules instead of the one `pxPerUm`.
- **§5.2 zoom-banded flattening tolerance** (S1 §4.1): not built; strips
  and the gate meet the memory budgets without it.
- **§5.2 earcut deviation check** (04 §6.1): polygons earcut gets wrong
  are not detected or redrawn by stencil-then-cover yet.
- **Text layout in boxes and along paths** — OCAD formatted text
  (`otp 5`) and Mapper text boxes (wrapping inside an object-level box,
  `paragraphSpacingUm`, `justify`), and line text laid along its path
  (per-glyph `angles` from §3.5 plus a path layout in `text.ts`). Row B8
  (user decision 2026-10-20); until then box text is block text from the
  anchor and line text is block text from the path's first vertex.
- **Backends drawing `taper` and `angles`** — the stage emits both. The
  WebGL2 backend draws `angles` on both its paths (B2: a text instance's
  `cos, sin`); it does not draw `taper` yet (drawn butt) — on the arena
  path a stroke vertex carries its own half width, so a taper is that
  width scaled along the taper length. The PDF backend (slice C) draws
  neither yet. The goldens leave both out until every backend does; the
  reference raster draws `angles`.
- **S2 confirmation** of §4.2 step 3 (what stretches, the `round`
  threshold), of `endGapUm` and of the vertical anchor's metrics (§4.9),
  against OCAD exports.
- **Serif and mono faces** — `liberation-serif` / `liberation-mono` are
  in the IR and the importers map Times / Courier to them, but no face is
  shipped (§4.10), so such text draws nothing with `NO_FONT`.
- **Rectangle grids** (OCAD rectangle symbol cell lines and numbering) —
  a by-design drop (user decision 2026-10-20); not pending, listed so the
  reader does not look for it.
- **§5.3 PDF** — slice C.
