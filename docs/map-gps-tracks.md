# GPS tracks

Status: **draft** — chapter of the vector map pipeline specification,
started by sub-slice G22. GPS tracks are new scope for slice G (user,
2026-11-13, `docs/research/vector-map-pipeline/SLICES.md` "Slice G",
rows G20–G28): the research decides none of it beyond 04 §7
("Georeferenced inputs" become paper-space overlays) and 06 §3.2 (a
source's GPX templates are dropped at import). Each row records its
decisions in `decisions/slice-g.md`. When the research and this
document disagree, this document wins.

The use is ski-O mapping: a mapper skis the tracks with a GPS logger,
imports the GPX files into an event, averages several passes, trims and
splits them, and converts them into ISSkiOM track lines on the event's
map (Map mode, `course-editor.md` §13). This chapter is normative for
`packages/shared/src/gps-track/` (`import { gpsTrack } from
"@oxygen/shared"`). It covers storage (§1), reading GPX (§2), the
geometry on the paper (§3), averaging passes (§4), the reference layer
and editing (§5) and conversion into map objects (§6).

## 1. Storage

Pending (G24). Tracks are per event, in their own cloud-owned table
`map_gps_tracks`, one row per track segment, stored in WGS 84 so that a
re-match or a new map edition does not move them (slice G "Decided in
this split", answer 10). The row's `points` are the `TrackPoints`
columns of §2.1 verbatim, and its trim is a `TrackRange` (§3.5). An
average (§4) also keeps its `singlePass` ranges (`single_pass`, user
2026-11-13).

## 2. GPX

A GPX file is parsed **in the browser**; the server stores points, not
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
}
```

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
   segment lengths in canonical order. The passes are sorted by length,
   ties by the canonical point list (a shorter list first on a common
   prefix), and the reference is the one at index `floor(n / 2)`: the
   **upper median**, so the longer of two. The result spans the
   reference, so with two passes it spans the one that covers more, and
   a pass covering half is reported (§4.6) instead of cutting the
   result to its half.

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

5. A sample with **fewer than two votes stays** where it is and is
   **single-pass**. With two or more it moves along its normal by their
   median — the votes sorted, the middle one, or the mean of the two
   middle ones for an even count (so the mean for two passes). In the
   first iteration the reference's own vote counts, so a sample only the
   reference votes on stays and is reported, as the fixed method says.
6. **The second iteration** takes the first one's moved samples as the
   reference: resampled again (§4.4), new normals, every pass (the
   first reference included) matched afresh from its start in the
   orientation of §4.3; the reference line itself does not vote. The
   reference choice and the orientation are not re-derived.
   `iterations` repeats this; the default 2 is the fixed method's
   "repeat once". The result is the last iteration's moved samples (not
   resampled again), and `singlePass` is the maximal runs of its
   single-pass samples.

Cost is samples × pass points in the worst case (a pass that is absent
over a long stretch is scanned to its end at every sample there); there
is no spatial index.

## 5. Reference layer and editing

Pending (G25, G27).

## 6. Conversion into map objects

Pending (G26, G28).

## 7. Tests

| File | Proves |
|------|--------|
| `gps-track/__tests__/gpx.test.ts` | GPX 1.1 (Garmin-style, extensions, metadata, two segments) and 1.0 (root name, routes, two tracks); one track per segment in file order with `trackIndex` / `segmentIndex`; four tracks from two `trk` × two `trkseg`; a prefixed namespace, BOM and CDATA name; routes untimed; missing time and elevation per point and per column; zoneless and offset times; invalid points and short segments skipped and counted; `malformed` (truncated, mismatched, empty, not XML), `not-gpx` (KML), `no-points` (waypoints only); a timed route dropped to untimed; the first `time` / `ele` winning over a private element; decimal-only coordinates; impossible dates, hour 24, second 60 and offsets rejected; quantisation; 200 000 points |
| `gps-track/__tests__/project.test.ts` | The frame read from `e2e/test.xmap` by the importer; its reference point (a hard-coded lat / lng on the zone's central meridian); paper → WGS 84 → paper within 0.002 mm on it and on an OCAD-unit SWEREF99 TM frame; WGS 84 → paper → WGS 84 within 1e-7°; outside points kept and counted; `correctionDeg`; `not-georeferenced` (no CRS, no origin, unknown code) and `not-projectable` with its index and cause, both ways |
| `gps-track/__tests__/geometry.test.ts` | Resample spacing, exact ends, duplicates, degenerate lines, step and window `RangeError`s; smoothing: straight line fixed, seeded noisy line reduced, corner cut < 1.5 m with the legs unmoved, ends bit-identical, determinism (same bytes), no mutation, the 1-2-3-2-1 kernel and the shrunk window; simplify: tolerance bound at 0.05 / 0.1 / 0.5 mm, subset in order, ends, collinear, tolerance 0, a closed loop, 200 000 points, determinism |
| `gps-track/__tests__/track.test.ts` | Quantisation; trim `[start, end)` over every column, null columns, no mutation, every `RangeError`; split sharing its point, split-split cutting out a stretch, every `RangeError` |

No integration or E2E test: the module has no API, table or UI until
G24 / G25 (AGENTS.md §4, "New algorithm / computation").

## 8. Pending in this chapter

- §1 storage, the table and the API (G24).
- §5 the reference layer in Map mode and trim / split / average there
  (G25, G27).
- §6 conversion into `add` ops and snapping ends onto the track network
  (G26, G28).
- Bézier fitting of a converted line (later; polylines for now).
- Recording a track in the app (waits for a packaged app: a browser
  loses its GPS watch with the screen off).
