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
 3 parse        reader → source model                                     api/shared done (OCAD via the ocad2geojson fork; OMAP via the shared XML reader, §4)
 4 normalise    source model → objects, symbols, colours, georef, warnings shared     done (OCAD §3; OMAP §4; symbol IR §3.3 / §4.3)
 5 analyse      bounds, north, fonts, feature usage                       shared     bounds, georeference, north (§3.8); fonts and feature usage pending
 6 match        03 §6.5 staged matcher → SymbolMatch[]                    shared     done (docs/map-symbols.md §8)
 7 align        colour stack alignment (03 §6.3)                          shared     done (docs/map-symbols.md §9)
 8 encode       02 codec → bytes; sha256 → documentHash                   shared     done
 9 store        map_sources + map_documents rows, event pin, report      api        done, as an import job in a worker thread (docs/map-storage.md §3, §6)
10 derive       thumbnail (map_previews)                                  api        done, inside the job after the pins (docs/map-storage.md §4.5, §6.1)
```

Stages 3–8 are pure functions over bytes with no Node APIs
(`@oxygen/shared`: `mapImport`, `mapDocument`), so they run in the API
process, in a worker thread and in the browser (`/dev/map-gl-doc`
runs them client-side today). The only Node-side piece is the reader
loader in `packages/api/src/import/ocad.ts`; the OMAP reader itself is
shared code (no XML library — `packages/shared/src/import/xml.ts`), so
a Mapper file needs no Node-side dependency at all.

Stage 10 writes the thumbnail only. 06 §4.1's "metadata columns from
the header" are the stage-9 `map_documents.header` summary
(`docs/map-storage.md` §3): scale, bounds, georeferencing, colours and
counts are already there. The `map_files` quick-access columns (`scale`,
`bounds`, `north_offset`, `calibration`) are written by the pin from the
document's header and its stage-5 report (§3.8, `docs/map-storage.md`
§6.4). A failed derive is logged and the job still ends `done`: previews
are cache.

## 2. Entry points

### 2.1 Shared

```ts
import { mapImport, mapDocument } from "@oxygen/shared";

const { input, counts, warnings, analysis } = mapImport.ocadToDocumentInput(ocadFile, {
  fileName, fileHash, fileBytes,
  importer?: string,                                   // default OCAD_IMPORTER_VERSION
  renderFor?: (symbol) => RenderSymbol | null,         // replaces the §3.3 conversion when given
});
// analysis: stage 5 over `input` (§3.8) — bounds, georeference, north; not part of the document
const matched = mapImport.matchDocument(input, {       // stages 6–7
  library?, edition?, factor?, decisions?,             // overrides; see docs/map-symbols.md §8
});
// matched.input (header.symbols[i].match, header.colours aligned, header.library,
// header.documentFactor), matched.matching, matched.colourStack, matched.warnings
const bytes = mapDocument.encodeMapDocument(matched.input); // stage 8
const hash = await mapDocument.mapDocumentHash(bytes);
```

`matchDocument` throws if a symbol's IR references a colour index outside
the colour table (the normaliser never produces one; a `renderFor` hook
must state its renders against the source table).

`ocadFile` is structurally typed (`OcadFileLike`) against what the
`ocad2geojson` reader returns — header, sparse `colors`, `symbols`,
`objects`, `parameterStrings`, `warnings`, `getCrs()` — so the shared
package does not depend on the reader.

The Mapper path has the same shape with its own reader in front:

```ts
const file = mapImport.readOmap(text);                 // stage 3: OmapFile (§4.1)
const { input, counts, warnings, analysis } = mapImport.omapToDocumentInput(file, {
  fileName, fileHash, fileBytes, importer?,            // default OMAP_IMPORTER_VERSION
});
// then matchDocument / encodeMapDocument exactly as above
```

`mapImport.looksLikeOmap(head)` is the shared sniff (`<map` with the
Mapper namespace in the first kilobyte); the API's `sniffMapKind` wraps
it with the OCAD magic check and a BOM skip.

### 2.2 API

```ts
import { importMapToDocument, importOcadToDocument, importOmapToDocument } from "./import/ocad.js";
const r = await importMapToDocument(buffer, "map.omap", kind /* "ocad" | "omap" */, { renderFor, onStage, match });
// importOcadToDocument / importOmapToDocument are the fixed-kind wrappers.
// r.kind, r.bytes, r.documentHash, r.fileHash, r.counts, r.warnings,
// r.matching, r.colourStack, r.analysis (stage 5, §3.8), r.libraryVersion ("ISOM2017-2@2026.10.1"),
// r.timings { read, normalise, match, encode } (ms)
// onStage?: (stage: "parse" | "normalise" | "match" | "encode") => void — called as
// each stage begins; the import job (docs/map-storage.md §6) writes it to the row.
// match?: MatchDocumentOptions — forwarded to matchDocument.
```

In the API this runs inside a worker thread
(`packages/api/src/map-store/import-worker.ts`) launched by the import
job, never on the request thread. The job passes `map_sources.kind`
through (`runImportInWorker(bytes, fileName, { kind })`), so an uploaded
`.omap` / `.xmap` follows exactly the same route as an `.ocd` from
chunked upload to pinned document. `renderFor` applies to OCAD only.

The legacy modules `packages/api/src/map-projection.ts` and
`map-north.ts` are adapters over the same shared code: `ocadToWgs84`,
`wgs84ToOcad`, `ocadBoundsToWgs84`, `computeMapNorthOffset`,
`computeTrueNorthFromGrid` and `probeMeridianLines` build a `mapGeo`
frame from the reader's `getCrs()` (grid scale factor 1, as the reader
has it) and call `mapGeo`; what stays API-side is the coordinate-range
EPSG inference for files without a usable grid id (`getEpsgString`,
raster path only — a heuristic with no place in a deterministic
normaliser) and the WMM declination (`computeDeclination`, date
dependent). The raster upload computes the `map_files` columns through
the same function as the pin (`map-store/map-file-metadata.ts`
`mapFileMetadataFor`, over `ocadToDocumentInput` with symbol conversion
skipped), so both writers produce identical values; the inference is
its only fallback.

The *apply* mutations that still feed the legacy raster tile pipeline
(`course.applyEventMap`-style event map upload, club map upload) remain
OCAD-only: they need `ocad2geojson` for the tiles. A Mapper file can be
imported to a document and stored, but cannot yet be made an event's or
a club's map until slice C replaces those consumers (09 §3).

### 2.3 CLI

```bash
pnpm --filter @oxygen/api document:from-ocd <in.ocd|in.omap|in.xmap> [out.oxvm] [--json]
```

The kind is sniffed from the bytes, not the extension. Writes the document (default: next to the input with `.oxvm`), prints
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
- `georeferencing`: `crs` from `getCrs()` when the grid id `i` resolves
  in the reader's table, else from the OCAD 2018 EPSG code `e` when
  present (`{ authority: "EPSG", code, name: "EPSG:<code>" }`).
  `paperOrigin` from `x`/`y` when a CRS resolved, `gridRotationDeg` from
  `a`, `gridScaleFactor = 1 + b/100`, `realWorldEnabled` (`r`) and
  `sourceGridId` (`i`) passed through.
- ScalePar `d` is the real-world grid distance in metres (`g` × scale:
  `d1000` on 1:15 000 maps, `d120` on a 1:4 000 sprint) and is **not**
  carried; OCAD declares no declination. 02 §5 read it as a declination
  (decision log 2026-10-19, A11); `ocad-4` documents carry that wrong
  `declinationDeg`.
- A real-world grid that does not resolve (`r = 1` with `i ≠ 0` or an
  `e` that is no positive integer) gives `crs: null`, `paperOrigin: null`
  and `CRS_UNRESOLVED` naming the grid (`grid 1000`, `EPSG abc`), as on
  the OMAP path (§4.4). A CRS that resolves while ScalePar `x` / `y` are
  missing is dropped the same way (`EPSG:3006 without ScalePar x/y`), so
  `crs` and `paperOrigin` stay null together
  (`docs/map-document-format.md` §2.3). The legacy raster path's coordinate-range inference is
  not applied here (§2.2).
- `printWindow` from PrintPar (1026); `exportRectangles` from string 26.

### 3.6 Dropped with a warning

Templates (string 8, `TEMPLATES_DROPPED`), layout objects (string 24,
`LAYOUT_OBJECTS_DROPPED`), reader warnings (`READER_WARNING`, texts in the
import result). Everything else in the file (view, zoom, bookmarks,
symbol icons, course-setting data) is dropped silently per 02 §1.

### 3.7 Stage 6–7 warnings

Added by `matchDocument` to `header.warnings` and the import report, one
entry per code with a count:

| Code | Meaning |
|---|---|
| `SYMBOL_UNMATCHED` | source symbols with a render but no canonical match (state `unmatched`, method `none`); drawn from their own definition. Template `variant`s and render-less symbols are not counted. |
| `SYMBOL_SCALE_ANOMALY` | an exact-code line fits its entry only at a different enlargement than the document's factor (`matching.scaleAnomalies`) |
| `DECISION_UNKNOWN_ENTRY` | a `SymbolDecision` names a library entry id that does not exist |
| `COLOUR_ORDER_CONFLICT` | the source stacks two palette colours in the opposite order to the palette (`colourStack.conflicts`); the source order is kept |
| `COLOUR_UNCLASSIFIED` | a colour used by symbols is not an IOF colour (`colourStack.unclassified`); its symbols stay as drawn |

### 3.8 Stage 5: georeference and north (both sources)

`mapImport.analyseDocumentInput(input)` runs at the end of both
normalisers and returns `analysis` with the input;
`mapImport.analyseMapDocument(doc)` gives the same result from a decoded
document. Pure and isomorphic (`packages/shared/src/import/analyse.ts`
over `mapGeo`, `packages/shared/src/geo/`). Its results are
transcendental (proj4, sin/cos/atan2) and derived, so they are never
written into the document (§6, `docs/map-document-format.md` §2.3); they
go into the import report and the `map_files` columns.

**Projection** (`mapGeo`): paper (native units, y-up) → projected:
rotate by −(`gridRotationDeg` + correction), scale by
`gridScaleFactor · mapScale / (unitsPerMm · 1000)` m per unit, add
`paperOrigin`; projected ↔ WGS 84 by proj4 with the EPSG definitions in
`geo/epsg.ts` (SWEREF99 TM and the 12 local zones 3006–3018, 3067,
ETRS89 / UTM 25832–25835, WGS 84 / UTM 32632–32636). A CRS outside that
list resolves (`method: "epsg"`) but is not `projectable`, and every
WGS 84 field is null. The correction is the operator's
`rotation_correction`; stage 5 runs with 0.

**Meridian lines**: objects of `origin: "source"` symbols coded `601`
or `601.x`, grouped by symbol index; each line's tilt is the folded
angle from paper +Y of its first → last coordinate; lines shorter than
5 mm (`5 · unitsPerMm`) are dropped. A group counts with ≥ 10 lines and
a tilt standard deviation ≤ 0.7°; the largest group wins (ties: lowest
symbol index); `medianTiltDeg` is the upper median. Sums run over the
sorted tilts, so object order (Hilbert, in a stored document) does not
change the result. Same thresholds as the legacy `probeMeridianLines`.

**Fields** (`DocumentAnalysis`; the report's `georeference` and `north`
carry them under these names, which the S0 corpus check reads):

| Field | Meaning |
|---|---|
| `bounds` | union of object coordinate boxes, native units (= `header.bounds`) |
| `georeference.crs` | `"EPSG:<code>"` from `header.georeferencing.crs`, or null |
| `georeference.method` | `"epsg"` when a CRS resolved, else `"none"` (06 §4.4's `proj4-match` is not used: §4.4) |
| `georeference.projectable` | proj4 has a definition for the CRS |
| `georeference.gridRotationDeg` | declared grivation |
| `georeference.gridConvergenceDeg` | true north measured from grid north at the paper origin, atan2(Δe, Δn) of a 0.001° step north |
| `georeference.originWgs84` | `{lat, lng}` of the paper origin |
| `georeference.wgs84Bounds` | `{north, south, east, west}` around the projected corners of `bounds` |
| `north.meridian` | `{symbolIdx, code, count, medianTiltDeg, stddevDeg}` or null |
| `north.paperNorthBearingDeg` | initial bearing from true north of paper +Y, between the points at 25 % and 75 % of the height on the vertical centre line of `bounds` |
| `north.displayNorthOffsetDeg` | `paperNorthBearingDeg + medianTiltDeg` (0 without meridians): `map_files.north_offset` before any correction |

The API's report adds the legacy `NorthDetection` fields to `north`
(`packages/api/src/map-north.ts` `detectDocumentNorth`):
`declaredGrivationDeg`, `trueNorthFromGridDeg` (= convergence),
`centerLat` / `centerLng` (= `originWgs84`), the WMM `declinationDeg`
and `meridianStalenessDeg` at `asOf` (the worker's clock). Those three
depend on the import date, which is why the report is not part of the
document identity.

**Quick-access columns** (`mapFileMetadataFor`): `scale = mapScale`;
`bounds` = `wgs84Bounds`, `calibration` = the four corners of `bounds`
(min/min, max/min, min/max, max/max) as `{mapX, mapY}` paper mm with
`{lat, lng}`, and `northOffset` = paper-north bearing + meridian tilt —
all with the row's `rotation_correction`. Not projectable → no write.
The extent is the geometry's (`header.bounds`); the raster path used to
take the reader's object-index rectangles, which include symbol extents
(±0.4 mm on the fixture) — the shared function moved both writers to
the geometry.

## 4. OMAP normalisation rules

Reader: `packages/shared/src/import/omap-reader.ts` over the shared SAX
tokenizer (`xml.ts`). Mapper XML format versions 2–9 (`.omap` compact
and `.xmap` pretty-printed are the same document). Units: 0.001 mm
(`unitsPerMm = 1000`); widths and sizes in the symbol definitions are
already µm and pass through — the stage 6 factor detection sees ×1 on
every Mapper file tried. Field semantics are Mapper's own source
(`src/fileformats/xml_file_format.cpp`, `src/core/symbols/*.cpp` and its
OCD exporter `ocd_file_export.cpp`, which is the authority wherever
Mapper and OCAD disagree) cross-checked against the OOM ISOM / ISSprOM
symbol sets as a read-only oracle (06 §6.2; never shipped, never copied).

### 4.1 Reader (`readOmap`)

- Streaming, order-independent: the `<barrier>` compatibility wrapper
  that Mapper puts around everything after `<colors>` is transparent;
  sections are looked up under `<map>` or `<barrier>`.
- Builds the symbol list and metadata as a tree; `<object>` elements are
  consumed one by one into the current part and never kept as XML, so a
  100 MB `.omap` costs its objects, not its DOM. `icon`, `undo`, `redo`,
  `view`, `map_view` are discarded without being built.
- Coordinates: the compact text form `x y[ flags];…` (regex tokenised,
  `count` checked) and the legacy `<coord x y flags/>` form. Flags
  `CurveStart 1`, `ClosePoint 2`, `GapPoint 4`, `HolePoint 16`,
  `DashPoint 32`.
- Symbols are indexed by position; an `id` that disagrees with its
  position, or non-contiguous colour priorities, are warned and
  normalised (Mapper itself writes both contiguously).
- Output `OmapFile`: `version`, `notes`, `georeferencing`, `colours`
  (sorted by priority, 0 = top), `symbols`, `symbolSetId`, `parts`,
  `templates`, `print`, reader `warnings`. Everything else in the file
  (view, print mode details, undo) is dropped silently per 02 §1.

### 4.2 Coordinates and flags (deviations from 06 §3.2)

06 described the flag mapping from Mapper's data model; the implemented
rule follows what Mapper's **OCD exporter** does, since that is the
conversion every Mapper user has already accepted when they save as
`.ocd`:

| Mapper | Document (`COORD_FLAG`) | Rule |
|---|---|---|
| `CurveStart` on point *i* | `bezierFirst` on *i+1*, `bezierSecond` on *i+2* | as 06 |
| `HolePoint` on point *i* (last of the previous ring) | `hole` on *i+1* (first of the next ring) | as 06 |
| `ClosePoint` | *dropped*; the repeated coordinate is **kept** | 06 said "drop the repeated point, set closed". The document has no closed flag: areas are always closed by the render bridge and a line's closure *is* the repeated point, so dropping it would open closed line objects (fences, building outlines drawn as 519). Kept for both. |
| `DashPoint` | `dash` (8) if the object's symbol is a dashed line **without** a dash symbol; `corner` (4) otherwise | Mapper's exporter rule. 06's "always bit 8 + omap layout" would turn every dash point on a solid line with a dash symbol (511 power line, 516 fence) into a section boundary and lose the glyph. The per-symbol rule is computed once per symbol (`dashPointRule`) and applied per object. |
| `GapPoint` | `gap` (128) | internal in Mapper, honoured if present |

y is negated (Mapper y grows downward; the document is y-up), with
`-0` normalised to `0` so encode is deterministic. Objects take their
first coordinate only for point and text objects; a text object's
second coordinate (the box) is dropped with `TEXT_BOX_DROPPED`. Rotation
rad → 0.1° on the object; an area object's `<pattern rotation>` becomes
its `angleDeciDeg` (the pattern origin is dropped — the IR anchors
patterns at the paper origin).

### 4.3 Symbols → render IR

`packages/shared/src/import/omap-symbols.ts`
(`omapSymbolToRender(sym, { colourIndex, symbolById })`), the OMAP
counterpart of §3.3 producing the same `RenderSymbol`. Rules that
differ from OCAD or that 06 left open:

- **Point symbols**: elements are line, area **or nested point**
  symbols; a nested point is expanded recursively at its element
  coordinate (the OOM sets use this for every finish ring and for 44
  pattern definitions). Inner-colour discs / rings with a non-zero
  offset keep `cx`/`cy`. `rotatable` is the symbol's own flag; glyphs
  attached to lines follow it too (Mapper semantics; OCAD's rotate-to-
  line default is not assumed).
- **Lines**: `start_offset` / `end_offset` shorten the stroke unless the
  cap is `pointed`, in which case Mapper tapers over that length — the
  IR has no taper so the stroke is drawn butt and full length (noted as
  `SYMBOL_FEATURE_APPROXIMATED`). Border centre = `line_width/2 + shift`
  (Mapper measures `shift` from the main line's edge; the IR from its
  centre); dashed borders carry their own dash. Dash pattern → `layout:
  "omap"` with `dashes_in_group`, `in_group_break_length`,
  `half_outer_dashes` and `minimum_mid_symbol_count(_when_closed)` as
  06/03 specified. Mid symbols → `dashCentres` / `dashGroupCentres` /
  `gapCentres` per `mid_symbol_placement` when dashed, `spaced` when
  not; the dash symbol → `corners` with `ignoreEnds =
  suppress_dash_symbol_at_ends` and `scaleAtCorners` when
  `scale_dash_symbol` is set. A line with width 0 is kept only when it
  is a dashed carrier for mid symbols (the ISOM 516 fence idiom).
- **Areas**: fill colour, `pattern` elements → hatches (`type 1`) and
  point patterns (`type 2`, with `rotatable`, `no_clipping & 3`); the
  pattern angle is CCW like object rotation.
- **Text**: `bold` → weight 700, framing mode 1 → halo of
  `line_half_width`, framing mode 2 (box), `underline` and `line_below`
  are warned and dropped; font family through the same `ocadFontFamily`
  substitution table as §3.3 (`FONT_SUBSTITUTED`).
- **Combined symbols** are flattened into *one* IR symbol
  (`mergeLines`), parts by reference or inline, cycles and depth
  guarded. Primary = the first dashed line part with a positive width
  (else the first dashed, else the narrowest solid, else the first).
  Each further solid part is folded in, in this order: a part that
  carries borders when the result has none → the result's borders plus
  a background band of the part's colour / width (509 railway); a part
  wider than the result's main with no halo yet → a continuous halo of
  `(w − w_result)/2` (508.x rides, 502.2 wide road); a part that is
  narrower when the result has borders without background → the
  background band; anything else warns `SYMBOL_FEATURE_DROPPED`. A
  part's own glyphs are appended (511.2); a second dashed main, a
  second fill colour, point or text parts are warned and dropped. Area
  parts merge fills / hatches / patterns; a line part inside an area
  combination becomes `area.border`.
- `hidden` = `hidden || helper` (`HELPER_SYMBOLS_HIDDEN` counts helper
  symbols): Mapper never prints helper symbols, so neither does Oxygen.
- Minimum sizes: `minimum_length` / `minimum_area` → `minimum.lengthUm`
  / `areaUm2`.

### 4.4 Colours, georeferencing, print, parts

- **Colours**: Mapper `priority 0` is the *top* of the stack; the
  document's index 0 is the bottom, so the list is reversed. `id =
  "src:<priority>"`, `sourceNumber = priority`, CMYK as written, `spot
  {name?, knockout?}` kept when the colour is a named spot or a
  component composition; `opacity < 1` is recorded and
  `COLOUR_OPACITY_IGNORED` counts it (the renderer draws opaque, 04 §6.8).
- **Georeferencing**: `crs` resolved by id — `EPSG` (the code parameter),
  `UTM` (`"33 N"` / `"33 S"` → 32600 / 32700 + zone), `Gauss-Krueger`
  (zones 2–5 → 31466–31469), `PROJ.4` by parsing `+init=epsg:` or a
  plain `+proj=utm +zone=… +datum=WGS84 [+south]`; `Local` or no CRS →
  `null`, anything else → `null` with `CRS_UNRESOLVED` naming the spec.
  06 proposed matching the PROJ.4 spec against the OCAD grid table; the
  parse covers every spec in the OOM sets and the corpus `.omap`s, and
  the grid table only knows OCAD ids. `paperOrigin` is the projected
  position of paper (0, 0): `P_ref + Rot(−grivation) · s · flipY(−ref_point)`,
  `s = grid_scale_factor · scale / 1000` (mm → m), reproducing Mapper's
  `Georeferencing::toProjectedCoords`, each coordinate rounded to
  1e-6 m (1 µm on the ground; Mapper writes its reference points to the
  millimetre) so no unrounded sin/cos result reaches the document bytes
  (§6; `omap-2`). `gridRotationDeg = grivation`,
  `declinationDeg` when non-zero, `realWorldEnabled` when a CRS resolved.
  `mapScale` from `<scale>`, default 15 000 with `MAP_SCALE_MISSING`.
- **Print**: `<print_area left top width height>` (mm, y-down) →
  `printWindow` in document units, y flipped; no export rectangles.
- **Parts**: merged in part order; `PARTS_MERGED` lists the names
  (06 §3.2). `sourceIndex` is the position in the merged object stream.
- **Templates**: `TEMPLATES_DROPPED` lists the file names.
- **Object tags**: 06 wanted them kept as attributes; the document has
  no per-object attribute slot yet (02 §10 reserves room), so they are
  counted by `OBJECT_TAGS_DROPPED` until it does.
- **Text objects**: Mapper stores horizontal and vertical alignment per
  *object*; the IR stores alignment per *symbol*. When every object of
  a symbol agrees, the alignment is lifted onto the symbol; otherwise
  `TEXT_ALIGNMENT_PER_OBJECT` counts the symbol and the first object's
  alignment wins. Vertical alignments other than baseline are counted
  by `TEXT_VERTICAL_ALIGNMENT_DROPPED`. Empty texts are dropped
  (`EMPTY_TEXT_DROPPED`).
- Objects referencing a symbol id outside the table get a stub
  (`origin: "missing"`, code `#<id>`, `MISSING_SYMBOL`); unknown object
  types and empty geometry are dropped with the §3.4 codes.

### 4.5 Warning codes added by the OMAP path

`COLOUR_OPACITY_IGNORED`, `HELPER_SYMBOLS_HIDDEN`, `TEXT_BOX_DROPPED`,
`TEXT_ALIGNMENT_PER_OBJECT`, `TEXT_VERTICAL_ALIGNMENT_DROPPED`,
`OBJECT_TAGS_DROPPED`, `PARTS_MERGED`, `CRS_UNRESOLVED` (shared with
OCAD since `ocad-5`, §3.5), `MAP_SCALE_MISSING`, `EMPTY_TEXT_DROPPED`, plus the reader's own
(`READER_WARNING` texts for unknown elements, misnumbered symbols,
non-contiguous priorities). The rest are shared with §3.6–3.7.

## 5. Header provenance

`format.importer` is `"ocad-5"` for OCAD sources (`OCAD_IMPORTER_VERSION`;
`ocad-1` had `render: null` for every source symbol, `ocad-2` carried the
upload name in the header, `ocad-3` had no matcher, `ocad-4` stored
ScalePar `d` as `declinationDeg`, ignored `e` and had no
`CRS_UNRESOLVED`) and `"omap-2"` for Mapper sources
(`OMAP_IMPORTER_VERSION`; `omap-1` stored `paperOrigin` unrounded).
Documents of either earlier version have no `georeference` / `north` in
their report; the dedup only reuses current-version documents, so the
next import of their source produces both. Bump the relevant one whenever
stages 3–8 would produce different bytes for the same file — reader fix,
normaliser rule, codec change, matcher thresholds; a codec or matcher
change bumps both. Library changes are carried
separately by `header.library {id, version}` (`SYMBOL_LIBRARY_VERSION`)
and `map_documents.library_version`; the store dedups on both (any
current importer version, `docs/map-storage.md` §6.1). `source` carries the reader's file version, `fileHash` and size
— not the upload name, so the same bytes give the same document whatever
the file was called (06 §4.2). The name is kept on `map_sources.file_name`
and in the import report (`mapImport.importReportSchema`,
`packages/shared/src/import/report.ts`; shape in `docs/map-storage.md` §3).

## 6. Determinism

Required and tested: same bytes in → same document bytes and hash out,
across processes and machines. Unit tests `import-ocad.test.ts` /
`import-omap.test.ts` encode `e2e/test.ocd` / `e2e/test.xmap` twice; the corpus script asserts `sameAsPrevious` across
runs. Sources of non-determinism to avoid when extending the normaliser:
iteration over `Map`/`Set` built from sparse arrays (use the array
index), floating-point sums (keep source integers), `Date`/random ids,
and transcendental functions (`Math.sin`/`cos`/`atan2`, proj4): their
last-bit results are not guaranteed identical across engines and
platforms, so the header holds only source-declared values and the one
computed value (OMAP `paperOrigin`) is rounded to 1e-6 m; everything
projected lives in the report (§3.8). The S0 corpus check asserts the
document hash is identical on two machines.

## 7. Tests

| Level | File | Covers |
|---|---|---|
| Unit (shared) | `packages/shared/src/import/__tests__/xml.test.ts` | the SAX tokenizer: prolog / comments / CDATA / DOCTYPE, entities, attribute quoting, mismatched and unclosed tags, second root, the pruning tree builder |
| Unit (shared) | `packages/shared/src/import/__tests__/omap-reader.test.ts` | barrier wrapper, both coordinate forms and every flag, symbols of all five types incl. inline sub-symbols, colours with spot components, georeferencing, parts, templates, print, tags, misnumbered symbols |
| Unit (shared) | `packages/shared/src/import/__tests__/omap-symbols.test.ts` | every §4.3 rule: point glyphs incl. nested points and offset discs, line caps / shortening / pointed taper, borders, dash layouts and mid / dash / start / end placements, width-0 carriers, area hatch and pattern, text framing and fonts, the combined-symbol merge table (509, 508.x, 502.2, 511.2, second dashed, area combinations) |
| Unit (shared) | `packages/shared/src/import/__tests__/omap-source.test.ts` | the fixture through `omapToDocumentInput`: colour stack order and opacity, y flip and `-0`, every §4.2 flag rule, hole shift, dash-point rule per symbol, text alignment lifting, missing symbols, parts merge, templates, print window, georeferencing (UTM / EPSG / Gauss-Krüger / PROJ.4 / Local / unresolved), codec round trip, every §4.5 warning code |
| Unit (shared) | `packages/shared/src/import/__tests__/ocad-source.test.ts` | colour stack order, symbol table, hidden flag, duplicates, graphic objects, missing symbols, flag mapping, georeferencing (no `declinationDeg` from `d`, `e` fallback, grid table first, `CRS_UNRESOLVED`), print window, warning codes, `analysis` returned |
| Unit (shared) | `packages/shared/src/geo/__tests__/projection.test.ts`, `north.test.ts` | §3.8 maths: EPSG lookup, paper ↔ projected (rotation + correction, grid scale factor, round trip), Mapper's reference point on the `e2e/test.xmap` frame, paper ↔ WGS 84, convergence at Nackareservatet (−2.82°) and on a central meridian, paper-north bearing, extent and calibration corners, `mapFileMetadata`; angle folding and the cluster thresholds |
| Unit (shared) | `packages/shared/src/import/__tests__/analyse.test.ts` | `601` / `601.x` codes, grouping per symbol, 5 mm floor scaled by `unitsPerMm`, graphic symbols excluded, georeference fields, un-georeferenced and non-projectable CRSs, same result over the decoded document |
| Unit (shared) | `packages/shared/src/import/__tests__/ocad-symbols.test.ts` | every row of the §3.3 tables: line styles, dashes (507 end gap), framing, double lines, main / secondary / corner / start / end symbols, point elements, area fill / hatch / pattern / border, text mapping, fonts, warning codes |
| Unit (shared) | `packages/shared/src/render/__tests__/{dash,placement,symbolise}.test.ts` | OCAD end-gap semantics, `dashGroupCentres` / `sectionCentres`, `backgroundWidthUm`, continuous halo |
| Unit (shared) | `packages/shared/src/map-document/__tests__/codec.test.ts`, `projection-bridge.test.ts` | encode/decode round trip, Hilbert order, validation errors, truncation, JSON projection, render bridge |
| Unit (shared) | `packages/shared/src/import/__tests__/{colour-class,fingerprint,matcher,colour-align,match-document}.test.ts` | stages 6–7: CMYK / name classification, fingerprints and tolerances, every matcher stage and the traps (reused numbers, template variants, old numbering), factor detection (lines / codes / scale / override), alignment steps and conflicts, whole-document run with codec round trip and canonical drawing through the bridge |
| Unit (api) | `packages/api/src/__tests__/import-ocad.test.ts` | reader → document on `e2e/test.ocd`, determinism, bboxes, all fixture symbols converted, symbolise without proxies, fixture matches (3 auto, old-numbered ring suggested, factor by `codes`), stack with inserted lower purple, hook renders against the source table; stage 5: grid 13002 → EPSG:3006 with no `declinationDeg`, the same 12-line meridian cluster as the legacy probe, report `georeference` / `north` with WMM fields at `asOf` agreeing with `detectMapNorth`, raster-path and pin columns identical (correction 0 and 11) |
| Unit (api) | `packages/api/src/__tests__/import-omap.test.ts` | reader → document on `e2e/test.xmap`: determinism across `importOmapToDocument` / `importMapToDocument`, provenance (`omap-2`, version 9, UTM 33N), bboxes, all 21 fixture symbols rendered, symbolise with the dangling symbol as the only drop, factor ×1, import report, kind sniff with BOM, the two kinds kept apart |
| Unit + integration (api) | `map-import-jobs.test.ts` (both) | worker runs a Mapper file by kind with the same hashes as inline; a Mapper source goes through the job to a `done` row with `importer_version omap-2` and is deduplicated on the second job; garbage of either kind fails cleanly; the pin writes the quick-access columns equal to the raster path's, recomputes them with a row's `rotation_correction` idempotently, and leaves them alone for a document without a CRS |
| Unit (api, unchanged) | `map-north.test.ts`, `map-projection-correction.test.ts`, `map-coordinate-transfer.test.ts`, `course-import-align.test.ts` | the legacy modules as adapters over `mapGeo` keep their behaviour |
| E2E | `e2e/map-gl-doc.spec.ts` | document path = reader path in the browser, native `.oxvm` round trip, `mode=source` draws the fixture from its own definitions with no proxies; `e2e/test.xmap` loads client-side with no OCAD reader, draws, and surfaces the OMAP warning codes |
| Unit + integration + E2E (api, web) | see `docs/map-storage.md` §10 | stages 1 and 9: chunked upload route, import jobs, store, dedup, pins, report row, delivery route |
| Unit + integration + E2E (api) | see `docs/map-storage.md` §10 (previews rows) | stage 10: thumbnail row written by the job and by the dedup short-cut, non-fatal failure, object cap |

The S0 corpus check (09 §7: whole corpus, every OMAP construct): the
OCAD half runs via the measurement script and is recorded in
`docs/map-document-format.md` §9; the OMAP half has run against the
three OOM symbol sets (ISOM 2017-2, ISSprOM 2019-2, ISOM 2017-2 1:10000 —
185 rendered symbols in the ISOM set, 106 auto / 46 suggested / 38
unmatched / 25 variant, factor ×1 by `lines`, the only conversion
warnings being 502.2's extra border pair and 602's empty point symbol)
and the corpus `.omap` files; results stay in the local measurements
directory, not in the repo.

## 8. Pending in this chapter

S2 confirmation of the *provisional* §3.3 rows against OCAD output,
event / club map *apply* for Mapper sources (needs slice C, §2.2), review API
(06 §5.1, §5.3; previews landed, `docs/map-storage.md` §4.5), the `decisions` input to a job (06 §5.3 — the column
exists and `matchDocument` accepts decisions, nothing reads the column
yet), stage 5 fonts used (fallback decisions) and feature usage (03 §6.8
table) — 06 §4.4's `fonts` / `features` report sections; the `proj4-match`
CRS method for PROJ.4 specs neither parse nor the grid table knows. Each
lands with its own section here and its own tests.
