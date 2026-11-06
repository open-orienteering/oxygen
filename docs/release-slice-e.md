# Release runbook — slice E (full migration to the vector pipeline)

Slice E moves every event to the vector pipeline and removes the legacy one
(`docs/research/vector-map-pipeline/SLICES.md`, slice E; decision log
"Slice E re-cut"). It ships as two tags with one rollback boundary:

- **v0.6.0**: the flip and the code removal (rows E1–E4c, E6). The old
  columns and tables are kept and still written, so `./deploy.sh v0.5.0`
  remains a working rollback.
- **v0.6.1**: the drops (row E5). After it there is no image rollback past
  v0.6.0; the per-event dump is the floor.

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
(`map-store/backfill.ts`), and they are listed under information as
`removed_events_unsourced_maps`.

### Club production, 2026-11-05

Run with the v0.5.0 image: 14 live events (9 `legacy`, 5 `vector`), all
pinned; every must-be-zero list empty; 24 documents, all with an aligned
stack; 19 import jobs, all `done`. Two soft-deleted test events
(`Ny_karta_test`, `xx`) hold three map rows without a source. `map_tiles`
is 517 MB, freed by v0.6.1. No fix was needed.

## 1. v0.6.0

(The rest is written when E1–E4c and E6 have merged.)

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

**Rollback and E4a.** The upload still writes everything v0.5.0 reads —
`map_files.file_data` / `file_hash` / `render_key` / colour columns, the
`club_map_files` row — and a rotation change still refreshes
`render_key` and collects orphan tiles, so v0.5.0's tiles and prints
work after a rollback. Its image brings its own `rsvg-convert` and
fonts. Two things it rebuilds lazily: `club_map_files.preview_png` of a
club map uploaded under v0.6.0 (rendered on the first preview request),
and tiles of a map uploaded under v0.6.0 (rendered on first view, as
after any upload).

## 2. v0.6.1

(Written with E5.)
