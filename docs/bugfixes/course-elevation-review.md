# Course elevation, before PR #254 merges (fix package 23)

Findings from the review of the course-elevation work (`docs/course-elevation.md`) that were still open when the branch had main merged in: API-15 / CRS-014, DB-53 / CRS-091, API-37l, CRS-071, CRS-048, CRS-070, CRS-089, CRS-090, EVT-22, SYNC-17 (this branch's part) and MAP-1 / D7. The defaults of the open questions were approved by the owner and are in the decision logs (`decisions/general.md` D8, `decisions/slice-h.md` D7) and in `course-elevation.md` §0 rows 43-45. Not done: CRS-072 and the rest in [course-elevation-followups.md](course-elevation-followups.md).

## API-15 / CRS-014: background jobs wrote on a node that does not hold the lease

**What happened.** The automatic leg-route refresh and the climb compute had no lease check. A `courseObject.*` write on the cloud during a lease started both there, so the cloud wrote `leg_routes` rows and climbs for an event whose data the venue box owns.

**Fix.** `background-lease.ts` (`mayRunBackgroundJob`, wrapping `mayWriteEventData`): `computeMissingClimbs` and `refreshAutoRoutes` do nothing on a non-holder (no search, no clear, no write; logged once per job, event and reason), re-check before each course's transaction and before each chunk's writes, and do not throw. On the holder, a forwarded `courseObject.*` write now enqueues the route refresh, and the holder's map refresh clears and recomputes the computed climbs when it replaced map files. Spec §6 and §7.5 "During a lease".

## DB-53 / CRS-091: one read per course, a clear that journaled nothing

**What happened.** The climb compute read every chosen route inside each course's loop; `clearComputedClimbs` changed rows without a journal entry, so a peer kept the old climb until something else touched the course.

**Fix.** The chosen routes are read once with a stamp (count and newest `updatedAt`); each course's transaction re-reads the stamp only and reloads on a difference. `clearComputedClimbs` returns the ids it cleared and, with `emit`, journals each cleared row (`advanceVersion: false`); the callers that do not emit the row themselves pass it (route choice, the automatic refresh, a map refresh, an interval change), and the derived-course rebuild emits for the union.

## API-37l and CRS-071: a worker per chunk; one bad pair dropped its chunk

**What happened.** Every chunk of 20 pairs started a worker that decoded the whole map document again, and one pair that threw dropped all 20 and was searched again by the next refresh, for ever.

**Fix.** One long-lived worker per refresh decodes the document once and answers a job at a time (60 s per job; on a timeout or a death the worker is replaced). A job answers `route` or `failed`; a failed pair is logged with its controls and remembered in memory against its basis, so it is not searched again until a control of it moves or the process restarts. The rest of the chunk is written.

## CRS-048 and CRS-070: courses that gained a pair kept the old climb; cleared climbs stayed empty

**What happened.** The refresh cleared the climbs of the courses that ran a pair when the refresh started, so a course that gained the pair meanwhile kept a climb along the straight line; and every cleared climb stayed empty until the whole refresh ended.

**Fix.** The courses per pair are read once per chunk (`coursesByPair`) before the writes, and the climbs of the chunk's courses are computed after each chunk instead of at the end (the `finally` computes only what is still pending).

## CRS-089: the shortest search ran twice and never stopped at its target

**What happened.** `searchStretch` ran a full Dijkstra field and, for a non-shortest model, a second one over the whole grid.

**Fix.** `costField` takes a `stopAt` cell and ends when it is settled. The shortest field is always traced to the target only, so it stops there; the first field stops there when no alternatives are asked for. The routes found are identical (no `AUTO_ROUTE_VERSION` bump).

## CRS-090: `course.update` with `firstAsStart` / `lastAsFinish` kept a stale climb

**What happened.** The flags change which controls the course visits, but only `bulkUpdate` cleared the computed climb.

**Fix.** `course.update` clears it (and the compute that follows stores the new one).

## EVT-22: no way to push without the course element

**What happened.** Every start list and result list pushed to Eventor carried `Course` (length and climb), with no way to leave it out if Eventor rejects it (not tried against Test-Eventor).

**Fix.** `eventor.pushResults` and `pushStartList` take `includeCourse` (default true). The event page has a checkbox, remembered per browser and event. Guide: `guide/event-setup.md`.

## SYNC-17: the climb columns and a peer without them

**What happened.** The review feared that a box without `climb_source` / `winner_pace_s_per_km` could not check out from a cloud that has them.

**Status.** Fixed by the merge of main (`knownFields` filters every snapshot row to the importer's columns). `known-fields.test.ts` now has the case by name.

## MAP-1 / D7: the official climb rested on a guessed contour interval

**What happened.** The contour field is derived at 5 m (2.5 m for ISSprOM) whatever the map's own interval, and the climb read it as it was: a map drawn at 2.5 m got twice its climb, stored, printed and pushed.

**Fix.** The interval is confirmed per map (`club_maps.contour_interval_m`, `map_files.contour_interval_m`; the club map's value wins). Until it is confirmed a contour climb is an estimate (`≈`, a note with Confirm, a banner) and is not stored, printed or exported; with a value, the heights are read scaled to it and the climbs of every event on the map are cleared and recomputed. The migration clears the computed climbs once. Not done: deriving the fields at the confirmed interval (F3).

## Second review round

- **Journal.** `climbSource` and `winnerPaceSPerKm` travel in `course.upserted`. Before, a climb computed on the holder arrived on the cloud as typed and survived an interval clear there; a winner pace typed on a box never reached the cloud. An entry that carries `climbM` without `climbSource` (an older sender) is still held as typed.
- **Who may change a club map's interval.** `clubMap.setContourInterval`, and `course.setContourInterval` for an event whose map comes from the library, take the check of deleting the map (its uploader or an admin), since the value recomputes every event's climbs.
- **Background.** The recompute after an interval change runs in a per-event in-memory queue and skips removed events; the mutation returns once the value is stored. The post-refresh clear of the holder's map refresh takes the same lease check as the compute. A promote that changes the pinned document clears and recomputes the climbs on the holder, and no longer copies the event's interval to the club map.
- **Route searcher.** A worker that timed out or exited is flagged dead and never reused; one job at a time is enforced. The lease log line repeats after an hour instead of once per process.
- **Interval input.** One validation function in `@oxygen/shared`, used by the API and the editor; a confirmed value can be returned to *not confirmed* from the dialog row and the club card; the route finder's costs read the heights at the confirmed interval, as the displayed climb does.
- **Migration note.** The migration's one-off clear also clears computed climbs resting on a ground model; they are computed again when a course is next edited or the editor is opened.
