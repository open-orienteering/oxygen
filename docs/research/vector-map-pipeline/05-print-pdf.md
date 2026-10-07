# 05 — Print: PDF from the same pass stream

Status: proposed 2026-10-07 (recommendation §9); awaiting decision.
Depends on: [03](03-symbol-model.md) (CMYK per colour, colour order,
overprint hint, library symbols for the overprint), [04](04-render-core.md)
(the shared symbolisation stage and its pass stream — this topic is its
second backend). Feeds: 07 (print profiles as club data), 08 (layout
editor on the GL viewer, variants → pages), 09 (retiring `rsvg-convert`,
`fonts-liberation`, `window.png`).

## The question

04 decided that everything a user could measure on paper is decided once,
in the shared symbolisation stage, and that backends only rasterise. The
PDF is the backend whose "raster" is the printing press. This topic
decides:

1. **How the pass stream becomes a PDF page**: the page model (paper,
   frame, window, scale, rotation, layout objects, descriptions), the
   coordinate mapping, and the PDF operator for each pass kind.
2. **Colour**: CMYK from the colour stack, what happens to RGB page
   objects, whether to emit PDF overprint, spot colours, and what a
   *print profile* is (README objective 4 lists it; `map-color-stack.md`
   lists "print profiles (per-printer CMYK) and CMYK PDF output" as out
   of scope today).
3. **Which PDF writer**, and where it runs (server, browser, both).
4. **Fonts, images, page boxes, metadata, georeferencing** — the things a
   print shop or a phone app looks for in the file.
5. **How print is tested** against the GL backend so objective 3 is
   verifiable, not aspirational.

Primary sources: IOF *Printing and Colour Definitions* (2022 edition and
the Rev 4 colour-order table already transcribed in 03 Appendix B),
ISO 32000 (PDF 1.7 / 2.0) for overprint and geospatial dictionaries, the
PDF/X-4 conformance rules, the ECI profile licence. Prior art: OCAD's PDF
export, Purple Pen, Condes, OpenOrienteering Mapper. Current code:
`packages/api/src/course-maps/`, `packages/shared/src/course-maps/`,
`docs/course-maps.md`, `docs/map-color-stack.md`.

## 1. Requirements, by consumer

| Consumer | Needs from the print backend |
|----------|------------------------------|
| Course setter (club laser printing, the common case) | A PDF per course (or combined) at exact scale, A4/A3/A5/custom, portrait/landscape, that prints "actual size" from any PDF reader; the IOF layering (lower purple under black/brown/blue 100 % lines, upper purple on top) without reader settings; control descriptions on the map and as separate sheets; the overprint enlarged with the map (`overprintScale`); text variables; logos; white-outs and ink-saver white-out-outside; out-of-bounds hatch; variants as separate pages (course-maps.md "Future forking contract"). |
| Print shop (offset or production digital) | Vector PDF, DeviceCMYK throughout with the IOF CMYK values, fonts embedded, trim box + bleed + crop marks on request, PDF/X-4 with an output intent when the shop asks, optionally the purple as a spot colour with overprint for a true PMS Purple overprint run (IOF: "for main IOF events offset printing (CMYK+B) is demanded for 1:15 000"). |
| Club (calibration) | Per-printer colour adjustment: the IOF method is to print the test sheet and adjust CMYK values per colour until they match the offset reference; so a *print profile* must be able to override the CMYK of palette colours and be reused across events. A generated test sheet (the spec's 11 × 11 CMYK tables and a symbol sample) makes the method usable. |
| Layout editor (08) | What the editor shows *is* the print: the same pass stream drawn by the GL backend with a page overlay; no server raster preview. |
| Mobile users (GPS) | The course-map PDF opens in Avenza Maps and similar with the runner's position: ISO 32000 geospatial measure dictionary on the map frame when the map is georeferenced (OCAD does this automatically). |
| Export to other tools | Course and all-controls PDFs are the exchange format with printers and organisers; the base map as such is exported via OCAD (02), not via PDF. |
| Tests | Deterministic bytes for a fixed input (stable object numbering, no timestamps unless asked); rasterised PDF comparable to the reference raster and the GL backend; structural assertions (colour spaces, fonts, boxes) on the file. |
| Operations | No native binaries: today's `librsvg2-bin` and `fonts-liberation` leave the API image; fonts ship in the package. Generation time comparable to today's 0.8 s for the sprint map, memory bounded for the biggest club map window. |
| Offline (later) | The PWA can produce the same PDF without the server — the generator must be isomorphic and the fonts cacheable by the service worker. |

Out of scope: the course-setting domain model, variant materialisation,
and the layout editor UI (08); storage of print profiles (07); the
retirement sequence (09).

## 2. What the IOF printing document asks for

From *IOF Map Specifications — Printing and Colour Definitions* (2022
edition; the Rev 4 2024 table is in 03 Appendix B):

- **CMYK is the recommended technology**; spot (PMS) printing is legacy
  and hard to source. Offset CMYK+B (brown as a spot colour) is demanded
  for 1:15 000 at main IOF events and strongly recommended at 1:10 000;
  sprint, MTBO and Ski-O maps "shall always be laser printed". Resolution
  at RIP ≥ 230 lpi for CMYK, 200 for CMYK+B, 150 for sprint.
- **The seven CMYK definitions** for offset: black 0/0/0/100, blue
  100/0/0/0, yellow 0/27/79/0, green 76/0/91/0, dark green 100/0/80/30,
  brown 0/56/100/18 (PMS 471 for CMYK+B), purple 35/85/0/0 "or PMS
  Purple". "For laser printers no fixed definition can be used because
  every single laser printer gives its own colours" — calibrate with the
  PrintTech test sheet and the CMYK tables (§8–9 of the document).
- **Overprint**: in offset the course is overprinted in PMS purple, making
  black show through. "In laser printing this effect must be simulated.
  The easiest way to do this is to place the purple track colour in the
  colour order below black, brown and blue 100 % colours. The IOF does not
  recommend more advanced methods to achieve overprint because this can
  impede the effort to print a map with high resolution." This is the
  lower/upper purple layering Oxygen already does.
- **Colour order** (chapter 7, 43 rows in Rev 4) is the draw order 03
  made the document's colour stack. "It is very important to follow the
  colour order, otherwise it's impossible to show the course planning
  symbols correctly."
- **Paper**: 100–120 g coated for offset, 100–110 g laser paper or
  plastic; no file-format implications.

Consequences: DeviceCMYK with the palette's values is the default
colour model; the layering is the default overprint simulation; true
overprint flags and spot colours are an *offset option*; per-printer CMYK
overrides are a first-class feature, not a hack.

## 3. Current state, and what to keep

```
map_files.file_data → readOcad → applyIofColorStack → ocadToSvg (full) + ocadToSvg (ink)
  → composeMapPageSvg: full map → lower purple → ink → whiteouts → upper purple
                        → descriptions → layout objects   (paper-mm SVG, y down)
  → rsvg-convert --format=pdf  (one process per page, 30 s timeout)
  → pdf-lib: copy pages into one document, set title/author/creator
```

What this gets right and must survive: the paper-mm page model
(`CourseMapDocument`: paper, orientation, margin, map frame, window
centre, print scale, appearance, objects with page/map anchor, description
block placement), the overprint enlargement rule, the shared course-overlay
geometry (circle gaps, leg cutting, number placement with a per-course
`labelPosition`), the description sheet builder with its IOF rule set
(`buildDescriptionSheet`, thick rules after every third control…), the
validation (`validateCourseMap`), the digit-height → em conversion for 704
(cap-height ratio 1409/2048 of Liberation Sans), ink-saver white-out
outside as an even-odd ring, meridian-tilt rotation of the window.

What goes:

- **SVG as the intermediate.** Pattern tiles had to be expanded for
  librsvg (`bugfix-librsvg-pattern-tile-size.md`); `dominant-baseline` is
  not implemented so baselines are computed by hand; fonts are whatever
  the container has; the ink layer is a *second rasterisation of the whole
  map* on top of the first because SVG has no colour-order primitive. The
  pass stream has colour order built in, so lower purple is simply a
  stack position and the ink layer disappears.
- **`rsvg-convert`.** Chosen because it was the only converter that kept
  patterns as vectors (0.8 s vs 14 s with rasterised patterns). With the
  pass stream there is no SVG to convert.
- **`window.png` previews** in the layout editor (120 dpi then high-res
  raster). The editor draws the pass stream on the GPU (08).
- **`fonts-liberation` in the image.** The fonts move into the shared
  package (04 §4.4) so server and browser embed the same bytes.

## 4. Prior art

| Program | PDF colour | Overprint | Fonts / text | Georeferencing | Notes |
|---|---|---|---|---|---|
| OCAD | CMYK process by default; spot-colour separations (one greyscale PDF per spot colour, or combined with /Separation plates) | In spot-colour mode only; Acrobat needs "Use Overprint Preview: Automatic" | Embedded | Writes an ISO 32000 geospatial PDF (WGS 84) automatically for georeferenced maps; documented as working in Avenza | Recommends exporting PDF and printing "actual size" rather than printing from the program, because GDI round-trips CMYK→RGB→CMYK |
| Purple Pen | CMYK by default since 2.x ("much closer to what the map creator intended"); RGB and "OCAD compatible" models selectable | "Blend purple with underlying map colors" (a Darken-style blend, on by default when creating a file) and, since 3.5, upper/lower purple layering; honours OCAD's per-colour overprint flag when asked (off by default) | Embedded; can incorporate a PDF base map at original quality | — | Confirms the two approaches coexist in practice; many federations' guidance says "blending unchecked" and layering instead |
| Condes | CMYK | Either true overprint markings on brown/blue (requires Acrobat overprint preview) or "preferably Blend mode DARKEN"; also supports lower-purple merging when the base is an OCAD file | — | — | Explicitly warns the overprint route depends on reader settings |
| OpenOrienteering Mapper | RGB via Qt's PDF writer; experimental spot-colour separations as grey pages | Overprint *simulation* is a view option, not exported | Qt | — | Issue #653 discusses proper CMYK/spot PDFs as future work |

Takeaways: CMYK vector PDF is table stakes; layering is the recommended
and reader-independent way to get the overprint effect; true overprint
flags are only honoured by RIPs and by Acrobat with a non-default setting
and so must be opt-in for offset jobs; a geospatial PDF is a cheap,
appreciated extra.

## 5. Design

### 5.1 One page = one pass stream plus page-space layers

The page composer builds, per page, an ordered list of **layers**, each
with a transform into page space and an optional clip:

```
Page (paper mm, y down, origin top-left)
├─ background         white rectangle (MediaBox)
├─ map layer          transform T_map, clip = map frame
│    one pass stream in paper µm (y up) from the shared stage, containing:
│      base-map objects (document) + course-layer objects (7xx symbols,
│      filter regions, map-anchored white-outs) in ONE colour stack order
├─ page layer         identity, clip = printable area
│    page-anchored objects: white-outs, text, lines, rectangles, images,
│    the description block
└─ marks layer        crop/trim/registration marks, outside TrimBox (offset profile only)
```

The decisive point is the map layer: because the course overlay and the
map-anchored white-outs are *objects in the same symbolisation* as the base
map (04 §7), the colour stack already orders lower purple under black and
white-outs ("White for course overprint", one position below upper purple
in the Rev 4 table) above the ink and below the numbers. There is no
sandwich to compose and nothing to draw twice. Page-anchored white-outs
are the only white-outs drawn in the page layer, after the map, which is
also their meaning (they cover the map regardless of what is under them).

`T_map` is today's `mapToPage` (`geometry.ts`): translate window centre to
frame centre, scale by `scaleRatio = baseMapScale / printScale`, rotate by
`−meridianTiltDeg` about the frame centre, flip y. Symbol dimensions scale
with it, which is exactly the ISOM rule that the overprint is enlarged with
the map; `documentFactor` (03 §6.6) stays a property of the document.

### 5.2 Units and precision

PDF user space is points. Two choices avoid precision and size traps:

- Emit the map layer under a `cm` that maps **paper µm → points**
  (`72 / 25400 × scaleRatio`, with rotation and translation folded in),
  and write every coordinate as an **integer µm relative to the window
  origin**. Integers compress far better than reals and sidestep the
  ~5-significant-digit real precision of older readers (ISO 32000
  Annex C). The window is at most ~1 m → 10⁶, well inside the integer
  limit (2³¹).
- Line widths and dash-free stroke parameters are also in µm under the
  same `cm`, so a 0.14 mm contour is `140 w`. A 1:15 000 map printed at
  1:10 000 gets 0.21 mm lines from the matrix, not from the data.

Page-layer coordinates are page millimetres with 3 decimals (1 µm) under
a mm → pt `cm`.

### 5.3 Pass kinds → PDF operators

Mapping of the 04 §4.2 stream:

| Pass | Operators | Notes |
|---|---|---|
| `fill` | `m / l / c … h f` (non-zero) | Holes are sub-paths with the orientation 02 §3 normalised; Béziers stay `c`; nothing is flattened. |
| `stroke`, whole path | `w J j M` then path, `S` | `cap` flat/round/square → `J` 0/1/2; `join` bevel/miter/round → `j` 2/0/1; miter limit as 04 (`M 2`-ish); `pointed` caps and `taper` have no PDF equivalent → the shared `strokeOutline()` turns the sub-path into a fill polygon (both backends, so identical). |
| `stroke`, with `slices` (dashes) | one path per slice (de Casteljau split at `(seg, t)`), `S` | Never PDF's `d` dash array: it is non-adaptive and would put dashes where the GL backend does not. |
| `glyph` (point symbols, line glyphs, pattern cells) | Form XObject per `(glyphId, partIdx)` drawn with `q a b c d e f cm /Gn Do Q` per instance | A glyph part is tessellation-free vector geometry in µm; XObjects keep the file small (Club-full A4 window: ~2–3 k instances × ~40 B). Pattern mode `clip` → `q <area path> W n … Q` around the instances; the other three modes are inclusion decisions already made in the stream. |
| `hatch` | `q <area path> W n` then `hatchLines()` as `m l … S` `Q` | Explicit lines rather than a PDF tiling pattern: exact match to GLSL by construction and no pattern-cell phase questions; counts are small (04 §3). |
| `text` | `BT /Fn size Tf 1 0 0 1 x y Tm <gid…> Tj ET` per run, or `TJ` with per-glyph advances | Glyph ids from the shared shaping (04 §4.4); font = subset CIDFontType2 with Identity-H. Halo passes = the same glyphs with `Tr 1` (stroke) at `2 × haloWidth` in the halo colour, drawn at the halo colour's stack position — exactly the 03 §6.9 item 9 rule. |
| colour change | `k` / `K` (DeviceCMYK) or `rg` / `RG` in the RGB mode; `/CSn cs t scn` for a spot colour | One colour change per colour pass; passes are already colour-sorted. |
| filter region, mode clip | `q <region path, even-odd with frame> W* n … Q` around the affected passes | Same stream data as the GL stencil (04 §7). |

Nothing in the table depends on the backend having made a decision; a
stroke that the GL backend draws as a ribbon with analytic AA is the same
`S` here. The only backend-local choices are the operator encoding and
the form-XObject factoring.

### 5.4 Colour

**Source of truth** is the document's colour stack (03 §6.3): every entry
carries CMYK; palette entries carry the IOF values, source entries the
mapper's. The naive sRGB used on screen is *derived* from the same CMYK
(03 §2.3), so screen and print agree on which colour is which — the
screen only approximates the hue.

**Output modes** (part of the print profile, §5.5):

| Mode | Colour operators | Overprint | Standard | Use |
|---|---|---|---|---|
| `cmyk` (default) | DeviceCMYK everywhere; RGB page objects converted with the inverse of the shared naive conversion | None; IOF layering only | PDF 1.7, no PDF/X claim | Club laser printing, most print shops |
| `cmyk-offset` | DeviceCMYK; optional `/Separation` for purple (alternate DeviceCMYK 35/85/0/0) and brown (PMS 471, alternate 0/56/100/18) | ExtGState `/OP true /op true /OPM 1` on the purple passes (and any colour whose 03 `overprint` hint is set) when `overprint: true` | PDF/X-4 when an output-intent ICC is supplied; TrimBox/BleedBox, bleed, crop marks | Offset, CMYK+B, PMS Purple overprint runs |
| `rgb` | DeviceRGB with the shared sRGB values | None | PDF 1.7 | Proofs, QA golden comparisons against the GL backend, screen viewing |

Why the layering stays the default even when overprint is available:
`/OP` is only honoured by RIPs and by Acrobat with "Overprint Preview:
Automatic" (OCAD's and Condes' documentation both carry that warning); a
club printing from a browser viewer would see knock-outs. The layered file
looks right everywhere. And a true overprint changes the purple's hue
over yellow and green (that is what overprint means), which is what the
IOF accepts in offset and advises against simulating digitally. The
*Darken blend* route some programs offer is not used: it is a transparency
feature, changes colours in the same way, and the IOF explicitly does not
recommend "more advanced methods".

**RGB page objects** (user-picked hex colours on text, lines, rectangles;
PNG logos) are converted to CMYK in the `cmyk` modes with the inverse of
the shared naive conversion, except pure black (`#000000` → 0/0/0/100) and
white (→ 0/0/0/0) which are special-cased so text and white-outs stay
single-plate. PDF/X-4 forbids mixing DeviceRGB into a CMYK-intent file, so
in `cmyk-offset` images are converted to CMYK too (PNG → DeviceCMYK image
XObject via the same conversion). Precise colour management of logos is a
non-goal — print shops accept this and clubs can supply a CMYK PNG later
if ever needed.

### 5.5 Print profiles

A **print profile** is club-level data (07) selected per export (default
per club), containing everything that is about the *printer*, not the
map:

```ts
interface PrintProfile {
  id: string; name: string;                 // "Club laser (Kyocera)", "Print shop offset A3"
  mode: "cmyk" | "cmyk-offset" | "rgb";
  colourOverrides: Record<string, [c, m, y, k]>;   // palette id or "src:<n>" → calibrated CMYK
  minLineWidthMm?: number;                  // thin-line compensation for toner spread; default none
  overprint?: boolean;                      // cmyk-offset only
  spotColours?: ("purple" | "brown")[];     // cmyk-offset only
  outputIntent?: { iccGraphicId: number; description: string };   // uploaded ICC (graphics-like store)
  bleedMm?: number; cropMarks?: boolean;    // cmyk-offset only
}
```

- `colourOverrides` is the IOF calibration method as data: after printing
  the test sheet the club records "our brown is 0/50/100/10". Overrides
  key on the colour-stack entry id so they survive map changes and apply
  to every map that matches the palette (03 §6.3) — and, by `src:` id, to
  unmatched colours of a specific document.
- `minLineWidthMm` is applied by the *PDF backend* as `max(width, min)`
  on strokes — a backend-local output adjustment analogous to the GL
  hairline floor (04 §6.2), and like it never part of the stream. Default
  off; the IOF has no such rule, but clubs with toner spread or
  under-inking ask for it.
- The **test sheet generator** renders, through the same backend: the
  spec's eleven 11 × 11 CMYK tables (one per yellow level), the palette's
  colours as 15 mm swatches with their names and values, and a symbol
  sample (contours, 505 path, 7xx overlay at 1:15 000 and 1:4 000).
  Calibration becomes: print, compare, type four numbers.
- The **output intent** ICC is uploaded by the club, not bundled: ECI's
  PSO Coated v3 "may be used, embedded and exchanged without restriction"
  but "may not be distributed … without written permission", so Oxygen
  should not ship it. The upload UI links to ECI and names the common
  profiles (PSO Coated v3 / FOGRA51, ISO Coated v2 / FOGRA39, PSO
  Uncoated v3 / FOGRA52).

### 5.6 Fonts and text

- The two bundled faces (Liberation Sans, Liberation Sans Narrow — 04
  §4.4; metric-compatible with Arial / Arial Narrow which the corpus uses)
  are embedded as **subset CIDFontType2** with Identity-H, glyph ids from
  the shared shaper, one font object per face per document. `pdf-lib`'s
  subset embedder (via fontkit) renumbers glyphs and writes `<gid>` hex
  strings, which matches a shaper that already works in glyph ids; text
  remains selectable/searchable via `ToUnicode`, which the embedder
  writes.
- Fallback: if subsetting ever fails for a face (the library notes it does
  not work for every font) the backend emits the glyph outlines as fills
  — the shaper has the outlines because the MSDF atlas is generated from
  the same files. Since only two known faces are ever embedded, this is
  tested once and otherwise never hit.
- Text in the *page layer* (titles, variables, description block text)
  goes through the same shaper and the same fonts. The description
  block's IOF pictograms (`iof-symbols.ts`, today SVG paths) become glyph
  meshes in the shared `glyphTable` at build time — drawn as form
  XObjects like any glyph.
- The user-facing font choice in layout objects (sans / serif / condensed
  / monospace, course-maps.md) maps to bundled faces: sans and condensed
  exist; serif and monospace need two more OFL faces (Liberation Serif,
  Liberation Mono — same family, same licence) or are dropped in 08.

### 5.7 Images and graphics

- **PNG** graphics: embedded as image XObjects (`pdf-lib` handles alpha);
  converted to CMYK in the offset mode (§5.4).
- **SVG** graphics (club logos): there is no SVG renderer left in the
  pipeline. Options: (a) rasterise at upload to a 600 dpi PNG (resvg is
  already a dependency for thumbnails) and embed that; (b) convert a safe
  SVG subset (paths, basic shapes, fills/strokes, transforms, no text, no
  gradients) to a form XObject at upload, falling back to (a). Start with
  (a); most logos are small enough that 600 dpi is indistinguishable in
  print; (b) later if a club asks for vector logos.

### 5.8 Page boxes, metadata, standards

- `MediaBox` = paper (+ bleed on each side in offset mode); `TrimBox` =
  paper; `CropBox` unset (defaults to MediaBox) so viewers show the whole
  sheet; crop and registration marks drawn in the bleed area only.
- `Info`: Title (event · course · map name), Author (club), Creator
  "Oxygen", Producer; **deterministic output**: fixed `CreationDate`/
  `ModDate` and no document ID randomness when `deterministic: true`
  (test fixtures), real timestamps otherwise. `pdf-lib` exposes both.
- **PDF/X-4** in `cmyk-offset` with an output intent: `/OutputIntents`
  with the uploaded ICC, `GTS_PDFXVersion (PDF/X-4)`, `Trapped /False`,
  XMP metadata with the X-4 identification, TrimBox present, no
  DeviceRGB, fonts embedded, no transparency used (the layering means we
  need none; white-outs are opaque fills). Validation in CI with a
  preflight tool is an open question (§10); at minimum `qpdf --check` and
  our own structural assertions.
- Page labels: course name per page; outlines (bookmarks) per course when
  a file has many pages.

### 5.9 Geospatial PDF

When the document is georeferenced (02 §5: `crs`, `paperOrigin`,
`gridRotationDeg`, `gridScaleFactor`) the map frame gets a **Viewport**
with a `/Measure /GEO` dictionary (ISO 32000-2 §12.9.3, implemented by
Acrobat since 9, read by Avenza Maps; OCAD writes the same):

- `GCS`: `/Type /GEOGCS` WGS 84 (`/EPSG 4326`) — most portable; our
  `proj4` dependency converts the paper→grid affine to lat/long for any
  EPSG the map uses (`map-projection.ts` does this today for GPS tracks).
- `GPTS`: lat/long of the frame's four corners (in page order), `LPTS`:
  the unit-square corners. Four points express rotation (meridian tilt)
  and the small non-orthogonality of lat/long with no special casing.
- `BBox` of the viewport = the map frame in page points. One viewport per
  map frame; pages with several frames (map exchange on one sheet) get
  one each.

No raster, no extra bytes to speak of (~300 B per page). Opens the
"navigate on the printed course map" use case on phones at zero cost to
the rest of the design.

### 5.10 Documents with many pages

`pdf-lib` builds pages into one document directly — the current
per-page-PDF-then-merge step existed only because `rsvg-convert` produces
one file per SVG. Shared resources (fonts, glyph XObjects, the base map
window if two pages share it — e.g. all variants of a forked course) are
emitted once per document. Export granularity stays as today (one map,
all maps of a course, all-controls, whole event); 08 adds "one page per
variant" with the description block per variant.

### 5.11 Where it runs

The generator is **isomorphic**: `@oxygen/shared/print` (page composer,
pass → operators, geospatial dictionary) depends only on the shared stage
and the PDF writer, both of which run in Node and in the browser.

- **Phase 1: server.** `GET /api/maps/:nameId/maps.pdf` stays; the
  handler loads the document, runs the shared stage for the window + the
  course layer, composes, writes. No worker needed: a sprint-map A3 page
  is a few hundred ms of CPU (the current 0.8 s was mostly librsvg).
  Memory is bounded by the window's pass stream, not the map.
- **Phase 2: browser (offline).** The same module in a Web Worker,
  triggered from the layout editor, with the fonts (2 × ~350 kB) and the
  PDF writer (~200 kB gz) lazy-loaded and service-worker cached. This is
  what makes "print the maps in the forest when the venue has no network"
  possible and offloads the server at the same time. Nothing in phase 1
  has to change for it; it is the reason to keep Node-only APIs out of
  the module.

### 5.12 Preview and the layout editor

The layout editor renders the page with the **GL backend** (04): the map
layer's pass stream at `T_map`, the page layer as paper-space objects, the
sheet and margins as UI. There is no `window.png`, no 120 dpi first
paint, no "freshly rendered raster swaps in". "Print preview" is a toggle
that applies the print profile's colour overrides and `minLineWidthMm` to
the GL view and hides the hairline floor — the only two things in which
the GL frame legitimately differs from the PDF.

## 6. PDF writer options

| Option | What it is | For | Against | Verdict |
|---|---|---|---|---|
| A. Keep SVG → `rsvg-convert` (status quo) | Serialise the pass stream to SVG, convert | Exists | A second serialisation with its own semantics (patterns, baselines, fonts), a native binary in the image, no CMYK (librsvg writes RGB PDFs), no overprint, no PDF/X, no geospatial, no offline | Rejected — it is the problem 04 set out to remove. |
| **B. `pdf-lib` low-level API** (`pushOperators`, `setFillingCmykColor`, `clip`, custom ExtGState dicts via `context.obj`, `embedFont({ subset: true })`, `embedPng`, `copyPages`) | The library already in `packages/api`; TypeScript, zero native deps, Node + browser | Everything §5 needs is reachable: operators are first-class, CMYK operators exist, arbitrary dictionaries (ExtGState with `/OP`, `/Separation` colour spaces, `/OutputIntents`, `/Measure`) can be registered through `PDFContext`; subsetting via fontkit; deterministic save options | Upstream `Hopding/pdf-lib` has been inactive since 2021. The fork **`@cantoo/pdf-lib`** (2.11, Sept 2026, >1 M weekly downloads, API-compatible, `fflate` instead of `pako`, `@cantoo/fontkit`) is the maintained line — switch to it. Not every print feature has a convenience API; we write ~300 lines of dictionary plumbing (PDF/X output intent, Separation, Viewport/Measure). | **Recommended.** |
| C. Own minimal PDF writer | Content streams + xref + Flate are ~400 lines; CMYK/ExtGState/Measure trivial | Total control, tiny | TrueType subsetting (glyf/loca/cmap/hmtx rewriting) is the hard 60 %; `fontkit` does it and is what B uses anyway | Fallback if the pdf-lib line dies; the §5.3 operator layer is written so swapping the writer is mechanical. |
| D. CanvasKit/Skia PDF | Skia's SkPDF backend | One engine for screen and print | Rejected in 04 §5 (no PDF in the npm build, 7 MB wasm, path effects expanded) | Rejected. |
| E. Browser print of the GL canvas | `window.print()` | Nothing to build | Raster at screen DPI, no scale guarantee, no CMYK, no file | Rejected (fine for a quick proof, never for maps). |
| F. `@imprint-pdf/print` / `modern-pdf-lib` | Newer TypeScript packages with print features (PDF/X-4, Separation, overprint helpers) | Have the helpers B lacks | Alpha / very low adoption (45 weekly downloads); one wraps `pdf-lib 1.17.1` itself | Borrow ideas for the plumbing; do not depend. |

## 7. Tests

Three tiers, extending 04 §8:

1. **Operator-level unit tests** (`@oxygen/shared/print`): for a fixture
   pass stream, assert the emitted operator sequence — colour operator per
   pass, `W n` around clip-mode patterns and filter regions, slice paths
   for dashes, `Tr 1` halo pass before the fill pass, units/`cm` for a
   given window and scale, `k` values equal the stack's CMYK (or the
   profile's override), `minLineWidthMm` clamps, no `rg` in `cmyk` mode.
2. **Structural tests on the file**: parse with `pdf-lib` and assert
   fonts are `CIDFontType2` subsets with `ToUnicode`, `MediaBox`/
   `TrimBox` per profile, `/OutputIntents` present and ICC attached in
   offset mode, `/Measure /GEO` with the expected `GPTS` for a
   georeferenced fixture, deterministic bytes for `deterministic: true`
   (hash-stable across runs), `qpdf --check` clean (dev dependency only,
   CI image).
3. **Three-way golden images** (04 §8 tier 2): `pdftoppm -r 600` of the
   PDF vs the reference raster vs the GL backend for every §8 fixture of
   04 and for a page fixture (A4 sprint page with descriptions, a
   white-out-outside ring, a rotated window, two variants). The `rgb`
   mode is used for these so colours are comparable; the `cmyk` modes
   are compared after a naive conversion with a looser tolerance.

Playwright E2E keeps the existing "export PDF" flows and adds a check that
the downloaded file has the expected page count and page size.

## 8. Effort

| Item | Estimate |
|---|---|
| Pass → operators layer (fills, strokes, slices, glyph XObjects, hatch, text, clips), units, colour modes | 1.5 weeks |
| Page composer on the existing `CourseMapDocument` (frame, window, rotation, page objects, description block as glyphs/text, images) | 1.5 weeks |
| Fonts: embedding, shaping hand-off, outline fallback, IOF pictograms as glyph meshes | 0.5 week |
| Print profiles: schema, overrides, offset extras (Separation, OP ExtGState, OutputIntent, boxes, marks), test-sheet generator | 1.5 weeks |
| Geospatial viewport | 2 days |
| Tests (tiers 1–3), `qpdf`/`pdftoppm` in the CI image, E2E updates | 1 week |
| Server route switch-over and removal of rsvg/fonts from the image (with 09) | 0.5 week |
| Browser (offline) generation — phase 2 | 1 week, later |
| **Total, phase 1** | **≈ 6–7 weeks**, of which the first two rows depend on 04's shared stage existing for the pilot symbols |

## 9. Recommendation

1. **The PDF is a backend of the shared stage** (§5.1–5.3): one pass
   stream per map layer with the course layer inside it, mapped to PDF
   operators one-to-one — Béziers kept, dashes as slices, glyphs as form
   XObjects, hatches as clipped lines, halos as stroked text passes,
   filter regions as clips. No SVG, no second rasterisation, no ink
   layer.
2. **DeviceCMYK from the colour stack by default, IOF layering as the
   only overprint simulation** (§5.4). True overprint (`/OP /OPM 1`) and
   spot colours (purple, brown) are `cmyk-offset` options; Darken blending
   is not offered. RGB page objects are converted naively with black and
   white special-cased.
3. **Print profiles as club data** (§5.5): mode, per-colour CMYK
   overrides keyed by colour-stack id, optional minimum line width,
   offset extras, uploaded output-intent ICC. Ship the **test-sheet
   generator** so the IOF calibration method is a ten-minute task.
4. **Writer: `@cantoo/pdf-lib`** (the maintained `pdf-lib` line) with its
   low-level API, behind a ~300-line operator/dictionary layer so the
   writer is replaceable (§6 B/C).
5. **Embed subset Liberation Sans / Sans Narrow** from the shared
   package, glyph ids from the shared shaper; `fonts-liberation` and
   `librsvg2-bin` leave the Docker image (§5.6, 09).
6. **Geospatial viewport on every georeferenced map frame** (§5.9).
7. **PDF/X-4 only when the club supplies an ICC profile**; otherwise plain
   PDF 1.7 with correct boxes and metadata (§5.8).
8. **Isomorphic module, server first, browser/offline second** (§5.11).
9. **Layout editor previews with the GL backend**, print-preview toggle
   applies profile overrides; `window.png` retired (§5.12).
10. **Tests at three tiers** (§7), with the `rgb` mode as the comparable
    channel against the GL backend.

## 10. Open questions carried forward

- **PDF/X preflight in CI.** `veraPDF` validates PDF/A, not PDF/X;
  commercial preflight is out. Candidates: `qpdf --check` + our
  structural tests (certain), Ghostscript's `-dPDFX` round-trip as a
  smoke test (maybe), or asking one print shop to preflight a sample once
  per release (practical).
- **Vector SVG logos** (§5.7 option b): wait for demand.
- **Serif/monospace faces** for layout text: add Liberation Serif/Mono
  (~700 kB more in the shared package) or restrict the font menu (08).
- **Raster export** (PNG/TIFF at 300–600 dpi) for organisers who want an
  image of the course map (results pages, social media): the reference
  raster backend behind the same composer; small, and it reuses the 01 §9
  "public raster" answer. Not in phase 1 unless 08 wants it.
- **CMYK images**: only if a club supplies CMYK logos; `pdf-lib` embeds
  JPEG CMYK natively, PNG would need conversion.
- **Spot-colour separations as separate pages** (OCAD's "one PDF per spot
  colour"): no request; a composite with `/Separation` colour spaces is
  what modern shops want (OOM issue #653 reaches the same conclusion).
- **Per-page vs per-document base-map XObject**: emit the map layer inline
  first; measure whether variants of one course make a shared form
  XObject worthwhile.
- **Minimum line width semantics vs ISOM**: `minLineWidthMm` is a
  printer compensation, not a map change; document it as such in the
  profile UI so it is not used to "fix" a map.

---

## Appendix A — Operator sketch for one page (cmyk mode)

```
%PDF-1.7
% page: A4 portrait, 210 × 297 mm; frame (10,10)–(200,250) mm; 1:15000 map at 1:10000
q                                   % page layer units: mm → pt
  2.834645 0 0 -2.834645 0 841.89 cm      (y down → PDF y up)
  0 0 0 0 k  0 0 210 297 re f       % white sheet
  q                                 % map frame clip
    10 10 190 240 re W n
    q                               % T_map: µm → mm × scaleRatio, rotate −3.3°, window→frame
      0.001497 -0.0000863 0.0000863 0.001497 105 130 cm
      % --- passes in colour-stack order, coordinates in integer µm rel. window origin ---
      0 0.27 0.79 0 k  12040 -8800 m 15220 -8800 l 15220 -5100 l h f        % yellow 100 % area
      0.35 0.85 0 0 k  350 w 1 J 1 j  -4000 2000 m 6000 2000 l S           % lower purple leg (slice)
      0 0 0 1 k        140 w 0 J 0 j  -9000 0 m -8600 400 -8200 800 -7800 900 c S   % black path dash slice
      q 1 0 0 1 -2200 4100 cm /G7 Do Q   q 0.94 0.34 -0.34 0.94 -1900 4600 cm /G7 Do Q   % 516 glyphs
      0 0 0 0 k  <whiteout polygon> f                                       % white for course overprint
      0.35 0.85 0 0 k  BT /F1 5590 Tf 1 0 0 1 -1200 3300 Tm <0014001A> Tj ET   % "31" upper purple
    Q
  Q
  % page layer: description block, title, logo
  0 0 0 1 k  BT /F1 3.2 Tf 1 0 0 -1 12 262 Tm <...> Tj ET
  q 40 0 0 15 160 275 cm /Im1 Do Q
Q
```

Resources: `/F1` subset Liberation Sans (CIDFontType2, Identity-H,
ToUnicode), `/G7` form XObject for 516 power-line tick, `/Im1` PNG logo.
In `cmyk-offset` with overprint: `/GS1 << /Type /ExtGState /OP true /op
true /OPM 1 >>` and `/GS1 gs` before the purple passes; purple as
`/CS1 [/Separation /Purple /DeviceCMYK <tint fn>]` with `/CS1 cs 1 scn`.

## Appendix B — Size arithmetic

Sprint map, A3 page covering ~75 % of the map (04 §3 counts):

```
coords         ~92 k  × 2 ints × ~6 B (µm, relative)        ≈ 1.1 MB raw
dash slices    ~1.4 k × ~40 B                                ≈ 0.06 MB
glyph instances ~8 k × ~40 B (cm + Do)                        ≈ 0.3 MB
text           negligible (no base-map text; ~40 control numbers)
fonts          2 subsets, digits + Latin-1 used              ≈ 60 kB
Flate (×0.3–0.4)                                             ≈ 0.5–0.6 MB per page
```

Club-full A4 window at 1:10 000 (2.8 % of the map): ~42 k coords, ~1.4 k
dash segments, ~1.4 k pattern instances → ≈ 0.25 MB per page. Comparable
to today's output and small enough to email, which course-setting
guidance still treats as the constraint.
