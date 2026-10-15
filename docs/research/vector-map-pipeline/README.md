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

## Method, after the research (decided 2026-10-14)

All nine topics are decided. The **specification** is not a separate
volume: it is written incrementally, one slice at a time (09 §4), as the
normative `docs/*.md` that the slice's PRs are reviewed against — only
what was decided, stated as schemas, interfaces, rule tables and
acceptance checklists, without rationale or rejected options. The research
documents freeze as the record of why; where a later topic refined an
earlier one (07 → 06 upload and job model; 08 → 05 page ownership) the
spec states the refined form. The spikes (09 §7) run before the slice they
protect and may amend a spec chapter before it is written, never after
the slice has shipped. Each spike ends in a report here (`S<n>-*.md`)
with the numbers, the verdict per budget and the amendments it makes to
the research decisions; the spec chapter carries only the resulting
rules.

| Spike | Status | Report |
|-------|--------|--------|
| S1 render budgets | Done 2026-10-15 — backend confirmed, two amendments to 04, phone-GPU budget carried as residual risk | [S1-render-spike.md](S1-render-spike.md) |
| S0, S2–S4 | Scheduled per 09 §7 | — |

Spec chapters by slice:

| Slice | Spec documents (`docs/`) | Source topics |
|-------|--------------------------|---------------|
| A | `map-document-format.md`, `map-import.md`, `map-storage.md` | 02, 06, 07 |
| B | `map-symbols.md`, `map-rendering.md` (shared stage, WebGL2, viewer) — `map-rendering.md` §1–4, §5.1–5.2, §6 drafted by S1 steps 1–4 (step 4 = corpus measurements against 04 §9 in §5.2) | 03, 04, 01 |
| C | `course-layer.md`, `course-print.md` | 08 §4.1, 05 |
| D | `course-editor.md` (rewritten), `course-layout.md` | 08 |
| E–F | `migrations/2026-vector-map-pipeline.md`, `AGENTS.md` §7/§15 | 09 |
| G | `map-editing.md` | 08 §4.7, 03 §1 |

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
| 08 | Course editor: domain model (sites, course structure with variations and map exchange, course-setting objects incl. filter regions, layout templates and sheets, patch layer), redesigned editing experience with a mobile field mode, roadmap | Decided (derived course layer; structure + materialised variants; `course_objects`; auto templates; event-scoped patch; one canvas, four modes; field mode on phones) | [08-course-editor.md](08-course-editor.md) |
| 09 | Migration: release slices, per-event switch and coexistence, data backfill, rollback matrix, retirement schedule, spikes S0–S4, per-slice gates | Decided (seven slices A–G behind `events.map_pipeline`; additive schema until retirement; backfill job by hash; S1 phone spike before the viewer slice) | [09-migration.md](09-migration.md) |

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
| 2026-10-12 | 08 Course editor | Course layer derived by one shared function for screen, print and kiosk; course structure as items with variation groups and map-exchange sections in `courses.structure`, materialised into child variant rows for timing and export; controls stay sites (+ kind, manual gaps, notes, field check-off); `course_objects` with scope (OOB, whiteout, filter regions clip/hide/show-only, toner saver, text, images); layout templates auto-keyed by paper/orientation/scale with explicit extras, sheets per section and class override, `resolveSheet` as 05's single page producer; event-scoped patch layer keyed by document hash, promoted to a club version on demand; one editor with Course/Layout/Field/Map modes, contextual selection plus sticky creation tools with a ghost and pending leg; Field mode as the phone default with a bottom-sheet inspector; advisory live checks. | One geometry implementation instead of three; structure edited whole and journaled as one row while timing keeps reading flat rows; a patch avoids invalidating every hash reference per edit; the mobile requirement is met by chrome and gestures, not a second model. See [08](08-course-editor.md) §11. |
| 2026-10-14 | 09 Migration | Seven release slices A–G, each additive in schema and gated by an instance flag plus per-event `events.map_pipeline` switch that governs reads only; imports and derived artifacts dual-written from slice A; resumable hash-keyed backfill; retirement in two steps one release after the last consumer; spikes S0–S4 scheduled against the slices they protect, S1 (phone budgets) before the viewer slice is committed. | Rollback stays an image tag plus a switch at every step; the document is useful before any consumer exists; the only decision a spike can still change (04's backend) is tested before the code that depends on it. See [09](09-migration.md) §9. |
| 2026-10-15 | S1 spike | 04's custom WebGL2 backend confirmed; slice B may be committed. Event maps meet every measured budget (first frame 40–142 ms laptop / 154–552 ms at 4× CPU throttle after decode, 5–20 MB GPU, 14–328 draws, ≤ 1 ms frame CPU); club maps fail whole-document first frame and GPU memory as 04 predicted, fixed by the bucket layer, not the stack. Amendments to 04: strokes as indexed strips (95 % of GPU bytes), visible-set indices on B's critical path, depth-buffer fills dropped, earcut/stencil split fixed (stencil only for pattern clip and hatch), pattern inclusion as a scanline. 04 §11 closed: resvg-via-SVG oracle; MSDF atlas = ASCII + Latin-1 + Latin Ext-A (corpus text is `ÄÅÖäåéö` beyond ASCII), Cyrillic on demand; 05's pdf-lib writer stands against the unchanged stream. Residual: frame GPU on a real phone unmeasured — first task of B. | Whole-document draw is vertex-bound (GPU time flat from 1 M to 2.6 M pixels), so no GPU library or AA fallback would change the club result; the pilot family covers 11–18 % of real objects, so budgets were judged against the envelope mode. See [S1-render-spike.md](S1-render-spike.md). |
| 2026-10-14 | Method | Specification written incrementally per slice as the living `docs/*.md`; research directory frozen as the record; spikes before their slice. | Avoids a second document set that drifts; lets S1 amend a spec chapter that does not exist yet. See "Method" above. |
| 2026-10-07 | Scope | Light map editing (new/changed objects with existing or materialised symbols) is a stated future requirement. Not implemented initially; every topic keeps it possible. | Avoids a bolted-on editing layer later: objects reference source symbols only, canonical symbols are materialised into the source table, the format allows appends (02 §10, 03 §1). |
