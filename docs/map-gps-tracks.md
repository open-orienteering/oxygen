# GPS tracks

Status: **draft** — chapter of the vector map pipeline specification,
started by sub-slice G22; §4 by G23; §1 by G24; §5.1 by G25; §6 by G26; §6.7 by G28; §2.4 by G31; §5.2's nodes by G30. GPS tracks are new scope for slice G (user,
2026-11-13, `docs/research/vector-map-pipeline/SLICES.md` "Slice G",
rows G20–G28): the research decides none of it beyond 04 §7
("Georeferenced inputs" become paper-space overlays) and 06 §3.2 (a
source's GPX templates are dropped at import). Each row records its
decisions in `decisions/slice-g.md`. When the research and this
document disagree, this document wins.

The use is ski-O mapping: a mapper skis the tracks with a GPS logger,
imports the GPX or TCX files into an event, averages several passes, trims and
splits them, and converts them into ISSkiOM track lines on the event's
map (Map mode, `course-editor.md` §13). This chapter is normative for
`packages/shared/src/gps-track/` (`import { gpsTrack } from
"@oxygen/shared"`). It covers storage (§1), reading GPX and TCX (§2), the
geometry on the paper (§3), averaging passes (§4), the reference layer
and editing (§5) and conversion into map objects (§6).

## 1. Storage

Tracks are per event, in their own cloud-owned table `map_gps_tracks`,
one row per track segment, stored in WGS 84 so that a re-match or a new
map edition does not move them (slice G "Decided in this split", answer
10). The row's `points` are the `TrackPoints` columns of §2.1 verbatim,
and its trim is a `TrackRange` (§3.5). An average (§4) also keeps its
`singlePass` ranges (`single_pass`, user 2026-11-13). Written by row
G24: migration `20261114120000_map_gps_tracks`, the store
`packages/api/src/gps-tracks.ts`, the router `mapTrack`
(`packages/api/src/routers/mapTrack.ts`).

### 1.1 The table

| Column | Type | Meaning |
|---|---|---|
| `id` | `UUID` PK, default `uuidv7()` | client-mintable on `import` and `split` (AGENTS.md §7) |
| `event_id` | `BIGINT` → `events` `ON DELETE CASCADE` | the event the track belongs to |
| `name` | `TEXT NULL` | `Track.name` (§2.1); null when the GPX names none |
| `source_name` | `TEXT NOT NULL DEFAULT ''` | the file it came from; `''` for an average |
| `points` | `JSONB NOT NULL` (an object) | `TrackPoints` verbatim (§2.1) |
| `point_count` | `INTEGER NOT NULL` | `points.lat.length`, set by the server (user 2026-11-14) |
| `recorded_at` | `TIMESTAMPTZ(3) NULL` | the first non-null `time`; null when untimed (user 2026-11-14) |
| `trim_start`, `trim_end` | `INTEGER NOT NULL` | the trim `[start, end)` (§3.5); `0` / `point_count` when untrimmed |
| `derived_from` | `UUID[] NOT NULL DEFAULT '{}'` | an average's passes (provenance only: no FK, not cleaned on remove) |
| `single_pass` | `JSONB NULL` (an array) | an average's single-pass ranges (§4.1), `[{ start, end }]` indices of the stored points; null for a recorded track |
| `converted_op` | `TEXT NULL` | the patch `add` op the track was converted into (G26), `add:<uuid>` |
| `created_by` | `UUID NULL` → `users` `ON DELETE SET NULL` | the importing user; null with auth off |
| `created_at` | `TIMESTAMPTZ(6)` | import time; the list order (`created_at`, `id`) |
| `version` | `BIGINT` | token: an HLC minted at insert and on every write that changes the row, as `map_patches` (`course-layer.md` §7); a decimal string on the wire |

CHECKs: `points` is a JSON object, `single_pass` null or an array,
`0 ≤ trim_start`, `trim_end − trim_start ≥ 2`, `trim_end ≤ point_count`.
Index `(event_id, created_at, id)`. No `updated_at`: the token carries
the write.

`point_count` and `recorded_at` are derived columns the row did not
name (user 2026-11-14): `list` answers metadata without reading
`points` (a 200 000-point timed track is about 8 MB of JSON), and the
trim CHECK needs the count. Length in metres is not stored: it is
ground metres on the projected track (§3.1), computed on the device.

### 1.2 The API

Every procedure is `coursesEditProcedure` — reads too, so tracks are
never delivered to a viewer (`courses.view`) or a kiosk key. Every query
is scoped to the event of the call (`x-event-id`); another event's id is
`NOT_FOUND`. Metadata (`TrackMeta`): `{ id, name, sourceName,
pointCount, recordedAt (epoch ms | null), trim: { start, end },
derivedFrom, singlePass | null, convertedOp, createdBy, createdAt (ISO),
version (string) }`.

| Procedure | Input | Answer |
|---|---|---|
| `mapTrack.list` | — | `{ tracks: TrackMeta[] }` in list order; never reads `points` |
| `mapTrack.get` | `{ id }` | `TrackMeta & { points }` |
| `mapTrack.import` | `{ tracks: [{ id?, name, sourceName, points, derivedFrom?, singlePass? }] }` (1–200) | `{ tracks: TrackMeta[] }` in input order |
| `mapTrack.update` | `{ id, name?, trim? }` (one at least) | `TrackMeta` |
| `mapTrack.split` | `{ id, index, ids?: [uuid, uuid] }` | `{ tracks: [TrackMeta, TrackMeta] }` |
| `mapTrack.remove` | `{ ids }` (1–200) | `{ removed }` |
| `mapTrack.markConverted` | `{ marks: [{ id, opId: string \| null }] }` (1–200) | `{ tracks: TrackMeta[] }` |

- **Inputs.** `name` is at most 200 characters (null allowed), and
  `sourceName` at most 255; a device truncates longer GPX names and file
  names. `points` is validated by hand rather than by Zod (AGENTS.md §8
  "Zod at the boundary" covers the envelope): a capped track is 800 000
  numbers.
- **Parsed on the device.** The server never parses GPX and never
  projects; it validates `points` against §2.1 and refuses, never
  re-rounds: `lat` / `lng` equal-length integer arrays (|lat| ≤ 90°,
  |lng| ≤ 180° in 1e-7°), at least two points; `time` null or that
  length of null / non-negative safe integers; `ele` null or that length
  of null / finite numbers equal to their `quantiseEle`. A column of only
  nulls is stored as null (§2.1). `singlePass` must be integer ranges,
  `0 ≤ start < end ≤ n`, ascending, disjoint and never touching (§4.1).
- **Caps** (§2.2 leaves them to this API): 200 000 points a track, 200
  tracks an event (counted under a per-event transaction lock, so two
  imports cannot both pass it; `split` counts too), and 500 000 points
  a call, so one request stays well under Cloud Run's 32 MiB: a device
  sends a large import as several calls. A refused import writes nothing.
- **Import** is one transaction, rows inserted in input order (so
  server-minted ids keep file order; a client minting ids mints them
  ascending — uuidv7 in file order — since rows of one import share
  `created_at` and the list orders them by id). A supplied `id` already in the
  event is skipped and answered as stored — a retried venue forward is a
  no-op, and an undo can re-import a removed track under its id; one in
  another event is `CONFLICT`. `derivedFrom` (2–200 distinct ids) and
  `singlePass` come together (an average, G27) or not at all.
- **Update** sets the name and the trim (§3.5's rule against
  `point_count`). It never touches `points` or `single_pass`: the
  ranges index the stored points, and shifting them for the trimmed view
  is G27's (§4.1). A write that changes nothing keeps the version. No
  `baseVersion`: `points` never change under one id, so only name, trim
  and `converted_op` can race, last writer wins (as `mapPatch`).
- **Split** at a stored-point `index` that leaves two visible points on
  each side (`trim_start + 1 ≤ index ≤ trim_end − 2`) **replaces the row
  with two** in one transaction (a stale client gets `NOT_FOUND`, not
  half a track): points from `splitTrack` (§3.5) on the full stored
  points, so both parts share the split point; trims carried, left
  `[trim_start, index + 1)`, right `[0, trim_end − index)`, so both stay
  restorable; `single_pass` divided by `splitRanges` (§3.5); `name`,
  `source_name`, `derived_from`, `converted_op`, `created_by` and
  `created_at` (exact) kept, so the parts stay with their import in the
  list, ordered there by id (client `ids` ascending, left first, to keep
  left before right); a fresh version each. With `ids`, a repeat after success (the
  original gone, both ids present) answers the two rows.
- **Remove** deletes the event's rows among `ids`; unknown ids are
  ignored, so twice is once.
- **Mark converted** sets or clears (G26's undo) `converted_op`; every id
  must exist in the event, else `NOT_FOUND` and nothing is written. The
  op is not checked against the patch.

Errors carry their code as the message prefix, as `PATCH_*` do:

| Code | tRPC code | When |
|---|---|---|
| `TRACK_POINTS_INVALID` | `BAD_REQUEST` | a points or `singlePass` rule fails, `derivedFrom` / `singlePass` come alone, `derivedFrom` names a pass twice, or an id appears twice in one `import` / `markConverted` call |
| `TRACK_TOO_MANY_POINTS` | `PAYLOAD_TOO_LARGE` | a track has more than 200 000 points |
| `TRACK_REQUEST_TOO_LARGE` | `PAYLOAD_TOO_LARGE` | a call holds more than 500 000 points |
| `TRACK_LIMIT` | `PRECONDITION_FAILED` | the event would hold more than 200 tracks |
| `TRACK_ID_TAKEN` | `CONFLICT` | an `import` id belongs to another event, or a `split` part id is already used by any row |
| `TRACK_NOT_FOUND` | `NOT_FOUND` | no such track in the event |
| `TRACK_TRIM_INVALID` | `BAD_REQUEST` | a trim outside §3.5's rule |
| `TRACK_SPLIT_INVALID` | `BAD_REQUEST` | a split index without two visible points each side, or part `ids` equal to each other or to the original |

### 1.3 Ownership, venue and backups

- **Cloud-owned, not journaled**: `"mapTrack."` is in
  `CLOUD_OWNED_MUTATION_PREFIXES` (`packages/shared/src/cloud-ownership.ts`),
  so a venue box forwards the mutations; no mutation writes a journal
  entry. Tracks are not results (08 §4.8's non-critical data).
- **Not in the checkout snapshot** (`map-storage.md` §7.2): a box holds
  no tracks. Reads are not forwarded, so on a box `list` answers empty
  during a lease; G25 disables the panel on a venue node with the
  reason (user 2026-11-14: mapping is not a venue task).
- **In the per-event dump** (`map-storage.md` §7.3; 07 §10): a
  `map_gps_tracks` section after `map_patches`, all columns, restored
  by `packages/api/scripts/restore-map-gps-tracks.sql -v event_id=<id>`
  with `event_id` rewritten, `created_by` kept only when that user
  exists, `ON CONFLICT (id) DO NOTHING` (twice is once).

## 2. GPX and TCX

A GPX or TCX file (§2.4) is parsed **in the browser**; the server stores points, not
the file (slice G "Decided in this split"). `parseGpx(text)` is pure,
uses no DOM or Node API, and streams over the import's dependency-free
tokenizer (`import/xml.ts` `parseXml`), so a file of hundreds of
thousands of points never becomes an element tree.

### 2.1 The track

```ts
interface TrackPoints {          // columns of equal length
  lat: number[];                 // integer 1e-7 degrees: Math.round(deg * 1e7)
  lng: number[];                 // same
  time: (number | null)[] | null; // epoch ms UTC, integer; null per point without one,
                                  // the whole column null when no point has one
  ele: (number | null)[] | null;  // metres, rounded to 0.1; null as for time
}
interface Track { name: string | null; points: TrackPoints }
```

- **Quantised at parse.** Coordinates become 1e-7° integers (≈ 1 cm)
  when the file is read, so a track parsed on the device and the same
  track read back from G24's table are the same input to the geometry
  and to averaging.
- **Absolute time.** `time` is wall-clock UTC from the logger, not the
  ZeroTime-relative race time of AGENTS.md §7: tracks are not results.
- `trackLength(track)` is the point count; `quantiseDeg` /
  `quantiseEle` are the two roundings.

### 2.2 What is read

- **GPX 1.0 and 1.1 alike.** The root's local name must be `gpx`; the
  namespace is not checked, and a prefix (`gpx:trkpt`) is stripped from
  every element name. The root's `version` and `creator` are reported.
  A byte-order mark is skipped.
- **One track per segment.** Each `trk/trkseg` with at least two valid
  points is one `ParsedTrack`, named after its `trk`'s `<name>` (null
  when absent; a name after the segments counts), with `source: "trk"`,
  `trackIndex` (the `trk`'s position among the file's `trk`s) and
  `segmentIndex` (the segment's in its `trk`).
- **A route is an untimed track.** Each `rte` with at least two valid
  `rtept`s is one track with `source: "rte"`, `trackIndex` its position
  among the file's `rte`s, `segmentIndex: 0` and a null `time` column
  whatever the file says; its elevations are kept.
- Tracks and routes are returned in file order.
- **Waypoints** (`wpt`) are counted in `waypoints` and otherwise
  ignored. `<extensions>` (heart rate, cadence …), `metadata` and every
  other element are ignored.
- **A valid point** has `lat` and `lon` that are plain decimals
  (optionally signed, optionally with an exponent — not hexadecimal, not
  `Infinity`) within [−90, 90] and [−180, 180]. `ele` is read the same
  way. Other points are skipped and
  counted in `skippedPoints`; a segment or route left with fewer than
  two points is dropped and counted in `skippedSegments`. One bad fix
  does not reject a recording.
- **Time** is ISO 8601 `YYYY-MM-DDThh:mm:ss[.fff][Z|±hh[:mm]]`, read by
  a regular expression into `Date.UTC`. A time without a zone is UTC
  (GPX says so), never local time, so the result does not depend on the
  machine. Fractions round to the millisecond. A date or time that does
  not exist (31 February, hour 24, second 60) or a zone offset past
  23:59 is unreadable. An unreadable time is null for that point; so is
  an unreadable elevation.
- **The first `ele` and `time` of a point win.** GPX 1.0 allows private
  elements directly in a point; one whose local name is `ele` or `time`
  after the GPX one does not override it.
- No caps: the 200 000-point and 200-track limits are G24's API rules.

### 2.3 Errors

`parseGpx` throws `GpxParseError` with a `code`:

| Code | When |
|------|------|
| `malformed` | The text is not well-formed XML (truncated, mismatched tags, no root element). Wraps `XmlParseError`; `offset` is its character offset. |
| `not-gpx` | Well-formed XML whose root is not `gpx` (a KML file, say). |
| `no-points` | No segment or route has two valid points (a waypoints-only file). |
| `not-tcx` | `parseTcx` only (§2.4): the root is not `TrainingCenterDatabase`. |

### 2.4 TCX and telling the two apart

Written by row G31 (user 2026-11-20: "could we support TCX import as
well?"; `packages/shared/src/gps-track/tcx.ts`). `parseTcx(text)`
reads Garmin's Training Center XML v2 into the same `GpxFile` shape as
`parseGpx`, over the same tokenizer, so the import, the caps and the
rest of this document treat both alike.

- **The root's local name must be `TrainingCenterDatabase`**, else
  `not-tcx`; prefixes are stripped, the namespace is not checked, a
  byte-order mark is skipped, `Extensions` are ignored.
- **One track per `Activities/Activity`**, `source: "trk"`, timed,
  `segmentIndex: 0`, `trackIndex` its position among the activities,
  unnamed (the list shows the file name, §5.1). Every `Lap`'s `Track`s
  are joined in file order: a watch's auto-laps (every kilometre, say)
  and pauses do not cut a recording into many tracks; cutting is the
  Tracks tool's split (§5.2). (Deviation from the G31 planner, who
  proposed one track per `Track` like GPX segments; recorded in
  `decisions/slice-g.md`.)
- **One track per `Courses/Course`**, `source: "rte"`, untimed like a
  GPX route (a course's times are a planned pace), named after its
  `Name`; its `CoursePoint`s count as `waypoints`.
- **A `Trackpoint`** gives `Position/LatitudeDegrees`,
  `Position/LongitudeDegrees`, `AltitudeMeters` and `Time`, read with
  §2.2's rules (plain decimals, the ranges, the ISO 8601 times, the
  first of each wins, the roundings). A `Trackpoint` **without a
  `Position`** (a sensor-only sample, common in Garmin files) is not a
  point and not counted; one whose position is unreadable or out of
  range is skipped and counted in `skippedPoints`. An activity or
  course left with fewer than two points counts in `skippedSegments`.
- `creator` is the first `Creator/Name` (the device); `version` null.
- Errors: `malformed`, `not-tcx`, `no-points`, as `GpxParseError`.

**`parseTrackFile(text)`** is what the import calls (`model.ts`
`planImport`): GPX or TCX **by the root element, not the file name** —
`parseGpx`, and when its root is not `gpx`, `parseTcx`. A root that is
neither is `not-gpx`, shown as "not a GPX or TCX file". The picker
accepts `.gpx` and `.tcx` (`application/gpx+xml`,
`application/vnd.garmin.tcx+xml`); a drop takes any file.

## 3. Geometry

Everything in this section is pure: no randomness, inputs never mutated,
and the same input gives the same bytes on the same JavaScript engine.
How far that holds across engines differs by step:

- **Projection (§3.2) is not bit-identical across engines**: it goes
  through proj4's trigonometry, which engines may round differently in
  the last bit (as `docs/map-import.md` §6 says of stage 5). What crosses
  devices is quantised: `unprojectTrack` rounds to 1e-7° (≈ 1 cm), and a
  converted line (G26) is rounded to the document's integer units
  (0.01 mm or 0.001 mm on paper), so a last-bit difference changes a
  stored value only at a rounding tie.
- **Resampling, smoothing and simplification (§3.3–3.4) are
  bit-identical across engines**: they use only + − × ÷ and √, which IEEE
  754 rounds correctly, in a fixed order (no `Math.hypot`, which the
  language leaves implementation-approximated).

G23 and G26 may rely on the second, and on the first only up to the
quantisation.

### 3.1 The projected track

```ts
interface ProjectedTrack {
  x: Float64Array;   // paper mm, y up — the course layer's and the viewer's space
  y: Float64Array;
  metresPerMm: number; // mapScale / 1000
}
```

A projected track is transient, never stored. **Ground metres** are
paper mm × `metresPerMm` (= `mapScale / 1000`); the grid scale factor
(0.04 % on the fixture) is ignored, as `field.ts` `distanceM` does. The
2 m, 10 m and (G23) 15 m of this chapter are ground metres in that
sense. A converted line (G26) multiplies by the document's `unitsPerMm`.

### 3.2 Projection

`projectTrack(frame, track, bounds?)` → `{ track, outside }` goes through
`mapGeo.wgs84ToPaper` only, so a track lands where the viewer puts a GPS
fix: the frame's grid rotation, grid scale factor and the operator's
`correctionDeg` (04 §7: "georeference block + `rotation_correction`").

- **Index-aligned.** `x[i]`, `y[i]` is the track's point `i`; G27's trim
  and split handles map back to stored indices through it.
- **Outside the map.** `bounds` is the header's bounds in native units;
  points outside them are kept (drawn and converted like the others)
  and counted in `outside`. Without `bounds`, `outside` is 0.
- **Errors** (`TrackProjectionError`, `code`; proj4's own exception, if
  it threw, is the `cause`):
  `not-georeferenced` when `mapGeo.epsgOf(frame)` is null — no CRS, no
  paper origin, or an EPSG code proj4 does not know (G25 disables the
  panel with this reason; `isGeoreferenced(frame)` asks first);
  `not-projectable`, with the point's `index`, when a point has no
  finite position. It is thrown rather than the point dropped, so the
  index alignment always holds.
- **Projected on every use.** Tracks are stored in WGS 84, so they are
  projected onto whichever map is open, not "once" as 04 §7 has it.

`unprojectTrack(frame, line, name?)` is the inverse through
`mapGeo.paperToWgs84`, quantised as §2.1, untimed and without
elevation: how an averaged line (G23) is stored. Paper → WGS 84 → paper
is within 0.002 mm, and WGS 84 → paper → WGS 84 within one stored unit
(1e-7°), on the fixture frame.

### 3.3 Resampling and smoothing

`resampleTrack(line, stepM = 2)`: consecutive duplicate points are
dropped; the line, of arc length L, is divided into
`max(1, ceil(L / step))` equal intervals, with the samples at those arc
positions. Both ends are exact, the spacing along the line is at most
`stepM` ground metres, and positions are computed as `k · L / n`, not by
repeated addition. A line with fewer than two distinct points comes
back unchanged. G23 resamples with it. A step that is not positive and
finite is a `RangeError`.

`smoothTrack(line, { stepM = 2, windowM = 10 })` resamples and then
applies `movingAverage(line, K)` with `K = floor(windowM / 2 / stepM)`
samples — 2 at the defaults:

- weights `K + 1 − |j|` for offsets `j = −h … h`: **1, 2, 3, 2, 1** at
  the defaults, normalised by their sum;
- the half-width at sample `i` of `n` is `h = min(K, i, n − 1 − i)`: the
  window shrinks **symmetrically** near the ends, so the line does not
  pull back from them and the **ends are pinned** (bit-identical to the
  input's ends);
- `K < 1` (a window under two steps) leaves the resampled line; a
  negative or infinite window is a `RangeError`.

What this gives: a straight line is a fixed point; independent
cross-track noise on fixes 2 m apart drops to under two thirds of its
RMS (the kernel's floor for independent samples is √(19/81) ≈ 0.48;
resampling a noisy arc correlates neighbouring samples); a right angle
is cut by less than 1.5 m, and samples more than half a window from it
are not moved.

### 3.4 Simplification

`simplifyTrack(line, toleranceMm = 0.1)` is Douglas–Peucker with the
tolerance in **paper mm**, run after smoothing to make the converted
polyline (slice G "Decided in this split": "smoothed, then
Douglas–Peucker"; Bézier fitting is later):

- the result's vertices are a subset of the input's, in order, with both
  ends kept;
- **tolerance bound**: every input point lies within `toleranceMm` of
  the output polyline — distance to the replacing *segment*, not its
  line, so a closed loop's degenerate chord is a point distance;
- a vertex is kept only when its distance is strictly greater than the
  tolerance, so tolerance 0 removes exactly collinear vertices only;
  ties go to the first vertex;
- iterative over an explicit stack: a 200 000-point track does not
  overflow the call stack; distances are compared squared;
- a negative tolerance is a `RangeError`.

### 3.5 Trim and split

On the stored track (`Track`, any subtype), every column sliced alike,
the name kept:

- `trimTrack(track, { start, end })` keeps points `[start, end)` —
  `start` inclusive, `end` exclusive — and needs integers with
  `0 ≤ start`, `end ≤ n`, `end − start ≥ 2`, else `RangeError`. G24's
  `trim_start` / `trim_end` and G27's end handles mean the same range.
- `splitTrack(track, index)` → `[points 0 … index, points index … n − 1]`:
  the split point is in both parts, so they touch, and cutting out a
  break or a wrong turn is split, split, delete the middle. `index` must
  be `1 … n − 2` (two points on each side), else `RangeError`.
- `splitRanges(ranges, index)` divides index ranges (an average's
  `singlePass`) as `splitTrack` divides the points: the left part keeps
  `[start, min(end, index + 1))`, the right `[max(start, index) − index,
  end − index)`, each only where non-empty, so a range covering the
  split point is in both (G24's `split`).

## 4. Averaging passes

A mapper skis a track several times; `averageTracks(passes, opts)`
turns the passes into one line. The method is fixed in `SLICES.md`
slice G "Decided in this split" ("Averaging"), with four refinements
the user decided on 2026-11-13 (`decisions/slice-g.md`, G23): a
canonical direction (§4.2), orientation by matched samples (§4.3), the
first run within reach and the end rule in matching (§4.5). It is pure
and uses only + − × ÷ and √ in a fixed order, as §3.3–3.4 do, so the
same projected passes give the same bytes on every engine; inputs are
never mutated.

### 4.1 Input and result

```ts
interface AverageOptions {
  stepM?: number;        // resampling step, ground metres; default 2
  maxDistanceM?: number; // the match gate, ground metres; default 15
  iterations?: number;   // integer ≥ 1; default 2
}
interface AverageResult {
  line: ProjectedTrack;     // the moved samples of the last iteration, about stepM apart
  singlePass: TrackRange[]; // point indices of `line`, [start, end), ascending,
                            // disjoint, never touching: samples fewer than two passes voted on
  reference: number;        // index in `passes` of the pass chosen as the reference
  reversed: boolean[];      // per pass: used the other way round from how it was given
                            // (§4.2 step 0 and §4.3 together)
}
```

`gpsTrack` exports `averageTracks`, these two types and the defaults
`DEFAULT_MATCH_DISTANCE_M` (15) and `DEFAULT_ITERATIONS` (2); the step
default is §3.3's `DEFAULT_STEP_M`.

- **Projected in, projected out.** The passes are tracks projected by
  §3.2 onto one map; the caller stores the result with `unprojectTrack`
  (§3.2) — WGS 84, untimed, index-aligned — so `singlePass` indexes the
  stored track's points unchanged, on any map. The ranges are kept with
  the stored average (G24's `single_pass`, user 2026-11-13); trimming
  the average shifts them (G27).
- **Ground metres** (§3.1): gate and step are converted to paper mm by
  `metresPerMm`, which all passes must share.
- **The result spans the reference only.** Stretches of other passes
  beyond its ends are not in it.
- **`RangeError`**, as in §3.3: fewer than two passes; a pass with fewer
  than two distinct points; passes with different `metresPerMm`; a step
  or gate that is not positive and finite; `iterations` not an integer
  ≥ 1.

### 4.2 Canonical direction and the reference

0. **Canonical direction** (user 2026-11-13). Consecutive duplicate
   points are dropped (as `resampleTrack` does), and each pass is turned
   to whichever of its point list and its reverse is lexicographically
   smaller (x₀, y₀, x₁, y₁, …): the first point is the smaller of the two
   ends by x, then y; equal ends are decided further in. Reversing any
   pass or reordering the passes therefore gives bit-identical output.
   The result's direction is arbitrary but fixed; a stored average is
   untimed, so its direction carries nothing.
1. **The reference** is the pass of median length — the sum of the
   segment lengths in canonical order. The median length is the one at
   index `floor(n / 2)` of the lengths sorted ascending: the **upper
   median**, so the longer of two. Of the passes of exactly that length,
   the reference is the one with the lexicographically smallest
   canonical point list (a shorter list first on a common prefix). The
   result spans the reference, so with two passes it spans the one that
   covers more, and a pass covering half is reported (§4.6) instead of
   cutting the result to its half.

### 4.3 Orientation of the other passes

2. **By evidence** (user 2026-11-13; the fixed rule alone cannot orient a
   closed loop, whose ends coincide). Each other pass is matched against
   the resampled reference (§4.4–4.5) both ways round, and keeps the
   direction in which more samples get its vote. On a tie it is reversed
   if that brings its ends strictly nearer the reference's — the fixed
   rule: `|p₀ − r₀| + |pₙ − rₙ|` against `|pₙ − r₀| + |p₀ − rₙ|` — and
   otherwise kept. Orientation is decided once, in the first iteration.

A closed loop whose passes start at different places on it is not
aligned by this (each pass is matched from its own start); split such a
pass at the reference's start first (§3.5).

### 4.4 Resampling and normals

3. The reference is resampled with `resampleTrack(reference, stepM)`
   (§3.3). The tangent at an inner sample is the central difference
   `p[i+1] − p[i−1]`, one-sided at the two ends; a zero central
   difference (an exact hairpin) falls back to the forward, then the
   backward difference. It is normalised with √, and the normal is
   `(−tᵧ, tₓ)`, left of travel with y up. A corner sample therefore gets
   the bisector.

### 4.5 Matching

4. Each pass is matched as a polyline (segments, not only vertices),
   unresampled, walking forward from its first point. For each sample
   `p` in order:
   - **Monotone.** Candidates are the points of the pass no earlier
     along it than the previous match of that pass. The first sample
     starts at the pass's first point; a sample without a match leaves
     the previous match where it was.
   - **The first run within reach** (user 2026-11-13). Scanning forward,
     the candidates are the first run of consecutive segments that each
     come within `maxDistanceM` (Euclidean) of `p`; the match `q` is the
     nearest point in that run, ties to the earliest. A later run — the
     pass's second visit to a crossing, or the end of a closed loop — is
     not considered, so a loop that passes itself does not cross-match.
   - **The end rule** (user 2026-11-13). When `q` is the pass's first or
     last point, it counts only if `|(q − p) · t| ≤ stepM`: a pass that
     stops does not keep voting with its end point for 15 m past it.
   - **The vote** is the signed offset along the normal,
     `(q − p) · n`, so |vote| ≤ 15 m; the match becomes the previous
     match.

The reference pass is not matched in the first iteration: it votes 0 at
every sample.

### 4.6 Votes, ranges and the second iteration

5. A sample moves along its normal by the **median of its votes** —
   the votes sorted, the middle one, or the mean of the two middle ones
   for an even count (so the mean for two passes). A sample with **fewer
   than two votes is single-pass**; one with none stays where it is. In
   the first iteration the reference's own vote, 0, counts, so a sample
   only the reference votes on stays and is reported, as the fixed
   method says; in later iterations a lone vote moves the sample onto
   the one pass that covers it.
6. **The second iteration** takes the first one's moved samples as the
   reference: resampled again (§4.4), new normals, every pass (the
   first reference included) matched afresh from its start in the
   orientation of §4.3; the reference line itself does not vote. The
   reference choice and the orientation are not re-derived.
   `iterations` repeats this; the default 2 is the fixed method's
   "repeat once". The result is the last iteration's moved samples (not
   resampled again), and `singlePass` is the maximal runs of its
   single-pass samples.

**Where a pass leaves the others** (a detour, a wrong turn) at an
angle, its departing stretch stays within 15 m of the line for up to
15 m and votes there by its nearest points: with two passes the line
bulges toward it over that stretch, and the single-pass range starts
where the pass is out of reach. With three or more passes the median
rejects it. Moving along a sample's normal by a normal offset lands on
a pass exactly only where the two are parallel; on a slope it overshoots
by up to a few decimetres, which the second iteration mostly removes.

Cost is samples × pass points in the worst case (a pass that is absent
over a long stretch is scanned to its end at every sample there); there
is no spatial index. Measured with three passes at a fix per metre, one
covering only the second half: 10 km well under a second, 25 km 0.9 s,
50 km 3.3 s, 100 km 16 s. Ski-O passes are a few km, but the call is
synchronous and G24 allows 200 000 points a track, so G27 runs it off
the main thread or caps the input.

## 5. Reference layer and editing

The mapper's tracks in the editor's Map mode (`course-editor.md` §13
"GPS tracks"): imported from GPX, listed, and drawn over the map as a
reference to draw from. §5.1 is row G25; editing them (§5.2) is G27's.

### 5.1 Import and the reference layer

Written by row G25 (`packages/web/src/pages/editor/modes/map/tracks/`;
decision row in `decisions/slice-g.md`).

- **Where it is off.** The panel shows the reason and makes no
  `mapTrack` request: on a venue node (`lease.status.nodeRole` is
  `venue`, a lease held or not — a box holds no tracks, §1.3, user
  2026-11-14), without `courses.edit` (every `mapTrack` procedure needs
  it, §1.2), and on a map without a georeference
  (`isGeoreferenced(paperFrameOf(header, rotationCorrection))` false,
  §3.2), in that order. Until `lease.status` answers the panel offers
  nothing (no import, no list); a failed `lease.status` is taken as not
  a venue (a box's reads answer empty anyway, §1.3). Without a pinned
  document Map mode's own `editor-map-none` stands and the panel is
  absent.
- **Import.** One or many `.gpx` files, by the file picker or a drop on
  the panel. Each is parsed on the device with `parseGpx` (§2); a file
  that does not parse (`malformed`, `not-gpx`, `no-points`) is reported
  by name and code and the others still import. One track per segment in
  file order (§2.1); `name` is the GPX name cut to 200 characters (null
  when there is none) and `sourceName` the file name cut to 255 (§1.2
  "Inputs"). A track over 200 000 points is refused on the device, by
  name, and the rest go. The tracks go in calls of at most 200 tracks
  and 500 000 points each, in file order (§1.2 "Caps"); ids are minted
  by the server. A refused call (`TRACK_LIMIT` and the other `TRACK_*`
  codes, translated; a refusal without one, such as a lost connection, is
  `failed`) stops the import there: the calls before it stay imported.
  The refusal is reported under the call's first file (a call may span
  files). The result line counts the tracks imported and the points,
  segments and waypoints the files had that were not imported (§2.2).
- **The list** is `mapTrack.list`'s order. A row shows the track's
  colour, its name (else the file name), the date it was recorded
  (`recordedAt` as a local date; a dash when untimed), its length in
  ground metres and its point count — both of the trimmed range
  (§3.5) —, a mark with the count when points lie outside the map, a
  mark when it is converted (`convertedOp`, G26), and (G26) a checkbox
  selecting it for a conversion (§6; session only, `ready` rows). Length is the sum of the
  projected trimmed track's segment lengths × `metresPerMm` (§1.1, §3.1).
  Points are fetched per track with `mapTrack.get`, one request at a
  time, after the list (a capped track is megabytes); a row shows that it
  is loading until then. Points never change under one id (§1.2), so
  they are kept for the session. A `get` that fails makes the row's
  error `load-failed`; it is tried again when the list is next fetched
  (after any write of the panel, or a reload).
- **Projection.** `projectTrack(paperFrameOf(header, rotationCorrection),
  trimTrack(track, trim), header.bounds)` on the pinned document, again
  when the document or the correction changes (§3.2 "Projected on every
  use"). A `not-projectable` track is listed with that error and not
  drawn.
- **The layer.** Each visible, projected track is one polyline over the
  map, 2 CSS px, solid, in its colour, on the editor's UI layer (the
  Map-mode binding's `shapes`, 04 §7 "UI layers"): screen only — never
  requested for print, never in a delivery to a viewer or the kiosk
  (reads are `courses.edit` too, §1.2). Outside points are drawn like the
  others (§3.2).
- **Decimation to the pixel.** The drawn line is `simplifyTrack` (§3.4)
  of the projected track at a tolerance of half a CSS pixel at the zoom
  last reported, rounded down to its octave
  (`0.5 × 2^⌊log₂ mmPerPx⌋` mm), so it is recomputed only when the zoom
  crosses a power of two; the ends are kept. Before any zoom is known the
  tolerance is 0.01 mm. The visible tracks share a budget of 50 000
  drawn points: over it the tolerance doubles until they fit. The zoom
  comes from the viewer's pointer events (hover, press, click:
  `ToolPointer.mmPerPx`) — the viewer reports no view change to the page
  (user 2026-11-15, G25 question 1) —, so a zoom with the pointer still
  keeps the old decimation until the pointer moves (§8).
- **Show / hide and colour are the device's** (user 2026-11-15, G25
  question 2): a track is shown unless hidden on this device
  (`localStorage` `oxygen:gps-tracks:<nameId>`, ids no longer listed
  dropped); the colour is one of eight, chosen by a hash of the id, so it
  is stable everywhere and not editable. Neither is stored on the row.
  A converted track is hidden by default (G26, §6.3; *Show converted*
  flips that default), and an average's passes — named in a listed
  track's `derivedFrom` — are hidden by default too (G27, §5.2), with the
  same per-device override, kept only where it differs from the default.
- **Locate.** A click on a row fits the view to the track's trimmed
  bounding box, padded by 5 % with a 10 mm minimum side.
- **Rename and delete** are `mapTrack.update { id, name }` and
  `mapTrack.remove { ids }`. Import, rename and delete are undo entries
  on the editor's stack (`course-editor.md` §3): an import's undo
  removes the ids it answered and its redo imports them again under
  those ids; a delete's undo imports the track again under its id with
  its points, name, file name, `derivedFrom` and `singlePass` (§1.2
  names this use), then restores its trim and `convertedOp` when set —
  it comes back at the end of the list (a new `created_at`). Show /
  hide and locate are not undo entries.

### 5.2 Editing

Written by row G27 (`packages/web/src/pages/editor/modes/map/tracks/`
`edit.ts`, `average.ts`, `average-worker-entry.ts`, the hook
`useMapTracks.ts`; the tool `tools/tracks.ts` and `tools/bindings.ts`
`mapTracksBinding`; the editor's side in `course-editor.md` §13 "GPS
tracks: editing"; decision row in `decisions/slice-g.md`). Trim and
split are the Map-mode tool `T`; *Average* is a button of the panel.
Each gesture is one undo entry on the editor's stack. No API change: G24's
`update`, `split`, `import`, `remove` and `markConverted` carry it all.

Decided by the user before planning (2026-11-15):

- **Converting an average marks its sources** (G27 planner's Q3):
  converting an average also marks its still-listed source passes
  converted with the same op id; undoing the conversion clears them all —
  precisely, restores each one's mark from before, which is null unless
  the pass was converted itself (§6.2; decided overnight, below).
- **A split's undo** removes the two parts and imports the original
  again under its id, then restores its trim and `convertedOp`; it comes
  back at the end of the list (the wart G25 accepted for delete's undo).

**The tool's tracks.** `T` acts on every track selected in the list
(G26's checkboxes) that is visible and `ready` — G30 (user 2026-11-20)
widened this from the one selected track, so that the parts of a split
stay the tool's (below); with none selected it has none, and the panel
says so (`editor-tracks-tool-hint`, `data-state` `pick` | `ready`). In
`T` a click goes to the nearest visible track within 6 CSS px — the
tool's own first on a tie, then list order: on a tool's track it splits
(below), on another it selects that one alone; a click on empty map does
nothing. `T` needs the panel on (§5.1 "Where it is off", and loaded) —
not *Apply corrections*: track writes do not touch the patch — and falls
back to `V` when the panel turns off.

**Nodes** (G30; user 2026-11-20: "When it is armed, shouldn't I see the
nodepoints then, and it will split each time I click one?"). On each
tool's track its splittable stored points (`trim.start + 1 …
trim.end − 2`) are drawn as dots, `editor-track-nodes` (`data-track-id`,
`data-count`): one path, thinned in screen space at the current zoom to
one per 10 CSS px in index order, the spacing doubling while over 4 000
dots (`MapViewer.tsx` `nodePoints`). The stored point a click would split
at is found on hover with the click's own rule (`tools/tracks.ts`
`hoverCandidate`) and drawn larger and filled,
`editor-track-node-hover` (`data-index`), with every splittable point
within 60 CSS px of it, unthinned (`editor-track-nodes-near`,
`edit.ts` `nodesNear`), so the point under the pointer is always shown
whatever the thinning; the cursor is a pointer there. While a handle is
held no nodes are drawn; a track of fewer than four kept points has
none. The handles are drawn above the nodes and keep the press.

**Trim.** The tool's track has two handles (`editor-track-handle`,
`data-end` `start` | `end`, `data-index`) on its stored points
`trim.start` and `trim.end − 1` (§3.5), placed on the full projected
track (index-aligned, §3.2). A press within 7 CSS px of a handle takes the
gesture; past 3 px it moves along the stored points: to the stored point
nearest the pointer, over the whole track (so a trim is restored by
dragging back out), keeping two points between the handles. Where two
stretches of the track run side by side (an out-and-back), among the
points within the handle's reach of the nearest one the handle takes the
one nearest in index to where it was, so it stays on its own leg. While
held, the layer draws the live trim; while part of the track is trimmed
away the whole track is drawn under it thin and grey
(`editor-track-trimmed`). The release writes one
`mapTrack.update { id, trim }` — none when the handle is back on its
point, or when the drag was cancelled (Escape, the pointer leaving); undo
and redo are one `update` each. Until the write settles the new trim is
drawn and no new press is taken. Trim is at stored points only: the API
takes indices, and the points never change under an id (§1.2).

**Split.** A click on a tool's track within 6 CSS px splits it at the
nearer stored point of the nearest kept segment (ties to the earlier) —
the hovered node —
when that leaves two visible points on each side
(`trim.start + 1 … trim.end − 2`, §1.2 "Split"); next to a handle a
click does nothing. One `mapTrack.split { id, index, ids }`, the ids
UUIDv7 minted on the device in consecutive milliseconds (ascending, left
first); the parts' points are the stored points split on the device
(`splitTrack`, §3.5), so nothing is fetched. The two parts take the
original's place in the selection (G30, replacing Q3's "cleared"), so
they stay the tool's tracks with their nodes, and the next click splits
again without re-selecting.
The undo is the user's answer above (remove the parts, `import` the
original under its id with its points, name, file name, `derivedFrom` and
`singlePass`, then `update` its trim when not whole and `markConverted`
its mark when set); the redo splits again under the same ids. Cutting out
a break or a wrong turn is split, split, delete the middle (§3.5).

**Average.** *Average* (`editor-tracks-average`, `data-busy` while it
runs) is enabled with two or more selected rows. Its input is each
selected row's projected trimmed track (hidden or converted rows count
when selected), in list order; `averageTracks` (§4) runs with the
defaults — the 15 m gate, two iterations, no control for either — in a
module worker (`average-worker-entry.ts`), the passes sent as compact
copies so the rows' cached lines are never detached. The result is
stored like an imported track: `unprojectTrack` (§3.2) on the main
thread, one `mapTrack.import` item with a client UUIDv7 id, the name
"Average of *n* tracks" (localised when made; renameable), `sourceName`
`""`, `derivedFrom` the selected ids and `singlePass` the result's
ranges. Over 200 000 points it is refused on the device. A pass split or
deleted while the job runs stays named in `derivedFrom` (provenance only,
§1.1). The average then
becomes the selection, so *Convert to line* is the next click. Its undo
removes it; its redo imports it again under its id. An average may itself
be averaged (`derivedFrom` names the averages, not their passes). No
cancel button: leaving Map mode or the document terminates the worker,
and a job in flight is dropped without an error.

**Sources and single-pass spans.** A track named in a listed track's
`derivedFrom` is hidden by default — *Show converted* or not — under the
same per-device eye override (§5.1 "Show / hide"); deleting or undoing the
average shows its passes again. The rows carry `data-average` /
`data-source` and the marks `editor-track-average` / `editor-track-source`.
An average's single-pass ranges, clipped to its trim and shifted by
`trim.start`, are drawn dashed: the line is drawn as runs, each a path of
its own (`editor-gps-track` with the same `data-track-id`; the dashed ones
`data-single-pass="true"`), simplified each on its own so the run ends
stay, solid and dashed runs sharing their boundary point; a one-sample
range has no dashed run. A track without ranges stays one path. The
ranges convert like the rest of the line (§6).

**Converting an average** (§6.2): `planConversion` adds a mark with the
average's op for each of its still-listed sources, and their marks from
before to the undo's; one `markConverted` never names an id twice — a
track converted itself in the same batch keeps its own op, a source of
two averages in one batch takes the later one's (list order).

Decided overnight on the user's standing instruction (2026-11-13), for
review — each the G27 planner's conservative recommendation:

- **Q1 the undo of an average's conversion restores each source's mark
  from before** (§6.2), not always null: a pass converted on its own keeps
  that conversion's mark, which is sticky until that conversion is undone
  (§6 answer 1). In the usual case the marks were null, so "clears them
  all" holds.
- **Q2 the tool's track and split gesture**: the single checkbox-selected
  visible track (widened by G30 to every selected visible track); split is a plain click on it (no armed *Split* button),
  at stored points only; a click goes to the nearest track in reach (the
  tool's own on a tie), so a click meant for a neighbouring pass selects it
  rather than splitting; on empty map nothing.
- **Q3 after a split** the selection is cleared (superseded by G30, user
  2026-11-20: the parts stay selected, "The tool's tracks") and the original's eye
  override is not carried to the parts (only a visible track can be split;
  a part of a converted track shown by its eye falls back to hidden).
- **Q4 restoring a trim** is dragging the handle back out over the grey
  rest; there is no *Reset trim*.
- **Q5 an average's input** is the trimmed range of each selected row;
  `derivedFrom` is the selected ids, not flattened through averages.
- **Q6 sources stay hidden under *Show converted*** unless their eye says
  otherwise; there is no *Show passes*.

## 6. Conversion into map objects

Written by row G26 (`packages/web/src/pages/editor/modes/map/tracks/`
`convert.ts`, `useTrackConvert.ts`, `ConvertPanel.tsx`; the editor's
side in `course-editor.md` §13 "GPS tracks: convert"; decision row in
`decisions/slice-g.md`). Snapping a converted line's ends is G28's
(answers 4 and 5 below; §6.7).

Decided before planning (the planner's questions and defaults, the user
2026-11-15, every recommendation):

1. **"Converted" is sticky** (G26): a converted track stays converted —
   hidden unless *Show converted* — until the conversion is undone, even
   when its line is later hidden or reverted in Map mode or baked by a
   promote (G12). *Convert* stays available on a converted track; it
   makes a new line and the mark moves to the newest op.
2. **The 2000-node cap** (G26): the convert panel shows the resulting
   node count live and warns above `MAP_NODES_MAX` (2000, G7) that the
   line will not be node-editable; still one `add` op per track.
3. **Controls** (G26): smoothing window in ground metres 0–30, default
   10 (0 = off); simplification 0.02–0.5 mm, default 0.1 (§3.3–3.4).
   Both and the symbol are remembered per device. No default symbol the
   first time.
4. **Track symbols for the end snap** (G28): an end snaps onto ISSkiOM
   track-group lines (801.1–804.2, 805, 807, 813.1 / 813.2; a document
   symbol matched to one, or a patch symbol `ISSkiOM2019:…`) and onto
   document line symbols whose source code is 8xx without a match (a
   club's own ski symbols). Not roads or paths (ISOM 501–508).
5. **Several tracks in one conversion** (G28) are snapped in list order,
   each seeing the document plus the lines already made in that batch.

Decided overnight on the user's standing instruction (2026-11-13), for
review, each the G26 planner's conservative recommendation: Q1 the page
raster in integration (§6.5), Q2 *Show converted* (§6.3), Q3 two writes
(§6.2), Q4 the symbol across maps (§6.4), and Q5 what else works while the
panel is open (`course-editor.md` §13 "GPS tracks: convert": `V` armed, no
move drag, closed by arming another tool).

### 6.1 The line

Per selected track (`ready`: its points loaded and projected, §5.1):

- **Input**: the projected trimmed range (`TrackGeometry.line`, §5.1
  "Projection"), outside points included (§3.2).
- **Smoothing**: `smoothTrack(line, { windowM })` (§3.3, `stepM` 2) unless
  the window is 0, which leaves the projected points as they are (no
  resampling).
- **Simplification**: `simplifyTrack(·, toleranceMm)` (§3.4).
- **Units**: each vertex × the document's `unitsPerMm`, rounded to whole
  units per axis (no flip, no offset: paper mm y-up is the document's
  space, §3.1); a vertex whose rounded coordinate equals the previous
  one's is dropped.
- **The op**: `{ op: "add", id, type: 2, symbol, coords }`, corner nodes
  (no flags), no `angle` — byte for byte what Map mode's `L` writes for the
  same vertices (`draw.ts` `drawOp`, `course-editor.md` §13 "Drawing").
  A track left with fewer than two coordinates is not converted (it would
  be `geometry-invalid`, `map-patches.md` §2.3); the panel counts it.
- **Determinism**: the same track, settings, frame and id give the same
  op; across engines up to the projection's last bit at a rounding tie
  (§3 intro).
- **Ids**: one lowercase UUIDv7 per track, ascending in list order
  (consecutive milliseconds; `map-patches.md` §2.2 orders added objects by
  id), shared by the preview and the write: minted on opening, and all
  again when a track joins the open panel; closing the panel drops them.
- **The symbol**: one line symbol for every track of a conversion, from
  the picker; a library entry is materialised on first use and put in the
  same change (`symbolPut`, `map-patches.md` §1.3).

### 6.2 The write, the mark and undo

- **One change**: `mapPatch.applyChange { documentHash, put: [one add per
  track], putSymbols? }`, then `mapTrack.markConverted { marks: [{ id,
  opId: "add:<id>" }] }` (§1.2). One undo entry on the editor's stack.
- **Two writes, not one transaction** (decided overnight on the user's
  standing instruction (2026-11-13), confirmed by the user 2026-11-17; G26 planner's Q3): the
  patch first, then the marks, on do, undo and redo alike. The marks are
  a step of their own: a refused mark is shown and the entry kept, on undo
  and redo too (the line is there, or gone; the track's mark is merely
  stale). On do the entry is recorded once the marks have settled, so it
  cannot be undone while they are in flight. Marks go
  only to tracks still listed (one deleted meanwhile is skipped, not a
  failed undo). A combined procedure would be an API change outside the
  row; the worst case is a stale mark, which the eye or *Show converted*
  overrides.
- **Undo** removes the adds (the symbol stays, `map-patches.md` §1.5) and
  restores each track's mark from before the conversion: null, or an
  earlier conversion's op (answer 1). Redo writes both again.
- **An average's sources** (G27, §5.2, user 2026-11-15) are marked with
  the average's op in the same `markConverted`, and restored the same way
  on undo; an id is never named twice in one call.
- Hiding, reverting or promoting the line does not touch the mark
  (answer 1).

### 6.3 Visibility and *Show converted*

A converted track (`convertedOp` set) is hidden from the layer by default
and kept in the list with its mark. *Show converted* (decided overnight on
the user's standing instruction (2026-11-13), confirmed by the user 2026-11-17; G26 planner's
Q2) is a checkbox in the panel, per device and per event (`localStorage`
`oxygen:gps-tracks:<nameId>:show-converted`), shown while a listed track
is converted: it makes the default *shown* for converted tracks. The
track's own eye (§5.1 "Show / hide") still wins; an eye override is kept
only where it differs from the default.

### 6.4 The panel's settings and symbol

Remembered on the device, not per event (`localStorage`
`oxygen:gps-track-convert`): smoothing in whole metres, simplification to
0.01 mm, both clamped to answer 3's ranges, *Snap ends* (`snapEnds`, G28,
§6.7; absent or not `false` = on), and the symbol. **The symbol
across maps** (decided overnight on the user's standing instruction
(2026-11-13), confirmed by the user 2026-11-17; G26 planner's Q4): the picked item is
remembered by its key with the document's hash, and by its library entry
when it has one. On that document the item itself is chosen again (not a
sibling document symbol matched to the same entry); on any other map the
first enabled item offering the entry — a library item, a patch symbol,
or a document symbol matched to it. An unmatched document symbol is
chosen on its own document only. Anything else leaves nothing chosen, so
another document's own symbol is never preselected.

### 6.5 In print

A converted line prints as any added object (`map-patches.md` §2; the
reference track never does, §5.1). **The row's "in the PDF's page
raster"** (decided overnight on the user's standing instruction
(2026-11-13), confirmed by the user 2026-11-17; G26 planner's Q1, G9 question 2's precedent) is
proven in integration — `print-patch.test.ts` rasterises `maps.pdf`
(`pdftocairo`) before and after a line with `ISSkiOM2019:801.1` and finds
every changed pixel inside its box — since poppler is not on the E2E job
and no route rasterises a page; the E2E checks the op, the canvas and
`maps.pdf`'s strokes.

### 6.6 Smoothing granularity

The slider is in whole metres while the kernel
half-width is `floor(windowM / 2 / stepM)` samples (§3.3), so the
smoothing changes every 4 m (1–3 m resample only; 10 m smooths as 8 m).
§3.3 is unchanged (§8).

### 6.7 Snapping the ends

Written by row G28 (`modes/map/tracks/snap-ends.ts`; the target search
`nearestOnLines` in `lib/editor/snap.ts`, `course-editor.md` §6.2; the
editor's side in `course-editor.md` §13 "GPS tracks: junctions"; decision
row in `decisions/slice-g.md`). A converted line's ends are moved onto the
track network, so that two tracks meet instead of stopping short of each
other or running past.

- **Where**: at conversion, when the panel's *Snap ends* is on (the
  default; remembered on the device with the other settings, §6.4), and
  afterwards as *Snap ends* on a selected added line (`course-editor.md`
  §13 "Line and area operations").
- **Targets** (answer 4): line objects (type 2) of the effective document,
  added lines included, whose symbol is a **track symbol**: a document
  line symbol whose applied match (`isAppliedMatch`: automatic, or
  confirmed in review) is one of the twelve ISSkiOM track-group lines
  `ISSkiOM2019:` 801.1, 801.2, 802.1, 802.2, 803.1, 803.2, 804.1, 804.2,
  805, 807, 813.1, 813.2 (`TRACK_ENTRY_IDS`; 808 is an area); a patch
  symbol under one of those keys; a document line symbol with **no applied
  match** whose source code is in the 800s (`/^8\d\d(\.\d+)?$/`: a club's
  own ski symbols). Not roads or paths (ISOM 501–508), nor anything matched
  to another entry, nor points and areas. An unreviewed suggestion is not
  an applied match, so a symbol that only has one counts by its code
  (decided overnight on the user's standing instruction (2026-11-13), confirmed by the user 2026-11-17: the renderer draws it from its source too). Hidden
  objects and hidden symbols are no targets (decided overnight on the user's standing instruction (2026-11-13), confirmed by the user 2026-11-17: as the snap
  index). The line being snapped is never its own target.
- **A batch** (answer 5): the tracks of one conversion are snapped in list
  order, each seeing the document's track lines and the lines already
  made in that batch. The batch's lines are targets only when the
  conversion's symbol is itself a track symbol (decided overnight on the user's standing instruction (2026-11-13), confirmed by the user 2026-11-17: one rule
  for what an end snaps onto, so a batch gives what converting the tracks
  one at a time would). On a tie the document's line wins, then the
  earlier line of the batch.
- **Reach**: **1.5 mm** on paper (`SNAP_ENDS_MM`), inclusive, from the end
  node to the nearest point on the target line — the row's own reach, not
  the 0.5 mm of control and node snapping (`course-editor.md` §6.2).
  Target curves are measured on their curve (flattened to 0.01 mm).
- **Per end**, the start first and then the end (each sees the other's
  result); the target is the nearest track line within reach, then in this
  order:
  1. **End to end**: when one of that line's end nodes — the first or last
     node of the part that was hit — lies within 1.5 mm of the end, the end
     node moves onto it; the two lines then share a vertex (joining them
     is G10's *Join*).
  2. **Overshoot**: else, walking back from the end while the line's nodes
     stay within 1.5 mm of the target, the first segment that crosses it is
     cut there: the nodes past the crossing go and the crossing becomes the
     end. The rule "every point after the crossing within 1.5 mm" is
     checked at the nodes of the cut-off tail (decided overnight on the user's standing instruction (2026-11-13), confirmed by the user 2026-11-17). With
     several crossings on that segment the one nearest the end is taken
     (decided overnight on the user's standing instruction (2026-11-13), confirmed by the user 2026-11-17: it removes the least of the recording). A tail
     that leaves reach before a crossing is not cut.
  3. **Short**: else the end node moves to the nearest point on the
     target: the last segment is extended straight onto it, with no node
     added (decided overnight on the user's standing instruction (2026-11-13), confirmed by the user 2026-11-17, the G28 planner's question 1: "moved onto it" read
     literally; on an oblique approach the last segment turns slightly
     rather than being prolonged along its own direction).
  An end already on the target — within half a unit's diagonal, as a
  snapped end rounded to whole units lies — is left as it is, apart from
  step 1, so snapping a snapped line again changes nothing.
  A result is rounded to whole document units. A step that would leave the
  line under two distinct coordinates, or change nothing, is not taken and
  the next one is tried; nothing in reach leaves the end as it was. Only a
  straight end segment is snapped, and the walk back stops at a curve (a
  converted line has none).
- **The other line is never changed**: no node is inserted into it, it is
  not split or joined. A conversion still writes only its own `add`s
  (§6.2); *Snap ends* rewrites only the selected line's `add` — one op.
- **Flags** (only *Snap ends* meets them; a converted line has none): a
  moved or new end keeps the old end's flags without its border bits (at
  the line's end they cover nothing); a new start takes the border bits of
  the segment it now starts. Nodes cut off go with their flags, and the
  gaps are balanced afterwards (`shape-ops.ts` `balanceGaps`).
- **The panel** counts the ends moved (`editor-tracks-convert-snapped`),
  and its node count and preview are of the snapped lines.

## 7. Tests

| File | Proves |
|------|--------|
| `gps-track/__tests__/gpx.test.ts` | GPX 1.1 (Garmin-style, extensions, metadata, two segments) and 1.0 (root name, routes, two tracks); one track per segment in file order with `trackIndex` / `segmentIndex`; four tracks from two `trk` × two `trkseg`; a prefixed namespace, BOM and CDATA name; routes untimed; missing time and elevation per point and per column; zoneless and offset times; invalid points and short segments skipped and counted; `malformed` (truncated, mismatched, empty, not XML), `not-gpx` (KML), `no-points` (waypoints only); a timed route dropped to untimed; the first `time` / `ele` winning over a private element; decimal-only coordinates; impossible dates, hour 24, second 60 and offsets rejected; quantisation; 200 000 points |
| `gps-track/__tests__/tcx.test.ts` | §2.4: an activity of two laps and three `Track`s one timed track, a position-less sample not a point, an out-of-range latitude skipped and counted, an exponent coordinate, zoneless and offset times, elevations rounded, `Extensions` ignored, a short activity a skipped segment, the device as `creator`, BOM; a course one untimed named track with its course point a waypoint; `not-tcx`, `malformed`, `no-points`; `parseTrackFile` reading GPX and TCX by the root, a KML `not-gpx`, a truncated GPX `malformed` |
| `gps-track/__tests__/project.test.ts` | The frame read from `e2e/test.xmap` by the importer; its reference point (a hard-coded lat / lng on the zone's central meridian); paper → WGS 84 → paper within 0.002 mm on it and on an OCAD-unit SWEREF99 TM frame; WGS 84 → paper → WGS 84 within 1e-7°; outside points kept and counted; `correctionDeg`; `not-georeferenced` (no CRS, no origin, unknown code) and `not-projectable` with its index and cause, both ways |
| `gps-track/__tests__/geometry.test.ts` | Resample spacing, exact ends, duplicates, degenerate lines, step and window `RangeError`s; smoothing: straight line fixed, seeded noisy line reduced, corner cut < 1.5 m with the legs unmoved, ends bit-identical, determinism (same bytes), no mutation, the 1-2-3-2-1 kernel and the shrunk window; simplify: tolerance bound at 0.05 / 0.1 / 0.5 mm, subset in order, ends, collinear, tolerance 0, a closed loop, 200 000 points, determinism |
| `gps-track/__tests__/average.test.ts` | Every `RangeError`; no mutation, same bytes twice; the upper-median reference for 2, 3 and 4 passes and the tie among passes of the median length; `unitNormals` (left of travel, one-sided ends, corner bisector, hairpin fallback); two parallel passes → the centre line (straight to 1e-9 m, concentric arcs to 2 cm); an outlier within the gate held to the band of the good passes, also as the reference, and one beyond it without a vote; all 6 orders × 8 reversal patterns of three noisy passes → the same bytes, ranges and reference; the ends rule on a tie (reversed and kept, through `reversed`) and evidence over it; `reversed` following each input reversal; a pass covering half (either way round) → one range ending within a step of where it begins; a detour → its range, re-matched after; a loop crossing itself, with its second visit nearer, does not cross-match; a closed loop skied the other way round is orientated by its matches; `iterations` 1, 2 and 3 differ; ranges disjoint; the result unprojects index-aligned through the `e2e/test.xmap` frame; three 10 km passes at a fix per metre |
| `gps-track/__tests__/track.test.ts` | Quantisation; trim `[start, end)` over every column, null columns, no mutation, every `RangeError`; split sharing its point, split-split cutting out a stretch, every `RangeError`; `splitRanges` before, after and across the split point, a range of the split point in both parts, point-by-point agreement with `splitTrack`, no mutation |
| `api/src/__tests__/map-gps-tracks.test.ts` | Points validation: every refusal (`TRACK_POINTS_INVALID`), edge coordinates, all-null columns stored as null, 200 000 points accepted and one more `TRACK_TOO_MANY_POINTS`; single-pass ranges (empty, reversed, touching, overlapping, out of order, past the end); `firstTime`; `splitStoredTrack` (points as `splitTrack`, both trims, `single_pass` divided, a part's all-null column, every refused index) |
| `api/src/__tests__/venueForwarder.test.ts` | `mapTrack.` mutations forwarded, `list` / `get` not; `tracks.` and `mapTrack.` do not shadow each other |
| `api/src/__tests__/backup.test.ts` | `map_gps_tracks` directly after `map_patches`, filtered by event |
| `api/src/__tests__/integration/map-gps-tracks.test.ts` | The CHECKs; cascade with the event; `created_by` SET NULL; import / list / get round trip (deep-equal points, null columns, input order, list without points), an average with `derivedFrom` + `singlePass`, refusals writing nothing, a retried import by id, an id of another event, scoping; caps (200 000 points, 500 000 a call, 200 tracks with concurrent imports, split at the cap); update (trim set and restored, non-destructive, unchanged keeps the version, every bad trim, `single_pass` untouched); split (shared point, trims, ranges, the row replaced, order, a repeat with ids, split-split-remove); remove twice; markConverted (set, clear, unknown id writes nothing); a course setter does all, a viewer, a kiosk key and a stranger nothing; not in the checkout snapshot; no journal entry |
| `api/src/__tests__/integration/backup.test.ts` | The dump's `map_gps_tracks` section holds the event's tracks; `restore-map-gps-tracks.sql` restores them exactly (points, trim, ranges, token above 2^53) into another event, a missing importer NULL, an existing one kept, twice is once |
| `web/src/pages/editor/__tests__/map-tracks-model.test.ts` | §5.1: where it is off; the import plan (a TCX file beside a GPX one, §2.4; segments in file order, names cut, per-file parse errors, skip counts, the 200 000-point refusal, calls within 200 tracks / 500 000 points); the trimmed projection, length, outside count, `not-projectable`; rows; colour; locate's bounds; per-device overrides; a deleted track's re-import |
| `web/src/pages/editor/__tests__/map-tracks-decimate.test.ts` | §5.1 "Decimation to the pixel": the octave tolerance, the tolerance bound and ends, determinism, the 50 000-point budget, the layer's paths; §5.2: an average's runs (solid and dashed touching, a one-sample range none, a range over the whole line), one path per run under one track id, the dashed ones marked |
| `web/src/pages/editor/__tests__/map-tracks-edit.test.ts` | §5.2: handle ↔ stored-point index and back (start inclusive, end exclusive), the handles' bounds over the whole track keeping two points, a drag to the nearest point within the bounds (outward too, stopping at a bound), an out-and-back keeping the handle on its leg; the split index (the nearer vertex of the nearest kept segment, ties earlier, out of reach or too near an end none, the trimmed-away stretch not clickable); the track under a click; the kept line; an average's ranges clipped and shifted by the trim; G30's `nodesNear` (the splittable points round a point, clipped to the trim, the other leg of an out-and-back included); a split's undo (remove the parts, the original's re-import, trim and mark only when set, an average's `derivedFrom` / `singlePass` kept) |
| `web/src/pages/editor/__tests__/map-tracks-tool.test.ts` | §5.2, the Tracks tool's reducer and binding: a press on a handle taken (the nearer one), elsewhere or without a track not; the drag threshold; the live trim along the stored points, outward restoring, two points kept; the release writing once with the trim before, nothing at the same index, cancelled or without a gesture; a click splitting on the tool's track, nothing next to a handle, selecting another track, nothing on empty map, selecting without a tool track, the nearer of two tracks in reach winning and the tool's own on a tie; the binding exclusive, its handles at the live trim, the draft reported and cleared, the effects sent; no press while a write is in flight; no handles and no press without a track; G30: `hoverCandidate` equal to the click's split and none off the track, next to a handle or without a tool track; two tool tracks (a click splits the one it is on, a press takes the nearest handle of either); the nodes, the near nodes and the hovered node drawn with the handles last, the cursor; hover reported with the zoom and cleared by a split; no nodes while a handle is held or on a track too short; `nodePoints` thinning to the gap in index order and doubling it over 4 000 |
| `web/src/pages/editor/__tests__/map-tracks-average.test.ts` | §5.2 *Average*: the worker's handler is `averageTracks` with the defaults (two passes 3 m apart, one covering half → the centre line, the rest on the one pass, one range), a `RangeError` its error; the passes copied (compact, never the rows' buffers); the client — one worker, answers by id, order-independent bytes, an error rejected, `dispose` terminating and cancelling a job in flight; the import item (client id, name, `sourceName` `""`, `derivedFrom`, `singlePass`, untimed WGS 84 back on the paper within 0.002 mm); refused over 200 000 points or without a georeference |
| `web/src/pages/editor/__tests__/map-tracks-convert.test.ts` | §6 (and §5.2: an average's sources marked with its op and restored on undo, a track converted in the same batch keeping its own op, a source of two averages taking the later's, a skipped average marking none): the fixture L → one `add` at 100 and 1000 units per mm, equal to `drawOp`'s; ends pinned under smoothing; fewer nodes with smoothing and a larger tolerance; determinism and no mutation; rounded duplicates and a one-coordinate track; outside points; a conversion's ops, marks, previous marks, node counts and skipped tracks; `putSymbols` on first use only, applying without an issue; ascending ids; the controls' defaults and ranges; the node count's warning above 2000; the remembered symbol (§6.4); the picker's order |
| `web/src/lib/editor/__tests__/snap.test.ts` (G28 cases) | §6.7's target search `nearestOnLines`: the nearest point inside a segment, the 1.5 mm reach inclusive and not beyond, the symbol filter, points / areas / texts never lines, hidden symbols and the skipped object, a tie to the lower index, a Bézier line measured on its curve with the hit part's ends, the effective document (a hidden line not found, an added one found), the bounding-box reject at the edge; `nearestOnPath` on one line in document units |
| `web/src/pages/editor/__tests__/map-tracks-snap.test.ts` | §6.7: short (moved onto the nearest point), overshoot (cut at the crossing, over several nodes too), a tail leaving reach moved not cut, end to end (before a crossing), nothing in reach unchanged, the reach inclusive, both ends start first, a snap that would collapse the line not made, an end on an oblique line not snapped again, of two crossings the one nearest the end, determinism and no mutation, the flags of a new start (after a cut over several nodes too) and end, a curved end segment left; the filter — the twelve ids equal the library's track-group lines, document symbols (matched, unmatched 8xx, an 8xx matched elsewhere, an unreviewed suggestion, an area and a point, a 505 matched to 805), patch symbols by key, a path nearer than a track passed over |
| `web/src/pages/editor/__tests__/map-tracks-convert.test.ts` (G28 cases) | §6.7 in a conversion: the fixture L's start end to end onto a track's end node and its end extended 1 mm onto another; off or out of reach the ops exactly as without; a path no target; a batch in list order (the second track onto the first's line; not the other way round; not when converted as a path); a tie to the document's line; the node count after a cut; *Snap ends* stored, on by default |
| `web/src/pages/editor/__tests__/map-shape-ops.test.ts` (G28 cases) | *Snap ends* on an added line: the `add` rewritten as the only op, the track line untouched, the inverse restoring it; the line never its own target and paths none (`no-target`); `closed`, `multi-part`; nothing on a document line |
| `api/src/__tests__/integration/print-patch.test.ts` | §6 in print (G26, the row's page raster): a line `add` with `ISSkiOM2019:801.1` materialised on first use changes the rasterised `maps.pdf` page only inside its box |
| `e2e/map-gps-tracks.spec.ts` | §5.1 end to end on `e2e/test.ocd`: import by the picker (a non-GPX file reported; G31: the two passes re-written as a two-lap TCX activity each import as two tracks with the GPX's point counts, the file as their source and drawn where the GPX's points project), the rows, the paths at the fixture's paper mm, locate, hide kept across a reload, a converted track hidden by default and *Show converted*, rename, delete and its undo, a reload keeping the tracks; §6: the fixture track converted with 801.1 — the preview, the op, the mark, the canvas, `maps.pdf`'s strokes, undo, redo, a second conversion moving the mark, the settings and symbol across a reload, a refused mark keeping the undo entry; §6.7: two ISSkiOM 801.1 lines put through the patch, the fixture converted with *Snap ends* on (two ends counted, the start on one line's end node, the end extended onto the other, both lines unchanged), off (the line as recorded), *Snap ends* on the added line (one write, then `no-target`, undone), off remembered across a reload; §5.2 on `e2e/fixtures/gps-passes.gpx` (two synthetic passes, generated with the expected average): trim by `T`'s end handle, undo / redo, outward restoring, the start handle, a reload keeping it; split (G30: the nodes drawn when armed, the hovered node at point 15 with the near nodes, both parts still selected with their nodes after the split), split again without re-selecting, delete the middle, three undos bringing the original back under its id at the end of the list, the redo splitting again; *Average* of the two passes — one import with `derivedFrom` and `singlePass` as the generator's, the passes hidden, the average solid on the centre line and dashed on the one pass, converting it marking all three with one op and its undo restoring them, the average's undo showing the passes (`course-editor.md` §13 "Tests" has the detail) |

## 8. Pending in this chapter

- Trim and split at stored points only (§5.2): on a sparse recording (a
  point every 10 s) a handle or a split lands up to a fix away from the
  pointer. Splitting between points would need new points under an id, or
  a new track; left until a mapper asks.
- *Average* has no cancel and no progress: a long job (§4.6: 3 s at 50 km)
  shows only the busy button; leaving Map mode drops it.
- T's nodes (§5.2, G30) are thinned over the whole track, not culled to
  the view (no `onView`, below): at a deep zoom on a long track the 4 000
  cap widens their spacing on screen; the nodes round the hovered one are
  always all drawn. The thinning projects every kept point on each
  change of view (cached per view).
- TCX (§2.4): activities are unnamed (the file name shows); multi-sport
  and `MultiSportSession` files are read only through their activities.
- A split's parts fall back to the default visibility (§5.2 Q3), so a
  converted track shown by its eye vanishes when split; an average's pass
  shown by its eye keeps that override after the average goes, though it
  is then the default (harmless; not pruned).
- The layer's zoom (§5.1): from pointer events only, so a zoom with the
  pointer still keeps the old decimation until it moves, and no culling to
  the view; a viewer `onView` prop would make both exact (user
  2026-11-15: pointer events now, the prop when `MapViewer.tsx` is free).
- Tracks loaded on entering Map mode: every listed track's points are
  fetched (one at a time) for its length and drawing, hidden ones too; at
  the caps (200 tracks of 200 000 points) that is the whole event's
  tracks in the tab's memory.
- The layer's cost per viewer render: the viewer's `line` shape
  (`MapViewer.tsx` `toolShapeNode`) rebuilds its path and its
  `data-points` string on every render, so up to the 50 000-point budget
  is re-serialised per pan frame. Culling to the view (the `onView` prop
  above) or a cached path in the viewer would bound it; unmeasured.
- The end snap (§6.7) gives the target no node at the junction: a line
  ending in the middle of another meets it without a shared vertex, so a
  later edit of the target moves away from it. Inserting a node into the
  other line was out of the row ("the other line is not changed").
- *Snap ends* leaves a curved end segment alone and the overshoot walk
  stops at a curve: converted lines are polylines, and a hand-drawn curved
  line is snapped only where its end segment is straight.
- *Snap ends* cutting off a tail drops the gap toggles of the nodes cut
  off (balanced afterwards, so a gap opened before the cut and closed in
  the tail is gone).
- The overshoot rule checks the cut-off tail at its nodes, not between
  them: a tail whose segment bulges more than 1.5 mm from a bending target
  between two nodes within reach is still cut.
- Bézier fitting of a converted line (later; polylines for now).
- The smoothing control acts in 4 m steps (§6.6): whole metres over a
  kernel of `floor(windowM / 4)` samples at `stepM` 2. A finer kernel (a
  fractional half-width, or `stepM` from the window) would change §3.3's
  weights and G23's averages; left until a mapper asks.
- A conversion is two writes (§6.2): a refused `markConverted` leaves the
  line written and the track unmarked (reported, the undo entry kept).
- The convert panel's preview and node count recompute on the main thread
  per control change: smoothing once per track and window, simplification
  per tolerance; at the caps (a 200 000-point track) unmeasured.
- Recording a track in the app (waits for a packaged app: a browser
  loses its GPS watch with the screen off).
