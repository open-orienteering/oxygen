# Process stability: a stray rejection, a bad map file or a hung peer could stop the API

Fix package 21 of the November 2026 full code review (`docs/reviews/2026-11-full-review.md`, IDs SYNC-39 / API-37i,
MAP-6, MAP-5 / DB-28, MAP-3, MAP-2, API-23, SYNC-21 / API-37a, EVT-13 / MC-45). Left-out edge cases are in
[process-stability-followups.md](process-stability-followups.md).

## What happened

- **Unhandled rejections killed the API (SYNC-39).** Node 24 terminates on an unhandled promise rejection, and
  `packages/api/src/index.ts` installed no handler. Docker or Cloud Run restarted the process, dropping every
  in-flight readout. `shutdown` had no re-entry guard (a second SIGTERM ran it twice) and no deadline (a hung
  step held the container until SIGKILL).
- **A database blip during a map import crashed the process (MAP-6).** The import worker's stage callback fired
  `progress()` with `void`, so a rejected `updateMany` at a stage boundary became an unhandled rejection.
- **An import that killed the process ran again after every restart (MAP-5 / DB-28).** `claim` re-took any
  `running` job with a stale heartbeat and counted nothing, so an out-of-memory import looped forever.
- **A truncated `.ocd` hung the import (MAP-3).** The ocad2geojson object-index loop caught every exception and
  never moved on, so it spun until the 10-minute job timeout; on the main-thread callers (course import from an
  OCAD file, the event document) it blocked the event loop with no timeout at all.
- **One stray contour far from the map allocated gigabytes (MAP-2).** The terrain mapped-area mask was sized from
  the raw contour bounding box at a fixed 0.5 mm cell with no budget.
- **`chunkBytes: 1` blocked the event loop (API-23).** A 128 MiB upload at one byte per chunk made `finalise`
  build and serialise a 134-million-entry missing list.
- **A black-holed link hung venue-to-cloud calls (SYNC-21).** The shipper and lease tRPC links had no timeout, so
  each call waited for undici's ~300 s default. (The venue forwarder was already bounded by package 20.)
- **Eventor calls had no timeout (EVT-13 / MC-45).** A stalled upload showed a failure in the UI at 2 minutes while
  the upload went on; pressing again started a second upload.

## How it was fixed

- `packages/api/src/process-guards.ts`: an `unhandledRejection` logger (`[process] unhandled rejection:` with the
  stack; the process keeps running) and `createShutdown`, which runs once and exits after at most
  `SHUTDOWN_DEADLINE_MS` (8 s), under the 10 s grace of Docker and Cloud Run.
- `map-store/jobs.ts`: stage reports go through `reportStage`, which logs a database error instead of
  rejecting. Import jobs carry an `attempts` count (migration `…_map_import_job_attempts`); after
  `IMPORT_MAX_ATTEMPTS` (3) stale claims the job fails with `IMPORT_ABANDONED` (and a promote job's pending
  version is cleaned up).
- ocad2geojson is patched in this repo (`patches/`, `patchedDependencies`) so every index loop stops on a read
  error, a loop or an out-of-range offset and records a warning; the importer refuses such a file with
  `DAMAGED_FILE`. The worker also has a 120 s parse timer.
- The terrain mask has a cell budget (`MASK_MAX_CELLS`, 8 M cells) and a typed-array flood stack. Ordinary maps
  are unchanged byte for byte, so `TERRAIN_VERSION` was not bumped.
- Uploads are capped at `MAX_UPLOAD_CHUNKS` (4096) chunks; a 409 from `finalise` lists at most 100 missing
  chunks plus `missingCount`.
- Node-to-node calls carry a per-call abort signal: 30 s for ordinary calls, 120 s for snapshot, blob and map-row
  transfers (`sync/peerTimeouts.ts`).
- Eventor requests time out at 30 s, the competitor download at 120 s and uploads at 60 s. An upload timeout is
  reported as `EVENTOR_OUTCOME_UNKNOWN` (check Eventor before pushing again), and a second push for the same
  event while one runs is refused with `EVENTOR_PUSH_IN_PROGRESS`.
