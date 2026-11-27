# Oxygen documentation

Start with [features.md](features.md) for what Oxygen does and [architecture.md](architecture.md) for how it is built. [AGENTS.md](../AGENTS.md) §10 has the rules for writing docs.

## Specification chapters (top level)

The vector map pipeline's normative spec. Code cites these by path and section number, so they keep their names and numbering.

| Chapter | Covers |
| --- | --- |
| [map-document-format.md](map-document-format.md) | The map document codec, header and JSON projection |
| [map-import.md](map-import.md) | OCAD and OMAP import |
| [map-storage.md](map-storage.md) | Storage tables, routes, upload, import jobs, backfill |
| [map-symbols.md](map-symbols.md) | The canonical IOF symbol library, matching, colour layers |
| [map-rendering.md](map-rendering.md) | Pass stream, symbolisation, WebGL2 / raster / PDF backends, viewer, fixtures |
| [map-patches.md](map-patches.md) | Map corrections (patch layer) |
| [map-gps-tracks.md](map-gps-tracks.md) | GPS tracks |
| [map-terrain.md](map-terrain.md) | Contour graph, height field, DEM, 3D |
| [course-layer.md](course-layer.md) | The derived course layer |
| [course-editor.md](course-editor.md) | The course editor |
| [course-elevation.md](course-elevation.md) | Heights along a course: profile, climb, which field |
| [course-layout.md](course-layout.md) | Layout mode, templates and sheets |
| [course-print.md](course-print.md) | Course print and PDF |

Older course notes that share the prefix: [course-maps.md](course-maps.md), [course-controls-and-matching.md](course-controls-and-matching.md), [course-import-class-fallback.md](course-import-class-fallback.md).

## Folders

| Folder | What goes there |
| --- | --- |
| [guide/](guide/) | What each area of Oxygen does, in full: the detail behind the [feature tour](features.md) |
| [system/](system/) | Feature and subsystem design: authentication, offline and lease, readout, club library, imports and exports, mobile layout |
| [ops/](ops/) | Operator guides: Cloud Run deploy, venue box, demo, printers, backup and restore |
| [releases/](releases/) | Release policy, image tags, and one runbook per release |
| [dev/](dev/) | Test infrastructure and tooling: E2E sharding, Eventor stub, fixtures, lint policy, [route cost model calibration](dev/route-calibration.md) |
| [bugfixes/](bugfixes/) | One note per fixed bug, indexed by area in [bugfixes/README.md](bugfixes/README.md) |
| [migrations/](migrations/) | Data and dependency migrations (MeOS drop, vector pipeline, dependency sweeps) |
| [history/](history/) | Superseded notes and finished plans, kept for the record |
| [si-protocol/](si-protocol/) | SPORTident protocol notes and captures: [card memory layouts](si-protocol/card-layouts.md), [readout-station backup format](si-protocol/readout-backup-format.md), [Reader BT](si-protocol/reader-bt.md) |
| [research/vector-map-pipeline/](research/vector-map-pipeline/) | Frozen research record, decision logs, and the [work queue](research/vector-map-pipeline/SLICES.md) |
| [screenshots/](screenshots/) | Feature screenshots and how they are made, including private club-map shots ([screenshots/README.md](screenshots/README.md)); the demo fixtures are in `fixtures/showcase/` at the repository root |

The Eventor import and re-sync rules are in [system/eventor-sync.md](system/eventor-sync.md).

`node scripts/check-doc-links.mjs` checks that every Markdown link and every `docs/…` path in the repository resolves.
