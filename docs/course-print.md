# Course print

How a course map is printed from the vector pipeline: the PDF
operators, the colour stack on paper and the layout-editor preview.
Normative for slice C of the vector map pipeline (research:
`docs/research/vector-map-pipeline/` 05, 09 §4 C).

> §1–3 (writer, colour modes, fonts and determinism) are C1's; §4–7
> (page model, `resolveSheet`, layers, page objects and graphics, boxes,
> metadata and geospatial) C2's; §8–9 (route, golden PDFs, CI) C3's;
> §10 (layout-editor preview) is C6's. How a *pass* becomes PDF content is
> `docs/map-rendering.md` §5.3; this chapter owns everything around it.

Status: **draft** — §1–3 written by C1, §10 by C6 (2026-10-23), §4–7 by
C2, §8–9 by C3 (2026-10-24).

## 1. The print module and its writer

`packages/shared/src/print/` — the PDF backend of the shared stage.
**Isomorphic**: no Node API (`node:*`, `Buffer`); fonts arrive as bytes,
randomness (non-deterministic `/ID`) comes from Web Crypto, so the same
code runs in the API and, later, in a Web Worker (05 §5.11). It is *not*
re-exported from the package root (`import { render } from
"@oxygen/shared"` stays free of the PDF library, which keeps it out of the
web bundle); it is the package's `@oxygen/shared/print` subpath
(`exports` in `packages/shared/package.json`: `.`, `./print`, and
`./src/*` for the declaration references tsc emits). The Dockerfile's
build-stage patch rewrites all three entries to `dist/src/…` together
with `main` — with `exports` present Node ignores `main`.

| File | Contents |
|---|---|
| `print/operators.ts` | pass stream → content-stream operators (`map-rendering.md` §5.3); `mapLayerOperators`, `layerMatrix`, `clipOperators`, glyph form content and bounding box, number formatting (`fmtMm` for the page layer: mm, 3 decimals) |
| `print/colour.ts` | colour modes (§2) |
| `print/fonts.ts` | font programs: subsetter, widths, descriptor values, subset tag, ToUnicode (§3) |
| `print/writer.ts` | `PdfWriter` — the only file that imports the PDF library |
| `print/page.ts` | the page model (§4): `PageInput`, `ComposedPage`, `T_map`, `flipPageObject`, `transformPassStream` |
| `print/compose.ts` | `composePage`, `writePage` (§4, §6.3) |
| `print/description.ts` | the description block and the IOF pictogram glyphs (§6.2) |
| `print/geo.ts` | the `/Measure /GEO` viewport (§7.3) |
| `print/__fixtures__/pages.ts` | the page scenes (§7.5) |
| `print/index.ts` | the module's exports |

**Writer.** `@cantoo/pdf-lib` (the maintained fork of `pdf-lib`, 05 §6
B) is used as object model, Flate encoder and cross-reference writer
only: content streams are strings from `operators.ts`, font objects are
built from `fonts.ts`; no `drawText`, no `embedFont`, no fontkit.
Replacing the library (05 §6 C) is a rewrite of `writer.ts` alone.

```ts
const w = await PdfWriter.create({ faces, deterministic, info, text });
const page = w.addPage({ widthPt, heightPt, trimBox? });
page.addContent(mapLayerOperators(stream, { colours, mode, resources: page.resources, originUm, matrix }));
const bytes = await w.save();
```

- `faces`: `{ family, data }` for the bundled files
  (`packages/shared/fonts/`). A text pass uses the face of its
  `FontRef.family` (matching `bold` / `italic` first, else the family).
- `page.resources` is the `OperatorResources` the operators ask for
  names: `font(ref, glyphIds)` records the glyphs a page draws and returns
  `F<n>`; `glyph(mesh)` returns `G<n>`; `glyphOutline` serves the
  fallback (§3.1). Names are handed out in first-use order — never a
  random suffix.
- **Per document, not per page** (05 §5.10): one font object per face,
  subset at `save()` to the union of every page's glyphs; one form
  XObject per distinct glyph part, deduplicated by content and bounding
  box, so equal parts from two separately symbolised streams share one
  object even when the streams number them differently.
- Boxes: `MediaBox` = the page; `TrimBox` = `trimBox`, default the
  `MediaBox` (the paper, 05 §5.8). No bleed and no marks in slice C (they
  belong to `cmyk-offset`, §2).
- File: PDF 1.7 header, object streams, Flate on every content stream,
  form and font file.
- `Info`: `Title`, `Author`, `Subject`, `Keywords` from `info`;
  `Creator` "Oxygen", `Producer` "Oxygen (@oxygen/shared/print)";
  `CreationDate` = `ModDate` (§3.2).

## 2. Colour modes

The document's colour stack is the source of truth (03 §6.3): every
entry carries CMYK. A pass's `colour` indexes it.

| Mode | Stack colours | RGB page colours (C2: text, lines, rectangles a user picked) | Never emitted |
|---|---|---|---|
| `cmyk` (default) | `k` / `K` with the entry's CMYK (0..1) | the **inverse naive conversion** (`rgbToCmykNaive`): maximal K, then C/M/Y from the rest, so `cmykToHex(rgbToCmykNaive(hex)) === hex`; `#000000` → 0/0/0/1 and `#ffffff` → 0/0/0/0 special-cased (single-plate black text and white-outs) | `rg`, `RG` |
| `rgb` | `rg` / `RG` with the shared naive sRGB (`cmykToHex`, the screen's colour) | the hex as is | `k`, `K` |

Components are written clamped to 0..1 with at most four decimals.
No overprint, no transparency, no spot colours: the IOF layering is the
colour stack's order (05 §5.4). `rgb` is for proofs and the golden
comparison against the other backends (C3); `cmyk` for printing.

Not in slice C (user decision 2026-10-23, decision log): `cmyk-offset`
(`/Separation` purple and brown, `/OP` overprint, PDF/X-4 with an output
intent), print profiles with `colourOverrides`, `minLineWidthMm` and the
test sheet (05 §5.5) — a later row before the default flips.

## 3. Fonts, text and determinism

### 3.1 Fonts

The two bundled faces (Liberation Sans, Liberation Sans Narrow;
`map-rendering.md` §4.10) are embedded per document as

```
Type0  /Encoding /Identity-H  /ToUnicode <CMap>  /DescendantFonts [
  CIDFontType2  /CIDSystemInfo (Adobe, Identity, 0)  /CIDToGIDMap /Identity  /W [...]
    FontDescriptor  /FontFile2 <subset, /Length1>  ]
```

- **Glyph ids are kept.** The stream's text passes carry glyph ids from
  the shared shaper (`render/text.ts`, `TrueTypeFont`); the content
  stream writes them as 2-byte Identity-H codes and CID = GID. The
  subsetter (`subsetTrueType`) therefore does **not renumber**: unused
  glyphs become empty `glyf` entries and the font is cut after the
  highest used id (`maxp.numGlyphs`). Kept: `.notdef`, the drawn glyphs
  and the components of composite glyphs (Å = A + ring), recursively.
  Tables: `head` (long `loca`, new `checkSumAdjustment`), `hhea`
  (`numberOfHMetrics` = glyph count), `maxp`, `hmtx` (one long metric per
  glyph), `loca`, `glyf`, `cvt `, `fpgm`, `prep`, `OS/2`, `name`, `post`
  (format 3). `cmap`, `kern`, `GPOS`, `GSUB`, `GDEF` and the rest are
  dropped — the PDF addresses glyphs by id and the shaper already applied
  kerning. (05 §5.6 expected pdf-lib's fontkit embedder; it only accepts
  strings and re-shapes them, so the stream's glyph ids cannot reach it —
  decision log 2026-10-23.)
- `W`: the advance of every used glyph in 1000 units per em, runs of
  consecutive ids grouped.
- `FontDescriptor`: `FontBBox`, `Ascent`, `Descent` (`hhea`),
  `CapHeight` (`OS/2`), `ItalicAngle` (`post`), `Flags` 4 (symbolic, +64
  italic), `StemV` 80 (120 bold), all in 1000 units.
- `BaseFont` / `FontName`: `XXXXXX+LiberationSans` (`…Narrow`, `-Bold`
  …), the six-letter tag derived from the face and the sorted glyph set
  (FNV-1a) — deterministic.
- `ToUnicode`: one `bfchar` per used glyph that some code point maps to,
  the lowest such code point (BMP), so text is selectable and searchable.
- **Fallback: outlines.** A face whose file the subsetter cannot read
  (checked once when the writer loads the face; the reason is pushed to
  `PdfWriter.warnings` as `PDF_FONT_OUTLINES: …` for the caller to log) or
  `text: "outline"` draws text as the glyph outlines the reference raster draws
  (`map-rendering.md` §5.3). A family without a face draws nothing — the
  stage has already warned `NO_FONT` (§4.9) for families no file ships.

### 3.2 Determinism

`deterministic: true` (test fixtures, golden files) — equal input gives
equal bytes:

- `CreationDate` = `ModDate` = 2000-01-01T00:00:00Z
  (`DETERMINISTIC_DATE`); otherwise `now` (default the current time).
- `/ID`: 16 bytes from the FNV-1a hash of the title, both halves equal;
  otherwise random (Web Crypto).
- No other source of variation: resource names in first-use order,
  subset tags from the glyph set, Flate (fflate) and the object order are
  deterministic; the font programs copy the source file's `head` dates.

### 3.3 Tests

| Test | Covers |
|---|---|
| `print/__tests__/operators.test.ts` | tier 1 (05 §7), see `map-rendering.md` §5.3 |
| `print/__tests__/colour.test.ts` | stack CMYK in `cmyk`, naive sRGB in `rgb`; inverse naive round-trips through `cmykToHex`; black / white single-plate; grey on K; operator formatting |
| `print/__tests__/fonts.test.ts` | subset keeps ids: kept glyph records and advances byte-equal, composite components kept, others empty, cut after the highest id, < ¼ of the file; checksums (`0xB1B0AFBA`), byte-identical across runs, dropped tables; `W` grouping; ToUnicode pairs; hex runs; subset tag; descriptor metrics |
| `print/__tests__/writer.test.ts` | tier 2 (05 §7): PDF 1.7, page count, `MediaBox` / `TrimBox`, `Info` with fixed dates; per face Type0 → Identity-H → CIDFontType2 → `CIDToGIDMap /Identity` → `FontDescriptor` → `FontFile2` with `Length1` = program length, subset tag pattern, ToUnicode covers every drawn id; form XObjects (`Subtype /Form`, `BBox`) and clip blocks; byte-identical files with `deterministic` (cmyk and rgb); real dates and differing bytes without; a face the subsetter cannot read → `PDF_FONT_OUTLINES` warning and no font; outline mode embeds no font and draws no `BT` |

`qpdf --check` and the rasterised comparison against the reference
raster are §9.2–9.3 (C3).

## 4. The page model

One course-map page is a set of **layers** in page space (05 §5.1),
built by `composePage(input, fonts)` (`print/compose.ts`) and written by
`writePage(writer, page, { mode, images })`:

```
page (page µm, y-up, origin bottom-left — PDF's own orientation)
├─ sheet        white rectangle over the MediaBox
├─ map layer    one pass stream in paper µm under T_map, clipped to the frame
│                 = document window objects ⊕ courseLayer() (C0), one symbolise call
├─ page layer   page-anchored objects + the description block, page µm, unclipped
└─ marks layer  null: offset marks belong to print profiles (§2)
```

The templates' page mm are y-down from the top-left (the editor's
convention, unchanged); `frameRectUm` and `flipPageObject` turn them into
y-up page µm once, on the way in. Nothing else in the composer knows the
y-down convention.

### 4.1 Input and output

`PageInput` (`print/page.ts`): `paper` (mm), `frame` (template mm),
`window` (`mapWindowForFrame`, rotation clockwise on the page), `map`
(`objects` near the window, the document's `symbols`, its
`CourseDocumentContext`, its `cutFeatures`), `course` (structure, sites,
appearance, view options — the course layer's input without the
document, `docs/course-layer.md` §2), `objects` (layout objects of both
anchors), `textValues`, `description` (§6.2, or null), `label`, `geo`
(§7.3, or null). `resolveSheet` (§5) builds everything but `map` and
`geo`; `pdf-page.ts` adds them from the pinned document.

`ComposedPage`: `frameUm`, one `colours` table both layers index,
`mapLayer { stream, transform }`, `pageLayer { stream }`, `marksLayer:
null`, `images` (§6.3), `geo`, `label`, `warnings` (course-layer and
`symbolise` warnings, prefixed by layer).

### 4.2 `T_map`

`mapLayerTransform(frame, window, paperHeightMm)` is today's `mapToPage`
(`geometry.ts`) in y-up page µm: paper µm relative to the **window
centre** (`originUm`) → scale `frame.width / window.width` (=
`baseMapScale / printScale`) → rotate by **−window rotation** (the
window's clockwise page rotation is a negative, counter-clockwise angle on
the y-up page; the window rotation is −meridian tilt, so the matrix turns
by +tilt) → translate to the **frame centre** (`atUm`). Unit-tested
against `mapToPage` at 0°, 20° and −15°. Symbol dimensions scale with
the matrix (the ISOM rule that the overprint enlarges with the map);
`documentFactor` stays the document's (03 §6.6).

Base-map scale and meridian tilt come from `getBaseMapInfo` only (§10.1).

### 4.3 The map layer

1. `courseLayer({ …input.course, objects, viewOptions: { …, window,
   textValues }, document: map.context, cutFeatures })`. `window` is the
   frame mapped back through `T_map⁻¹`, grown by 1 mm
   (`RING_BLEED_UM`), as the outer ring of a map-anchored white-out
   outside: the clip trims it, and no anti-aliased seam of map ink is left
   where a ring edge and the clip edge coincide.
2. `courseRenderInput(map, layer)` → one `symbolise` call: lower purple
   under the line art, map-anchored white-outs at upper white, upper
   purple and the layout objects' colours on top — the stack's order, no
   sandwich, nothing drawn twice.
3. Emitted as `q <frame> re W n  q <T_map> cm 4 M <passes> Q  [q <T_map>
   cm <map images> Q]  Q`; coordinates integer µm relative to the window
   centre under a 9-decimal `cm` (05 §5.2, `map-rendering.md` §5.3).

A document whose stack is not aligned (no lower / upper purple) throws
`CourseStackError` out of `composePage`; whether `maps.pdf` then falls
back to the legacy page is C3's call.

### 4.4 The page layer

Page-anchored objects are flipped to y-up page mm, re-anchored as `map`
and drawn by the course layer's own object builder (`layoutObjects`, C0)
with `overprintScale: 1` and the frame, grown by the same 1 mm
(`RING_BLEED_UM`), as the white-out-outside ring (legacy: the ring against
the map frame; the extra millimetre is white on the white sheet and keeps
the ring's outer edge off the frame clip's edge, so no map ink seam shows
there either), plus the description block
(§6.2), in one `symbolise` call. Emitted as `q <µm → pt> cm 4 M <passes>
[<page images>] Q` after the map layer, **unclipped**: 05 §5.1 clips the
page layer to the printable area, but legacy never clipped to
`printMarginMm` (it only warns, `validate.ts`), and slice C keeps that.

**Colour table.** The page layer shares the map layer's table: the
course layer's completed stack (`layer.colours`, upper white included),
then `#ffffff` and the block's ink when a block is drawn, then the hex
colours of page objects in first-use order (`withObjectColours`). So a
page white-out prints in the stack's upper white, a page 709 in its upper
purple at the size the map draws it (`documentFactor × scaleRatio`), and
the block and page objects follow the map. Page-layer order is
therefore colour order: page white-outs, then the block's white sheet
and ink, then other page-object colours (legacy: page white-outs, block,
page foreground — the same order).

### 4.5 Many pages

`renderCoursePages` writes every sheet into **one** `PdfWriter`
(05 §5.10): one font object per face subset at `save()` to the union of
all pages' glyphs, one form XObject per distinct glyph part (7xx parts
and IOF pictograms included), one image XObject per distinct PNG.

## 5. `resolveSheet`

`packages/api/src/course-maps/resolve-sheet.ts` — the 08 §4.6 boundary
for slice C: `resolveSheet(input)` calls `resolveMapLayout` (unchanged,
so the legacy SVG page and this one resolve the same layout; templates
and `course_maps` rows unchanged, 09 §4 C) and returns `{ layout, sheet }`
with `sheet` = `PageInput` minus `map` and `geo`.

### 5.1 Fields

| Page input | From |
|---|---|
| `paper` | `getPaperDimensions(paper, orientation, custom)` |
| `frame`, `window` | `document.mapFrame`, `layout.window` (`mapScale` and `meridianTiltDeg` from `getBaseMapInfo`) |
| `course.appearance` | `appearanceFromTemplate(document.appearance)` — multipliers of the library sizes (`docs/course-layer.md` §2) |
| `course.viewOptions` | `allControls` = `kind === "all_controls"`, `labelMode`, `overprintScale` from the layout |
| `objects`, `textValues` | `document.objects` (template + sheet), `layout.textValues` |
| `description` | `document.description` position and cell size, `layout.descriptionRows` / `descriptionHeader`, title = course name, else map name; null when the template hides the block |
| `label` | course name, else map name (page label and outline title, §7.2) |

### 5.2 Course structure

- **Sites**: `layout.controls` (start and finish from the course
  geometry, controls from `course_controls`, all placed controls for
  all-controls sheets), one per id.
- **Course sheets**: a v1 structure with one item per layout control in
  order, `role` = its type; `labelOffsets` = stored label position −
  site; `extras` = the geometry's `marked_route`, `forbidden_route` and
  `restricted_line` lines. Free order is carried as `orderMode`.
- **All-controls sheets**: `structure: null`, every site drawn with
  codes (`viewOptions.allControls`).
- **Authored geometry** only when `courses.geometry_source = "ocd"`
  (`docs/course-layer.md` §2): circle gaps from the geometry's `cuts`,
  and — when the geometry has exactly one leg into each item after the
  first — each leg's path with its gaps, or its pre-clipped polyline as
  the drawn piece. Every other course (`editor`, `xml`, none) gets legs
  and automatic cuts from the course layer, with cut features from the
  pinned document (`cutFeaturesOfDocument`, §3.4 there).

`pdf-page.ts` adds the map part: `sheetForMapRow(row, { event,
allControls, mapInfo })` maps a `course_maps` row (with template and
course, as `maps.pdf` loads it) to its sheet through `resolveSheet`;
`loadPinnedPrintDocument(db, eventId)` returns the prepared document,
`getBaseMapInfo` and the pinned `map_files` row's rotation correction,
or null on the legacy path; `pageInputFor(doc, sheet, geo)` selects the
document objects within 20 mm of the window's bounding box (C6's
`objectsNear`, the legacy crop's padding).

## 6. Page objects, the description block and graphics

### 6.1 Page-anchored objects

All `course-maps` schema kinds, as on the map (`docs/course-layer.md`
§3.6) but in page mm: text with placeholders, lines and paths (dashes as
legacy print draws them), rectangles, `solid` fills, `whiteout`,
`whiteoutInverted` (ring against the frame + 1 mm, §4.4), `outOfBounds` (709 / 709.b /
709.c from the library), images (§6.3). Sizes are page mm and never
divided by `overprintScale`. User colours print through the inverse
naive conversion in `cmyk` and as the hex in `rgb` (§2).

### 6.2 Description block

`descriptionBlock(input, paperHeightMm, colourOf)` (`print/description.ts`)
reproduces the legacy SVG block (`description-svg.ts`) formula for
formula, as objects for the shared stage:

- white sheet (area) with a 0.35 mm border; 8 cells wide; 3 header rows
  (event, classes, course · length · climb with thick verticals after
  columns 3 and 6) or 1 title row; rules 0.15 / 0.35 mm by
  `DESCRIPTION_THICK_COLUMNS` and `hasThickRuleBelow`;
- text in Liberation Sans, centred: header 0.42 / 0.40 × cell at
  baselines 0.68 / 1.68 / 2.68 × cell, title 0.48, sequence and code
  0.43 at 0.67, F dimension 0.34, wide-row length 0.9 × 0.43; header
  text, title and lengths carry `weight: 700` (drawn regular while only
  the regular faces ship — §7.4, SLICES row C8);
- pictograms as **point symbols**: `iofSymbolGlyph(key)` converts the
  `iof-symbols.ts` data (absolute `M` / `L` / `C` / `Z` paths and
  circles) into a glyph at 100 µm per unit, y flipped — `fill="black"` →
  fill or disc, a stroke width → stroke or ring with flat caps and the
  element's join; converted once per key at first use (no generated
  file: one source of truth) and scaled to 0.8 × cell per 200 units (the
  legacy 10 % inset). Start in column A, C–H by `descriptionCells`, wide
  special / finish symbols centred across the block. In the PDF each
  pictogram is one form XObject per document (05 §5.6).

### 6.3 Graphics

Image objects become `PageImage`s in their layer's space (map-anchored:
paper µm under `T_map`, so they turn with a rotated window; page-anchored:
page µm). The composer takes PNG bytes per graphic id; `writePage`
embeds each distinct PNG once (`/Subtype /Image`, `Im<n>` in first-use
order) and draws it `q [<rect> re W n] <w 0 0 h x y> cm /Imn Do Q`,
stretched to the rectangle like the legacy `preserveAspectRatio="none"`,
the crop's part filling it under a clip. An image without bytes is
skipped with `IMAGE_MISSING`.

**SVG logos** are rasterised in the API at render time (05 §5.7 a), so
`graphics` rows stay as uploaded: resvg at 600 dpi of the placed size
(the crop's source size), at most 4096 px per side, text in the
bundled faces only (no system fonts),
stretched to the exact pixel box; cached per graphic and size within one
export. The composer itself never sees SVG — `@oxygen/shared/print`
stays isomorphic (§1; a test reads the module's imports). Images are
DeviceRGB in both modes: CMYK conversion of images belongs to the
offset profile (05 §5.7, §2).

## 7. Boxes, metadata and geospatial

### 7.1 Boxes and metadata

`MediaBox` = `TrimBox` = the paper; no `CropBox`, no bleed (§1, §2).
`Info` from the caller: C3 passes the title (`<event> · <map>` for one
page, `<event> maps` for several, as `maps.pdf` names them today) and
the organiser as author; `Creator` / `Producer` / dates per §1 and §3.2.

### 7.2 Page labels and outlines

`/PageLabels` gives every page its label as the prefix (`/P`, UTF-16) —
the course name, else the map name — so viewers show "Blå" rather than
"1". `/Outlines` is flat: one item per page with the same title,
`/Dest [page /Fit]`, `/Prev` / `/Next`, `/Count` = pages. Both are written
at `save()` (`PdfWriter.addPage({ label, outlineTitle })`).

### 7.3 `/Measure /GEO`

Every map frame of a georeferenced document gets a viewport (05 §5.9;
ISO 32000-2 §12.9.3), on the page's `/VP`:

```
<< /Type /Viewport /BBox [frame in pt]
   /Measure << /Type /Measure /Subtype /GEO /Bounds [0 0 0 1 1 1 1 0]
     /GCS << /Type /GEOGCS /EPSG 4326 /WKT (GEOGCS["WGS 84",…]) >>
     /GPTS [lat lng ×4] /LPTS [0 0 0 1 1 1 1 0] /PDU [/M /SQM /DEG] >> >>
```

`geoViewport(frameUm, T_map, paperFrame)` (`print/geo.ts`): the frame's
corners (lower-left, upper-left, upper-right, lower-right — the `LPTS`
order) through `T_map⁻¹` to paper µm, to native units
(`× unitsPerMm / 1000`), through A11's `mapGeo.paperToWgs84` with the
`PaperFrame` of the header's georeferencing and the pinned row's
`rotation_correction`. Four points carry window rotation and grid
convergence with no special case. No viewport when `epsgOf` is null
(no projectable CRS). Lat / long are written with 8 decimals.

### 7.4 Differences from the legacy page for C3's list

Beyond §10.4 and the two differences of decision (3): spec-sized 7xx
symbols, the 701 turned to the first control, 709 from the library and
start / finish clearance (C0); the block's header, title and lengths
in regular weight (decided 2026-10-24, bold face in SLICES row C8); Liberation Sans in the block (the legacy font stack lists
DejaVu Sans first); map-anchored images, control numbers and map text
turn with a rotated window (legacy drew the overprint upright in page
space); imported `marked_route` / `restricted_line` / `forbidden_route`
lines drawn by the library; images DeviceRGB in `cmyk`.

### 7.5 Tests

| Test | Covers |
|---|---|
| `print/__tests__/page.test.ts` | `T_map` against `mapToPage` (0°, ±rotation), inverse, frame in map space, `flipPageObject`, `transformPassStream` (slices kept, widths / taper / glyph instances / text scaled and turned, hatch lines on the transformed lines) |
| `print/__tests__/description.test.ts` | every `IOF_SYMBOLS` key converts; 2.4 one fill, 1.10 one disc, 0.3 two strokes + disc, Bézier flags; block size and position, border, thick / thin rules, header sizes and weight, F text 0.34 × cell, pictograms centred at 0.8 × cell, one symbol per key |
| `print/__tests__/compose.test.ts` | one colour-sorted map stream with lower purple < black < upper purple; block text / rules / pictograms on appended colours; no block → empty page layer; map ring outer boundary = frame (+1 mm) through `T_map⁻¹`, page ring = frame + 1 mm, page white-out at upper white; placeholders; rotated `T_map`; images in layer space; `CourseStackError` |
| `print/__tests__/write-page.test.ts` | operator order (sheet, frame clip, `T_map` `cm`, page `cm`), no `rg` in `cmyk` / no `k` in `rgb`, rotated `cm`, two pages sharing font, glyph forms and image XObject, page labels and outlines, `/Measure /GEO` (SWEREF99 TM corners near 58.6° N 15° E, rotated corners), deterministic bytes, missing image warning |
| `print/__tests__/isomorphic.test.ts` | no Node API, `Buffer`, sharp or resvg in the module |
| `packages/api/src/__tests__/course-print-sheet.test.ts` | `resolveSheet`: paper / frame / window / tilt, structure and roles, unique sites, label offsets, extras, `editor` vs `ocd` authored geometry, description block / hidden, all-controls, free order |
| `packages/api/src/__tests__/integration/course-print.test.ts` | the E2E fixture map pinned on a `vector` event: legacy event → no print document; two sheets → one PDF of two A4 pages, `TrimBox`, labels, outlines, Type0 / CIDFontType2 shared, frame clip and `T_map`, no `rg`, PNG and rasterised SVG logos shared (600 dpi), `/Measure /GEO` of the fixture's georeference, deterministic bytes |
| `packages/api/src/render/__tests__/page-raster.test.ts` | the page oracle: white outside the frame and the ring, map inside, page box on top; rotated building where `T_map` puts it; block position on A4 |
| `packages/api/src/render/__tests__/golden-files.test.ts` | `page-sprint-a4`, `page-ring`, `page-rotated` match the page oracle |

The page goldens (`e2e/__golden__/map-gl/page-*.png`, 05 §7 tier 3) are
the page oracle (`render/page-raster.ts`): the map layer moved through
`T_map` into page µm (`transformPassStream`) and rasterised over the
frame alone — the frame clip is the raster's extent — composited with the
page layer on white paper, at 10 px/mm, supersampled 2× (an A4 sheet at
the scene goldens' 4× would be a ~400 MB intermediate). The WebGL2
golden spec does not draw pages (the viewer has no page view until slice
D); the PDF golden tier compares the `rgb` page rasterised by
`pdftocairo` against them (§9.2).

## 8. The `maps.pdf` route

`GET /api/maps/:nameId/maps.pdf` (`docs/course-maps.md` API: query
`maps` / `courses` / `allControls`, `courses.view`, 200-page cap, pages
ordered by course, `sort_order`, `seq`) has two paths behind one
handler (`packages/api/src/course-maps/routes.ts`). The switch gates the
read only (`map-pipeline-switch.md` §3.4): both paths read the same
`course_maps`, `map_templates`, course, control and graphics rows, and
neither writes anything, so **rollback is the switch** — flip the event
back to `legacy` and the same rows print through rsvg.

### 8.1 Which path prints

| Event | Path | `X-Print-Pipeline` |
|---|---|---|
| `map_pipeline = vector` and the latest `map_files` row pins a document | the composer, §8.2 | `vector` |
| `legacy`, or `vector` without a pin | SVG → `rsvg-convert` → pdf-lib merge, as before slice C (`docs/course-maps.md` "Rendering pipeline") | `legacy` |
| `vector` with a pin whose colour stack is not aligned (`course.CourseStackError`: no lower / upper purple) | the legacy path, with one `warn` log line per request naming the document hash | `legacy-fallback` |

The decision is `loadPinnedPrintDocument(db, eventId)` (`pdf-page.ts`),
which reads `getBaseMapInfo` (§10.1) — the same function, so the
preview and the print never disagree on the path. Every other error on
the vector path is an error (400 with the message, as the legacy path
answers), not a fallback: a broken composer must be seen, not hidden
behind rsvg.

### 8.2 The vector path

1. The rows `findMapRows` selects, each turned into a sheet by
   `sheetForMapRow` (§5) with the event, its controls and the pinned
   document's `getBaseMapInfo` scale and meridian tilt.
2. Graphics referenced by any row's or template's image objects (event
   or club scope), loaded once — the same query as the legacy resolver.
3. `renderCoursePages({ document, rotationCorrectionDeg, sheets,
   graphics, mode: "cmyk", info })`: one `PdfWriter`, one page per
   sheet, fonts, glyph forms and images shared (§4.5). Not
   `deterministic`: real dates (§3.2).
4. Under a `renderGate()` permit like tiles and `window.png`, but
   **without the queue cap**: the request waits for a permit and never
   answers 503 — the export is a browser download, where a 503 body
   would arrive as a broken file, and the layout editor's `window.png`
   requests share the four-deep queue. Composing runs on the API's event loop
   and yields between pages (`setImmediate`), so other requests run
   between the pages of a long export; each page is one synchronous
   compose + write.
5. Composer and writer warnings (`NO_FONT` for a page text in a family
   with no face, `IMAGE_MISSING`, `SVG_RASTER`) go to the log at `warn`;
   the PDF is still served.

The route always writes `cmyk` (decision (2), 2026-10-23: print profiles
are a later row). `rgb` exists for the golden tier and proofs; no query
parameter reaches it.

### 8.3 Response

As before slice C: `Content-Type: application/pdf`,
`Content-Disposition: attachment; filename="<event>_<map>.pdf"` for one
page and `"<event>_maps.pdf"` for several, `Cache-Control: no-store`;
404 for an unknown event or no maps, 400 for a bad selection. New:
**`X-Print-Pipeline: vector | legacy | legacy-fallback`** names the
path that drew the file (E2E and support read it). Any error on the
vector path other than `CourseStackError` is a 400 with its message. `Info /Title` per §7.1 (`<event> · <map>`
for one page, `<event> maps` for several), `/Author` the organiser.

### 8.4 Sanctioned differences from the legacy PDF

The 03 §6.9 rule as `map-rendering.md` §6.4 applies it: a place where
the vector page differs from the legacy page of the same sheet is either
on this list or a bug. C7's corpus print run classifies by these codes;
S2 judges the print shop's view of the first two.

| Code | Difference | Decided |
|---|---|---|
| `cmyk-colour` | DeviceCMYK from the colour stack (§2) against the legacy page's RGB from rsvg: on screen and through a printer's own conversion the colours shift | user, 2026-10-23 (3) |
| `colour-overrides` | the event map's `colorOverrides` are not applied (the column stays, unused) | user, 2026-10-23 (3) |
| `north-lines-below` | `northLinesBelow` is not applied | user, 2026-10-23 (3) |
| `description-weight` | the description block's header, title and wide-row lengths in regular weight (`weight: 700` kept; no bold face ships until row C8) | user, 2026-10-24 (C2 question) |
| `description-font` | Liberation Sans in the block (the legacy font stack lists DejaVu Sans first) | C2, §7.4 |
| `course-symbol-sizes` | 7xx symbols at the library's dimensions × the document factor, the template's appearance as multipliers (`course-layer.md` §2) | user, 2026-10-24 (C0 question) |
| `start-turned` | the 701 start triangle turned to the first control | C0 |
| `library-course-lines` | 709 out-of-bounds boundary and imported `marked_route` / `restricted_line` / `forbidden_route` lines drawn by the library | C0, C2 |
| `start-finish-clearance` | legs cut at the start / finish symbols' own outlines | C0 |
| `size-aware-cuts` | automatic circle and leg cuts from the pinned document with clearance = feature radius + line width / 2 + 0.25 mm | user, 2026-10-24 (C5 question) |
| `rotated-overprint` | on a rotated window, map-anchored images, control numbers and map text turn with the map (legacy drew the overprint upright in page space) | C2, §7.4 |
| `image-rgb` | images stay DeviceRGB in `cmyk` (CMYK images are the profiles row) | C2, §7.4 |
| `library-symbols`, `stack-order` | the base map as the window preview draws it (§10.4): matched symbols drawn by the library, every `map-rendering.md` §6.4 code, and the document's own colour order — on `e2e/test.ocd` the stack puts yellow above lower purple, so legs lie under the yellow area | 2026-10-23 slice C split; C6 |

Geometry is not on the list: paper size, frame, window, scale, rotation
and control positions agree with the legacy page (the integration and
E2E tests check page count and size; C7 compares the rasters).

## 9. Tests and CI

### 9.1 Tests

| Test | Covers |
|---|---|
| `packages/api/src/__tests__/integration/course-maps.test.ts` "maps.pdf route switch" | `vector` + pin → one composed PDF, pages at each template's paper (A4, A5), never the rsvg converter, `X-Print-Pipeline: vector`, `Info` title for one and several pages, file names; selection errors unchanged; `qpdf --check` clean; a `legacy` event, a `vector` event without a pin, and the same event flipped back all print legacy; an injected `CourseStackError` falls back (`legacy-fallback`); any other injected error is a 400 |
| `packages/api/src/__tests__/integration/course-print.test.ts` | §7.5's row, plus `qpdf --check` of both colour modes |
| `packages/api/src/render/__tests__/pdf-golden.test.ts` | the PDF golden tier, §9.2, and `qpdf --check` on every file it writes; `boxDown`; the swatch read-back |
| `e2e/course-maps.spec.ts` (`map-legacy`, `map-vector`) | the export flows of the maps page: page count and A4 page size of the single-map, course and all-controls downloads (05 §7), `X-Print-Pipeline` equal to the project's value |

### 9.2 The PDF golden tier

05 §7 tier 3, the third backend of `map-rendering.md` §6.2: every golden
scene (`render.goldenSceneNames`: the contract fixtures, the pilot scene,
the library and course scenes) and every page scene (§7.5), written by
the print backend and rasterised by poppler, against the reference
raster. `packages/api/src/render/pdf-golden.ts`:

- **Scene pages.** One page the size of the scene's golden frame
  (`goldenFrame(stream).bounds`), the stream at 1:1 under
  `layerMatrix({ scaleRatio: 1, atPt: −frame origin })`, the colours as a
  stack from the scene's hex through `rgbToCmykNaive` (exact for the
  library and course scenes, whose hex is `cmykToHex` of their stack).
  **Page scenes** go through `composePage` → `writePage` exactly as the
  route does.
- **Rasteriser: `pdftocairo`** (poppler-utils), at the oracle's own
  supersample (4× scenes, 2× pages) and box-filtered down, so both sides
  of the comparison average the same sub-pixel grid. `pdftoppm` (Splash)
  was measured first and rejected: it snaps fills and hairlines to the
  pixel grid and puts 0.4–5 % of the pixels of geometry-exact scenes
  beyond the tolerance even supersampled (`lib-hatch` 2.4 %,
  `lib-borders` 2.1 %, `text-with-halo` 5.1 % at 4×); Cairo matches the
  oracle to ≤ 0.13 % on every scene without embedded text.
- **`rgb`** against the committed golden (`e2e/__golden__/map-gl/`) at
  `diffImages(…, 16)` and **≤ 0.5 %** differing pixels. A scene with
  text passes is written twice: with **text as glyph outlines**
  (`text: "outline"`), held to 0.5 % — glyphs are placed by one `Tm`
  each in both modes, so this run proves the text geometry — and with
  **embedded fonts**, held to **≤ 2.5 %**: the rasteriser draws an
  embedded font through FreeType's glyph renderer, not the outlines the
  oracle fills, the same situation as the WebGL2 MSDF text tier
  (`map-rendering.md` §6.2).
- **`cmyk`** against the oracle drawn in the **rasteriser's own CMYK →
  RGB conversion** of each stack colour (`rasteriserCmykColours`: one
  swatch per colour, read back), same budgets. Poppler does not convert
  CMYK naively (purple, brown and greens differ by up to ~100 levels per
  channel; even 100 % K comes back as `#231f20`, not `#000000`), so a
  "naive conversion with a looser tolerance" (05 §7)
  would need a tolerance that hides geometry; making the conversion
  explicit keeps the 16-level tolerance.

Measured at introduction (C3, 2026-10-24; poppler 22.02, percent of
pixels beyond 16 levels; scenes not listed are 0.000 % in all columns):

| Scene | `rgb` embedded fonts | `rgb` outlines | `cmyk` embedded fonts |
|---|---|---|---|
| `dashed-bezier-stroke` | 0.036 | — | 0.021 |
| `pilot-scene` | 0.038 | 0.000 | 0.038 |
| `lib-text` | 1.210 | 0.000 | 0.947 |
| `lib-halos` | 0.369 | 0.000 | 0.369 |
| `lib-text-layout` | 1.964 | 0.000 | 1.662 |
| `lib-colour-order` | 0.118 | 0.000 | 0.038 |
| `course-legs` | 0.125 | 0.000 | 0.085 |
| `course-cuts` | 0.098 | 0.000 | 0.092 |
| `course-objects` | 0.037 | 0.000 | 0.034 |
| `course-sprint` | 0.013 | 0.000 | 0.013 |
| `course-all-controls` | 0.478 | 0.000 | 0.398 |
| `page-sprint-a4` | 0.073 | — | 0.062 |
| `page-ring` | 0.057 | — | 0.045 |
| `page-rotated` | 0.027 | — | 0.015 |

Every outline run is 0.000 %: the residual of the embedded-font runs is
the glyph renderer alone, largest on the small text of `lib-text` and
`lib-text-layout`. The page scenes' outline runs are not written (their
text is a few short strings, already under 0.5 % with fonts).

### 9.3 `qpdf --check`

Every file the golden tier writes (both modes) and the composed route
output in the integration test must pass `qpdf --check` (exit 0, "No
syntax or stream encoding errors"). The tests that need `qpdf` or
`pdftocairo` skip when a tool is missing and **fail under CI**
(`process.env.CI`): `.github/workflows/ci.yml` installs `qpdf` and
`poppler-utils` in the unit and integration jobs.

### 9.4 Tools in the production image (S3)

09 §7 S3: the tools go into the production image if they add ≤ 30 MB,
else they stay CI-only. Measured 2026-10-24 with
`docker build --network host --target api` and `docker image inspect`:
1 001 907 361 bytes without, 1 016 377 611 bytes with `qpdf` and
`poppler-utils` in the base stage's `apt-get install` — **+14.5 MB**
(qpdf 11.3.0, poppler 22.12.0; `libcairo2` is already there for
librsvg). So they are **in-image** (`Dockerfile` base stage): a running
instance can check and rasterise what it prints (C7's corpus run, a
future preflight) without a second toolchain. `rsvg-convert` and
`fonts-liberation` stay until slice E removes the legacy path (09 §9
step 5).

## 10. Layout-editor preview (interim)

`GET /api/maps/:nameId/window.png` feeds `MapLayoutEditor` its map
sandwich (`docs/map-color-stack.md`: full → lower purple → ink →
whiteouts → upper purple). The URL, the query parameters, the 4096 px and
600 dpi caps, the cache headers and the 503 on a full render queue are
unchanged (`docs/course-maps.md` API).

### 10.1 Which path draws it

| Event | Path |
|---|---|
| `map_pipeline = vector` and the latest `map_files` row pins a document | the reference raster, §10.2 |
| `legacy`, or `vector` without a pin | the OCAD → SVG → resvg path, as before this slice |

`getBaseMapInfo(db, eventId)` makes the call and returns
`{ scale, meridianTiltDeg, version, document }`. With a pin, `document`
is `{ hash }`, `version` is the document hash, `scale` is the header's
`mapScale` and `meridianTiltDeg` is the report's
`north.meridian.medianTiltDeg` (0 when there is none) — the values the
A11 dual write puts into the `map_files` columns, so both branches agree
on the same map (integration-tested). On the legacy path `document` is
`null`. C2 and C3 read this one function.

### 10.2 The render

1. Window: `mapWindowForFrame(frame, {cx, cy}, scale, printScale, rot)`,
   unchanged. The axis-aligned `windowBoundingBox` of it is the raster's
   paper area (paper mm = document µm / 1000, y up; the legacy OCAD
   unit/100 is the same space).
2. Objects: those whose path extent comes within 20 mm of the bbox (the
   legacy crop's padding). The document is decoded once per hash
   (`prepareDocument`, the last two hashes kept in-process).
3. `documentRenderInput` → `symbolise` → (layer filter) →
   `rasterisePassStream` with explicit `bounds`, so the resvg off-frame
   guard of `map-rendering.md` §5.1 applies, at
   `pxPerMm = widthPx / window.width`.
4. Rotation is applied to the raster: the bbox image is rotated about its
   centre by `rot` (positive = clockwise on the page, as the legacy SVG's
   `rotate(rot, cx, cy)`) and cropped to the centre `widthPx × heightPx`.
5. The permit comes from `renderGate()` as for tiles and the legacy
   window; a full queue is a 503 with `Retry-After`.

Output is exactly `round(wMm/25.4·dpi) × round(hMm/25.4·dpi)` for both
layers, rotated or not.

### 10.3 Layers

- `layer=full`: the whole stack on opaque white.
- `layer=ink`: the passes whose colour index is **above** the stack index
  of palette id `purple-lower`, on transparent. The split is a colour
  index filter on the colour-sorted pass stream (05 §3); everything at
  or below that index is the "lower" part, which the editor draws itself
  (`course-overlay-lower`) and which is never served.
- A stack without a `purple-lower` row (only imports older than colour
  alignment lack it): the first entry with `purpleRole: "lower"` is the
  boundary; with none, the ink layer is a full-size transparent PNG and
  the server logs one warning per document hash (re-import fixes it).
  Decided in C6, 2026-10-23.

Which colours are ink is therefore the document's own stack order, not
the legacy regex classification (`map-color-stack.ts`): on an aligned ISOM
map black, blue and brown line / point colours are ink, as before; where
a map's source order differs from the IOF rewrite the split follows the
document.

### 10.4 Sanctioned differences from the legacy window

Decision 2026-10-23 (Slice C split): library-drawn symbols for matched
symbols; the shared naive CMYK → RGB conversion (`stackColour`) instead
of the legacy RGB; `colorOverrides` and `northLinesBelow` are not applied
on the vector path (the column values stay, unused); the document's stack
order decides the ink split (§10.3). Geometry — window, scale, rotation,
size — agrees; the integration tests compare against the legacy window
of the same map for that.

### 10.5 Cache

In-process PNG cache key `[eventId, version, cx, cy, wMm, hMm,
printScale, dpi, rot, layer]` with `version` = document hash, so a
re-pin or re-import is a new entry and a rotated window is its own.
ETag / 304 / `X-Cache` as before.

### 10.6 Interim

The preview exists because the editor composes raster layers
(05 §5.12). Slice D replaces the editor's sandwich with the vector layer
and retires `layer=ink`; the legacy branch stays until the legacy
pipeline is removed. The document branch is the second production job of
the reference raster (`map-rendering.md` §5.1).

### Tests

| Test | Covers |
|---|---|
| `packages/api/src/render/__tests__/window-raster.test.ts` | boundary choice and fallbacks; pass filter; object selection; full / ink probes; ink at a moved boundary; stack without lower purple; 90° rotation direction |
| `packages/api/src/__tests__/integration/course-maps.test.ts` "window.png under a pinned document" | `getBaseMapInfo` branch equality and the unpinned fallback; full size / colour / cache; ink transparency and empty window; rotated entry; agreement with the legacy window of the same map |

## Pending in this chapter

- **Composing off the event loop**: each page is composed and written
  synchronously on the API's event loop (§8.2 step 4 yields only between
  pages; 05 Appendix B: hundreds of ms per page). A worker thread if
  C7's corpus run shows pages long enough to delay a card readout.
- **Golden tier on CI's poppler**: the budgets were measured with poppler
  22.02 (dev) and 22.12 (image); the CI runner's distribution may ship a
  newer one. A drift beyond the budgets is a rasteriser change, re-measured
  and recorded here, not a reason to loosen the 0.5 %.
- **Bold description-block text** (SLICES row C8): the block's header,
  title and lengths carry `weight: 700` but print regular — only the
  regular faces ship (`map-rendering.md` §4.10) and `symbolise` picks a
  font by family. Decided 2026-10-24: regular weight now, a sanctioned
  difference (§7.4); C8 ships Liberation Sans Bold with weight-aware font
  resolution.
- **Print profiles** (05 §5.5): `cmyk-offset`, `/Separation`, overprint,
  PDF/X-4 and output intents, `colourOverrides`, `minLineWidthMm`, bleed
  and crop marks (the marks layer), CMYK images, the test sheet — a later
  row (decision (2), 2026-10-23).
- **Filter regions by symbol** (05 §5.3, 04 §7): the stream has no region
  concept yet; `clipOperators` is the primitive the composer will use.
- **One window shared by several pages** (05 §5.10): two sheets on the
  same window (a course and its all-controls sheet, forked variants)
  re-symbolise and re-emit the map content per page; a shared form
  XObject of the window's base map comes with per-variant pages (08).
- **Vector SVG logos** (05 §5.7 b): a safe SVG subset as form XObjects;
  rasterised at 600 dpi until a club asks.
- **Several frames per sheet** (map exchange on one sheet, 05 §5.9) and
  per-variant pages (08): one frame per page in slice C.
- **Serif and mono faces**: no file ships (`map-rendering.md` §4.10), so
  no PDF font either.
- §10 is retired by slice D (§10.6); §11 (corpus numbers) is C7's.
