# 06 — Import pipeline

Status: proposed 2026-10-07 (recommendation §12); awaiting decision.
Depends on: [02](02-document-format.md) (the document the importer
produces; identity by hash; `sourceIndex`), [03](03-symbol-model.md)
(normalisation into the IR, staged matching, `SymbolMatch[]`, review),
[04](04-render-core.md) (reference raster for previews; font fallback is
an import decision), [05](05-print-pdf.md) (nothing new; consumes the
document). Feeds: 07 (what is stored and how it is keyed), 08 (club
symbol decisions, course alignment after re-import), 09 (migrating
today's `map_files` / `club_map_files` rows).

## The question

Topics 02–05 define what a map document is and how it is drawn. This
topic decides how one comes into existence and how it changes:

1. **Readers.** Which source formats, which versions, with which code —
   and how both OCAD and OpenOrienteering Mapper (OMAP) files become the
   *same* document with the same flag bits, symbol IR and georeferencing
   block.
2. **The pipeline.** The stages from upload to a stored, content-addressed
   document; where each runs; what is deterministic; what the importer
   version means.
3. **Review.** The contract between the matcher (03 §6.5) and a review
   UI: the import report, previews, decisions, and where decisions live so
   a club does not redo them for every version of its map.
4. **Versioning and re-import.** Club maps get new editions every year;
   events pin a version; course geometry and layout objects reference map
   objects. What happens on re-import, and what "update to the latest
   map" means.
5. **Caching and delivery.** Immutable documents on the server and in the
   PWA; what replaces `render_key`, tiles and preview PNGs.
6. **Transport and limits.** The current base64-over-tRPC upload cannot
   carry the largest corpus map.

## 1. Requirements, by consumer

| Consumer | Needs from the import pipeline |
|----------|-------------------------------|
| Course setter (event) | Upload an `.ocd` or `.omap/.xmap`, see the map within seconds, be told clearly what was dropped or guessed (fonts, unsupported features, unmatched symbols), and be able to ignore the review when the defaults are fine. Replace the map later without losing the courses. |
| Club map manager | Keep a library of maps with versions; review symbol matching once per map and have it carry over to the next edition; set the colour profile, north options, rotation correction once; see which events use which version. |
| Renderer / PDF (04, 05) | A document that decodes in < 10 ms (event maps) with every object, flag bit, symbol IR entry, colour and match in place; no reparse of the source at render time. |
| Course import and alignment (`course-import-align.ts`, Purple Pen / IOF XML / OCAD course files) | The same georeference block and the same paper coordinate system as the base map so controls land where the mapper drew them; a stable `sourceIndex` so references survive re-import. |
| Review UI (web) | A report with counts and categories; per-symbol proposed match, confidence, reasons; a preview image of the source symbol and the candidate; accept / choose another / leave unmatched; export/import of decisions as CRT (03 §9 point 5). |
| Offline (PWA) | Documents cacheable forever by hash; the event's current document fetched once and kept; no server call needed to draw. |
| Tests | Every corpus map imports with zero errors and a stable warning set; synthetic fixtures for every flag and symbol feature; deterministic output (same bytes + same versions → same hash). |
| Operations | Import of a 37 MB club map must not block the event loop or exhaust memory; progress visible; failures diagnosable from the report; the original file retained for re-import when the importer improves. |

Out of scope: the OCAD *export* (02 §1 lists it as a requirement on the
document; the writer is a later topic), course import itself (08), and
object storage versus Postgres (07).

## 2. Current state, and what to keep

```
uploadMap(fileName, fileDataBase64)  — tRPC, 50 MB body limit
  → applyEventMap: readOcad (ocad2geojson fork) → resolveMapNorth
      (detectMapNorth, probeMeridianLines) → metadata (scale, WGS 84 bounds,
      northOffset, 4-corner calibration) → map_files row (blob + columns)
      → delete rendered_maps, gcOrphanTiles, fireMapUpload
      → synchronizePositionedControlCoordinates, rebuildCourseGeometry (editor courses)
clubMap.upload → same + renderOcadPreview (PNG) → club_map_files row
course.useClubMap → copies the blob into map_files (fromClubLibrary = true), carries
      rotationCorrection / colorProfile / colorOverrides / northLinesBelow along
```

Keep:

- **North handling** (`map-north.ts`, `map-projection.ts`): the ScalePar
  georeference is authoritative, `rotation_correction` is an operator
  override, meridian-line detection is diagnostic, `northOffset` is a
  display bearing. All of it moves to operate on the *document* instead
  of the parsed OCAD object and is otherwise unchanged (02 §5 keeps these
  outside the document deliberately).
- **The re-import side effects**: re-synchronising control WGS 84 from
  paper coordinates, rebuilding editor course geometry, bumping
  `overprintCutsVersion`. These are the "references survive a new map"
  mechanics and stay, re-keyed to `(documentHash, objectIndex)` where they
  reference map objects.
- **Club library → event copy semantics** (club maps stay club property;
  the event gets a reference it cannot download without admin rights).
- The 4-corner `calibration` and `bounds` columns as quick-access
  metadata, now derived from the document header.

Change:

- **Transport.** Base64 inflates by 33 %; Club-full (35.9 MB) becomes
  48 MB of JSON and a 37 MB `.ocd` would exceed the 50 MB `bodyLimit`.
  The upload becomes a binary route (§8).
- **Parse-per-use.** `course.mapMetadata` backfills by reparsing, the tile
  renderer reparses per cold block, PDF reparses per window with an LRU.
  After import nothing parses the source again; consumers decode the
  document.
- **`render_key`, tiles, `preview_png`, `rendered_maps`**: replaced by the
  document hash and content-addressed thumbnails (§7).
- **Synchronous import inside the mutation.** The event loop is held for
  the whole parse (257 ms for Club-full is fine; a full encode + match is
  not). Import becomes a job in a worker thread with a status endpoint
  (§4.5).

## 3. Sources

### 3.1 OCAD

- **Reader**: `ocad2geojson` fork, `readOcad` — binary reader for format
  versions 10, 11, 12 and 2018 (per-version structs for symbols and
  objects; `version < 10` rejected). The whole corpus is version 2018.
  OCAD has written the year as the version number since 2018; an **OCAD
  2024** file is expected to carry `2024` and reuse the 2018 structures,
  but the reader's version tables stop at 2018 — the first import task is
  to obtain a 2024-saved file and add the entry (or confirm the format is
  byte-identical). The reader is CommonJS JavaScript in the fork we
  already maintain; it can be ported to TypeScript inside
  `@oxygen/shared/import` when the fork reference is dropped (AGENTS.md
  §14), but that is not on this topic's path.
- **What is read**: file header, symbol index (point/line/area/text/
  rectangle/line-text symbols with the fields 03 Appendix C maps), object
  index (type, symbol, angle, coordinates with the 8 flag bits, text,
  status), string index (parameter strings — 1039 ScalePar for
  georeferencing, colours, 8 templates, course-setting strings,
  layout/zoom strings).
- **Dropped with a warning** (02 §9 point 1): templates/background
  images, layout objects (OCAD 2018+ layout layer), editor state, course
  setting *strings* (courses drawn as objects in the map file are kept as
  ordinary objects; 08 may hide 7xx symbols by default), icon bitmaps.
- **Kept but flagged**: hidden symbols (status) and the objects using
  them, so the viewer can hide them and the review can show them;
  graphic/image objects (`sym` −2/−3) with their own colour/width.

### 3.2 OpenOrienteering Mapper (`.omap`, `.xmap`)

- **Format**: XML, namespace
  `http://openorienteering.org/apps/mapper/xml/v2`, format `version`
  attribute (current 9, Mapper 0.9; minimum readable by Mapper 2). `.omap`
  is the compact form, `.xmap` the pretty-printed identical form. Both
  are plain text (no compression). Elements, in stream order (Mapper uses
  a streaming reader, so order matters for our reader too): `notes`,
  `georeferencing`, `colors`, `barrier` (a compatibility wrapper around)
  `symbols`, `parts` → `part` → `objects` → `object`, `templates`,
  `view`, `print`, `undo`/`redo` (dropped).
- **Coordinates**: integers in **0.001 mm** (`unitsPerMm = 1000`, vs
  OCAD's 100). In the compact form `<coords count="N">x y [flags];…</coords>`
  with flags omitted when zero; verbose form `<coord x y flags/>`. The
  normaliser must verify the y-axis direction against Mapper's own OCD
  importer (it negates y when reading OCAD, so OMAP y grows downward) and
  flip to the document's y-up.
- **Flags** (`MapCoord::Flag`): `CurveStart 1`, `ClosePoint 2`,
  `GapPoint 4` (internal, never expected in files), `HolePoint 16`,
  `DashPoint 32`. Differences from OCAD that the normaliser resolves:
  - *Bézier*: `CurveStart` marks the first of four points; OCAD marks the
    two control points (bits 1 and 2). Convert by marking the two
    following points.
  - *Holes*: Mapper marks the **last point of the previous ring**; OCAD
    marks the **first point of the hole** (bit 16). Shift by one.
  - *Closed paths*: an explicit repeated last point with `ClosePoint`;
    OCAD closes implicitly for areas and by coincident end points for
    lines. Drop the repeated point, set the object's closed flag.
  - *Dash point*: Mapper has one flag for what OCAD splits into corner
    (4) and dash (8) points; the symbol decides (03 `DashPattern.layout:
    "omap"`). Map to OCAD bit 8 and let the OMAP dash layout treat it as a
    section boundary, which is what Mapper does.
- **Symbols**: `point_symbol` (nested `element`s each with its own
  symbol + object), `line_symbol` (the dash fields 03 §3.2 lists,
  `start_symbol`/`mid_symbol`/`end_symbol`/`dash_symbol`, borders,
  `mid_symbol_placement`, `start_offset`/`end_offset`), `area_symbol`
  (fill colour, `pattern` elements for hatch and point patterns with
  clip modes), `text_symbol` (font, size, framing, `rotatable`),
  `combined_symbol` (parts referencing other symbols → one IR symbol
  with several parts, 03 §6.2). Hidden/protected status, `icon`
  bitmaps (dropped).
- **Colours**: `priority` (= draw order), CMYK, `opacity`, spot-colour
  composition and `knockout` — map to 03 `ColourEntry` (opacity < 1 is
  recorded and warned; the renderer treats colours as opaque, 04 §6.8).
- **Georeferencing**: `scale`, `grid_scale_factor`, `declination`,
  `grivation`, `ref_point` (map 0.001 mm) + `projected_ref_point`,
  `geographic_ref_point` (lat/lon), `projected_crs id="EPSG|UTM|
  Gauss-Krueger|PROJ.4|Local"` with a `spec` (PROJ.4 string) and
  `parameter`s. Map to 02 §5: `crs` from the EPSG id when given, else by
  matching the PROJ.4 spec against the grid table (`crs-grids.js`
  already lists Swedish and common grids with their PROJ.4 forms), else
  `null` with a warning; `paperOrigin` from the two reference points;
  `gridRotationDeg` from `grivation`; `gridScaleFactor` as is. `Local`
  → not georeferenced.
- **Parts**: several map parts are merged in part order with a warning
  (Oxygen has no part concept; mappers use parts as layers).
- **Templates** (background rasters, GPX): dropped with a warning,
  listing the file names so the user knows what the map depended on.
- **Object tags** (`<tags>` key/value): kept as object attributes
  (02 has room for attributes; cheap, and OOM-centric clubs use tags).

### 3.3 One normaliser, two readers

```
.ocd ──► ocadReader ──► SourceModel ─┐
                                      ├─► normalise() ─► Document (02) + Report
.omap/.xmap ─► omapReader ─► SourceModel ┘        │
                                                  ├─ symbols → IR (03 Appendix C)
                                                  ├─ coords → int32 + OCAD flag bits, y-up
                                                  ├─ colours → ColourStack seed
                                                  ├─ georef → 02 §5 block
                                                  └─ warnings per dropped/approximated thing
```

`SourceModel` is a thin, format-flavoured in-memory model (what the
readers already produce today); the **normaliser** is where every
format difference above is resolved, once, with a fixture per rule
(§9). After `normalise()` nothing downstream knows which format a
document came from except the `format.source` header field and the
`layout: "ocad" | "omap"` tag on dash patterns.

## 4. Pipeline

### 4.1 Stages

```
 1 receive      binary upload → temp file / Buffer; sha256 → fileHash
 2 detect       magic bytes 0x0CAD → OCAD; "<?xml" + Mapper namespace → OMAP; else reject
 3 parse        reader → SourceModel            (Club-full: ~260 ms)
 4 normalise    SourceModel → objects, source symbols (IR), colours, georef, warnings
 5 analyse      bounds, north detection (meridian lines), fonts used → fallback decisions,
                feature usage (03 §6.8 table), object/coord counts
 6 match        03 §6.5 staged matcher against the canonical library → SymbolMatch[] + reasons
                (+ pre-applied club decisions, §5.3)
 7 align        colour stack alignment (03 §6.3) → ColourStack, conflicts flagged
 8 encode       02 codec: Hilbert order, attrs/bboxes/geometry sections, header → bytes; sha256 → documentHash
 9 store        map_documents(hash) if new; link from map_files / club_map_versions; report row
10 derive       thumbnail via reference raster (04); metadata columns from header
```

Stages 3–8 are pure functions in `@oxygen/shared/import` over bytes and
the library; they run identically in Node and in a browser worker.
Stages 1, 2, 9, 10 are API code.

### 4.2 Two hashes, two kinds of input

02 §7 lists the inputs that change the document hash: source bytes,
importer version, library version, review decisions. Separate them:

- **Source document** = `f(fileBytes, importerVersion)` — stages 3–5.
  Deterministic from the file alone. Cached by `(fileHash,
  importerVersion)` so re-matching after a review does not reparse.
- **Final document** = `g(sourceDocument, libraryVersion, decisions)` —
  stages 6–8. This is what `documentHash` identifies and what the
  renderer loads. A review round produces a new final document (cheap:
  matching + encoding, < 100 ms for event maps, ~1 s for Club-full) and
  the previous one is garbage-collected when unreferenced.

Documents stay immutable and content-addressed as 02 decided; reviews
iterate without reparsing; and "same file, same importer, same library,
same decisions" gives the same bytes on every machine, which is what the
determinism test (§9) asserts.

### 4.3 Importer version

`format.importer` is a semver-like string bumped whenever stages 3–8
would produce different bytes for the same input: a reader fix, a
normaliser rule change, the codec, the matcher's thresholds, the
library edition. On deploy, 09 decides whether stored documents are
re-imported eagerly (background job over `map_files`) or lazily on first
use; either way the original file is still there (`map_files.file_data`,
02 §8) and the re-import re-resolves external references via
`sourceIndex` (02 §7).

### 4.4 Report

Produced by stages 3–7, stored with the document link, shown by the
review UI, and the thing tests assert on:

```ts
interface ImportReport {
  source: { kind: "ocad" | "omap"; version: string; fileName: string; bytes: number; fileHash: string };
  counts: { objects: number; drawn: number; hiddenSymbolObjects: number; symbols: number; colours: number; coords: number; bezierObjects: number };
  georeference: { crs: string | null; method: "epsg" | "proj4-match" | "none"; gridRotationDeg: number } ;
  north: NorthDetection | null;                       // today's structure, unchanged
  fonts: { name: string; objects: number; substitutedBy: string | null }[];
  features: { feature: string; symbols: number; objects: number; supported: "yes" | "approximate" | "warn" }[];   // 03 §6.8 rows
  dropped: { what: string; count: number; detail?: string[] }[];   // templates, parts merged, layout objects, …
  matching: { auto: number; suggested: number; unmatched: number; reviewed: number; conflicts: number };
  colourStack: { source: number; inserted: string[]; conflicts: { colour: string; reason: string }[] };
  warnings: { code: string; message: string; count: number }[];   // stable codes, not free text
  timings: Record<string, number>;
}
```

Warning codes are stable identifiers (`OMAP_TEMPLATES_DROPPED`,
`FONT_SUBSTITUTED`, `IRREGULAR_PATTERN_REGULARISED`, `COLOUR_ORDER_CONFLICT`,
`SYMBOL_UNMATCHED`, …) so E2E tests and the corpus check can assert on
sets of codes rather than on prose, and so the UI can translate them
(i18n, AGENTS.md §9).

### 4.5 Where it runs

- **Server, in a worker thread.** Stages 3–8 run in a Node
  `worker_threads` worker so the Fastify event loop stays free
  (the tile renderer learned this the hard way, `map-tile-rendering.md`
  "Keeping the event loop free"). The job is tracked in memory with a
  status endpoint; the client polls (or subscribes, if a push channel
  exists by then). One job at a time per instance is enough.
- **Browser, later.** The same stages can run in the PWA for an instant
  local preview before upload, or for fully offline import of a club map
  onto a device — not phase 1, but the reason stages 3–8 have no Node
  APIs.

## 5. Review contract

### 5.1 API sketch

```
mapImport.start({ scope: "event" | "club", fileName, uploadId })      → { jobId }
mapImport.status({ jobId })                                           → { stage, progress, report?, documentHash?, error? }
mapImport.review({ documentHash })                                    → { symbols: ReviewRow[], stack: ColourStack, report }
mapImport.decide({ documentHash, decisions: SymbolDecision[] })       → { documentHash: newHash, report }
mapImport.finalise({ documentHash, target })                          → links the document to the event / club map version
mapImport.exportCrt({ documentHash }) / importCrt({ documentHash, crt })
GET /api/map-documents/:hash                                          → bytes, immutable
GET /api/map-documents/:hash/thumbnail.png                            → reference raster
GET /api/map-documents/:hash/symbols/:idx.png                         → source symbol preview (reference raster, 04)
GET /api/library/:libraryId/:code.png                                 → canonical symbol preview
```

```ts
interface ReviewRow {
  symbolIdx: number; code: string; name: string; type: "point" | "line" | "area" | "text";
  objects: number;                              // usage count — sort by this; unused symbols are collapsed
  match: SymbolMatch | null;                    // 03 §6.5: canonicalId, confidence, method, reasons, reviewed
  candidates: { canonicalId: string; confidence: number; reasons: string[] }[];   // top 3
  colourClass: string;                           // from the source colour → palette mapping
  flags: ("hidden" | "unused" | "club-symbol" | "text")[];
}
type SymbolDecision =
  | { symbolIdx: number; accept: string }       // canonicalId
  | { symbolIdx: number; unmatch: true }
  | { symbolIdx: number; reset: true };         // back to the matcher's proposal
```

Accepting the defaults is a no-op: `finalise` on the matcher's output.
The review is optional for event maps and expected for club maps.

### 5.2 Previews

Symbol previews come from the reference raster backend (04 §4.1), which
renders one `RenderSymbol` in isolation on a neutral swatch: a point
symbol at 3× magnification, a 30 mm line sample with a corner and a dash
point, a 15 × 15 mm area sample, a text sample. Both source and canonical
previews are produced by the same code, so the reviewer compares like
with like. Content-addressed and cached forever
(`(documentHash, symbolIdx)` / `(libraryVersion, code)`).

### 5.3 Where decisions live

Decisions must outlive a single document — next year's edition of the
same club map has the same symbols. Store them as **club symbol
decisions**, keyed by a *symbol fingerprint* rather than by document:

```
club_symbol_decisions(
  fingerprint TEXT,          -- hash of (source kind, code, type, geometry fingerprint from 03 §6.5)
  canonical_id TEXT NULL,    -- null = explicitly unmatched
  library_version TEXT,
  decided_by, decided_at,
  PRIMARY KEY (fingerprint, library_version)
)
```

Stage 6 applies them before the matcher runs (03's "explicit CRT" stage
is exactly this: decisions are CRT rows with a fingerprint instead of a
file-local code). The matcher's own output never writes this table; only
`decide` does. CRT export emits the decisions in OOM's CRT syntax (with
the fingerprint in a comment) so a club can carry them to Mapper, and CRT
import maps codes to fingerprints via the current document. 03 §10's
question "where do per-club mappings live" is answered: here, in 07's
schema.

## 6. Versioning and re-import

- **Club maps become a series with versions.** Today `club_map_files` is
  one row per upload with no relation between editions. Proposal (schema
  in 07): `club_maps(id, name, settings…)` and `club_map_versions(id,
  club_map_id, file_hash, document_hash, label, uploaded_at)`. Settings
  that are about the *map*, not the file — colour profile, north-lines
  option, rotation correction, symbol decisions — live on the series and
  apply to every version.
- **Events pin a version.** `map_files` keeps one row per event but
  references `club_map_version_id` (or its own upload) and the
  `document_hash`. "Update to the latest version" is an explicit action
  that runs the re-import side effects (§2 keep list) and reports what
  moved.
- **Re-import of the same file** (importer or library upgrade) keeps
  `sourceIndex` per object, so `(documentHash, objectIndex)` references
  in course layers and layout objects are re-resolved exactly. A **new
  edition** of the map has no `sourceIndex` correspondence; references
  are re-resolved by *position and symbol* (nearest object of the same
  symbol within a tolerance) and flagged for review when nothing is
  found — the same policy 02 §7 states, with the tolerance decided in 08
  where the referencing objects are defined.
- **Course geometry** is in paper coordinates of the map and does not
  reference objects; it survives any re-import unchanged, as today. The
  overprint cut list (`overprintCutsVersion`) is recomputed, as today.

## 7. Caching and delivery

- **Documents are immutable**: `GET /api/map-documents/:hash` with
  `Cache-Control: public, max-age=31536000, immutable`, `ETag = hash`,
  byte-range support (01 Option C needs nothing else later). The service
  worker caches by URL; the event's current hash comes from
  `course.mapMetadata` as `documentHash` (replacing `renderKey`).
- **Server memory**: an LRU of decoded documents (02 decode is < 10 ms
  for event maps, 30 ms for Club-full, so the cache is a convenience for
  PDF bursts, not a necessity). Symbolised pass streams for print windows
  are not cached — they are cheap and window-specific.
- **Thumbnails and previews**: content-addressed PNGs from the reference
  raster, generated at import (stage 10) and on demand for symbol
  previews; stored next to the document (07 decides table vs object
  store). `preview_png` on `club_map_files` is replaced.
- **Retired**: `map_tiles`, `rendered_maps`, `render_key`, the tile
  render queue and pre-caching progress poll (09).

## 8. Transport and limits

- **Binary upload route** `POST /api/map-upload` (multipart or raw
  `application/octet-stream`, `x-event-id` as today), streamed to a temp
  file, limit 128 MB (Club-full is 36 MB; OCAD files with embedded
  bitmaps in symbol icons stay below this), returns `{ uploadId,
  fileHash, bytes }`. `mapImport.start` then references the upload. The
  tRPC `uploadMap(fileDataBase64)` is kept for one release for E2E and
  small files, then removed (09).
- **Progress**: byte progress from the browser's upload, stage progress
  from the job status.
- **Dedup**: if `fileHash` already has a source document for the current
  importer version, stage 3–5 are skipped (a club re-uploading the same
  file to a second event is common).

## 9. Tests

| Tier | What | Where |
|---|---|---|
| Normaliser unit tests | One fixture per rule in §3.2 (Bézier flag conversion, hole shift, close point, dash point, y flip, units, georef from EPSG / PROJ.4 / Local, parts merge, combined symbol → IR), one per OCAD field in 03 Appendix C | `@oxygen/shared/import/__tests__` |
| Synthetic OCAD fixtures | Extend `scripts/generate-test-ocd.mjs` (which already produces `e2e/test.ocd` without real-map metadata, AGENTS.md §12) to emit every object type, every flag bit, holes, each symbol feature of 03 §6.8, hidden symbols, graphic objects, and both a georeferenced and a local file. Checked-in `.vmap.json` projections (02 §6) as golden output | `packages/shared/src/import/__fixtures__/` |
| Synthetic OMAP fixtures | A small generator in the same script family writing format-9 `.xmap` with the same coverage; plus OOM's ISOM/ISSprOM `.omap` symbol sets as a *read-only oracle* for symbol conversion (03 §10 — fetch in CI from a pinned commit, do not ship) | same |
| Determinism | Import each fixture twice in separate processes; `documentHash` equal; import with a bumped `importerVersion` → different hash, same `sourceIndex` mapping | unit |
| Corpus check (local, not CI) | `measure-import.mjs` next to the other `.local` scripts: import all six corpus maps; assert zero errors, print the warning-code histogram and matching counts; diff against the previous run | `.local/research/oxygen-measurements/` |
| Integration | Job lifecycle (`start` → `status` → `review` → `decide` → `finalise`), dedup by `fileHash`, club decisions applied on a second version, GC of unreferenced documents, "update to latest" re-resolution | `packages/api/src/__tests__/integration/` |
| E2E | Upload `test.ocd` and a `test.xmap`, see the map, open the review, accept a suggestion, export, re-upload the same file (dedup message), replace with a modified fixture (references re-resolved) | `e2e/map-import.spec.ts` |

## 10. Options

| Option | Readers | Verdict |
|---|---|---|
| **A. Keep the OCAD reader from the fork; write an OMAP reader; one shared normaliser** | `readOcad` (proven on the corpus, maintained by us) + ~600 lines of streaming XML → `SourceModel` | **Recommended.** Smallest step; the normaliser is where the design lives and is format-neutral from day one. |
| B. Port the OCAD reader to TypeScript now | Own code in `@oxygen/shared/import` | Right eventually (dropping the fork, browser import without a CJS bundle), wrong now: ~2 k lines of porting with no user-visible gain; do it when the fork reference goes. |
| C. OMAP via Mapper's own OCD export (ask users to save as `.ocd`) | OCAD only | Loses OMAP-only fidelity (combined symbols, 0.001 mm precision, PROJ.4 CRS) and makes OMAP clubs second-class; Mapper's OCD export is also lossy for its own features. Rejected. |
| D. Server-side conversion with Mapper headless | Mapper binary in the image | Native dependency, no API for symbol matching, GPL tooling in the runtime image. Rejected. |

## 11. Effort

| Item | Estimate |
|---|---|
| `SourceModel`, normaliser (both formats), flag/hole/unit/y rules with fixtures | 2 weeks |
| OMAP streaming reader (symbols incl. combined, objects, colours, georef, parts, tags) | 1.5 weeks |
| Analyse stage (port north detection/bounds/fonts/features onto the model) | 0.5 week |
| Matcher integration (03), colour alignment, club decisions, CRT import/export | 1 week (matcher itself is 03's estimate) |
| Encode/store/report, job runner in a worker thread, binary upload route, dedup, GC | 1 week |
| Review API + previews via reference raster | 1 week |
| Review UI (web): report page, symbol table with previews and decisions, i18n | 1.5 weeks |
| Club map series/versions, "update to latest", re-resolution | 1 week (schema with 07) |
| Tests (fixture generators for both formats, determinism, integration, E2E) | 1.5 weeks |
| **Total** | **≈ 11 weeks** |

## 12. Recommendation

1. **Two readers, one normaliser** (§3.3, option A): the fork's
   `readOcad` for OCAD 10–2018 (add 2024 after checking a real file),
   a new streaming OMAP reader for format versions 2–9, and a
   format-neutral `normalise()` in `@oxygen/shared/import` that owns
   every flag, hole, unit, axis, symbol and georeference conversion,
   each with a fixture.
2. **Ten-stage pipeline** (§4.1) with stages 3–8 pure and isomorphic,
   running in a Node worker thread as a job with status; the browser can
   run the same stages later.
3. **Two-level identity** (§4.2): source document by `(fileHash,
   importerVersion)`, final document by content hash over source +
   library version + decisions. Reviews re-match and re-encode, never
   reparse.
4. **A structured report with stable warning codes** (§4.4), stored with
   the document, asserted by tests, translated by the UI.
5. **Review API and previews** (§5): optional for events, expected for
   club maps; previews from the reference raster for both source and
   canonical symbols.
6. **Decisions persist per club by symbol fingerprint** (§5.3), applied
   as the matcher's first stage, exportable as CRT.
7. **Club maps as series with versions, events pin a version** (§6);
   same-file re-import re-resolves references by `sourceIndex`, new
   editions by position + symbol with review flags.
8. **Immutable documents by hash** (§7) with long-lived caching on the
   server and in the PWA; `render_key`, tiles, `rendered_maps` and
   `preview_png` retired with 09.
9. **Binary upload route** (§8) with a 128 MB limit, dedup by file hash;
   the base64 tRPC upload kept one release.
10. **Fixture generators for both formats** (§9) and a local corpus
    check as the acceptance gate: zero errors on all six maps.

## 13. Open questions carried forward

- **OCAD 2024 header version and struct changes** — needs a sample file
  (ask a club with a current OCAD licence; none in the corpus).
- **OMAP y-axis** — verify against Mapper's OCD importer before freezing
  the normaliser fixture; a wrong guess here is a mirrored map.
- **Encrypted OCAD exports** ("Export encrypted file", loadable only as
  a background map in OCAD): unreadable by design; detect and reject
  with a clear message.
- **Object tags and attributes** — kept, but 02's attribute section must
  have a string table for them; confirm when the codec is specified.
- **Re-resolution tolerance for new map editions** (§6) — 08.
- **Browser-side import** — when offline club-map import becomes a
  requirement; nothing in the design blocks it.
- **OCAD export writer** (02 §1) — a later topic; the source symbol table
  and flags are preserved precisely so it can be written.
- **GC policy for unreferenced documents** — immediately on unlink, or a
  retention window so an undo of "update to latest" is cheap? 07.
