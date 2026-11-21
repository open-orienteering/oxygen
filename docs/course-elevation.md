# Course elevation

Normative specification of **heights along a course**: the height profile
of a polyline over a map's height field and the climb read from it (§1–2),
which field is read (§3), what the course editor shows (§4–5), the course's
stored climb (§6, pending) and leg routes (§7, pending). The height fields themselves are
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
   a route (§7). IOF 16.4 states climb "along the shortest sensible
   route", and the line overstates it; a leg with a route states its
   climb along the route. (Superseded in part by 8: the number is not
   named apart.)
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

2026-11-21, 22:55 (the user, in the thread, on the first editor build):

8. **One number, called climb / stigning.** The editor does not show a
   computed "climb along the line" beside a stated climb. The computed
   climb **is** the course's climb — in the editor, on the description
   sheet and in exports (§6) — "to calculate the official value as
   correctly as possible". A climb someone typed (Courses page, an
   import) is the course's climb instead, marked manual, with a way back
   to the computed one: the rule of the stored length
   (`course-controls-and-matching.md` "Course length").
9. **Route alternatives are the target of §7**: a leg selected shows its
   computed top alternatives with metres, climb and estimated time, and
   the course the same summed; stored per control pair in running order.

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

Implementation: `packages/web/src/pages/editor/useCourseElevation.ts`
(the hook), `lib/editor/elevation.ts` (what is shown), `lib/editor/status.ts`
(the climb row), `pages/editor/EditorStatus.tsx`, `StatusBar.tsx`,
`modes/LegSection.tsx`.

### 4.1 Which course

The editor computes heights for **the selected course in Course mode,
when its order is `ordered` and the viewer draws it alone and whole**:
the legs are the layer's `DerivedLeg.points` of that one course
(`useCourseChecks` `legs`, the derivation the length is read from,
`course-editor.md` §8). There is nothing to read — and the field is not
asked for — in the all-controls and all-variations views, for a
free-order course, while a part of the course is drawn (Layout mode on a
part sheet) and for a course without legs.

### 4.2 The field

`pickClimbField` (§3) over `course.mapMetadata.terrain`; the field is
fetched by `useHeightField` (`docs/map-rendering.md` §5.4 "Field": one
request per URL, kept in memory and in Cache Storage, so the editor and
the 3D viewer share it and it reads offline once fetched). The profile is
`courseProfile(legs, fieldSampler(field))`, recomputed when the legs
change — a control moved, a bend dragged — never the field.

### 4.3 States

| State | When | Shown |
|---|---|---|
| `none` | §4.1 does not hold, or §3 picks no field | nothing new: the stored climb as before |
| `loading` | the field is being fetched (a `pending` contour field is derived by this request) | the stored climb if there is one, else *Climb: reading heights…* |
| `unavailable` | the fetch failed (`offline`, `pending`, `failed`, `missing`, `unauthorised`) | the stored climb if there is one, else *Climb: heights not available* and **Try again** (`editor-stats-elevation-retry`), which asks once more |
| `ready` | the field is read | §4.4, §4.5 |

A course whose profile has no length or no data at all (coverage 0)
shows as `none`.

### 4.4 The climb row

The course-info popover has **one** climb row (`editor-stats-climb`,
§0 decision 8), by the first that applies:

1. **A typed climb** — the course's stored climb when it was typed
   (until §6 stores the source, every stored climb above 0 is a typed
   one): `85 m climb`, `data-m`, `data-source="manual"`. Nothing about
   the computed climb is shown with it.
2. **The computed climb** (`ready`): `135 m climb · 3.1 %` — the
   course's climb (§2 "A course", rounded once) and its share of the
   profile's length in percent to one decimal. `data-m`,
   `data-source="computed"`, `data-state="ready"`, `data-share`,
   `data-basis` (`ground` / `contours`), `data-partial`, `data-approx`.
3. **The stored climb** while the field loads or cannot be read
   (`data-source="stored"`, `data-state`).
4. The state's words (§4.3; `data-state`), or no row in state `none`
   without a stored climb.

**Approximate.** The computed number is written `≈ 135` (`data-approx`)
when the course is `partial` (§2) or less than 80 % of its length is
confident (`ELEVATION_CONFIDENT_MIN`, the 3D gate's share); the data
attributes carry the bare number.

**Under the rows**, for the computed climb only: with basis `contours`
the disclaimer *From the map's contours: approximate*
(`editor-stats-elevation-note`; §0, 4); when partial, *Part of the course
has no height data: at least this much* (`editor-stats-elevation-partial`);
the field provider's attribution when it has one
(`editor-stats-elevation-attribution`, `map-terrain.md` §7.1).

**Phone.** The sheet's peek line (`editor-status`, `course-editor.md`
§10) shows the same row without the share (`135 m climb`;
`data-climb` on the line); the words of `loading` / `unavailable` are
left off it, as are the notes.

### 4.5 The selected leg

With a leg selected (`course-editor.md` §6.7) and the state `ready`, the
Leg section shows, read-only, on a phone too
(`editor-leg-elevation`, `data-basis`, `data-approx`): **Length**
(`editor-leg-length`), **Climb** (`editor-leg-climb`: the leg's share of
the course's climb, §2), **Descent** (`editor-leg-descent`) and **Net**
(`editor-leg-net`: the end's height minus the start's, signed), each
in whole metres with `data-m`; a dash where the leg has no data. `≈`
on climb and descent when less than 99.5 % of the leg has data or less
than 80 % is confident. With basis `contours` the disclaimer is repeated
under them (`editor-leg-elevation-note`). The leg is found among the
course's derived legs by its insert position
(`insertIndexForLeg`). These numbers are shown under a typed course
climb too: they are the leg's, not the course's stated value.

## 5. The profile graph

Implementation: `packages/web/src/lib/editor/profile-graph.ts` (the
model), `pages/editor/ProfilePanel.tsx` (the panel, plain SVG),
`components/MapPanel.tsx` `bottomPanel`.

**Where.** A panel under the map, inside the map's fullscreen subtree,
144 px high (`PROFILE_PANEL_HEIGHT`); the map gives it its height, and
the tool rail scrolls when the window is too short for both. Desktop and
tablet only: the phone has no panel. It is shown when it is **open** and
§4's state is `ready`, and is opened and closed by *Show / Hide elevation
profile* in the course-info popover (`editor-stats-profile-toggle`,
`aria-pressed`; offered only in state `ready`, under a typed climb too)
and closed by its ✕ (`editor-profile-close`). Open or closed is kept on
the device (`localStorage` `oxygen.editor.profilePanel`, `open` /
`closed`; closed by default).

**What** (`editor-profile`: `data-basis`, `data-datum`,
`data-length-m`):

- A header: the title, the summary `1.7 km · ↑ 38 m · ↓ 37 m`
  (`editor-profile-summary`: the profile's length, climb and descent,
  §2 — the computed values, also under a typed climb), what the height
  axis counts, and with basis `contours` the disclaimer
  (`editor-profile-note`).
- The graph (`editor-profile-graph`): height against distance along the
  course, one line (`editor-profile-line`, the course purple, 2 px) over
  a light area down to the baseline. The line breaks where there is no
  data. **One axis**: a field with datum `relative` is drawn as *metres
  above the course's lowest point*, an `absolute` one as *metres above
  sea level*; the range is at least 10 m (`MIN_SPAN_M`) and ends on round
  ticks (`niceTicks`: 1, 2, 5 × 10ⁿ). Distance ticks in km.
- The controls (`editor-profile-control`, `data-index`, `data-d`): a
  dashed vertical mark where each leg starts and at the finish, labelled
  along the top `S`, `1`, `2` … `F` (the leg's ordinal, as the course's
  numbers; `M` for the finish in Swedish); labels closer than 16 px thin
  out, the first and last stay (`boundLabels`).
- The selected leg (§4.5) is shaded (`editor-profile-selected`,
  `data-leg`).

A long course is drawn with at most two points per pixel column — the
column's lowest and highest, so peaks stay (`decimate`).

**The pointer.** Over the graph it reads a place: a crosshair
(`editor-profile-crosshair`) with a dot on the line, and a readout
(`editor-profile-tooltip`: `data-d`, `data-z`, `data-leg`) — the height,
the distance along the course and the leg by its controls' codes
(*36 m · at 0.87 km · Leg 87 → 86*), or *No height data here*. The same
place is marked on the map by a dot (`editor-profile-map-dot` in the
viewer's marker layer, `data-x` / `data-y` paper mm, `data-leg`;
`pointAtDistance` over the leg's drawn line), updated once per frame. A
**click** selects the leg under the pointer, as a click on the leg on
the map does (the Leg section, the action bar's leg actions at that
place). The pointer leaving removes the readout and the dot.

## 6. The course's stored climb

*Pending: slice 4.* `courses.climb_m` is the course's climb (printed on
the description sheet, exported as IOF `Climb`). §0 decision 8: the
computed climb is stored there with a source (`climb_source`, as
`length_source`), a typed one wins and can be cleared back to the
computed one. Until then the editor shows the computed climb only for a
course without a stored one (§4.4).

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
| `packages/web/src/lib/editor/__tests__/elevation.test.ts` | §4.3–4.5: what a state shows, rounding, the share, approximate, a leg's numbers and a leg without data |
| `packages/web/src/lib/editor/__tests__/status.test.ts` "the climb row is one number" | §4.4: the order typed · computed · stored · words, the phone's short text |
| `e2e/course-editor-elevation.spec.ts` | §4 in the browser on a synthetic plane field: the computed climb and its notes, a leg's numbers, a moved control, a ground model's attribution, a failed read and **Try again**, a typed climb, free order and the all-controls view, a map without a field |
| `e2e/course-editor-phone.spec.ts` "the computed climb on a phone" | §4.4 "Phone" |
| `packages/web/src/lib/editor/__tests__/profile-graph.test.ts` | §5: points and bounds, the leg at a distance, ticks, the scale and its minimum span, the paths and their breaks, decimation, the height at a distance, label thinning, the kept preference |
| `e2e/course-editor-profile.spec.ts` | §5 in the browser: the toggle, the panel under the map and above the rail's end, the controls, the summary, the kept preference, ✕; the pointer's readout, the dot on the map, a click selecting the leg |

## Pending in this chapter

- §6–7 as marked.
- §5: the map does not point back at the graph (hovering a leg on the map
  marks nothing on the profile); stretches of low confidence are not
  drawn apart; there is no table view of the profile and no keyboard
  reading of it; the phone has no profile.
- §4.4: a typed climb cannot be cleared back to the computed one in the
  editor yet, and the computed climb is not stored, printed or exported
  (§6).
- §2: the threshold was chosen on synthetic noise over the contour field;
  a comparison of `ground.lantmateriet-2m` against the contour field on
  real courses is not made (the ground field is in no test database).
- §2: a height step across a stretch without data counts as any other
  (the only case where a gap adds climb), and on the plain contour field
  a step between floating components counts too (§3); neither is
  removed, both lower the coverage or confidence share shown.
- §3: sprint maps — bridges, stairs and multi-level areas are in no
  height model; the number is shown as on any map.
