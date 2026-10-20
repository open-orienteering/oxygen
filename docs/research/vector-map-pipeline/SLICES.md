# Sub-slice index

The work queue for the vector map pipeline, one row per unit a single
session implements end to end. Coordinator sessions read this file to
decide what is ready; implementer sessions update their own row. The
normative content lives in the spec chapters (`docs/map-*.md`), each of
which ends in a "Pending in this chapter" section — this index only
orders that backlog and records who is on what.

Branch model: `vector-map-pipeline` is the long-lived integration branch.
Every sub-slice is a worktree cut from it and a PR back into it. Spike
branches may be cut from it and merged back the same way. `main` is not
involved until a slice's gate (09 §4) has passed and the user decides.

## Status values

| Status | Meaning |
|--------|---------|
| `ready` | Dependencies merged; may be started |
| `blocked: <ids>` | Waits for the listed rows to merge |
| `in progress: <session>` | A session owns it; nobody else touches its area |
| `review` | PR open against `vector-map-pipeline` |
| `done <date>` | Merged; decision-log row written |
| `manual` | Needs the user (corpus, staging, the club's instance) |

A row is `done` only when all of: spec section written or updated,
"Pending in this chapter" trimmed, tests per AGENTS.md §4 matrix, a
decision-log row in [README.md](README.md) naming deviations, PR merged.

Two rows whose **area** columns overlap are never in progress at the
same time. Verification steps that use fixed ports or shared databases
(`pnpm test:e2e*`, `playwright test`, integration tests, the Docker
rebuild) run through `scripts/with-verify-lock.sh`; a hook blocks bare
invocations.

## Slice A — import and storage (09 §4)

### Done

| Step | Decision-log row | Spec |
|------|------------------|------|
| Codec + OCAD normaliser | 2026-10-16 "Slice A, 02 codec" | `map-document-format.md`, `map-import.md` §3 |
| Symbol render IR at import | 2026-10-16 "Slice A, symbol IR" | `map-import.md` §3.3 |
| Storage tables + document route | 2026-10-16 "Slice A, storage + document route" | `map-storage.md` §1–4 |
| Import jobs + chunked upload | 2026-10-16 "Slice A, import jobs + chunked upload" | `map-storage.md` §5–6 |
| Backfill | 2026-10-16 "Slice A, backfill" | `map-storage.md` §6.7 |
| Matcher + colour alignment | 2026-10-18 "Slice A/B, matcher + colour alignment" | `map-symbols.md` §8–9 |
| OMAP import | 2026-10-18 "Slice A, OMAP import" | `map-import.md` §4 |

### Remaining

| Id | Sub-slice | Spec home | Research | Depends on | Area (files a session may touch) | Status |
|----|-----------|-----------|----------|------------|----------------------------------|--------|
| A5 | Previews: `map_previews` rows filled, per-symbol swatch render in the reference raster (point 3×, 30 mm line with corner + dash point, 15 × 15 mm area, text), `GET /api/map-documents/:hash/thumbnail.png`, `…/symbols/:idx.png`, `GET /api/library/:libraryId/:version/:code.png`, stage 10 derive (thumbnail only — metadata is the stage-9 header summary) | `map-storage.md` §4 + new §, `map-import.md` §1 stage 10 | 06 §5.2, 04 §4.1 | — | `packages/shared/src/render/reference-svg.ts` (+ new swatch module), `packages/api/src/map-store/`, document route file, `map_previews` writes | done 2026-10-19 (PR #37) |
| A6 | Review + decisions: `mapImport.review` / `decide` / `finalise`; new table `club_symbol_decisions` (fingerprint, canonical_id NULL, library_version, decided_by/at) written only by `decide`, read by stage 6 before the matcher; `decisions` job input wired (column exists, nothing reads it); re-match pass for documents stored under `ocad-3` / `none` library version | `map-symbols.md` §8 + §10, `map-import.md` §2.2 + §8, `map-storage.md` §6 | 06 §5.1, §5.3; 03 §6.5 | A5 (review payload carries preview URLs) | `packages/api/src/routers/mapImport.ts`, `packages/shared/src/import/match-document.ts`, `packages/api/src/map-store/import-worker.ts`, one Prisma migration, re-match CLI (landed in `packages/api/src/cli/`) | done 2026-10-19 (PR #40) |
| A7 | CRT export / import: `mapImport.exportCrt` / `importCrt` in OOM CRT syntax with the fingerprint in a comment; import maps codes → fingerprints via the current document | `map-symbols.md` §8 | 06 §5.1, 03 §10 | A6 | `packages/shared/src/import/` (crt codec), `routers/mapImport.ts` (A6 handed off `mapImport.documentSymbolFingerprints` as the base); landed in `map-store/crt.ts` | done 2026-10-20 (PR #44) |
| A8 | Storage housekeeping: daily GC with 30-day grace from `last_referenced_at` (RESTRICT FKs decide what is collectable), `GET /api/map-sources/:hash` streamed, "own running import job" as the fourth authorisation clause on the document route | `map-storage.md` §4.2, §8 | 07 §5, §6 | — | `packages/api/src/map-store/` (gc, source route, auth predicate), background-job registration | done 2026-10-19 (PR #38) |
| A9 | Club map CRUD reads `club_maps` / `club_map_versions` instead of mirroring into them; legacy `club_map_files` becomes write-through only | `map-storage.md` §6.5, `club-library.md` | 07 §4, 06 §6 | A8 (GC must exist before rows stop being mirrored) | `packages/api/src/routers/clubMap.ts` (+ new `club-map-library.ts`, `course.useClubMap`), `packages/web/src/pages/SettingsPage.tsx` (Maps tab; the row first said `MapsPage.tsx`), `MapPanel.tsx` picker, `e2e/club-map-library.spec.ts` | done 2026-10-19 (PR #41) |
| A10 | Documents join the venue checkout snapshot even while the event is `legacy`; backups by hash; restore doc gains "run `pnpm map:backfill --event <slug>` after restoring a pre-vector dump" | `map-storage.md` §7 + §9, `backup-restore.md` | 07 §9.2, §10; 09 §5, §10 | — | venue checkout / snapshot and backup code in `packages/api/src/` (planner locates), `docs/backup-restore.md` | done 2026-10-19 (PR #39) |
| A11 | Stage 5 beyond bounds (north detection and projection reused from `map-north.ts` / `map-projection.ts` inside the normaliser) | `map-import.md` §3.5, §3.8 | 06 §4.1 stage 5 | — | `packages/shared/src/geo/` (new `mapGeo`), `packages/shared/src/import/ocad-source.ts`, `omap-source.ts`; `packages/api/src/map-north.ts` / `map-projection.ts` became adapters | done 2026-10-19 (PR #42; `format.importer` → `ocad-5` / `omap-2`) |
| S0 | Corpus spike: `measure-import.mjs` over `.local/corpus` + OMAP samples; zero unsupported-primitive warnings; identical hashes on two machines | 09 §7, `map-import.md` §7 | 06 §9 | A11 | `scripts/measure-import.mjs` (committed dev tool; the corpus stays in `.local/`); fixes land as ordinary rows | manual — 2026-10-20 run on the dev laptop: 0 import errors, 8/8 `sameAsPrevious` across processes, 48 unsupported-primitive warnings → A12–A14 (two `ocad-6` fixes landed with it); the user runs the second-machine hash comparison (`--previous` with this run's `--hashes`) and re-runs after A12–A14 |
| A12 | OCAD reader gaps from S0: a fork release of `ocad2geojson` that parses rectangle (type 7) and line-text (type 6) symbols and the text framing parameters its `TODO` skips (colour, width, shadow offsets); normaliser maps OCAD line framing (`frMode` 2) to the existing text `halo` and line-text symbols to the text IR; rectangle symbols either get an IR form or a by-design drop recorded in the spec (user decides); `READER_WARNING` texts kept in the report as §3.6 first said; `ocad-7` | `map-import.md` §3.3, §3.6, §5 | 03 Appendix C; 06 §3.1 | — | `open-orienteering/ocad2geojson` (fork), `packages/api/package.json` + lockfile, `packages/shared/src/import/ocad-{source,symbols}.ts` + tests, `scripts/generate-test-ocd.mjs` / `e2e/test.ocd` | ready |
| A13 | IR gaps from S0 that need the shared stage: text shadow (OCAD `frMode` 1, Mapper framing mode 2), vertical text anchor (OCAD `alignment & 0xfc`, Mapper `TEXT_VERTICAL_ALIGNMENT_DROPPED`), Mapper text boxes (`TEXT_BOX_DROPPED`), an OCAD framing line narrower than its main line (shows only in dash gaps), Mapper combined symbols with a second border pair (502.2); each is an IR field plus its symbolisation, or a by-design drop the user accepts for A's gate | `map-import.md` §3.3, §4.3; `map-rendering.md` §3–4 | 03 §6.8; 04 §4 | B1 (same files) | render IR types and `packages/shared/src/render/symbolise.ts` (B1's area), `packages/shared/src/import/{ocad,omap}-symbols.ts` | blocked: B1 |
| A14 | Warning taxonomy from S0: a code for a stale area-border reference (a source data error — Club-full's six areas that point at themselves) apart from `SYMBOL_FEATURE_DROPPED`; per-symbol warning detail in the import report, since the header keeps only the first message per code (Club-full's 16 `SYMBOL_FEATURE_DROPPED` show as one message); `measure-import.mjs` gate updated with the spec | `map-import.md` §3.3, §3.6, §7; `map-document-format.md` §2.6 | 06 §4.4 | — | `packages/shared/src/import/{ocad,omap}-symbols.ts`, `ocad-source.ts`, `omap-source.ts`, `report.ts`, `scripts/measure-import.mjs` | ready |
| S4 | 36 MB upload + inline-start job on Cloud Run idle mode | 09 §7 | 07 §7–8 | — | staging revision | manual |
| A-gate | Backfill of the club's production database with zero `error` jobs; 07 integration matrix green; S0 green | 09 §4 A | — | all of A5–A14, S0 | club admin runs `pnpm map:backfill` | manual |

Waiting on later slices, not A: S2 confirmation of the provisional
§3.3 rows (slice C), Mapper sources as event/club map *apply* (slice C),
`ISMTBOM2022` / `ISSkiOM2019` libraries, Swedish names, contact sheet,
library variants for template conventions (only if the auto rate needs
to rise), `defaultMapAppearance` retirement (slice C).

## Slice B — GL viewer (09 §4)

Split 2026-10-20 from 09 §4 B, S1 §6 (build order the numbers support:
indexed strips → visible-set indices → worker → zoom-gated buckets →
MSDF text), 04 §6–8, 06 §5 and 09 §3. The spike drew the whole document
every frame with 13 pilot symbols; B turns that into the viewer behind
the per-event switch. Four rows can start at once (B1, B2, B6, B7 —
disjoint areas); B3/B4 follow B2, B5 follows B4.

### Done

| Step | Decision-log row | Spec |
|------|------------------|------|
| S1 render spike (shared stage, WebGL2 backend, corpus measurements) | 2026-10-15 "S1 spike" | `S1-render-spike.md`, `map-rendering.md` §1–6 |
| Canonical library `ISOM2017-2` + `ISSprOM2019-2` | 2026-10-16 "Slice B, canonical library" | `map-symbols.md` §1–7 |

### Remaining

| Id | Sub-slice | Spec home | Research | Depends on | Area (files a session may touch) | Status |
|----|-----------|-----------|----------|------------|----------------------------------|--------|
| B0 | Real-phone baseline (S1 residual): Pixel-class device, throttled 4G, `/dev/map-gl-doc?mode=envelope` on Sprint envelope and Club-2026 pilot; record first frame, frame GPU, resident GPU in `map-rendering.md` §5.2 | `map-rendering.md` §5.2 | 04 §9, S1 §6 | — | dev page only; numbers into the spec | manual (user; a baseline for B2, not a blocker) |
| B1 | Full-library symbolisation: the shared stage must symbolise every IR primitive the library (`ISOM2017-2`, `ISSprOM2019-2`) and the importers produce, not only the 13 pilot symbols — remaining placement/dash/pattern/text rules, the provisional §4.2–4.3 rows resolved where S2 is not needed; the 04 §8 fixture rows 1–9, colour order and precision as pass-stream assertions (`__fixtures__/streams/`) plus goldens (reference raster ↔ WebGL2; PDF tier waits for C); whole-library symbolisation of both editions warning-free; documents through `map-document/render-bridge.ts` (the `ocad-objects.ts` spike path stays dev-only) | `map-rendering.md` §3–4, §6 | 04 §4, §8; 03 §6.9 | — | `packages/shared/src/render/{symbolise,dash,placement,pattern,text,glyph-table}.ts`, `__fixtures__/`, `packages/shared/src/map-document/render-bridge.ts`, `e2e/map-gl-golden.spec.ts`, `e2e/__golden__/map-gl/` | ready |
| B2 | GPU arena and buckets: strokes as indexed strips (S1 §4.1), per-object range table and visible-set index buffers per (colour, kind) (04 §6.8, §7 — required for the phone budget), glyph meshes of one colour merged into one buffer (draw calls < 300 on Sprint), 50 mm buckets + large-object bucket, zoom-gated preparation and LRU eviction under the 30 / 150 MB budgets (04 §6.11), symbolise + prepare in a worker, GPU timer and bench kept on `/dev/map-gl-doc`; measured against 04 §9 on the corpus with the dev page | `map-rendering.md` §5.2 (rewrite "Preparation", "Batching", add "Arena and buckets", "Worker") | 04 §6.2, §6.8, §6.11, §6.12, §7; S1 §4, §6 | — (pilot stream suffices; re-measure after B1 merges) | `packages/web/src/map-gl/{prepare,batch,renderer}.ts` + new `arena.ts`, `buckets.ts`, `worker.ts`; `packages/web/src/pages/dev/MapGlDocPage.tsx`; `e2e/map-gl-doc.spec.ts` | ready |
| B3 | MSDF text: atlas generation (Liberation Sans + Narrow; ASCII + Latin-1 Supplement + Latin Extended-A at 32 px; Cyrillic as a second page generated only when a document's header lists such characters — S1 §5), text passes drawn from the atlas instead of instanced outlines, halos as the stroked variant, screen-only LOD skips (04 §6.11) | `map-rendering.md` §4.9–4.10, §5.2 | 04 §4.4, §6.7; S1 §5 | B2 (text goes through the arena) | `packages/web/src/map-gl/text-atlas.ts` + renderer text path, an atlas build script under `packages/web/scripts/` or `scripts/`, `packages/shared/fonts/` | blocked: B2 |
| B4 | Viewer integration: `VectorMapLayer` as the alternative to `TileLayer` inside `MapViewer`; viewport model in paper space with `northOffset` as a viewport rotation; GPS, tracks, replay through `geoToPaper` (A11's `mapGeo`); the overlay (controls, legs, GPS, tracks, replay, selection) stays React SVG on top; documents fetched from `/api/map-documents/:hash` with CacheFirst + `storage.persist()` (`map-storage.md` §7 pending); every call site in 09 §1 (CompetitionShell/MapSlot/MapPane, KioskPage, CardReadout + CardMapPreview, RunnerMapPreview, CompetitionDashboard, TracksPage + ReplayMapLayer, CourseEditorPage) unchanged from the user's point of view | `map-rendering.md` new §5.4 "Viewer", `map-storage.md` §7 | 04 §7; 01 §9; 07 §9 | B2 (arena API); goldens from B1 before the gate | `packages/web/src/components/MapViewer.tsx` (host only), new `VectorMapLayer.tsx`, `map-pane-shared.ts`, `packages/web/src/lib/` viewport + document cache, service-worker config; `TileLayer.tsx` untouched | blocked: B2 |
| B5 | Per-event switch and instance flags: `events.map_pipeline = legacy \| vector` (migration, default from `map.pipeline.default`), `map.pipeline.allowLegacy`, Event page toggle **Use new map engine** with one-line explanation and *Report a problem* link while `allowLegacy`; reads only — routes the web app calls and the editor mounted; tile pre-cache job skips `vector` events; a Playwright project per value for an explicit list of specs in `playwright.config.ts` (09 §10) | new `docs/map-pipeline-switch.md` (09 §3 as rules), `AGENTS.md` §7 pointer | 09 §3, §4 B, §10 | B4 (something to switch to) — the column, settings and toggle may be pulled forward if B4 runs long | Prisma migration, event router + settings (`db.ts` `getSetting`), event settings page, `packages/api/src/map-tiles.ts` pre-cache gate, `playwright.config.ts`, `e2e/` | blocked: B4 |
| B6 | Import review UI (06 §5): a review screen for a document — `ReviewRow` list sorted by usage with unused symbols collapsed, source swatch beside the top-3 candidate swatches (A5 preview routes), accept / unmatch / reset, finalise, CRT export/import (A7), job progress; reached from the club library card (expected for club maps) and the event map panel (optional for event maps); i18n en + sv; E2E against `e2e/test.ocd` | `map-symbols.md` §8 (UI subsection), `club-library.md`, `docs/features.md` | 06 §5 | — (API from A5–A7 is merged; no GL needed, previews are reference-raster PNGs) | new `packages/web/src/pages/MapReviewPage.tsx` (or Settings → Maps panel), `MapPanel.tsx` entry point, `packages/web/src/i18n/locales/{en,sv}/`, new `e2e/map-review.spec.ts` | ready |
| B7 | Library polish: contact sheet (golden render per entry at 10× via the reference raster, committed for visual review in PRs), Swedish names, aliases — the `map-symbols.md` §10 items that do not wait for C | `map-symbols.md` §3, §6, §10 | 03 §6.4 | — | `packages/shared/src/symbol-library/`, `packages/api/src/render/golden.ts`, `e2e/__golden__/` | ready (low priority) |
| B-gate | 04 phone budgets met on Sprint and Crop-B on the B0 device; visual parity on the corpus against tiles for the sanctioned differences only (03 §6.9 rule; a `.local` parity script); `webserial.spec.ts` post-readout map and `mobile-layout.spec.ts` green under `vector`; one real event run with `vector` on the organiser's instance before `map.pipeline.default` flips | 09 §4 B | — | B1–B6 | user + club | manual |

## Decision gates

G1 concurrent editing — open; must be recorded before the C/D spec
chapters are written (README, "Decision gates").
