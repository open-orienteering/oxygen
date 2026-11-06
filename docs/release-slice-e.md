# Release runbook — slice E (full migration to the vector pipeline)

Slice E moves every event to the vector pipeline and removes the legacy one
(`docs/research/vector-map-pipeline/SLICES.md`, slice E; decision log
"Slice E re-cut"). It ships as two tags with one rollback boundary:

- **v0.6.0**: the flip and the code removal (rows E1–E4c, E6). The old
  columns and tables are kept and still written, so `./deploy.sh v0.5.0`
  remains a working rollback.
- **v0.6.1**: the drops (row E5). After it there is no image rollback at
  all — v0.6.0's Prisma client selects columns the migration drops — so
  its rollback is a Cloud SQL backup taken just before (§2). The cutover
  record is `docs/migrations/2026-vector-map-pipeline.md`.

## 0. Preflight (row E0)

The flip assumes every live event's map has a pinned document. Check it on
the instance before deploying v0.6.0:

```bash
cd scripts/gcp
./db-job.sh jobs/map-survey.js --tag v0.5.0
```

`db-job.sh` runs a Node script against Cloud SQL as a one-off Cloud Run job
(`oxygen-db-<script>`) with the `oxygen-database-url` secret and the image's
`pg` client; the survey is read-only. Every list under **must be zero** has
to be empty:

| Line | Meaning | Fix |
|------|---------|-----|
| `unpinned_events` | a live event whose latest map has no document | `./backfill.sh` (re-runnable; it lists the import error per map) |
| `map_files_unsourced` | a live event's map row without `source_hash` | `./backfill.sh` |
| `club_files_unmigrated` | a club library map without its series | `./backfill.sh` |
| `courses_no_structure` | a live course without `courses.structure` | Maintenance → **Course structures** — on v0.5.0: v0.6.0 deletes the card and the CLI (E6). An instance upgrading straight from before slice D must run it on v0.5.0 first, or an OCAD-imported course's gaps, cuts and objects that only its GeoJSON holds are lost (it still reads from its columns) |
| `stack_unaligned` | a pinned document without lower / upper purple (`CourseStackError`: no course layer, no vector print) | re-match: `./backfill.sh --rematch` |

Soft-deleted events are left out: the backfill skips them on purpose
(`map-store/backfill.ts`, up to v0.6.0), and they are listed under
information as `removed_events_unsourced_maps`. The E5 migration's guard
checks the same two conditions as `map_files_unsourced` and
`club_files_unmigrated` (§2).

### Club production, 2026-11-05

Run with the v0.5.0 image: 14 live events (9 `legacy`, 5 `vector`), all
pinned; every must-be-zero list empty; 24 documents, all with an aligned
stack; 19 import jobs, all `done`. Two soft-deleted test events
(`Ny_karta_test`, `xx`) hold three map rows without a source. `map_tiles`
is 517 MB, freed by v0.6.1. No fix was needed.

## 1. v0.6.0

Rows E1, E2, E3, E3b, E4a, E4b, E4c and E6. What each changes for the
operator:

**The readers on the document (E1).** No migration. Every server reader
of map data — the event CRS, lengths, exports, control lat/lng, the
description autodetect, north, cut features, the club-map alignment —
reads the pinned map document; nothing parses `map_files.file_data` any
more (`docs/map-storage.md` §4.6). Uploads keep writing the legacy
columns (rollback).

**E2E on the new pipeline (E2).** Tests only.

**The flip's migration (E3).** `20261106120000_map_pipeline_flip` runs
with `pnpm db:migrate` before the stack: every event `vector`, the
column default `vector`, and the three flags (`map.pipeline.default`,
`map.pipeline.allowLegacy`, `map.editor.vector`) deleted. Nothing in
v0.6.0 reads the column or the flags (`docs/map-pipeline-switch.md`,
history note).

**The length source (E6).** `20261106130000_course_length_source` adds
`courses.length_source` and backfills it from `geometry_source`
(`editor` → `derived`, `ocd` / `xml` → `file`); v0.6.0's export and
Eventor sync read it instead of `geometry_source`
(`docs/course-controls-and-matching.md` "Course length"). Additive:
v0.5.0 ignores it, and v0.6.0 keeps writing `courses.geometry` and
`geometry_source` with the values v0.5.0 reads. Nothing in v0.6.0 reads
`courses.geometry`; the Maintenance tab's **Course structures** card and
`pnpm course:backfill-structure` are gone.

**Rollback to v0.5.0** stays possible until v0.6.1: the column and enum
are still there. v0.5.0 then reads `vector` for every existing event and
the absent flags as `default = legacy`, `allowLegacy = true`,
`editorVector = false` — tiles still regenerate, new events are
`legacy`, and the legacy course editor mounts. To get v0.5.0's pre-flip
behaviour (new events `vector`, the new editor) back, re-insert the
flags after rolling back:

```sql
INSERT INTO oxygen.settings (key, value) VALUES
  ('map.pipeline.default', 'vector'),
  ('map.editor.vector', 'true')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

Re-insert exactly the flags the instance had before the flip: note them
(`SELECT key, value FROM oxygen.settings WHERE key LIKE 'map.%'`) before
running the v0.6.0 migration.

**The image and the server's legacy code (E4a).** No migration. The
v0.6.0 API image has no `rsvg-convert` (`librsvg2-bin`) and no
`fonts-liberation`: printing embeds the bundled fonts. The server
renders no tiles (`/api/map-tile*`, `/api/club-map-preview/*` and
`/api/maps/:nameId/window.png` answer 404) and `map_tiles` is no longer
written; its rows (517 MB on the club's production database at E0) stay
until E5 drops the table. Tile env vars on the Cloud Run revision —
`MAP_TILE_BLOCK_TILES`, `MAP_TILE_SUPERSAMPLE`, `MAP_TILE_PRECACHE`,
`MAP_PRECACHE_*`, `MAP_RENDER_MAX_QUEUE`, `MAP_SVG_CACHE_EVENTS`,
`MAP_WINDOW_MAX_PIXELS` — are ignored and can be removed after v0.6.1
(v0.5.0 falls back to its defaults without them);
`MAP_RENDER_CONCURRENCY` and `PRINT_WORKERS` stay. The colour-stack
settings (the map-info select, the club card's select and north-lines
checkbox) are gone from the UI; the columns keep their values.

**Legacy web code and `MapLayoutEditor` (E4b, E4c).** No migration. The
tile viewer, the legacy course editor (`CourseEditorPage`), the replay
view's tile layer, the service-worker tile cache and the legacy layout
editor are gone; the Maps and Map templates pages' *Edit layout* opens
the course editor's Layout mode. A browser that still holds the old
`map-tiles` Cache Storage has it deleted on start.

**Description instructions in the new editor (E3b).** No migration. The
course inspector edits the finish variant and the special-instruction
rows the description sheet prints (they had no UI after E3).

**Rollback and E4a.** The upload still writes everything v0.5.0 reads —
`map_files.file_data` / `file_hash` / `render_key` / colour columns, the
`club_map_files` row — and a rotation change still refreshes
`render_key` and collects orphan tiles, so v0.5.0's tiles and prints
work after a rollback. Its image brings its own `rsvg-convert` and
fonts. Two things it rebuilds lazily: `club_map_files.preview_png` of a
club map uploaded under v0.6.0 (rendered on the first preview request),
and tiles of a map uploaded under v0.6.0 (rendered on first view, as
after any upload).

### 1.1 Land, tag and deploy v0.6.0

v0.6.0 is `vector-map-pipeline` **before** E5's merge (E6's merge,
`963b276`, plus the docs-only commits after it, `52b13a0`): E5 lands on
the same branch, so cut the release branch at that commit, not at the
branch head.

```bash
git fetch origin
git checkout -b release/slice-e-v0.6.0 52b13a0      # the last commit before E5's merge
gh pr create --base main --title "Slice E: every event on the vector pipeline (v0.6.0)" \
  --body "See docs/release-slice-e.md §1. Two migrations (the flip, length_source); the legacy columns are kept; rollback = v0.5.0."
# merge with a merge commit after green CI, then:
git tag v0.6.0 <main merge commit>
git push origin v0.6.0          # release.yml retags sha-… as v0.6.0 and stable
cd scripts/gcp
# First note the instance's map.* flags for a rollback (§1): the survey prints them (§0).
./deploy.sh v0.6.0              # migrate job (two migrations) then the service
```

Then the E-gate (`SLICES.md`): an event's map, the course editor on
desktop and phone, print, a readout map on the kiosk — on production.

## 2. v0.6.1

Row E5: one migration, `20261107120000_vector_map_pipeline_drops`, and
the code that only existed for the v0.5.0 rollback. Cutover record:
`docs/migrations/2026-vector-map-pipeline.md`.

**What it drops.** `map_tiles` (517 MB on production at E0, returned to
the instance at once — `DROP TABLE` needs no vacuum), `rendered_maps`,
`club_map_files`; `map_files.file_data`, `render_key`, `file_hash`,
`color_profile`, `color_overrides`, `north_lines_below`;
`events.map_pipeline` and its enum, `events.overprint_cuts_version`;
`courses.geometry`, `geometry_source`. Kept: `courses.length_source`,
`map_files.north_detection` (unwritten), the club series' colour-stack
columns (unused).

**What the code drops with them.** The upload's OCAD parse and its dual
writes (the pin writes the quick-access columns,
`docs/map-storage.md` §6.4); the base64 upload procedures
`course.uploadMap` and `clubMap.upload` (the web uploads every file in
chunks); the tile GC and render keys; the map-document backfill —
Maintenance → **Map documents** and `pnpm map:backfill` (the re-match now
imports a live map that has a source but no document; an older dump
restores through `restore-legacy-map-files.sql`,
`docs/backup-restore.md`); the course GeoJSON writer (lengths only,
`rebuildCourseLengths`). Event and club maps may now be Mapper files on
the server side (the web's pickers still offer `.ocd`).

### 2.1 Preflight

On the v0.6.0 image, with v0.6.0 deployed and the E-gate check done:

```bash
cd scripts/gcp
./db-job.sh jobs/map-survey.js --tag v0.6.0
```

- `map_files_unsourced`, `club_files_unmigrated` and
  `club_files_bytes_unsourced` must be **0** — they are the migration's
  guard (a club row must have its series and its bytes in `map_sources`). If not: `./backfill.sh --tag v0.6.0`, then
  survey again. (The backfill CLI is not in the v0.6.1 image.)
- `removed_events_unsourced_maps` lists soft-deleted events' map rows
  without a source: they keep their row and file name and **lose their
  bytes** with `file_data`. Expected on production: the three rows of
  `Ny_karta_test` and `xx` (E0). Nothing is purged; if one of them must
  be kept, restore the event (`events.removed = false`) and run the
  backfill before deploying.
- Note what else is set on the revision by hand (`gcloud run services
  describe oxygen --format='value(spec.template.spec.containers[0].env)'`):
  `deploy.sh` passes `--set-env-vars`, which replaces the revision's
  environment, so the retired tile `MAP_*` variables are only there if
  someone added them after a deploy.

Then take an on-demand backup — the only rollback after the migration:

```bash
source ./env.sh
gcloud sql backups create --instance="$SQL_INSTANCE" --project="$PROJECT_ID" \
  --description="before v0.6.1 (E5 drops)"
gcloud sql backups list --instance="$SQL_INSTANCE" --project="$PROJECT_ID" --limit=1
```

### 2.2 Deploy

Land `vector-map-pipeline` with E5 merged on `main` (a `release/slice-e-v0.6.1`
branch, merge commit, `git tag v0.6.1`, `release.yml`), as in §1.1. Then,
when nobody is using the instance:

```bash
cd scripts/gcp
./deploy.sh v0.6.1     # migrate job (the guard, then the drops), then the service
```

`deploy.sh` migrates **before** it deploys the service. For that window
— a minute or two — the v0.6.0 revision serves on the dropped schema:
its Prisma client selects `events.map_pipeline`, `courses.geometry` and
the dropped `map_files` columns, so most event pages answer 500 until the
v0.6.1 revision takes the traffic. Idle mode and an unused instance make
that acceptable (no maintenance mode exists).

**If the guard fails**, the migrate job exits non-zero with `E5 guard: n
map_files row(s) of live events have no source_hash …` (or `… club_map_files
row(s) have no club_map_id …`) and `deploy.sh` stops before the service:
nothing was dropped and v0.6.0 keeps serving. Prisma has recorded the
migration as failed (P3018) and refuses every later `migrate deploy` —
v0.6.0's too — with P3009 until it is marked rolled back (verified on a
scratch copy). Fix the data (§2.1: the backfill on v0.6.0), then:

```bash
source ./env.sh
gcloud run jobs update "${SERVICE}-migrate" --project="$PROJECT_ID" --region="$REGION" \
  --args=-c,"cd packages/api && node_modules/.bin/prisma migrate resolve --rolled-back 20261107120000_vector_map_pipeline_drops"
gcloud run jobs execute "${SERVICE}-migrate" --project="$PROJECT_ID" --region="$REGION" --wait
./deploy.sh v0.6.1     # redeploys the migrate job with its usual command
```

### 2.3 Smoke

- An event's map draws (dashboard, course editor desktop and phone).
- Upload a map to a test event (any size — every upload is chunked now);
  it imports and draws; the stale-north notice appears for a map whose
  lines lag.
- Settings → Maps: upload a club map, adopt it in an event (**From club
  library**).
- Print a course (`maps.pdf`); a readout map on the kiosk.
- Settings → Maintenance has no **Map documents** card.
- `map_tiles` is gone: the instance's storage drops by about 517 MB
  (Cloud SQL → Overview, or `SELECT pg_size_pretty(pg_database_size('oxygen'))`
  through `db-job.sh`).

### 2.4 After v0.6.1

- Remove any hand-set tile env vars found in §2.1 (`MAP_TILE_BLOCK_TILES`,
  `MAP_TILE_SUPERSAMPLE`, `MAP_TILE_PRECACHE`, `MAP_PRECACHE_*`,
  `MAP_RENDER_MAX_QUEUE`, `MAP_SVG_CACHE_EVENTS`, `MAP_WINDOW_MAX_PIXELS`):
  `gcloud run services update oxygen --remove-env-vars=<list>`. Keep
  `MAP_RENDER_CONCURRENCY` and `PRINT_WORKERS`.
- `jobs/map-survey.js` is a pre-v0.6.1 tool: its queries of the dropped
  tables now print `ERR` lines.
- A per-event dump taken before v0.6.1 restores with
  `restore-legacy-map-files.sql` and `pnpm map:rematch --event`
  (`docs/backup-restore.md`).

### 2.5 Rollback

There is no image rollback: neither v0.6.0 nor v0.5.0 runs on the
v0.6.1 schema. To go back, restore the §2.1 backup (it overwrites the
instance; anything written since is lost), then redeploy v0.6.0:

```bash
source ./env.sh
gcloud sql backups list --instance="$SQL_INSTANCE" --project="$PROJECT_ID"
gcloud sql backups restore <BACKUP_ID> --restore-instance="$SQL_INSTANCE" --project="$PROJECT_ID"
./deploy.sh v0.6.0     # its migrate job finds nothing to apply
```
