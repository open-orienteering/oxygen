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
 6 match        03 §6.5 staged matcher → SymbolMatch[]                    shared     done (docs/map-symbols.md §8); club decisions as stage 1 (§8.5)
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

const { input, counts, warnings, warningDetails, analysis } = mapImport.ocadToDocumentInput(ocadFile, {
  fileName, fileHash, fileBytes,
  importer?: string,                                   // default OCAD_IMPORTER_VERSION
  renderFor?: (symbol) => RenderSymbol | null,         // replaces the §3.3 conversion when given
});
// analysis: stage 5 over `input` (§3.8) — bounds, georeference, north; not part of the document
// warningDetails: one entry per warning emission, for the import report (§3.6); not part of the document
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
const { input, counts, warnings, warningDetails, analysis } = mapImport.omapToDocumentInput(file, {
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
// r.kind, r.bytes, r.documentHash, r.fileHash, r.counts, r.warnings, r.warningDetails,
// r.matching, r.colourStack, r.analysis (stage 5, §3.8), r.libraryVersion ("ISOM2017-2@2026.10.3"),
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

`runImportInWorker(bytes, fileName, { kind, decisions })` also carries
the job's decision snapshot (`map_import_jobs.decisions`,
`docs/map-storage.md` §6.1) into `match.decisions`, so stage 6 applies the
club symbol decisions (`docs/map-symbols.md` §8.5) exactly as the job
row recorded them when it was inserted.

**Review round** (06 §5.1, §5.3; `docs/map-storage.md` §6.8):

```
mapImport.review   { documentHash }                          query, map-storage §4.2 predicate (courses.view, kiosk key)
  → { documentHash, current, library, symbols: ReviewRow[], stack: { colours, alignment }, report }
mapImport.decide   { documentHash, decisions: ReviewDecision[] }   mutation, the same predicate in edit mode
  → { applied, job }                                         job as mapImport.status returns it
mapImport.finalise { documentHash, target: {kind:"event"} | {kind:"club", clubMapId} }   mutation
  → { documentHash, pinned, previous[] }

type ReviewDecision = { symbolIdx; accept: canonicalId } | { symbolIdx; unmatch: true } | { symbolIdx; reset: true }
```

- `ReviewRow` is `docs/map-symbols.md` §8.5 plus `previewUrl`
  (`/api/map-documents/:hash/symbols/:idx.png`, null without a render) and
  a `previewUrl` per candidate (`/api/library/:libraryId/:version/:code.png`,
  the current release — A5's versioned path, `docs/map-storage.md` §4.5).
  The URLs are relative and carry no event: a client reviewing an event's
  document appends `?event=<nameId>` as for the document route.
  `current` is true when importing the source now would give this very
  document (current importer, current library release, current
  decisions); `stack.colours` is the header's colour stack and
  `stack.alignment` the report's `colourStack` summary.
- `decide` validates every decision against the document (index exists,
  a source symbol with a render, an accepted id is an entry of the
  document's library — `BAD_REQUEST` otherwise), writes the club rows
  (`accept` / `unmatch` upsert under the current release, `reset` deletes
  the fingerprint's rows of that library) and starts an import job for
  the document's source **without a target**. The job snapshots the new
  decisions, so its document is the reviewed one; it is stored, visible
  to the decider through the own-job clause (`docs/map-storage.md` §4.2) with its swatches, and
  pinned nowhere. Same file + same decisions ⇒ same document (the dedup
  short-cut finds it). `reset` of everything returns the matcher's own
  document.
- `finalise` pins a document where its source is the target's map:
  `target.kind: "event"` = the request's event (`x-event-id`,
  `courses.edit`; `BAD_REQUEST` without an event), every `map_files` row
  carrying the document's source; `"club"` = that club map's version of
  the source, whose `document_hash` moves (`docs/map-storage.md` §6.4).
  `PRECONDITION_FAILED` when the target's map is another file;
  `NOT_FOUND` for an unknown document, an event without a map or an
  unknown club map. Finalising the matcher's own output is a no-op
  (06 §5.1); `previous` lists the hashes that were pinned before.
- Authorisation (`docs/map-storage.md` §4.2): `review` is the document route's predicate exactly (not behind `authedProcedure`: a kiosk key with no user reads, as on the route).
  `decide` and `finalise` use it in edit mode (`EDIT_ACCESS`): the event
  clause needs `courses.edit` and never takes the kiosk key; the club and
  own-job clauses read as for reading. Club map targets need a signed-in
  user, as the club library's own mutations.

**CRT export / import** (06 §5.1, §5.3; format and resolution rules in
`docs/map-symbols.md` §8.6):

```
mapImport.exportCrt { documentHash, includeMatches?: boolean }      query, review's predicate (READ_ACCESS)
  → { documentHash, fileName, library, crt, rules, kept, auto }
mapImport.importCrt { documentHash, crt: string ≤ 1 MiB, dryRun?: boolean }   mutation, decide's (EDIT_ACCESS)
  → { decisions: ({symbolIdx, accept} | {symbolIdx, unmatch: true})[], unchanged[], skipped[], warnings[], applied, job | null }
```

- `exportCrt` reads the club rows of the document's library for the
  document's fingerprints (`includeMatches` adds its automatic matches).
  `fileName` follows Mapper's `SOURCE-TARGET.crt` convention:
  `<source file name without extension>-<library id>.crt`. `rules` /
  `kept` / `auto` count the rule lines, `# keep` lines and the rule lines
  marked `auto`. Same document + same rows ⇒ the same bytes.
- `importCrt` resolves the CRT against the document and passes the
  applicable `accept` / `unmatch` decisions to `decide`'s
  `decideOnDocument`: rows under the current release, one import job
  without a target, `{ applied, job }` exactly as `decide`. `unchanged` /
  `skipped` list `{ line, symbolIdx }` / `{ line, code, message }`;
  `warnings` are the counted codes. Nothing applicable, or `dryRun: true`,
  writes nothing and returns `applied: 0, job: null` with the resolved
  `decisions`. More than 5 000 applicable decisions (`decide`'s cap) is
  `BAD_REQUEST`; so is a CRT over 1 MiB.
- Authorisation is `review`'s for the export (a kiosk key reads; the
  rows are what `review` already shows) and `decide`'s for the import.

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
| `distFromStart`, `distToEnd` | `shortenStartUm`, `shortenEndUm`; with `cap: "pointed"` `main.taper { startUm, endUm }` | On a line without pointed ends they shorten the stroke. With `cap: "pointed"` they are the lengths of the points and become `main.taper` instead (user decision 2026-10-20, `docs/map-rendering.md` §3.2): the line is not shortened, and each end gets a `taper` key only when its length is > 0 (no `taper` at all when both are 0). Since `ocad-11` (A13); earlier importers shortened pointed lines too. Corpus: 107.0 erosion gully tapers 0.75 mm at both ends. |
| `mainLength`, `mainGap`, `endLength` | `dash { layout: "ocad", dashUm, gapUm, endDashUm? }` | Only when `mainLength > 0` and any of `mainGap`, `secGap`, `endGap` > 0. `endDashUm` only when it differs from `mainLength`. |
| `secGap` | `dash.secondaryGapUm` | Secondary gap splitting each interior dash (`dashesInGroup` default 2). |
| `endGap` | `dash.endGapUm` | *Provisional.* The secondary gap applied to the **end** dashes, not a line-end shortening: 507 footpath has `mainLength 225, endLength 225, mainGap 80, secGap 25, endGap 25`. |
| `minSym` | `dash.minGaps` | Only when `> 0`. |
| `frColor`, `frWidth`, `frStyle` | `main.halo { colour, widthUm: (frWidth − lineWidth)/2, continuous: true }` | The framing line is a solid stroke of total width `frWidth` under the main line; it stays solid under a dashed main line (509 railway). When the main width is 0 the halo takes `frStyle`'s cap/join. `frWidth < lineWidth` ⇒ the same halo with a **negative** `widthUm` (a framing line narrower than the main line, user decision 2026-10-20, `docs/map-rendering.md` §4.4; Crop-A / Crop-B 503.1: 0.65 under 0.67 mm, unused), since `ocad-11` (A13). `frWidth = lineWidth` ⇒ dropped with `SYMBOL_FEATURE_DROPPED` (`framing line as wide as the main line`): the IR rejects a zero-width halo. Not in the corpus. |
| `doubleLine.dblMode` 1–3 | `borders` | Mode 1 both edges solid, 2 left edge dashed, 3 both dashed (`dblLength` / `dblGap`); 0 and 65535 off; anything else warns. *Provisional.* |
| `dblLeftColor/Width`, `dblRightColor/Width`, `dblWidth` | `borders.left / right { colour, widthUm, shiftUm: dblWidth/2 + width/2 }` | Edges straddle the `dblWidth` band. |
| `dblFlags & 1`, `dblFillColor` | `borders.backgroundColour`, `backgroundWidthUm: dblWidth` | Band drawn in the fill colour, even without edges. `dblFlags & 2` (background colour) warns. |
| `primSymElements`, `nPrimSym`, `primSymDist` | `glyphs[] { glyph, placement }` | Main symbol only when `nPrimSym > 0` (518.3 "Utan tagg" has elements but `nPrimSym 0`). Solid line ⇒ `spaced { distanceUm: mainLength, firstUm = lastUm = endLength, perSpot: nPrimSym, spotSpacingUm: primSymDist, minCount: minSym + 1 (when minSym ≥ 0) }`; dashed ⇒ `dashCentres`; dashed with `secGap`/`endGap` ⇒ `dashGroupCentres` (the glyph sits in the secondary gap, 517 ruined fence). |
| `secSymElements` | `sectionCentres` | Once per corner-delimited section. *Provisional.* |
| `useSymbolFlags` bit 1 + `endSymElements`, bit 2 + `startSymElements`, bit 4 + `cornerSymElements` | `end` / `start` / `corners` | Bit 1 is the **end** symbol and bit 2 the start symbol (user decision 2026-10-21, B9: club-full's 518.1 sets 5 with only an end symbol defined, and Coursecraft decodes it so; `ocad-8` read them the other way round). Neither Mapper nor the legacy SVG reads the flags — both draw any start / end elements present. The corner symbol lands on corner-flagged vertices only, ends included when flagged (map-rendering §4.5; `ocad-8`'s rule put one on every end — 44 phantom poles on club-2026's 510). |
| `decrease.decMode ≠ 0` | — | Warned, drawn full size. Not in the corpus. |

**Point symbols** (`type 1`) → `{ type: "point", glyph, orientation }`:
`orientation = flags & 1 ? "object" : "north"`, `glyph.rotatable` likewise
— with one exception decided by the objects: a north-oriented symbol that
has at least one point object with a non-zero `ang` becomes `orientation:
"object"`, `glyph.rotatable: true`, unless its glyph is only discs and
rings centred on the origin (which look the same at any angle and stay
`north`). OCAD draws such objects turned, and Mapper's OCD import does
the same (`importObject`: a non-rotatable, non-symmetrical point symbol is
made rotatable on the first object with an angle). Since `ocad-14` (C10):
Club-full has 23 north-oriented point symbols with rotated objects — its
504.5 / 504.7 barriers, 512.3 footbridge and 519.0 tunnel are rotated on
every object and are `flags 1` in Club-2026; the other corpus maps have
none. `ocad-13` and earlier drew them north-up: six of the 23 diverged
15–36 % from the legacy in B9's parity tool, none does since
(`docs/map-rendering.md` §6.4, `docs/bugfix-ocad-point-rotation.md`). Objects with `ang` 0 are unaffected
by the change; the matcher (stage 6) sees the corrected orientation. The
rule is OCAD-only: Mapper writes `rotation` only for rotatable symbols
(§4.3).

**Symbol elements** (point glyphs, area patterns, line decorations) →
`GlyphPart`: type 1 line ⇒ `stroke` (`lineWidth`, cap/join from `flags`,
coordinates ×10 with the OCAD coordinate flags), 2 area ⇒ `fill`
(closed), 3 circle ⇒ `ring` (`lineWidth`, centre from the first
coordinate; the IR's outer diameter is `diameter + lineWidth` from OCAD 9
on, where `diameter` runs along the line's centre, and `diameter` itself
in OCAD 8 and older — Mapper's OCD import reads it the same way; B9 found
`ocad-8` one line width small against the legacy tiles), 4 dot ⇒ `disc`. Elements whose colour is unknown are
skipped; a glyph with no parts left is dropped.

**Area symbols** (`type 3`) → `{ type: "area", fill?, hatches?, patterns?, border? }`

| OCAD | IR | Notes |
|---|---|---|
| `fillOn`, `fillColor` | `fill` | |
| `hatchMode` 1 / 2, `hatchColor`, `hatchLineWidth`, `hatchDist`, `hatchAngle1/2` | `hatches[]` | `spacingUm = hatchDist × 10` is the **pitch** (line to line). Mode 2 adds a second hatch at `hatchAngle2`. |
| `structMode` 1 / 2, `structWidth/Height/Angle`, `elements` | `patterns[]` | Mode 2 ⇒ `shiftedRows`. `clip` from `structDraw`: 0 `clip`, 1 `completelyInside`, 2 `centreInside`, 3 `partiallyInside`. `structIrregularVarX/Y > 0` ⇒ regular grid + `IRREGULAR_PATTERN_REGULARISED`. |
| `flags & 1` | `hatches[].rotate`, `patterns[].rotate` | `"manual"` when set, else `"never"`. |
| `borderOn`, `borderSym` | `border` | The referenced line symbol's body, converted with the same rules (its warnings propagate). A reference that is the area itself, is missing from the table or is not a line symbol is a stale reference — a source data error: no border is drawn, the fill / hatch / pattern stay, and `SYMBOL_REFERENCE_INVALID` names the case (`border symbol 301002 is the symbol itself` / `… is not in the symbol table` / `… is an area symbol, not a line symbol`). The importer does not guess the intended line symbol. Stale references exist in the corpus (Club-full 301.2, 520.3, 522.1, 709.4, 709.6 point at themselves; 307.1 points at the area 301.2). |

**Text symbols** (`type 4`, `type 6` line text) → `{ type: "text", … }`

| OCAD | IR | Notes |
|---|---|---|
| `fontName` | `fontFamily` | Arial / Helvetica / Liberation Sans / Arimo ⇒ `liberation-sans`; Arial Narrow ⇒ `liberation-sans-narrow`; Times (New Roman) / Tinos ⇒ `liberation-serif`; Courier (New) / Cousine ⇒ `liberation-mono`. Anything else is substituted by keyword (narrow / mono / serif / default sans) with `FONT_SUBSTITUTED`. |
| `fontSize` (1/10 pt) | `fontSizeUm = round(fontSize/10 × 352.78)` | |
| `fontColor`, `weight`, `italic` | `colour`, `weight`, `italic` | |
| `alignment & 3` | `align` | 0 left, 1 centre, 2 right, 3 justify. |
| `alignment & 0xfc` | `verticalAlign` | 4 ⇒ `"middle"`, 8 ⇒ `"top"`, 0 (baseline) ⇒ the field is left out — the IR has no default for it on purpose, so a baseline symbol parses as before. Any other value ⇒ `SYMBOL_FEATURE_DROPPED` (`vertical text alignment N`), anchored at the baseline. Since `ocad-11` (A13). The anchor metrics are *provisional* until S2 (`docs/map-rendering.md` §4.9). Corpus: Club-full 802.6 / 802.7 top, Crop-A / Crop-B 901.0 middle and 902.0 top. |
| `lineSpace` (%) | `lineSpacing = lineSpace / 100` | |
| `paraSpace` (1/100 mm) | `paragraphSpacingUm` | |
| `charSpace` (%) | `charSpacing = charSpace / 100` | |
| `wordSpace` (%) | `wordSpacing = (wordSpace − 100)/100 × 0.278` | Only when ≠ 100; 0.278 em approximates the space glyph. *Provisional.* |
| `frMode` 2 (line framing), `frColor`, `frWidth` | `halo { colour, widthUm: frWidth × 10 }` | `frWidth` is how far the framing reaches beyond the glyph outline — the halo's half-width, as Mapper reads and writes it (`framing_line_half_width`, §4.3), so an OCAD file and its Mapper conversion give the same halo. `frWidth` 0 ⇒ no halo and no warning (nothing is drawn). An `frColor` the colour table lacks ⇒ `SYMBOL_COLOUR_UNKNOWN`, no halo. `frStyle` (the framing stroke's join) is not carried: a halo is stroked round / round on every backend (`docs/map-rendering.md` §4.9). |
| `frMode` 1 (shadow), `frColor`, `frOfX`, `frOfY` | `shadow { colour, offsetXUm: frOfX × 10, offsetYUm: frOfY × 10 }` | Offsets in OCAD's paper coordinates, y up, as the IR's (*provisional* until S2: no corpus shadow is offset vertically against a known rendering). Both offsets 0 ⇒ no shadow and no warning (it would sit under the text, as a zero-width halo draws nothing). An `frColor` the colour table lacks ⇒ `SYMBOL_COLOUR_UNKNOWN`, no shadow. `frWidth` is not used by a shadow. Since `ocad-11` (A13). Corpus: Club-2026 815.2 (colour 9, 0.2 mm right), Club-full 825.1 (0.1 / 0.1 mm). |
| `frMode` 3 (rectangle), `frColor`, `frLeft`, `frBottom`, `frRight`, `frTop` | `frame { colour, leftUm, bottomUm, rightUm, topUm }` (margins × 10) | A filled rectangle behind the text block (`docs/map-rendering.md` §4.9). An `frColor` the colour table lacks ⇒ `SYMBOL_COLOUR_UNKNOWN`, no frame. On a line-text symbol (where OCAD does not define it) ⇒ `SYMBOL_FEATURE_DROPPED` (`rectangle framing on line text`). Since `ocad-13` (B8); none in the corpus. |
| `nTabs`, `tabs` (1/100 mm) | `tabStops: [{ xUm: tab × 10 }]` | The first `nTabs` entries; a non-positive stop, or one not beyond the previous, is not a stop; none ⇒ the field is left out. Since `ocad-13` (B8). Corpus: one stop on 12 (Club-2026) / 18 (Club-full) / 1 (Crop-A, Crop-B, Sprint) symbols, e.g. 815.2 at 7.5 mm, 801.x at 45 mm. |
| `indentFirst`, `indentOther` | — | ≠ 0 ⇒ `SYMBOL_FEATURE_DROPPED` (`paragraph indent`): the IR has no indents. 0 in the corpus. Since `ocad-13`. |
| `lbOn`, `pointSymOn` | — | Warned and dropped: line-below and attached point symbols are not in the IR. |

Reader struct offsets (from the start of the text attributes, i.e. after
the base symbol, whose OCAD 11+ description is 128 bytes — the reader
reads 64 and skips the rest before the body): `frMode` 194, `frStyle`
195, `pointSymOn` 196, `pointSymNumber` 197 (int32), `frColor` 228,
`frWidth` 230, `frOfX` 236, `frOfY` 238 — the same in OCAD 10, 11, 12 and
2018 (Mapper's `FramingAttributesV8`). Confirmed on the corpus and on the
fork's `fences.ocd` (902.1: line framing, colour 12, width 10).

**Line-text symbols** (`type 6`) convert with the same table — they carry
font, colour, size, weight, italic, spacing, alignment and framing, no
line or paragraph spacing, line-below or attached point symbol, and no
rectangle framing (`frMode` 3 is not defined for them) — and, since
`ocad-13` (B8), no longer warn: the object keeps type 6, its path and its
text (§3.4), the render bridge marks it `textLayout: "path"` and the
stage lays it along the path (`docs/map-rendering.md` §4.9). `ocad-7` to
`ocad-12` warned `SYMBOL_FEATURE_DROPPED` (`line text drawn as block
text`). No corpus map uses line text. The line-text struct is from the
OCAD 2018 file-format description and Mapper's `LineTextSymbolV11` only
(no real file seen): *provisional*.

**Rectangle symbols** (`type 7`) → `{ type: "line", cornerRadiusUm?,
main: { colour: lineColor, widthUm: lineWidth × 10, cap: "flat", join:
"miter" } }`: an outline line, as Mapper's OCD import makes of them.
Mapper strokes it round / round and rounds the corners by the radius;
Oxygen joins miter so unrounded corners stay as sharp as the verbatim
coordinates. Rectangle objects keep their corners verbatim (§3.4) and the
render bridge draws type-7 paths closed. `lineWidth` 0 ⇒ `SYMBOL_EMPTY`,
an unknown `lineColor` ⇒ `SYMBOL_COLOUR_UNKNOWN`, both `render: null`. A
corner radius (`radius` > 0) ⇒ `cornerRadiusUm = radius × 10`, rounded by
the symbolisation stage (`docs/map-rendering.md` §4.4), not at import —
rounding at import, as Mapper does, would rewrite source coordinates
(user decision 2026-10-20, A12); since `ocad-11` (A13), earlier importers
warned `SYMBOL_FEATURE_DROPPED` and drew the corners sharp. Corpus:
Club-full 850.1, 2.29 mm. A grid (`gridFlags & 1`, with cell size,
numbering and unnumbered-cell text) is not drawn — a by-design drop (user
decision 2026-10-20, B1) — and reported as `RECTANGLE_GRID_DROPPED`
(`rectangle grid (cells w × h mm) not drawn`, class `by-design`, §7);
`ocad-10` and earlier reported it as `SYMBOL_FEATURE_DROPPED`. Not in the
corpus. Struct (after the base symbol): `lineColor`
+0, `lineWidth` +2, `radius` +4, `gridFlags` +6, `cellWidth` +8,
`cellHeight` +10, two reserved words, `unnumCells` +16, `unnumText` +18
(string[3]).

Since the `v2.2.2-oxygen.1` fork release the reader parses both types for
OCAD 10–2018. Unknown types still warn `SYMBOL_TYPE_UNSUPPORTED`: the
reader leaves them out of the symbol table and says so in its warning
list (`Unknown symbol type 9`); the normaliser turns exactly those
warnings — and the reader's older `Ignoring rectangle / line text symbol
N.` texts, should an unparsed version ever produce them — into
`SYMBOL_TYPE_UNSUPPORTED` instead of counting them under
`READER_WARNING`. Objects that use such a symbol get the `MISSING_SYMBOL`
stub of §3.4.

**Warnings** (aggregated into the document header like every other
stage-4 warning):

| Code | Meaning |
|---|---|
| `SYMBOL_COLOUR_UNKNOWN` | A colour number the colour table lacks; that part of the symbol is skipped. |
| `SYMBOL_EMPTY` | Nothing drawable was left ⇒ `render: null`. |
| `SYMBOL_TYPE_UNSUPPORTED` | Unknown symbol type, also when the reader dropped it (from its warning list). |
| `SYMBOL_FEATURE_DROPPED` | Decrease, double-line background colour / unknown mode, a framing line exactly as wide as the main line, unknown text framing mode / rectangle framing on line text / line-below / attached point symbol / paragraph indent / a vertical alignment other than 0, 4, 8, zero-size hatch or pattern — constructs the render IR cannot express. |
| `RECTANGLE_GRID_DROPPED` | A rectangle symbol's grid, not drawn by design (class `by-design`, §7). Since `ocad-11`. |
| `SYMBOL_REFERENCE_INVALID` | A symbol-to-symbol reference that does not resolve to a usable definition: an area's border symbol that is the area itself, is missing from the table or is not a line symbol (§3.3 area table); on the OMAP path a combined-symbol part that references itself or a missing symbol (§4.3). A source data error, not an unsupported feature (§7 classification); the message names the symbol and the case. Since `ocad-10` / `omap-4`; earlier importers reported these as `SYMBOL_FEATURE_DROPPED`. |
| `FONT_SUBSTITUTED` | Font name not metric-compatible with the shipped family. |
| `IRREGULAR_PATTERN_REGULARISED` | Irregular area pattern drawn as a regular grid. |

**Corpus** (2026-10-16, script under the local measurements directory;
superseded for warnings by the 2026-10-20 S0 run in the research decision
log, which counts every symbol rather than the first message per code;
numbers only, no map content): 1 154 source definitions, 1 153
converted (one text symbol references a colour missing from its table);
objects drawn natively 45 628 / 100 845 / 4 927 / 3 021 / 10 680, proxied
0 / 3 / 0 / 4 / 0 (the proxies are missing-symbol stubs and that text
symbol). Warnings: `FONT_SUBSTITUTED` (Segoe UI), one text framing, two
stale border references, one too-narrow framing line. Since `ocad-7` (A12,
decision log 2026-10-20) the corpus's line-framed texts carry a halo, its
rectangle symbols convert, and what is left is shadow framing, vertical
alignment, one corner radius, a narrow framing line and the stale border
references. Since `ocad-10` (A14) the stale border references are
`SYMBOL_REFERENCE_INVALID` — six on Club-full, five self-references and 307.1
pointing at the area 301.2 — and no longer count among the unsupported features.
Since `ocad-11` (A13) the shadows, vertical alignments, the corner radius and
the narrow framing line are imported into their IR fields, and the five corpus
maps import with no unsupported-primitive warning (§7).

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
  text keeps all five coordinates (anchor + box), formatted text (type 5)
  its four box corners bottom-left, bottom-right, top-right, top-left
  (Club-2026 9, Club-full 13 objects, all unrotated), line text (type 6)
  its path; the render bridge picks the layout from the type
  (`docs/map-rendering.md` §4.9).
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
`LAYOUT_OBJECTS_DROPPED`), reader warnings (`READER_WARNING`, a count in
the header; the dropped-symbol-type ones are `SYMBOL_TYPE_UNSUPPORTED`
instead, §3.3). Since `ocad-7` the texts — the reader's own `warnings`
list minus those, in reader order, at most 50
(`READER_WARNING_TEXTS_MAX`) — are in the import report as
`readerWarnings`, present only when there are any; the document bytes do
not depend on them (`ocadToDocumentInput` returns them beside the input).
`ocad-6` stored the count only.

**Per-emission detail.** The header keeps one `{code, count, message}` per
code, the message being the first one emitted, so Club-full's four
`SYMBOL_FEATURE_DROPPED` show as one message. Since `ocad-10` / `omap-4`
both normalisers also return `warningDetails` beside the input, and the
import report carries it as `warningDetails: {code, message, symbolIdx?}[]`
(`importWarningDetailSchema`): one entry per warning emission that has a
message, in emission order, at most 500 (`WARNING_DETAILS_MAX`; every
emission is still counted in `warnings`), present only when there are any.
`symbolIdx` is the index in the document's symbol list — the symbol
conversion's, the duplicate's for `DUPLICATE_SYMBOL_NUMBER`, or the stub's for
`MISSING_SYMBOL` — and survives stage 6 (the matcher edits symbols in place).
Unless the cap was reached before the code was first emitted, the first detail
of each code carries the header's message. Warnings that are counts over many objects
(`EMPTY_GEOMETRY_DROPPED`, no message) and the stage 6–7 warnings (§3.7, one
message per code already) have no entries. The list is not part of the
document: it never reaches the header or the bytes (§6), so a change to it
alone does not bump the importer version. Reports from before `ocad-10` /
`omap-4` have none. Everything else in the file (view, zoom, bookmarks,
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
first coordinate only for point and single-anchor text objects. A **box
text** (a text object with `<size>`, or a second coordinate for the box
size) is stored as **formatted text** (type 5) with the box's four
corners bottom-left, bottom-right, top-right, top-left — Mapper's anchor
is the box centre, so the corners are `centre ± (width/2, height/2)` in
the y-up frame, turned by the object rotation. Unrotated, the corners are
integers with the width and height exact (`x0 = cx − ⌊w/2⌋`, `x1 = x0 +
w`); rotated, they need `cos` / `sin` and are rounded to native units —
the one computed coordinate, §6 (user decision 2026-10-22, B8). The
render bridge lays it out as box text (`docs/map-rendering.md` §4.9).
`omap-1` to `omap-6` kept the anchor only and warned `TEXT_BOX_DROPPED`
(retired in `omap-7`). Rotation
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
  cap is `pointed`, in which case they are Mapper's cap lengths (its
  `LineSymbol` has no other) and become `main.taper { startUm:
  start_offset, endUm: end_offset }` — each key only when > 0 — on a
  stroke of full length. A file whose pointed line carries only
  `pointed_cap_length` (offsets 0; Mapper still writes it, equal to the
  offsets: OOM ISOM 106, 747 µm ×3) tapers both ends over it. Since
  `omap-5` (A13); earlier importers drew pointed caps untapered. Border centre = `line_width/2 + shift`
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
- **Text**: `bold` → weight 700, framing mode 1 (line) → halo of
  `line_half_width`, framing mode 2 (shadow — Mapper's `ShadowFraming`;
  it has no box framing) → `shadow { colour, offsetXUm:
  shadow_x_offset, offsetYUm: −shadow_y_offset }` (Mapper's offsets are
  y-down, the IR's y-up; both 0 ⇒ nothing, no warning; since `omap-5`,
  A13), any other mode, `underline` and `line_below` are warned and
  dropped (`SYMBOL_FEATURE_DROPPED`); font family through the same `ocadFontFamily`
  substitution table as §3.3 (`FONT_SUBSTITUTED`). Custom `<tabs>` →
  `tabStops: [{ xUm }]`, read as native units (µm) like Mapper's other
  lengths; non-positive and non-ascending values are not stops; none ⇒
  the field is left out. *Provisional*: no Mapper sample has tabs. Since
  `omap-7` (B8).
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
  part's borders when the result already has borders (502.2: the wide
  road's edges outside the narrow line's) → one more entry of
  `borders.extraPairs` (`{ left?, right? }`, each side's `shiftUm` from
  that part's own width, `docs/map-rendering.md` §4.4), no warning, since
  `omap-5` (A13); the background band is unaffected. A part
  that references the combined symbol itself or a symbol id outside the
  table is a stale reference: `SYMBOL_REFERENCE_INVALID`, the part is skipped. A
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
- **Text objects**: Mapper stores horizontal (`h_align` 0 left, 1
  centre, 2 right) and vertical alignment (`v_align` 0 baseline, 1 top,
  2 middle, 3 bottom) per *object*; the IR stores both per *symbol*
  (`align`, `verticalAlign`). Per text symbol, the first (h, v) pair its
  objects use, in object order, is lifted onto the symbol itself
  (`verticalAlign` left out for baseline). Every further pair gets an
  **alignment variant**: an ordinary `origin: "source"` header entry
  appended after the symbol table and the missing-symbol stubs, in order
  of first use, with the parent's `code`, `name`, `kind`, `hidden`,
  `sourceIndex` and `sourceFont`, the parent's render with the pair's
  `align` / `verticalAlign`, and IR id `src:<id>/<align>/<verticalAlign>`
  (`src:20/right/middle`); the objects with that pair point at it (user
  decision 2026-10-22, A13 — no header schema change). The matcher,
  club decisions and the CRT treat a variant as a source symbol; its
  decision fingerprint is the parent's (the text fingerprint carries no
  alignment, `docs/map-symbols.md` §8.1), so one decision covers both,
  and the review shows one row per variant actually used. A value
  outside those ranges (not written by Mapper) reads as left / baseline.
  A symbol without a text render gets no variants. Since `omap-5`;
  `omap-4` lifted only a uniform horizontal alignment
  (`TEXT_ALIGNMENT_PER_OBJECT` otherwise) and dropped vertical ones
  (`TEXT_VERTICAL_ALIGNMENT_DROPPED`) — both codes are retired. Empty
  texts are dropped (`EMPTY_TEXT_DROPPED`).
- Objects referencing a symbol id outside the table get a stub
  (`origin: "missing"`, code `#<id>`, `MISSING_SYMBOL`); unknown object
  types and empty geometry are dropped with the §3.4 codes.

### 4.5 Warning codes added by the OMAP path

`COLOUR_OPACITY_IGNORED`, `HELPER_SYMBOLS_HIDDEN`,
`OBJECT_TAGS_DROPPED`, `PARTS_MERGED`, `CRS_UNRESOLVED` (shared with
OCAD since `ocad-5`, §3.5), `MAP_SCALE_MISSING`, `EMPTY_TEXT_DROPPED`,
`SYMBOL_REFERENCE_INVALID` (combined parts, §4.3; shared with OCAD since
`ocad-10`, §3.3), plus the reader's own
(`READER_WARNING` texts for unknown elements, misnumbered symbols,
non-contiguous priorities). The rest are shared with §3.6–3.7.

## 5. Header provenance

`format.importer` is `"ocad-14"` for OCAD sources (`OCAD_IMPORTER_VERSION`;
`ocad-1` had `render: null` for every source symbol, `ocad-2` carried the
upload name in the header, `ocad-3` had no matcher, `ocad-4` stored
ScalePar `d` as `declinationDeg`, ignored `e` and had no
`CRS_UNRESOLVED`, `ocad-5` counted the reader's dropped rectangle /
line-text symbols as `READER_WARNING` and warned `SYMBOL_FEATURE_DROPPED`
for double-line mode 65535 although §3.3 calls it off, `ocad-6` read
neither text framing nor rectangle / line-text symbols — no halo from
OCAD line framing, rectangle objects as `MISSING_SYMBOL` stubs — and kept
no reader warning texts, `ocad-7` matched descriptions on the entries'
English names only — `docs/map-symbols.md` §8.2 row 5, B7 —, `ocad-8` read
`useSymbolFlags` 1 / 2 as start / end and OCAD 9+ circle diameters as
outer diameters — §3.3, B9, `ocad-9` reported a stale area-border
reference as `SYMBOL_FEATURE_DROPPED` and kept no per-symbol warning detail
— §3.3, §3.6, A14, `ocad-10` dropped text shadows, vertical text alignment,
rectangle corner radii and framing lines narrower than the main line,
shortened pointed lines instead of tapering them and reported a rectangle
grid as `SYMBOL_FEATURE_DROPPED`, `ocad-11` is the A13 importer that reads them — §3.3, A13; `ocad-11` also fingerprinted Mapper's inverted railway as unmatched, `ocad-12` reads it as 509's construction — `docs/map-symbols.md` §8.1, A15; `ocad-12` had no tab stops or rectangle frame and warned line text, `ocad-13` is the B8 importer — §3.3; `ocad-13` drew north-oriented point symbols north-up even where their objects carry an angle, `ocad-14` turns them — §3.3, C10) and `"omap-7"`
for Mapper sources (`OMAP_IMPORTER_VERSION`; `omap-1` stored `paperOrigin`
unrounded, `omap-2` is `ocad-7`'s matcher, `omap-3` reported stale
combined-part references as `SYMBOL_FEATURE_DROPPED` and kept no
per-symbol detail, `omap-4` drew pointed caps untapered and dropped shadow
framing and a combined symbol's second border pair — §4.3, A13, `omap-5` is the A13 importer, `omap-6` is `ocad-12`'s matcher, A15; `omap-6` kept a box text's anchor only and had no tab stops, `omap-7` is the B8 importer — §4.2, §4.3). A header `warnings` change alone bumps the
version — `ocad-6` did — while the report-only `warningDetails` would not.
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
`import-omap.test.ts` encode `e2e/test.ocd` / `e2e/test.xmap` twice; the corpus script
(`scripts/measure-import.mjs`, §7) asserts `sameAsPrevious` across runs. Sources of non-determinism to avoid when extending the normaliser:
iteration over `Map`/`Set` built from sparse arrays (use the array
index), floating-point sums (keep source integers), `Date`/random ids,
and transcendental functions (`Math.sin`/`cos`/`atan2`, proj4): their
last-bit results are not guaranteed identical across engines and
platforms, so the header holds only source-declared values and the one
computed value (OMAP `paperOrigin`) is rounded to 1e-6 m; everything
projected lives in the report (§3.8). The one computed *coordinate*: a
**rotated Mapper box text**'s four corners (§4.2), which need `sin` /
`cos` of the object rotation, are rounded to integer native units
(0.001 mm) — a cross-engine last-bit difference flips such a rounding
with probability ~1e-12 per coordinate (user decision 2026-10-22, B8).
Unrotated boxes are computed in integers. The S0 corpus check asserts the
document hash is identical on two machines.

## 7. Tests

| Level | File | Covers |
|---|---|---|
| Unit (shared) | `packages/shared/src/import/__tests__/report.test.ts` | `WARNING_CLASS` classifies every code the importers, matcher and CRT parser emit and names none that nothing emits (source scan), the `unsupported` set is exactly the five codes of §7, `SYMBOL_REFERENCE_INVALID` is a `source-error`; `importReportSchema` accepts / rejects `warningDetails` |
| Unit (shared) | `packages/shared/src/import/__tests__/xml.test.ts` | the SAX tokenizer: prolog / comments / CDATA / DOCTYPE, entities, attribute quoting, mismatched and unclosed tags, second root, the pruning tree builder |
| Unit (shared) | `packages/shared/src/import/__tests__/omap-reader.test.ts` | barrier wrapper, both coordinate forms and every flag, symbols of all five types incl. inline sub-symbols, colours with spot components, georeferencing, parts, templates, print, tags, misnumbered symbols |
| Unit (shared) | `packages/shared/src/import/__tests__/omap-symbols.test.ts` | every §4.3 rule: point glyphs incl. nested points and offset discs, line caps / shortening / pointed taper (offsets, one end, `pointed_cap_length` only), borders, dash layouts and mid / dash / start / end placements, width-0 carriers, area hatch and pattern, text framing (line → halo, shadow → y-flipped shadow, zero offset), custom tab stops and fonts, the combined-symbol merge table (509, 508.x, 502.2 with its second border pair in `extraPairs`, 511.2, second dashed, area combinations), self and missing combined parts → `SYMBOL_REFERENCE_INVALID` |
| Unit (shared) | `packages/shared/src/import/__tests__/omap-source.test.ts` | the fixture through `omapToDocumentInput`: colour stack order and opacity, y flip and `-0`, every §4.2 flag rule, hole shift, dash-point rule per symbol, text alignment lifting and alignment variants (§4.4), box text as formatted text with four corners (odd sizes exact, rotated boxes turned and rounded, §4.2), missing symbols, `warningDetails` with the stub index, parts merge, templates, print window, georeferencing (UTM / EPSG / Gauss-Krüger / PROJ.4 / Local / unresolved), codec round trip, every §4.5 warning code |
| Unit (shared) | `packages/shared/src/import/__tests__/ocad-source.test.ts` | colour stack order, the file version reaching the circle-diameter rule, symbol table, hidden flag, duplicates, graphic objects, missing symbols, rectangle objects resolved to a parsed rectangle symbol, flag mapping, georeferencing (no `declinationDeg` from `d`, `e` fallback, grid table first, `CRS_UNRESOLVED`), print window, warning codes, reader-dropped types vs `READER_WARNING`, `readerWarnings` texts (order, cap of 50), `warningDetails` (one entry per emission with the symbol index, stub index for `MISSING_SYMBOL`, first detail = header message, not in the document, cap of 500 with every emission counted), `analysis` returned; point orientation from object angles (§3.3, C10): a north-oriented symbol with a rotated object turns `object`, a centred disc, an already rotatable symbol and one with no rotated object keep their flag, angles reach the render bridge |
| Unit (shared) | `packages/shared/src/geo/__tests__/projection.test.ts`, `north.test.ts` | §3.8 maths: EPSG lookup, paper ↔ projected (rotation + correction, grid scale factor, round trip), Mapper's reference point on the `e2e/test.xmap` frame, paper ↔ WGS 84, convergence at Nackareservatet (−2.82°) and on a central meridian, paper-north bearing, extent and calibration corners, `mapFileMetadata`; angle folding and the cluster thresholds |
| Unit (shared) | `packages/shared/src/import/__tests__/analyse.test.ts` | `601` / `601.x` codes, grouping per symbol, 5 mm floor scaled by `unitsPerMm`, graphic symbols excluded, georeference fields, un-georeferenced and non-projectable CRSs, same result over the decoded document |
| Unit (shared) | `packages/shared/src/import/__tests__/ocad-symbols.test.ts` | every row of the §3.3 tables: line styles, dashes (507 end gap), shortening without pointed ends and the taper with them (one end, none), framing (also narrower than the main line → negative halo, equal width warned), double lines, main / secondary / corner / start / end symbols (`useSymbolFlags` 1 = end, 2 = start), point elements (circle diameter by OCAD version), area fill / hatch / pattern / border, text mapping, vertical anchor (4 middle, 8 top, 0 absent, other values warned), fonts, text line framing → halo (`frWidth` as half-width, width 0, unknown colour), shadow framing → shadow (offsets, zero offset, unknown colour), rectangle framing → frame (margins, unknown colour; on line text warned), unknown framing warned, tab stops (`nTabs`, zero and non-ascending stops), paragraph indent warned, line text without a warning, a border reference that is missing / not a line / the area itself → `SYMBOL_REFERENCE_INVALID` with the fill kept, rectangle → outline line (`cornerRadiusUm`, grid → `RECTANGLE_GRID_DROPPED`, width 0, unknown colour), warning codes |
| Unit (shared) | `packages/shared/src/render/__tests__/{dash,placement,symbolise}.test.ts` | OCAD end-gap semantics, `dashGroupCentres` / `sectionCentres`, `backgroundWidthUm`, continuous halo |
| Unit (shared) | `packages/shared/src/map-document/__tests__/codec.test.ts`, `projection-bridge.test.ts` | encode/decode round trip, Hilbert order, validation errors, truncation, JSON projection, render bridge |
| Unit (shared) | `packages/shared/src/import/__tests__/{colour-class,fingerprint,matcher,colour-align,match-document}.test.ts` | stages 6–7: CMYK / name classification, fingerprints and tolerances, every matcher stage and the traps (reused numbers, template variants, old numbering), factor detection (lines / codes / scale / override), alignment steps and conflicts, whole-document run with codec round trip and canonical drawing through the bridge |
| Unit (api) | `packages/api/src/__tests__/import-ocad.test.ts` | reader → document on `e2e/test.ocd`, determinism, bboxes, all fixture symbols converted (the framed 603 text with its white halo, the 850.1 rectangle as an outline), symbolise without proxies, fixture matches (4 auto incl. 603.b, old-numbered ring and the rectangle suggested, factor by `codes`), `readerWarnings` and `warningDetails` in the report only when non-empty, stack with inserted lower purple, hook renders against the source table; the symbol-types fixture (`buildSymbolTypesOcad`) through reader → document → stage: a framed, justified formatted text wrapped in its box with its frame fill, a line text with an angle per glyph (B8); stage 5: grid 13002 → EPSG:3006 with no `declinationDeg`, the same 12-line meridian cluster as the legacy probe, report `georeference` / `north` with WMM fields at `asOf` agreeing with `detectMapNorth`, raster-path and pin columns identical (correction 0 and 11) |
| Unit (api) | `packages/api/src/__tests__/import-omap.test.ts` | reader → document on `e2e/test.xmap`: determinism across `importOmapToDocument` / `importMapToDocument`, provenance (`omap-7`, version 9, UTM 33N), `warningDetails` in the report (the `MISSING_SYMBOL` stub with its index, the dropped templates), bboxes, all 21 fixture symbols and the 702 alignment variant rendered, symbolise with the dangling symbol as the only drop, factor ×1, import report, kind sniff with BOM, the two kinds kept apart |
| Unit + integration (api) | `map-import-jobs.test.ts` (both) | worker runs a Mapper file by kind with the same hashes as inline; a Mapper source goes through the job to a `done` row with `importer_version omap-7` and a stored report carrying `warningDetails`, and is deduplicated on the second job; garbage of either kind fails cleanly; the pin writes the quick-access columns equal to the raster path's, recomputes them with a row's `rotation_correction` idempotently, and leaves them alone for a document without a CRS |
| Unit (api, unchanged) | `map-north.test.ts`, `map-projection-correction.test.ts`, `map-coordinate-transfer.test.ts`, `course-import-align.test.ts` | the legacy modules as adapters over `mapGeo` keep their behaviour |
| E2E | `e2e/map-gl-doc.spec.ts` | document path = reader path in the browser, native `.oxvm` round trip, `mode=source` draws the fixture from its own definitions with no proxies; `e2e/test.xmap` loads client-side with no OCAD reader, draws, and surfaces the OMAP warning codes |
| Unit (shared) | `packages/shared/src/import/__tests__/decisions.test.ts` | club decisions and review rows (`docs/map-symbols.md` §8.5), stage 6 with decisions: other library ignored, older release applied |
| Unit + integration (api) | `map-symbol-decisions.test.ts`, `integration/map-review.test.ts` (see `docs/map-storage.md` §10) | the review round: decision writes and validation, worker applying a snapshot, `review` / `decide` / `finalise` |
| Unit (shared) | `packages/shared/src/import/__tests__/crt.test.ts` | the CRT codec (`docs/map-symbols.md` §8.6): Mapper's grammar, Oxygen's comments, resolution and its warning codes, unchanged auto matches, round trip |
| Unit + integration (api) | `map-crt.test.ts`, `integration/map-crt.test.ts` (see `docs/map-storage.md` §10) | `exportCrt` / `importCrt`: file name, plan on the fixture, decide's cap, the procedures end to end |
| Unit + integration + E2E (api, web) | see `docs/map-storage.md` §10 | stages 1 and 9: chunked upload route, import jobs, store, dedup, pins, report row, delivery route |
| Unit + integration + E2E (api) | see `docs/map-storage.md` §10 (previews rows) | stage 10: thumbnail row written by the job and by the dedup short-cut, non-fatal failure, object cap |
| Script (scripts) | `scripts/__tests__/ocad-fixture.test.mjs` (`pnpm test:scripts`) | the OCAD fixture writer: `e2e/test.ocd` byte-identical on regeneration, its framed text and rectangle read back by the reader; the symbol-types file (`buildSymbolTypesOcad`, also the fork's `test/data/symbol-types.ocd`) read back field by field — text framing, line text, rectangles with radius and grid; the stale-border file (`buildStaleBorderOcad`: an area whose border is itself, one whose border is missing) read back |
| Reader (fork) | `open-orienteering/ocad2geojson` `test/reader.test.js`, `test/svg.test.js` (`npm test`) | text framing on the real `fences.ocd` (902.1: mode 2, colour 12, width 10) and every new field on `symbol-types.ocd`; `ocadToSvg` reads but does not draw line-text and rectangle objects |
| Script (scripts) | `scripts/__tests__/measure-import.test.mjs` (`pnpm test:scripts`) | `scripts/measure-import.mjs` over the two fixtures: hashes written and found again in a second process, a changed hash fails as a determinism failure, the Mapper fixture's four unsupported-primitive codes fail the run and print their per-emission detail, a stale area-border reference is reported per symbol (`~`) without failing the run, usage errors exit 2 |

**S0 corpus check** (09 §7: the whole corpus and every OMAP construct in
the sample set, deterministically). `scripts/measure-import.mjs` runs
every `.ocd` / `.omap` / `.xmap` in the given directories through the
import worker's path (`importMapToDocument` with no decisions, then
`buildImportReport`) and prints per map the document hash,
`format.importer`, library version, counts, the warning-code histogram,
symbol and object matching outcomes and the report's `georeference` /
`north` fields (§3.8). It exits non-zero on an import error, on any
*unsupported-primitive* warning — a source construct the document drops or
approximates — and, with `--previous`, on any document hash that differs
from that run's. Which codes those are is the classification below
(`mapImport.WARNING_CLASS` in `packages/shared/src/import/report.ts`; the
script reads it, so the table, the gate and `report.test.ts` cannot drift).
Source data errors are reported, listed per symbol from the report's
`warningDetails` (`~` lines, with the symbol index), and do not fail the
run; the unsupported ones are listed the same way (`!` lines).

| Class | Codes | Meaning |
|---|---|---|
| `unsupported` | `SYMBOL_TYPE_UNSUPPORTED`, `SYMBOL_FEATURE_DROPPED`, `UNKNOWN_OBJECT_TYPE`, `IRREGULAR_PATTERN_REGULARISED`, `COLOUR_OPACITY_IGNORED` | a source construct the document cannot represent (the gate). `TEXT_VERTICAL_ALIGNMENT_DROPPED` and `TEXT_ALIGNMENT_PER_OBJECT` were here until `omap-5` (A13), which imports both alignments (§4.4); `TEXT_BOX_DROPPED` until `omap-7` (B8), which imports the box (§4.2) |
| `by-design` | `TEMPLATES_DROPPED`, `LAYOUT_OBJECTS_DROPPED`, `OBJECT_TAGS_DROPPED`, `PARTS_MERGED`, `HELPER_SYMBOLS_HIDDEN`, `RECTANGLE_GRID_DROPPED` | dropped on purpose |
| `source-error` | `SYMBOL_REFERENCE_INVALID`, `MISSING_SYMBOL`, `DUPLICATE_SYMBOL_NUMBER`, `SYMBOL_COLOUR_UNKNOWN`, `SYMBOL_EMPTY`, `EMPTY_GEOMETRY_DROPPED`, `EMPTY_TEXT_DROPPED`, `MAP_SCALE_MISSING`, `CRS_UNRESOLVED` | the file is inconsistent; nothing is missing from the document that the file defines |
| `substitution` | `FONT_SUBSTITUTED` | a font was replaced |
| `outcome` | `SYMBOL_UNMATCHED`, `SYMBOL_SCALE_ANOMALY`, `DECISION_UNKNOWN_ENTRY`, `COLOUR_ORDER_CONFLICT`, `COLOUR_UNCLASSIFIED`, the `CRT_*` codes | a matching, colour-stack, decision or CRT result |
| `reader` | `READER_WARNING` | reader noise (texts in `readerWarnings`) |

A new warning code gets a row in this table and an entry in `WARNING_CLASS`
in the same change; `report.test.ts` fails otherwise.

```bash
node scripts/measure-import.mjs .local/corpus <omap-dir> --out .local/s0/run.json --hashes .local/s0/hashes.json
node scripts/measure-import.mjs .local/corpus <omap-dir> --previous .local/s0/hashes.json
```

`--hashes` writes only `{name, documentHash, importer, libraryVersion}`
keyed by the source file's SHA-256 (`map_sources.file_hash`) — no
georeference — so it can be carried to a second machine and passed as
`--previous` there (maps match by file hash, then by name). Neither the
maps nor the JSON files are committed (AGENTS.md §12); keep them under
`.local/`, since `--out` carries each map's WGS 84 origin and extent.

**Against production.** The same comparison works against what Cloud
Run produced from the same files, once the instance runs the same
importer and library versions (`ocad-12` / `omap-6`,
`*@<SYMBOL_LIBRARY_VERSION>`) and only for documents imported without
club decisions (stage 6 applies them, so a reviewed map has a different,
equally correct hash). Either list the stored documents:

```sql
select s.file_hash, s.file_name, d.hash, d.importer_version, d.library_version
from oxygen.map_documents d
join oxygen.map_sources s on s.file_hash = d.source_hash
order by s.file_hash, d.created_at;
```

and compare `(file_hash, hash)` with the `--hashes` file; or, signed in
as an admin, `GET https://<instance>/api/map-documents/<documentHash>`
for each local document hash — `?event=<eventId>` for a map only an
event pins (club-library versions pass without it, `docs/map-storage.md`
§4.2). A 200 means production holds byte-identical output for that file;
a 403 does not distinguish "no such document" from "not visible to you",
so only the 200 is evidence. The 2026-10-20 run over
the five OCAD corpus maps and the three OOM sample `.omap` files is in
the research decision log ("S0 corpus check"): deterministic, zero
import errors, 48 unsupported-primitive warnings. The `ocad-7` re-run
(decision log, "A12") has 36, none of them a text line framing or an
unparsed symbol type. The `ocad-10` / `omap-4` run (A14) has 30: the six
stale area-border references moved to `SYMBOL_REFERENCE_INVALID`
(Club-full 10 → 4 unsupported); the 30 left were all row A13's. The
`ocad-11` / `omap-5` run (A13, 2026-10-22) has **0** — the S0 zero-warning
criterion is met on the corpus: shadows (Club-2026 815.2, Club-full 825.1),
vertical anchors (Club-full 802.6 / 802.7, Crop-A / Crop-B 901.0 / 902.0, OOM
Course_Design's 18 middle-anchored texts, lifted onto their four symbols
without variants), Club-full 850.1's corner radius, Crop-A / Crop-B 503.1's
narrow framing and OOM ISOM 502.2's second border pair are imported; 0 import
errors, 8/8 hashes reproduced by a second run; symbol and object match
outcomes identical to the `ocad-10` / `omap-4` run on every map. (The
fixture `e2e/test.xmap` keeps one translucent colour, so the gate still
fails on it by design; its text box is imported since `omap-7`, B8.)

## 8. Pending in this chapter

The S0 hash comparison on a second machine (re-run on
`ocad-7`). The line-text struct (§3.3) is
*provisional* until a real OCAD file with line text is seen. S2 confirmation of the *provisional* §3.3 rows against OCAD output,
event / club map *apply* for Mapper sources (needs slice C, §2.2), stage 5 fonts used (fallback decisions)
and feature usage (03 §6.8 table) — 06 §4.4's `fonts` / `features`
report sections; the `proj4-match` CRS method for PROJ.4 specs neither
parse nor the grid table knows. Each lands with its own section here and
its own tests.
