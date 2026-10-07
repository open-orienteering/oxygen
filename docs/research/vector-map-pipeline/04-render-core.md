# 04 — Render core

Status: proposed 2026-10-07 (recommendation §10); awaiting decision.
Depends on: [01](01-tiling-vs-whole-document.md) (whole-document delivery,
client-side buckets, budgets), [02](02-document-format.md) (int32 paper
units, coordinate flags, colour table), [03](03-symbol-model.md) (the
`RenderSymbol` IR, the colour stack, the §6.9 semantics this topic must
pin). Feeds: 05 (print consumes the same pass stream), 06 (import warnings
for unsupported features, symbol previews in the review UI), 08 (course
editor: hit-testing, dynamic objects, overlay), 09 (migration off tiles and
librsvg).

## The question

Objective 3 of the README is one rendering core for screen and print.
Topic 03 reduced every symbol to one IR and stated that "rendering reduces
any `RenderSymbol` to passes — `(colour, primitive)` pairs". This topic
decides what that reduction is, where it runs, and how the passes are
drawn:

1. **Where is the boundary between shared and backend code?** Which parts
   of drawing an orienteering map are *semantics* (and must therefore be
   computed once, identically, for the GL viewer and the PDF) and which are
   *rasterisation* (and may differ per backend)?
2. **Which GPU stack** draws the screen: a custom WebGL2 renderer, a
   general GL framework (deck.gl, MapLibre, PixiJS), or a 2D vector engine
   compiled to WebAssembly (CanvasKit, Vello)?
3. **How is each primitive drawn on the GPU** — fills, strokes with
   caps/joins, adaptive dashes, repeated glyphs, point grids with clip
   modes, hatches, text with halos — in colour order, anti-aliased, at
   60 fps on a phone, with the whole document resident per 01?
4. **What must be true for editing** (08) and tests (§8) to be possible
   without rework: hit-testing, per-object updates, golden images.

Prior art examined: MapLibre GL JS / Mapbox GL (line extrusion, dash
atlas, earcut over stencil), deck.gl 9.4 (orthographic view, path and
fill-style extensions, bundle cost), PixiJS v8, Skia/CanvasKit, Vello,
Purple Pen and OpenOrienteering Mapper (CPU renderers for the same
symbol model), and the browser platform state as of October 2026 (WebGL2,
WebGPU, OffscreenCanvas, MSAA behaviour on mobile). Workload numbers come
from a new corpus measurement (`measure-render.mjs`, §3) alongside the
tessellation measurements from 01.

## 1. Requirements, by consumer

| Consumer | Needs from the render core |
|----------|---------------------------|
| Viewer / course editor (web) | Draw a whole document (01) in paper space at 60 fps with pan, zoom (≈ 0.05× to 20× paper size) and **rotation** (display north, `docs/map-tile-rendering.md` "North"), on a mid-range phone and a laptop. Colour-stack order exact. Overlays — course overprint, GPS tracks, runner positions, selection — drawn by the same core (overprint) or above it (UI) in paper coordinates via the georeference. Hairline floor when zoomed out (03 §6.9 item 10). |
| Print / PDF (05) | The *same* pass stream: identical dash positions, glyph placements, pattern instances, text placement and colour order; geometry as vector paths (not pre-flattened at screen tolerance); CMYK per colour; no screen-only minimum sizes. |
| Import review (06) | Render one symbol in isolation (library entry or source symbol) to a small image for the matching review UI; render a whole document to a thumbnail server-side. |
| Course editor (08) | Hit-testing from screen point to object(s) with the symbol's drawn shape (not just bbox); per-object show/hide and move without re-preparing the whole map; a dynamic layer for the object under edit; course symbols 7xx drawn as objects in upper purple. |
| Light map editing (future, 08) | Everything the course editor needs, plus re-symbolisation of a single object after an edit and appending objects to a resident document without a reload. |
| Tests | Deterministic, backend-independent output of the shared stage (dash counts and positions, instance transforms, text layout) assertable in unit tests; golden images per 03 §6.9 rule; the GL backend testable in headless Chromium (Playwright) against the CPU reference. |
| Operations | No native dependencies for the screen path; the server-side paths (PDF, thumbnails) must build in the production Docker image (`docs/course-maps.md` lists today's `librsvg2-bin fonts-liberation`). |

Out of scope here: the document format and loading (01, 02), symbol
matching (03/06), PDF page composition and CMYK handling (05), the editor's
domain model (08). The overprint *symbols* are library entries (03 §9
point 8); this topic only has to draw them like any other object.

## 2. Current state, and what it teaches

Today the base map is drawn two ways and the overprint three ways:

| Path | Base map | Overprint | Where |
|------|----------|-----------|-------|
| Live viewer | Web-Mercator PNG tiles: `ocad2geojson` → SVG string → resvg per 256×512 block, ~6 s cold per block of which ~5.7 s is SVG parsing | React SVG in screen pixels (`MapViewer.tsx`, 3 554 lines, own geometry code) | `packages/api/src/map-tiles.ts`, `packages/web/src/components/{TileLayer,MapViewer}.tsx` |
| Layout editor | The same tiles | Shared paper-mm SVG fragments (`packages/shared/src/course-maps/`) positioned by the editor | `docs/course-maps.md` |
| Print | Paper-mm SVG (`ocadToSvg` full + ink) → `rsvg-convert` → `pdf-lib` | The shared fragments composed into the page SVG | `packages/api/src/course-maps/` |

The lessons that shape this topic:

- **Semantics leaked into a serialisation.** Dash layout, glyph
  placement and pattern tiling are decided inside `ocadToSvg` and then
  re-interpreted by two rasterisers (resvg, librsvg) with different
  pattern-tile behaviour (`docs/bugfix-librsvg-pattern-tile-size.md`),
  different font handling and different anti-aliasing. The fix is to make
  the *decisions* explicit data and the rasterisers dumb.
- **Parsing dominates.** 5.7 of 6 s per tile block is SVG parsing: the
  text format, not the drawing, is the cost. A binary pass stream handed
  to a GPU has no such step.
- **Three overlay implementations drift.** Control circle radius, line
  gaps and number placement exist as SVG fragments *and* as React code in
  screen pixels. With 03 making 7xx symbols library entries, the overlay
  becomes ordinary objects and the drift ends only if the viewer draws
  those objects through the same core as print.
- **Fonts are a deployment fact.** Print depends on `fonts-liberation`
  being present; the web has whatever the OS has. A single bundled font
  set used by both backends (§4.4) removes the divergence.
- **rsvg-convert stays the only PDF rasteriser** today because the
  alternative rasterised patterns (14 s vs 0.8 s). In the new design the
  PDF backend emits paths directly from the pass stream, so there is no
  SVG and no converter (05 decides the PDF writer).

## 3. Workload measurements

`measure-render.mjs` (local, next to the 01 scripts) walks every object of
a map, resolves its symbol and counts what a renderer would actually have
to draw. Dash segments are estimated as `length / (dash + gap)` per dashed
line, glyph instances as `length / period × glyphsPerPeriod`, pattern
instances as `area / cellArea`. Hidden symbols are skipped (Club-full has
881 objects on hidden symbols, 494 of them text — mapper's notes — which
is why only 199 of its 693 text objects are drawn). The phone column
assumes a 50 × 110 mm paper window at 1× and *uniform* density; the
densest cells in 01 §2.2 are ~2.5× the average, so multiply by 2.5 for a
worst-case viewport.

| | Club-full | Club-2026 | Sprint | Crop-A | Crop-B |
|---|---|---|---|---|---|
| Paper extent (mm) | 1 169 × 651 | 326 × 438 | 425 × 389 | 89 × 129 | 137 × 98 |
| Drawn objects | 100 839 | 45 628 | 10 680 | 3 020 | 4 927 |
| Colours used / in table | 62 / 81 | 48 / 67 | 36 / 42 | 27 / 122 | 25 / 154 |
| Line objects; total length (paper m) | 44 045; 335 | 19 770; 141 | 4 481; 48 | 1 649; 13 | 2 135; 17 |
| Dashed lines → dash segments | 14 096 → 51 020 | 7 209 → 25 760 | 386 → 1 903 | 490 → 2 352 | 585 → 2 751 |
| Lines with glyphs → glyph instances | 21 270 | 8 119 | 1 261 | 891 | 922 |
| Corner glyphs | 365 | 156 | 0 | 29 | 27 |
| Double lines | 2 564 | 1 026 | 392 | 14 | 36 |
| Areas: fill / hatch / pattern | 37 249 / 1 792 / 3 331 | 16 065 / 1 039 / 1 028 | 4 893 / 50 / 259 | 373 / 120 / 66 | 1 149 / 114 / 106 |
| Pattern instances (whole map) | 48 764 | 16 448 | 7 985 | 645 | 1 574 |
| Areas with border symbol | 91 | 28 | 1 179 | 6 | 3 |
| Point objects | 16 741 | 8 145 | 1 257 | 853 | 1 507 |
| Text objects; characters | 199; 2 224 | 85; 803 | 0; 0 | 1; 11 | 3; 24 |
| Objects with Bézier segments | 30 690 | 15 949 | 3 935 | 1 592 | 2 013 |
| Source coordinates | 1 510 022 | 636 372 | 122 422 | 53 322 | 71 028 |
| Phone viewport (uniform): dash segs / glyphs / pattern inst. / points / coords | 368 / 154 / 352 / 121 / 10.9 k | 990 / 312 / 632 / 313 / 24.5 k | 63 / 42 / 265 / 42 / 4.1 k | 1 132 / 429 / 310 / 410 / 25.7 k | 1 125 / 377 / 644 / 616 / 29.0 k |

From 01 §2.2 (`measure-tess.mjs`, flattening tolerance 0.02 mm):

| | Club-full | Club-2026 | Sprint | Crop-A |
|---|---|---|---|---|
| Flattened coordinates | 1.95 M | 872 k | 193 k | 79 k |
| Area triangles (earcut) | 622 k | 271 k | 110 k | 19 k |
| earcut time, whole map | 99 ms | 45 ms | 35 ms | 9 ms |
| Flatten + tessellate, whole map | 311 ms | 145 ms | 79 ms | 38 ms |
| Estimated stroke vertices (extruded) | 5.73 M | 2.57 M | 307 k | 278 k |
| Eager GPU bytes at 16 B/stroke vertex, 24 B/fill vertex | 109 MB | 49 MB | 7.4 MB | 5.1 MB |

Three conclusions:

1. **GPU throughput is not the constraint.** The *whole* Club-full map is
   ~6 M stroke vertices, 622 k fill triangles, ~90 k glyph instances; a
   phone viewport holds a few thousand of each. Any technique that avoids
   per-object draw calls is fast enough. The constraints are CPU
   preparation time (01's parse + index + tessellate budget), **GPU
   memory** for the resident set, and **draw-call count** per frame.
2. **Dashes, glyphs and patterns are small in count but large in
   semantics.** 51 k dash segments is nothing for a GPU, but *where* each
   dash falls (03 §6.9 item 1) is the thing print and screen must agree
   on. That is the argument for laying them out once on the CPU (§4).
3. **Text is rare in base maps and critical in the overlay.** 199 text
   objects in the largest map, zero in the sprint map; the control numbers
   (704) and descriptions are where text quality is judged. A text
   technique optimised for a few hundred crisp glyphs at any zoom is
   enough; there is no need for a general text engine.

## 4. Architecture: one symbolisation stage, several backends

### 4.1 Pipeline

```
                   Document (02): objects + source IR + matches + colour stack (03)
                                            │
                     ┌──────────────────────┴──────────────────────┐
                     │   Symbolisation (shared, pure TypeScript,   │
                     │   @oxygen/shared/render, runs in a worker)  │
                     │                                             │
                     │  resolve(symbolIdx) → RenderSymbol          │
                     │  sections (corner / dash points) → dash     │
                     │  layout (OCAD or OMAP) → slices             │
                     │  glyph placement → instance transforms      │
                     │  pattern grid → instance transforms + clip  │
                     │  text shaping → positioned glyph ids        │
                     │  hatch params; halos split into own passes  │
                     └──────────────────────┬──────────────────────┘
                                            │  PassStream (binary-friendly,
                                            │  µm paper units, Béziers intact)
          ┌───────────────────┬─────────────┴──────────────┬─────────────────────┐
          ▼                   ▼                            ▼                     ▼
   WebGL2 backend      WebGPU backend (later)      PDF backend (05)       Reference raster
   (packages/web)      same tessellation,          paths → PDF ops,      (API / tests):
   flatten @ screen    WGSL shaders                CMYK, clip paths,     pass stream → SVG
   tolerance, earcut,                              embedded fonts        → resvg PNG, or
   extrude, instance,                                                    Canvas2D
   MSDF text
```

The rule for the boundary: **anything whose result a user could measure
with a ruler on the paper is symbolisation; anything that depends on
pixels is backend.** Dash positions, glyph positions and angles, pattern
cell positions and inclusion, hatch line positions, text baseline and
advances, which colour pass a shape belongs to — all symbolisation. Bézier
flattening tolerance, stroke extrusion, triangulation, anti-aliasing,
minimum pixel widths, atlas textures — all backend.

### 4.2 The pass stream

Sketched as TypeScript; the concrete representation is typed arrays per
bucket (01 §6), so a worker can transfer it and a backend can upload it
without re-walking objects. Lengths are **µm at the document's reference
scale** as in 03, already multiplied by `documentFactor` (03 §6.6).

```ts
// Geometry is kept as path segments, not flattened: PDF emits Béziers,
// GL flattens at its own tolerance. A slice is a sub-range of a path in
// (segment, t) space — the output of dash layout — so a dashed Bézier
// stays a Bézier in print (de Casteljau split) and is flattened per dash
// on the GPU side.
interface Path { coords: Int32Array /* x,y pairs */; flags: Uint8Array /* 02 §3 bits */; closed: boolean }
interface Slice { seg0: number; t0: number; seg1: number; t1: number }

type Pass =
  | { kind: "fill";    colour: number; path: Path; rule: "nonzero" }            // holes via flag 16, orientation normalised
  | { kind: "stroke";  colour: number; path: Path; slices?: Slice[];           // undefined = whole path
      widthUm: number; cap: Cap; join: Join; taper?: { startUm?: number; endUm?: number } }
  | { kind: "glyph";   colour: number; glyphId: number; partIdx: number;       // one pass per glyph *part colour*
      instances: Float32Array /* x, y, cos, sin, scale ×n */; clip?: Path }     // clip only for pattern mode "clip"
  | { kind: "hatch";   colour: number; path: Path; widthUm: number; spacingUm: number; offsetUm: number; angleDeg: number }
  | { kind: "text";    colour: number; fontId: number; sizeUm: number;
      glyphs: Uint16Array /* glyph ids */; positions: Float32Array /* x, y per glyph, paper µm */;
      haloWidthUm?: number }                                                    // set only on the halo pass, which is a separate pass in the halo colour

interface PassStream {
  objectIdx: Uint32Array;      // per pass → owning object (hit-testing, per-object hide)
  passes: Pass[];              // sorted by (colour, kind) within a bucket
  glyphTable: GlyphMesh[];     // one entry per distinct Glyph part, geometry in glyph-local µm
  fontTable: FontRef[];
}
```

What is deliberately *not* in the stream: screen-space anything, triangle
indices, extruded stroke geometry, texture coordinates. Those are the
backend's derived data and are rebuilt when the backend's parameters
(tolerance, atlas) change.

### 4.3 Shared vs backend-specific

| Concern | Shared (symbolisation) | Backend |
|---|---|---|
| Section splitting at corner/dash points (02 §3 flags 4, 8) | yes | — |
| Arc length of Bézier segments (needed for dashes and glyph spacing) | yes — computed by fixed-rule adaptive subdivision (1 µm tolerance) or Gauss–Legendre, *independent of any backend's flattening* | — |
| OCAD and OMAP dash fitting (03 §6.9 items 1–2) | yes → `Slice[]` | flatten each slice at own tolerance |
| Glyph placement, orientation, min count, corner scaling (item 3) | yes → instance transforms | tessellate glyph mesh once, draw instanced |
| Pattern grid origin, angle, shifted rows, clip mode decision (item 4) | yes → instances (+ clip path for mode "clip") | stencil or clip path |
| Hatch angle/offset convention (item 5) | yes → parameters; a shared `hatchLines(path, params)` function exists for backends that need explicit lines (PDF) | GL draws stripes procedurally in the fragment shader with the same formula |
| Border shift and shared dash phase (item 6) | yes → border strokes are ordinary stroke passes with their own slices | — |
| Hole flags, orientation normalisation (item 7) | yes | triangulation / fill rule |
| Text shaping: font selection, advances, kerning, line breaking, alignment, digit-height sizing (item 8) | yes, from bundled font metrics | rasterisation (MSDF or outlines), PDF font embedding |
| Halos as own-colour passes (item 9) | yes | — |
| Minimum pixel sizes (item 10) | — | screen backends only |
| Colour-major ordering | pass sort key | draw order / depth |
| Bézier flattening | — | per backend tolerance: screen ≈ 0.25 px, PDF ≈ 0.005 mm, reference raster ≈ 0.01 mm |

Determinism follows: two backends given the same pass stream draw the same
dash in the same place because the dash is *data*. Differences are confined
to sub-pixel rasterisation, which the test harness (§8) tolerates.

### 4.4 Fonts and text

Base maps in the corpus use Arial and Arial Narrow (place names, 8xx club
symbols); the library needs one sans-serif for 704 control numbers, 603
spot heights, and descriptions. Both backends must place letters
identically, which requires the *same font files* on both sides. Proposal:

- Bundle **Liberation Sans** and **Liberation Sans Narrow** (SIL OFL;
  metric-compatible with Arial and Arial Narrow, which is what makes the
  mapper's text boxes keep their line breaks). Note the Narrow face exists
  only in the Liberation 1.07 series — Debian's `fonts-liberation`, which
  the API image already installs, is 1.07 and includes it; `fonts-liberation2`
  does not.
- Shaping in the shared stage from the fonts' metrics (advances, kerning
  pairs, digit height per font — 03 §6.9 item 8: ISOM 704 specifies 4.0 mm
  *digit* height, which for Arial-metric fonts is ≈ 5.59 mm em). Latin
  script with simple left-to-right shaping is sufficient; a full shaper
  (HarfBuzz via wasm) is not needed for orienteering maps and would cost
  several hundred kB of download.
- Font fallback is an *import* decision (06): unknown font names map to
  Liberation Sans with a warning in the import report, so the document
  records the font actually used and both backends agree.
- OCAD formatted text (`otp 5`, 13 objects in Club-full) is laid out by the
  same shared line-breaker inside its box; the box's margins and paragraph
  rules are IR fields (03 `TextSymbol`).

### 4.5 Placement in the monorepo and where it runs

- `packages/shared/src/render/` — symbolisation, path/arc-length utilities,
  dash and glyph layout, text shaping, hit-testing geometry (§7). Pure
  functions over typed arrays; no DOM, no `fs`. Unit-tested with the §8
  fixtures.
- `packages/web/src/map-gl/` — the WebGL2 backend: bucket manager, flatten
  + earcut + extrude workers, GPU resource arena, shaders, frame loop.
- `packages/api/src/render/` — the PDF backend (05) and the reference
  raster for thumbnails and golden tests.

In the browser, parsing (02), indexing (01), symbolisation and the
backend's CPU work (flatten, tessellate, extrude) all run in a **Web
Worker**; the main thread receives transferable typed arrays per bucket and
issues GL calls. OffscreenCanvas with a WebGL2 context in a worker is
available in Chrome 69+, Firefox 105+, Safari/iOS 17+ (~95 % of users), so
the frame loop *can* move into the worker later; the design keeps the
renderer DOM-free so that is a mechanical change. Start with GL on the main
thread: the per-frame work (bind, draw ≈ 250 calls, §6.8) is well under a
millisecond of CPU and avoids the OffscreenCanvas input-latency and
`devicePixelRatio` plumbing.

## 5. Stack options for the GPU backend

Platform facts (October 2026) that bound the choice:

- **WebGL2** is in every evergreen browser including Safari 15+ (2021).
- **WebGPU** ships in Chrome 113+ desktop, Chrome 121+ Android, Chrome 144+
  Linux (Intel Gen 12+ only), Safari 26+, Firefox 141 on Windows and 145 on
  macOS ARM; Firefox Linux/Android are still pending. Roughly 88 % of
  global traffic; club volunteers' older Android phones and Linux laptops
  are the gap. A WebGL2 baseline is therefore mandatory for several years;
  WebGPU is an optional second backend, not a replacement.
- **MSAA** on mobile GPUs is effectively "4× or nothing": drivers coerce
  2× to 4×, and the WebGL2 spec requires the `antialias` attribute to be
  honoured. Query `SAMPLES` and plan for 4× (5 coverage levels per edge).
- **OffscreenCanvas + WebGL2 in workers**: see §4.5.

| Option | What it gives | What it lacks for this problem | Weight | Verdict |
|---|---|---|---|---|
| **A. Custom WebGL2 renderer** (own shaders, own buffer management; ~6 shader programs: fill, stroke, instanced glyph, hatch, MSDF text, stencil/clip) | Exactly the primitives of §6 with paper-space units, colour-major order, and the shared-stage contract; no CRS impedance; WebGPU port is a second small backend behind the same interface | Everything is ours to write and debug: ~3–4 k lines plus shaders; no community | ≈ 15–25 kB gz + earcut (3 kB) + flatbush (2 kB) | **Recommended.** The hard parts (dash/glyph/pattern/text layout) are shared-stage code we must write regardless; the GPU part is well-trodden (MapLibre's line technique is documented and public). |
| **B. deck.gl 9.4** (`OrthographicView`, `COORDINATE_SYSTEM.CARTESIAN`, `SolidPolygonLayer`, `PathLayer` + `PathStyleExtension`, `IconLayer`/`TextLayer`, `FillStyleExtension`) | Mature WebGL2 *and* WebGPU core, picking, analytic AA, orthographic 2D with Cartesian coordinates works today; `PathStyleExtension` dashes in common units; `visgl:webgl-only` build condition | Dashes are *not* adaptive (ours arrive pre-cut, so `PathLayer` with solid segments is fine — but then the extension buys nothing); `IconLayer` is a raster atlas (glyphs blur at zoom); pattern clip modes and map-origin grids need custom layers; colour-major order across buckets means one layer per (colour, kind) — hundreds of layers with per-layer per-frame overhead; min-pixel width and taper need shader injection; paper-µm precision via `fp64` costs | 145 kB gz core + 40 kB layers (WebGL-only build) | Viable prototype accelerator; the remaining 30 % (vector glyphs, clipping, ordering, hairline rules) is custom WebGL inside deck.gl's framework. Not chosen, but noted as the fallback if A stalls. |
| **C. MapLibre GL JS** (6.x) with a custom "projection" | Best-in-class line and label rendering, collision detection, huge community | No paper-space CRS in a release: the `simple`/identity CRS lives on an in-progress branch (issue #168); style-spec primitives (`line-dasharray` in screen units, `fill-pattern` as texture, `symbol` placement by its own rules) encode *web-map* semantics, not ISOM's; we would fight its tile model (01 decided whole document) | ~250 kB gz | Not suitable. |
| **D. PixiJS v8** (WebGL + WebGPU 2D scene graph) | Fast batching, `Graphics` API with caps/joins, texture fill patterns, WebGPU today | No dashes (the single biggest primitive in our corpus), no vector patterns with clipping, scene-graph object model at odds with 100 k objects, texture-based pattern fills | ~110 kB gz | Not suitable. |
| **E. CanvasKit / Skia (wasm)** | Full 2D vector semantics (dashes via path effects, clip paths, text shaping, PDF backend *in Skia*) — on paper the one-engine answer for screen and print | The npm build ships without the PDF backend (forks with `--enable_pdf` exist, ~7 MB wasm); SkPDF expands path effects into geometry anyway; Skia's dash is non-adaptive so dash layout would still be ours; 2.5–7 MB download and wasm startup on phones; a C++ dependency in the web build | 2.5–7 MB | Not suitable as the primary; its *idea* — one engine both sides — is realised more cheaply by the shared pass stream. |
| **F. Vello / `vello_hybrid`** (Rust compute-shader 2D renderer, wasm) | Resolution-independent compute rasterisation, exact AA, strokes and dashes native | Alpha quality; WebGPU-centric (the WebGL2 `vello_hybrid` backend exists since May 2025 but panics on masks, some blend modes and complex filters); Rust toolchain in the build; no PDF | ~1 MB+ wasm | Watch; revisit for the WebGPU backend in 2–3 years. |

Two engines looked at for *how they draw*, not as dependencies: Purple Pen
(C#, GDI+/WPF/Skia CPU rendering of the same OCAD-derived symbol model)
and OpenOrienteering Mapper (Qt CPU rendering). Both lay out dashes and
glyphs on the CPU and hand solid primitives to the rasteriser — the same
split as §4.1, which is reassuring for its correctness and shows the GPU
part is purely an acceleration of the final step.

## 6. GPU techniques per primitive

Everything below is the WebGL2 backend; a WebGPU backend reuses the CPU
side unchanged and ports the shaders to WGSL.

### 6.1 Fills

Two established approaches:

- **Tessellate on the CPU (earcut)** into triangles, upload, draw. Cost is
  CPU time (99 ms for all 622 k triangles of Club-full; ~1 ms per bucket)
  and robustness: earcut is not exact for self-intersecting or degenerate
  rings and gives no error, only a `deviation()` estimate.
- **Stencil-then-cover**: draw a triangle fan from any vertex with stencil
  INCR on front faces / DECR on back faces, then draw the bounding quad
  where stencil ≠ 0. No tessellation, exact for any polygon including
  self-intersections, but two draws per polygon *set* per colour, a
  stencil clear between colours, and poor behaviour with many overlapping
  polygons (Mapbox switched from stencil to earcut for exactly that
  reason, mapbox-gl-js issue #682). Also interacts with MSAA: the cover pass must be the
  AA'd one.

Choice: **earcut per polygon with holes** (flag-16 rings, orientation
normalised as 02 §3), one vertex buffer per bucket, triangles sorted by
colour so a colour pass is a contiguous index range. Use
`earcut.deviation()` on every polygon at preparation time; polygons above a
threshold (say 1 % of area) are recorded in a per-document list and drawn
by stencil-then-cover as the exception path. The corpus will tell us how
often that happens (expected: a handful of mapper mistakes per club map).
Fill edges are anti-aliased by MSAA only (§6.9): shared edges between
adjacent polygons must not get analytic feathering or they show seams.

### 6.2 Strokes

The standard GPU technique (Mapbox 2013, MapLibre today): for each
polyline vertex emit **two vertices with a unit normal** (±), and let the
vertex shader offset by `normal × halfWidth` so width is applied at render
time. Vertex layout per stroke vertex: position (bucket-relative, §6.10),
normal (2 × int8 as MapLibre does), half-width scale factor (uint8, for
tapers), misc flags (uint8): 8 bytes. That halves the 16 B/vertex eager
estimate in §3 (Club-full strokes: 46 MB instead of 92 MB).

- **Joins**: miter with a limit of ~2× width (beyond which bevel), round
  joins and caps via a few fan vertices or — MapLibre's way — by passing
  the normal through to the fragment shader and discarding fragments
  outside the circle. Caps `flat | square | round` as geometry at the
  ends.
- **Pointed caps and tapers** (`cap: "pointed"`, `taper`, OCAD decrease):
  because half-width is a per-vertex factor, a taper is extra vertices
  along the taper length with factor decreasing to 0. Free.
- **Width in paper units**, not pixels: an ISOM line is 0.14 mm wide at
  every zoom, so the ribbon scales with the map. The vertex shader receives
  `pixelsPerUm`; width in pixels is `widthUm × pixelsPerUm`.
- **Screen-only hairline floor** (03 §6.9 item 10): when the pixel width
  falls below ~1 px, clamp the ribbon to 1 px and multiply alpha by the
  true width — coverage-preserving thinning. Zoomed out, contours fade
  into a tint rather than aliasing or vanishing abruptly. Never emitted by
  the PDF backend because it is a shader uniform, not stream data.
- **Analytic anti-aliasing** on strokes: the interpolated normal gives the
  distance from the centre line; a 1-px feather at the edge
  (`smoothstep`) gives smooth thin lines that 4× MSAA alone cannot
  (5 coverage levels make 1-px diagonals "ropy"). Strokes blend over the
  fills already in the framebuffer (§6.8).
- **Halos** (line framing, 502 in the club sets) are separate stroke
  passes in their own colour and width — nothing special on the GPU.

### 6.3 Dashes

MapLibre draws dashes with an SDF dash atlas sampled along the line's
accumulated length because its dash pattern is defined in *screen* units
and re-fits at every zoom. Ours is the opposite: ISOM dash lengths are in
paper mm, the count per section is fitted once (03 §6.9 item 1), and the
result is zoom-independent. So dashes are **laid out on the CPU in the
shared stage and arrive as slices**; the GPU draws them as ordinary
stroked sub-paths. Benefits: exact print parity, no atlas, caps on every
dash for free, secondary gaps and end dashes are just more slices.
Cost: more vertices — 51 k dash segments × ~6 vertices ≈ 300 k for
all of Club-full, i.e. ~5 % of the stroke total. Nothing to optimise.

### 6.4 Glyphs (point symbols, line glyphs, pattern glyphs)

A `Glyph` (03 §6.2) is a small vector drawing in glyph-local µm whose size
scales with the map, so its geometry is fixed: **tessellate each distinct
glyph part once** (strokes extruded at their fixed width, fills via earcut,
rings/discs as fans) into a shared `glyphTable` mesh, and draw every
placement with **instancing** (`drawElementsInstanced` with per-instance
`x, y, cos, sin, scale` from the pass stream). One draw per (glyph part
colour, bucket range) — a glyph whose parts have different colours becomes
one instanced draw per part colour, each at that colour's stack position,
which is exactly the colour-order semantics.
Club-full has 16.7 k point objects + 21 k line glyphs + 48.8 k pattern
instances for the whole map; a dense phone viewport a few thousand. Glyphs
smaller than ~2 px on screen are skipped (screen-only LOD, §6.11).

### 6.5 Patterns and clip modes

Instances come from the shared stage (grid anchored at the map origin for
OCAD, per-object angle, shifted rows). The four clip modes (03 §6.2) split
in two:

- **`completelyInside | centreInside | partiallyInside`** are *inclusion
  decisions*, made on the CPU by point-in-polygon / bbox tests against the
  area (with holes), identically for print. No GPU clipping at all.
- **`clip`** needs real clipping of glyph geometry to the polygon. GPU:
  write the area's already-tessellated triangles to the **stencil
  buffer** (set to 1), draw the instances with `EQUAL 1`, clear. Because
  OCAD anchors regular patterns at the map origin, all areas of the same
  symbol with angle 0 share one grid — so instances can be de-duplicated
  per symbol and drawn once against the *union* stencil of those areas.
  Per-object angles fall back to a per-object stencil pass; the corpus has
  few of those (`measure-render.mjs` can count `ang ≠ 0` on area objects
  when tuning). PDF: clip path per area (05).

### 6.6 Hatches

Hatches could be emitted as explicit clipped line segments (shared
`hatchLines()` does that for PDF). On the GPU it is cheaper and
resolution-independent to **draw the area's triangles with a stripe
fragment shader**: compute the paper-space coordinate's signed distance to
the nearest stripe centre (`mod(dot(p, dir) − offset, spacing)`), compare
with `width/2`, anti-alias with `fwidth`. Two directions = two passes or
one shader with two stripe sets. The angle and offset convention is one
shared function (03 §6.9 item 5) that the GLSL mirrors; a fixture compares
the two (§8). 1 792 hatched areas in Club-full, 50 in the sprint map.

### 6.7 Text

Options for drawing shaped glyphs:

- **MSDF atlas** (multi-channel signed distance field, `median(r,g,b)`
  decode, derivative-based AA): one texture per font (Liberation Sans +
  Narrow, Latin-1 + Latin Extended-A for Nordic names ≈ 400 glyphs each),
  generated at build time with `msdf-atlas-gen`; crisp at any zoom from
  one atlas; **halos come for free** by widening the threshold in a
  separate pass drawn at the halo colour's stack position (03 §6.9
  item 9, the ISSprOM 704 white outline). Known weakness: very small sizes
  (< ~6 px) lose sharp corners — irrelevant, text that small is hidden
  anyway (§6.11).
- **Tessellated outlines** (glyph contours flattened and triangulated like
  any fill): geometrically exact and identical to the PDF's embedded
  outlines, but anti-aliasing thin stems with 4× MSAA shimmers, and the
  halo needs outline stroking.

Choice: **MSDF for the screen backend, embedded outlines in PDF**; both
place glyphs from the shared shaping result, so the only difference is
rasterisation. Text passes are drawn like glyph passes (instanced quads,
one draw per colour range). Size and position are in paper µm, so text
scales with the map exactly as print does; the editor can additionally
draw screen-fixed UI labels, but those are UI, not map.

### 6.8 Colour order, batching and draw calls

The semantics are painter's order by colour-stack index. Within one
colour, order between objects does not matter for opaque IOF colours
(all colours in 03 are opaque; `overprint` is a print hint). The budget
problem is draw-call count: with the 01 bucket scheme a laptop viewport at
1× paper scale is ~500 × 280 mm ≈ 60 buckets (+ margin ≈ 80); naive
"per colour, per kind, per bucket" is `62 × 4 × 80 ≈ 20 000` draws per
frame — far too many (WebGL call overhead is tens of µs each).

Design:

1. **Arena buffers per primitive kind**, not per bucket: one large vertex
   buffer (and index buffer) per kind with sub-allocations per bucket
   (free-list; eviction frees the range). Buckets remain the unit of
   preparation and residency, not of drawing.
2. **A visible-set index buffer per (colour, kind)**, rebuilt only when the
   set of visible buckets changes (a few times per second while panning,
   never while zooming in place): concatenate each visible bucket's index
   range for that colour. Draw calls per frame then = colours in view ×
   kinds ≈ `62 × 4 ≈ 250`, independent of bucket count. Rebuilding ~1 M
   indices is ~1–2 ms on the main thread, or done in the worker.
   `WEBGL_multi_draw` (where available) removes even the rebuild.
3. **Depth buffer as an optimisation for fills, not as the ordering
   mechanism.** Writing `depth = colourIndex` for opaque fills with a depth
   test that lets the higher index win allows all fills to be drawn in one
   pass, in any order, with early-z rejection of the overdraw that stacked
   area symbols produce (Club-full: 37 k fills,
   several layers deep in forest). Strokes/glyphs/text are then drawn in
   painter's order *with the depth test on* against the fills' depth, which
   makes "black building fill above brown contour stroke" correct
   automatically. Analytic-AA stroke fragments must not write depth. This
   is an optimisation to measure in the spike; the painter's-order path in
   (2) is the semantically obvious baseline and must be kept working as
   the reference.
4. **Overprint preview**: 03 marks `overprint` as a print-only hint. A GL
   multiply blend (`DST_COLOR, ZERO`) for flagged colours would preview
   it for a few lines of code; off by default, a view option at most. Not
   phase 1.

### 6.9 Anti-aliasing

- Request `antialias: true` (4× MSAA on mobile, 4–8× desktop) on the
  default framebuffer; fills rely on it. Query `SAMPLES` and expose it in
  the debug overlay.
- Strokes, glyph strokes and MSDF text use analytic AA in the fragment
  shader on top of MSAA.
- **Seams**: adjacent fills share edges only where the mapper snapped
  vertices; elsewhere hairline seams at high zoom are inherent to the data
  and visible in OCAD too. Do not feather fill edges (it makes seams
  worse); do keep bucket-relative coordinates (§6.10) so float error does
  not add seams of its own.
- Hatch stripes: `fwidth`-based AA; hatch *edges* come from the polygon's
  MSAA.

### 6.10 Precision and coordinate layout

The document is int32 µm (02). A 1.2 m club map spans 1.2 × 10⁶ µm, within
float32's 24-bit mantissa, but transforming absolute coordinates in the
vertex shader at 20× zoom loses sub-pixel precision at the far end of the
map. Standard remedy: **store vertices relative to the bucket origin**,
compute the bucket's model-view matrix in float64 on the CPU, upload as a
uniform. Within a 50 mm bucket, int16 at 10 µm (OCAD's own 0.01 mm
resolution) is lossless for OCAD data and halves position storage versus
float32; Béziers flattened at screen tolerance add points on the same
grid. Rotation (display north) is part of the view matrix, so north-up
glyphs rotate with the paper exactly as print does.

### 6.11 Buckets, level of detail and memory

01 §6 proposed a 50 × 50 mm paper grid plus an always-resident large-object
bucket. Tuning against the measurements:

- **Cell size.** Density per unit of *paper* is what matters for cell
  cost, and it is similar across scales: Club-full has 13 objects and
  ~750 stroke vertices per cm² on average (≈ 330 objects / 19 k stroke
  vertices per 50 mm cell; 2.5× that in the densest cells), Sprint 6.5
  objects and ~190 stroke vertices per cm². Preparation of one cell
  (flatten + earcut + extrude) is therefore ~3–10 ms in a worker, and a
  pan reveals at most a row of cells. One cell size, **50 mm**, for all
  scales; it is a constant to re-tune if a denser corpus map disagrees.
- **Large-object threshold.** Objects whose bbox exceeds 2 × 2 cells go to
  the resident bucket (long contours, roads, lake outlines, the map
  frame). Expected a few thousand objects per club map; measure in the
  spike; the threshold is a constant.
- **Zoom-gated preparation.** When a 0.14 mm line would render below
  ~0.15 device px even after the hairline floor (alpha < 0.15 — about
  0.28× paper scale on a 1× DPR laptop, 0.14× on a 2× DPR phone; a whole
  club map on a phone is ~0.03×) only fills and large-object strokes are
  drawn; stroke, glyph and text buffers of ordinary buckets are not even
  prepared. Event maps never reach the gate in practice (Crop-B at 0.14×
  is 72 CSS px wide), so they are simply fully resident. This caps the
  eager 110 MB of §3 to the fill set (~4 MB at int16 positions) plus
  large objects. When zoomed in, visible + margin buckets are prepared
  (strokes dominate: ~0.5 MB per dense cell at 8 B/vertex incl. strip
  overhead) and evicted LRU past a budget (01: 30 MB event maps, 150 MB
  club maps).
- **Overview texture (optional).** If zooming out on a phone still
  stutters, render the whole map once at low zoom to a 4 096² texture
  and show it below the zoom gate. Cheap to add later; not in the
  baseline.
- **Screen-only LOD rules**, all shader uniforms or draw-skips, none in
  the stream: hairline floor (§6.2), skip glyphs < 2 px, skip text < 4 px,
  skip hatch stripes when spacing < 1.5 px (draw a 50 % tint instead).

### 6.12 Frame loop

Render on demand (on view change, data arrival, edit), not continuously;
`requestAnimationFrame` only while an interaction or animation is active.
A frame: update visible set → (if changed) rebuild index buffers →
for each colour in stack order → for each kind → draw. Target ≤ 4 ms CPU,
≤ 8 ms GPU on a mid-range phone at 2× DPR with a dense viewport.

## 7. Editing and overlay hooks

Decided now so 08 does not have to retrofit them:

- **Hit-testing** is a shared-stage function over the document, not a GPU
  feature: flatbush R-tree candidates by bbox (01), then exact tests on
  the *symbolised* shape — point-in-polygon with holes for fills,
  distance-to-polyline ≤ half width (+ a screen tolerance) for strokes,
  instance bbox for glyphs and text, with the colour-stack order deciding
  which of several hits is "on top". This works identically for the editor
  and for tests, costs microseconds for the ~2 k objects of a viewport, and
  needs no readback. GPU id-picking (render object ids to an offscreen
  target) handles pattern cells and glyph shapes exactly and is the
  fallback if the editor ever needs pixel-exact picking.
- **Per-object identity in the stream**: `objectIdx` per pass (§4.2) and a
  per-object range table per bucket so an object can be hidden (skip its
  index ranges when building the visible-set buffers) or replaced.
- **Dynamic bucket**: objects under edit (dragged control, new path being
  drawn) live in a small always-resident bucket re-symbolised on every
  change (a single object: < 1 ms) and drawn in colour order *with* the
  static buckets, so the course overlay interleaves correctly with the
  base map's upper white and black. On commit the object moves to its
  static bucket, which is re-prepared asynchronously.
- **Course overprint is objects.** Controls, lines, numbers, descriptions
  and the layout items are objects with library symbols
  (`ISOM2017-2:701…`) in a per-course document layer (08), drawn by this
  renderer. Course-setting geometry rules (circle gaps where lines cross,
  line cutting at circles, number placement avoiding features) are
  *symbolisation* of that layer and so shared with print by construction.
- **UI layers** (selection outline, handles, GPS runners, cursor
  snapping) are drawn after the map with screen-space widths; they are
  explicitly not map and not in the pass stream. Selection *highlight* of
  a map object re-draws that object's passes with a highlight colour
  via the dynamic bucket.
- **Appending objects** (light map editing) is a new object in the dynamic
  bucket plus, on commit, a bucket re-prepare; symbols materialised into
  the source table (03 §1) are just new `glyphTable`/IR entries. Nothing
  in the renderer assumes a closed document.

## 8. Determinism and test fixtures

Two tiers, in increasing cost:

1. **Pass-stream assertions** (unit tests in `@oxygen/shared`, fast,
   exact): for a fixture object + IR, assert dash slice boundaries (as
   arc-length positions, to 1 µm), glyph instance transforms, pattern
   instance counts and inclusion, hatch line positions, text glyph
   positions, pass colour order. These are the real tests of 03 §6.9.
2. **Golden images** (three-way): the reference raster (pass stream → SVG
   → resvg, or Canvas2D) is the oracle; the WebGL2 backend renders the same
   fixture in headless Chromium under Playwright and is compared with a
   perceptual threshold (AA-tolerant); the PDF backend's output is
   rasterised (`pdftoppm`) and compared the same way. The oracle itself is
   checked against hand-measured expectations once and then committed.

Fixture list derived from 03 §6.9 (one file per row under
`packages/shared/src/render/__fixtures__/`):

| # | Rule | Fixture object | Assertions |
|---|---|---|---|
| 1 | OCAD dash fitting | 505 footpath, open and closed, with a corner point and a dash point mid-way; 507 with secondary gaps; `minSym` −1/0/2 | dash count per section, end-dash stretch, section reset at both flag types |
| 2 | OMAP dash fitting | OMAP 505 equivalent with `dashes_in_group 2`, `half_outer_dashes`, `show_at_least_one_symbol` | same |
| 3 | Glyph placement | 516 power line (spaced, rotatable), 201 cliff with tags (spaced, both sides), 529 wall with corner glyphs and `ignoreEnds`, closed path `minCountClosed` | instance count, positions, angles, corner scaling |
| 4 | Pattern origin and clip modes | 407 rough open with scattered trees at angle 0 and at 30°; 213 sandy ground in each of the four clip modes; shifted rows | instance positions identical for adjacent areas at angle 0; inclusion decisions; stencil correctness in image tier |
| 5 | Hatch | 709 out-of-bounds (single), 520 stripe variant, 714 crossed | line positions vs GLSL stripe function sampled at test points |
| 6 | Borders | 509 railway (dashed borders share phase), 502 road with asymmetric border widths, framing halo | border offsets, shared phase, halo at its own colour position |
| 7 | Holes and winding | Area with two holes, one reversed; self-touching ring | triangle coverage equals shoelace area; earcut deviation flagged for the degenerate case |
| 8 | Text metrics | 704 "31" at 4.0 mm digit height; 603 spot height left/centre/right aligned; a two-line `otp 5` box | em size from digit height, baseline positions, advances with kerning |
| 9 | Halos as own passes | ISSprOM 704 over black 521 building; 502 framing over 406 | pass order; the halo colour's stack position; image shows white between purple and black |
| 10 | Minimum sizes (screen only) | 101 contours at 0.03× | PDF backend emits 0.14 mm; GL backend width uniform clamps and alpha scales; image tiers differ by design — assert the stream, not the image |
| + | Colour order | A stack of fills/strokes/glyphs across 10 colours including lower and upper purple | pixel probes at overlap points |
| + | Precision | Objects at the far corner of a 1.2 m document at 20× | no visible jitter vs reference |

## 9. Effort

| Item | Estimate |
|---|---|
| Shared stage: sections, arc length, OCAD + OMAP dash layout, glyph placement, pattern grids + clip decisions, hatch params, halo splitting, pass sort | 3–4 weeks |
| Text shaping (metrics loading, advances, kerning, alignment, line breaking, digit-height sizing) | 1 week |
| WebGL2 backend: arena buffers, workers, flatten/earcut/extrude, 6 shaders, visible-set indices, stencil clip, MSDF text, LOD rules, debug overlay | 4–5 weeks |
| Reference raster backend (pass stream → SVG → resvg) and the §8 harness incl. Playwright golden run | 1–1.5 weeks |
| Hit-testing and dynamic bucket | 1 week |
| Tuning against the corpus on a phone (budgets below) | 1 week |
| **Total** | **≈ 11–14 weeks**, of which the shared stage and harness (≈ 5 weeks) are needed by 05 and 06 regardless of the GPU choice |

Using deck.gl (Option B) would save roughly two of the backend's weeks and
add them back as custom layers for glyphs, clipping and ordering.

### Budgets (extend 01's table)

| Metric | Event map (Crop-A/B, Sprint) | Club-full |
|---|---|---|
| Symbolisation, whole document, in worker | ≤ 100 ms | ≤ 800 ms |
| Prepare one 50 mm bucket (flatten + earcut + extrude) | ≤ 5 ms | ≤ 10 ms (dense cell) |
| Draw calls per frame | ≤ 300 | ≤ 300 |
| Frame CPU / GPU, mid-range phone, 2× DPR, dense viewport at 1× | ≤ 4 ms / ≤ 8 ms | same |
| Resident GPU memory | ≤ 30 MB | ≤ 150 MB (zoom-gated) |
| Fixture golden-image diff vs reference | ≤ 0.5 % pixels differing beyond AA tolerance | — |

## 10. Recommendation

1. **Split the core into a shared symbolisation stage and dumb backends**
   (§4). The stage lives in `@oxygen/shared/render`, is pure TypeScript
   over typed arrays, and emits a pass stream in paper µm with Béziers
   intact and dashes as slices. Everything a user could measure on paper
   is decided there, once. This is the mechanism that delivers objective 3
   and makes 05 a consumer rather than a second implementation.
2. **Build a custom WebGL2 backend** (Option A) rather than adopting
   deck.gl, MapLibre, PixiJS, CanvasKit or Vello. The library would save
   little — the hard parts are shared-stage code — and each one fights our
   primitives or CRS. Keep the GPU interface narrow (fill, stroke,
   instanced glyph, hatch, text, stencil clip) so a WebGPU backend can
   follow when its reach justifies it.
3. **Per-primitive techniques** (§6): earcut fills with stencil-then-cover
   as the exception path; shader-extruded strokes with per-vertex width
   factors (tapers), analytic AA and the screen-only hairline floor;
   CPU-laid-out dashes drawn as solid slices (no dash atlas); glyphs
   pre-tessellated once and instanced; pattern inclusion on the CPU and
   stencil clipping only for mode `clip`, with instance de-duplication for
   map-origin grids; procedural hatch stripes; MSDF text from bundled
   Liberation Sans/Narrow with halos as separate passes.
4. **Colour order by painter's order with visible-set index buffers per
   (colour, kind)** (~250 draws per frame); the depth-buffer fill
   optimisation is measured in the spike and adopted only if it pays.
5. **Buckets**: 50 mm cells at every scale, a resident large-object
   bucket (bbox > 2 × 2 cells), zoom-gated preparation of
   strokes/glyphs/text, LRU eviction to the 01 budgets.
6. **Workers for everything but the GL calls**; renderer kept DOM-free so
   the frame loop can move to OffscreenCanvas later.
7. **Editing hooks now** (§7): per-object pass identity, shared-stage
   hit-testing, a dynamic bucket, course overprint as library-symbol
   objects, UI layers outside the stream.
8. **Pin 03 §6.9 with the §8 fixtures first**, pass-stream assertions as
   the primary tests and three-way golden images as the secondary, before
   the pilot family is authored.
9. **Pilot** (03 §9 point 9): the 5xx paths and fences family (dashes,
   glyphs, borders, halos) plus 101 contours, 4xx vegetation fills with a
   patterned 407, 709 hatch and the 7xx overlay symbols, rendered through
   shared stage → WebGL2 and → the reference raster, on the Sprint and
   Crop-B maps, measured against the budgets above on a phone. The PDF
   backend joins in 05 using the same stream.

## 11. Open questions carried forward

- **PDF writer and CMYK** (05): the pass stream is designed so 05 can emit
  paths directly; whether to use `pdf-lib` low-level operators or a small
  PDF writer of our own, and how spot colours/overprint are expressed, is
  05's.
- **Reference raster engine**: resvg via an SVG serialisation of the pass
  stream (one more serialisation, but only for tests/thumbnails and with
  no semantics in it) vs a Canvas2D implementation (`@napi-rs/canvas` or
  `skia-canvas`) that walks the stream directly. Decide in the harness
  spike; the former reuses a dependency we already have.
- **Depth-buffer fills** (§6.8 point 3): adopt or drop after the spike.
- **Glyph size of the MSDF atlas and which Unicode ranges** (Nordic,
  Baltic, Cyrillic club maps?) — decide from the corpus's text objects.
- **Irregular patterns** (03 §6.8): the renderer draws the regular grid
  with a warning; a seeded jitter in the shared stage would be
  deterministic across backends if ever needed.
- **WebGPU timing**: revisit when Firefox ships on Linux/Android and
  Android Chrome's WebGPU share of our users passes ~95 %.
- **Public raster endpoint** (01 §9 point 6): if ever needed, it is the
  reference raster backend behind a route — nothing new in the core.

---

## Appendix A — Draw-call and memory arithmetic

Club-full, laptop viewport 1 920 × 1 080 CSS px at 1× paper
(≈ 3.78 px/mm → 508 × 286 mm), 50 mm cells:

```
visible cells            ≈ 11 × 6 = 66, + 1-cell margin ≈ 104 prepared
colours in view          ≤ 62
kinds                    4 (fill, stroke, glyph, text; hatch shares fill geometry)
naive draws/frame        62 × 4 × 104 ≈ 25 800        → not viable
visible-set indices      62 × 4 ≈ 248 draws/frame      → viable
multi-draw extension     same, without the rebuild step
```

Memory, Club-full, eager vs. designed:

```
fills:   622 k tri × 3 idx × 4 B = 7.5 MB idx; verts ≈ 1 M × 4 B (int16 xy) = 4 MB
strokes: 5.73 M verts × 8 B = 46 MB, plus either uint32 indices (~5.7 M tri
         × 12 B ≈ 69 MB) or triangle strips with degenerate joins (~+10 %)   eager
         zoom-gated: ~104 cells × ~0.5 MB ≈ 50 MB worst case at 1× on a laptop,
         ~9 cells ≈ 5 MB on a phone at 2×
glyphs:  ~90 k instances × 20 B = 1.8 MB (+ glyph meshes, a few hundred kB)
text:    2.2 k glyph quads ≈ 0.1 MB + 2 MSDF atlases (2 × 1024² RGB(A) ≈ 6–8 MB)
```

Eager strokes alone would approach the club-map budget, which is why
zoom-gated preparation (§6.11) is part of the design and not a later
optimisation.

Both are inside the 01 budgets (30 MB event maps, 150 MB club maps).

## Appendix B — Spike plan

1. Harness first: fixture loader, pass-stream snapshot tests, reference
   raster, Playwright golden step (1 week).
2. Shared stage for the pilot symbols only: solid stroke, OCAD dash,
   spaced glyphs, borders, halo split, fill with holes, pattern grid with
   clip modes, hatch, text run (2 weeks).
3. WebGL2 backend: buckets, arena, stroke + fill + glyph + hatch + text
   shaders, visible-set indices, LOD uniforms (3 weeks).
4. Load Sprint and Crop-B documents (02 decoder) and the pilot subset of
   Club-full; measure the §9 budgets on a phone; try the depth-buffer fill
   path; tune cell sizes and the large-object threshold (1 week).
5. Report back with numbers; then decide 05's PDF writer against the same
   stream.
