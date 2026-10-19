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
| A5 | Previews: `map_previews` rows filled, per-symbol swatch render in the reference raster (point 3×, 30 mm line with corner + dash point, 15 × 15 mm area, text), `GET /api/map-documents/:hash/thumbnail.png`, `…/symbols/:idx.png`, `GET /api/library/:libraryId/:code.png`, stage 10 derive (thumbnail, metadata columns) | `map-storage.md` §4 + new §, `map-import.md` §1 stage 10 | 06 §5.2, 04 §4.1 | — | `packages/shared/src/render/reference-svg.ts` (+ new swatch module), `packages/api/src/map-store/`, document route file, `map_previews` writes | review |
| A6 | Review + decisions: `mapImport.review` / `decide` / `finalise`; new table `club_symbol_decisions` (fingerprint, canonical_id NULL, library_version, decided_by/at) written only by `decide`, read by stage 6 before the matcher; `decisions` job input wired (column exists, nothing reads it); re-match pass for documents stored under `ocad-3` / `none` library version | `map-symbols.md` §8 + §10, `map-import.md` §2.2 + §8, `map-storage.md` §6 | 06 §5.1, §5.3; 03 §6.5 | A5 (review payload carries preview URLs) | `packages/api/src/routers/mapImport.ts`, `packages/shared/src/import/match-document.ts`, `packages/api/src/map-store/import-worker.ts`, one Prisma migration, re-match CLI under `packages/api/scripts/` | blocked: A5 |
| A7 | CRT export / import: `mapImport.exportCrt` / `importCrt` in OOM CRT syntax with the fingerprint in a comment; import maps codes → fingerprints via the current document | `map-symbols.md` §8 | 06 §5.1, 03 §10 | A6 | `packages/shared/src/import/` (crt codec), `routers/mapImport.ts` | blocked: A6 |
| A8 | Storage housekeeping: daily GC with 30-day grace from `last_referenced_at` (RESTRICT FKs decide what is collectable), `GET /api/map-sources/:hash` streamed, "own running import job" as the fourth authorisation clause on the document route | `map-storage.md` §4.2, §8 | 07 §5, §6 | — | `packages/api/src/map-store/` (gc, source route, auth predicate), background-job registration | ready |
| A9 | Club map CRUD reads `club_maps` / `club_map_versions` instead of mirroring into them; legacy `club_map_files` becomes write-through only | `map-storage.md` §6.5, `club-library.md` | 07 §4, 06 §6 | A8 (GC must exist before rows stop being mirrored) | `packages/api/src/routers/clubMap.ts`, `packages/web/src/pages/MapsPage.tsx` (club library), `e2e/club-map-library.spec.ts` | blocked: A8 |
| A10 | Documents join the venue checkout snapshot even while the event is `legacy`; backups by hash; restore doc gains "run `pnpm map:backfill --event <slug>` after restoring a pre-vector dump" | `map-storage.md` §7 + §8, `backup-restore.md` | 07 §9.2, §10; 09 §5, §10 | — | venue checkout / snapshot and backup code in `packages/api/src/` (planner locates), `docs/backup-restore.md` | ready |
| A11 | Stage 5 beyond bounds (north detection and projection reused from `map-north.ts` / `map-projection.ts` inside the normaliser) | `map-import.md` §3.5, §8 | 06 §4.1 stage 5 | — | `packages/shared/src/import/ocad-source.ts`, `omap-source.ts`; may move pure parts of `packages/api/src/map-north.ts` / `map-projection.ts` to shared | ready |
| S0 | Corpus spike: `measure-import.mjs` over `.local/corpus` + OMAP samples; zero unsupported-primitive warnings; identical hashes on two machines | 09 §7 | 06 §9 | A11 | `.local/` scripts (not committed); fixes land as ordinary rows | manual (user runs, agent fixes findings) |
| S4 | 36 MB upload + inline-start job on Cloud Run idle mode | 09 §7 | 07 §7–8 | — | staging revision | manual |
| A-gate | Backfill of the club's production database with zero `error` jobs; 07 integration matrix green | 09 §4 A | — | all of A5–A11 | club admin runs `pnpm map:backfill` | manual |

Waiting on later slices, not A: S2 confirmation of the provisional
§3.3 rows (slice C), Mapper sources as event/club map *apply* (slice C),
`ISMTBOM2022` / `ISSkiOM2019` libraries, Swedish names, contact sheet,
library variants for template conventions (only if the auto rate needs
to rise), `defaultMapAppearance` retirement (slice C).

## Slice B — GL viewer (09 §4)

Started ahead of A's completion because S1 needed the shared stage.
Not yet split into sub-slices; do that when A5–A11 are in review.

| Step | Status | Spec |
|------|--------|------|
| S1 render spike (shared stage, WebGL2 backend, corpus measurements) | done 2026-10-15 | `S1-render-spike.md`, `map-rendering.md` §1–6 |
| Canonical library `ISOM2017-2` + `ISSprOM2019-2` | done 2026-10-16 | `map-symbols.md` §1–7 |
| Real-phone frame GPU measurement (S1 residual) | manual, first task of B | 04 §9 |
| `VectorMapLayer` in `MapViewer`, paper-space viewport, `geoToPaper` | not split | `map-rendering.md` §5.2 |
| Import review UI (needs A5/A6 and the renderer) | not split | 06 §5 |
| Per-event switch `events.map_pipeline`, instance flags | not split | 09 §3 |

## Decision gates

G1 concurrent editing — open; must be recorded before the C/D spec
chapters are written (README, "Decision gates").
