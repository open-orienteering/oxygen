# Map rendering

Status: **draft** — chapter of the vector map pipeline specification,
started by spike S1 (steps 1–3: harness, pilot symbolisation stage,
WebGL2 backend with golden images). Sections marked *not yet specified*
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
Fonts are the four Liberation families (`FontRef.family`); shaping rules
are *not yet specified* (S1 step 2).

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
fields are quantised to 3 decimals (µm) in the projection; typed arrays are
canonical in memory. All-zero flag arrays are omitted. Parsing sorts.

## 4. Symbolisation rules

Status: pilot rules (S1 step 2), proven by
`packages/shared/src/render/__tests__/{measure,dash,placement,pattern,text,symbolise}.test.ts`
and in image form by `packages/api/src/render/__tests__/pilot-raster.test.ts`.
Rules marked **provisional** reproduce the documented behaviour of OCAD /
Mapper from their field semantics; the exact constants are confirmed
against exports of the corpus maps in the S0/slice A corpus run and
amended here if they differ. The *structure* of each rule (what is
computed where, what the stream carries) is not provisional.

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
  them and the wrap-around piece through the start point is a section of
  its own (the start point is not an implicit split).
- `shortenStartUm` / `shortenEndUm` shrink the first / last section of an
  open path before layout.
- **Gap points** (128): from one gap point to the next, the main stroke is
  not drawn. Intervals are subtracted after dash layout, so dashes keep
  their phase across the gap. An unpaired gap point at the last point
  runs to the end of the line.

### 4.2 Dash layout — `layout: "ocad"` (provisional)

Per section, with dash `D`, gap `G`, end dash `E` (= `D` unless
`endDashUm` is given), gap count `n`:

1. `n = round((L − 2E + D) / (D + G))`, then `n = max(n, minGaps)`. On a
   closed loop `E = D/2` and `n ≥ 1`, so the two half end dashes meet at
   the start point and form one ordinary dash.
2. If `n = 0` the section is one solid dash.
3. Otherwise **gaps keep their nominal length** and all dashes are scaled
   by one ratio `r = (L − n·G) / (2E + (n − 1)·D)` so the section starts
   and ends with a full end dash. The last dash is snapped to the section
   end. If even the gaps do not fit (`L − n·G ≤ 0`), `n` is reduced until
   they do.
4. `secondaryGapUm` splits every **interior** dash into `dashesInGroup`
   (default 2) equal parts separated by the secondary gap; `endGapUm` is
   the secondary gap applied to the two **end** dashes (OCAD's "end gap"
   — 507 footpath: `secGap 25, endGap 25`; 0 / absent leaves the end
   dashes whole). On a closed loop every dash is interior.
5. A secondary or end gap forces the virtual grid: a pattern with
   `gapUm 0` and `secondaryGapUm > 0` (517 ruined fence) lays out
   touching dashes and cuts each one, so the line reads as a solid line
   with a short gap every `D`.

What stretches is the provisional part: the implementation keeps gaps
fixed (visibly uniform gaps, varying dashes, which is what OCAD maps
show); if the corpus run shows OCAD scaling gaps too, step 3 changes and
nothing else does.

### 4.3 Dash layout — `layout: "omap"` (provisional)

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

### 4.4 Strokes, halos, borders

- A line symbol's `main` stroke becomes one `StrokePass` on the object's
  own path (Béziers intact), with `slices` from §4.2/4.3 when dashed,
  shortened or gapped, otherwise no slices. `cap: flat` maps to `butt`.
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

### 4.5 Glyphs on lines

Placement (`render/placement.ts`) yields `(length, angle, scale)` per
glyph; the instance transform is the point at that length with
`cos/sin` of the angle (tangent angle when the glyph is `rotatable`,
0 otherwise).

| `placement.at` | Rule |
|---|---|
| `start` / `end` | the path's ends, tangent angle |
| `corners` / `dashPoints` | every point with flag 4 / 8 strictly inside the path, at the **bisector** of the incoming and outgoing tangents; the ends of an open path too unless `ignoreEnds`; on a closed path the start point only when it carries the flag. `scaleAtCorners` scales by `1 / cos(turn/2)` (mitre length), clamped at 4× |
| `dashCentres` / `gapCentres` | centres of the dashes / gaps of the main stroke's dash layout per section. The layout is run in *virtual* mode so a solid line (`gapUm 0`) with spaced symbols — OCAD's 516 power line — still gets positions: with zero gaps the dashes touch and the glyphs sit at the joints |
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
  symbol (weight/italic ignored in the pilot). Fonts are read by the
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
  `−width/2`, `−width` for left / centre / right (justify = left in the
  pilot). The whole block rotates about the anchor by the object angle.
  Paragraph spacing and line breaking inside boxes belong to formatted
  text, which is not in the pilot.
- A `halo` is a separate `TextPass` in the halo colour with
  `haloWidthUm`, identical glyphs and positions. Sorted by colour it
  lands at the halo colour's stack position — the ISSprOM 704 white
  outline is "upper white", one below upper purple.

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

`packages/web/src/map-gl/`, three files with hard lines between them:

```
prepare.ts   pass stream ──► PreparedStream        pure TS, typed arrays, no GL
batch.ts     PreparedStream ──► Batch[]            pure TS, merges per (colour run, kind)
renderer.ts  Batch[] + View ──► pixels             WebGL2, six small programs
```

Status: S1 steps 3–4 spike — whole document drawn every frame, no
arena, no worker, no buckets / visible set, no MSDF text, no
depth-buffer fill path. Everything below is what the spike **proved**;
the arena / worker / tiling layer of 04 sits on top of it unchanged.
`renderer.ts` keeps the step-3 one-draw-per-pass path (`setStream` /
`render`) for the golden page; the document path is `setBatches` /
`renderBatches`. The spike's verdict and its amendments to 04 are in
`docs/research/vector-map-pipeline/S1-render-spike.md`.

#### Preparation (CPU)

Backend decisions only — nothing here moves a dash or a glyph:

| Pass | Becomes | How |
|---|---|---|
| fill | `fan` + `cover` | rings flattened (default 10 µm); one triangle per ring edge from a fan origin just outside the bounds; a two-triangle bounding quad |
| stroke | `verts` (x, y, ox, oy) | each slice (or ring) flattened from its Bézier sub-range, then extruded *directionally*: the vertex carries the centre-line point and a unit (or mitre) offset; the shader multiplies by the half width |
| glyph | instanced fill fan + strokes | the `GlyphMesh` in glyph-local units, flattened at ¼ tolerance; instances are the pass's `x, y, cos, sin, scale` buffer as-is |
| hatch | `fan` + `cover` + stripe params | the area like a fill; stripes are evaluated in the fragment shader |
| text | one instanced item per distinct glyph id | outline in font units, instance scale `sizeUm / unitsPerEm`; a halo pass is the same outlines **stroked** (round/round) with `haloWidthUm / k` |

Extrusion emits one quad per segment, a join wedge per interior vertex
(mitre with the 4× limit → bevel, or round at 8 steps per π) and the
caps (flat; square = quads extended by one half width; round = half
circle). Because the width is applied in the shader, the same buffer
serves every zoom and the minimum on-screen width is a uniform.

#### Drawing (GPU)

Items are drawn in stream order; the stream is already colour-major so no
sorting happens here. Projection subtracts `u_centre` and scales by
px/µm per axis; the stream is y-up and so is clip space, so there is no
flip anywhere.

* **Even-odd fills** — the stencil trick, never a triangulation: the fan
  is drawn colour-masked with `stencilOp(INVERT)`, then the cover quad is
  drawn where `stencil == 1` with `stencilOp(ZERO)`, which paints the
  fill and clears the stencil in one pass. Holes come for free and the
  result is exactly §3.1's rule.
* **Strokes** — plain triangles; `halfWidth = max(widthUm/2, minPx/2/pxPerUm)`.
* **Instanced glyphs and text** — `drawArraysInstanced` over the glyph's
  fan with a per-instance `(x, y, cos, sin)` + `scale` attribute, then
  the cover quad instanced the same way. Overlapping instances of the
  same pass XOR each other (known caveat, no map symbol in the pilot set
  triggers it; a per-instance stencil clear would fix it at the cost of
  a draw per instance).
* **Pattern clip** — two stencil bits: bit 0 holds the clip area (fan,
  INVERT, mask 0x01), bit 1 the instances' parity; the instanced cover
  tests `EQUAL 0x03` and clears bit 1, a final cover clears bit 0.
* **Hatch** — the area goes through the stencil like a fill; the cover
  quad runs a stripe shader (`d = dot(p, n) − offset`, distance to the
  nearest multiple of `spacing`) with a one-pixel coverage ramp and
  alpha blending. The fragment never `discard`s so the stencil clear
  always runs.
* **Anti-aliasing** — the context's MSAA (4× in practice). Optional
  `supersample: 2`: draw into a 2× multisampled renderbuffer, resolve
  into a texture, draw that onto the canvas with linear filtering (a
  2×2 box at exactly 2×; a scaled `blitFramebuffer` into the canvas is
  illegal because the default framebuffer is itself multisampled). The
  golden page uses it; the production default is 1.

Resources: `MapGlRenderer.setStream(prepared)` uploads, `render(view,
opts)` draws, `dispose()` frees. Measured on the pilot scene in headless
Chromium (SwiftShader): 36 items, prepare 3.8 ms, upload ~10 ms, draw
< 1 ms.

#### Batching (`batch.ts`)

One draw per pass does not scale: a real document has 2 000–113 000
passes (table below). The stream is colour-major and every pass inside
one colour is opaque and of that colour, so items of the same kind
within a **colour run** can be merged without changing the picture.
`buildBatches(prepared)` emits, per colour run and in the stream's kind
order:

| Batch | Merge | Notes |
|---|---|---|
| `fill` | all fills of the run → one position buffer + one `Uint32` index buffer | rings triangulated with **earcut** (holes as earcut hole indices). The stencil parity trick of the per-pass path cannot merge *overlapping* fills of one colour (they would XOR), so merged fills are triangulated. earcut's known failure modes (self-intersecting rings) are tolerated in the spike; the reference raster is the oracle |
| `hatch` | none, one per pass | each has its own stencil area and stripe parameters |
| `stroke` | all strokes of the run → one buffer | the half width moves from a uniform into a fifth vertex component (`x, y, ox, oy, hw`, program `strokeW`) so widths can mix |
| `instanced` | per (fill mesh, stroke meshes) object identity → instance arrays concatenated | glyph instances and text glyphs; pattern-clipped items stay alone because they own the stencil |

Draws per frame on the corpus: 14–75 (event maps) and 114–345 (club
maps) for 451–113 000 passes — inside 04 §9's ≤ 300 for everything but
Club-full envelope, which is the deliberately pessimistic upper bound.
`renderer.setBatches` uploads once; `renderBatches(view)` returns
`FrameStats { drawCalls, cpuMs, gpuMs? }`, the GPU time from
`EXT_disjoint_timer_query_webgl2` where available (resolved a frame
late).

#### Loading an OCAD document (`ocad-objects.ts`, shared)

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

#### Whole-document measurements (S1 step 4)

Measured through `/dev/map-gl-doc` with
`.local/research/oxygen-measurements/gl/measure-gl.mjs` (Playwright,
headed Chromium on the dev laptop's Alder Lake-P iGPU, GPU timer
available). Objects = matched + proxied. Load times are the browser's,
cold per page load, with `ocad2geojson` doing the decode (`read`) —
that stage is replaced by the 02 document reader and is shown
separately. All numbers in ms.

Desktop, 1280×800 @ 1×, 240-frame bench zooming 1→4→1 with pan:

| Map | Mode | Objects | Passes | Batches | Draws | GPU MB | read | symbolise | prepare | batch+upload | **total** | GPU avg / p95 | CPU avg |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Sprint | pilot | 1 275 | 2 241 | 115 | 325 | 5.0 | 120 | 14 | 25 | 7 | **168** | 3.7 / 3.9 | 1.0 |
| Sprint | envelope | 10 680 | 11 644 | 117 | 328 | 19.4 | 207 | 28 | 66 | 43 | **349** | 6.9 / 7.8 | 1.0 |
| Crop-B | pilot | 342 | 451 | 9 | 14 | 6.0 | 73 | 8 | 28 | 4 | **113** | 1.6 / 2.0 | 0.4 |
| Crop-B | envelope | 3 073 | 3 182 | 40 | 75 | 16.5 | 136 | 21 | 60 | 15 | **235** | 3.9 / 4.3 | 0.5 |
| Crop-A | pilot | 639 | 844 | 11 | 22 | 8.3 | 86 | 13 | 33 | 7 | **140** | 2.0 / 2.4 | 0.4 |
| Crop-A | envelope | 4 983 | 5 188 | 24 | 47 | 19.8 | 151 | 24 | 64 | 16 | **258** | 4.9 / 5.6 | 0.4 |
| Club-2026 | pilot | 7 980 | 12 097 | 39 | 114 | 70 | 477 | 103 | 190 | 58 | **837** | 9.5 / 11.1 | 0.6 |
| Club-2026 | envelope | 45 884 | 50 001 | 100 | 235 | 154 | 924 | 275 | 407 | 158 | **1 784** | 10.8 / 12.3 | 1.0 |
| Club-full | pilot | 17 550 | 28 756 | 61 | 192 | 157 | 1 108 | 225 | 432 | 135 | **1 915** | 10.2 / 19.4 | 0.8 |
| Club-full | envelope | 101 727 | 112 933 | 138 | 345 | 338 | 2 034 | 654 | 994 | 468 | **4 197** | 21.5 / 23.2 | 1.2 |

Phone proxy — same machine, 412×915 @ 2.625× (Pixel-7 metrics, 2.6 M
canvas pixels) with CDP `Emulation.setCPUThrottlingRate(4)`:

| Map | Mode | read | symbolise | prepare | batch+upload | **total** | **total − read** | GPU avg / p95 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Sprint | pilot | 368 | 35 | 118 | 24 | **555** | 187 | 4.0 / 4.2 |
| Sprint | envelope | 683 | 101 | 266 | 164 | **1 235** | 552 | 7.1 / 8.5 |
| Crop-B | pilot | 232 | 32 | 100 | 17 | **386** | 154 | 1.8 / 2.2 |
| Crop-B | envelope | 484 | 64 | 233 | 58 | **847** | 363 | 4.4 / 5.1 |
| Crop-A | pilot | 275 | 77 | 123 | 24 | **510** | 235 | 2.1 / 2.4 |
| Crop-A | envelope | 524 | 88 | 251 | 62 | **936** | 412 | 5.1 / 5.6 |
| Club-2026 | pilot | 1 554 | 550 | 743 | 204 | **3 079** | 1 525 | 6.7 / 9.8 |
| Club-2026 | envelope | 3 084 | 881 | 1 493 | 585 | **6 111** | 3 027 | 12.0 / 13.1 |
| Club-full | pilot | 3 484 | 1 105 | 1 797 | 433 | **6 876** | 3 393 | 10.0 / 11.0 |
| Club-full | envelope | 6 886 | 2 236 | 3 600 | 1 373 | **14 265** | 7 380 | 20.9 / 21.5 |

Every run held 60 fps (frame p95 ≈ 17 ms, vsync) on the laptop; render
CPU per frame is 0.4–1.6 ms in every configuration.

Against the budgets (04 §9, 09 §7):

| Budget | Event maps | Club maps | Verdict |
|---|---|---|---|
| symbolise whole document ≤ 100 / 800 ms | 8–28 ms (35–101 throttled) | 225–654 ms (1 105–2 236 throttled) | event ✓; club ✓ unthrottled, pilot ✓ / envelope ✗ at 4× — the 04 worker hides it |
| draw calls ≤ 300 | 14–328 | 114–345 | ✓ except Sprint (325 — 115 glyph meshes in one colour run; merging meshes into one atlas buffer fixes it) and Club-full envelope |
| frame CPU ≤ 4 ms | 0.4–1.0 ms | 0.6–1.6 ms | ✓ with margin, even throttled |
| frame GPU ≤ 8 ms on a mid-range phone | 1.6–3.9 pilot, 3.9–7.8 envelope on the iGPU | 10–23 on the iGPU | **not shown**: the whole-document draw is vertex-bound (time did not move between 1 M and 2.6 M canvas pixels) and a phone GPU is 2–4× slower than this iGPU, so the envelope would land at 8–30 ms. 04's visible set per bucket is what brings the vertex count down to the view; it is required, not optional |
| first frame ≤ 500 ms (event) / ≤ 2.5 s (club) | pilot 113–168 desktop, 386–555 throttled; envelope 235–349 / 847–1 235 | 0.8–4.2 s desktop, 3.1–14.3 s throttled | event ✓ once `read` is subtracted (154–552 ms throttled); club ✗ for the whole document — as 04 expected, Club maps need zoom gating and the worker. `prepare` is the dominant remaining stage |
| resident GPU ≤ 30 / 150 MB | 5–20 MB | 70–338 MB | event ✓; club ✗ for the whole document; see the stroke note below |

Findings carried into the 04 implementation:

1. **Stroke geometry is the memory.** 95 % of the bytes are extruded
   strokes: a non-indexed triangle list at 16 B per vertex is 48 B per
   triangle, and Club-full pilot has 2.7 M of them. An indexed strip (two
   vertices per polyline point) cuts this by ~3×; zoom-gated flattening
   tolerance (10 µm everywhere today) cuts it again. Both belong to the
   arena.
2. **The pilot family covers 11–18 % of the objects**, so pilot-mode
   numbers understate the load by 3–7×; the envelope overstates it
   slightly (proxy strokes are 140 µm solid, with no dashes). The truth
   for a full library is between the two columns, nearer the envelope.
3. **Batching works and is cheap** (3–280 ms CPU, once), and the per-frame
   CPU side is a non-issue at 1–2 ms with ≤ 345 draws.
4. **Not done in the spike**: the depth-buffer fill path (04 §6.8 point
   3), cell size and large-object threshold tuning (04 §6.11) — both need the
   bucket layer that does not exist yet, and the frame-GPU result above
   says the bucket layer is the next thing to build. Not measured on a
   physical phone; the 4× CPU throttle is Chromium's proxy and the GPU
   column is the laptop's. To measure on a device: `pnpm --filter
   @oxygen/web dev -- --host 0.0.0.0`, open
   `http://<laptop>:5173/dev/map-gl-doc?mode=envelope` on the phone, pick
   the `.ocd` with the file input, press *bench*.

#### Dev pages

`/dev/map-gl?fixture=<golden scene>` (`pages/dev/MapGlFixturePage.tsx`,
routed only when `import.meta.env.DEV`) draws one golden scene into a
canvas sized by `render.goldenFrame` (§6.2) with
`preserveDrawingBuffer`, sets `data-ready` when done and shows the
timings. Fonts are fetched from `packages/shared/fonts/` via Vite `?url`.

`/dev/map-gl-doc?mode=source|pilot|envelope[&via=document|reader][&url=…][&bench=1]`
(`pages/dev/MapGlDocPage.tsx`) runs the whole pipeline on an OCAD or
`.oxvm` file chosen with the file input (or fetched from `url`, e.g. a
Vite `/@fs/` path), shows the `LoadReport` (stage timings, pass kinds,
batch statistics, GPU bytes, draws) and runs a 240-frame zoom/pan bench
with CPU and GPU percentiles. `via=document` (default) goes through the
map document — read → normalise → encode → decode → render bridge
(`docs/map-document-format.md`) and reports the document's size,
sections, hash and codec timings; `via=reader` is the S1 path straight
from the reader (`ocadObjectsToRender`). A `.oxvm` file is decoded
natively without the OCAD reader. `mode=source` (default) draws the
file's own symbol definitions as converted by the importer
(`docs/map-import.md` §3.3) in the document's colour stack, proxies for
whatever stayed `null`; `pilot` / `envelope` swap in the S1 pilot family
by symbol code (`source` is document-only). Pan by drag, zoom by wheel
or pinch. Both reports and the encoded document bytes are published on
`window.__mapGlDoc` for Playwright; the E2E spec `e2e/map-gl-doc.spec.ts`
runs it on the synthetic `e2e/test.ocd` in all three modes and both
paths and feeds the encoded document back in as a native file.

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

### 6.2 Golden images

Three-way. The reference raster (§5.1) renders the fixture at 10 px/mm
(254 dpi). The WebGL2 backend renders the same stream in headless
Chromium (Playwright) and the PDF backend's page is rasterised with
`pdftoppm` at the same density. Each is compared with the oracle by
`diffImages(a, b, channelTolerance = 16)`: a pixel differs when any
channel differs by more than 16/255; the fixture passes when the fraction
of differing pixels is ≤ 0.5 % (04 §9 budget). Backends are compared
with the oracle, never with each other.

**Golden scenes** are the six contract fixtures (§6.3) plus the
`pilot-scene` (`__fixtures__/pilot-scene.ts`: one object per pilot
symbol, hand-placed). `render.goldenScene(name, fonts)` resolves a name
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
samples). Measured ratios, headless Chromium / SwiftShader:

| Scene | Differing pixels |
|---|---|
| `fill-with-holes` | 0 / 48 400 (0.000 %) |
| `dashed-bezier-stroke` | 136 / 66 000 (0.206 %) |
| `glyph-instances` | 10 / 26 076 (0.038 %) |
| `hatch-area` | 6 / 67 200 (0.009 %) |
| `colour-order` | 0 / 48 400 (0.000 %) |
| `text-with-halo` | 23 / 5 220 (0.441 %) |
| `pilot-scene` | 1 130 / 385 640 (0.293 %) |

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
`packages/api/src/render/__tests__/pilot-raster.test.ts`. The canonical
library's own fixtures (04 §8 table, one per rule) are added in slice B.

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
| `packages/shared/src/render/__fixtures__/` | contract fixtures (`streams/`), pilot symbols, `pilot-scene.ts`, `golden.ts` (scene list, frame) |
| `packages/shared/fonts/` | bundled Liberation faces |
| `packages/api/src/render/reference-raster.ts` | resvg rasterisation, `sampleAt`, `diffImages`, `encodePng` |
| `packages/shared/src/render/swatch.ts` | symbol swatch scene (§5.1.1) |
| `packages/api/src/render/previews.ts` | swatch and thumbnail PNGs (`docs/map-storage.md` §4.5) |
| `packages/api/src/render/fonts.ts` | bundled-font loader for the server backends |
| `packages/api/src/render/golden.ts`, `scripts/render-golden.ts` | golden PNG generation (`pnpm --filter @oxygen/api golden:render`) |
| `packages/shared/src/render/ocad-objects.ts` | `ocad2geojson` objects → `RenderObject`s (pilot / envelope modes, proxy symbols) |
| `packages/web/src/map-gl/prepare.ts` | WebGL2 backend, CPU stage (fans, extrusion, instancing) |
| `packages/web/src/map-gl/batch.ts` | WebGL2 backend, batching per colour run (earcut fills, mixed-width strokes, merged instances) |
| `packages/web/src/map-gl/renderer.ts` | WebGL2 backend, GPU stage (programs, stencil, supersampling, GPU timer) |
| `packages/web/src/pages/dev/MapGlFixturePage.tsx` | dev-only golden page `/dev/map-gl` |
| `packages/web/src/pages/dev/MapGlDocPage.tsx` | dev-only whole-document page `/dev/map-gl-doc` (load report, bench) |
| `e2e/__golden__/map-gl/`, `e2e/map-gl-golden.spec.ts` | committed goldens and the browser comparison |
| `e2e/map-gl-doc.spec.ts` | whole-document pipeline on `e2e/test.ocd` |

The shared module is exported as a namespace: `import { render } from
"@oxygen/shared"` → `render.PassStream`, `render.passStreamFromJson`, …
(namespaced to keep `Bounds`, `Segment` etc. from colliding with
`course-maps`).

## 8. Pending in this chapter

- **Text layout in boxes and along paths** — OCAD formatted text
  (`otp 5`) and Mapper text boxes (wrapping inside an object-level box,
  `paragraphSpacingUm`, `justify`), and line text laid along its path
  (per-glyph `angles` from §3.5 plus a path layout in `text.ts`). Row B8
  (user decision 2026-10-20); until then box text is block text from the
  anchor and line text is block text from the path's first vertex.
- **Backends drawing `taper` and `angles`** — the stage emits both; the
  WebGL2 backend (B2) and the PDF backend (slice C) do not draw them yet
  (a taper is drawn butt, rotated glyphs upright). The goldens leave both
  out until they do; the reference raster draws `angles`.
- **S2 confirmation** of §4.2 step 3 (what stretches, the `round`
  threshold) and of `endGapUm`, against OCAD exports.
- **Serif and mono faces** — `liberation-serif` / `liberation-mono` are
  in the IR and the importers map Times / Courier to them, but no face is
  shipped (§4.10), so such text draws nothing with `NO_FONT`.
- **Rectangle grids** (OCAD rectangle symbol cell lines and numbering) —
  a by-design drop (user decision 2026-10-20); not pending, listed so the
  reader does not look for it.
