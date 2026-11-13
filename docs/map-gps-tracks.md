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
columns of §2.1 verbatim, and its trim is a `TrackRange` (§3.5).

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
  `rtept`s is one track with `source: "rte"`, `segmentIndex: 0` and a
  null `time` column whatever the file says; its elevations are kept.
- Tracks and routes are returned in file order.
- **Waypoints** (`wpt`) are counted in `waypoints` and otherwise
  ignored. `<extensions>` (heart rate, cadence …), `metadata` and every
  other element are ignored.
- **A valid point** has `lat` and `lon` that parse to finite numbers
  within [−90, 90] and [−180, 180]. Other points are skipped and
  counted in `skippedPoints`; a segment or route left with fewer than
  two points is dropped and counted in `skippedSegments`. One bad fix
  does not reject a recording.
- **Time** is ISO 8601 `YYYY-MM-DDThh:mm:ss[.fff][Z|±hh[:mm]]`, read by
  a regular expression into `Date.UTC`. A time without a zone is UTC
  (GPX says so), never local time, so the result does not depend on the
  machine. Fractions round to the millisecond. An unreadable time is
  null for that point; so is an unreadable elevation.
- No caps: the 200 000-point and 200-track limits are G24's API rules.

### 2.3 Errors

`parseGpx` throws `GpxParseError` with a `code`:

| Code | When |
|------|------|
| `malformed` | The text is not well-formed XML (truncated, mismatched tags, no root element). Wraps `XmlParseError`; `offset` is its character offset. |
| `not-gpx` | Well-formed XML whose root is not `gpx` (a KML file, say). |
| `no-points` | No segment or route has two valid points (a waypoints-only file). |

## 3. Geometry

Everything in this section is pure and deterministic: float arithmetic
in a fixed order, no randomness, inputs never mutated. The same track
gives the same bytes on every device, which the conversion (§6) and
averaging (§4) rely on.

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
- **Errors** (`TrackProjectionError`, `code`):
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
back unchanged. G23 resamples with it.

`smoothTrack(line, { stepM = 2, windowM = 10 })` resamples and then
applies `movingAverage(line, K)` with `K = floor(windowM / 2 / stepM)`
samples — 2 at the defaults:

- weights `K + 1 − |j|` for offsets `j = −h … h`: **1, 2, 3, 2, 1** at
  the defaults, normalised by their sum;
- the half-width at sample `i` of `n` is `h = min(K, i, n − 1 − i)`: the
  window shrinks **symmetrically** near the ends, so the line does not
  pull back from them and the **ends are pinned** (bit-identical to the
  input's ends);
- `K < 1` (a window under two steps) leaves the resampled line.

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
  overflow the call stack.

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

Pending (G23). The method is fixed in `SLICES.md` slice G "Decided in
this split" ("Averaging"); it works in ground metres (§3.1) on tracks
projected by §3.2, resamples with `resampleTrack`, and stores its
result through `unprojectTrack`.

## 5. Reference layer and editing

Pending (G25, G27).

## 6. Conversion into map objects

Pending (G26, G28).

## 7. Tests

| File | Proves |
|------|--------|
| `gps-track/__tests__/gpx.test.ts` | GPX 1.1 (Garmin-style, extensions, metadata, two segments) and 1.0 (root name, routes, two tracks); one track per segment in file order with `trackIndex` / `segmentIndex`; four tracks from two `trk` × two `trkseg`; a prefixed namespace, BOM and CDATA name; routes untimed; missing time and elevation per point and per column; zoneless and offset times; invalid points and short segments skipped and counted; `malformed` (truncated, mismatched, empty, not XML), `not-gpx` (KML), `no-points` (waypoints only); quantisation; 200 000 points |
| `gps-track/__tests__/project.test.ts` | The frame read from `e2e/test.xmap` by the importer; its reference point; paper → WGS 84 → paper within 0.002 mm on it and on an OCAD-unit SWEREF99 TM frame; WGS 84 → paper → WGS 84 within 1e-7°; outside points kept and counted; `correctionDeg`; `not-georeferenced` (no CRS, no origin, unknown code) and `not-projectable` with its index |
| `gps-track/__tests__/geometry.test.ts` | Resample spacing, exact ends, duplicates, degenerate lines; smoothing: straight line fixed, seeded noisy line reduced, corner cut < 1.5 m with the legs unmoved, ends bit-identical, determinism (same bytes), no mutation, the 1-2-3-2-1 kernel and the shrunk window; simplify: tolerance bound at 0.05 / 0.1 / 0.5 mm, subset in order, ends, collinear, tolerance 0, a closed loop, 200 000 points, determinism |
| `gps-track/__tests__/track.test.ts` | Quantisation; trim `[start, end)` over every column, null columns, no mutation, every `RangeError`; split sharing its point, split-split cutting out a stretch, every `RangeError` |

No integration or E2E test: the module has no API, table or UI until
G24 / G25 (AGENTS.md §4, "New algorithm / computation").

## 8. Pending in this chapter

- §1 storage, the table and the API (G24).
- §4 averaging (G23).
- §5 the reference layer in Map mode and trim / split / average there
  (G25, G27).
- §6 conversion into `add` ops and snapping ends onto the track network
  (G26, G28).
- Bézier fitting of a converted line (later; polylines for now).
- Recording a track in the app (waits for a packaged app: a browser
  loses its GPS watch with the screen off).
