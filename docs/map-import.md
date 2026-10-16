# Map import

Normative chapter for the pipeline that turns an uploaded map file into a
map document (`docs/map-document-format.md`). Research record:
`docs/research/vector-map-pipeline/06-import-pipeline.md` (decided
2026-10-07). Slice A, written incrementally: each section states what is
implemented and marks what is still pending.

## 1. Stages

```
 1 receive      binary upload → Buffer; sha256 → fileHash                 api        pending (07 upload route)
 2 detect       0x0CAD → OCAD; "<?xml" + Mapper namespace → OMAP          api        pending
 3 parse        reader → source model                                     api/shared done (OCAD, via ocad2geojson fork)
 4 normalise    source model → objects, symbols, colours, georef, warnings shared     done (OCAD subset, §3)
 5 analyse      bounds, north, fonts, feature usage                       shared     bounds only (encoder)
 6 match        03 §6.5 staged matcher → SymbolMatch[]                    shared     pending
 7 align        colour stack alignment (03 §6.3)                          shared     pending
 8 encode       02 codec → bytes; sha256 → documentHash                   shared     done
 9 store        map_documents(hash), links, report row                    api        pending (07)
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
  renderFor?: (symbol) => RenderSymbol | null,         // stage 4 symbol IR hook, see §3.3
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
const r = await importOcadToDocument(buffer, "map.ocd", { renderFor });
// r.bytes, r.documentHash, r.fileHash, r.counts, r.warnings,
// r.timings { read, normalise, encode } (ms)
```

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

Stage 4's conversion of OCAD symbol definitions to `RenderSymbol`
(03 Appendix C: line elements, double lines, dash patterns, point
elements, area fills and hatches, text symbols) is **pending**. Until it
lands, `render` is whatever the caller's `renderFor` hook returns (the
dev page uses the S1 pilot family by code) and `null` otherwise; the
render bridge draws proxies for `null`.

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

`format.importer` is `"ocad-1"` today (`OCAD_IMPORTER_VERSION`). Bump it
whenever stages 3–8 would produce different bytes for the same file —
reader fix, normaliser rule, codec change, matcher thresholds, library
edition. `source` carries the reader's file version, the upload name,
`fileHash` and size.

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
| Unit (shared) | `packages/shared/src/map-document/__tests__/codec.test.ts`, `projection-bridge.test.ts` | encode/decode round trip, Hilbert order, validation errors, truncation, JSON projection, render bridge |
| Unit (api) | `packages/api/src/__tests__/import-ocad.test.ts` | reader → document on `e2e/test.ocd`, determinism, bboxes, symbolise through the bridge |
| E2E | `e2e/map-gl-doc.spec.ts` | document path = reader path in the browser, native `.oxvm` round trip |

The S0 corpus check (09 §7: whole corpus, every OMAP construct) is
pending the OMAP reader; the OCAD half runs today via the measurement
script and is recorded in `docs/map-document-format.md` §9.

## 7. Pending in this chapter

Symbol IR conversion (§3.3), matcher and colour alignment (stages 6–7),
OMAP reader and the shared `normalise()` fixtures (06 §3.3), import job
and report persistence, review API and previews (06 §5), upload route
and storage (`docs/map-storage.md`, 07). Each lands with its own section
here and its own tests.
