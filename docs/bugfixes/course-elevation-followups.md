# Course elevation: follow-ups after fix package 23

Left out of [course-elevation-review.md](course-elevation-review.md) on purpose.

1. **F1.** The holder does not refresh routes after a cloud-side out-of-bounds edit that arrives with the cadence map refresh (only after a `courseObject.*` write forwarded from the box). Wait for F2: with CRS-072 open it would re-search the whole event on the arena laptop after any map correction.
2. **F2 (CRS-072).** A local basis for the automatic routes (patch entries and objects whose box meets the leg's window) instead of the event-wide patch version; an `AUTO_ROUTE_VERSION` bump; the cases that must still change the basis (correction removed or hidden, patch on or off, a symbol's class). Spec §7.5 changes and a decision-log row.
3. **F3 (MAP-1 remainder).** Derive the fields at the confirmed interval (an artefact keyed on it, or a `TERRAIN_VERSION` bump) so the 3D view's vertical scale, the pick's `heightM`, the DEM anchor's level vote and its misalignment gate use it. Until then a map whose true interval differs from the guess may be refused a ground model as `misaligned`, and its coarse-DEM anchored field is not read for climb. Read the interval from an OMAP file if one turns out to carry it (D7 assumes none do).
4. **F4.** The Courses page says nothing when a course has no computed climb because the interval is unconfirmed; the printed and exported climb does not say it rests on contours.
5. **F5.** A restored event backup, or an event whose club map version was deleted, falls back to its own `map_files.contour_interval_m` (NULL: asked again). Safe, but a second confirmation.
6. **F6.** `course.update` and `course.bulkUpdate` with `firstAsStart` / `lastAsFinish` do not rebuild the `legs` string or a derived length (on main too).
7. **F7.** CRS-048's residual window (an edit committing between a chunk's read of the courses per pair and the pair's transaction); a failed pair's memo is per process, so a restart retries it once.
8. **F8.** Derived lengths are not re-derived on the holder after a map change during a lease (`venue-shipping-and-lease.md`, "Left out"); only climbs are.
9. **F9.** Not tried against Test-Eventor (EVT-22's first option): push once with and without the course element and record the result in `course-elevation.md` §0.38.
10. **F10.** Route refreshes of several events are not capped together; with one worker each it is one core per event.
11. **Q2.** `climbSource` and `winnerPaceSPerKm` do not travel in `course.upserted`: a climb computed on the holder arrives on the cloud as a typed one and is not recomputed there, and a winner pace typed on a box never reaches the cloud. Since review package 3 (2026-11-25) receivers drop unknown keys, so dropping the two names from `COURSE_DERIVED_FIELDS` is small once no older box is in use. Needs the owner's answer.
12. **Not forwarded.** `clubMap.setContourInterval` is not cloud-owned: a box learns a changed club value with its next map refresh (the cloud's `applyContourInterval` skips events it does not hold).
13. **Tests not written.** The worker searcher's timeout and restart path has no dedicated test; the snapshot exporter's interval is covered by an integration test, not a unit test of its own.
