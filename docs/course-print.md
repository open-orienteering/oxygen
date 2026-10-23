# Course print

How a course map is printed from the vector pipeline: the PDF
operators, the colour stack on paper and the layout-editor preview.
Normative for slice C of the vector map pipeline (research:
`docs/research/vector-map-pipeline/` 05, 09 §4 C).

> Chapter skeleton: §1–3 (writer, colour modes, fonts and determinism)
> are C1's; §4–9 (page model, `resolveSheet`, layers, boxes and
> metadata, geospatial, graphics, route, tests) are reserved for C2 / C3;
> §10 (layout-editor preview) is C6's. How a *pass* becomes PDF content
> is `docs/map-rendering.md` §5.3; this chapter owns everything around it.

Status: **draft** — §1–3 written by C1 (2026-10-23).

## 1. The print module and its writer

`packages/shared/src/print/` — the PDF backend of the shared stage.
**Isomorphic**: no Node API (`node:*`, `Buffer`); fonts arrive as bytes,
randomness (non-deterministic `/ID`) comes from Web Crypto, so the same
code runs in the API and, later, in a Web Worker (05 §5.11). It is *not*
re-exported from the package root (`import { render } from
"@oxygen/shared"` stays free of the PDF library, which keeps it out of the
web bundle and out of the Dockerfile's `main` patch); the first consumer,
the page composer (C2), wires the `@oxygen/shared/print` subpath.

| File | Contents |
|---|---|
| `print/operators.ts` | pass stream → content-stream operators (`map-rendering.md` §5.3); `mapLayerOperators`, `layerMatrix`, `clipOperators`, glyph form content and bounding box, number formatting (`fmtMm` for the page layer: mm, 3 decimals) |
| `print/colour.ts` | colour modes (§2) |
| `print/fonts.ts` | font programs: subsetter, widths, descriptor values, subset tag, ToUnicode (§3) |
| `print/writer.ts` | `PdfWriter` — the only file that imports the PDF library |
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

### Tests

| Test | Covers |
|---|---|
| `print/__tests__/operators.test.ts` | tier 1 (05 §7), see `map-rendering.md` §5.3 |
| `print/__tests__/colour.test.ts` | stack CMYK in `cmyk`, naive sRGB in `rgb`; inverse naive round-trips through `cmykToHex`; black / white single-plate; grey on K; operator formatting |
| `print/__tests__/fonts.test.ts` | subset keeps ids: kept glyph records and advances byte-equal, composite components kept, others empty, cut after the highest id, < ¼ of the file; checksums (`0xB1B0AFBA`), byte-identical across runs, dropped tables; `W` grouping; ToUnicode pairs; hex runs; subset tag; descriptor metrics |
| `print/__tests__/writer.test.ts` | tier 2 (05 §7): PDF 1.7, page count, `MediaBox` / `TrimBox`, `Info` with fixed dates; per face Type0 → Identity-H → CIDFontType2 → `CIDToGIDMap /Identity` → `FontDescriptor` → `FontFile2` with `Length1` = program length, subset tag pattern, ToUnicode covers every drawn id; form XObjects (`Subtype /Form`, `BBox`) and clip blocks; byte-identical files with `deterministic` (cmyk and rgb); real dates and differing bytes without; a face the subsetter cannot read → `PDF_FONT_OUTLINES` warning and no font; outline mode embeds no font and draws no `BT` |

Not in vitest until C3: `qpdf --check` and the rasterised comparison
(`pdftoppm`) against the reference raster.

## Pending in this chapter

- **§4–9** — page model, `resolveSheet`, map / page / marks layers,
  `Info` per course, page labels and outlines, `/Measure /GEO`, images
  and SVG logos (C2); the `maps.pdf` route switch, golden PDFs, `qpdf` in
  CI (C3). The `@oxygen/shared/print` subpath export (and the
  Dockerfile's `main` patch for it) lands with the first consumer (C2).
- **Print profiles** (05 §5.5): `cmyk-offset`, `/Separation`, overprint,
  PDF/X-4 and output intents, `colourOverrides`, `minLineWidthMm`, bleed
  and crop marks, the test sheet — a later row (decision (2),
  2026-10-23).
- **Filter regions by symbol** (05 §5.3, 04 §7): the stream has no region
  concept yet; `clipOperators` is the primitive the composer will use.
- **Serif and mono faces**: no file ships (`map-rendering.md` §4.10), so
  no PDF font either.
- **Rasterised PDF comparison**: a manual `pdftoppm -r 254` of the
  golden scenes in `rgb` against the committed goldens (C1, not
  committed) matched the contract fixtures within 0.11 % and showed the
  library scenes' remaining 1–6 % to be poppler's thin-line stroke
  adjustment and anti-aliasing at dash and glyph edges, not geometry —
  C3 picks the rasteriser options and tolerance.
