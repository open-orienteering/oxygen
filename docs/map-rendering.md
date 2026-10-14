# Map rendering

Status: **draft** — chapter of the vector map pipeline specification,
started by spike S1 (render harness). Sections marked *not yet specified*
are filled in as S1 steps 2–3 and slice B land. The research record this
chapter derives from is `docs/research/vector-map-pipeline/04-render-core.md`;
when the two disagree, this document wins.

This chapter is normative for the code in `packages/shared/src/render/`,
`packages/api/src/render/` and (later) `packages/web/src/map-gl/`.

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
  plus the `taper` (linear width reduction over `startUm` / `endUm`).
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

`{ kind: "text", colour, fontId, sizeUm, glyphs, positions, haloWidthUm? }`

Shaped text: one glyph id and one baseline origin per glyph, em size in µm
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

*Not yet specified.* S1 step 2 brings the pilot symbol set (101 contour,
505 footpath with OCAD and OMAP dash fitting, 418 point glyph, 407/213
patterns, 709 hatch, 704 text with halo); the rules land here as each is
implemented, with the fixture in §6.3 that proves it.

## 5. Backends

### 5.1 Reference raster (api, tests only)

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
purpose and is never used for production rendering.

### 5.2 WebGL2 (web)

*Not yet specified.* S1 step 3. Fixed points from 04: custom WebGL2 in
`packages/web/src/map-gl/`, arena buffers prepared in a worker, even-odd
fills via stencil, strokes extruded on the CPU, glyphs instanced, hatches
by stripe shader, text as MSDF, colour-major draw order from the stream.

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
(254 dpi) unless the fixture says otherwise. The WebGL2 backend renders
the same stream in headless Chromium (Playwright) and the PDF backend's
page is rasterised with `pdftoppm` at the same density. Each is compared
with the oracle by `diffImages(a, b, channelTolerance = 16)`: a pixel
differs when any channel differs by more than 16/255; the fixture passes
when the fraction of differing pixels is ≤ 0.5 % (04 §9 budget), or a
tighter per-fixture budget. Backends are compared with the oracle, never
with each other.

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

Symbolisation fixtures (one per rule, 04 §8 table) are added alongside
each rule in §4.

## 7. Where things live

| Path | Contents |
|---|---|
| `packages/shared/src/render/pass-stream.ts` | types, flags, sort, builder |
| `packages/shared/src/render/path.ts` | path walkers, Bézier split, arc length, hatch lines |
| `packages/shared/src/render/stream-json.ts` | JSON projection, `diffPassStreams` |
| `packages/shared/src/render/reference-svg.ts` | SVG serialiser (oracle, stage 1) |
| `packages/shared/src/render/__fixtures__/streams/` | contract fixtures |
| `packages/api/src/render/reference-raster.ts` | resvg rasterisation, `sampleAt`, `diffImages` |
| `packages/web/src/map-gl/` | WebGL2 backend (*not yet*) |

The shared module is exported as a namespace: `import { render } from
"@oxygen/shared"` → `render.PassStream`, `render.passStreamFromJson`, …
(namespaced to keep `Bounds`, `Segment` etc. from colliding with
`course-maps`).
