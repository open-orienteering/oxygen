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
| 04 | GL rendering: stack choice, colour-order drawing, lines/dashes/patterns/text on the GPU | Not started | — |
| 05 | Print: PDF generation from the same document, CMYK, print profiles | Not started | — |
| 06 | Import pipeline: OCAD/OMAP parsing, review, versioning, caching | Not started | — |
| 07 | Storage and delivery: Postgres vs. object storage, immutability, offline | Not started | — |
| 08 | Course editor domain model and feature roadmap, incl. the light-map-editing patch layer | Not started | — |
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
| 2026-10-07 | Scope | Light map editing (new/changed objects with existing or materialised symbols) is a stated future requirement. Not implemented initially; every topic keeps it possible. | Avoids a bolted-on editing layer later: objects reference source symbols only, canonical symbols are materialised into the source table, the format allows appends (02 §10, 03 §1). |
