# 09 — Migration and rollback

Status: decided 2026-10-14 (recommendation §9). The specification is
written incrementally per slice as the living `docs/*.md` (README,
"Method"); this directory freezes as the record.
Depends on: every earlier topic — this one orders their delivery. Feeds:
the implementation plan (the specification that follows this research)
and the spike list (README).

## The question

Topics 01–08 describe a target. The system is in daily use, the next
season's events are already being planned in it, and the research so far
totals roughly 60 engineer-weeks of work. How does the target arrive
without a flag day, how is each step reversed if it fails in a club's
hands, and what disappears when?

Specifically:

1. **Release slices** — what ships together, in what order, each
   independently valuable and independently revertible.
2. **Coexistence** — how old and new pipelines live side by side per event
   while a slice is being proven, and what decides which one a user sees.
3. **Data migration** — turning today's rows (`map_files.file_data`,
   `club_map_files`, `courses.geometry`, `map_templates`/`course_maps`,
   `graphics`) into the new tables, idempotently and re-runnably.
4. **Rollback** — per slice: what a revert of the image restores, what the
   database keeps, and what cannot be undone.
5. **Retirement** — the list of code, tables, routes, env vars, image
   packages and docs that leave, and the release in which each leaves.
6. **Verification** — the gates for each slice beyond the AGENTS.md §6
   checklist, including the deferred spikes.

Out of scope: estimates of individual topics (each has its own §Effort);
the feature content itself.

## 1. What has to be replaced

Measured on the working tree (2026-10-12):

| Surface | Today | Size | Target |
|---------|-------|------|--------|
| Base-map screen rendering | `map-tiles.ts`, `map-window.ts`, `map-render-*.ts`, `TileLayer.tsx`, tile routes, pre-cache job, progress poll | ≈ 2 100 lines api + 500 web | 04 GL viewer over 02 documents (01, 07) |
| Overprint on screen | React SVG in `MapViewer.tsx` (3 554 lines, also gestures, GPS, selection) | — | 08 derived course layer drawn by 04; `MapViewer` becomes a thin host of the canvas + UI layer |
| Print | `course-maps/*.ts` (SVG composition, `rsvg-convert`, pdf-lib merge, `window.png`), `resolve-layout.ts`, `map-color-stack.ts` | ≈ 2 200 lines | 05 PDF backend of the shared stage; 08 `resolveSheet` |
| Layout editor | `MapLayoutEditor.tsx` (3 269 lines) | — | 08 Layout mode on the shared canvas |
| Course editor | `CourseEditorPage.tsx` (1 832 lines) + `MapPanel.tsx` wiring | — | 08 Course/Field modes |
| Import | `event-map.ts`, `club-map-preview.ts`, `map-north.ts`, `map-projection.ts`, `event-crs.ts`, base64 tRPC uploads | ≈ 1 400 lines | 06 pipeline, 07 chunked upload; north detection and projection reused inside stage 5 |
| Map object access | `event-map-objects.ts` (slim OCAD objects for autodetect and cuts), `description-autodetect.ts`, `overprint-cuts.ts` | ≈ 1 200 lines | Same algorithms over the 02 document's objects via shared-stage hit-testing / geometry; cuts become a symbolisation rule |
| Course import/export | `ocd-course-parser.ts`, `ppen-course-parser.ts`, `iof-course-parser.ts`, `course-import-align.ts`, `course-export.ts` | ≈ 1 900 lines | Write `structure` instead of (or in addition to) `geometry`; export per materialised variant |
| Storage | `map_files.file_data`, `club_map_files`, `map_tiles` (208 MB in dev), `rendered_maps`, `render_key` | — | 07 tables |
| Shared helpers | `packages/shared/src/course-maps/*` (3 280 lines: overlay SVG, schema, geometry, description sheet, label placement) | — | Schema and geometry kept; SVG emitters retired; label placement and description sheet become symbolisation |
| Tests | `course-editor.spec.ts` (16 tests), `course-maps.spec.ts`, `mobile-layout.spec.ts`, `club-map-library.spec.ts`, `webserial.spec.ts` (map after readout); integration `map-tiles`, `course-maps`, `club-maps`, `map-rotation`, `map-control-id-space` | — | Rewritten per slice against the new surfaces; fixtures from 04 §8 |
| Docs | `map-tile-rendering.md`, `course-maps.md`, `map-color-stack.md`, `course-editor.md`, `club-library.md`, `mobile-layout.md`, `deploy-gcp-cloud-run.md` sizing notes, `backup-restore.md`, `architecture.md`, `AGENTS.md` §7 | — | Replaced by the specification's docs as each slice lands |

Call sites that render a map and must survive every slice unchanged from
the user's point of view: `CompetitionShell` (persistent side pane via
`MapSlot`/`MapPane`), `KioskPage`, `CardReadout` + `CardMapPreview`
(post-readout map), `RunnerMapPreview`, `CompetitionDashboard`,
`TracksPage` and the replay (`ReplayMapLayer`), `CourseEditorPage`.

## 2. Principles

1. **Vertical slices, each shippable.** No slice depends on a later one
   to be useful; each removes something old or is gated so that it can
   be switched off.
2. **The document is the pivot.** The first thing that lands is import →
   document → storage (06/07/02). Everything else reads documents. Until
   a slice's consumer exists, the document sits unused next to the `.ocd`
   — cheap and harmless.
3. **Dual-write, single-read, per event.** During coexistence both
   pipelines' inputs exist (the `.ocd` *and* the document; `geometry`
   *and* `structure`), and a per-event switch chooses which pipeline
   *reads*. Writes never fork: one source of truth per datum, derived
   artifacts regenerated.
4. **Rollback is an image tag plus a flag, never a down-migration.**
   Migrations are additive (new tables, nullable columns) until the
   retirement release; an older image runs against a newer schema. Data
   that only the new pipeline writes is kept on rollback and resumes on
   roll-forward.
5. **Retire in the release after the last consumer leaves**, not in the
   same one, so the old path is one image tag away for a full release
   cycle.
6. **Spikes before commitment**: the two unknowns that could change
   decisions (04's phone budgets; 05's print-shop acceptance) are run
   before the slices that depend on them are scheduled (§7).

## 3. Switches

Two mechanisms, both already in the codebase's style:

- **Instance flags** in `oxygen.settings` (`getSetting`/`setSetting`,
  `db.ts`): `map.pipeline.default = legacy | vector` (what new events
  get), `map.pipeline.allowLegacy = true | false` (whether events may
  still be switched back). Read once per request, cached 30 s.
- **Per-event switch** `events.map_pipeline = legacy | vector`
  (default from the instance flag at event creation; existing events
  `legacy` until migrated). Exposed on the Event page's map panel as
  **Use new map engine** with a one-line explanation and a *Report a
  problem* link while `allowLegacy` is true.

The switch gates *reads*: which routes the web app calls (`/api/map-tile`
vs `/api/map-documents`), which print path `maps.pdf` takes, which editor
the route mounts. It never gates imports or writes — a `legacy` event
still gets a document on upload (slice A), and a `vector` event still gets
`courses.geometry` regenerated (slice C) until retirement. E2E runs the
affected specs under both values while both exist (a Playwright project
per value, selected specs only).

## 4. Release slices

Each slice is a release (or a group of releases) on `main`, behind the
switch where noted. Durations are calendar estimates assuming one
engineer plus review; they overlap where the dependency allows.

### Slice A — Import and storage (06, 07, 02; no user-visible change)

- Schema: 07 §4 tables; `map_files` gains `source_hash`, `document_hash`,
  `club_map_version_id` (nullable); `file_data` stays.
- Importer behind `applyEventMap` and `clubMap.upload`: every upload
  additionally produces a source row, a document and a report. Review UI
  not yet shipped; stage 6 runs in auto mode (03's safe matches) and
  records what would need review in the report.
- Chunked upload route next to the base64 one; the web uploader uses the
  new route when the file exceeds 8 MiB, else the old one (keeps E2E
  fixtures working untouched).
- **Backfill job** (Maintenance tab + CLI `pnpm map:backfill`): iterate
  `club_map_files` then `map_files` without `document_hash`, dedup by
  `file_hash` into `map_sources`, import, write hashes; idempotent;
  rate-limited to one map at a time; progress in `map_import_jobs`.
  Club rows become `club_maps` series with one version each; event rows
  whose `file_hash` matches a club version get `club_map_version_id`.
- Documents reachable at `/api/map-documents/:hash` (07 §6) for the spike
  viewer, with the full auth predicate.
- Rollback: older image ignores the new tables and columns. Nothing
  user-visible changed. Backfill is re-runnable.
- Gate: backfill of the development and the club's production database
  succeeds for every row with zero `error` jobs; corpus check
  (`measure-import.mjs`) zero unsupported-primitive warnings; 02
  determinism test; 07 integration matrix.

### Slice B — GL viewer (04, 01) behind the per-event switch

- `@oxygen/shared/render` shared stage + WebGL2 backend + worker, the 04
  fixtures and the reference raster (which also yields thumbnails and
  symbol previews for 06's review UI, shipped here).
- `MapViewer` gains a `VectorMapLayer` alternative to `TileLayer`; the
  overlay (controls, legs, GPS, tracks, replay) keeps rendering as React
  SVG **on top of the GL base map** in this slice — the overlay already
  works in paper-mm/screen-affine terms, so only the base layer changes.
  The viewport model moves from Web Mercator to paper space with
  `geoToPaper` for GPS/tracks (04 §7); the `northOffset` rotation becomes
  a viewport rotation.
- Import review UI (06 §5) ships here, since previews need the renderer.
- Switch `vector` on an event: every map call site shows the GL base map.
  Tiles for that event are no longer requested; the pre-cache job skips
  `vector` events.
- Rollback: flip the event (or the instance default) back; tiles still
  exist or regenerate. Image rollback also fine — the switch column is
  ignored by the older image.
- Gate: 04 phone budgets met on the Sprint and Crop-B maps (spike S1,
  §7); visual parity on the corpus against tiles for the sanctioned
  differences only (03 §6.9 rule); `webserial.spec.ts` post-readout map
  and `mobile-layout.spec.ts` green under `vector`; one real event run
  with `vector` on the organiser's own instance before `map.pipeline.default`
  flips.

### Slice C — Derived course layer and PDF (08 §4.1, 05)

- `courseLayer()` in shared; `MapViewer`'s overlay switches to course-layer
  objects drawn by the GL backend (the SVG overlay is deleted for the
  base map and the course; UI layer stays DOM/SVG for handles and menus).
  `courses.geometry` is regenerated by `courseLayer()` → GeoJSON on every
  write for one release (consumers: `CoursesPage` lengths, IOF export,
  journaling snapshot, kiosk until it reads the layer directly).
- PDF: `maps.pdf` routes through the 05 backend when the event is
  `vector`; `resolveSheet` wraps today's `resolve-layout.ts` data model
  (templates/sheets unchanged in this slice) so the page content is
  identical except for the sanctioned differences; three-way golden
  tests from 05 §8. `window.png` is served from the reference raster for
  the legacy layout editor while it still exists.
- Rollback: switch back → SVG/rsvg path. Both paths read the same
  template/sheet rows.
- Gate: golden PDFs on the corpus; one club print-shop preflight (spike
  S2); `course-maps.spec.ts` under both values; the structural
  `qpdf --check` in CI.

### Slice D — Editor phase 1 (08 §8) and layout mode

- New editor route mounts for `vector` events: Course + Layout + Field
  modes, `course_objects`, auto templates, checks, export menu. The
  legacy `CourseEditorPage` and `MapLayoutEditor` remain for `legacy`
  events.
- `courses.structure` written by the editor and by the course importers
  (OCD/PPen/IOF: linear structure, no groups); `course.update
  { controlIds }` writes a structure. `geometry` still regenerated.
- Templates: existing `map_templates` get an `auto_key` derived from
  their paper/orientation/scale; duplicates for the same key become
  `is_extra`. No sheet is moved or deleted.
- Rollback: switch back → old editors; the `structure` column is ignored,
  `geometry` is current because both are regenerated on every write.
- Gate: `course-editor.spec.ts` rewritten and green on desktop and on the
  mobile Playwright project; a setter plans one real event on the new
  editor end to end including print.

### Slice E — Default flip and retirement I

- `map.pipeline.default = vector`; all events migrated by a one-shot
  job (`vector` for every event whose document exists); `allowLegacy`
  stays `true` for one release.
- Remove: tile pre-cache job, `/api/map-tile-progress`, `TileLayer`,
  `MAP_*` env vars from docs and compose files, `rendered_maps` writes.
  Keep the tile *route* serving from existing rows only (no rendering)
  for the legacy switch.
- Docker image: `librsvg2-bin` leaves once the legacy PDF path is behind
  `allowLegacy` and `rsvg-convert` absence degrades to a clear error
  (already the behaviour, `course-maps.md`).
- Gate: one full season event cycle (planning → print → race day →
  results) on `vector` at the organiser's club; no `legacy` switch-backs
  recorded in the event log for two releases.

### Slice F — Editor phase 2 (variations, exchange, legs) and retirement II

- 08 phase 2 features; IOF export per variant; `ClassCoursePool`
  written by materialisation.
- `allowLegacy = false`; drop `events.map_pipeline`, legacy editors,
  `map-tiles.ts` and friends, `svg-to-pdf.ts`, `map-page-svg.ts`, the
  shared SVG emitters, `map_tiles` and `rendered_maps` tables,
  `render_key`, `map_files.file_data` (sources live in `map_sources`;
  the per-event dump already carries them, 07 §10), `club_map_files`
  (after a verified backfill, kept as a renamed backup table for one
  more release), base64 upload procedures, `courses.geometry` and
  `geometry_source` (consumers read `structure` + `courseLayer()`).
- Docs rewritten; `AGENTS.md` §7 and §15 updated; `docs/migrations/
  2026-vector-map-pipeline.md` records the cutover like
  `2026-drop-meos.md` does.

### Slice G — Map mode (08 phase 3) and offline print

- Patch layer and editing tools; promote to club version; browser-side
  PDF (05) and venue printing via the snapshot additions.

```
 A import+storage ──► B viewer ──► C course layer + PDF ──► D editor ph.1 ──► E flip ──► F ph.2 + retire ──► G map mode
      (06 07 02)       (04 01)         (08§4.1 05)              (08)                       (08)                 (08 03)
   S0 ────────────► S1 phone ─────► S2 print shop
```

## 5. Data migration details

| Data | How | Idempotent by |
|------|-----|---------------|
| `club_map_files` → `club_maps` + `club_map_versions` + `map_sources` + `map_documents` | Backfill job (slice A); settings (`color_profile`, overrides, `north_lines_below`, `rotation_correction`) copied to the series | `file_hash` on sources; `(club_map_id, seq)` on versions; the old row keeps a `migrated_to` column |
| `map_files.file_data` → `map_sources` + document | Same job; `club_map_version_id` set when the hash matches a club version | `file_hash` |
| `map_tiles`, `rendered_maps`, `render_key`, `preview_png` | Not migrated; dropped in F; `map_previews` regenerated on demand | — |
| `courses.geometry` → `courses.structure` | Slice D writer: `structure` from `course_controls` order (linear) on first write; a one-shot job fills it for every course; `geometry` regenerated by `courseLayer()` and compared (bbox and control positions) with the stored one — differences logged per course as a report, since imported `ocd` geometry carried file-authored cuts and bends that `structure` v1 keeps only via `LegProps.bends`/`gaps` extracted by the job | `structure IS NULL` |
| `map_templates` / `course_maps` | Kept; `auto_key`, `is_extra`, `section_index = 0`, `class_id = NULL` added | Column defaults |
| `graphics` | Kept; `raster_png` filled lazily for SVG rows at first print | `raster_png IS NULL` |
| `events.auto_overprint_cuts`, `overprint_cuts_version` | Cuts become a symbolisation rule with the same toggle; the version column is dropped in F | — |
| Backups taken before the cutover | Restorable into a post-A schema: the restore doc gains "run `pnpm map:backfill --event <slug>` after restoring a pre-vector dump" | — |

All jobs are `BEGIN … COMMIT` per row, log per-row outcomes to
`map_import_jobs` or the server log, and are safe to interrupt.

## 6. Rollback matrix

| Slice | Switch back | Image rollback | Irreversible |
|-------|-------------|----------------|--------------|
| A | n/a | Yes (new tables ignored) | Nothing |
| B | Per event / instance | Yes | Nothing (tiles regenerate) |
| C | Per event | Yes | Nothing (`geometry` kept current) |
| D | Per event | Yes; `course_objects`, `structure` ignored by the old image — edits made only in the new editor (course objects, variation prep) are not visible in the old one but are kept | New-editor-only data invisible under legacy |
| E | Per event while `allowLegacy` | Yes to the previous release only (tile rendering code gone) | Tiles for new uploads no longer exist |
| F | No | To the pre-F release only if `file_data`/`club_map_files` were not yet dropped — hence "renamed backup table for one more release" | Dropped tables after the grace release |
| G | Patch toggle (`map_patches` applied or not) | Yes | Promoted club versions are ordinary versions |

A restore from the per-event dump is the last resort at every stage and
is exercised in CI from slice A on (07 §12).

## 7. Spikes (deferred from 04/05; scheduled here)

| Id | Question | Before | Method | Exit criterion |
|----|----------|--------|--------|----------------|
| S0 | Does the importer handle the whole corpus and every OMAP construct in the sample set deterministically? | A ships | `measure-import.mjs` over the corpus + the OMAP samples; byte-identical re-import | Zero unsupported-primitive warnings; identical hashes on two machines |
| S1 | Do the 04 budgets hold on a mid-range Android phone for Sprint, Crop-B and Club-full, with the pilot symbol family through the real shared stage + WebGL2 backend? | B is scheduled | 04 §9 pilot (5xx, 101, 4xx + 407, 709, 7xx) on a Pixel-class device, throttled 4G, Playwright + manual | First frame ≤ 500 ms (event maps) / ≤ 2.5 s (Club-full) after download, 60 fps pan/zoom, GPU ≤ 30/150 MB; otherwise 04's fallbacks (deck.gl, simpler AA) are decided before B |
| S2 | Does a club print shop accept the 05 output (CMYK, IOF layering; `cmyk-offset` with ICC) without manual intervention? | C ships | Test-sheet generator + one real course map, sent to the club's usual shop in both modes | Preflight passes; printed purple and brown match the current workflow's output side by side |
| S3 | Is `qpdf`/`pdftoppm` available in the production image at acceptable size, or do golden tests stay CI-only? | C ships | Image size diff | ≤ 30 MB added or CI-only decided |
| S4 | Does the chunked upload + inline-start job behave on Cloud Run idle mode with a 36 MB file? | A ships | Upload Club-full to a staging revision in idle mode | Finalise + import completes via polling; no 32 MiB errors; no duplicate job execution |

S1 is the one that can change a decision (04's backend choice); it runs
first after A's shared-stage work exists, which is also why 04's effort
table front-loads the shared stage.

## 8. Verification per slice

Beyond AGENTS.md §6 (build, unit, integration, full E2E, Docker rebuild,
drift report) every slice adds:

- The 04 §8 fixture suite and three-way golden images (from B).
- The both-values E2E project for the specs the slice touches (B–E).
- A **corpus run** script (`.local/`, not committed, like the
  measurement scripts) that imports every corpus map, renders a reference
  raster of a fixed window, produces one PDF page, and diffs against the
  previous run — the regression net for real maps that fixtures cannot
  cover.
- A **club dry run** on the organiser's own instance before the slice's
  default changes: one real event planned/printed/raced on the new path
  (B, C, D, E gates above).
- Release notes per slice naming the switch, the rollback and the
  retirement planned for the next release.

## 9. Recommendation

1. **Seven slices in the order A–G** (§4), each a release behind the
   per-event `map_pipeline` switch where user-visible, each additive in
   schema until the retirement slices.
2. **Instance flag + per-event switch** (§3) gate reads only; imports
   and derived artifacts are dual-written from slice A so switching in
   either direction is instantaneous and lossless.
3. **Backfill as a resumable job** keyed by content hashes, exposed in
   Maintenance and as a CLI, re-run after restores of pre-vector dumps.
4. **Spikes S0–S4 scheduled** against the slices they protect, S1 first;
   04's backend choice is confirmed or changed by S1 before slice B is
   committed.
5. **Retire in two steps** (E: rendering jobs and env; F: code, tables,
   image packages, base64 uploads, `geometry`) with a renamed backup
   table and a full release between the last consumer and the drop.
6. **Rollback is image tag + switch**; the per-event dump is exercised in
   CI as the floor.
7. **Record the cutover** in `docs/migrations/2026-vector-map-pipeline.md`
   with the same shape as the MeOS migration record, and update
   `AGENTS.md` §7 (schema conventions: content-addressed tables, patch
   layer) and §15 (pitfalls: paper-space viewport, document immutability)
   in slice F.

## 10. Open questions carried forward

- **Kiosk during coexistence**: the kiosk map after a readout follows the
  event switch; a venue box checked out before slice B's flip serves
  whatever the snapshot carried — confirm the snapshot includes the
  document from slice A onward (07 §9.2) even while the event is
  `legacy`, so a mid-season flip needs no re-checkout.
- **Legacy-geometry fidelity**: imported `ocd` courses with file-authored
  bends and gaps are the one case where `structure` v1 may lose
  information (§5); the comparison report decides whether `LegProps`
  needs a `path` override before slice D.
- **Two Playwright projects** double the runtime of the affected specs;
  acceptable for the coexistence window (shards absorb it), but the list
  of dual-run specs should be explicit in `playwright.config.ts`.
- **Release cadence**: slices assume a release per slice; if releases are
  rarer, the "one release between last consumer and drop" rule turns
  into a calendar minimum (one month) to keep rollback practical.
