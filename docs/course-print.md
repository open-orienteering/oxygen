# Course print

How a course map is printed from the vector pipeline: the PDF
operators, the colour stack on paper and the base map facts a print
reads.
Normative for slice C of the vector map pipeline (research:
`docs/research/vector-map-pipeline/` 05, 09 §4 C).

> §1–3 (writer, colour modes, fonts and determinism) are C1's; §4–7
> (page model, `resolveSheet`, layers, page objects and graphics, boxes,
> metadata and geospatial) C2's; §8–9 (route, golden PDFs, CI) C3's;
> §10 (`getBaseMapInfo`; the layout-editor preview until E4a) is C6's; §11 (corpus numbers) C7's. How a *pass* becomes PDF content is
> `docs/map-rendering.md` §5.3; this chapter owns everything around it.

Status: **draft** — §1–3 written by C1, §10 by C6 (2026-10-23), §4–7 by
C2, §8–9 by C3, §11 by C7 (2026-10-24).

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
| `print/description-sheet.ts` | description sheets: the block tiled on A4, a page drawn on the writer (§6.4); the options' constants are `course-maps/description-sheet-options.ts` (root export, read by the web dialog too) |
| `print/geo.ts` | the `/Measure /GEO` viewport (§7.3) |
| `print/__fixtures__/pages.ts` | the page scenes (§7.5) |
| `print/__fixtures__/description-sheets.ts` | description-sheet blocks and the `descriptions-a4` scene (§6.4, §7.5) |
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
  `F<n>`; `glyph(mesh, matrix?)` returns `G<n>` for the part drawn
  through `matrix` (the form's `/Matrix`: glyph µm → the layer unit, a
  turn class folded in, C11); `glyphOutline` serves the
  fallback (§3.1). Names are handed out in first-use order — never a
  random suffix.
- **Per document, not per page** (05 §5.10): one font object per face,
  subset at `save()` to the union of every page's glyphs; one form
  XObject per distinct glyph part and `/Matrix` (none for the identity),
  deduplicated by matrix, content and bounding box, so equal parts from
  two separately symbolised streams share one object even when the
  streams number them differently.
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

The bundled faces (Liberation Sans Regular and Bold, Liberation Sans
Narrow; `map-rendering.md` §4.10) are embedded per document, each as its own font object, as

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
appearance, view options, filter regions, and the event's course objects
in scope of the sheet — `objects`, `docs/course-layer.md` §8.3 — the
course layer's input without the document, `docs/course-layer.md` §2;
stored `filter_region` objects reach the page's clip paths through them),
`objects` (the template's and the
sheet's layout objects, all page-anchored since F12), `textValues`, `description` (§6.2, or null), `label`, `geo`
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

Base-map scale and meridian tilt come from `getBaseMapInfo` only (§10).

### 4.3 The map layer

1. `courseLayer({ …input.course, objects, viewOptions: { …, window,
   textValues }, document: map.context, cutFeatures })`. `window` is the
   frame mapped back through `T_map⁻¹`, grown by 1 mm
   (`RING_BLEED_UM`), as the outer ring of a toner saver's white-out
   outside: the clip trims it, and no anti-aliased seam of map ink is left
   where a ring edge and the clip edge coincide.
2. `courseRenderInput(map, layer)` → one `symbolise` call: lower purple
   under the line art, white-out course objects at upper white, upper
   purple and the course objects' colours on top, a toner saver's white
   above them all (`course-layer.md` §3.6, P1) — the stack's order, no
   sandwich, nothing drawn twice. The layer's filter regions go into the
   same call (`regions`, `regionObjectLimit`; `map-rendering.md` §4.11):
   hidden objects leave the stream, clipped passes carry masks that the
   operators write as `q <frame + region> W* n … Q` (`map-rendering.md`
   §5.3).
3. Emitted — the operators also get the frame, which they take back
   through `T_map⁻¹` and use to leave out what cannot paint inside it
   (C13, `map-rendering.md` §5.3 "Frame culling") — as `q <frame> re W n  q <T_map> cm 4 M <passes> Q  [q <T_map>
   cm <map images> Q]  Q`; coordinates integers in the layer unit
   (≤ 5 µm printed, a whole fraction of 10 µm; C11) relative to the
   window centre moved onto the 10 µm grid, each path under its own
   anchor, under a 9-decimal `cm` that folds both in (05 §5.2,
   `map-rendering.md` §5.3). The page layer is written the same way at
   1:1 (5 µm units of page µm).

A document whose stack is not aligned (no lower / upper purple) throws
`CourseStackError` out of `composePage`; `maps.pdf` answers 400 with its
reason (§8.1).

### 4.4 The page layer

`course.pageLayer` (`packages/shared/src/course/page-layer.ts`, beside the
course layer so the web worker has it without the PDF writer) builds it;
`composePage` calls it, and the editor's Layout mode draws the same
stream (`course-layout.md` §1).

Layout objects (all page-anchored) are flipped to y-up page mm
(`flipPageObject`) and drawn by the course layer's object builder in its
page form (`pageObjects`, `objects.ts`; F12 split it from the course
objects' `courseObjects`) with the frame, grown by the same 1 mm
(`RING_BLEED_UM`), as the white-out-outside ring (legacy: the ring against
the map frame; the extra millimetre is white on the white sheet and keeps
the ring's outer edge off the frame clip's edge, so no map ink seam shows
there either), plus the description block
(§6.2), in one `symbolise` call. Emitted as `q <µm → pt> cm 4 M <passes>
[<page images>] Q` after the map layer, **unclipped**: 05 §5.1 clips the
page layer to the printable area, but legacy never clipped to
`printMarginMm` (it only warns, `validate.ts`), and slice C keeps that.

**Colour table.** The page layer shares the map layer's table: the
course layer's completed stack (`layer.colours`, upper white included,
ending with the toner saver white when the map layer draws one),
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

**Copies** (F8): a sheet may carry `copies` (`PrintSheet = SheetInput &
{ copies? }`, absent = 1, 0 = no page). It is composed and written once;
`PdfWriter.copyPage(page, n − 1)` adds the other pages, each a page
object that shares the written page's content streams and resources
(`/Contents`, `/Resources`, `/TrimBox`, `/VP`), so a stack of twelve
costs one page's bytes plus eleven small page objects. A copy repeats
the page label and has no outline item (one per composed page).
`writePage` returns its `PdfWriterPage` for this; `renderCoursePages`'s
`pageCount` counts the copies, `onPage` fires once per composed sheet.

### 4.6 Variant pages

A **root** (a course with variation groups, `course-layer.md` §12) has
no page of its own: print is always one variant (08 §5.3). Each of its
own `kind = 'course'` sheets — the layout the variants share (08 §4.6,
`course-maps.md` "Forking contract") — prints once per live child
(`courses.parent_course_id`), in key order (`course.variantList`'s),
whatever selected the sheet (`courses`, `classes`, `maps`, the unfiltered
export):

- **`rowForVariant(row, child)`** (`pdf-page.ts`): the row's template,
  overrides, objects and window centre; the course's name, length,
  climb, structure (the linear `variantStructure`), `course_controls`
  (label offsets), ends and description instructions are the child's;
  its id and classes stay the root's — course objects are scoped to the
  root, and a class prints its root (`rowForClass` first). So the page
  label, outline title, block header and `{course}` are `<root> <key>`
  (`Long AB`), `{variant}` is the key, numbering and legs the
  variant's.
- **The shared window**: a stored centre wins; a NULL one centres on
  every site any alternative visits and the course's ends
  (`sharedWindowCentre`), so every variant page — and the
  all-variations page, and the root's own read in the editor and
  `courseMap.list` — shows the same window. A course split by map
  exchanges keeps its parts' own centring (§5.2 "Part sheets").
- **The all-variations page** (`?allVariations=`, answer 4: for
  officials; the runners' maps are the variant pages):
  `allVariationsRow(row, keys)` prints each own sheet once with the
  spine and every alternative's branch (`course.allVariationStructures`
  — the editor's All-variations view, `course-layer.md` §12.7) in **the
  one purple**: no `tint`, no `allVariations` view option (F7's fixture
  holds), labels as codes. The block lists every visited control once
  in first-seen order without sequence numbers (the course is passed as
  `free_order` to the layout; its structures stay ordered, so legs
  draw); the name, label and `{variant}` carry the keys joined by `/`
  (`Long AB/BA`; after five, `…`: `allVariationsSuffix`). The length is
  the root's (its first-alternatives path).
- **Copies for the hand-out** (`&copies=runners[&spare=n]`, answer 3 —
  variants are pre-set per runner, F6b): each page is repeated once per
  runner it is for, plus `spare`: a variant page per non-removed runner
  with `runner.course_id` = the child (the count
  `course.variantList.runnerCount` shows), a plain course page per runner
  whose own course, else class course, it is; with `?classes=` only that
  class's runners. Pages stay in key order, so the stack comes out
  sorted. A page with no runner and no spare is left out; nothing at all
  is a 400. A per-runner page with the runner's name is **not** printed
  (a separate feature if wanted, SLICES F0).

`courseMap.resolveSheet { seq | classSeq, variantKey }` reads the same
row (`course-layout.md` §1), so Layout mode and Class view draw what
prints. Decided on the user's standing instruction (2026-11-07), for
review: `{course}` is the child's name (templates use `{course}`, and the
runner's map then names her course); copies share one content stream
rather than being re-written; the all-variations block without numbers;
the 200-page cap counts composed pages, copies up to 5 000 pages.

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
| `course.viewOptions` | `allControls` = `kind` is `"all_controls"` or `"setter"` (F10), `setterMarks` likewise (F4: the map-issue points and every crossing point among the sheet's sites, `course-layer.md` §10.3), `labelMode` from the layout; `autoCuts: false` when the event's **Auto cuts** toggle is off (`ResolveSheetInput.autoCuts` from `MapRowContext.autoCuts`; no key when on — `docs/course-layer.md` §3.4, D17); `section` = the row's `section_index` when the course has ≥ 2 parts and it is in range (`layout.section`, F5 — `course-layer.md` §11; no key otherwise, so a one-part course's stream is unchanged) |
| `objects`, `textValues` | `document.objects` (template + sheet), `layout.textValues` |
| `description` | `document.description` position and cell size, `layout.descriptionRows` / `descriptionHeader`, title = course name, else map name; null when the template hides the block |
| `label` | course name, else map name (page label and outline title, §7.2) |

### 5.2 Course structure

- **Sites**: `layout.controls`, one per id, positions from the
  `controls` rows. A course sheet's are its start, its `course_controls`
  and its finish; all-controls sheets take every placed control. Since
  E6 nothing comes from `courses.geometry`: the caller resolves the
  start and finish (`layoutCourseEnds` in `resolve-layout.ts`) by the one
  sequence rule every course reader uses (`courseSequenceOf`,
  `course-layer.md` §6.2 "Readers"): the stored structure's explicit
  ends, else the columns' (`start_name`, `finish_control_id`, the
  flags — a NULL structure reads as the editor reads it), completed by
  the event's lowest-seq start / finish unless `first_as_start` /
  `last_as_finish`; an unplaced (0, 0) start or finish is not drawn.
  `maps.pdf`, `courseMap.resolveSheet` and `courseMap.list` pass the
  event's live controls with `name` and `kind` for it (all the
  rule looks up: a structure's ends are its first and last items). The layout's `legs` (`resolveMapLayout`'s;
  no wire answers them since E-pages) are straight centre-to-centre lines between the
  drawn controls, none under free order; the page draws the course
  layer's own legs. `CourseOverlayControl.cuts` is no longer filled.
- **Course sheets**: a v1 structure with one item per layout control in
  order, `role` = its type, each item's whole stored leg (F1–F4);
  `labelOffsets` = stored label position − site. The **crossing points**
  the stored legs run through join the sites (F4, `course-layer.md`
  §10.3: `courseInputOfLayout` reads them from `ResolveSheetInput.allControls`;
  no other crossing or map-issue point is drawn), and the block derives
  their 13.3 / 13.4 rows (`LayoutCourseSource.crossings`). The course-level lines and areas are course objects (`course-layer.md`
  §8), no longer read from the geometry. Free order is carried as `orderMode`.
- **Part sheets** (F5, `course-layer.md` §11): `PrintMapRow.sectionIndex`
  (`course_maps.section_index`) reaches `resolveMapLayout { section }`.
  On a course of ≥ 2 parts with the section in range, a NULL window
  centre centres on **that part's** placed controls (the exchange
  included, `sectionsOf` over the layout's controls typed by the
  sites' `kind`) and the sheet's `viewOptions.section` draws the part;
  the description block, its header and `{controls}` stay the whole
  course's (answer 2) and carry a **13.5** row after each exchange
  control (derived from the course's own control rows' `kind`, so a
  NULL structure gets it too). A stored centre wins as on any sheet. Out
  of range (a part sheet whose exchange was removed) the sheet is the
  whole course.
- **Variant sheets** (F8, §4.6): a root's sheet as one variant — the
  row's `course` from the child (`rowForVariant`), so the structure,
  sites, block and label are the variant's; `variantKey` reaches
  `textValues.variant`; a NULL window centre is the shared one.
- **The all-variations sheet** (F8, §4.6): `ResolveSheetInput.allVariations`
  with the root's stored structure: `course.structure` is an **array**
  — the spine, then one branch per alternative (ids
  `<course>:<group>:<label>`), each with the sheet's label offsets, the
  layout's start / finish completing an implicit spine end, the crossing
  points any branch runs through among the sites — and the course's
  controls (`allVariationControls`) every visited control once. No
  `tint` is set; `viewOptions` has no `allVariations` key.
- **All-controls sheets**: `structure: null`, every site drawn with
  codes (`viewOptions.allControls`), typed by `kind` (`resolveMapLayout`,
  F4: crossing points as 710, map-issue points as 702, an exchange as a
  control); the block lists the controls only.
- **Setter sheets** (F10, `course-layout.md` §8): `kind = 'setter'` joins
  the all-controls branch of `resolveMapLayout` (no layer change) with
  `ResolveSheetInput.allControls` = the group only — `sheetInputForMapRow`
  filters `ctx.allControls` by `props.controlIds` (`setterSheetInput`,
  `PrintMapRow.props`) and passes no course (a course's setter map draws no
  legs), the `all`-scoped course objects and the row's name as title. So:
  `structure: null`, the group's sites typed by `kind` (702 / 710), codes,
  setter marks, the block the group's control rows in code order with no
  header, at the row's 5 mm cells (`overrides.description.cellSizeMm`).
- **Authored geometry** comes from the stored structure and the controls
  (D1 retired deviation (e), which read the `ocd` GeoJSON): circle gaps
  from `controls.circle_gaps`, legs from the structure's `LegProps` —
  the item's whole stored leg: gaps, style and bends since F1, its
  corridor since F2 (`course-layer.md` §10.1, §10.2; `courses.structure`; aligned to the layout's
  controls on the first site both name, so a start the layout does not
  draw shifts nothing), an empty gap list meaning the automatic cuts. A
  `marked_route` leg prints 707's dashes as one subpath per dash
  (§4.3); a corridor's band is a clip region over the map passes (a
  `W*` clip, §4.3), its edge a lower-purple 705 stroke. Every course gets legs and
  automatic cuts from the course layer, with cut features from the
  pinned document (`cutFeaturesOfDocument`, §3.4 there) — unless the
  event's **Auto cuts** toggle is off: then the sheet carries
  `viewOptions.autoCuts: false` and the page has no automatic slits or
  leg gaps, while the stored circle and leg gaps still print (the
  screen's rule, `course-layer.md` §3.4, D17).

`pdf-page.ts` adds the map part: `sheetForMapRow(row, { event,
allControls, mapInfo, courseObjects?, classesByCourse?, autoCuts? })` maps a `course_maps` row (with template and
course, as `maps.pdf` loads it) to its sheet through `resolveSheet`;
`loadPinnedPrintDocument(db, eventId)` returns the prepared document,
`getBaseMapInfo` and the pinned `map_files` row's rotation correction,
or null on the legacy path; `pageInputFor(doc, sheet, geo)` selects the
document objects within 20 mm of the window's bounding box (C6's
`objectsNear`, the legacy crop's padding).

## 6. Page objects, the description block and graphics

### 6.1 Page-anchored objects

All `course-maps` schema kinds (`docs/course-layer.md` §3.6) in page mm:
text with placeholders, lines and paths (dashes as
legacy print draws them), rectangles, `solid` fills, `whiteout`,
`whiteoutInverted` (ring against the frame + 1 mm, §4.4), `outOfBounds` (709 / 709.b /
709.c from the library), images (§6.3). Sizes are page mm as stored.
User colours print through the inverse
naive conversion in `cmyk` and as the hex in `rgb` (§2).

### 6.2 Description block

`descriptionBlock(input, paperHeightMm, colourOf)` (`print/description.ts`)
reproduces the legacy SVG block (`description-svg.ts`, deleted in E4c)
formula for formula, as objects for the shared stage:

- white sheet (area) with a 0.35 mm border; 8 cells wide; 3 header rows
  (event, classes, course · length · climb with thick verticals after
  columns 3 and 6) or 1 title row; rules 0.15 / 0.35 mm by
  `DESCRIPTION_THICK_COLUMNS` and `hasThickRuleBelow`;
- text in Liberation Sans, centred: header 0.42 / 0.40 × cell at
  baselines 0.68 / 1.68 / 2.68 × cell, title 0.48, sequence and code
  0.43 at 0.67, F dimension 0.34, wide-row length 0.9 × 0.43; header
  text, title and lengths carry `weight: 700` and print in Liberation Sans
  Bold, embedded as its own font object (`map-rendering.md` §4.9–4.10);
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

Image objects become `PageImage`s in their layer's space (an `image`
course object: paper µm under `T_map`, so it turns with a rotated window;
a page-anchored layout object: page µm). The composer takes PNG bytes per graphic id; `writePage`
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

### 6.4 Description sheets

Control descriptions printed on their own, many to a sheet, to cut apart
and hand out at the start (08 §1 Organiser row, §3 "print sheets by
participant count", §4.6 "Control-description sheets"; F11). Printed on
demand from the request's options: no `course_maps` row (the slice F
split's decision, 08 §4.8 — a row would hold three fields and need a list
UI), no base map and no template.

**Route.** `GET /api/maps/:nameId/descriptions.pdf` (`courses.view`;
`packages/api/src/course-maps/descriptions-pdf.ts`):

| Parameter | Values | Default |
|---|---|---|
| `classes` | class seqs, comma-separated, printed in the order given | — |
| `courses` | course seqs, comma-separated; exclusive with `classes` (400) | — |
| (neither) | every class with a course, in class order (`sort_index`, then seq) | |
| `copies` | `count` · `fill` · a number 1–500 | `count` |
| `cell` | `5` · `6` · `7` (mm) | `6` |
| `gap` | mm between blocks, 0–30 | `5` |

- **One block per class** (or per course with `courses=`). The block is
  the map page's (§6.2): rows and header from `resolveMapLayout` — the
  function every sheet resolves through (§5) — on a stand-in A4
  template, so start, controls, special rows, the finish and its
  measured length (with a base map; else the instructions' length only)
  are the sheet's by construction. The header names the class
  (`classes=`, as a class prints its map, `course-layout.md` §6) or every
  class of the course (`courses=`). A class without a course is skipped.
- **Copies.** `count` = the class's runners (not removed, not withdrawn:
  `class.list`'s count) + its `vacant_count`; a course's = the sum over its
  classes; at least 1, so a class with nobody yet still prints a proof.
  `fill` = as many as one sheet holds; a number = that many.
- **Tiling** (`tileDescriptionSheets`, `print/description-sheet.ts`; pure):
  A4 portrait, a 10 mm margin; the block `8 × cell` wide and
  `cell × (rows + 3)` high (`descriptionBlockSize`); columns =
  `⌊(190 + gap) / (8·cell + gap)⌋`, rows likewise over 277 mm. Blocks are
  placed row-major from the top-left. **Classes never share a page**: a
  class's copies run onto as many pages as they need, the next class
  starts a new page, so every page has one label. A 14-row block (12
  controls) fits 4 × 3 at 5 mm, 3 × 2 at 6 and 7 mm (gap 5). A block
  taller than the usable page is a 400 `DESCRIPTION_TOO_TALL` naming the
  class and the cell size (a 40-control course at 7 mm).
- **Pages.** `composeDescriptionPage` puts every block of a page through
  `descriptionBlock()` and one `symbolise` (page µm, y-up; white and the
  ink as the page's colours, as `pageLayer` adds the block's);
  `writeDescriptionPage` writes the white sheet and the stream under
  µm → pt — `writePage`'s page-layer lines without a frame or map layer
  (§4.3–4.4). All pages go through one `PdfWriter`, so a pictogram is one
  form XObject and each face one font for the document (§1, 05 §5.10).
  `/PageLabels` and the outline carry the class (or course) name (§7.2).
  **In process**, not in the print worker: there is no document to
  decode, and §8.2's other concern — composing and writing on the event
  loop — is met by writing **one page per turn of the loop**
  (`setImmediate` between pages, as `renderCoursePages` does) under a
  **render-gate permit** (`renderGate()`, so prints never exceed
  `MAP_RENDER_CONCURRENCY` together). Measured 2026-11-07 (14-row block,
  6 mm, `cmyk`): ~18 ms a page; 200 pages (the cap) in 3.5 s with the
  event loop's longest wait 32 ms, the save included.
- **Response** as `maps.pdf` (§8.3): `application/pdf`,
  `attachment; filename="<event>_descriptions.pdf"`, `no-store`, `cmyk`,
  real dates (the builder takes `deterministic` for tests, §3.2);
  `Info /Title` `<event> descriptions`, `/Author` the organiser. 400 for
  a bad parameter, an unknown class or course, a block too tall, or more
  than 200 pages (the `maps.pdf` cap, counted before drawing); 404 "Event
  not found" / "Unknown event"; 404 `{ error: "No descriptions" }` when
  nothing selected has a course.
- **UI**: Export ▾ *Description sheets…* in the editor and the Courses
  page's export menu open one dialog (`course-layout.md` §7). `gap` is the
  route's only (the dialog uses the default).

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

A record since E4a deleted the legacy page (§8.4). Beyond the base
map's (§8.4 `library-symbols`, `stack-order`) and the two differences
of decision (3): spec-sized 7xx
symbols, the 701 turned to the first control, 709 from the library and
start / finish clearance (C0); Liberation Sans in the block (the legacy font stack lists
DejaVu Sans first); image and text course objects and control numbers
turn with a rotated window (legacy drew the overprint upright in page
space); imported `marked_route` / `restricted_line` / `forbidden_route`
lines drawn by the library; images DeviceRGB in `cmyk`.

### 7.5 Tests

| Test | Covers |
|---|---|
| `print/__tests__/page.test.ts` | `T_map` against `mapToPage` (0°, ±rotation), inverse, frame in map space, `flipPageObject`, `transformPassStream` (slices kept, widths / taper / glyph instances / text scaled and turned, hatch lines on the transformed lines) |
| `print/__tests__/description.test.ts` | every `IOF_SYMBOLS` key converts; 2.4 one fill, 1.10 one disc, 0.3 two strokes + disc, Bézier flags; block size and position, border, thick / thin rules, header sizes and weight, F text 0.34 × cell, pictograms centred at 0.8 × cell, one symbol per key |
| `print/__tests__/compose.test.ts` | one colour-sorted map stream with lower purple < black < upper purple; block text / rules / pictograms on appended colours; no block → empty page layer; map ring outer boundary = frame (+1 mm) through `T_map⁻¹` in the toner saver white, page ring = frame + 1 mm, page white-out at upper white; P1: with a 709 area and a course text outside a map toner saver, its ring is the map layer's last pass (the page layer still draws after); placeholders; rotated `T_map`; images in layer space; `CourseStackError`; auto cuts off = the stream without cut features (D17) |
| `print/__tests__/writer.test.ts` (C8) | a bold text symbol and a regular one embed two font objects, `…+LiberationSans` and `…+LiberationSans-Bold` |
| `print/__tests__/write-page.test.ts` | operator order (sheet, frame clip, `T_map` `cm`, page `cm`), no `rg` in `cmyk` / no `k` in `rgb`, rotated `cm`, two pages sharing font, glyph forms and image XObject, page labels and outlines, `/Measure /GEO` (SWEREF99 TM corners near 58.6° N 15° E, rotated corners), deterministic bytes, missing image warning, an object far outside the frame absent from the content stream (C13) |
| `print/__tests__/isomorphic.test.ts` | no Node API, `Buffer`, sharp or resvg in the module |
| `packages/api/src/__tests__/course-print-sheet.test.ts` | `resolveSheet`: paper / frame / window / tilt, structure and roles, unique sites, label offsets, extras, authored gaps from the structure only (start and finish rows, no GeoJSON, E6), description block / hidden, all-controls, free order, the event's auto cuts off on the view options (D17) |
| `packages/api/src/__tests__/course-map-layout.test.ts` "course sites", "layoutCourseEnds" (E6) | start, `course_controls` and finish from the rows with straight legs, no `cuts`; an unplaced end not drawn; the ends of a NULL structure from the columns (lowest-seq defaults, `firstAsStart`) and of a stored one from its items |
| `packages/api/src/__tests__/integration/course-maps.test.ts` "creates, duplicates and applies…", "resolveSheet: a template previewed…" (E6; E-pages read both through `resolveSheet`, `previewLayout` gone) | a course with no structure and no GeoJSON resolves start → controls → finish (the event's first start / finish) and its description rows; a template alone resolves centred on the map origin |
| `packages/api/src/__tests__/integration/course-print.test.ts` | the E2E fixture map pinned on a `vector` event: legacy event → no print document; two sheets → one PDF of two A4 pages, `TrimBox`, labels, outlines, Type0 / CIDFontType2 shared, frame clip and `T_map`, no `rg`, PNG and rasterised SVG logos shared (600 dpi), `/Measure /GEO` of the fixture's georeference, deterministic bytes |
| `packages/api/src/render/__tests__/page-raster.test.ts` | the page oracle: white outside the frame and the ring, map inside, page box on top; rotated building where `T_map` puts it; block position on A4 |
| `packages/api/src/render/__tests__/golden-files.test.ts` | `page-sprint-a4`, `page-ring`, `page-rotated` match the page oracle; `descriptions-a4` matches the description-sheet oracle (F11) |
| `print/__tests__/description-sheet.test.ts` (F11) | §6.4: a 14-row block 4 × 3 / 3 × 2 / 3 × 2 per page at 5 / 6 / 7 mm; placement inside the margin; `count` (runners + vacancies, at least 1), a number, `fill`; 13 copies at 5 mm → two pages of one class; classes in order, never sharing a page; the gap only between blocks (0 / 20 / 30 mm); `DESCRIPTION_TOO_TALL`; the writer: one A4 page per tiled page labelled by class, one outline item each, the white sheet first, no `rg` in `cmyk` / no `k` in `rgb`, the XObject set the same for one page and three, deterministic bytes |

The page goldens (`e2e/__golden__/map-gl/page-*.png`, 05 §7 tier 3) are
the page oracle (`render/page-raster.ts`): the map layer moved through
`T_map` into page µm (`transformPassStream`) and rasterised over the
frame alone — the frame clip is the raster's extent — composited with the
page layer on white paper, at 10 px/mm, supersampled 2× (an A4 sheet at
the scene goldens' 4× would be a ~400 MB intermediate). The
description-sheet golden (`descriptions-a4.png`, F11:
`descriptionSheetScene()`, one class at 6 mm cells, `fill` → 3 × 4
blocks) is the same oracle with no map layer
(`rasteriseDescriptionPage`). The WebGL2
golden spec does not draw pages (the viewer has no page view until slice
D); the PDF golden tier compares the `rgb` page rasterised by
`pdftocairo` against them (§9.2).

## 8. The `maps.pdf` route

`GET /api/maps/:nameId/maps.pdf` (`docs/course-maps.md` API: query
`maps` / `courses` / `classes` / `allControls` / `setter` / `variants` /
`allVariations`, `copies` / `spare`; `courses.view`; 200 composed pages
and 5 000 pages with copies at most; pages ordered by course,
`sort_order`, `seq`, then variant key) prints every event through the
composer (`packages/api/src/course-maps/routes.ts`) since E3, the flip
(`map-pipeline-switch.md`, history note). It reads the `course_maps`,
`map_templates`, course, control and graphics rows and writes nothing.
The composer is the only path: the rsvg branch (OCAD → SVG →
`rsvg-convert`, `svg-to-pdf.ts`, `map-page-svg.ts`) went in E4a.

### 8.1 Which path prints

| Event | Answer |
|---|---|
| the latest `map_files` row pins a document | the composer, §8.2 |
| no pin | 400 "No base map uploaded" (slice E1) |
| a pin whose colour stack is not aligned (`course.CourseStackError`: no lower / upper purple) | 400 with the error's reason (`{ error: <message> }`) |
| any other composer error | 400 with its message |

`pinnedPrintSource(db, eventId)` (`pdf-page.ts`;
`loadPinnedPrintDocument` is its in-process wrapper) reads
`getBaseMapInfo` (§10) — the same function the layout procedures read. There is
no fallback since E3 (decision log "E3, the flip"): an unaligned stack
was printed through rsvg until then; E0 found no such document on prod,
and a broken print must be seen, not hidden. The fix for such a map is a
re-import (the review's colour decisions).

### 8.2 The vector path

1. The pages `selectPrintPages` selects (the rows; a root's sheet once
   per variant or as its all-variations page; each with its copies —
   §4.6, `course-layout.md` §7 lists the query), each turned into a sheet by
   `sheetForMapRow` (§5) with the event, its controls, its
   `autoOverprintCuts` (`MapRowContext.autoCuts`, §5.2) and the pinned
   document's `getBaseMapInfo` scale and meridian tilt. The pinned
   document is identified, not decoded, on the request thread:
   `pinnedPrintSource` gives its hash, `rotationCorrectionDeg` and a
   `bytes()` reader of the `map_documents` blob.
2. Graphics referenced by any row's or template's image objects (event
   or club scope), loaded once.
3. `renderCoursePagesInWorker({ document: { hash, bytes }, rotationCorrectionDeg,
   sheets, graphics, mode: "cmyk", info, onPage })`: the same
   `renderCoursePages` (one `PdfWriter`, one page per sheet, fonts, glyph
   forms and images shared, §4.5) running in a `worker_threads` worker
   (`course-maps/print-worker.ts`, host `print-worker-host.ts`), so
   decoding the document, composing and writing never occupy the API's
   event loop and a card readout does not wait on a print. Not
   `deterministic`: real dates (§3.2). The worker's output is
   byte-identical to the in-process call's for the same inputs (tested
   with `deterministic: true`); `renderCoursePages` itself stays in
   process for the tests.
   - **Messages.** Everything that crosses is structured-cloneable: the
     sheets, the graphics as `[id, { mime, data }]`, the writer options.
     Host → worker `print`; worker → host `page` after each page (index,
     label, that page's warnings — the route logs them as they arrive),
     then `done` with the PDF bytes **transferred**, or `error`. The
     writer is pdf-lib's whole-document `save()` (xref and object streams
     at the end), so bytes cannot stream per page: the response is one
     buffer (§8.3), and "pages streamed back" is progress and warnings.
   - **Prepared once per worker.** The worker keeps `prepareDocument`'s
     cache (last two hashes). The host remembers which hashes the
     worker instance holds and reads and sends the blob only on a miss;
     a worker that reports it lacks the document (`NeedDocument`) gets it
     on one retry. A replaced worker starts empty.
   - **Pool.** Workers start on first use, are `unref`'d while idle and
     replaced after an exit. `PRINT_WORKERS` (default `1`, at most `4`)
     sets how many prints compose at once; each worker holds a decoded
     document and the fonts (C7 measured 2.6 GB peak RSS for a whole Club-full print run), so it is
     sized with the container's memory and CPU (2 vCPU / 4 GiB: one, or
     two). A worker needs no database connection, so it does not count
     against `DATABASE_POOL_MAX`. A request is timed out after 10 min
     (`PRINT_WORKER_TIMEOUT_MS`, as the import worker): the worker is
     terminated and the request fails; the next one starts a fresh worker.
   - **Errors.** An error in the worker is an `Error` with its message
     on the host (a 400, §8.1). `CourseStackError` crosses with a `code`
     and is re-created on the host (a 400 with its reason, §8.1). A worker that dies fails the request in flight.
   - **Shutdown.** The route's server `onClose` hook terminates the
     workers (`resetPrintWorkers`).
4. A worker slot (`printGate`), **then** a permit of the process's
   render gate (`renderGate()`, `MAP_RENDER_CONCURRENCY`, default 2, 3 on Cloud Run;
   `map-render-limits.ts`), **without a queue cap**: the request waits
   and never answers 503 — the export is a browser download, where a
   503 body would arrive as a broken file. Since E4a nothing else takes
   the gate (the tiles and `window.png` that shared it are gone), so it
   bounds only the prints composing at once; `PRINT_WORKERS` is the
   tighter bound by default. The slot comes first so a print waiting
   for a worker holds no permit.
5. Composer and writer warnings (`NO_FONT` for a page text in a family
   with no face, `IMAGE_MISSING`, `SVG_RASTER`) go to the log at `warn`;
   the PDF is still served.

The route always writes `cmyk` (decision (2), 2026-10-23: print profiles
are a later row). `rgb` exists for the golden tier and proofs; no query
parameter reaches it.

### 8.3 Response

As before slice C: `Content-Type: application/pdf`,
`Content-Disposition: attachment; filename="<event>_<map>.pdf"` for one
composed page (a variant's `<map>` with its key after it, `Long_BA`; the
all-variations page's with its keys, `Long_AB_BA`; copies of one page
still one) and `"<event>_maps.pdf"` for several, `Cache-Control: no-store`;
404 for an unknown event or no maps, 400 for a bad selection, no pin or
a composer error (§8.1). The `X-Print-Pipeline` header of slices C–D is
gone with the switch (E3). `Info /Title` per §7.1 (`<event> · <map>`
for one page — `<event> · Long BA` for a variant — `<event> maps` for
several), `/Author` the organiser.

### 8.4 Sanctioned differences from the legacy PDF

The 03 §6.9 rule as `map-rendering.md` §6.4 applies it: a place where
the vector page differs from the legacy page of the same sheet is either
on this list or a bug. C7's corpus print run classified by these codes;
S2 judges the print shop's view of the first two. Since E4a there is no
legacy page to compare with: the list is the record of what changed for
the user when every event moved to the composer (v0.6.0).

| Code | Difference | Decided |
|---|---|---|
| `cmyk-colour` | DeviceCMYK from the colour stack (§2) against the legacy page's RGB from rsvg: on screen and through a printer's own conversion the colours shift | user, 2026-10-23 (3) |
| `colour-overrides` | the event map's `colorOverrides` are not applied (the column stays, unused) | user, 2026-10-23 (3) |
| `north-lines-below` | `northLinesBelow` is not applied | user, 2026-10-23 (3) |
| `description-font` | Liberation Sans in the block (the legacy font stack lists DejaVu Sans first) | C2, §7.4 |
| `course-symbol-sizes` | 7xx symbols at the library's dimensions × the document factor, the template's appearance as multipliers (`course-layer.md` §2) | user, 2026-10-24 (C0 question) |
| `start-turned` | the 701 start triangle turned to the first control | C0 |
| `library-course-lines` | 709 out-of-bounds boundary and imported `marked_route` / `restricted_line` / `forbidden_route` lines drawn by the library | C0, C2 |
| `start-finish-clearance` | legs cut at the start / finish symbols' own outlines | C0 |
| `size-aware-cuts` | automatic circle and leg cuts from the pinned document with clearance = feature radius + line width / 2 + 0.25 mm | user, 2026-10-24 (C5 question) |
| `rotated-overprint` | on a rotated window, image and text course objects (map-anchored layout objects until F12) and control numbers turn with the map (legacy drew the overprint upright in page space) | C2, §7.4 |
| `image-rgb` | images stay DeviceRGB in `cmyk` (CMYK images are the profiles row) | C2, §7.4 |
| `library-symbols`, `stack-order` | the base map as the GL viewer draws it: matched symbols drawn by the library, every `map-rendering.md` §6.4 code, and the document's own colour order — where a map draws an area colour above lower purple (`COLOUR_AREA_ABOVE_LOWER_PURPLE`) or a 100 % line colour under it, legs follow that order (until `ocad-16`, C14, the inserted lower purple also went under every area on `e2e/test.ocd` and the club maps) | 2026-10-23 slice C split; C6 |

Geometry is not on the list: paper size, frame, window, scale, rotation
and control positions agreed with the legacy page (the integration and
E2E tests check page count and size; C7 compared the rasters).

## 9. Tests and CI

### 9.1 Tests

| Test | Covers |
|---|---|
| `packages/api/src/__tests__/integration/course-maps.test.ts` "maps.pdf through the composer", "course map REST rendering" | a pinned event → one composed PDF, pages at each template's paper (A4, A5), no `X-Print-Pipeline`, `Info` title for one and several pages, file names; selection errors unchanged; `qpdf --check` clean; without a pin 400 "No base map uploaded"; an injected `CourseStackError` is a 400 with its reason; any other injected error is a 400 (the route has no other path, no `converter` option); the second event of the file (pinned too) prints composed pages per course, the all-controls map and a placed graphic; `window.png` is a 404 |
| `packages/api/src/__tests__/integration/course-maps.test.ts` "a readout-path request is answered…" | 150 extra pages in one print while `race.recentActivity` is polled every 10 ms: every probe is answered within 500 ms and more than three were answered before the PDF finished; the PDF has all pages. A smoke test of the route wiring — the event-loop bound itself is `print-worker.test.ts`'s |
| `packages/api/src/__tests__/integration/course-print.test.ts` | §7.5's row, plus `qpdf --check` of both colour modes; the worker's bytes equal the in-process bytes (`deterministic: true`) and `onPage` fires once per sheet |
| `packages/api/src/__tests__/print-worker.test.ts` | the worker on `e2e/test.ocd`: bytes equal in-process; the blob read and sent once per worker; `page` order; an error keeps the worker usable; `CourseStackError` re-created (a document with palette ids stripped); a reset rejects the request in flight and the next call recovers; the main thread's event-loop delay stays under 25 ms (or half a page) during a 10-page A3 print; `PRINT_WORKERS` parsing |
| `packages/api/src/__tests__/worker-bootstrap.test.ts` | the shared bootstrap: `.js` imported as is, `.ts` through tsx |
| `packages/api/src/render/__tests__/pdf-golden.test.ts` | the PDF golden tier, §9.2, and `qpdf --check` on every file it writes; `boxDown`; the swatch read-back |
| `packages/api/src/__tests__/integration/descriptions-pdf.test.ts` (F11) | §6.4 on an event without a base map: `selectDescriptionBlocks` — classes in the order asked, count = runners (a removed and a withdrawn one left out) + vacancies, the header naming the class, the map page's rows (start, controls, the special after its control, finish); `courses=` one block per course, its classes in the header, the count their sum; neither = every class with a course in class order, a courseless class skipped. The route: one A4 page per class labelled by class, headers, file name, `Info /Title`, `qpdf --check`; 13 copies → two pages of one class; `fill` at 5 mm; 400s (both selections, bad ids, copies 0 / 501 / text, cell 8, gap −1 / 31, unknown class / course, 231 pages > 200); 404 "No descriptions" (a courseless class, an event without courses), an unknown event |
| `packages/api/src/__tests__/descriptions-pdf.test.ts` (F11) | `buildDescriptionsPdf` yields between pages: 40 pages with the event loop's longest wait under 250 ms (the whole build without the yield); more than 200 pages refused before a page is drawn |
| `e2e/course-editor.spec.ts` "F11: description sheets" (`chromium`) | Export ▾ → *Description sheets…*: focus inside the dialog and kept there by Tab; every class with a course checked; `k` typed in it arms no tool; *None* disables the download; two classes, two copies, 5 mm → a `…_descriptions.pdf` of two A4 pages; Escape closes the dialog only |
| `e2e/courses.spec.ts` "Export → Description sheets…" (`chromium`) | the Courses page's export menu opens the same dialog; `fill` → `itest_descriptions.pdf`, one page per checked class |
| `packages/api/src/__tests__/integration/variant-pages.test.ts` (F8) | §4.6 on a butterfly (AB / BA) with a class of three runners and a plain course: `?courses=<root>` two pages in key order labelled `Long AB` / `Long BA`, the course id the root's and the runners' course the child's, `{variant}`, `{course}`, the block header and its numbering the variant's, one shared window; `?courses=<variant>` one page (`_Long_BA.pdf`, `Info /Title`) and no new sheet; `?variants=` in key order; `?classes=` per variant with the class in the header; `?allVariations=` one page — three structures, no tint, codes, the block once per control without numbers, `_Long_AB_BA.pdf`; `copies=runners&spare=1` → AB × 3, BA × 2 sharing `/Contents`, `qpdf --check`; a class's and a plain course's stacks; the unfiltered export; `autoSheets` makes no sheet for a variant and returns the root's; `courseMap.resolveSheet { variantKey }` (block, `{variant}`, the shared window, Class view, a key without a variant, a plain course) and `courseMap.list`'s per-variant validation; the 400s (unknown key, a non-root, a bare `variants`, two selections, `copies` ≠ runners, `spare` alone or negative, `copies` without a course selection) |
| `packages/shared/src/print/__tests__/writer.test.ts` "copies a page", `compose.test.ts` "the all-variations page" (F8) | `copyPage`: three pages on one content stream and one resources dictionary, the trim box, the label repeated, one outline item, the bytes about one page's; the all-variations input composes with the plain colour table (no `course-tint:` row) and more course passes than the spine alone |
| `e2e/course-editor.spec.ts` "F7: variations and loops" (F8 part) | Export ▾ *This course (2 variants)* → two pages per own sheet, *All variations* → one per sheet, *One map per runner* disabled without runners; Layout mode shows Variant ▾ = AB and no *All variations*; BA picked → the mode kept, *This variant BA* → one page per sheet (the suite may hand the course another test's map exchange: two part sheets) |
| `e2e/courses.spec.ts` "a course with variations lists its variants…" (F8 part) | a variant row's one action (`export-variant-<seq>`, its title) requests `maps.pdf?variants=<root>:B`; the root row's `export-all-variations-<root>` requests `?allVariations=<root>`; the seed's missing base map shows on the error line |
| `e2e/course-maps.spec.ts` (`chromium`) | the export flows (E-pages: Layout mode's Export ▾ *This sheet*, the Courses page's course PDF and export menu): page count and A4 page size of the single-sheet, course, all-controls and all-maps downloads (05 §7), `application/pdf` and no `X-Print-Pipeline` |

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
  oracle to ≤ 0.036 % on every scene without embedded text.
- **`rgb`** against the committed golden (`e2e/__golden__/map-gl/`) at
  `diffImages(…, 16)` and **≤ 0.5 %** differing pixels. A scene with
  text passes is written twice: with **text as glyph outlines**
  (`text: "outline"`), held to 0.5 % — glyphs are placed by one `Tm`
  each in both modes, so this run proves the text geometry — and with
  **embedded fonts**, held to a provisional **≤ 2.5 %** (user decision
  2026-10-24; tightened once CI's poppler is measured): the rasteriser draws an
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

C11 (2026-10-24) re-measured `rgb` with the layer unit: every ratio
within 0.014 pp of the µm encoding's (largest: `lib-text-layout`
1.964 → 1.978, `course-all-controls` 0.487 → 0.495 against the 2.5 %
text budget), outline runs ≤ 0.002 %; all 57 golden tests and
`qpdf --check` pass. A 10 µm printed unit was rejected on this tier
(`lib-borders` 0.84 %, `lib-hatch` 0.45 %, `hatch-area` 0.22 %:
`map-rendering.md` §5.3 "Units").
| `page-rotated` | 0.027 | — | 0.015 |

Every outline run is 0.000 %: the residual of the embedded-font runs is
the glyph renderer alone, largest on the small text of `lib-text` and
`lib-text-layout`. The page scenes' outline runs are not written (their
text is a few short strings): the page scenes are held to **0.5 %
with embedded fonts**, in both modes — the text tier applies to scenes
only.

The **description sheet** (`descriptions-a4`, F11) is mostly text —
twelve blocks of headers, numbers and codes — so it is held like the
text scenes: embedded fonts to the 2.5 % text budget in both modes, the
`rgb` page written again with text as outlines and held to 0.5 %.
Measured at introduction (2026-11-07, poppler 22.02): `rgb` 0.459 %,
`cmyk` 0.439 %, outlines 0.023 %.

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
librsvg) — under the rule's threshold. They are nevertheless **CI-only**
(user decision 2026-10-24, a deviation from 09 §7 recorded in the
decision log): nothing in the image calls them — the golden tier and
`qpdf --check` run in vitest on the CI runner, C7's corpus run is a local
script, S2 is manual — and poppler is a parser with a steady CVE stream
that would ship unused. They join the image when a feature that runs in
it (an in-app preflight) calls them; the measurement above stays the
reference for that. `rsvg-convert` (`librsvg2-bin`) and
`fonts-liberation` left the image and CI in E4a with the legacy path
(09 §9 step 5): the composer embeds the bundled Liberation files
(`render/fonts.ts`), so printing needs no system tool or font. The
v0.5.0 image brings its own, so a rollback is unaffected.

## 10. `getBaseMapInfo`

`getBaseMapInfo(db, eventId)` (`course-maps/map-source.ts`) answers the
base map facts a print and a layout read and returns
`{ scale, meridianTiltDeg, version, document }`. For every event with a
pin (slice E1, `docs/map-storage.md` §4.6) `scale` is the pinned
document header's `mapScale`, `meridianTiltDeg` the report's
`north.meridian.medianTiltDeg` (0 when there is none) and `version` the
document hash — the values the A11 dual write puts into the `map_files`
columns. `document` is `{ hash }`, always (the `pinnedDocumentHash`
gate went with the switch in E3). Without a pin it throws "No base map
uploaded" (`getBaseMapInfoOrNull` → null), and a pin whose
`map_documents` row is missing throws "Pinned map document is missing"
(both 400 on the route); the OCAD fallback is gone. C2, C3 and the
layout procedures read this one function.

Until E4a this section also specified the layout-editor preview,
`GET /api/maps/:nameId/window.png` — the reference raster of the pinned
document (full and ink layers, rotation, a PNG cache, the render gate's
503) that fed `MapLayoutEditor` its map sandwich. Its last caller was
unreachable since E3 (Layout mode draws the page on the GL canvas,
`course-layout.md`), so E4a deleted the route with its raster
(`renderDocumentWindow`, `inkBoundary`, `filterPassStream` in
`render/window-raster.ts`) and the legacy OCAD → SVG branch
(`map-source.ts` `loadBaseMapSvg`); `MapLayoutEditor` itself went in
E4c. The request is a 404 now.

### Tests

| Test | Covers |
|---|---|
| `packages/api/src/__tests__/integration/course-maps.test.ts` "getBaseMapInfo under a pinned document" | every pinned event carries its document hash and the scale / tilt agree across two events of the file; without a pin "No base map uploaded" and `getBaseMapInfoOrNull` → null |
| `packages/api/src/render/__tests__/window-raster.test.ts` | `objectsNear` (the print's window crop) |

## 11. Corpus numbers

The slice's regression net (09 §8; SLICES C7): every corpus map printed
as one course page through the route's own function, checked, rasterised
and compared with the two references the slice had — the page oracle
(backend parity) and the legacy rsvg page (what changes for the user).
This section is the record of that run. The tool
(`render/print-run.ts`, `scripts/measure-print.mjs`) and its legacy
reference went in E4a with the rsvg page (decision log 2026-11-06); it
is in git history up to v0.5.0. Its sheet and synthetic course live on
as the print worker tests' fixture (`__tests__/helpers/print-sheet.ts`).
The corpus and everything the run wrote stay in `.local/` (AGENTS.md
§12): the PDFs carry the map's `/Measure /GEO`.

### 11.1 The page

`packages/api/src/render/print-run.ts` (`runPrint`, deleted in E4a), no database:

- **Import** with the API's importer (`importMapToDocument`), the
  document prepared as the route prepares a pinned one
  (`prepareDocument`); the meridian tilt from the import analysis, as
  `getBaseMapInfo` reads it (§10).
- **Sheet** (`printSheetFor`): the OCAD print window (`header.printWindow`,
  PrintPar 1026) at its print scale is the frame, on a custom sheet of
  frame + 3 mm margins, **rounded up to whole mm** — a fractional page
  puts the PDF raster and the oracle up to half a pixel apart at every
  edge (sprint's 105.663 × 48.338 mm page measured 11.7 % before the
  rounding). The window grows by less than 1 mm of paper. Without a print
  window (`e2e/test.ocd`): A4 at the map scale, its orientation from the
  object bounds, centred on them. `--paper`, `--print-scale`, `--centre`
  override, through production's `mapWindowForFrame`.
- **Course** (`syntheticCourse`): start, controls 31–34 and finish at
  fixed fractions (≤ 0.3) of the window, deterministic, with IOF
  descriptions; the description block top right when the frame is at
  least 100 × 80 mm. The legacy page gets the matching GeoJSON (start and
  finish points; both pages draw straight legs, the vector page cuts them
  around document features). A course on every page puts the course
  layer, size-aware cuts and the description block on real maps.
- **Print**: `resolveSheet` → `renderCoursePages` (`deterministic`) in
  `rgb` and `cmyk` — the route's bytes. Each mode is written a second time
  with text as glyph outlines (`renderCoursePages({ text: "outline" })`)
  for the comparison only.

### 11.2 Checks and measures

Per mode: `qpdf --check` (§9.3), the PDF page size against the sheet,
bytes, SHA-256, `renderCoursePages` wall time; once: `composePage` time,
document objects in the window (`objectsNear`).

- **(a) Backend parity**: the PDF rasterised by `pdftocairo` at 10 px/mm,
  2× supersampled (§9.2) against the page oracle (`rasterisePage`, same
  density and supersample) — `rgb` in the naive colours, `cmyk` in the
  rasteriser's own CMYK → RGB (`rasteriserCmykColours`), as the golden
  tier does. Three measures: pixels beyond 16 levels (the golden tier's),
  beyond 32 levels, and B9's **unexplained** pixels (`map-rendering.md`
  §6.4: inked on one side, no ink within one pixel on the other, and
  beyond the channel tolerance there) ÷ ink.
- **(b) Legacy page**: the `rgb` page against the legacy page of the same
  `resolveMapLayout` output — `renderBaseMapLayers` (the event-map
  defaults: colour profile `auto`, no overrides, north lines below) →
  `composeMapPageSvg` → `rsvg-convert` → the same rasteriser and grid.
  The legacy page's text is pinned to the bundled Liberation files through
  a generated `FONTCONFIG_FILE` (B9's pinning, for librsvg). Shape:
  unexplained ÷ ink against the PDF raster; colour: pixels beyond 16
  levels against the page oracle drawn in the **legacy RGB** of each
  source colour, over the same ink (legacy ∪ PDF) (B9's recolouring — the PDF matches the oracle within
  (a)), so OCAD's RGB against the stack's CMYK does not swamp it. Page
  sizes must agree (geometry is not a sanctioned difference, §8.4).
- **Per-symbol attribution**: `runParity` (`map-rendering.md` §6.4) on the
  window's bounding box, canonical; the diverging symbols with their codes.
  A composed page cannot be diffed per symbol; this is the base map's part
  of (b).
- **Sanctioned codes** per page (§8.4): `course-symbol-sizes`,
  `start-turned`, `start-finish-clearance`, `size-aware-cuts`,
  `library-symbols`, `stack-order`, `north-lines-below` (on by default for
  an event map) always; `cmyk-colour` on the `cmyk` page;
  `description-font` with the block;
  `rotated-overprint` on a rotated window. `colour-overrides`,
  `library-course-lines` and `image-rgb` cannot occur (no overrides, no
  imported lines, no images).
- **Previous run**: `.local/print/<map>/summary.json` of the last run is
  compared — equal SHA-256 per mode (equal input gives equal bytes, §3.2),
  bytes, time and ratio deltas — and kept as `summary.previous.json`.

### 11.3 The gate

A map passed when the page composed, `qpdf` found no errors, both pages
had the sheet's size, every diverging symbol carries a sanctioned code,
and in both modes **backend parity** holds: unexplained ≤ **0.01 % of
ink** (the same shapes) and ≤ **0.5 %** of the pixels beyond **32
levels** (user decision 2026-10-24). The 16-level ratio and the
text-as-outlines run are reported, not gated. Why two tolerances: the
golden tier's 0.5 % at 16 levels (§9.2) was calibrated on golden and page
scenes with few edges (≤ 0.073 %); on a dense real map Cairo's and
resvg's edge anti-aliasing alone put 17–32 levels between them on
0.5–1.5 % of the pixels — Crop-A 1.43 %, Club-full 0.83 %, Club-full A4
0.66 % when decided (1.42 / 0.83 / 0.65 % on library 2026.10.4) — with **no** shape difference (0–11 unexplained pixels per page)
and at most 0.134 % beyond 32 levels. It is not text: Crop-A written with
glyph outlines is 1.28 %. The golden tier keeps C3's rule. Size and time
are reported against 05 Appendix B, not gated; the legacy measures are
reported for reading with the images.

### 11.4 Invocation

`node scripts/measure-print.mjs <map.ocd>` wrote the pages, rasters,
diffs and `summary.{md,json}` into `.local/print/<map>/`, one map per
invocation. Deleted in E4a with the legacy page it compared against.

### 11.5 Results

Measured 2026-10-24 (dev machine, poppler 22.02 `pdftocairo`, `qpdf`
11.3 and librsvg 2.54 from the images, one map at a time). The **OCAD
window** rows are the C-gate's pages — what the mapper's own print
settings print; the **Appendix B** rows are the pages 05 priced, by
override (`sprint --paper=A3`, `club-full --paper=A4
--print-scale=10000`; user decision 2026-10-24). Times are wall time for
the one page (`composePage`, then `renderCoursePages` per mode, which
composes again and writes); bytes are the deterministic PDFs; every page
of the second complete run was byte-identical to the first in both modes.
The table is the run on library 2026.10.4 (#76: ISOM 704 control numbers
in upper purple, round cliff baselines). Against the run before it, every
page's bytes changed by a few tens of bytes; shapes (unexplained pixels),
the diverging symbols and the gate did not move; Crop-B's numbers, at 2×
overprint scale, moved most (beyond 32 levels 0.031 → 0.072 %, beyond 16
levels 0.494 → 0.537 %); the legacy colour ratio fell by 0.2–0.4 pp on
four pages. Times vary with the machine's load between runs (Club-full's
write 1.3–3.5 s per mode over three runs). The two Club-full rows are
re-runs on importer `ocad-15` (C10, 2026-10-24: north-oriented point
symbols whose objects carry an angle drawn turned, `map-import.md` §3.3):
against C7's run the four rotation symbols left the diverging list and
both pages pass; bytes grew by 2.2 kB (window) and 0.5 kB (A4) — the
turned glyph instances' `cm` operands —, shapes against the oracle and
the backend-parity ratios did not move, the legacy colour ratio fell by
0.03 pp.

**C13 (2026-11-03, frame culling, `map-rendering.md` §5.3).** The bytes
column has a third figure: the same pages after the composer hands the
frame to the operators. Against C11 nothing but the bytes moved: the
unexplained pixels are the same on every page (0 / 0 / 0 / 3 / 10–11 / 0
/ 5), the 16- and 32-level ratios equal to the third decimal, every page
passes; run without the legacy page and the per-symbol parity (`qpdf` and
`rsvg-convert` were not on the machine; both are unchanged by culling —
the legacy page is a different code path), times not re-measured. The
gain follows how much of the window lies outside the frame: nothing on
Crop-A (the print window is the map), −32 % on Club-full A4 at
1:10 000 (the ≈ −33 % estimated), −34 % to −74 % on the cropped windows.

**The C11 table is the run after C11** (2026-10-24: the layer unit, anchors,
turn-class forms, `map-rendering.md` §5.3), all seven pages in both
modes. "Before C11" is the same page at the encoding before it, on the
same code otherwise (C8's bold face and C10's turned symbols included, so
a few kB above C7's numbers). Against that run nothing but the bytes
moved: the unexplained pixels are identical on every page, the 16- and
32-level ratios within 0.01 pp, the diverging symbols the same, every
`qpdf --check` clean; Club-2026's legacy colour ratio reads 41.51 %
(40.60 % in C7's run).

| Page set | Map | Page (mm) | Map → print scale | Rotation | Objects | Bytes `rgb` / `cmyk` (kB): before C11 → C11 → C13 | compose / write `rgb` / `cmyk` (ms) | > 16 levels `rgb` / `cmyk` (%) | > 32 levels (%) | Unexplained (px) | qpdf | Legacy: unexplained / differing (% of ink) | Symbols compared / diverging | Gate |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| OCAD window | Sprint | 106 × 49 | 1:4000 → 1:4000 | 0° | 2 389 | 218 → 178 → 77 / 77 (−57 % vs C11) | 37 / 129 / 81 | 0.276 / 0.152 | 0.038 / 0.022 | 0 / 0 | ok | 1.54 / 29.32 | 58 / 4 | pass |
| OCAD window | Crop-A | 143 × 117 | 1:15000 → 1:15000 | 0° | 4 927 | 464 → 372 → 372 / 372 (0) | 98 / 252 / 176 | 1.423 / 1.250 | 0.134 / 0.100 | 0 / 0 | ok | 0.18 / 22.19 | 96 / 6 | pass |
| OCAD window | Crop-B | 43 × 52 | 1:15000 → 1:7500 | 0° | 1 005 | 141 → 124 → 32 / 32 (−74 %) | 34 / 118 / 90 | 0.549 / 0.399 | 0.072 / 0.023 | 0 / 0 | ok | 3.66 / 21.95 | 59 / 3 | pass |
| OCAD window | Club-2026 | 426 × 303 | 1:15000 → 1:5000 | -3.296° | 7 664 | 956 → 810 → 537 / 537 (−34 %) | 115 / 428 / 383 | 0.455 / 0.354 | 0.041 / 0.029 | 3 / 3 | ok | 8.91 / 41.51 | 101 / 6 | pass |
| OCAD window | Club-full | 426 × 303 | 1:15000 → 1:15000 | -3.3° | 31 163 | 3 632 → 2 716 → 2 406 / 2 406 (−11 %) | 284 / 1562 / 1390 | 0.835 / 0.650 | 0.135 / 0.114 | 11 / 10 | ok | 0.33 / 20.12 | 142 / 9 | pass |
| Appendix B | Sprint A3 | 420 × 297 | 1:4000 → 1:4000 | 0° | 10 441 | 889 → 683 → 654 / 654 (−4 %) | 225 / 716 / 445 | 0.155 / 0.095 | 0.015 / 0.008 | 0 / 0 | ok | 1.03 / 21.25 | 86 / 7 | pass |
| Appendix B | Club-full A4 1:10 000 | 297 × 210 | 1:15000 → 1:10000 | -3.3° | 13 768 | 1 634 → 1 353 → 917 / 917 (−32 %) | 166 / 766 / 542 | 0.660 / 0.502 | 0.098 / 0.079 | 5 / 5 | ok | 0.83 / 18.32 | 117 / 8 | pass |

**Backend parity.** Every page draws the same shapes as the oracle —
0–11 unexplained pixels on pages of 0.2–13 megapixels — and at most
0.134 % of the pixels lie beyond 32 levels. Beyond 16 levels the dense
1:15 000 pages exceed the golden tier's 0.5 % (§11.3); written with text
as outlines Crop-A still measures 1.28 %. Crop-A's lake hatch is the
largest single cluster: the same ink per period, the PDF's lines 0.07 px
(7 µm) from the oracle's, below every budget; its source was not found
(no global offset, no rotation, `hatchLines` identical on both sides).

**Legacy page.** Differing ink is 18–41 % (colour against the legacy RGB:
the library's and the stack's colours, purple, pattern phase), the shape
difference 0.2–8.9 % of ink, highest on Club-2026, whose dot-pattern
areas (210.1, 407.1) differ in phase (`pattern-origin`). Diverging
symbols on the window, unexplained ÷ ink and their codes:

- Sprint: 407.0 38.1 %, 404.0 27.6 %, 402.0 12.5 % (`pattern-origin`); 512.200 11.1 % (`dash-fitting`, `dash-points`).
- Crop-A: 407.0 36.1 %, 113.0 33.2 %, 520.2 27.9 %, 404.0 13.0 %, 409.0 10.4 % (`pattern-origin`); 507.0 10.1 % (`dash-fitting`, `dash-points`).
- Crop-B: 507.0 20.6 % (`dash-fitting`, `dash-points`); 409.0 20.3 %, 310.0 12.4 % (`pattern-origin`).
- Club-2026: 210.1 60.0 %, 407.1 41.5 %, 404.3 11.0 % (`pattern-origin`); 815.2 52.6 % (`text-fonts`); 507.1 15.9 %, 508.2 13.4 % (`dash-fitting`).
- Club-full: 407.1 42.7 %, 404.3 13.4 % (`pattern-origin`); 414.3 23.2 %, 507.1 12.4 % (`dash-fitting`); 811.5 19.5 %, 825.1 16.1 %, 825.0 10.9 % (`text-fonts`); 107.0 14.1 % (`pointed-caps`); 517.1 11.5 % (`curve-glyphs`, `dash-fitting`, `dash-points`). C7's run also had 504.7 46.6 %, 512.3 45.5 %, 519.0 20.2 % and 504.5 20.2 % without a code — fixed in C10, below.
- Sprint A3: 407.0 37.1 %, 533.0 29.8 %, 404.0 27.7 %, 501.300 19.1 %, 402.0 12.9 % (`pattern-origin`); 507.0 24.7 % (`dash-fitting`, `dash-points`); 416.0 24.6 % (`curve-glyphs`, `glyph-spacing`).
- Club-full A4: 407.1 52.5 %, 409.1 14.5 %, 404.3 13.9 % (`pattern-origin`); 414.3 22.0 %, 508.2 10.9 %, 507.1 10.3 % (`dash-fitting`); 107.0 14.1 % (`pointed-caps`); 517.1 12.7 % (`curve-glyphs`, `dash-fitting`, `dash-points`).

**What the run found** (fixes are rows, not C7):

- **Point-symbol rotation — fixed in C10 (`ocad-15`).** Club-full's 504.5
  / 504.7 (barrier), 512.3 (footbridge) and 519.0 (tunnel) were drawn
  unrotated, canonical rendering on or off, where the legacy turns each
  object to its angle: the symbols are north-oriented (OCAD's rotatable
  flag clear) while every object carries an angle, which OCAD draws
  regardless. The importer now turns such a symbol, as Mapper's OCD
  import does (`map-import.md` §3.3, `docs/bugfix-ocad-point-rotation.md`);
  both Club-full pages pass. It was the C-gate's only failure.
- **Size against 05 Appendix B (rows C11, C13; C13 landed 2026-11-03: Club-full A4 917 kB, Sprint A3 654 kB, below).** Before C11: Sprint A3
  889 kB against ≈ 0.5 MB, Club-full A4 at 1:10 000 1.63 MB against
  ≈ 0.25 MB. The content stream of Club-full A4 was 4.8 MB raw, flated
  ×0.34 (as Appendix B assumed) — 84 % of it path points, 64 k Béziers
  and 71 k lines, ~14 B raw and ~5.7 B flated per point; 14 k glyph
  instances with a six-number `cm` each (0.73 MB raw); text 20 kB, forms
  3.5 kB, fonts 24 kB. **The estimate's counts, not its bytes per point,
  are off**: the window holds 284 k path points where Appendix B assumed
  ~42 k coordinates (Sprint A3: 142 k against 92 k), and 14 k instances
  against ~1.4 k. C11 cut the encoding (−12 to −25 %: Club-full A4
  1.35 MB, Sprint A3 683 kB); the floor of any absolute encoding of 284 k
  points is about 1 MB, so 0.25 MB is out of reach by encoding.
  **44 % of Club-full A4's points lie more than 5 mm outside the printed
  frame** — the window takes whole objects within 20 mm of it, and long
  contours and large areas cross it. Omitting what cannot paint inside
  the frame (row C13) did not change the stream's geometry inside the
  frame but what is written, so it was its own row (decision 2026-10-24):
  −32 % measured, 917 kB. 05 Appendix B's budgets are re-based on these
  counts: 0.9 MB for this page (1.35 MB × 0.67 estimated, 0.92 MB
  measured). The golden PDF tier needs `qpdf` and skipped on the dev
  machine; its page scenes (the only golden coverage of culling under a
  turned frame) run on CI.
- **Time on the event loop (row C12, fixed).** A Club-full A3 page takes
  0.28–0.81 s to compose and 1.3–3.5 s to write per mode over three runs:
  within 05's "hundreds of ms" only for the smaller pages (Sprint
  0.1–0.2 s, Club-2026 0.4–0.6 s). Closed by C12: composing and writing
  moved to the print worker (§8.2); these numbers are the per-page cost
  the worker now carries.
- **Two measurement defects, fixed in C7** (user decision 2026-10-24: they
  would otherwise falsify these numbers): the page oracle composited
  resvg's premultiplied pixels as straight alpha
  (`docs/bugfix-page-oracle-premultiplied.md`; Crop-B 4.77 → 0.49 % at
  16 levels; page goldens unchanged), and B9's unexplained measure counted
  a tone on its ink threshold as a missing shape (Crop-A's 214.0 at 206
  against 207: 68 % → 0; `docs/bugfix-parity-ink-threshold.md`).

### 11.6 Tests

The tool's own tests (`print-run.test.ts`, `measure-print.test.mjs`,
`parity.test.ts`) went with it in E4a. What remains:

| Test | Covers |
|---|---|
| `packages/api/src/render/__tests__/page-raster.test.ts` "composites the layers' premultiplied pixels" | the oracle fix the run forced (`docs/bugfix-page-oracle-premultiplied.md`) |

## Pending in this chapter

- **PDF size** (rows C11, C13, done): Club-full A4 at 1:10 000 is
  917 kB and Sprint A3 654 kB (§11.5); 05 Appendix B's 0.25 / 0.5 MB
  assumed 6.7× / 1.5× fewer path points than the windows hold and the
  rest is points inside the frame. The object margin of the window (20 mm,
  `window-raster.ts`) is C12's area; text and hatch lines outside the
  frame are still written (`map-rendering.md` §5.3 "Frame culling").
- **Corpus gate** (§11.3): every page passed since C10, until the tool
  went in E4a. Crop-A's 7 µm hatch offset between PDF and oracle is
  unexplained (below every budget).
- **Golden tier on CI's poppler**: the budgets were measured with poppler
  22.02 (dev machine); the CI runner's distribution ships a newer one.
  The embedded-font text tier (≤ 2.5 %, §9.2) is provisional: tightened
  to the observed ratio + margin once CI's numbers are in. A drift beyond the budgets is a rasteriser change, re-measured
  and recorded here, not a reason to loosen the 0.5 %.
- **Print profiles** (05 §5.5) — and with them Layout mode's
  print-preview toggle (`course-layout.md` Pending): `cmyk-offset`, `/Separation`, overprint,
  PDF/X-4 and output intents, `colourOverrides`, `minLineWidthMm`, bleed
  and crop marks (the marks layer), CMYK images, the test sheet — a later
  row (decision (2), 2026-10-23).
- **One window shared by several pages** (05 §5.10): two sheets on the
  same window (a course and its all-controls sheet, a root's variant
  pages since F8) re-symbolise and re-emit the map content per page. F8
  did not take the shared form XObject (decided on the user's standing
  instruction 2026-11-07, for review): `composePage` symbolises document
  ⊕ course in one stream in colour-stack order (legs under the line art
  above areas, `stack-order`), so the base map is not one XObject but
  two halves split at lower purple, and a variant's corridors clip the
  map passes per page (`W*`, §4.3) — a composer restructuring, not a
  resource flag. By §11.5 (917 kB per Club-full A4 page, nearly all of
  it the map stream) a four-variant course is about 3.7 MB against about
  1.1 MB shared, acceptable for a download; identical **copies** of a
  page do share one content stream (§4.5), which is where a hand-out
  stack multiplies.
- **Vector SVG logos** (05 §5.7 b): a safe SVG subset as form XObjects;
  rasterised at 600 dpi until a club asks.
- **Several frames per sheet** (map exchange on one sheet, 05 §5.9):
  one frame per page in slice C (a variant's page is one page since F8,
  §4.6); F5 prints a map
  exchange as one sheet per part (§5.2), so several frames on one sheet
  stay Pending (decided on the user's standing instruction 2026-11-07,
  for review).
- **Serif and mono faces**: no file ships (`map-rendering.md` §4.10), so
  no PDF font either.
