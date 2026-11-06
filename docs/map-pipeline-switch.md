# Map pipeline switch (history)

**Retired in E3 (2026-11-06).** Every event reads the vector pipeline;
nothing chooses between pipelines any more. This note records what the
switch was so older docs, decision-log rows and the v0.5.0 rollback make
sense. The research record is `docs/research/vector-map-pipeline/09-migration.md`
§3, §4; the decision-log rows are "Slice B, per-event switch (B5)" and
"E3, the flip".

## What it was (B5, 2026-10-22 → E3)

- **Instance flags** in `oxygen.settings`: `map.pipeline.default` (what a
  new event got, absent = `legacy`), `map.pipeline.allowLegacy` (whether
  an event could go back to `legacy` and whether tiles were a fallback)
  and, from slice D, `map.editor.vector` (whether the new course editor
  mounted). Read through a 30 s memo (`map-pipeline.ts`).
- **Per-event column** `events.map_pipeline` (`legacy | vector`): the
  pipeline the event read through. Written by `event.setMapPipeline` (the
  *Use new map engine* toggle in the editor's map-info row), copied by
  snapshots and the lease refresh.
- **What it gated:** the viewer (tiles or the GL layer), the tile
  pre-cache, the fallback to tiles without WebGL2, the print path
  (`maps.pdf` composer or rsvg, `X-Print-Pipeline`), the layout preview
  (`window.png`), and which course editor `/:nameId/course-editor` and
  the Maps pages' *Edit layout* opened.
- **E2E** ran the map specs once per value (projects `map-legacy` /
  `map-vector`).

## What replaced each rule

| Rule | Since E3 |
|------|----------|
| Viewer: tiles or vector | The GL layer draws the pinned document; a map without a pin shows its import state (`docs/map-rendering.md` §5.4) |
| Fallback to tiles (no WebGL2, lost context) | The layer's "cannot draw the map" message; a lost context remounts the layer once first (§5.4 "Layer") |
| Print path | Every event prints through the composer; an unaligned colour stack is a 400 with the reason (`docs/course-print.md` §8.1) |
| Editor mount, *Edit layout* | Always the course editor, Layout mode for *Edit layout* (`docs/course-editor.md` §1, `docs/course-layout.md` §4) |
| Tile pre-cache | Retired; a tile asked for directly is still rendered until E4a deletes the tile pipeline |
| Unreadable document (no OCAD fallback) | The viewer's load error with *Try again* (`map-rendering.md` §5.4 "Host"); print 400 "Pinned map document is missing" (`course-print.md` §10.1); no cuts (`course-layer.md` §4.2) — the answers of slices B and E1, unchanged |
| New events | `vector` from the column default |

## Rollback to v0.5.0

The E3 migration (`20261106120000_map_pipeline_flip`) sets every event to
`vector`, makes `vector` the column default and deletes the three flags.
The column and its enum stay until E5 (v0.6.1), so `./deploy.sh v0.5.0`
still works: that image reads `vector` for every existing event, absent
flags as `default = legacy`, `allowLegacy = true`, `editorVector = false`
(new events legacy, the legacy course editor). To get v0.5.0's pre-flip
behaviour back, re-insert the flags (`docs/release-slice-e.md` §1).
E5 drops the column and its enum.
