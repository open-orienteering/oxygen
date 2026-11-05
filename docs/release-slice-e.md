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
| `courses_no_structure` | a live course without `courses.structure` | Maintenance → **Course structures** |
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

(Written when E1–E4c and E6 have merged.)

## 2. v0.6.1

(Written with E5.)
