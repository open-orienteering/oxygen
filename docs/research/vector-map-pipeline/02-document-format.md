# 02 — Map document format

Status: research complete; recommendation in §9 awaits a decision.
Depends on: [01](01-tiling-vs-whole-document.md) (whole-document delivery).
Feeds: 03 (symbol model), 04 (GL renderer), 05 (print), 06 (import).

## The question

What exactly is the artifact that the importer produces, the API stores and
serves, the GL renderer draws, the PDF backend prints, and the OCAD exporter
reads back? This document fixes its content (what is kept from the source
file and what is dropped), its coordinate space, its encoding, and its
identity/versioning rules. It does not fix the canonical symbol library
(topic 03) or the renderer's internal buffers (topic 04); it fixes the
contract between them.

## 1. Requirements, by consumer

| Consumer | Needs from the document |
|----------|-------------------------|
| GL renderer (04) | All objects with geometry in a fixed unit; per-coordinate OCAD flags (Bézier, hole, corner, dash, gap); object type; a symbol reference that resolves to drawing instructions; object rotation; text content and anchors; a global colour order; cheap decode into typed arrays in a worker |
| Print / PDF (05) | Identical content, plus colour definitions in CMYK with names so print profiles can map them; paper extent; hidden-symbol defaults |
| Course editor (08) | Stable object identity for selection, hide/show, whiteouts and edits; the paper↔projected transform so controls (stored in paper mm) and GPS/Eventor data (WGS84) can be reconciled |
| Import review (06) | Source symbol definitions (to render fallbacks and previews), per-symbol match results, warnings |
| OCAD export | Enough of the source to rebuild a plausible `.ocd`: symbol definitions, colour table, parameter strings that affect the map (scale/georeferencing), geometry with flags, text and attributes |
| Course import alignment (`course-import-align.ts`) and Eventor/GPS features | Georeferencing: EPSG code, paper origin in projected coordinates, grid-to-paper rotation, grid scale factor |
| Caching and offline | Content-addressed identity; a single immutable blob; fast validation of version compatibility |
| Tests and tooling | A human-readable projection of the same data |

Non-requirements, decided here:

- Rendering is never baked in. No pre-flattened curves, no tessellation, no
  per-zoom variants, no RGB conversions. The document is a model, not a
  display list.
- Event-level view settings stay out of the document: colour-stack profile
  and overrides (`map_files.color_profile`, `color_overrides`,
  `north_lines_below`), rotation correction, event crops. A document shared
  between a club library and several events must not change when an event
  tweaks its view.
- Templates (background rasters), OCAD layout-layer objects, zoom/bookmark/
  GPS-adjustment parameter strings and symbol icon bitmaps are dropped.

## 2. Inventory of the source: what an OCAD file carries

Measured with `ocad2geojson`'s `readOcad` on the corpus (README). Column
"Keep" is the proposal; §4 argues the non-obvious rows.

### 2.1 Per object (`TObject`)

| Field | Meaning | Observed | Keep |
|-------|---------|----------|------|
| `sym` | Symbol number ×1000 (e.g. `101000` = 101.0); `-2` graphic object, `-3` image object | Club-full: 266 symbols used, 7 graphic objects, 2 objects with symbols missing from the table | Yes; graphic/image objects keep their own colour/width |
| `otp` | Object type: 1 point, 2 line, 3 area, 4 unformatted text, 5 formatted text, 6 line text, 7 rectangle | Club-full: 16 741 / 44 437 / 39 856 / 680 / 13 / 0 / 2 | Yes |
| `ang` | Rotation in 0.1° (point symbols, area pattern angle, text) | 8 % of objects non-zero | Yes |
| `coordinates[]` | `TdPoly`: x, y as 24-bit signed integers in 1/100 mm, y-up, each with 8 flag bits (see §3) | median 6, p90 ≈ 30, max ≈ 3 000 per object; 20–30 % Bézier control points; 689 hole starts in Club-full | Yes, verbatim |
| `text` | UTF-16 text for `otp` 4/5/6 | 693 text objects in Club-full | Yes, as UTF-8 |
| `col` | Colour, meaningful for graphic/image objects | Populated on most objects by the writer, but only meaningful for `sym` -2/-3 | Only for `sym` ≤ -2 |
| `lineWidth`, `diamFlags` | Graphic-object line width; rectangle corner-radius flags | 8 / 1 objects | Only for `sym` ≤ -2 and `otp` 7 |
| `height` | Height attribute (OCAD 2018 "object height") | 259 objects | No (not a drawing attribute) |
| `objectString`, `databaseString` | Course-setting / database payloads | 0 | No |
| `serverObjectId`, dates, `multirepresentationId` | Collaboration metadata | — | No; the object's index in the source file is kept as provenance |

### 2.2 Symbol definitions

268 symbols in Club-full (60 point, 116 line, 61 area, 31 text), 142 symbol
elements in total; serialised as JSON without icon bitmaps they are 276 KB
raw and **15 KB gzipped**. Negligible next to geometry. Fields:

- Common: number, type, status (29 of 268 are **hidden**: course-setting
  7xx/8xx, north lines 601.x, 603.x, 605.x, 705.x, 709.x, 802.x), colours
  used, description, course-setting mode flags.
- Point: elements (line / area / circle / dot) with colour, width, diameter,
  coordinates in 1/100 mm relative to the symbol origin.
- Line: main colour and width, line style (caps/joins), dash model
  (`mainLength`, `endLength`, `mainGap`, `secGap`, `endGap`, `minSym`,
  `distFromStart/ToEnd`), repeated primary symbols (`nPrimSym`,
  `primSymDist`) plus secondary / corner / start / end symbol elements,
  double-line model (mode, flags, fill/left/right colours and widths, dash
  length and gap), framing colour/width/style, taper ("decrease") settings.
- Area: fill colour, hatch (mode 1/2, colour, line width, distance, two
  angles), structure/pattern (mode regular/shifted/irregular with variance
  and minimum distance in OCAD 12+, width/height/angle, elements), border
  symbol reference.
- Text: font name, colour, size, weight, italic, char/word spacing,
  alignment (left/centre/right/justified × bottom/middle/top), line and
  paragraph spacing, indents, tabs, line-below, framing (mode/style),
  optional point symbol.

Fonts seen: Arial, Arial Narrow, Segoe UI.

### 2.3 Colour table (parameter string type 9)

81 colours in Club-full, 42 in Sprint. Each: number, name (free text,
Swedish in practice: "Svart", "Undre lila", "För asfalt Green 100%"), CMYK
0–100, render order (the position in OCAD's colour table, which is the draw
order), optional spot-colour separations and overprint flag. 8 KB as JSON.
Oxygen's `map-color-stack.ts` already classifies these into above/below
lower purple by CMYK, name and usage.

### 2.4 Parameter strings worth keeping

| Type | Content | Keep |
|------|---------|------|
| 1039 ScalePar | `m` map scale, `g` grid distance, `r` real-world coordinates on/off, `i` grid id (e.g. 13002 = SWEREF99 TM), `x`/`y` paper origin easting/northing, `a` grivation (deg), `b` grid scale factor correction, `d` declination | Yes — this is the georeferencing (§5) |
| 9 Color, 10 SpotColor | Colour table | Yes |
| 1026 PrintPar | Print scale and print window (`L`/`B`/`R`/`T` in mm) | Yes, as informational "print window" (useful default print area) |
| 26 PrintAndExportRectangleList | Named export rectangles | Yes, informational |
| 15 SymTree, 12 Zoom, 17 Bookmark, 19 GpsAdjustPar (487 entries in Club-full), 1024 DisplayPar, 1030 ViewPar | Editor state | No |
| 8 Template | Background raster/vector templates (9 in Sprint) | No; recorded as a warning in import metadata ("map references 9 templates that are not imported") |
| 24 LayoutObjects, 25 LayoutFontAttributes | OCAD 12 layout layer | No |
| 1 CsObject, 2 Course, 3 CsClass … | Course setting | No in the map document; course import has its own path (`ocd-course-parser.ts`) |

## 3. Coordinate space

- **Unit.** Integer paper units with a per-document `unitsPerMm`. OCAD files
  are 1/100 mm (`unitsPerMm = 100`); OpenOrienteering Mapper `.omap` files
  are 1/1000 mm (`unitsPerMm = 1000`). Storing the native unit keeps both
  sources lossless; normalising OMAP down to 1/100 mm would lose precision,
  normalising OCAD up to 1/1000 mm costs ~3 bits per coordinate (~15–20 %
  of the geometry section) for nothing. Consumers convert to floating-point
  millimetres once, at decode.
- **Axes.** x right, y up, origin at the source file's paper origin. No
  y-flip is applied at import. The renderer and the PDF backend both flip
  once in their projection matrix; keeping the source convention makes OCAD
  export and course-coordinate reconciliation trivial (Oxygen controls are
  already stored in OCAD paper mm, y-up).
- **Range.** OCAD coordinates are 24-bit signed (±83 m of paper); OMAP
  coordinates are 32-bit. Int32 covers both.
- **Flags.** One byte per coordinate, bit-compatible with OCAD's low x/y
  flag bits so that import and export are table-free:

  | Bit | OCAD source | Meaning |
  |----:|-------------|---------|
  | 1 | x bit 0 | First Bézier control point |
  | 2 | x bit 1 | Second Bézier control point |
  | 4 | y bit 0 | Corner point (dash/symbol alignment, pattern reset) |
  | 8 | y bit 3 | Dash point |
  | 16 | y bit 1 | First point of a hole (area objects) |
  | 32 | x bit 2 | No left line (double-line / border suppression) |
  | 64 | y bit 2 | No right line |
  | 128 | x bit 3 | Area border line / virtual gap |

  The bits are the input to the renderer's curve flattening, hole
  splitting, dash phase and double-line logic. They are the single reason
  GeoJSON is unsuitable as the primary geometry encoding (§6).

- **Curves** stay as cubic Béziers: an anchor, two control points flagged
  1 and 2, the next anchor. Flattening tolerance is a renderer decision per
  zoom / per output device.
- **Holes** are encoded as OCAD does: one coordinate run per object; a
  coordinate flagged 16 starts a new ring. Rings are not stored separately,
  so a renderer that wants explicit rings splits on the flag in one pass.

## 4. Symbols and colours in the document

Three layers, kept separate because they change for different reasons:

1. **Source symbol definitions** — the OCAD/OMAP symbol table, normalised
   to a source-neutral schema with the same expressive power (units in the
   document's paper unit, colours by number). Always present. They are the
   fallback renderer's input, the import-review preview's input, and the
   OCAD exporter's input. Cost: ~15 KB gzipped.
2. **Canonical symbol matches** (topic 03) — for each source symbol, an
   optional reference to an entry in Oxygen's IOF symbol library
   (`ISOM2017:101`, `ISSprOM2019:502`, …) with match kind and confidence,
   produced at import and reviewable. The renderer prefers the canonical
   definition when a match exists (consistent appearance, spec-exact sizes,
   IOF colour names) and falls back to the source definition otherwise.
   Stored in the document because the match is part of the artifact's
   identity: a re-match produces a new version.
3. **Colour table** — the source colours with number, name, CMYK and draw
   order, plus the import-time IOF classification of each colour
   (`above` / `below` lower purple, with the resolution reason) as a
   **default**. Event-level overrides stay in `map_files` and are applied by
   the consumer. Colours are referenced by number everywhere; RGB for the
   screen is derived by the consumer from CMYK (or from the IOF colour
   name when matched), never stored.

Hidden-symbol status is kept per source symbol as the default visibility.
A consumer may override it (the editor will want to show course-setting
symbols or north lines on demand), and the colour-stack filter for ISOM
601.x north lines keeps working on symbol numbers as today.

## 5. Georeferencing

Carried from ScalePar / OMAP georeferencing, in a source-neutral block:

| Field | Source | Notes |
|-------|--------|-------|
| `mapScale` | ScalePar `m` | Denominator, e.g. 15000 |
| `crs` | ScalePar `i` → EPSG via grid id table; OMAP `<projected_crs>` | `{ authority: "EPSG", code: 3006, name: "SWEREF99 TM" }` or null when the map is not georeferenced |
| `paperOrigin` | ScalePar `x`, `y` | Projected easting/northing of paper (0, 0) |
| `gridRotationDeg` | ScalePar `a` | Grivation: angle from grid north to paper +y, clockwise positive. Observed 0.0 (Club-full, drawn magnetic-north-up without declaring it) and 4.98° (Sprint) |
| `gridScaleFactor` | ScalePar `b` | Usually 1 |
| `declinationDeg` | ScalePar `d` | Informational |
| `realWorldEnabled` | ScalePar `r` | Informational |

Oxygen's `rotation_correction` (operator-set extra grivation for maps that
declare `a = 0` but are magnetic-north-up) and the meridian-line detection
(`north_detection`) are **not** in the document: the first is an operator
decision per map file row, the second is derived and can be recomputed from
the document's 601.x objects. `course-import-align.ts` and the WGS84
conversion keep working from `paperOrigin` + `gridRotationDeg` + `crs`
exactly as they do from `getCrs()` today.

## 6. Encoding options

### 6.1 Candidates

| Option | Description | Verdict |
|--------|-------------|---------|
| **GeoJSON** (+ properties for flags) | Standard, tooling everywhere | Cannot carry Béziers or per-coordinate flags without abusing properties; polygons force explicit rings (OCAD "no left line"/gap flags have nowhere to go); objects become 2–4× larger. Keep GeoJSON for course geometry (already the case), not for the base map |
| **MVT / FlatGeobuf** | Binary geo formats | Tile-oriented (MVT) or GeoJSON-typed (FlatGeobuf); same flag/curve problem; FlatGeobuf's Hilbert-sorted R-tree layout is the one idea worth borrowing (01 §5) |
| **JSON tuples** | `[sym, type, [[x,y,flags]…], extras]` | Zero codec code, readable, Zod-validatable. Largest on the wire (JSON parse also allocates every coordinate as a JS array) |
| **Columnar typed arrays** | Object table + `Int32Array` xy + `Uint8Array` flags, zero-copy views | Near-zero decode cost, but raw int32 compresses poorly: gzipped it is barely smaller than JSON |
| **Delta zigzag varints** | Per object: header varints, then (Δx, Δy, flags) varints relative to the previous coordinate | Smallest by a wide margin; decode is a tight loop into typed arrays |
| **Protobuf / FlatBuffers / MessagePack** | Schema-driven generic codecs | Protobuf packed `sint32` ≈ delta-varint only if deltas are computed manually (then the library adds nothing); FlatBuffers ≈ columnar (poor compression); MessagePack ≈ JSON-sized. All add a dependency and a build step for a format with ~6 record types |

### 6.2 Measurements

Same corpus as 01; `measure-encoding.mjs`. Sizes in MB; compression gzip-6
/ brotli-6; decode = time to flat typed arrays (xy `Int32Array`, flags
`Uint8Array`) in Node 20 on a desktop. "Hilbert" = objects sorted along a
Hilbert curve by bounding-box centre before encoding.

| Map | Objects | Encoding | Raw | gzip | gzip (Hilbert) | brotli (Hilbert) | Decode to typed arrays |
|-----|--------:|----------|----:|-----:|---------------:|-----------------:|-----------------------:|
| Club-full | 101 729 | JSON | 24.0 | 7.53 | 7.19 | 7.30 | 255 ms (`JSON.parse` 226 ms + copy) |
| | | Columnar | 14.6 | 6.90 | 6.52 | 4.98 | 5 ms (+ 80 ms gunzip) |
| | | Delta-varint | **5.1** | **3.60** | **3.53** | **3.43** | 30 ms |
| Club-2026 | 45 884 | JSON | 10.4 | 3.18 | 3.04 | 3.08 | 107 ms |
| | | Columnar | 6.2 | 2.91 | 2.75 | 2.11 | 2 ms (+ 21 ms gunzip) |
| | | Delta-varint | **2.2** | **1.54** | **1.51** | **1.48** | 14 ms |
| Sprint | 10 680 | JSON | 1.90 | 0.62 | 0.59 | 0.59 | 24 ms |
| | | Columnar | 1.21 | 0.60 | 0.56 | 0.44 | 0.5 ms (+ 5 ms gunzip) |
| | | Delta-varint | **0.47** | **0.35** | **0.35** | **0.35** | 7 ms |
| Crop-A | 4 983 | JSON | 0.99 | 0.34 | 0.34 | 0.34 | 13 ms |
| | | Columnar | 0.69 | 0.32 | 0.31 | 0.25 | 0.2 ms (+ 3 ms gunzip) |
| | | Delta-varint | **0.24** | **0.17** | **0.17** | **0.17** | 6 ms |

Observations:

- Delta-varint is **half the size of gzipped JSON** at every scale and still
  gains ~30 % from transport compression, so HTTP `Content-Encoding` does
  the rest; the format needs no compression of its own.
- Columnar's zero-copy decode is attractive but it is the *largest* binary
  option after compression; brotli helps it more than gzip but it never
  beats delta-varint.
- Decode time is irrelevant for event maps under every option (≤ 25 ms) and
  only matters for the full club map, where JSON's 255 ms (and the
  transient allocation of 1.5 M small arrays) is the one that would be felt
  on a phone.
- Hilbert sorting is worth ~5 % on JSON/columnar and ~2 % on delta-varint.
  It is kept for the index and bucket-building reasons in 01, not for size.
- Symbol definitions, colours and georeferencing together are ~25 KB
  gzipped as JSON on the largest map: encoding them in binary would be
  work for no measurable gain and would cost readability.

### 6.3 Format shape: hybrid

The measurements split the document naturally in two:

- A **JSON header** (tens of KB): format version, provenance, scale and
  georeferencing, bounds, colour table, source symbol definitions,
  canonical matches, hidden defaults, strings table (texts, fonts),
  per-object table of small attributes, section directory with byte offsets.
  Readable, diffable, validated with Zod in `@oxygen/shared`.
- **Binary sections** (MB): geometry as delta-varint streams, plus a packed
  bounding-box array for the spatial index. Decoded by a ~60-line codec in
  `@oxygen/shared` into typed arrays, in a worker.

```
┌──────────────────────────────────────────────────────────────┐
│ magic "OXVM"  u32 version  u32 headerLength                  │
├──────────────────────────────────────────────────────────────┤
│ header: JSON (UTF-8)                                         │
│   format, importer, source {hash, kind, name}, unitsPerMm,   │
│   scale, georeferencing, bounds, printWindow,                │
│   colors[], symbols[], symbolMatches[], strings[],           │
│   objects: { count, sections: { attrs, bboxes, geometry } }  │
├──────────────────────────────────────────────────────────────┤
│ section attrs   : per object  u32 symbolIdx | u8 type |      │
│                   i16 angle | u32 stringIdx | u32 colorNo    │
│                   | u32 geomOffset | u32 coordCount  (fixed) │
├──────────────────────────────────────────────────────────────┤
│ section bboxes  : per object  i32 minX minY maxX maxY        │
├──────────────────────────────────────────────────────────────┤
│ section geometry: per object  varint(Δx) varint(Δy) u8 flags │
│                   × coordCount, Δ relative to previous coord  │
└──────────────────────────────────────────────────────────────┘
```

The fixed-width `attrs` and `bboxes` sections let a consumer build the
spatial index and the symbol/colour draw batches without touching geometry,
and give each object a random-access offset into the geometry stream — the
property 01 §5 asked for so range loading can be added later. Objects are
written in Hilbert order; `sourceIndex` in `attrs` (or the strings/provenance
table) preserves the original file order for export and for stable
identity.

A **JSON debug projection** (`.vmap.json`: the header plus geometry as
nested arrays) is produced by the same library for tests, fixtures and the
`ocad-tool`-style CLI, and is what E2E fixtures are checked in as. It is a
projection, not a second format: the binary file is canonical.

## 7. Identity and versioning

- `documentHash` = SHA-256 of the binary file. Used as the URL key,
  `ETag`, Cache Storage key and the `render_key` successor.
- Inputs that change the hash: source file bytes, importer version
  (`format.importer`), canonical library version, review decisions. A
  re-import or a re-match therefore yields a new immutable document; event
  rows point at the new hash and old documents are garbage-collected when
  unreferenced.
- `format.version` is a small integer with a strict compatibility rule:
  readers reject unknown major versions; minor additions only add optional
  header fields. The header is parsed before any binary section, so a
  version mismatch is detected after reading a few KB.
- Object identity within a document is the object's position in the
  `attrs` table (`objectIndex`), with `sourceIndex` recorded for provenance.
  Anything that refers to a map object from outside (whiteout anchors,
  hidden-object lists, overprint cut lists) refers to
  `(documentHash, objectIndex)`; when a map is re-imported those references
  are re-resolved by `sourceIndex` where the source is the same file, and
  flagged for review otherwise. The patch/edit layer itself is topic 08.

## 8. Relationship to the current schema

- `map_files.file_data` keeps the original `.ocd` (needed for re-import
  when the importer improves, and for the admin download that exists
  today). A new nullable `document_hash` column points at the imported
  document; the document bytes live in a new content-addressed table
  (`map_documents(hash PRIMARY KEY, bytes, importer_version, created_at)`)
  so a club-library map and the events that adopted it share one row.
  Object storage instead of Postgres is a deployment choice in topic 07; the
  content-addressed key is the same either way.
- `scale`, `bounds`, `north_offset`, `calibration` on `map_files` remain as
  the quick-access metadata they are today and are now derived from the
  document header rather than from a re-parse.
- `map_tiles`, `render_key` and `rendered_maps` are retired with the tile
  pipeline (topic 09).

## 9. Recommendation

1. **Content:** keep every map object with geometry, OCAD flag bits,
   rotation, text and type; keep the full source symbol table (minus icon
   bitmaps), the colour table with CMYK/order, scale and georeferencing,
   print window and export rectangles. Drop templates, layout objects,
   editor state and collaboration metadata, recording what was dropped in
   import warnings.
2. **Coordinates:** int32 in the source's native paper unit with a
   per-document `unitsPerMm`, y-up, source origin; Béziers and holes exactly
   as the source encodes them.
3. **Encoding:** hybrid — JSON header + fixed-width `attrs`/`bboxes`
   sections + delta-zigzag-varint geometry section; objects in Hilbert
   order; one hand-written codec in `@oxygen/shared` with a JSON debug
   projection. No protobuf/FlatBuffers dependency.
4. **Symbols:** three layers (source definitions always present; canonical
   matches optional per symbol; colour table with IOF classification as a
   default). Event-level view overrides stay outside the document.
5. **Identity:** SHA-256 of the file as the single key; strict major
   version check in the header; `(documentHash, objectIndex)` as the external
   object reference with `sourceIndex` for re-resolution.
6. **Storage:** content-addressed `map_documents` table referenced from
   `map_files.document_hash` (and `club_map_files`), original `.ocd`
   retained.

Budget check against 01: the largest map in the corpus becomes a 3.5 MB
download and a 30 ms decode; event maps are 0.17–0.35 MB and < 10 ms.

## 10. Open questions carried forward

- **OMAP coverage.** The reader in use (`ocad2geojson`) parses OCAD only.
  Supporting `.omap` needs either a second reader or a port; the format
  above accommodates it (`unitsPerMm`, source kind, symbol schema) but the
  normalised symbol schema must be checked against Mapper's symbol model
  (its line/area/point/text/combined symbols) before it is frozen — topic 06.
- **Source symbol schema.** The exact source-neutral symbol JSON schema is
  specified alongside the canonical library in topic 03, since the
  fallback renderer must draw both from one primitive vocabulary.
- **Fonts.** Text symbols reference system fonts (Arial, Arial Narrow,
  Segoe UI). The document stores the names; the substitution policy and the
  glyph pipeline (MSDF atlas vs. tessellated outlines) are topic 04, and
  PDF embedding is topic 05.
- **Large-text and formatted text.** `otp` 5 (formatted text in a box)
  needs layout rules (wrapping, alignment, tabs) that neither renderer has
  today; decide in 04 whether to support it fully or render it as
  unformatted text with a warning.
- **Graphic and image objects** (`sym` -2/-3): keep with their own
  colour/width (recommended, they occur in real files) — confirm the
  renderer treats them as single-colour primitives.
- **Patch layer for edits** (whiteouts, hidden objects, object mutations):
  separate artifact keyed by document hash, or a new document version per
  edit? Topic 08.
