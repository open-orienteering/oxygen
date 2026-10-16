# Map document format

Normative specification of the **map document**: the artifact the importer
produces from an OCAD or OpenOrienteering Mapper file, the API stores by
content hash, the viewer decodes in a worker and the PDF backend prints.
Research record: `docs/research/vector-map-pipeline/02-document-format.md`
(decided 2026-10-07); this chapter states only the result. Slice A.

Implementation: `packages/shared/src/map-document/` (`header.ts` schema,
`codec.ts` encode/decode, `projection.ts` JSON projection,
`render-bridge.ts` document → symboliser input). Exported as
`import { mapDocument } from "@oxygen/shared"`.

## 1. What the document is

- A **model, not a display list**: every map object with its geometry,
  flags, rotation, text and type; the source symbol table; the colour
  table in draw order; scale and georeferencing; print window and export
  rectangles. No flattened curves, no tessellation, no RGB, no per-zoom
  variants.
- **Immutable and content-addressed**: identity is the SHA-256 of the
  bytes (§6). A re-import, a re-match or a review decision yields a new
  document.
- **Event-neutral**: colour-stack profile and overrides, rotation
  correction, event crops and north-line options stay in `map_files`
  (and the club series settings), never in the document. One document can
  be shared by a club library entry and every event that adopted it.
- Dropped at import, recorded as warnings (§2.6): templates, OCAD layout
  objects, editor state (zoom, bookmarks, GPS adjustment, display and view
  parameters), collaboration metadata, symbol icon bitmaps, course-setting
  payloads.

## 2. Header (JSON)

The header is UTF-8 JSON validated by `mapDocumentHeaderSchema` (Zod).
Defaults are applied by the encoder, so stored headers are always
complete. Field order below is the schema's.

| Field | Type | Meaning |
|---|---|---|
| `format.version` | `1` | Major format version (§6) |
| `format.importer` | string | Importer version; bumped when the same file would encode differently (`docs/map-import.md`) |
| `source.kind` | `"ocad" \| "omap"` | Reader that produced the document. `source` deliberately omits the upload name so the hash depends on the bytes only (`docs/map-storage.md` §1) |
| `source.version` | string | Source file version, e.g. `"2018.8.3"` |
| `source.hash` | hex | SHA-256 of the source file |
| `source.bytes` | int | Source file size |
| `unitsPerMm` | int | Native paper unit: **100** for OCAD (1/100 mm), **1000** for OMAP (1/1000 mm) |
| `mapScale` | number | Scale denominator, e.g. `15000` |
| `documentFactor` | number | 03 §6.6 symbol scale factor; `1` until the matcher sets it |
| `library` | `{ id, version } \| null` | Canonical library the matches refer to; `null` before matching |
| `georeferencing` | §2.3 | |
| `bounds` | `{ minX, minY, maxX, maxY }` | Union of object bounding boxes, native units (computed by the encoder) |
| `printWindow` | `{ scale?, left, bottom, right, top } \| null` | OCAD PrintPar, paper mm, y-up |
| `exportRectangles` | `[{ name, left, bottom, right, top }]` | OCAD PrintAndExportRectangleList |
| `colours` | §2.1 | Colour stack, index = draw order |
| `symbols` | §2.2 | Symbol table |
| `strings` | string[] | Texts; `attrs.stringIdx` is **1-based** into this list, 0 = none; deduplicated |
| `warnings` | `[{ code, count, message? }]` | §2.6 |
| `objects.count` | int | Number of objects |
| `objects.sections` | `{ attrs, bboxes, geometry }` each `{ offset, length }` | Byte ranges relative to the **body offset** (§3) |

### 2.1 Colours

```ts
{ id: "src:12", name: "Brun", cmyk: [0, 0.56, 1, 0.18], sourceNumber: 12,
  spot?: { name?, knockout? }, overprint?: true, purpleRole?: "lower" | "upper" }
```

The stack is the document's draw order: **index 0 is drawn first**.
Source colours are imported in the source's render order (for OCAD,
`renderOrder` 0 is the top of the table and therefore the last index);
`sourceNumber` is the source colour number. Palette entries inserted by
colour alignment (03 §6.3, later in slice B) have no `sourceNumber`.
`cmyk` is 0–1. RGB is never stored; the screen conversion is
`render.cmykToHex`.

### 2.2 Symbols

```ts
{ code: "505.1", name: "Stig", kind: "line", origin: "source", hidden: false,
  sourceIndex: 17, sourceFont?: "Arial Narrow",
  render: RenderSymbol | null,
  match?: { canonicalId, method, confidence, reasons, reviewed, libraryVersion } }
```

- One entry per **source symbol**, in source table order (`sourceIndex`).
  `code` is the number as written. `kind` is the source type: `point`,
  `line`, `area`, `text`, `rectangle`, `unknown`. `hidden` is the
  source's default visibility (OCAD status bit 1); consumers may
  override it.
- `origin: "graphic"` entries are **synthesised** for OCAD graphic/image
  objects (`sym` −2/−3): one per (object type, colour, line width), with
  a `render` definition when the colour resolves (a line symbol or a
  plain area fill). The objects then reference them like any symbol.
- `origin: "missing"` entries are stubs for symbols that objects
  reference but the table lacks; `render` is `null` and the import warns
  `MISSING_SYMBOL`.
- `render` is the symbol in the render IR (`docs/map-symbols.md`; today
  `render.RenderSymbol`). `null` means the normaliser could not express
  the source definition; the render bridge then draws a proxy (§8) or
  drops the object, and the import report says which.
- `match` is the 03 matcher's result; absent until the matcher runs.

### 2.3 Georeferencing

```ts
{ crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" } | null,
  paperOrigin: { x: 687000, y: 6574000 } | null,   // projected coordinates of paper (0, 0)
  gridRotationDeg: 4.98,     // grivation: grid north → paper +y, clockwise positive
  gridScaleFactor: 1,
  declinationDeg?: 6.5, realWorldEnabled?: true, sourceGridId?: 13002 }
```

`crs` and `paperOrigin` are `null` together when the map is not
georeferenced. `declinationDeg`, `realWorldEnabled` and `sourceGridId`
are passed through from the source as written (OCAD ScalePar `d`, `r`,
`i`) and are not interpreted by the importer. The operator's `rotation_correction` and the detected
north lines are *not* here (02 §5).

### 2.4 Objects: fixed-width `attrs` record, 24 bytes

| Offset | Type | Field |
|---:|---|---|
| 0 | u16 | `symbolIdx` — index into `symbols` |
| 2 | u8 | `type` — OCAD object type: 1 point, 2 line, 3 area, 4 unformatted text, 5 formatted text, 6 line text, 7 rectangle |
| 3 | u8 | reserved (0) |
| 4 | i16 | `angle` — rotation in **0.1°**, as the source wrote it (point rotation, area pattern angle, text angle) |
| 6 | u16 | reserved (0) |
| 8 | u32 | `stringIdx` — 1-based into `strings`, 0 = no text |
| 12 | u32 | `geomOffset` — byte offset of the object's coordinates in the geometry section |
| 16 | u32 | `coordCount` — number of coordinates (≥ 1) |
| 20 | u32 | `sourceIndex` — position in the source file's object list |

All multi-byte integers are little-endian. The decoder exposes the
table as a structure of typed arrays (`ObjectAttrs`).

### 2.5 Objects: `bboxes` record, 16 bytes

`i32 minX, minY, maxX, maxY` in native units: the exact bounds of the
object's coordinates (control points included). Fixed width so the
spatial index and the symbol/colour batches can be built without touching
geometry.

### 2.6 Warning codes

Stable identifiers (06 §4.4); the UI translates them, tests assert on
them.

| Code | Meaning |
|---|---|
| `TEMPLATES_DROPPED` | Background templates (OCAD parameter string 8) not imported; count = templates |
| `LAYOUT_OBJECTS_DROPPED` | OCAD 12 layout objects (string 24) not imported |
| `MISSING_SYMBOL` | Objects reference a symbol absent from the table; a stub entry was created |
| `DUPLICATE_SYMBOL_NUMBER` | The same number is defined twice; objects use the first |
| `EMPTY_GEOMETRY_DROPPED` | Objects with no coordinates were dropped |
| `UNKNOWN_OBJECT_TYPE` | Object type outside 1–7, dropped |
| `READER_WARNING` | The source reader reported warnings (count); the texts are in the import report |

## 3. File layout

```
offset  size  content
0       4     magic "OXVM"
4       4     u32 format version (1)
8       4     u32 headerLength
12      n     header JSON, UTF-8 (exactly headerLength bytes)
…       0–3   zero padding so that bodyOffset is a multiple of 4
bodyOffset    body: sections at the offsets in header.objects.sections
              attrs    (count × 24 B, always first, offset 0)
              bboxes   (count × 16 B)
              geometry (variable)
```

`bodyOffset = align4(12 + headerLength)`. Section offsets are relative
to `bodyOffset`, so the header does not depend on its own length. The
bbox section starts 4-byte aligned, which lets the decoder expose it as
a zero-copy `Int32Array` view when the input buffer itself is aligned.

## 4. Coordinates and flags

- **Units**: `int32` in the source's native paper unit (`unitsPerMm`),
  **x right, y up**, origin at the source's paper origin. No y-flip at
  import; renderer and PDF flip once in their projection. Consumers
  convert to µm with `1000 / unitsPerMm` (×10 for OCAD).
- **Flags**: one byte per coordinate, `render.COORD_FLAG`
  (`docs/map-rendering.md` §2.1), bit-compatible with OCAD so import and
  export are table-free:

  | Bit | Meaning | OCAD |
  |---:|---|---|
  | 1 | first Bézier control point | x bit 0 |
  | 2 | second Bézier control point | x bit 1 |
  | 4 | corner point | y bit 0 |
  | 8 | dash point | y bit 3 |
  | 16 | first point of a hole ring | y bit 1 |
  | 32 | no left line | x bit 2 |
  | 64 | no right line | y bit 2 |
  | 128 | border line / virtual gap | x bit 3 |

- **Curves** stay cubic Béziers; **holes** are one coordinate run with a
  flag-16 ring start, as the source encodes them. Text objects keep their
  source coordinates verbatim (OCAD unformatted text: anchor plus the four
  box corners).

## 5. Geometry section

Per object, in attrs order, `coordCount` triples:

```
varint zigzag(Δx)  varint zigzag(Δy)  u8 flags
```

The **first** coordinate is a delta from the object's `(bbox.minX,
bbox.minY)`; each following coordinate is a delta from the previous one.
Deltas are zigzag-encoded unsigned LEB128 varints (7 bits per byte, high
bit = continue), at most 5 bytes. Because the first delta is relative to
the object's own bbox, any object can be decoded in isolation from
`attrs.geomOffset` + its bbox record — the random-access property 01 §5
asked for.

Objects are written in **Hilbert order**: by the Hilbert index (order
16, i.e. a 65 536² grid over `bounds`) of the bbox centre, ties broken by
`sourceIndex`. The output is therefore a pure function of the input set,
which is what makes the hash stable across machines (§6).

## 6. Identity and versioning

- `documentHash = SHA-256(bytes)` (`mapDocument.mapDocumentHash`, WebCrypto).
  URL key, `ETag`, Cache Storage key.
- Same `(source bytes, importer version, library version, review
  decisions)` ⇒ same bytes ⇒ same hash. The corpus check (`docs/map-import.md`)
  asserts this across two processes.
- `format.version` is a strict major: `readMapDocumentHeader` rejects any
  other value with `MapDocumentFormatError` after reading 12 bytes + the
  header. Compatible additions only add optional header fields.
- External references to a map object are `(documentHash, objectIndex)`
  where `objectIndex` is the position in `attrs`; `sourceIndex` is used to
  re-resolve them after a re-import of the same file (08 owns the
  tolerance rule for new editions).

## 7. JSON projection

`mapDocument.toJsonProjection(doc)` → `{ header, objects }` where
`header` is the header without `objects` and `strings`, and each object
is `{ symbol, type, angle?, text?, sourceIndex, coords: [[x, y] | [x, y, flags]] }`.
`fromJsonProjection(json)` re-encodes to **identical bytes** (asserted on
the corpus and in unit tests). Used for fixtures, diffs and the
`document:from-ocd --json` CLI; the binary file is canonical.

## 8. Render bridge

`mapDocument.documentRenderInput(doc, { unmatched, proxyColours, includeHidden })`
produces the symboliser's input: coordinates in µm, `RenderObject`s with
`angleDeg = angle / 10`, text from `strings`, `closed` for areas and
rectangles. Symbol resolution per object: the symbol's `render` when it
exists and its kind agrees with the object type; otherwise a proxy per
kind (`unmatched: "proxy"`, the S1 envelope) or nothing
(`unmatched: "drop"`). Hidden symbols' objects are skipped unless
`includeHidden`. Statistics: `total, rendered, proxied, hidden, dropped,
coordinates`.

## 9. Measured on the corpus

`.local/research/oxygen-measurements/document/measure-document.mjs` (Node 20, laptop)
and `measure-doc-browser.mjs` (Chromium through `/dev/map-gl-doc?via=document`).
Sizes in MB; gz = gzip −6 (what HTTP transport does); decode = bytes →
typed arrays, warm.

| Map | Objects | Coords | `.ocd` | Document raw | gz | brotli | header gz | attrs gz | bboxes gz | geometry gz | encode | decode (Node) | decode (browser) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Sprint | 10 680 | 122 422 | 2.19 | 0.90 | **0.52** | 0.49 | 4.6 KB | 0.08 | 0.10 | 0.33 | 31 ms | 8.7 ms | 4.7 ms |
| Crop-A | 4 983 | 71 084 | 2.29 | 0.47 | **0.25** | 0.23 | 6.1 KB | 0.04 | 0.04 | 0.16 | 14 | 1.7 | 3.9 |
| Crop-B | 3 073 | 53 395 | 4.36 | 0.33 | **0.18** | 0.17 | 5.8 KB | 0.02 | 0.03 | 0.12 | 9 | 1.4 | 3.0 |
| Club-2026 | 45 884 | 640 230 | 9.78 | 3.91 | **2.15** | 1.98 | 6.8 KB | 0.33 | 0.40 | 1.42 | 71 | 7.1 | 12.5 |
| Club-full | 101 729 | 1 518 979 | 37.69 | 8.95 | **4.99** | 4.58 | 9.7 KB | 0.73 | 0.90 | 3.35 | 133 | 16.7 | 25.1 |

- Round trip against the reader: 0 mismatches on every map (coordinates,
  flags, angles, texts); the JSON projection re-encodes to identical
  bytes; the hash is identical across processes.
- Header-only read: < 1 ms on every map.
- Against 02 §9's budget ("3.5 MB download, 30 ms decode" for Club-full):
  decode is 2× better than estimated; the download is 5.0 MB, not 3.5 —
  02's figure counted geometry only, and the fixed-width `attrs` +
  `bboxes` sections add 1.6 MB gzipped on Club-full (33 %), 0.18 MB on
  Sprint. Alternatives were measured and **not taken**: bboxes as
  `(min, width, height)` saves 1.5 % of the file; delta-coded bboxes save
  5 % but lose random access. Event maps are 0.18–0.52 MB, well inside
  01's budget.
- In the viewer, a native `.oxvm` replaces the `ocad2geojson` read that
  was 60–70 % of the S1 first frame: Sprint read stage 207 → 9 ms,
  Club-full 2 034 → 74 ms (decode + render bridge); Club-full envelope
  first frame 4.2 → 1.8 s on the laptop.

## 10. Where things live

| Path | Contents |
|---|---|
| `packages/shared/src/map-document/header.ts` | header schema and types, `OBJECT_TYPE`, magic/version |
| `packages/shared/src/map-document/codec.ts` | `encodeMapDocument`, `decodeMapDocument`, `readMapDocumentHeader`, `mapDocumentHash`, `hilbertIndex` |
| `packages/shared/src/map-document/projection.ts` | `toJsonProjection`, `fromJsonProjection`, `projectBytes` |
| `packages/shared/src/map-document/render-bridge.ts` | `documentRenderInput` |
| `packages/shared/src/map-document/__tests__/` | codec, projection and bridge tests |
| `packages/api/src/import/ocad.ts` | `importOcadToDocument` (reader + normaliser + encode + hash) |
| `packages/api/scripts/ocd-to-document.ts` | `pnpm --filter @oxygen/api document:from-ocd <in.ocd> [out.oxvm] [--json]` |
| `packages/web/src/pages/dev/MapGlDocPage.tsx` | `/dev/map-gl-doc?via=document` — browser-side encode/decode report; accepts `.oxvm` |
| `e2e/map-gl-doc.spec.ts` | document path = reader path on `e2e/test.ocd`; native `.oxvm` round trip |
| `packages/api/src/map-store/` | storage and delivery of encoded documents — `docs/map-storage.md` |
