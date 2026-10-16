# Map import

Normative chapter for the pipeline that turns an uploaded map file into a
map document (`docs/map-document-format.md`). Research record:
`docs/research/vector-map-pipeline/06-import-pipeline.md` (decided
2026-10-07). Slice A, written incrementally: each section states what is
implemented and marks what is still pending.

## 1. Stages

```
 1 receive      binary upload → Buffer; sha256 → fileHash                 api        done: base64 ≤ 8 MiB, chunked route above (docs/map-storage.md §5)
 2 detect       0x0CAD → OCAD; "<?xml" + Mapper namespace → OMAP          api        done on the chunked route (first chunk sniff, 415 otherwise); base64 path assumes OCAD
 3 parse        reader → source model                                     api/shared done (OCAD, via ocad2geojson fork)
 4 normalise    source model → objects, symbols, colours, georef, warnings shared     done (OCAD, §3; symbol IR §3.3)
 5 analyse      bounds, north, fonts, feature usage                       shared     bounds only (encoder)
 6 match        03 §6.5 staged matcher → SymbolMatch[]                    shared     pending
 7 align        colour stack alignment (03 §6.3)                          shared     pending
 8 encode       02 codec → bytes; sha256 → documentHash                   shared     done
 9 store        map_sources + map_documents rows, event pin, report      api        done, as an import job in a worker thread (docs/map-storage.md §3, §6)
10 derive       thumbnail, metadata columns                               api        pending
```

Stages 3–8 are pure functions over bytes with no Node APIs
(`@oxygen/shared`: `mapImport`, `mapDocument`), so they run in the API
process, in a worker thread and in the browser (`/dev/map-gl-doc`
runs them client-side today). The only Node-side piece is the reader
loader in `packages/api/src/import/ocad.ts`.

## 2. Entry points

### 2.1 Shared

```ts
import { mapImport, mapDocument } from "@oxygen/shared";

const { input, counts, warnings } = mapImport.ocadToDocumentInput(ocadFile, {
  fileName, fileHash, fileBytes,
  importer?: string,                                   // default OCAD_IMPORTER_VERSION
  renderFor?: (symbol) => RenderSymbol | null,         // replaces the §3.3 conversion when given
});
const bytes = mapDocument.encodeMapDocument(input);    // stage 8
const hash = await mapDocument.mapDocumentHash(bytes);
```

`ocadFile` is structurally typed (`OcadFileLike`) against what the
`ocad2geojson` reader returns — header, sparse `colors`, `symbols`,
`objects`, `parameterStrings`, `warnings`, `getCrs()` — so the shared
package does not depend on the reader.

### 2.2 API

```ts
import { importOcadToDocument } from "./import/ocad.js";
const r = await importOcadToDocument(buffer, "map.ocd", { renderFor, onStage });
// r.bytes, r.documentHash, r.fileHash, r.counts, r.warnings,
// r.timings { read, normalise, encode } (ms)
// onStage?: (stage: "parse" | "normalise" | "encode") => void — called as each
// stage begins; the import job (docs/map-storage.md §6) writes it to the row.
```

In the API this runs inside a worker thread
(`packages/api/src/map-store/import-worker.ts`) launched by the import
job, never on the request thread.

### 2.3 CLI

```bash
pnpm --filter @oxygen/api document:from-ocd <in.ocd> [out.oxvm] [--json]
```

Writes the document (default: next to the input with `.oxvm`), prints
counts, warnings and timings; `--json` also writes the JSON projection
(`<out>.vmap.json`). Used for fixtures and the corpus check; never commit
documents derived from real club maps (they carry georeferences).

## 3. OCAD normalisation rules

Reader: the `ocad2geojson` fork (AGENTS.md §14), OCAD 8–2018 files.
Units: 1/100 mm (`unitsPerMm = 100`).

### 3.1 Colours

Colour table → `colours[]` sorted by the reader's `renderOrder`
descending, so index 0 is the bottom of the stack (drawn first). Entry
`id = "src:<number>"`, `cmyk` divided by 100, `sourceNumber`,
`overprint` when set. Spot-colour separations are not imported.

### 3.2 Symbols

- Every table entry becomes a `symbols[]` entry in table order with
  `code` (as written), `name` (description), `kind` from the OCAD symbol
  type (1 point, 2 line, 3 area, 4 text, 6 line text, 7 rectangle),
  `hidden = (status & 2) !== 0`, `sourceFont` for text symbols.
- A number defined twice warns `DUPLICATE_SYMBOL_NUMBER`; objects
  resolve to the first definition.
- **Graphic and image objects** (`sym` −2 / −3, "to graphics" results)
  get a synthesised symbol per `(object type, colour, line width)` with
  `origin: "graphic"`; when the colour resolves, `render` is a one-element
  line (width from the object) or a plain fill in that colour.
- Objects whose symbol number is absent from the table get a stub entry
  with `origin: "missing"`, `render: null`, and `MISSING_SYMBOL` counts
  them.

### 3.3 Symbol render IR

Stage 4 converts every OCAD symbol definition to a `RenderSymbol`
(`docs/map-rendering.md` §3) in `packages/shared/src/import/ocad-symbols.ts`
(`ocadSymbolToRender(def, { colourIndex, symbolByNumber })`). A definition
the IR cannot express keeps `render: null` and the render bridge draws a
proxy; anything dropped or approximated inside a converted symbol is a
warning (table at the end). The `renderFor` option, when given, replaces
the conversion wholesale — the dev page uses it to swap in the S1 pilot
family. Units: OCAD 1/100 mm × 10 = µm, angles 0.1° / 10 = °, colours by
OCAD number → index in the document's colour stack. `id` is
`"src:<symNum>"`.

Field semantics are the fork's reader (`ocad2geojson`) plus the corpus
(five club maps, 1 154 definitions, OCAD 2018 ISOM 2017-2 and ISSprOM
2019 sets). Rows marked *provisional* follow the reader / Mapper
importer reading and are not yet checked pixel-for-pixel against OCAD;
the S2 visual comparison (03 §8) is where they get confirmed.

**Line symbols** (`type 2`) → `{ type: "line", main?, borders?, glyphs? }`

| OCAD | IR | Notes |
|---|---|---|
| `lineColor`, `lineWidth` | `main.colour`, `main.widthUm` | Width 0 ⇒ no main stroke, but `main` is still emitted (width 0) when a framing line or a dash pattern needs it. |
| `lineStyle` | `main.cap`, `main.join` | `& ~2`: 0 bevel / flat, 1 round / round, 4 miter / flat; bit 2 ⇒ `cap: "pointed"`. Same coding for element `flags`. |
| `distFromStart`, `distToEnd` | `shortenStartUm`, `shortenEndUm` | |
| `mainLength`, `mainGap`, `endLength` | `dash { layout: "ocad", dashUm, gapUm, endDashUm? }` | Only when `mainLength > 0` and any of `mainGap`, `secGap`, `endGap` > 0. `endDashUm` only when it differs from `mainLength`. |
| `secGap` | `dash.secondaryGapUm` | Secondary gap splitting each interior dash (`dashesInGroup` default 2). |
| `endGap` | `dash.endGapUm` | *Provisional.* The secondary gap applied to the **end** dashes, not a line-end shortening: 507 footpath has `mainLength 225, endLength 225, mainGap 80, secGap 25, endGap 25`. |
| `minSym` | `dash.minGaps` | Only when `> 0`. |
| `frColor`, `frWidth`, `frStyle` | `main.halo { colour, widthUm: (frWidth − lineWidth)/2, continuous: true }` | The framing line is a solid stroke of total width `frWidth` under the main line; it stays solid under a dashed main line (509 railway). When the main width is 0 the halo takes `frStyle`'s cap/join. `frWidth ≤ lineWidth` ⇒ dropped with a warning (`503.1` in the corpus, unused). |
| `doubleLine.dblMode` 1–3 | `borders` | Mode 1 both edges solid, 2 left edge dashed, 3 both dashed (`dblLength` / `dblGap`); 0 and 65535 off; anything else warns. *Provisional.* |
| `dblLeftColor/Width`, `dblRightColor/Width`, `dblWidth` | `borders.left / right { colour, widthUm, shiftUm: dblWidth/2 + width/2 }` | Edges straddle the `dblWidth` band. |
| `dblFlags & 1`, `dblFillColor` | `borders.backgroundColour`, `backgroundWidthUm: dblWidth` | Band drawn in the fill colour, even without edges. `dblFlags & 2` (background colour) warns. |
| `primSymElements`, `nPrimSym`, `primSymDist` | `glyphs[] { glyph, placement }` | Main symbol only when `nPrimSym > 0` (518.3 "Utan tagg" has elements but `nPrimSym 0`). Solid line ⇒ `spaced { distanceUm: mainLength, firstUm = lastUm = endLength, perSpot: nPrimSym, spotSpacingUm: primSymDist, minCount: minSym + 1 (when minSym ≥ 0) }`; dashed ⇒ `dashCentres`; dashed with `secGap`/`endGap` ⇒ `dashGroupCentres` (the glyph sits in the secondary gap, 517 ruined fence). |
| `secSymElements` | `sectionCentres` | Once per corner-delimited section. *Provisional.* |
| `useSymbolFlags` 1 / 2 / 4 + `startSymElements` / `endSymElements` / `cornerSymElements` | `start` / `end` / `corners` | Corner glyphs include the line ends. |
| `decrease.decMode ≠ 0` | — | Warned, drawn full size. Not in the corpus. |

**Point symbols** (`type 1`) → `{ type: "point", glyph, orientation }`:
`orientation = flags & 1 ? "object" : "north"`, `glyph.rotatable` likewise.

**Symbol elements** (point glyphs, area patterns, line decorations) →
`GlyphPart`: type 1 line ⇒ `stroke` (`lineWidth`, cap/join from `flags`,
coordinates ×10 with the OCAD coordinate flags), 2 area ⇒ `fill`
(closed), 3 circle ⇒ `ring` (`diameter`, `lineWidth`, centre from the
first coordinate), 4 dot ⇒ `disc`. Elements whose colour is unknown are
skipped; a glyph with no parts left is dropped.

**Area symbols** (`type 3`) → `{ type: "area", fill?, hatches?, patterns?, border? }`

| OCAD | IR | Notes |
|---|---|---|
| `fillOn`, `fillColor` | `fill` | |
| `hatchMode` 1 / 2, `hatchColor`, `hatchLineWidth`, `hatchDist`, `hatchAngle1/2` | `hatches[]` | `spacingUm = hatchDist × 10` is the **pitch** (line to line). Mode 2 adds a second hatch at `hatchAngle2`. |
| `structMode` 1 / 2, `structWidth/Height/Angle`, `elements` | `patterns[]` | Mode 2 ⇒ `shiftedRows`. `clip` from `structDraw`: 0 `clip`, 1 `completelyInside`, 2 `centreInside`, 3 `partiallyInside`. `structIrregularVarX/Y > 0` ⇒ regular grid + `IRREGULAR_PATTERN_REGULARISED`. |
| `flags & 1` | `hatches[].rotate`, `patterns[].rotate` | `"manual"` when set, else `"never"`. |
| `borderOn`, `borderSym` | `border` | The referenced line symbol's body, converted with the same rules (its warnings propagate). A reference that is not a line symbol in the table warns (stale references exist in the corpus: ISSprOM 301.2 → 301002). |

**Text symbols** (`type 4`, `type 6` line text) → `{ type: "text", … }`

| OCAD | IR | Notes |
|---|---|---|
| `fontName` | `fontFamily` | Arial / Helvetica / Liberation Sans / Arimo ⇒ `liberation-sans`; Arial Narrow ⇒ `liberation-sans-narrow`; Times (New Roman) / Tinos ⇒ `liberation-serif`; Courier (New) / Cousine ⇒ `liberation-mono`. Anything else is substituted by keyword (narrow / mono / serif / default sans) with `FONT_SUBSTITUTED`. |
| `fontSize` (1/10 pt) | `fontSizeUm = round(fontSize/10 × 352.78)` | |
| `fontColor`, `weight`, `italic` | `colour`, `weight`, `italic` | |
| `alignment & 3` | `align` | 0 left, 1 centre, 2 right, 3 justify. `alignment & 0xfc` (vertical: 4 middle, 8 top) is warned and ignored — the IR anchors at the baseline. |
| `lineSpace` (%) | `lineSpacing = lineSpace / 100` | |
| `paraSpace` (1/100 mm) | `paragraphSpacingUm` | |
| `charSpace` (%) | `charSpacing = charSpace / 100` | |
| `wordSpace` (%) | `wordSpacing = (wordSpace − 100)/100 × 0.278` | Only when ≠ 100; 0.278 em approximates the space glyph. *Provisional.* |
| `frMode` ≠ 0, `lbOn`, `pointSymOn` | — | Warned and dropped: the reader does not expose the framing colour / width, and line-below / attached point symbols are not in the IR. |

Rectangle symbols (`type 7`) and unknown types are `null` with
`SYMBOL_TYPE_UNSUPPORTED`.

**Warnings** (aggregated into the document header like every other
stage-4 warning):

| Code | Meaning |
|---|---|
| `SYMBOL_COLOUR_UNKNOWN` | A colour number the colour table lacks; that part of the symbol is skipped. |
| `SYMBOL_EMPTY` | Nothing drawable was left ⇒ `render: null`. |
| `SYMBOL_TYPE_UNSUPPORTED` | Rectangle or unknown symbol type. |
| `SYMBOL_FEATURE_DROPPED` | Decrease, double-line background colour / unknown mode, framing narrower than the main line, text framing / line-below / attached point symbol / vertical alignment, non-line border reference, zero-size hatch or pattern. |
| `FONT_SUBSTITUTED` | Font name not metric-compatible with the shipped family. |
| `IRREGULAR_PATTERN_REGULARISED` | Irregular area pattern drawn as a regular grid. |

**Corpus** (2026-10-16, script under the local measurements directory;
numbers only, no map content): 1 154 source definitions, 1 153
converted (one text symbol references a colour missing from its table);
objects drawn natively 45 628 / 100 845 / 4 927 / 3 021 / 10 680, proxied
0 / 3 / 0 / 4 / 0 (the proxies are missing-symbol stubs and that text
symbol). Warnings: `FONT_SUBSTITUTED` (Segoe UI), one text framing, two
stale border references, one too-narrow framing line.

### 3.4 Objects

- Coordinates verbatim (`int32`, 1/100 mm, y-up), flags per the OCAD →
  `COORD_FLAG` bit table (`docs/map-document-format.md` §4). Reader
  `xFlags`/`yFlags` are combined into one byte.
- `type` is the OCAD object type 1–7; others warn `UNKNOWN_OBJECT_TYPE`
  and are dropped. Objects with no coordinates are dropped
  (`EMPTY_GEOMETRY_DROPPED`).
- `angle` is the reader's `ang` (0.1°); the encoder rejects values outside
  `int16` (OCAD writes −3600..3600).
- Text objects keep their text in `strings` (deduplicated). Unformatted
  text keeps all five coordinates (anchor + box).
- `sourceIndex` is the position in the reader's object list.

### 3.5 Scale, georeferencing, print

- `mapScale` from ScalePar (1039) `m`, default 15 000.
- `georeferencing`: `crs` from `getCrs()` when the grid id resolves,
  `paperOrigin` from `x`/`y`, `gridRotationDeg` from `a`,
  `gridScaleFactor = 1 + b/100`, `declinationDeg` / `realWorldEnabled` /
  `sourceGridId` passed through.
- `printWindow` from PrintPar (1026); `exportRectangles` from string 26.

### 3.6 Dropped with a warning

Templates (string 8, `TEMPLATES_DROPPED`), layout objects (string 24,
`LAYOUT_OBJECTS_DROPPED`), reader warnings (`READER_WARNING`, texts in the
import result). Everything else in the file (view, zoom, bookmarks,
symbol icons, course-setting data) is dropped silently per 02 §1.

## 4. Header provenance

`format.importer` is `"ocad-3"` today (`OCAD_IMPORTER_VERSION`; `ocad-1`
had `render: null` for every source symbol, `ocad-2` carried the upload
name in the header). Bump it
whenever stages 3–8 would produce different bytes for the same file —
reader fix, normaliser rule, codec change, matcher thresholds, library
edition. `source` carries the reader's file version, `fileHash` and size
— not the upload name, so the same bytes give the same document whatever
the file was called (06 §4.2). The name is kept on `map_sources.file_name`
and in the import report (`mapImport.importReportSchema`,
`packages/shared/src/import/report.ts`; shape in `docs/map-storage.md` §3).

## 5. Determinism

Required and tested: same bytes in → same document bytes and hash out,
across processes and machines. Unit test `import-ocad.test.ts` encodes
`e2e/test.ocd` twice; the corpus script asserts `sameAsPrevious` across
runs. Sources of non-determinism to avoid when extending the normaliser:
iteration over `Map`/`Set` built from sparse arrays (use the array
index), floating-point sums (keep source integers), `Date`/random ids.

## 6. Tests

| Level | File | Covers |
|---|---|---|
| Unit (shared) | `packages/shared/src/import/__tests__/ocad-source.test.ts` | colour stack order, symbol table, hidden flag, duplicates, graphic objects, missing symbols, flag mapping, georeferencing, print window, warning codes |
| Unit (shared) | `packages/shared/src/import/__tests__/ocad-symbols.test.ts` | every row of the §3.3 tables: line styles, dashes (507 end gap), framing, double lines, main / secondary / corner / start / end symbols, point elements, area fill / hatch / pattern / border, text mapping, fonts, warning codes |
| Unit (shared) | `packages/shared/src/render/__tests__/{dash,placement,symbolise}.test.ts` | OCAD end-gap semantics, `dashGroupCentres` / `sectionCentres`, `backgroundWidthUm`, continuous halo |
| Unit (shared) | `packages/shared/src/map-document/__tests__/codec.test.ts`, `projection-bridge.test.ts` | encode/decode round trip, Hilbert order, validation errors, truncation, JSON projection, render bridge |
| Unit (api) | `packages/api/src/__tests__/import-ocad.test.ts` | reader → document on `e2e/test.ocd`, determinism, bboxes, all fixture symbols converted, symbolise without proxies |
| E2E | `e2e/map-gl-doc.spec.ts` | document path = reader path in the browser, native `.oxvm` round trip, `mode=source` draws the fixture from its own definitions with no proxies |
| Unit + integration + E2E (api, web) | see `docs/map-storage.md` §9 | stages 1 and 9: chunked upload route, import jobs, store, dedup, pins, report row, delivery route |

The S0 corpus check (09 §7: whole corpus, every OMAP construct) is
pending the OMAP reader; the OCAD half runs today via the measurement
script and is recorded in `docs/map-document-format.md` §9.

## 7. Pending in this chapter

Matcher and colour alignment (stages 6–7), S2 confirmation of the
*provisional* §3.3 rows against OCAD output,
OMAP reader and the shared `normalise()` fixtures (06 §3.3), review API
and previews (06 §5), the `decisions` input to a job (06 §5.3 — the column
exists, nothing reads it yet). Each lands with its own section here and
its own tests.
