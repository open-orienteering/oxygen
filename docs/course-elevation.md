# Course elevation

Normative specification of **heights along a course**: the height profile
of a polyline over a map's height field and the climb read from it (§1–2),
which field is read (§3), what the course editor shows (§4–5), the stated
climb (§6) and leg routes (§7, pending). The height fields themselves are
`docs/map-terrain.md` (§4–7); the course's stored length is
`docs/course-controls-and-matching.md` "Course length".

Implementation: `packages/shared/src/terrain/profile/` — pure TypeScript,
no Node APIs, no randomness; it imports the field's client entry
(`terrain/field/read.js`) only, never the derivation. Consumers import by
subpath, `@oxygen/shared/src/terrain/profile/index.js`.

Units: **paper millimetres, x right, y up** for positions (the frame of
`controls.xpos/ypos` and of the fields); **ground metres** for distances
and heights (`groundMPerMm` of the field read).

## 0. Decided with the user

2026-11-21 (the plan: project thread "Research course elevation features
plan"):

1. **Length and climb stay two numbers.** Climb never changes
   `courses.length_m` (IOF rule 16.3 and 16.4 state them separately).
2. **Climb is computed along the leg's drawn line** — the course layer's
   `DerivedLeg.points`, centre to centre through bends and the crossing
   point, the polyline the stored length is measured on — until a leg has
   a route (§7). It is named *climb along the line* wherever it is shown,
   so it does not read as the stated climb: IOF 16.4 states climb "along
   the shortest sensible route", and the line overstates it.
3. **No per-leg climb in exports.** IOF XML 3.0 has no element for it and
   Oxygen adds no extension.
4. **Maps without a ground model show numbers from the contour field,
   with a disclaimer** (§3, §4).
5. **Noise is handled by a threshold** (§2): a rise counts once it is at
   least 1 m above the last low point.

Decided in implementation (2026-11-21, the slice plan's review; told to
the user):

6. **The rule runs once over the whole course**, not per leg (§2 "A
   course"): with a reset at every control a steady slope cut into short
   legs — a sprint — would lose up to the threshold per leg and could
   state no climb at all. Each leg shows its share of the course's rises.
7. **This chapter's §0 is its decision record.** The feature is not a row
   of `docs/research/vector-map-pipeline/SLICES.md`.

## 1. The profile

```ts
interface TerrainSampler {
  /** Height in metres at a paper point; null outside the field or in a no-data cell. */
  heightAt(p: PaperPoint): number | null;
  /** The field's confidence bit at p (false outside). */
  confidentAt(p: PaperPoint): boolean;
  /** Ground metres per paper mm. */
  groundMPerMm: number;
  /** The field cell on the ground, metres. */
  cellM: number;
  datum: "relative" | "absolute";
  /** The field's `source` (`contours`, `contours.<id>`, `ground.<id>`). */
  source: string;
  provider?: HeightFieldProvider;
}
function fieldSampler(field: HeightField): TerrainSampler;

interface ProfileSample { dM: number; zM: number | null; confident: boolean }
interface PolylineProfile {
  /** Along the polyline on the ground, metres (unrounded). */
  lengthM: number;
  samples: ProfileSample[];
  climbM: number;      // §2, unrounded
  descentM: number;    // §2 mirrored
  /** Height at the last sample minus the first; null unless both have data. */
  netM: number | null;
  /** Share of lengthM with data, 0..1. */
  coverage: number;
  /** Share of lengthM whose samples have data and are confident, 0..1 (≤ coverage). */
  confidence: number;
}
function profileAlong(points: readonly PaperPoint[], sampler: TerrainSampler, opts?: ProfileOptions): PolylineProfile;
function pointAtDistance(points: readonly PaperPoint[], groundMPerMm: number, dM: number): PaperPoint | null;
function distanceAtPoint(points: readonly PaperPoint[], groundMPerMm: number, p: PaperPoint): { dM: number; offMm: number } | null;
```

Every reader of heights along a course goes through a `TerrainSampler`,
never a `HeightField` directly: the choice of field (§3) is made once, and
a later cost surface has the same shape (§7).

**Sampling.** Each segment of the polyline is sampled at its two ends and
at equal steps between, the step the largest that is at most
`stepM = max(1, sampler.cellM / 2)` ground metres (a positive
`opts.stepM` overrides it; tests). `dM` runs along the polyline from its
first point; a vertex is sampled once and a zero-length segment adds
nothing, so a curved leg (flattened into many vertices by the course
layer) has at most `length / step` + its vertex count samples. A polyline of fewer than two points, or of zero length, has
no samples, `lengthM` 0, climb and descent 0, `netM` null, coverage and
confidence 0. `zM` is `sampler.heightAt` (bilinear, `map-terrain.md`
§5.3).

**Coverage and confidence** weigh each sample by the half-steps beside it
(trapezoid), so they are shares of length, not of sample count; both are
clamped to 1, and a sample without data is never confident. `netM` is the
height at the polyline's end minus its start — control to control for a
leg — and null when either end has no data. Climb, descent and net need
not reconcile: a steady rise below the threshold has a net and no climb.

**Distance and place.** `pointAtDistance` gives the paper point a ground
distance along a polyline (clamped to its ends), `distanceAtPoint` the
nearest place on it to a point and how far off the point lies; the graph's
link with the map (§5) uses both.

## 2. Climb

Climb is read from the samples with data, in order, by **hysteresis** with
threshold `T = 1 m` (`opts.thresholdM`; `CLIMB_THRESHOLD_M`):

- Walking the samples, the reader holds the last **low** and is either
  *flat* or *rising*.
- *Flat*: a lower sample becomes the low; a sample at least `T` above the
  low starts a rise (the **high** is that sample).
- *Rising*: a higher sample becomes the high; a sample at least `T` below
  the high ends the rise — `high − low` is added to the climb, and that
  sample becomes the new low.
- At the end a rise in progress is added.

Descent is the same rule on the negated heights. A stretch without data
(`zM` null) is skipped: the samples on either side follow each other, so a
height step across a gap counts as any other.

`climbRises(heights, T)` returns the counted rises as index pairs; the
climb is the sum of `high − low` over them.

The rule is nearly independent of the sampling step (the unit test allows
2 % between 0.5 m and 5 m steps), which is why it is used instead of
summing every rise: at 1 m steps a sum counts each bump of
model noise. Measured on the o-kartan original (400 random legs, 199 km,
synthetic independent noise on a 2 m grid, against the sum of every rise
on the clean field):

| Method | clean | σ 0.1 m | σ 0.2 m | σ 0.3 m |
|---|---|---|---|---|
| sum of every rise, 1 m steps | 0 | +12 % | +34 % | +59 % |
| sum of every rise, 10 m steps | −3 % | −2 % | 0 % | +2 % |
| threshold 0.5 m | −2 % | 0 % | +6 % | +24 % |
| **threshold 1 m** | **−4 %** | **−2 %** | **0 %** | **+5 %** |
| threshold 2 m | −7 % | −6 % | −4 % | −2 % |

**A course.** `courseProfile(legs, sampler)` profiles each leg's polyline
and runs the rule **once over the whole course's heights in order** (§0,
6): a rise that spans a control counts. Per leg it gives the leg's
`PolylineProfile`, its offset along the course and its **share** of the
course's climb and descent: of each rise, the gain of the rise's running
maximum inside the leg (`climbShares`), so a share is never negative and
the legs' shares sum to the course's climb exactly. The totals are length,
climb, descent, coverage and confidence over the legs. A leg whose
coverage is 0 has no climb (`null`); the course is flagged `partial`
when less than 99.5 % of its length has data (`PARTIAL_COVERAGE`), and
its totals are then a lower bound.

**Rounding.** The functions return unrounded metres. A number is shown as
`Math.round` of it (a `-0` shown as 0); a course's climb is rounded once
from the unrounded total, so rounded legs need not sum to it (the rule of
the stored length).

## 3. Which field

`pickClimbField(terrain): { url, basis, provider } | null` over the
event's terrain descriptor (`course.mapMetadata.terrain`,
`docs/map-storage.md` §4.7; read structurally as `ClimbTerrainLike`),
first match:

| Order | Field | When | Basis shown |
|---|---|---|---|
| 1 | `dem.ground` | `dem.state` is `ready`, and the provider's `grade` is `anchor` | `ground` |
| 2 | `dem.anchored` | `dem.state` is `ready` (in practice a coarse provider: a ready anchor-grade DEM has its ground row) | `contours` |
| 3 | the `contours` field | `terrain.state` is `ready` or `pending` | `contours` |
| — | none | no pin, `none`, `over-cap` | — |

A coarse ground model (`glo30-30m`: a 30 m surface model) is never read
for climb. Climb needs only height differences, so the relative
`contours` field serves (§0, 4) — within one connected set of contours:
sets no chain joins float independently (`map-terrain.md` §4.8), and a
leg from one to another sees an arbitrary step. Such regions are weak and
so not confident (`map-terrain.md` §4.7), which the confidence share
shows. There is no `decided` gate (the 3D viewer's 80 %), on the anchored
field either: low confidence is shown, not hidden (§4). A `pending`
contour field is derived by the first fetch of its URL (up to the
derive's limit, `map-storage.md` §4.7); the reader waits (§4).

The **basis** travels with every number: `ground` (a ground model) or
`contours` (the map's contours). With `contours` the UI shows the
disclaimer *From the map's contours: approximate* (§0, 4). When a field's
provider carries an attribution (`HeightFieldProvider.attribution`,
"© Lantmäteriet"), it is shown wherever that field's heights are drawn or
stated (`map-terrain.md` §7.1).

## 4. The editor's numbers

*Pending: slice 2.*

## 5. The profile graph

*Pending: slice 3.*

## 6. The stated climb

*Pending: slice 4.* `courses.climb_m` stays the stated climb (typed on
the Courses page, printed on the description sheet, exported as IOF
`Climb`); the computed climb is offered, never written unasked.

## 7. Leg routes

*Pending.* A route is a polyline between two controls of an event, drawn
or estimated; `profileAlong` takes it as it takes the drawn line, and a
leg with a route states its climb along the route.

## Tests

| Test | Covers |
|---|---|
| `packages/shared/src/terrain/profile/__tests__/profile.test.ts` | §1: the sampler, sampling step, vertices once, lengths, no-data and confidence shares, net, degenerate polylines, `pointAtDistance` / `distanceAtPoint`; §2 "A course": offsets, a rise across a control, shares summing to the total, a leg without data, `partial` |
| `packages/shared/src/terrain/profile/__tests__/climb.test.ts` | §2: the hysteresis rule on hand-made heights, descent, step independence, a noise bound against a plain sum, `climbRises`, `climbShares` |
| `packages/shared/src/terrain/profile/__tests__/pick.test.ts` | §3: the order over every descriptor state |

## Pending in this chapter

- §4–7 as marked.
- §2: the threshold was chosen on synthetic noise over the contour field;
  a comparison of `ground.lantmateriet-2m` against the contour field on
  real courses is not made (the ground field is in no test database).
- §2: a height step across a stretch without data counts as any other
  (the only case where a gap adds climb), and on the plain contour field
  a step between floating components counts too (§3); neither is
  removed, both lower the coverage or confidence share shown.
- §3: sprint maps — bridges, stairs and multi-level areas are in no
  height model; the number is shown as on any map.
