# Process stability: follow-ups

Left open by [process-stability.md](process-stability.md) (fix package 21).

- **Robust contour box for the terrain (MAP-2, D7).** A stray contour no longer exhausts memory, but it still
  coarsens the barrier raster and the field (about 1.5 mm field cell in the review's case). The fix changes
  `docs/map-terrain.md` §2.3/2.4 and needs a `TERRAIN_VERSION` bump.
- **No warning when an outlier coarsens the mask or raster.** No stat tells the user, and no named
  pre-allocation error is stored.
- **Maps whose padded contour box exceeds 2 m² of paper** get a coarser mask than before without a version bump;
  a height field cached before this change for such a map is not re-derived.
- **Worker `resourceLimits`** for the import and height-field workers.
- **Upstream ocad2geojson release.** Apply the patch in `patches/` to `open-orienteering/ocad2geojson`, tag
  `v2.2.2-oxygen.2`, bump `packages/api` and `packages/web`, then drop the patch and the
  `patchedDependencies` entry.
- **Main-thread `readOcad`** in `routers/course.ts` and `map-store/event-document.ts` no longer spins on a
  damaged file, but a large file still parses on the event loop; move it to a worker.
- **The Eventor push guard is per process.** Two Cloud Run instances can still upload at once; it needs an
  advisory lock or a row.
- **Eventor `sync` / `importEvent`** make several sequential calls, each bounded at 60 s, with no overall deadline
  and no in-flight guard.
- **Other outbound fetches without a timeout:** `liveresults.ts`, `sheetsBackup.ts`, and the google-auth-library
  token fetch in `sync/googleIdToken.ts`.
- **Peer timeouts are total-time, not idle-time.** A slow but live link moving a 4 MiB blob slice in over 120 s
  fails and retries from the slice start; there is no backoff between failed shipper cycles.
- **A timed-out forwarded or peer write may have landed** on the cloud; the retry safety of each forwarded
  mutation is not audited.
- **Shutdown does not await an in-flight shipper cycle or running import and DEM jobs.** Jobs are re-claimed,
  which now costs one of the 3 attempts; three redeploys mid-import abandon it.
- **No UI retry for `IMPORT_ABANDONED`;** re-uploading starts a new job.
- **`unhandledRejection` is logged, not counted or alerted on;** `uncaughtException` still crashes.
- **Upload `finalise`** still does up to 4096 single-row chunk reads and assembles up to 128 MiB in memory; there
  is no per-user cap on open uploads.
- **Docker rebuild (AGENTS.md §6 step 5) was not run** in the cloud container (no Docker daemon). The CI `image`
  job, which now has to copy `patches/` before install, is the proof.
