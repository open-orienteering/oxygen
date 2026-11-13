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

Decision gates (not spikes — design decisions that must be recorded
before a slice's spec chapter is written, because they shape its schema):

| Gate | Decide before | Question | Status |
|------|---------------|----------|--------|
| G1 Concurrent editing | Slice C/D spec (`course-layer.md`, `course-editor.md`) | Multi-device, occasionally concurrent course editing (setter on desktop, controller in Field mode) without silent clobber. Not a requirement in 01–09; 08 §5.5 inherits full-row LWW and `courses.structure` is one JSONB row, so two edits to the same course overwrite each other. Direction agreed 2026-10-18: (1) optimistic concurrency on `course.setStructure` / `control.update` — client sends the HLC/version it edited from, server answers `CONFLICT` on mismatch, client refreshes and re-applies; (2) presence ("who has this course open") and live refresh of others' changes over the existing journal/push path; (3) `map_patches` ops idempotent and commutative so patches from two devices merge via the journal; `structure` stays blob-LWW-with-conflict-detection in v1, concurrent control reordering is rejected as a conflict rather than merged. General-purpose CRDT documents (Yjs/Automerge) remain rejected per `offline-architecture.md`. To record: the conflict payload, how the client rebases a field move onto a refreshed structure, and whether presence needs a new push channel. | **Decided 2026-10-31** (decision log; normative text in `course-layer.md` "Decided by the user 2026-10-31"; D0 writes §7 "Concurrency") |

Spec chapters by slice:

| Slice | Spec documents (`docs/`) | Source topics |
|-------|--------------------------|---------------|
| A | `map-document-format.md` (written 2026-10-16: codec, header, JSON projection, render bridge, corpus numbers), `map-import.md` (stages 1–4 OCAD and OMAP incl. symbol IR, 6–9 done; review pending), `map-storage.md` (tables, document route, chunked upload, import jobs) | 02, 06, 07 |
| B | `map-symbols.md` (written 2026-10-16: palette editions, `ISOM2017-2` + `ISSprOM2019-2` libraries, authoring rules, resolver, tests; §8–9 matcher + colour alignment written 2026-10-18), `map-rendering.md` (shared stage, WebGL2, viewer) — `map-rendering.md` §1–4, §5.1–5.2, §6 drafted by S1 steps 1–4 (step 4 = corpus measurements against 04 §9 in §5.2) | 03, 04, 01 |
| C | `course-layer.md`, `course-print.md` | 08 §4.1, 05 |
| D | `course-editor.md` (rewritten), `course-layout.md` | 08 |
| E–F | `migrations/2026-vector-map-pipeline.md`, `AGENTS.md` §7/§15 | 09 |
| G | `map-patches.md` (§1–2 written 2026-11-13 by G2: patch model, merge, application) | 08 §4.1, §4.7, 03 §1 |
| H | `map-terrain.md` (§1–2 contour graph written 2026-11-13 by H1; §3 solve H2, §4–5 height field H3, §6–7 DEM H9–H10) | 10 |

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
| 10 | Height sources and 3D draping: contour-derived surface vs open DEMs, elevation assignment from unlabelled contours, height field as a stage-10 artifact, render-to-texture drape, readiness constraints on B2/B4, spike T1 | Open (research opened 2026-10-21; constraints §6 act now; decide after slice D) | [10-terrain.md](10-terrain.md) |

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

The log is split into one file per slice under [`decisions/`](decisions/), so that no file is too large to open. Each file is a table with the same columns as before (Date, Topic, Decision, Rationale), rows in the order they were recorded.

| File | Covers |
|------|--------|
| [`decisions/general.md`](decisions/general.md) | Research, gates, releases and cross-slice decisions |
| [`decisions/slice-a.md`](decisions/slice-a.md) | Slice A — import and storage |
| [`decisions/slice-b.md`](decisions/slice-b.md) | Slice B — GL viewer |
| [`decisions/slice-c.md`](decisions/slice-c.md) | Slice C — derived course layer and PDF |
| [`decisions/slice-d.md`](decisions/slice-d.md) | Slice D — editor phase 1 and layout mode |
| [`decisions/slice-e.md`](decisions/slice-e.md) | Slice E — full migration |
| [`decisions/slice-p.md`](decisions/slice-p.md) | Slice P — polish after slice E |
| [`decisions/slice-f.md`](decisions/slice-f.md) | Slice F — course structure |
| [`decisions/slice-g.md`](decisions/slice-g.md) | Slice G — Map mode and offline print |
| [`decisions/slice-h.md`](decisions/slice-h.md) | Slice H — terrain |

**Adding a row.** Append it to the file of the row's slice (`decisions/slice-<letter>.md`; a new slice starts a new file and gets a line in the table above). A decision that belongs to no slice — a research topic, a gate, a release, a cross-slice bug fix — goes to `decisions/general.md`. Keep the four columns. When a slice's file passes about 120 KB, continue it in `decisions/slice-<letter>-2.md` and list that here.
