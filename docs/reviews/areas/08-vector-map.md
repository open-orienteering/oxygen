# Area 08: vector map pipeline

Part of the November 2026 full review (merge target: `docs/reviews/2026-11-full-review.md`). Review only; no code was changed.

- **Code reviewed:** `main` at `df5460c3`, plus the terrain part of PR 254 (`claude/project-thread-avzbks`, `packages/shared/src/terrain/profile/`).
- **Scope:** OCAD/OMAP importers, symbol and colour matching, import jobs and uploads, the club map library, map documents and their storage, patches (Map-mode corrections), colour settings, GC, DEM and height fields, previews, the web map editor's state and persistence, the renderer (shared `render/`, `symbol-library/`, web `map-gl/`, `VectorMapLayer`), and terrain derivation plus the 3D client.
- **Method:** the area was split into four sub-areas: import and upload (IMP), documents, patches and editor (DOC), renderer (REN), and terrain (TER). Each sub-area got its own fresh Fable reviewer. Every one of the 30 findings then went to a separate fresh Fable verifier. The verifier saw only the claim and its location, not the reviewer's evidence, and was asked to disprove it. No finding was refuted outright. One half-finding was refuted and dropped: `clubMap.rename` being open to everyone is documented behaviour. Severities and fixes below take the verifier's corrections into account. Where reviewer and verifier disagreed on severity, the verifier's lower rating is used and the disagreement is noted.
- **Original IDs:** each finding keeps its sub-area ID in brackets (for example `[IMP-1]`). The scratch reproductions are not in the repo.

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 14 |
| Low | 15 |

No finding loses or corrupts a stored map document or patch. The server patch writes, GC, the document codec and colour-settings locking were read closely and found sound. The weak spots are stability on bad input (a damaged file hangs the import worker, and a stray object far from the map exhausts memory), the import job queue (a forgotten `catch` can exit the API, and a job that kills the process is re-run indefinitely), and one authorisation hole in the club library.

**Five to fix first**

1. **MAP-1:** official course climb from contours rests on a hard-coded 5 m or 2.5 m contour interval. Settle this before PR 254 merges.
2. **MAP-6:** an unhandled rejection in import progress reporting exits the API process. S fix.
3. **MAP-5:** import jobs have no attempt limit, so a job that kills the process crash-loops the API. Mirror the guard the DEM queue already has.
4. **MAP-2:** one stray contour far from the map makes the terrain derive allocate gigabytes inside the API process. The mask cell budget alone is an S fix.
5. **MAP-3:** a truncated `.ocd` spins the import worker for 10 minutes and blocks every other import.

Next in line is MAP-4: any signed-in user can obtain another uploader's original map file.

**Needs Marcus's decision before code.** These findings change behaviour that a spec chapter documents on purpose, so the project rule (answer first, then the spec, then the code) applies: MAP-1 (how to source the interval), MAP-2 part 1 (robust contour box), MAP-7 (keeping the old pin during a map replace), MAP-14 (wording only), MAP-18 (an exit from a dormant patch), MAP-19 (retry after a second context loss).

## High

### MAP-1 [TER-2]: (PR 254) Official course climb from the plain contour field rests on a hard-coded contour interval that nothing can override
- **Area:** terrain. **Category:** functional. **Severity:** high for PR 254 as it stands; low on `main` alone, where only the 3D vertical scale and the pick's `heightM` are affected.
- **Location:**
  - `packages/shared/src/terrain/index.ts:34-36` (`contourIntervalM`: `ISSprOM*` gives 2.5 m, anything else 5 m).
  - `packages/api/src/map-store/heightfield-worker.ts:21` and `packages/api/src/map-store/dem-worker.ts:54` (both call without `opts.intervalM`).
  - PR 254: `packages/shared/src/terrain/profile/pick.ts:48` and `profile/profile.ts:48`.
  - `packages/shared/src/terrain/anchor/anchor.ts:181` (`intervalSuspect` is computed, but nothing in api or web reads it).
- **What is wrong:** every height in a `contours` field is `level × intervalM`, and `intervalM` is never read from the map or settable per map. PR 254 makes the climb from this field the course's stored, printed and Eventor-exported climb whenever no anchor-grade ground model exists. A coarse-DEM anchored field is also affected, for chains without a DEM height. The error is the ratio of the assumed interval to the true one. The research already named the interval as a prerequisite for climb from contours (`docs/research/vector-map-pipeline/08-course-editor.md:122, 218`, and `docs/map-terrain.md` §6.0 answer 2, "the per-map override stays later"). Neither "Pending in this chapter" section lists it.
- **Scenario:** an ISOM forest map drawn with 2.5 m contours and no DEM (not georeferenced, outside coverage, or no credential). A course with 120 m of true climb is stored, printed and exported as about 240 m. A sprint map with 2 m contours reads 125 %; an ISOM map with 10 m contours reads 50 %.
- **Fix:**
  - Make the interval a per-map value. Read it from OMAP, where the file has it. OCAD does not store it reliably (research 08 line 218), so ask at import or in the map settings.
  - Store it on the document header or the map row, and pass it as `opts.intervalM` from both workers and from `dem-live-check.ts:68`. Bump `TERRAIN_VERSION` or key the artefact on the interval.
  - Until the interval is confirmed, PR 254 should treat a contours-basis climb as not storable (as it already does for a partial profile, decision 11), or at least print the assumed interval next to the number.
  - Surface `intervalSuspect` in Height data settings.
  - Size: M (L with the import question UI).
- **Status:** confirmed, proven from the code. The reviewer read the terrain and profile code and grepped both branches. The verifier repeated the grep and traced every derive caller.

## Medium

### MAP-2 [TER-1]: One stray contour object far from the map makes the terrain derive allocate gigabytes, silently coarsen the terrain, then throw
- **Area:** terrain. **Category:** stability. **Severity:** medium. The reviewer rated it high, and the verifier said high is defensible: the outcome can be an OOM-killed API, but the trigger is a contour object 2 m or more of paper away from the map.
- **Location:**
  - `packages/shared/src/terrain/graph/index.ts:27` (box over all contour points).
  - `packages/shared/src/terrain/graph/mask.ts:73-115` (mask at a fixed 0.5 mm cell, no cell budget, `number[]` flood stack at :99).
  - `packages/shared/src/terrain/graph/raster.ts:37` (the raster meets its 60 M cell budget by coarsening over the inflated box).
  - `packages/api/src/map-store/heightfield.ts:123` (worker started without `resourceLimits`; typed arrays are off-heap anyway).
- **What is wrong:** the mapped-area mask is sized from the raw bounding box of every contour point, with no outlier handling and no cell budget, unlike the raster (60 M cells) and the field (4 M cells). Memory and time grow with the square of the stray object's distance. `isOverCap` does not help, because the default cap equals the raster budget and models the raster, not the mask.
- **Scenario** (reproduced twice; 100 mm synthetic map, three rings):
  - Clean map: 0.2 s, 0.3 GB, 0.2 mm field cell.
  - One 4 mm ring added at (3000, 3000) mm: 7-9 s, about 2.5 GB peak RSS, field cell 1.55 mm (about 23 m ground cells at 1:15 000).
  - The same ring at (20 000, 20 000) mm: about 60 s, about 7.9 GB, then `RangeError: Invalid array length`.
  - The derive runs in a worker inside the API process. It is reached lazily on the first 3D or terrain request, from the DEM job and from `dem-live-check.ts:105`. On an arena laptop or a small container, one such map can get the API OOM-killed. Mitigations limit how often this happens: a 240 s worker timeout, serialised derives, and a 10-minute failure memo.
- **Fix:**
  1. Give `mappedAreaMask` a cell budget like the raster's (grow `cellMm` so `W×H` stays under about 8 M), and replace the `number[]` flood stack with a growable `Int32Array`. This alone removes the OOM. Size S.
  2. Compute the contour box robustly by dropping pieces far outside the main cluster, and count them in `stats`. This restores the field cell, but changes spec §2.3/2.4 ("the contour pieces' bounding box"), so it needs a decision and a `TERRAIN_VERSION` bump.
  3. Optionally, throw a named error before allocating when the box exceeds a hard limit, so the API can store `over-cap`.
  4. Add a test with a far outlier.
  - Overall size: M.
- **Status:** confirmed, reproduced by both reviewer and verifier with `deriveTerrain` on synthetic documents built from the repo's test helpers. The only figure that did not reproduce is the decided share (0.48 against 0.97), which depends on the layout.

### MAP-3 [IMP-1]: A truncated or damaged OCAD file hangs the import worker for 10 minutes and blocks every other import
- **Area:** import. **Category:** stability. **Severity:** medium, upper end (the reviewer rated it high).
- **Location:**
  - `packages/api/node_modules/ocad2geojson/src/ocad-reader/index.js:78-92` (fork `open-orienteering/ocad2geojson#v2.2.2-oxygen.1`, pinned at `packages/api/package.json:49`).
  - `packages/api/src/import/ocad.ts:103`.
  - `packages/api/src/map-store/jobs.ts:41` (`JOB_TIMEOUT_MS`) and `:182-196` (one job at a time).
- **What is wrong:** the reader's object-index loop assigns the next offset only on success. Its `catch` swallows every exception and never breaks, so any exception inside the loop leaves `objectIndexOffset` unchanged and the loop spins. `reader.stack` also grows by one entry per pass. The symbol, object and string index loops have no visited-offset guard against a block chain that points back on itself. The upload checks only the 2-byte magic and the size.
- **Scenario:** a user uploads an `.ocd` that is cut short, for example a partial download or a broken cloud-sync copy. `e2e/test.ocd` and `e2e/colour-layers.ocd` cut to anywhere from 50 % to 99 % spin at 100 % CPU until `JOB_TIMEOUT_MS` (10 min). Cut to 25 % or less, they fail at once. Every other map upload, review round, colour switch, promote and re-match on the instance waits behind the hung job. The user finally sees `import exceeded 600000 ms`, which says nothing about the file.
- **Fix:**
  - In the fork, `break` in the `catch` for every exception type (recording the warning), and keep a `Set` of visited offsets in all three index loops. Tag the fork and bump `packages/api/package.json`.
  - Cheaper stopgap in Oxygen if the fork release is slow: a parse-stage timer in `runImportInWorker`, armed at start and cleared on the `normalise` stage message, with an error that says the file is probably damaged.
  - Test: `test.ocd` cut to 90 % and 50 % must settle promptly. Run the test through `runImportInWorker` with a small timeout, so a regression fails instead of hanging vitest.
  - Size: M (S for the stopgap).
- **Status:** confirmed, reproduced by both reviewer and verifier in a worker thread. The cyclic-chain sub-claim is evident from the code but was not reproduced.

### MAP-4 [IMP-2]: Any signed-in user can obtain another uploader's original map file by quoting its hash
- **Area:** import / club library. **Category:** security. **Severity:** medium. The reviewer rated it high; high is defensible if one instance hosts several clubs.
- **Location:**
  - `packages/api/src/routers/clubMap.ts:126-144` (`addFromSource`) and `:72-85` (`createClubMap` sets `uploadedBy` to the caller).
  - `packages/api/src/club-map-library.ts:107` (`sourceHash` in the list row).
  - `packages/api/src/routers/clubMap.ts:237-268` (`download`) and `packages/api/src/map-store/source-routes.ts:77-81`.
  - `packages/api/src/routers/course.ts:1530-1552` (`applyUploadedMap`).
- **What is wrong:** `addFromSource` accepts any `fileHash` that exists in `map_sources` without proof that the caller uploaded those bytes, and it stamps the new version with `uploadedBy = caller`. That satisfies the "uploader or admin" download rule of docs/map-storage.md §4.4 and §6.5. `clubMap.list` hands every hash to every signed-in user. The event path is similar: `applyUploadedMap` attaches the source with `fromClubLibrary = false`, and an event manager can then download it. This also defeats the rule that club-library copies stay with instance admins.
- **Scenario:** Alice uploads the club map. Bob, any signed-in user, reads `version.sourceHash` from `clubMap.list`, calls `addFromSource({ fileHash })` and then `download`, and receives Alice's OCAD file. The dedupe makes the job return `done` in the normal case. If the import outlives the 30 s hold, a second call succeeds. Each attempt also leaves a stray series in the shared library.
- **Fix:**
  - Require proof of upload in both mutations: a `map_uploads` row with `finalisedHash = fileHash` and `uploadedBy = ctx.user.id` (plus `eventId` for the event mutation), or an instance admin. Rows live 24 h, which covers upload-then-apply.
  - A cleaner variant passes `uploadId` and resolves the hash on the server.
  - Keep `AUTH_MODE=off` and admins exempt. Check that `__tests__/helpers/upload-map.ts` still goes through a real upload.
  - Add an integration test: user B cannot use a hash that only A uploaded.
  - Size: M.
- **Status:** confirmed, proven from the code end to end by reviewer and verifier. Not run, because it needs the test database.

### MAP-5 [IMP-4]: Import jobs have no attempt limit, so a job that kills the process is run again after every restart
- **Area:** import. **Category:** stability. **Severity:** medium.
- **Location:**
  - `packages/api/src/map-store/jobs.ts:198-217` (`nextClaimable`, `claim`) and `:504-513` (engine tick).
  - `packages/api/prisma/schema.prisma:1551-1583` (`MapImportJob` has no attempts column).
  - Compare `packages/api/src/map-store/dem-jobs.ts:227-230, 262-265`, where the DEM queue has exactly this guard.
- **What is wrong:** `claim` re-takes any `running` job whose heartbeat is more than 60 s old and counts nothing. Nothing else ever ends a non-terminal import job, and `JOB_TIMEOUT_MS` is enforced only in-process, so it does not survive a kill.
- **Scenario:** a very large import, near the 128 MB upload cap, pushes the container past its memory limit during the store or preview stage, or a native crash occurs. Docker restarts the API (`restart: unless-stopped`; Cloud Run does the same). After about 60 s the tick re-claims the job and the process dies again. This crash loop drops every in-flight readout and registration request each cycle, on every instance that shares the database, until someone edits the row by hand. A plain heap OOM inside the worker does not kill the process (the job then fails normally), so the trigger has to be a whole-process kill.
- **Fix:**
  - Add `attempts Int @default(0)` with a migration, and increment it in `claim`.
  - Before claiming, sweep stale `running` jobs with `attempts >= 3` to `failed` ("abandoned after N attempts"), run `abandonPromote` for promote jobs, and call `notify()`. Mirror dem-jobs.ts.
  - Update docs/map-storage.md §6.
  - Optionally pass `resourceLimits` to the Worker.
  - Size: M.
- **Status:** confirmed, proven from the code. Not reproduced, because it needs a process kill against a database.

### MAP-6 [IMP-3]: A database error while reporting an import stage crashes the API process
- **Area:** import. **Category:** stability. **Severity:** medium (the reviewer rated it high).
- **Location:** `packages/api/src/map-store/jobs.ts:234` (`onStage: (stage) => void progress(db, job.id, stage)`) and `:220-222` (`progress`); `packages/api/src/index.ts:185-186` (only SIGINT and SIGTERM handlers).
- **What is wrong:** `progress()` awaits a Prisma `updateMany` with no `catch`. The stage callback discards its promise and fires from the worker's message handler, so no upstream `try` can catch it. The API registers no `unhandledRejection` handler, and Node 22 exits on one.
- **Scenario:** a map import is running (upload, review, colour switch or re-match). At one of the four stage boundaries (parse, normalise, match, encode), the database connection blips. The API exits with code 1 and every in-flight request is lost. Docker restarts the API after a few seconds; under `pnpm dev` or a bare `node` start it stays down. The heartbeat write a few lines above does have a `.catch`, which shows the intent.
- **Fix:**
  - `onStage: (s) => { progress(db, job.id, s).catch((e) => console.error(...)) }`, with a unit test using a `db` stub whose `updateMany` rejects. Size: S.
  - Separately, a process-level `unhandledRejection` handler in index.ts that logs loudly. That is a behaviour change for the whole API, so make it its own item.
- **Status:** confirmed. The verifier reproduced the exact pattern on Node v22.23.5 (exit code 1). The grep for handlers came up empty.

### MAP-7 [DOC-1]: Replacing an event's map removes the working pin before the new import has succeeded, in two non-atomic statements
- **Area:** documents. **Category:** stability. **Severity:** medium (the reviewer rated it high).
- **Location:**
  - `packages/api/src/event-map.ts:139` (`deleteMany`), `:140` (`create` with `documentHash` null) and `:152-156` (job start, with any error caught and logged).
  - `packages/api/src/map-store/event-document.ts:56-64` (pin = latest row).
  - `packages/api/src/routers/course.ts:1544, 1619` (callers pass the plain client).
- **What is wrong:** `applyEventMap` deletes the event's `map_files` rows, then inserts the new unpinned row, and only then starts the import. A failed import, or one that is still running, leaves every reader answering "no map". This is documented behaviour (docs/map-storage.md around lines 158-166 and 501-507, and docs/map-patches.md around 744-747), so it is a robustness gap, not a code/spec mismatch.
- **Scenario:** at the arena, an organiser uploads a revised `.ocd` for an event whose map works. The file has valid magic but the importer rejects it, the worker crashes, or the import simply takes minutes. Meanwhile the viewer and kiosk show no map, cuts and checks have no frame, `maps.pdf` has no map, and new control positions have no lat/lng. There is no "revert to previous map". Recovery is to re-upload the old file (a dedupe hit pins at once) or re-pick the club map. A crash between :139 and :140 leaves no `map_files` row at all. Registration, readout and results do not depend on the map.
- **Fix:**
  - Minimal: wrap :139-140 in `$transaction`. Size S; covers only the crash case.
  - Full: keep the old row until the new one pins. Insert without deleting, then delete the other rows in the same transaction as the pin in `applyJobResult`, which is not itself transactional today. Make `eventPin` read "latest row with a `documentHash`, else latest", and show "new map failed, still showing <old file>" in `MapImportState`.
  - The full fix touches every consumer of the pin: `applyMapRotationCorrection`, `mapMetadata`/`mapFileInfo`, `writePinnedMapFileColumns`, the dedupe path in jobs.ts, `sync/snapshotMaps.ts`, `sync/mapRefresh.ts:329` and the patch re-key.
  - Needs Marcus's decision and edits to both spec chapters first. Integration test: use a file that passes the upload sniff but fails the import (OCAD magic plus garbage).
  - Size: M-L.
- **Status:** confirmed, proven from the code.

### MAP-8 [DOC-3]: Map-mode patch writes are not serialised on the client, and an older reply can overwrite a newer one
- **Area:** map editor. **Category:** stability. **Severity:** medium, lower end.
- **Location:**
  - `packages/web/src/lib/editor/write-client.ts:344-359` (`applyPatchChange`, `attachUnresolvedPatch` and `setPatchEnabled` bypass `serial`).
  - `packages/web/src/lib/map-document-cache.ts:308-313` (`setMapPatch` replaces unconditionally).
  - `packages/web/src/pages/editor/modes/MapMode.tsx:233-236, 283-292`.
  - `packages/web/src/lib/undo-stack.ts:76-92` (undo pops synchronously, so two presses put two writes in flight).
  - `packages/web/src/pages/editor/EditorPage.tsx:1927-1940`.
- **What is wrong:** course, control and object writes go through `EditorWrites.serial` (docs/bugfixes/editor-overlapping-course-writes.md), but patch writes do not. Only `commit` checks `writingRef`; undo, redo and the `loadMapPatch` revalidation do not. The server merges per op in arrival order, and the client installs whichever reply arrives last.
- **Scenario:** the user moves object 17 twice, then presses Ctrl+Z twice quickly on a slow arena network. If the server takes the second undo's write first, the stored patch ends at "after move 1" while the undo stack says both moves are undone. Because `deliver` also writes that version into `mapMetadata.patchVersion`, and `invalidate()` never refreshes `course.mapMetadata`, nothing self-heals. The stored and printed corrections disagree with the editor. The same can happen with Ctrl+Z during an in-flight gesture write, or with a stale GET reply.
- **Fix:**
  1. Route the three patch writes through `this.serial("patch", 0, …)`, widening the key type.
  2. In `setMapPatch`, drop a delivery with the same `documentHash` and a lower `BigInt(version)`. Versions are monotonic HLC values from one node. Keep "0", null and hash changes always accepted.
  3. Optionally, make undo and redo refuse or queue while one is in flight; that fixes the same race in every mode.
  - Add unit tests for both 1 and 2. Size: S-M.
- **Status:** confirmed, proven from the code. Not run, because the reorder depends on network timing.

### MAP-9 [DOC-4]: The web client fetches the event's patch with plain `fetch`, so a venue session never reads the venue box's copy
- **Area:** documents (offline). **Category:** functional. **Severity:** medium.
- **Location:** `packages/web/src/lib/map-document-cache.ts:349`; compare :129 and :179, which use `venueAwareFetch` as the `FetchOptions` comment at :67 says. Also `packages/api/src/index.ts:65-72` (CORS `allowedHeaders`).
- **What is wrong:** the document, height field and tRPC calls are routed to the active venue box, but `loadMapPatch` always hits the page origin, and no caller overrides it. On failure it quietly resolves `NO_PATCH`. docs/map-patches.md §3.4 says the box answers from its copy. This is not the "offline copy of the patch" Pending item.
- **Scenario:** a station PWA served from the cloud works against the venue box on the LAN, and the uplink is down. The document comes from the box, but the patch request goes to the unreachable cloud. The viewer, editor and kiosks then draw the map without the event's corrections, while the box's own prints apply them. With the uplink up but the two pins different, the client again draws no corrections. Display only; no data loss.
- **Fix:**
  - Default `loadMapPatch` to `venueAwareFetch` and keep `cache: "no-store"`.
  - Also add `if-none-match` to the API's CORS `allowedHeaders`. Without it, every revalidation preflight to the box fails once the client holds a delivery.
  - Check the auth-enabled box case for a signed-in user (the same shape as the document fetch).
  - Tests: the request URL with an active venue base and a second load; an OPTIONS preflight with `if-none-match` is allowed.
  - Size: S.
- **Status:** confirmed, proven from the code.

### MAP-10 [DOC-7]: A bad body cached under a document hash is never detected or evicted on the device
- **Area:** documents (offline). **Category:** stability. **Severity:** medium, lower end.
- **Location:**
  - `packages/web/src/lib/map-document-cache.ts:142-157` (only the header is parsed; no hash check; no eviction), `:150` (`res.arrayBuffer()` is outside the stored-copy fallback) and `:179-181` (`prefetchMapDocument` stores a body with no check at all).
  - `packages/web/vite.config.ts:89-100` (CacheFirst for a year; any 200 is cacheable).
- **What is wrong:** the bytes are never checked against the hash in the URL (`mapDocumentHash` exists but is used only on a dev page). A bad cached entry stays, and `retry` gets the same bytes. `DocumentCacheStorage` has no `delete`.
- **Scenario:** something in front of the API answers 200 with other content for `/api/map-documents/<hash>`, such as a sign-in or interstitial proxy page, or a hosting SPA fallback. The repo's own nginx and the SW navigation fallback cannot do this, so the trigger is uncommon. That device then shows "map could not be loaded" for the event, online or offline, until its site data is cleared. Separately, on a venue (cross-origin) session a drop during the body download rejects as a raw error at :150 instead of falling back to the stored copy.
- **Fix:**
  - After reading the bytes, `await mapDocumentHash(bytes) === hash`. On a mismatch or header failure, `cache.delete(mapDocumentUrl(hash), { ignoreVary: true })` (add `delete` to `DocumentCacheStorage`) and refetch once. `cache: "reload"` alone does not bypass Workbox CacheFirst.
  - Do not check content-type in `fetchDocument`: the app's own copies are stored as `application/octet-stream`. Put `cacheableResponse.headers: { "content-type": "application/vnd.oxygen.map" }` on the Workbox route instead.
  - Apply the same check in `prefetchMapDocument`, and move `arrayBuffer()` inside the `try`.
  - Size: S-M.
- **Status:** confirmed, proven from the code (the verifier narrowed which triggers are realistic).

### MAP-11 [IMP-5]: Map downloads send the whole file as base64 through tRPC although a streaming route exists
- **Area:** import / club library. **Category:** performance. **Severity:** medium.
- **Location:** `packages/api/src/routers/clubMap.ts:237-268` (`download`); `packages/api/src/routers/course.ts:~1291-1308` (`course.downloadMap`, the same defect); `packages/web/src/pages/SettingsPage.tsx:417-437` (caller); `packages/api/src/map-store/source-routes.ts` (the streaming route, unused by the web).
- **What is wrong:** both procedures read the whole `map_sources.bytes`, base64-encode it into the JSON response, and the web decodes it with a per-character loop on the main thread. `GET /api/map-sources/:hash` streams the same file in 4 MiB slices under the same permission rules. Its header comment gives the reason: Cloud Run's 32 MiB limit on a non-streamed response.
- **Scenario:** on Cloud Run, base64 inflates the body by 4/3, so any source over about 24 MB cannot be downloaded at all; docs/map-storage.md §4.4 says sources reach 36 MB today. On a venue laptop the download works but builds roughly 3× the file size on the API event loop and freezes the Settings tab while it decodes.
- **Fix:**
  - Replace the button with a link to `/api/map-sources/<version.sourceHash>`. Set the file name with `<a download="…">` (same-origin), because the route names the file from `map_sources.file_name` while the procedure uses `version.label`.
  - Delete or slim both procedures, and update `club-maps.test.ts` and docs/map-storage.md §4.4/§6.
  - Size: S.
- **Status:** confirmed, proven from the code.

### MAP-12 [DOC-5]: Any `courses.edit` holder of any event can delete any club map template
- **Area:** documents (print templates). **Category:** security. **Severity:** medium, low end.
- **Location:** `packages/api/src/routers/mapTemplate.ts:398-411` (`deleteClub`); compare `packages/api/src/routers/clubMap.ts:179-195`, where `remove` checks `canRemoveClubMap`.
- **What is wrong:** `deleteClub` runs `deleteMany({ where: { id } })` on the instance-wide `club_map_templates` with no uploader or admin check. `listClub` exposes every id. No spec makes this intentional, and no test covers who may delete.
- **Scenario:** with auth on, a user holding the `courseSetter` role on one training event deletes every club template. Events that already copied a template keep their snapshot; the library entries for future events are gone unless some event still holds a copy to `saveToClub` again.
- **Fix:**
  - Load the row (NOT_FOUND if absent), then return FORBIDDEN unless `canRemoveClubMap({ authEnabled, user, createdBy: row.uploadedBy })` allows it.
  - Hide the button or surface the error in `KeySections.tsx:249`, and state the rule in docs/course-layout.md §4.
  - Add a permissions integration test.
  - Size: S.
- **Status:** confirmed, proven from the code.

### MAP-13 [REN-2]: `visibleCells` enumerates every grid cell in view on each `setView`; one stray object far from the map freezes the main thread
- **Area:** renderer. **Category:** performance. **Severity:** medium.
- **Location:**
  - `packages/web/src/map-gl/buckets.ts:157-178` (grid extent, no cap) and `:225-236` (`visibleCells`).
  - `packages/web/src/map-gl/engine.ts:748, 754, 759, 774-775` (`selectViews`).
  - `packages/web/src/components/VectorMapLayer.tsx:288`.
- **What is wrong:** the bucket grid spans the min and max of all small objects, with no cap. `visibleCells` allocates and sorts one entry per cell in view, occupied or not, and `selectViews` builds Sets and sorted, joined keys over the same list on every view change. This is not the Pending "rebuild-free visible set" item.
- **Scenario:** an OCAD or OMAP file with a small forgotten object far from the map in both axes. At 20 m the grid is 400×400 cells: 120-280 ms per view change. At 80 m it is 1600×1600: 2.7-3.5 s per view change. The initial view fits the header bounds, so the worst case hits as soon as the map opens and persists until the user zooms in on the real map. The 3D path calls `selectViews` per drape layer, at the same cost.
- **Fix:**
  - Ship the sorted list of occupied cell ids in the summary; it is already iterated at `worker.ts:746-760`. Loop the view rectangle or filter the occupied list, whichever is smaller. Keep the order: nearest the centre first, ties by id.
  - Optionally, route objects outside a sane extent to the large bucket, as `assignToGrid` does at buckets.ts:781-782. That also caps `largeId`.
  - Size: S-M.
- **Status:** confirmed, reproduced (benchmark of the real `visibleCells`).

### MAP-14 [DOC-2]: The document route compresses whole documents synchronously on the API event loop, per request, with no cache
- **Area:** documents. **Category:** performance. **Severity:** medium, lower end.
- **Location:** `packages/api/src/map-store/routes.ts:92-96` (`brotliCompressSync` q5, `gzipSync`), `:273-275` and `:299-305`; compare `packages/api/src/map-store/heightfield-routes.ts:25-36` (async, "off the event loop").
- **What is wrong:** every non-range 200 compresses the whole blob on the single API thread, and the result is not kept. docs/map-storage.md §4.1 records "computed per request" as a deliberate choice, so the docs need changing too.
- **Scenario:** event morning, or right after a re-import changes the hash. `useEventOfflineMaps` prefetches the document on every event page for every viewer with `courses.view`. Each first fetch of a 3-5 MB document blocks the event loop for tens to hundreds of ms (synthetic benchmark: 30-625 ms at 3-5 MB, 0.3-2.2 s at 20 MB). Ten devices arriving together serialise that, stalling readout and registration requests. Each device pays once per hash, because of the immutable caching and the service worker.
- **Fix:**
  - Use the promisified async `brotliCompress`/`gzip`, sharing one helper with heightfield-routes.ts.
  - Keep a byte-bounded LRU of compressed bodies per `(hash, encoding)`; the content is immutable.
  - Update §4.1, and add a test that a second request is served from the memo.
  - Size: S.
- **Status:** confirmed, proven from the code. The timings are from synthetic buffers; real documents were not measured.

### MAP-15 [REN-1]: A dashed border on an area with holes dashes across ring boundaries, drawing a stray stroke from the outline to the hole
- **Area:** renderer. **Category:** functional. **Severity:** medium.
- **Location:** `packages/shared/src/render/symbolise.ts:376` (`Stage.area` passes the whole path to `this.line`); causes in `packages/shared/src/render/measure.ts:47-67` and `:231-243`; joined by `geometry.ts:47-52`, `reference-svg.ts:74-86`/`:248` and `print/operators.ts:510-519`.
- **What is wrong:** `PathMeasure` puts all rings on one arc-length axis, and `pathSections` returns one closed loop. A dash that straddles a ring boundary becomes one slice spanning two rings, and all three backends (screen, reference raster, PDF) join it into a single polyline. Dash fitting also uses the summed ring lengths. When rings repeat their first point, `segmentStartPoint` maps hole-ring segments one point early, so corner, dash and gap flags are read from the wrong vertex. Related, with the same root cause: offset borders (double lines) use only `flattenRings(path, 5)[0]`, so they draw nothing on holes (symbolise.ts:273).
- **Scenario:** an imported OCAD or OMAP area symbol whose border is a dashed line symbol (`import/ocad-symbols.ts:492`, `omap-symbols.ts:488-490`), applied to any area with a cut-out. Screen, reference raster and PDF all show a straight ink line crossing the area, a wrong map in front of runners. The canonical library's area borders are solid, and course OOB objects are single-ring, so neither is affected.
- **Fix:**
  - Lay out per ring: loop `pathRings`, one single-ring measure per ring, and offset the segment indices.
  - Walk rings explicitly in the `PathMeasure` constructor (`pt = ring.start`).
  - Apply the same per-ring rule to offset borders.
  - Add unit tests for a holed area with a dashed border, with and without a repeated closing point.
  - Size: M.
- **Status:** confirmed, reproduced by reviewer and verifier on the real `symbolise`.

## Low

### MAP-16 [IMP-6]: Every import job sends the whole source file to Postgres again for an insert that can never apply
- **Area:** import. **Category:** performance. **Severity:** low (the reviewer rated it medium).
- **Location:** `packages/api/src/map-store/jobs.ts:230-240`; `packages/api/src/map-store/documents.ts:66-76`.
- **What is wrong:** `execute` loads `map_sources.bytes`, and `storeImportedDocument` copies it and runs `mapSource.createMany({ skipDuplicates: true })`. The job holds a NOT NULL foreign key to the source, and GC never deletes a referenced source, so the insert always conflicts, yet the file is copied and sent anyway. The main thread also keeps the buffer alive across the whole import.
- **Scenario:** each upload, review round, colour switch, promote and re-match item costs one extra in-process copy and one extra transfer of the file to the database.
- **Fix:**
  - Add an option to skip the source insert, used from `execute`; `importAndStoreMap` keeps it.
  - Null the bytes reference after the Worker is constructed.
  - Update the header comment of documents.ts.
  - Size: S.
- **Status:** confirmed, proven from the code.

### MAP-17 [IMP-7]: `clubMap.setRotation` is open to every signed-in user although commented as an ops-only escape hatch
- **Area:** club library. **Category:** security. **Severity:** low.
- **Location:** `packages/api/src/routers/clubMap.ts:153-164`.
- **What is wrong:** `authedProcedure` with only an existence check. `rename` (:166-172) is open by design (docs/map-storage.md §6.5, docs/system/club-library.md:67-68) and is not part of this finding.
- **Scenario:** a signed-in user sets 90° on a shared club map. Every event that copies the map afterwards gets wrong bounds, north offset and control coordinates, and no UI shows the value.
- **Fix:**
  - Use `adminProcedure`, which passes through when auth is off.
  - Add a non-admin FORBIDDEN test, and add it to the §6.5 Authorisation bullet.
  - Check `course.setMapRotation` for the same gap.
  - Size: S.
- **Status:** confirmed for `setRotation`; the `rename` half was refuted.

### MAP-18 [DOC-6]: A patch that cannot be re-keyed stays dormant, refuses every write, and has no discoverable exit
- **Area:** documents (patches). **Category:** stability. **Severity:** low (the reviewer rated it medium).
- **Location:** `packages/api/src/map-store/patches.ts:189-200`, `:232-246` and `:317-346`; `packages/api/src/routers/mapPatch.ts` (no discard procedure).
- **What is wrong:** when `reresolveEventPatch` fails (the document cannot be decoded, the row cannot be parsed, or the re-keyed patch is over the 4 MiB cap), every `mapPatch` write throws `PATCH_STALE`, and reads deliver no corrections. This is documented and user-decided (docs/map-patches.md §3.2, 2026-11-13: the automatic alternatives were declined). The gap is that Map mode offers no way out.
- **Scenario:** the size path needs about 9,500 individual corrections that all lose their object on a new edition (measured: 9,000 hides produce about 4.0 MB of unresolved entries). Exits do exist: pinning back to the old document revives the row, later pins and the re-match sweep retry, and on a box the cloud's copy replaces the local one. None of them is visible in the UI beyond "could not be carried over".
- **Fix:**
  - After Marcus decides: an explicit, confirmed `mapPatch.discardDormant` (`courses.edit`) offered on `PATCH_STALE`, and/or measuring the cap on `ops` and `symbols` only for a re-key.
  - Do not silently drop unresolved entries; that contradicts "Nothing is lost".
  - Record the decision in §3.2 and add a decision-log row. Add a test for a re-key over the cap.
  - Size: S-M.
- **Status:** confirmed, proven from the code (size ratio measured).

### MAP-19 [REN-3]: A second WebGL context loss ends the map layer, with a misleading message and no retry
- **Area:** renderer. **Category:** stability. **Severity:** low (the reviewer rated it medium).
- **Location:** `packages/web/src/components/VectorMapLayer.tsx:170` (`lostRef`), `:320-324` and `:531-536` (Retry only for `error`); spec docs/map-rendering.md:2124-2127; decision row `decisions/slice-e.md:19`; E2E `e2e/map-vector-layer.spec.ts:636-657`.
- **What is wrong:** the loss counter is never reset. After a second loss, the layer shows "This browser cannot draw the map (WebGL2 is not available)" with no button. Spec, decision row and E2E all pin this behaviour. The decision row is marked "for user review".
- **Scenario:** a course setter's laptop or a field-mode phone sleeps and resumes, or has a GPU reset, twice in one long session. The map is gone until the user leaves and re-enters the view. No unattended display mounts this layer, and nothing at registration, readout or results depends on it.
- **Fix:**
  - After Marcus answers: change §5.4 and add a decision row.
  - Reset the counter on a completed load, not on load start. Pass Retry for the post-loss case, with its own "context lost" message.
  - Rewrite the E2E.
  - Size: S.
- **Status:** confirmed, proven from the code.

### MAP-20 [REN-4]: An exception while preparing one detail cell stalls the worker queue and leaves `whenComplete` pending
- **Area:** renderer. **Category:** stability. **Severity:** low.
- **Location:** `packages/web/src/map-gl/worker.ts:555-569` (`pump`, no try/catch); `packages/web/src/map-gl/engine.ts:639-661, 760-768, 816-820`; `readback.ts:176-181`.
- **What is wrong:** a throw in `pump` leaves the queue unscheduled and posts no error reply. The engine hears a generation-less `onerror`, rejects unrelated patch and hit requests, and never re-asks for the cell. `whenComplete` never resolves, and frame readbacks wait out their 60 s timeout. With the inline transport the throw is an uncaught main-thread error.
- **Scenario:** no concrete throwing input was found (the spec says symbolise never throws on data). If one exists, that cell and the cells queued after it never sharpen, a concurrent course edit is reported as failed, and print readback waits 60 s.
- **Fix:**
  - Worker: try/catch per id, post `partFailed { bucket, message }`, continue.
  - Engine: on `partFailed`, drop the id from `detailCells` (or keep a failed set used by `isComplete` and the want filter), and log the message.
  - Add worker and engine tests, and a row in the protocol table in map-rendering.md.
  - Size: S-M.
- **Status:** confirmed; the worker half was reproduced with a scratch vitest, the engine half proven from the code.

### MAP-21 [REN-5]: Clip grouping is quadratic in the number of pattern-clipped areas, on the main thread, on every rebuild
- **Area:** renderer. **Category:** performance. **Severity:** low.
- **Location:** `packages/web/src/map-gl/buckets.ts:1175-1188` (`groupClips`, called from `buildVisibleSet` at :1071).
- **What is wrong:** first-fit grouping tests each clip item against every earlier member of its colour and mask, and copies `grouped.slice(start)` per item. Disjoint footprints, the normal case, give n²/2 box tests. This is separate from the Pending "rebuild-free visible set" item.
- **Scenario:** a dense map shown above the zoom gate. In a node copy of the loop, 2,000 clipped passes take 24 ms per rebuild, 5,000 take 58 ms, and 10,000 take 287 ms. Seconds would need 20-30 thousand passes in view.
- **Fix:**
  - Use a per-group coarse grid or spatial hash, keeping the same first-fit result, and drop the per-item slice.
  - Keep the "greedy in stream order" spec and the buckets tests passing.
  - Size: M.
- **Status:** confirmed, reproduced.

### MAP-22 [REN-6]: `MapGlRenderer.dispose()` never deletes shader programs, shaders or pending timer queries
- **Area:** renderer. **Category:** stability. **Severity:** low.
- **Location:** `packages/web/src/map-gl/renderer.ts:607-626` (`link`), `:675-692` (`dispose`), `:1069-1083`; `packages/web/src/components/VectorMapLayer.tsx:314, 516`.
- **What is wrong:** up to 12 programs and 24 shaders per renderer are never freed. A new renderer is built on the same GL context whenever `doc`, `budget` or `nameId` changes. A saved patch version does not trigger this.
- **Scenario:** an all-day course-editor tab that switches maps or re-imports often strands a dozen programs per switch. This is small, and no driver limit was shown to be hit.
- **Fix:**
  - `detachShader`/`deleteShader` after link; `deleteProgram` for all programs in `dispose`; `deleteQuery` for pending timer queries. Follow the pattern in terrain/program.ts.
  - Size: S.
- **Status:** confirmed, proven from the code.

### MAP-23 [REN-7]: The engine's `loaded` handler resets every part except the page part
- **Area:** renderer. **Category:** stability. **Severity:** low.
- **Location:** `packages/web/src/map-gl/engine.ts:670-706` (page set at :575-576).
- **What is wrong:** after a second `load` on the same engine, `page` and `pageClip` still hold a part whose arena offsets point into the new document's buffers. Until the course reply arrives, the next frame draws garbage in page colours, or indefinitely if that request errors.
- **Scenario:** latent on `main`. VectorMapLayer creates one engine per load, and no dev page sets a course. It would surface with any reuse of one engine across documents.
- **Fix:** `this.page = undefined; this.pageClip = undefined;` next to `this.course = undefined`, plus a regression test next to the "a page:" test in engine.test.ts. Size: S.
- **Status:** confirmed, reproduced with a scratch copy of engine.test.ts.

### MAP-24 [REN-8]: `MapGlEngine.dispose()` leaves the load, patch and completion promises pending
- **Area:** renderer. **Category:** practice. **Severity:** low.
- **Location:** `packages/web/src/map-gl/engine.ts:1123-1135`.
- **What is wrong:** `dispose()` rejects only the terrain and hit-test waiters. `loadWaiter`, `loadPatchWaiters`, `patchWaiters`, `inFlightWaiters` and `completeWaiters` never settle.
- **Scenario:** no observable failure today. Every caller continuation is guarded (`cancelled`, `engineRef.current === engine`), readback races a timeout, and the cycle is collectable. This is an API-hygiene trap for future callers.
- **Fix:**
  - Reject all waiter lists with "map engine disposed". `completeWaiters` hold only `resolve`, so give them a reject.
  - Check that the existing rejection handlers stay silent on a dispose rejection, and that the dev pages handle it.
  - Size: S.
- **Status:** confirmed, proven from the code.

### MAP-25 [DOC-8]: `mapTemplate.list` fails for the whole event when one stored template does not parse
- **Area:** documents (print templates). **Category:** stability. **Severity:** low.
- **Location:** `packages/api/src/routers/mapTemplate.ts:61-70` (`.parse`) and `:80-87`; trigger path `packages/api/src/sync/mapRefresh.ts:360-372` (mirrors cloud template rows without parsing them).
- **What is wrong:** one row that fails the current schema makes the whole list a 500. No current writer produces such a row. Realistic triggers are a later schema tightening without a data migration, or version skew: a venue laptop on an older build than the cloud receives an unknown object kind through the sync. `listClub` in the same file already uses `safeParse`.
- **Scenario:** the laptop runs an older build, the cloud template has a new object kind, and Layout mode and the Courses page lose every template for the event on event day.
- **Fix:**
  - `safeParse` per row in `list`; log the event id and seq, return the rest, and flag the broken row.
  - Separate small defect: `update` (:131-142) lacks `create`'s custom-paper refinement (width and height required), so a template saved that way later mis-sizes the sheet (resolve-layout.ts:444-449, resolve-sheet.ts:230). Check it against the merged row.
  - Size: S.
- **Status:** confirmed, proven from the code plus a scratch schema check.

### MAP-26 [DOC-9]: The document-access cache grows without bound
- **Area:** documents. **Category:** stability. **Severity:** low.
- **Location:** `packages/api/src/map-store/routes.ts:180` and `:224-237`.
- **What is wrong:** a module-level `Map` that is only ever set. With auth off, any 64-hex hash combined with any `?k=` or `?event=` value adds an entry, even when the request ends in a 404. With auth on, an authorised user can do the same for a real hash.
- **Scenario:** a script or a buggy client on a venue LAN with `AUTH_MODE=off` grows the API heap until restart. It takes millions of varied requests (about 200 bytes per entry).
- **Fix:** skip the cache when auth is off, and use the existing `LruCache` (`course-maps/lru-cache.ts`, `new LruCache<number>(5000)`). Size: S.
- **Status:** confirmed, proven from the code.

### MAP-27 [DOC-10]: The patch route reads and parses the whole patch before checking `If-None-Match`
- **Area:** documents (patches). **Category:** performance. **Severity:** low.
- **Location:** `packages/api/src/map-store/routes.ts:288-296`; `packages/api/src/map-store/patches.ts:58-72, 113-119, 125-129`.
- **What is wrong:** every revalidation (on focus, visibility change and reconnect) reads the full JSONB, Zod-parses and re-sorts it, then usually answers 304.
- **Scenario:** a large patch, at most 4 MiB but normally kilobytes, and a room of clients. The cost is small in normal use.
- **Fix:**
  - Read the pin and `eventPatchVersion` first, answer 304 on a match, and only then call `eventPatch`.
  - Keep a second ETag check after the full read: `eventPatchVersion` gives the row's version for an unparsable row, where `eventPatch` gives "0".
  - Size: S.
- **Status:** confirmed, proven from the code.

### MAP-28 [DOC-11]: DEM fetch errors during the body read are mislabelled, and a timed-out DEM job keeps fetching in the background
- **Area:** DEM. **Category:** practice. **Severity:** low.
- **Location:** `packages/api/src/map-store/dem-cog.ts:109-132` (`await res.arrayBuffer()` at :130 is outside the try/catch); `packages/api/src/map-store/dem-jobs.ts:290-292, 318-363`; `packages/api/src/map-store/dem.ts:142-197`.
- **What is wrong:** a stall or reset after the 206 headers surfaces as a raw `TimeoutError` or `TypeError` and is recorded as reason `derive`, which contradicts docs/map-storage.md:772. Retry behaviour is unaffected. After the job's 10-minute timer fires, `fetchDemMosaic` is not aborted, and it keeps downloading and decoding (up to 64 M cells, 256 MB) while the next job runs.
- **Scenario:** a slow but moving arena uplink. Settings shows "failed: derive", and memory is held by the abandoned fetch alongside the next job's mosaic.
- **Fix:**
  - Put the body read inside the try/catch (`TimeoutError`/`AbortError` maps to `timeout`, anything else to `http`).
  - Thread an `AbortSignal` from `execute` through `fetchDemMosaic`, `readCogWindow` and `fetchRange`, combined with the per-request timeout via `AbortSignal.any`.
  - Size: S.
- **Status:** confirmed. Part 1 was reproduced against a stalling local server; part 2 is proven from the code.

### MAP-29 [IMP-8, TER-3]: Two small cleanups
- **MAP-29a [IMP-8], low, practice.** `packages/api/src/map-store/colour-pictures.ts:28` (writes at :225 and :265): the `failures` map is never pruned, one entry per distinct failed id. While the IOF import keeps failing, any distinct `deviations` query adds a key.
  - Fix: delete on read past the TTL and on success (in the `work.then` handlers at :222 and :262), and cap the size. Size: S.
  - Status: confirmed, from the code.
- **MAP-29b [TER-3], low, practice.** `sideCell` is byte-identical in `packages/shared/src/terrain/graph/incidence.ts:18-27`, `solve/probe.ts:24-33` and `field/interpolate.ts:42-51`. `PAIR_KEY` is declared twice (incidence.ts:15, probe.ts:21), `mod5` twice (`solve/report.ts:22`, `index-repair.ts:28`), and the pair-rule constants twice (incidence.ts `PAIR_MIN_SAMPLES`/`PAIR_MIN_SHARE` against probe.ts `PROBE_RULES`). They must stay identical for `cliffBornePairs`, `leakyRegions` and `bandSources` to see the same pairs.
  - Fix: export `sideCell`, `PAIR_KEY` and the pair rule from `graph/incidence.ts`, and one `mod5` from a shared util. Size: S.
  - Status: confirmed by diff.

## Clean (read closely, no findings)

- `packages/shared/src/map-document/**` (codec, header, patch, patch-bake, patch-resolve, materialise, projection, render-bridge): merge and apply are deterministic and never throw on patch content.
- Server patch writes, promote and `mapPatch` router: the row lock, the pin re-check under the lock, the promote gate and version minting are consistent. Every query is keyed by `ctx.event.id`, so no cross-event path exists.
- `gc.ts`: deletes re-check their conditions in one statement, backed by FK RESTRICT.
- Colour settings: read-modify-write under an advisory lock.
- Height-field routes and derive: single-flight, serialised, in a worker, authorised before the existence check.
- Field codec: truncated, over-long and absurd-dimension inputs are rejected before allocation. Solve, interpolation, anchor and the 3D client (GL resources released, loops bounded) are clean.
- PR 254 `terrain/profile/`: climb shares fuzzed over 200,000 cases with no mismatch; nothing beyond MAP-1.
- Thirteen odd contour inputs (single, crossing, self-crossing, duplicate-point, index-only, extreme scales, NaN DEM) all derive without throwing.
- Renderer: integer coordinates and Zod-validated symbols rule out NaN and zero-dash crashes. No stale-reply race was found in the worker protocol beyond MAP-23. Symbol-library schema, palette and index are clean.
- OMAP/XMAP reader: no DTD or external entities, and symbol recursion is depth-limited.

## Not reviewed / could not verify

- **Symbol matching and colour layering correctness.** `packages/shared/src/import/matcher.ts`, `fingerprint.ts`, `colour-class.ts`, `colour-roles.ts`, `colour-align.ts`, `colour-layers.ts`, `ocad-symbols.ts`, most of `omap-symbols.ts`, and `report.ts` were only searched for loops, recursion guards and type holes, not read for correctness. This is the largest gap in the area and is worth a follow-up review.
- **The Map-mode editor UI.** Not read in full: `packages/web/src/pages/editor/modes/map/**` (except the start of `model.ts`), all of `tracks/`, `components/map-review/CompareView.tsx` and `ColourLayersPanel.tsx`, and `MapMode.tsx` lines 720-997. Also only skimmed: `dem-settings.ts`, and `colour-pictures.ts` beyond MAP-29a.
- **The `ocad2geojson` fork.** Only `ocad-reader/index.js`, `object-index.js` and `buffer-reader.js` were read; the symbol and string parsers were not reviewed for other hostile-input problems. OMAP was not fuzzed.
- **Real club maps.** None was used (the Flaten map is off limits and the corpus is not in the repo). Memory and time on 20-50 MB maps rest on the spec's own tables. Not measured: peak memory of a 50-128 MB import, compression timings on real documents (MAP-14), the number of clip items per view (MAP-21), and how often stray far-away objects occur in real files (MAP-2, MAP-13). Whether the importer drops far-away objects before terrain was not checked.
- **No integration tests, E2E, browser or GPU runs.** MAP-4, MAP-5, MAP-6 (beyond the Node repro), MAP-7, MAP-8 and MAP-10 are proven from the code but were not run against a database or browser. WebGL behaviour (MAP-19, MAP-22) was judged by reading.
- **Spec documents** were read selectively (the relevant sections and every "Pending in this chapter" list), not end to end, so a spec/code mismatch outside the touched sections would not have been noticed.
- **Production barrel exports.** `packages/shared/src/render/index.ts:14-20` re-exports test fixtures and golden scenes. Whether they reach the web and worker bundles, and their size, was not measured.
- **Out of this area:** course maps, printing and the course-elevation UI (area 09), GPS tracks (to be revamped), and the web client outside the map layer (area 10).
