# 2026 — The vector map pipeline replaces the raster one

From slice A (v0.2.0) to slice E (v0.6.1), Oxygen moved every map from the
raster pipeline — the OCAD file stored on the event row, parsed per
request, rendered to PNG tiles on the server and to SVG for print — to a
content-addressed **map document** imported once, drawn on the GPU in the
browser and composed to PDF from the same data. The specification is
`docs/map-*.md`, `docs/course-*.md`; the research and its decision log are
`docs/research/vector-map-pipeline/`; the work queue was `SLICES.md`. This
record summarises the new shape and the cutover operators run, as
`2026-drop-meos.md` does for the PostgreSQL move.

## New layout

- **Map bytes are content-addressed.** An uploaded file is a
  `map_sources` row (`file_hash` = SHA-256, `kind` `ocad` / `omap`, the
  bytes `STORAGE EXTERNAL`); its import is a `map_documents` row (`hash`
  of the encoded document, a header summary and the import report). Both
  are append-only and shared by every event and club map that uses the
  same bytes; a storage GC collects what nothing references after a grace
  (`docs/map-storage.md` §1–§3, §8).
- **Events and club maps pin hashes.** `map_files` holds an event's pin —
  `source_hash`, `document_hash`, `club_map_version_id` — plus the
  quick-access columns (`scale`, `bounds`, `north_offset`, `calibration`)
  the pin writes from the document, `rotation_correction` and
  `from_club_library`. No bytes. The club library is a series
  (`club_maps`) of editions (`club_map_versions`, each pinning a source
  and a document).
- **Uploads are chunked.** `POST /api/map-uploads` → `PUT …/chunks/:n` →
  `POST …/finalise` produces the source row; `course.applyUploadedMap` /
  `clubMap.addFromSource` make it an event's or the club's map and start
  an import job (a worker thread, polled; `docs/map-storage.md` §5–§6).
  OCAD and Mapper files.
- **Every reader reads the pinned document** — the event's CRS, the
  description autodetect, cut features, checks, north, print, the viewer
  (`docs/map-storage.md` §4.6). Nothing parses the original file after
  its import.
- **Courses are structures.** `courses.structure` (start … finish, leg
  properties) and the `controls` rows are the course; the course layer
  (`courseLayer()`, `docs/course-layer.md`) derives what the viewer,
  the editor and the print draw. `length_m` / `legs` are derived from it
  (`length_source = 'derived'`) or published by an imported file
  (`'file'`).
- **Gone:** server tiles (`map_tiles`), the rendered-map cache
  (`rendered_maps`), the legacy library (`club_map_files`), the event
  row's OCAD bytes and colour stack (`map_files.file_data`, `file_hash`,
  `render_key`, `color_profile`, `color_overrides`, `north_lines_below`),
  the per-event switch (`events.map_pipeline` and its enum), the cuts
  version stamp (`events.overprint_cuts_version`), the course GeoJSON
  artifact (`courses.geometry`, `geometry_source`), the base64 upload
  procedures (`course.uploadMap`, `clubMap.upload`), `rsvg-convert` in the
  image, the map-document backfill.

## Verified path

The schema applies cleanly to a fresh database and to a copy of a
populated one:

```bash
# Fresh: every migration, the E5 drops last.
DATABASE_URL='postgresql://oxygen:oxygen@localhost:5433/oxygen_scratch?schema=oxygen' \
  pnpm --filter @oxygen/api exec prisma migrate deploy

# A populated v0.6.0 database: a copy, so the original keeps its columns.
psql postgresql://oxygen:oxygen@localhost:5433/postgres \
  -c "CREATE DATABASE oxygen_copy TEMPLATE oxygen_test"
DATABASE_URL='postgresql://oxygen:oxygen@localhost:5433/oxygen_copy?schema=oxygen' \
  pnpm --filter @oxygen/api exec prisma migrate deploy
```

Row E5 ran the whole integration suite and the full E2E suite this way,
on copies of the shared test and E2E databases
(`INTEGRATION_DATABASE_URL`, `E2E_DB_PREFIX`, `docs/e2e-sharding.md`).
`packages/api/src/__tests__/integration/vector-map-pipeline-drops.test.ts`
tests the guard on a scratch database built to the migration before it.

A map then goes in through the chunked routes, as the web does:

```bash
curl -s -X POST "$API/api/map-uploads" -H 'x-event-id: itest' -H 'content-type: application/json' \
  -d '{"fileName":"test.ocd","bytes":'"$(stat -c%s e2e/test.ocd)"',"chunkBytes":8388608}'
# → {"uploadId":"…","chunkCount":1,"chunkBytes":8388608}
curl -s -X PUT "$API/api/map-uploads/$UPLOAD/chunks/0" -H 'x-event-id: itest' \
  -H 'content-type: application/octet-stream' --data-binary @e2e/test.ocd
curl -s -X POST "$API/api/map-uploads/$UPLOAD/finalise" -H 'x-event-id: itest'
# → {"fileHash":"…","bytes":…,"deduplicated":false}
curl -s -X POST "$API/trpc/course.applyUploadedMap" -H 'x-event-id: itest' \
  -H 'content-type: application/json' -d '{"fileHash":"…","fileName":"test.ocd"}'
curl -s -H 'x-event-id: itest' "$API/trpc/course.mapMetadata"   # documentHash, scale, bounds
```

## Migration

The slices' migrations were additive (new tables, nullable columns,
backfills an older image ignores) up to v0.6.0, so every release until
then could roll back by image. The data moved in place:

| Data | How | When |
|---|---|---|
| `club_map_files` → `club_maps` + `club_map_versions` + sources + documents | the map-document backfill (`pnpm map:backfill`, Maintenance card) | slice A; production verified at E0 |
| `map_files.file_data` → `map_sources` + a pinned document | same backfill | slice A; E0 |
| documents of older importers / library releases | the re-match pass (`pnpm map:rematch`) | slices B–D |
| `courses.geometry` → `courses.structure` (gaps, objects) | the structure backfill | slice D; run on v0.5.0 |
| every event `vector`, the switch's flags deleted | migration `20261106120000_map_pipeline_flip` | v0.6.0 (E3) |
| `courses.length_source` from `geometry_source` | migration `20261106130000_course_length_source` | v0.6.0 (E6) |
| the drops | migration `20261107120000_vector_map_pipeline_drops` | v0.6.1 (E5) |

**The drops migration's guard.** Before dropping anything it fails —
leaving the schema untouched — when any `map_files` row of a **live**
event (`events.removed = false`) has no `source_hash` (its OCAD bytes
would be lost), or any `club_map_files` row has no `club_map_id` (a club
map would be lost). Rows of soft-deleted events are not guarded: they
keep their row and file name and lose their bytes. On production E0
found exactly three such rows, all of two soft-deleted test events
(`Ny_karta_test`, `xx`); no event or row is purged. The fix for a guard
failure is the backfill on the v0.6.0 image (`scripts/gcp/backfill.sh
--tag v0.6.0`), then the Prisma recovery below and a retry.

What was not migrated, by design (09 §5): tiles, rendered maps, render
keys and PNG previews (caches; documents draw on demand),
`map_files.north_detection` (kept, unwritten — `report.north` replaced
it), the series' colour-stack settings (kept, unused).

**Restoring an older per-event dump.** A dump written before v0.6.1
carries `file_data` in its `map_files` section;
`packages/api/scripts/restore-legacy-map-files.sql` makes its bytes
sources and pins them, and `pnpm map:rematch --event <name_id>` imports
them (`docs/backup-restore.md` "Dumps written before v0.6.1").

## Cutover

The runbook is `docs/release-slice-e.md`: §0 preflight (E0), §1 v0.6.0,
§2 v0.6.1. In short, for v0.6.1:

1. v0.6.0 has run on production and the user's E-gate check passed.
2. Survey on the v0.6.0 image (`./db-job.sh jobs/map-survey.js --tag
   v0.6.0`): `map_files_unsourced` and `club_files_unmigrated` empty
   (the guard's two conditions); `removed_events_unsourced_maps` lists
   what loses its bytes.
3. An on-demand Cloud SQL backup.
4. `./deploy.sh v0.6.1`: the migrate job (the guard, then the drops),
   then the service. Between the two the v0.6.0 revision runs on the
   dropped schema and its event reads fail; deploy when nobody uses the
   instance.
5. Smoke: an event's map, a chunked upload, a club-library upload, print,
   a kiosk readout map.
6. Remove the tile `MAP_*` env vars from the revision if any were set by
   hand (`deploy.sh` replaces the revision's environment).

**Rollback.** None by image: the v0.6.0 image's Prisma client selects
columns the migration dropped, so neither v0.6.0 nor v0.5.0 runs on the
v0.6.1 schema. The rollback is restoring the step-3 backup, then
`./deploy.sh v0.6.0`; anything written since the backup is lost. A guard
failure needs no rollback — nothing was dropped and v0.6.0 keeps
serving — but Prisma records the migration as failed (P3018), and every
later `migrate deploy` (v0.6.0's too) refuses with P3009 until it is
marked rolled back (`prisma migrate resolve --rolled-back
20261107120000_vector_map_pipeline_drops`, `release-slice-e.md` §2).

## Status (November 2026)

| Slice | Release | What |
|---|---|---|
| A | v0.2.0 | import and content-addressed storage, chunked uploads, import jobs, the backfill |
| B | v0.3.0 | the GL viewer behind the per-event switch |
| C | v0.4.0 | the derived course layer and the composed PDF |
| D | v0.5.0 | the new course editor behind its gate |
| E | v0.6.0 | every event on the vector pipeline; the switch and the legacy code removed; columns kept for the v0.5.0 rollback |
| E5 | v0.6.1 | the drops |

Left for later rows (`SLICES.md`): the templates redesign (E-pages), the
showcase demo fixture on the document pipeline (still in the pre-v0.6.1
shape, `docs/demo.md`), the editor's phase 2 (slice F), map mode
(slice G).
