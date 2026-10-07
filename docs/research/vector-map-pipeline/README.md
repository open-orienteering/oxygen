# Vector map pipeline — research and specification

Working area for the redesign of Oxygen's map, course-setting and print
pipeline. The method is spec-driven: each topic gets a research document that
states the question, gathers evidence (measurements, prior art, constraints
from the current code), lays out the options with their trade-offs, and ends
in a recorded decision. Decisions then feed a specification that
implementation PRs are measured against.

Nothing in this directory is shipped. Documents here may be superseded; when
a topic lands, its decision is copied into the relevant `docs/*.md` and the
research document is marked as such.

## Objectives

1. One vector representation of the base map, in map paper space, that is
   the single source for the interactive viewer/editor, printing and export.
2. GPU rendering of that representation in the browser; no raster tiles and
   no SVG DOM for the base map.
3. One rendering core for screen and print. Today the live viewer, the layout
   editor and the PDF path draw the overprint three different ways and the
   base map two different ways (`docs/course-maps.md`, "Web vs print
   divergence" in `docs/map-tile-rendering.md`).
4. A course editor that can grow the features serious course setting needs
   (variations, corridors, insets, print profiles, layout templates, setter
   maps) without fighting the rendering substrate.
5. Room for **light map editing** — adding or correcting a path, a boulder,
   a fence, a whiteout — without becoming a mapping program. Not in the
   first implementation, but every topic must leave it possible rather than
   bolt it on later (see 02 §10 patch layer, 03 §1 scope note, 08).

## Current state (for reference)

- `map_files.file_data` keeps the raw `.ocd`. The web viewer gets Web
  Mercator PNG tiles rasterised server-side from `ocad2geojson` SVG via resvg
  (`packages/api/src/map-tiles.ts`, `docs/map-tile-rendering.md`).
- Print composes paper-space SVG and converts with `rsvg-convert`
  (`packages/api/src/course-maps/`, `docs/course-maps.md`).
- The overprint helpers in `packages/shared/src/course-maps/` are shared by
  print and the layout editor; `MapViewer.tsx` re-implements the overlay as
  React SVG in screen pixels.

## Topics

| # | Topic | Status | Document |
|---|-------|--------|----------|
| 01 | Delivery: tiles vs. whole document | Decided (whole document) | [01-tiling-vs-whole-document.md](01-tiling-vs-whole-document.md) |
| 02 | Map document format (encoding, coordinate flags, symbols, colours, georeferencing) | Decided (hybrid JSON header + binary geometry) | [02-document-format.md](02-document-format.md) |
| 03 | Symbol model: render IR, canonical IOF library, colour palette and stack, OCAD/OMAP symbol matching, fallbacks | Decided (one IR; library authored in it; staged reviewable matching) | [03-symbol-model.md](03-symbol-model.md) |
| 04 | Render core: shared symbolisation stage + backends, GPU stack choice, per-primitive techniques, colour-order drawing, editing hooks, fixtures | Decided (shared pass stream; custom WebGL2 backend) | [04-render-core.md](04-render-core.md) |
| 05 | Print: PDF as a backend of the shared stage, CMYK and overprint policy, print profiles, fonts, PDF/X-4, geospatial PDF, writer choice | Decided (pdf-lib low-level ops; CMYK + IOF layering default; club print profiles) | [05-print-pdf.md](05-print-pdf.md) |
| 06 | Import pipeline: OCAD/OMAP readers and one normaliser, staged job, report, review API and decisions, club map versions, immutable caching, binary upload | Decided (two readers + shared normaliser; two-level identity; club symbol decisions by fingerprint) | [06-import-pipeline.md](06-import-pipeline.md) |
| 07 | Storage and delivery: blob store choice, content-addressed schema (sources, documents, club map versions, decisions, print profiles), GC, routes and auth, chunked upload, serverless job execution, PWA and venue offline, backups | Decided (Postgres `bytea` content-addressed; RESTRICT FKs + GC; immutable hash routes; chunked upload; documents in the checkout snapshot) | [07-storage-delivery.md](07-storage-delivery.md) |
| 08 | Course editor: domain model (sites, course structure with variations and map exchange, course-setting objects incl. filter regions, layout templates and sheets, patch layer), redesigned editing experience with a mobile field mode, roadmap | Proposed (derived course layer; structure + materialised variants; `course_objects`; auto templates; event-scoped patch; one canvas, four modes; field mode on phones) | [08-course-editor.md](08-course-editor.md) |
| 09 | Migration from the tile and librsvg pipelines; rollback | Not started | — |

## Measurement corpus

Several research documents cite measurements of real OCAD maps held in the
development database (club library maps and event crops). The maps are not
committed (see `AGENTS.md` §12 on real club maps); the measurement scripts and
raw results live outside the repository and are referenced by name in each
document so the numbers can be regenerated.

| Label | Kind | Scale | `.ocd` size |
|-------|------|-------|-------------|
| Club-full | Full club map, entire mapped area | 1:15 000 | 35.9 MB |
| Club-2026 | Club map, current-season extent | 1:15 000 | 9.3 MB |
| Club-old | Older club map (rotated) | 1:15 000 | 3.2 MB |
| Sprint | Sprint event map | 1:4 000 | 2.1 MB |
| Crop-A | Event crop of a club map | 1:15 000 | 2.2 MB |
| Crop-B | Event crop of a club map | 1:15 000 | 4.2 MB |

## Decision log

| Date | Topic | Decision | Rationale |
|------|-------|----------|-----------|
| 2026-10-07 | 01 Delivery | Whole document (Option A). Range-indexed loading (Option C) only if club-library browsing of very large maps needs it; no server-cut vector tiles. | Event maps are < 1 MB and prepare in < 100 ms; tiles would be a second product with permanent seam defects in ISOM line/area styling. See [01](01-tiling-vs-whole-document.md) §9. |
| 2026-10-07 | 02 Format | Hybrid document: JSON header (provenance, scale, georeferencing, colours, source symbols, matches) + fixed-width attribute/bbox sections + delta-zigzag-varint geometry; int32 paper units with `unitsPerMm`, y-up; SHA-256 identity; content-addressed `map_documents`. | Half the size of gzipped JSON, decodes in < 10 ms for event maps, keeps every OCAD flag bit, no codec dependency. See [02](02-document-format.md) §9. |
| 2026-10-07 | 03 Symbols | One `RenderSymbol` IR for imported and canonical symbols; IOF library (ISOM 2017-2 r6, ISSprOM 2019-2 r6) authored in the IR with per-entry purple role; versioned IOF colour palette and one aligned colour stack per document; staged, reviewable matching persisted in the document; unmatched symbols drawn by the same renderer. | Removes the second (fallback) render path, makes lower/upper purple data-driven, and survives the corpus's traps (`527 Byggnad`, `503.4`) via colour-class hard fails and review. See [03](03-symbol-model.md) §9. |
| 2026-10-07 | 04 Render core | Shared symbolisation stage in `@oxygen/shared` emitting a pass stream (paper µm, Béziers intact, dashes as slices, halos as own-colour passes); custom WebGL2 backend (earcut fills, shader-extruded strokes, instanced glyphs, stencil clip, procedural hatch, MSDF text), painter's order via per-(colour, kind) visible-set index buffers, 50 mm buckets with zoom-gated preparation; WebGPU later behind the same interface. Filter regions and georeferenced overlays are stream-level concepts. Spikes deferred until research is complete. | Everything measurable on paper is decided once and shared with print; the GPU libraries surveyed each fight the primitives or the CRS and save little. See [04](04-render-core.md) §10. |
| 2026-10-07 | 05 Print | PDF is a backend of the shared stage: pass kinds map one-to-one to operators (Béziers kept, dashes as slices, glyph form XObjects, clipped hatch lines, stroked-text halos); DeviceCMYK from the colour stack with IOF lower/upper purple layering as the only default overprint simulation; true overprint and spot colours as a `cmyk-offset` option; club print profiles (mode, per-colour CMYK calibration, min line width, uploaded output-intent ICC) with a test-sheet generator; subset Liberation fonts embedded from the shared package; geospatial viewport per frame; `@cantoo/pdf-lib` low-level API behind a thin operator layer; isomorphic module, server first, browser/offline later. | Removes SVG, `rsvg-convert`, the ink layer and `window.png`; reader-independent output per the IOF printing document; print profiles make the IOF calibration method usable. See [05](05-print-pdf.md) §9. |
| 2026-10-07 | 06 Import | Keep the fork's OCAD reader, add a streaming OMAP reader, resolve every format difference in one fixture-tested `normalise()`; ten-stage job in a worker thread with a structured, code-keyed report; source document keyed by `(fileHash, importerVersion)` and final document by content hash so review never reparses; review API with reference-raster previews; club symbol decisions persisted by fingerprint and applied as the matcher's first stage; club maps as versioned series pinned by events; immutable delivery by hash; binary upload route. | Two formats converge before symbol matching, review stays fast and repeatable, and a club's mapping choices survive new editions of its map. See [06](06-import-pipeline.md) §12. |
| 2026-10-07 | 07 Storage | Postgres `bytea` as the single content-addressed store (`STORAGE EXTERNAL`, thin `BlobStore` seam); `map_sources` / `map_documents` / previews, `club_maps` + `club_map_versions` pinned by `map_files`, club symbol decisions and print profiles, upload and job tables; blobs never updated, `RESTRICT` FKs + daily GC with grace; `/api/map-documents/:hash` immutable with reference-based auth, ranges, route-scoped compression, streamed sources; chunked upload into the DB; import jobs as rows resumed by heartbeat; CacheFirst + `storage.persist()` on devices; documents join the venue checkout snapshot; backups by hash. | The only store all three deployments share is Postgres; the FK graph is the reference counter; Cloud Run's 32 MiB HTTP/1 ceiling and two-instance topology rule out temp files and in-memory jobs; a 0.2–3.5 MB document is small enough to travel to the venue where tiles were not. See [07](07-storage-delivery.md) §13. |
| 2026-10-07 | Scope | Light map editing (new/changed objects with existing or materialised symbols) is a stated future requirement. Not implemented initially; every topic keeps it possible. | Avoids a bolted-on editing layer later: objects reference source symbols only, canonical symbols are materialised into the source table, the format allows appends (02 §10, 03 §1). |
