# Course elevation

Normative specification of **heights along a course**: the height profile
of a polyline over a map's height field and the climb read from it (§1–2),
which field is read (§3), what the course editor shows (§4–5), the course's
stored climb (§6) and leg routes with computed alternatives (§7). The height fields themselves are
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

Decided in implementation of §6 (2026-11-22; told to the user, open to
change):

10. **The stored computed climb is the whole metre**, not rounded to
    5 m: the editor, the sheet and the export state one number.
11. **A partial profile stores no climb** (it would be a lower bound).
12. **`file` and `manual` are distinct sources** that win alike; an
    import without a climb leaves a typed climb alone.
13. **Courses that exist are filled on their next edit** or when opened
    in the editor; there is no job over all events.
14. **Every ordered course on a map with heights now prints and exports
    a climb**, the contour-based approximate ones included.

2026-11-21, 23:58 (the user, in the thread, on the plan for routes):

15. **The official climb follows the shortest legal alternative**,
    computed automatically, and the setter can pin another route per
    leg. Course length stays as it is measured.
16. **Estimated times are shown before calibration**, from a simple
    speed model (pace by terrain type and slope), marked uncalibrated.
17. **One expected winner pace per course** (min/km, typed);
    alternatives are ranked relative to it.

Decided in implementation of §7.1–7.4 (2026-11-22; told to the user):

18. **A route belongs to the directed control pair**, shared by every
    course running it, and only a **chosen** route changes a climb
    (§0.2's "a leg with a route" is "a leg with a chosen route").
19. **Routes are not journaled**: they travel with the backup and the
    checkout snapshot only.
20. **A marked-route leg ignores routes**; route writes are not undoable.
21. **The search is a cost grid with Dijkstra, in the browser** (a web
    worker), not a visibility graph: area speeds and slope are per-cell
    costs, which a visibility graph does not model. §1's "a later cost
    surface has the same shape" is a separate `CostModel` over classes
    and slope.
22. **Alternatives are found on demand per leg** (Find routes), and an
    alternative changes the climb only once someone uses it.

Decided in implementation of §7.5 (2026-11-22; told to the user, open
to change):

23. **The automatic shortest legal route is searched on the server**,
    in a worker thread after the edit has committed — not in the
    browser (§0.21 holds for the alternatives a person asks for): the
    official climb must not depend on someone opening the editor, and
    imports get it too. Until a route lands the climb is read as
    before; when it lands the climb is computed again.
24. **A person's choice is the pin** (§0.15): choosing another route,
    or the drawn line, takes the choice from the automatic route, and
    a refresh never gives it back. The automatic route stays in the
    list to be chosen again.
25. **An out-of-bounds object closes a pair's way for the automatic
    route when every course running the pair is drawn with it**
    (scope *all*, or each of those courses named); an object scoped by
    class is not read.
26. **Map corrections do not start a search by themselves**: the routes
    are brought up to date by the next course edit or the next opening
    of the editor (as §0.13).
27. **The winner pace is minutes per km of the course's length**
    (§0.17). The winner's time — pace × length — is shared over the
    legs by their costs under the model, which gives the pace on flat
    forest that the alternatives are timed at. The course's time is
    therefore pace × length by definition; metres and times are
    derived in the editor, not stored (§0.9's "stored per control
    pair" is the routes).

Decided in implementation of §7.9 (2026-11-22; told to the user, open
to change):

28. **The cost model is calibrated outside the server**, by a local
    command from neutral track records and the map file (§7.9). The
    repository holds no tracks, names no track provider, and keeps
    only a fitted model's numbers; the command's report is aggregates
    only. Selecting whose tracks count (the user's "top 10 %") is done
    before the command: it fits what it is given.
29. **Calibration is per terrain class**: a model can be partly
    measured, and the editor's note names the measured classes (this
    replaces §0.16's single "marked uncalibrated"). A class counts as
    measured from 2000 m of track, 10 runs and 30 legs holding 20 m or
    more of it **between 8 different control pairs** (a pair run both
    ways is one), when its 90 % interval — over runs and control pairs
    drawn again — is within ±15 % of the factor. A model holds measured
    numbers only: a factor that was fitted but did not settle is the
    rule of thumb's in the model, as the note says.
30. **Factors are relative to forest; without forest in the data, to
    the class with the most track**, which keeps its rule-of-thumb
    factor. Classes without enough track keep theirs.
31. **A model per map family**: sprint maps (ISSprOM) and forest maps
    each have their current model (`currentCostModel`), since a sprint
    is run differently from a forest race.
32. **The course's time stays pace × length after calibration**
    (§0.27): calibration changes how the time is shared over legs and
    alternatives. The paces fitted are those of one event's finishers
    and say nothing of another course's winner.
33. **A model is data** — class factors and the slope's four numbers
    of a fixed shape (`CostModelData`) — kept under an id; `default-1`
    stays. This narrows §0.21's seam from any function to that shape.
    Calibration does not change the automatic route or its basis
    (§7.5): the shortest legal route reads no factor.
34. **Slope is fitted against the contour field**, and only where the
    tracks climb and descend enough on it; otherwise the rule of
    thumb stays.
35. **What "measured" also needs, and what is never cut** (after two
    independent reviews of the tool, 2026-11-22): 8 different control
    pairs per class and intervals over runs and pairs (in §0.29); a
    fit that settled, with every interval's fits started off the fit
    (§7.9.4); no leg left out for being slow (§7.9.2); and at least
    five runs with a usable leg on each map, or no report (§7.9.6).

36. **Tracks are put on the way they follow** on forest maps (§7.9.3),
    after the first runs on real tracks (2026-11-22: 256 runs on two
    maps) put paths at the lowest allowed factor: within 10 m for 40 m.
    A fitted number whose interval touches a bound is not measured.

37. **Forest maps run under `forest-2026-1`** (§7.9.7): the three
    numbers the first calibration settled. Put to the user as a choice
    on 2026-11-22 (adopt the three; adopt them and the uphill number;
    wait); implemented as recommended, to be reverted if he chooses to
    wait.

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
nearest place on it to a point and how far off the point lies. The graph
marks its pointer's place on the map with the first (§5); the second is
for the map pointing back at the graph, which is pending.

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

The editor computes heights for **the selected course in Course mode's
Course view, when its order is `ordered` and the viewer draws it alone
and whole**:
the legs are the layer's `DerivedLeg.points` of that one course
(`useCourseChecks` `legs`, the derivation the length is read from,
`course-editor.md` §8). There is nothing to read in the all-controls and all-variations views,
in the Class and Variant views (their drawn path is not the inspector's
rows, by which a leg is found), for a free-order course, while a part of
the course is drawn (Layout mode on a part sheet) and for a course
without legs; the field is asked for only while a course of the first
kind is selected.

A course with variation groups (`course-editor.md` §12) is read along
**the path the Course view shows**: the alternatives picked in the
inspector. Its climb is that path's, and changes with the pick.

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

1. **A typed climb** — the course's stored climb when its source is
   `manual`, `file` or none (§6 "Read rule"): `85 m climb`, `data-m`,
   `data-source="manual"`. Nothing about
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
§4's state is `ready`. The profile follows a drag one render behind
(`useDeferredValue`). It is opened and closed by *Show / Hide elevation
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
  ticks (`niceStep`: 1, 2, 5 × 10ⁿ). Distance ticks in km, in metres on a
  course under 1 km.
- The controls (`editor-profile-control`, `data-index`, `data-d`): a
  dashed vertical mark where each leg starts and where the last ends,
  labelled along the top by what stands there (`routeMarks` over the
  inspector's positioned rows): `S` for a start, `F` for a finish (`M` in
  Swedish), a control's number on the course; labels closer than 16 px thin
  out, the first and last stay (`boundLabels`).
- The selected leg (§4.5) is shaded (`editor-profile-selected`,
  `data-leg`).

A long course is drawn with about two points per pixel column — the
column's lowest and highest, so peaks stay, and the ends of every run of
data (`decimate`).

**The pointer.** Over the graph it reads a place: a crosshair
(`editor-profile-crosshair`) with a dot on the line, and a readout
(`editor-profile-tooltip`: `data-d`, `data-z`, `data-leg`) — the height,
the distance along the course and the leg by its controls' codes
(*36 m · at 0.87 km · Leg 87 → 86*), or *No height data here*. The same
place is marked on the map by a dot (`editor-profile-map-dot` in the
viewer's marker layer, `data-x` / `data-y` paper mm, `data-leg`;
`pointAtDistance` over the leg's drawn line). The place is held in a
store the viewer's dot subscribes to (`lib/editor/hover-dot.ts`), so a
moving pointer redraws the dot and the readout, not the page. A
**click** selects the leg under the pointer, as a click on the leg on
the map does (the Leg section, the action bar's leg actions at that
place). The pointer leaving removes the readout and the dot.

## 6. The course's stored climb

Implementation: `packages/api/src/course-climb.ts` (the compute),
`course-geometry.ts` `rebuildCourseLengths` (the invalidation), the
writers in `routers/course.ts`; migration
`20261122010000_course_climb_source`.

`courses.climb_m` is the course's climb in metres — printed in the
description sheet's header, exported as IOF `Climb`, shown on the
Courses page and in the editor (§4.4). Who wrote it is
`courses.climb_source` (TEXT NULL, CHECK `manual` | `file` | `computed`):

| `climb_source` | Written by | Overwritten by a compute |
|---|---|---|
| `manual` | a climb above 0 typed on the Courses page (`course.create`, `course.update`, `course.bulkUpdate`) | never |
| `file` | `course.importCourses` when the file states a climb above 0 | never |
| `computed` | `refreshComputedClimbs` (below) | yes: cleared by every re-derivation of the course's geometry, written again after it |
| NULL | no climb (`climb_m` = 0) — or a climb written before this column or by an older image | only while `climb_m` is 0 |

**Read rule.** A climb is a typed one when `climb_m` ≠ 0 and its source
is not `computed` (`isTypedClimb`): nothing computed replaces it. That
covers source NULL with a climb (the migration backfills `manual` for
these; an older API image or a peer that knows no source writes them,
AGENTS §7). `manual` and `file` win alike; they are kept apart as
`length_source` keeps `file`. A row with `climb_m` 0 has **no climb**
whatever its source says, and the compute fills it. A `course.upserted`
applied from the journal carries no source, so the apply sets the
source to NULL with the climb it writes: an incoming climb is a typed
one here, an incoming 0 is none.

**The way back.** Clearing the Courses page's climb field (or typing 0)
writes `climb_m` 0 with source NULL, and the computed climb is stored in
its place when there is one. There is no stated "0 m": a flat course's
computed 0 is stored as no climb.

**The compute** (`refreshComputedClimbs(db, eventId, courseUuids?)`): for
every live **ordered** course of the event with no climb (`climb_m` 0,
source not `computed`), the
climb is `Math.round(courseProfile(legs, sampler).climbM)` (§2; whole
metres, the number the editor shows) over

- the legs' drawn polylines of the stored course layer
  (`editorCourseLayer` → `derivation.courses[0].legs[].points`: the
  polylines the stored length is measured on and the editor draws), and
- the field §3 picks from the event's terrain descriptor, **read as
  stored** (`readHeightfield`): a field that is `pending` or has no
  stored bytes gives no climb. The server never derives a field to
  compute a climb.

Nothing is stored when the profile is `partial` (§2: the total would be
a lower bound), has no length, or rounds to 0; low confidence alone
does not stop it (the editor's `≈` says so, §4.4). Free-order courses
are never computed. A variant has its own computed climb; a root's
typed climb reaches its variants as before (`syncVariants`), a computed
one does not, and a root whose typed climb is cleared takes the copies
back from its variants. A clone copies a typed climb with its source and
computes its own otherwise.

**When.** Every change of what a climb rests on resets a `computed`
climb to 0 / NULL **inside the edit's transaction**
(`clearComputedClimbs`), so a stored computed climb is never stale, and
marks the course:

- `rebuildCourseLengths` — every re-derivation of a course's stored
  geometry: create, update, sequence and leg edits, control moves, copy,
  a position-less import;
- `course.bulkUpdate` moving the courses' ends (`firstAsStart`,
  `lastAsFinish`);
- a map upload, a library map or a rotation change
  (`refreshDerivedCourses`): **every** course of the event, whatever its
  length source — the climb rested on the previous map's heights;
- `course.importCourses`: every course of the event (the import moves
  shared controls), so an imported course whose file states no climb
  gets a computed one and a re-imported course does not keep an old one.

A file that states a climb overwrites the course's climb with source
`file`, a typed one included; a file without one leaves a typed climb
alone. Oxygen's own IOF export writes the stored climb, so exporting a
course with a computed climb and importing that file back makes it a
`file` climb.

The marks are **the request's own** (`course-climb-pending.ts`: an
`AsyncLocalStorage` scope opened by `eventProcedure` around every
mutation), so no other request — an open editor's presence heartbeat,
a readout — can take them before the edit has committed, and a request
that marked nothing computes nothing. The compute runs **after the
transaction commits**, outside it (a field read never runs inside an
edit's transaction): a mutation that succeeded computes the courses it
marked, **one short transaction per course** that locks that course's
row only (an edit of several courses cannot deadlock with it), and
fails soft — an error is logged, the mutation's result stands and the
course has no climb until its next edit or `course.refreshClimbs`. A
mark made outside a request scope is dropped the same way. The computed
climb is journaled
(`course.upserted`, the course's concurrency token not advanced: an
editor's next write is not refused for it), so each geometry edit of
such a course journals it twice — cleared, then computed. `course.refreshClimbs`
runs the same compute for every such course of the event on demand; the
editor calls it once per course opened when it shows a computed climb
and the stored one is empty (heights that arrived after the last edit),
and again after a failure.

**Readers.** The description sheet, the course-map header and the IOF /
Purple Pen exports read `climb_m` as stored, whatever its source
(unlike a `derived` length, nothing is recomputed at export). Eventor's
sync never writes climb. `course.list` and `course.detail` state the source
(`climbSource`: `manual` | `file` | `computed` | null, a climb without
a stored source read as `manual`). The column is stripped from the
`course.upserted` payload, as `length_source` is (an older peer's apply
knows no such field); it travels with the checkout snapshot. A peer that
receives a computed climb through the journal therefore holds it as a
typed one until it is cleared there. That copy is not cleared by
the peer's geometry edits: after a checkout to another node, a climb
computed here stays as it was until someone clears it there (Pending).

**The Courses page** (`CoursesPage.tsx`, the course's detail): a *Climb
(m)* field (`course-detail-climb`, `data-source`) holding a typed climb,
empty with the computed climb as its placeholder otherwise, and a line
under the fields saying which it is (`course-detail-climb-hint`).
Emptying the field (or 0) writes `climb: null`.

**The editor** (§4.4) takes "typed" from the source: `manual`, `file`,
or NULL with a climb. A stored `computed` climb is shown only while the
field loads or cannot be read (rule 3 there); with the field read the
live value is shown, which is the stored one once the edit is saved.

## 7. Leg routes

A **route** is a polyline between two controls of an event, in the
direction it is run. `profileAlong` takes it as it takes the drawn line.

### 7.1 Model

Table `leg_routes` (migration `20261122020000_leg_routes`), one row per
route:

| Column | |
|---|---|
| `event_id`, `from_control_id`, `to_control_id` | the directed pair; both controls cascade |
| `points` | the route's **interior** vertices, paper mm (`[{ x, y }]`, 1 to 2000): the ends are the controls' centres and follow a moved control, as a leg's bends do |
| `source` | `drawn` (by hand) or `computed` (an alternative the search of §7.5 found and someone kept) |
| `model` | the cost model a computed route was found with; NULL for a drawn one |
| `auto_basis` | non-NULL: the pair's **automatic** route (§7.5) and a digest of what it was searched on; NULL: a person's route. A partial unique index allows one automatic row per pair. Its `points` may be empty: the drawn line is the shortest legal route |
| `chosen` | the route the pair's climb is read along; a partial unique index allows one per pair. Two writers choosing for one pair at once: the second gets `CONFLICT` and tries again |

A route belongs to the **pair, not to a course**: every course of the
event that runs `from` → `to` as a leg shares it (§0.9; the terrain
between two controls is the same for every course, and a course's
variants are copies that would otherwise each need their own). It is
directed: the pair run the other way has its own routes. A pair may
hold several routes; at most one is chosen.

Routes are not journaled. They are in the event's backup
(`BACKUP_TABLES`) and travel with the checkout snapshot
(`SNAPSHOT_TABLES`).

### 7.2 API

`legRoute.*` (`packages/api/src/routers/legRoute.ts`); controls by their
public id, a route by its UUID:

- `list` (`courses.view`): every route of the event between live
  controls, a pair's routes together, oldest first.
- `save` (`courses.edit`, lease-guarded): a new route for a pair, or new
  points for route `id` (a route keeps its pair). A new route is chosen
  unless `chosen: false`; choosing takes the choice from the pair's
  other routes.
- `choose { id, chosen }`: choose the route for its pair, or take the
  choice away — the pair is read along its drawn line again.
- `delete { id }`.

Every write that changes what a pair is read along (a chosen route
saved, chosen, unchosen or deleted) clears the computed climb of
**every live ordered course running the pair** in its transaction
(`clearComputedClimbs`, §6 "When") and they are computed again after
the commit. A write to a route that is not the chosen one changes no
climb.

### 7.3 What is read along a route

`routedLegs` (`packages/shared/src/course/leg-routes.ts`): a leg whose
pair has a chosen route is read along the route from the leg's first
point to its last; every other leg along its drawn line (§0.2). The
rule of §2 still runs once over the whole course (§0.6). This is the
polyline list of

- the stored computed climb (`computeMissingClimbs` through
  `climbLegsOf`, `packages/api/src/leg-routes.ts`), and
- the editor's climb, its selected leg's numbers, the profile graph
  and the graph's dot on the map (§4, §5).

Unchanged by a route: the course's **length** (§0.1; it stays the
drawn line's), the drawn and printed leg, the description sheet's
distances and every export — a route is never printed or exported
(§0.3). A leg with style `marked_route` ignores routes: its drawn line
is the route the runner must follow. The style is the leg's own: where
a control is run to twice, one leg to it can be marked and the other
read along its pair's route. A leg through a crossing point is
read along the chosen route as any other; the setter draws the route
through the crossing.

### 7.4 The editor

Course mode's Course view, an ordered course, a leg selected: the
inspector's *Leg* section shows a **Routes** block
(`editor-leg-routes`) under the leg's numbers, on a map with or
without heights.

- The list (`editor-leg-route`, `data-id`, `data-source`,
  `data-chosen`, `data-m`, `data-climb`): the **drawn line** first
  (`data-id="line"`), then the pair's routes. The automatic route
  (§7.5) is `data-source="auto"`, named *Shortest legal route
  (automatic)* and has no ✕; where it is the line itself it is not
  listed and the line says so. The list is asked again every 8 s
  while a course is open, so a route the server wrote appears, and
  the course's climb with it. Each states its metres
  on the ground and, when the field is read, its own climb
  (`profileAlong` over that polyline alone, `≈` as in §4.4). A radio
  (`editor-leg-route-choose`) chooses one; choosing the drawn line
  takes the choice from the routes. ✕ (`editor-leg-route-remove`)
  deletes a route.
- **Draw route** (`editor-leg-route-draw`) takes the map: every click
  adds a vertex from the first control towards the second
  (`editor-route-draft`, `editor-route-draft-rest`,
  `editor-route-draft-point`), nothing else is hit and the leg stays
  selected. **Save route** (`editor-leg-route-done`), Enter or a
  double click stores it as the pair's chosen route; **Cancel**,
  Escape or a right click gives it up; Backspace takes the last vertex
  back. The draft ends when the selection leaves the leg. The keys are
  the draft's only bare: with Ctrl, Cmd or Alt they are the browser's,
  and Enter on a focused button or link presses it. Nothing is saved
  while a route write is under way.
- The selected leg's stored routes are drawn on the map, screen only
  (`editor-route-line`, `data-chosen`): the chosen one solid, the
  others dashed.
- With a chosen route the leg's numbers (§4.5) are the route's: the
  first cell is labelled **Route** instead of **Length**
  (`editor-leg-elevation` `data-routed="true"`).
- Route writes are not on the undo stack. On a phone the block is
  read-only, as the section is.

A chosen route's own climb in the list can differ from the leg's share
of the course's climb (§4.5) by up to the threshold: the list reads the
route alone, the course in one pass.

### 7.5 The automatic route and computed alternatives

**The automatic route** (`packages/api/src/leg-routes-auto.ts`,
`leg-routes-auto-worker.ts`; §0.15, §0.23). Every directed pair that a
live ordered course runs as a leg — a marked-route leg aside (§7.3) —
has one automatic route: the **shortest way that crosses nothing
uncrossable** (`shortestLegRoute`: the `shortest` model of §7.7 on the
grid of §7.6, without heights). Where the straight line between the
controls is legal the line is that route and the row has no points;
without any way the row has none either.

- **When.** After a mutation whose geometry rebuild marked climbs
  (§6 "When") has committed and its climbs are written, after any
  `courseObject.*` write, and from `course.refreshClimbs` (the
  editor's catch-up): `enqueueAutoRoutes(event)`. One refresh per
  event runs at a time, in the background; an event asked for again
  meanwhile is refreshed once more after. The queue is in memory — a
  restart loses it and the next edit asks again.
- **What is searched.** The pair's **basis** is a digest of the
  document hash, the map patch's version, the map scale, the two
  controls' positions, the leg's crossing point, the out-of-bounds
  objects that apply (§0.25) and `AUTO_ROUTE_VERSION`. A pair whose
  stored basis is the current one is not searched. The others are
  searched in worker threads, 20 pairs to a worker (the document
  decoded, patched and classified once per worker), so no search holds
  the request or the event loop. Each worker's routes are written
  before the next starts; a worker that fails or runs past five
  minutes leaves its pairs for the next refresh and the others go on.
- **The row.** `source = 'computed'`, `model = 'shortest'`,
  `auto_basis` the basis. A new row is **chosen unless a person chose
  a route for the pair**; a refresh rewrites points and basis and
  never `chosen` (§0.24). A chosen row whose vertices changed clears
  the computed climb of the courses running the pair, and the climbs
  are computed again when the refresh ends, also when it ends in an
  error (§7.3). A new row without vertices, or a row searched again to
  the same vertices, clears nothing.
- **By hand.** `legRoute.list` marks the row `auto`. `legRoute.save`
  on it and `legRoute.delete` of it are `BAD_REQUEST`; `choose` works
  as for any route.
- `AUTO_LEG_ROUTES=off` in the environment turns the refresh off
  (`docs/ops/deploy-gcp-cloud-run.md`); the integration tests run with
  it off, except the file that tests it.
- **The editor's catch-up.** The course mode asks once per opening
  (`course.refreshClimbs`), so routes searched on a map or a map
  correction that changed since are searched again (§0.26).

Between an edit and the route's landing the climb is read along what
is stored: a moved control's automatic route keeps its vertices with
the ends moved, for the seconds the search takes.

**Alternatives.** A leg selected can be **searched** by hand: the
editor finds the fastest route between its two controls under a cost
model, up to two others that are nearly as fast and run somewhere
else, and the shortest legal route — each with metres, climb and an
estimated time (§0.9). An alternative can be kept as the pair's chosen
route (§7.1 `source = 'computed'`, `model` the cost model's id). The
search is `packages/shared/src/route/` (pure, no DOM); §7.6–7.8
describe it.

### 7.6 Cost classes and the grid

**Classes** (`cost-model.ts`). A map symbol is one of sixteen cost
classes by its code — the applied match's canonical code, else the
source code, as the checks read it (`course-layer.md` §9.3) — or says
nothing about running (contours, point symbols):

| Class | ISOM 2017-2 / ISSprOM 2019-2 codes |
|---|---|
| `forest` (also every unmapped cell) | 405 |
| `open` · `roughOpen` | 401, 402, 412, 413, 214 · 403, 404, 213 |
| `slow` · `walk` · `fight` | 406, 407, 414, 210 · 408, 409, 211 · 410, 212 |
| `marsh` · `water` | 308, 310 · 302 |
| `boulders` · `denseBoulders` | 208 · 209 |
| `paved` · `road` · `path` · `smallPath` | 501 · 502, 503 · 504, 505 · 506, 507, 508 |
| `blockedSoft` | 301, 307 (uncrossable water and marsh) |
| `blocked` | 201, 411, 515, 518, 520, 521, 529, 708, 709, and the course's `oob_area` / 708 `oob_line` objects |

The uncrossable set is the checks' `UNCROSSABLE_CODES` and `OOB_CODES`.

**Grid** (`grid.ts`, `leg.ts`). A leg is searched in a window of the
map: the box of its ends (and its crossing point) grown by half the
leg's length, at least 10 mm, in square cells of 0.25 mm of paper
(2.5 m at 1:10 000) — coarser when the window would hold more than
1.2 million cells. Each cell has one class and, with a height field,
the height at its centre (the field §3 picks, the one the climb is
read from):

1. **Areas** fill the cells whose centre is inside (even-odd over the
   object's rings, so a hole is left out; curves cut into chords). Where
   areas overlap, the cell takes the higher rank: forest < open <
   green < boulders, marsh, water < paved < uncrossable water <
   uncrossable.
2. **Thin outlines and banks.** Where an uncrossable area is thinner
   than 1.5 cells — a point that far in from its outline is outside
   it again — the outline marks the cells it touches too, so a wall
   drawn as an area narrower than a cell (which holds no cell centre),
   or a lake's thin arm, still closes the way. Where the area is wider
   it is its filled cells alone: the passage between two buildings
   stays as wide as it is drawn. Line objects of `blockedSoft` (a bank
   drawn as a 301 line) mark their cells as well.
3. **Ways** — line objects of the path classes — then mark every cell
   they touch, over anything but `blocked`: a path over uncrossable
   water and its banks is a bridge, a path into a building opens
   nothing.
4. **Uncrossable lines** of `blocked` mark every cell they touch
   `blocked`, after the ways: a fence closes a path.

A line is walked cell by cell without a diagonal step, and the search
moves diagonally only when both cells beside the step are passable, so
nothing slips through a barrier or past its corner.

Line objects of other classes mean nothing. Objects a map patch hides
and hidden symbols are skipped.

### 7.7 The search

**Cost** (`cost-model.ts`, `search.ts`). Costs are in **flat-forest
metres**: a metre of flat, runnable forest costs 1. A move between
neighbouring cells costs its ground length × the mean of the two
cells' class factors × the slope factor of the height difference in
the running direction. `CostModel { id, calibrated, classFactor,
slopeFactor, calibratedClasses?, slopeCalibrated? }` is the seam for calibration (§0.16): `default-1` is an
uncalibrated first guess —

| | factor |
|---|---|
| paved 0.62 · road 0.65 · path 0.72 · small path 0.85 | |
| open 0.8 · rough open 0.92 · forest 1 | |
| slow 1.3 · marsh 1.5 · boulders 1.7 · walk 1.8 · water 2.2 · dense boulders 2.6 · fight 3.2 | |
| slope up | 1 + 7.5 × grade (100 m of climb ≈ 750 m of flat) |
| slope down | 1 − 1.5 × grade to −10 %, then 0.85 + 3 × (grade − 10 %) |

— and `shortest` costs every passable cell its length, whatever its
class or slope.

**Alternatives** (`alternatives.ts` `findRoutes`). Dijkstra over the
eight neighbours gives the cost from the first control to every cell,
and a second, reversed field the cost from every cell to the second
control (each move costed in its running direction).

1. The **fastest** route is the path of least cost.
2. An **alternative** is the cheapest route through a cell that no
   route tried so far comes near; it is kept when it costs at most
   1.3 × the fastest and shares at most half of its length with the
   routes already kept. "Near" is a corridor of 6 % of the leg's
   straight length (at least 3 cells). Up to two are kept; 40 tries.
3. The **shortest legal** route is the least-cost path under
   `shortest`. When it runs where a kept route runs, that route is
   marked shortest too; else it is one more entry.
4. Each path is straightened: from each vertex the straight run to the
   farthest later vertex that costs no more than the path between
   them, so the grid's staircase does not lengthen a route. A route's
   metres are its polyline's; its cost is re-read along the polyline,
   with the height read between the cell centres, so a straight run
   down an even slope costs what the model says.
5. Straightening can lay two routes on one line (open terrain: every
   detour straightens to the leg). An alternative that shares more
   than half of its length with a route already kept is dropped after
   straightening too. The shortest route is dropped only when the
   route it runs along is as short, and that route is then marked
   shortest. The list is by cost after straightening: its first route
   is marked fastest, the one of least length shortest.

A control standing on an uncrossable cell is run to from the passable
cell nearest to the control itself (up to 12 cells away; a control
beside a fence, in the fence's cell, from its own side): the route is searched and
straightened from that cell, never across the obstacle, and the stub
between the control and the cell is added as it is, costed by its
length. A leg through a **crossing
point** is searched in two stretches through it, with the obstacle
opened within 1 mm of the point (`course-layer.md` §9.3); it gets the
fastest and the shortest, without other alternatives. No way at all
gives no route. The same input gives the same routes.

### 7.8 The editor

Under the Routes list (§7.4), on a desktop or tablet
(`editor-leg-alternatives`, `data-status` `idle` / `running` / `done` /
`error`):

- **Find routes** (`editor-leg-alternatives-find`) runs the search in
  a web worker (`lib/route/finder.ts`, `route-worker-entry.ts`; the
  worker keeps the document's classified features and the height
  field between searches). The course's out-of-bounds objects in view
  are obstacles. Without a height field the search runs without
  slopes. A result belongs to the leg as it stood — its ends, its
  crossing point, the document, the patch, the field, the
  out-of-bounds objects — and is dropped when any of them changes.
- The list (`editor-leg-alternative`, `data-kind` `fastest` /
  `shortest` / `fastestShortest` / `alternative`, `data-m`,
  `data-climb`, `data-time`): metres, the route's own climb as in
  §7.4, and the estimated time `~m:ss` = cost × pace. The alternatives
  are drawn on the map, dashed, the pointed-at one solid
  (`editor-route-alternative`), screen only.
- **Winner pace** (`editor-leg-alternatives-pace`, `m:ss` or decimal
  minutes per km, 2:00–30:00; §0.17, §0.27): the expected winner's
  pace over the course's length, stored with the course
  (`courses.winner_pace_s_per_km`, `course.update`
  `winnerPaceSPerKm`, with the course's version token; not journaled,
  as `climb_source`); 6:00 while none is typed. The worker costs every
  leg of the course along the polyline it is read along
  (`legPolylineCost`, the `costs` message); the pace on flat forest is
  pace × length ÷ the sum of those costs (`flatPaceSPerKm`), and an
  alternative's time is its cost at that pace. Until the costs are
  known the list shows no times.
- **The course along its routes** (`editor-course-route-totals`,
  `data-m`, `data-time`, `data-routed`): under the Routes list, the
  sum of the legs' metres along the routes they are read along and
  the winner's time, pace × length.
- **Use** (`editor-leg-alternative-use`) stores the alternative as the
  pair's chosen route (`legRoute.save`, `source: "computed"`, `model`
  the id of the model it was found under: `shortest` for the route
  that is only the shortest, else the id of the model the search ran
  under, §7.9.6 — `default-1` until a model is adopted). An
  alternative that is the straight line cannot be stored: the drawn
  line is that route.
- A note says the times are estimates from an uncalibrated model
  (`editor-leg-alternatives-note`); no route found says so
  (`editor-leg-alternatives-none`).
- A phone has no alternatives: its Leg section is read-only.

### 7.9 Calibration from GPS tracks

The cost model's numbers can be **measured**: fitted to GPS tracks of
finishers on maps whose files are at hand (§0.28). The fit is a local
command, `route:calibrate` (`packages/api/src/cli/calibrate-cost-model.ts`,
runbook `docs/dev/route-calibration.md`), over the pure modules of
`packages/shared/src/route/calibration/`. It needs no database and no
server and sends nothing anywhere.

#### 7.9.1 The track record

The command reads a map file (OCAD or Mapper, imported as the server
imports it, `map-import.md` §2) and **track records**, JSON
(`trackRecordSchema`):

- `courses[]`: `id` and `controls[]` in running order, each `code`,
  `type` (`start` | `control` | `finish`) and `lat`, `lng` (WGS 84);
- `tracks[]` (or `kept[]`): `courseId`, `raceStartMs`, `waypoints[]`
  of `timeMs`, `lat`, `lng`, and `result` with `status`, `timeMs` and
  `splitTimes[]` of `controlCode`, `timeMs`. `waypoints.timeMs` and
  `raceStartMs` are on one clock; `result.timeMs` and the split times
  are elapsed from the start. A track whose status is not `ok` is left
  out; a track without `result` counts as ok and is cut without punch
  times. A track naming a course the record lacks is left out with
  the warning `track-without-course`.
- `projectionEpsgCode` and `map.mapScale` are optional cross-checks: a
  difference from the map file is a warning in the report.

Any other key is dropped unread. A record says nothing of where it
came from, and nothing in the repository knows. Points go onto the
map's paper by the document's own georeference (`wgs84ToPaper`,
`map-gps-tracks.md` §3.2); a map without a CRS proj4 knows cannot take
tracks (`not-georeferenced`).

#### 7.9.2 Legs

A track is cut where it passes its course's controls (`splitTrack`):

- **The pass** of a control is the track's nearest approach to it — a
  point on a segment between two fixes, with its interpolated time —
  within 20 s of the punch (the start, a split time, the finish), after
  one clock offset per track: the median, over the controls, of pass
  time minus punch time, each looked for within 60 s of the punch (a
  watch further off loses its legs as `control-missed`). Without punch times the passes are found in
  course order, each after the one before. A pass further than 15 m
  (ground) from its control is no pass, and the two legs it bounds are
  left out.
- **The leg's time** is the track's own time between two passes, so
  distance and time come from one clock; the punch only picks the pass.
- **Cleaning**, in this order: a fix whose time does not increase is
  dropped; a fix that needs more than 9 m/s from both neighbours is
  dropped, and a leg that lost over 10 % of its fixes is left out; a
  leg with more than 20 s between two fixes, or a fix outside the
  map's bounds, is left out; **standing** (under 3 m of movement over
  10 s or more) is taken out of the leg's time, and a leg standing
  over a fifth of its time is left out. Positions are not smoothed.
  Two wild fixes in a row are dropped like one, when the fixes either
  side of them agree.
- **No leg is left out for being slow.** Slow ground and a mistake look
  alike in one leg's time, and a rule on time would cut off exactly the
  slow terrain the fit is to measure; the fit weighs down what its
  model cannot explain (§7.9.4) and counts it.
- **Where a runner waits** — on the start line, at the finish — the
  track is equally near the control for a while: among approaches
  within 3 m of the nearest, the pass is the one closest to the punch.

Each reason's count is in the report.

#### 7.9.3 Attribution

A kept leg is read on **the finder's grid** (§7.6): `legGridCovering`,
the leg's own cell size with the bounds grown to hold every track of
that control pair — over all of the map's records, so classes sharing a
pair share its grid and it counts as one pair. A leg with a fix beyond
the leg's window (§7.6) grown once more by its pad is left out as
**wandered**: it is not a route of that leg, and the grid stays
bounded. The track
is walked as the cost is (§7.7): half-cell steps, each step's metres
halved between the classes of its two ends, the grade from the heights
at its ends (`attributeLeg`). Per class the leg keeps its metres and
three slope terms — metres × grade uphill, downhill to the knee, and
beyond the knee — so that, weighted by a model's numbers, they are that
polyline's cost under the model (the same walk as `routeCost`; the
finder's own search differs where it refuses a diagonal squeezed
between two uncrossable cells, which a track may take). Heights are the contour field
of the map file (§3; §0.34); a step without a height is flat.

**On the way it follows.** A watch puts a runner some metres beside
where they ran (the median pass is about 4 m from its control), and a
path is a cell wide: read where it lies, most path running is forest
and the few metres that land on the path carry all its speed — the
first runs on real tracks put paths at the lower bound. So on a forest
map a stretch of track that stays within **10 m** of a road or path
(paved, road, path, small path) for **40 m or more** is that way's,
each sample taking the nearest way's class (`attributeLeg`'s `snapM`,
`snapMinRunM`; §0.36). A crossing is too short to count. On a sprint
map (ISSprOM), where the ways are areas, nothing is snapped. A route's
cost is read without snapping, so the equality above holds for routes.

A step in an uncrossable cell takes the class of the nearest passable
cell and is counted; a leg with over a quarter of its metres there is
left out (a georeference that is off, or a bridge or stairs the grid
does not hold).

#### 7.9.4 The fit

The model: **a leg's time = the runner's pace × Σ metres × class
factor × slope factor** (§7.7). The error fitted is in **log time**,
log(actual) − log(predicted): a leg run 20 % slow and one run 20 % fast
pull alike, and the noisy time is on one side only, so noise does not
pull the factors down. `fitCostModel` solves, a Gauss–Newton step a
round until nothing moves by 10⁻⁴ (at most 50 rounds):

- the **class factors** of the classes with enough track (§0.29) and
  the slope's **up**, **down** and **steep down** together — each
  slope number only when there is an anchor and the tracks hold 1000 m
  steeper than 5 % that way (500 m beyond the knee for steep down);
  the knee stays 10 %. An unknown's regressor is the derivative of the
  leg's log cost by it;
- each run's **pace** is an intercept of its own in log time and is
  taken out inside the step: every leg's row less its run's weighted
  mean. Pace and factors are not fitted in turn — where one class is
  most of every leg the two are nearly one thing and turns crawl;
- **Huber weights** (1.345 × the scaled median deviation) from each
  leg's distance to its run's median, so a blown leg weighs little.

One class is the **anchor** and keeps its factor (§0.30). Factors stay
within 0.4–6, the slope's numbers within 0 and their tops (up 25, down
0.6 ÷ the knee, steep down 15); one at a bound is held there and the
others solved again. Steps are full for eight rounds and halved after
(a full step between bounds can go round in circles). An unknown whose
regressor is the same on every leg of each run that has it cannot be
told from those runs' pace: it is **loose**, stays where it is, and is
not measured. Two unknowns the data cannot tell apart stay near where
they stand (a pull of 10⁻⁶ of the diagonal). A class without
enough track keeps the base model's factor throughout. Each fitted
number gets a **90 % interval** (a class's is reported; the slope's
only decide whether it is measured) from 200 fits on **runs and
control pairs** both drawn again with replacement (pairs that disagree
about a class show it as runners that disagree do). Each of the 200
starts a random way off the fit — every unknown times e^±0.3 — and runs
to the same criterion: what the data pins down comes back to one
value, what it cannot tell (maps sharing no class or runner, an ascent
and a descent that always come together) stays spread and fails the
interval. The generator is seeded: the same input gives the same
output. A class is **measured** when its interval is within
±15 % of its factor and neither the factor nor its interval is at a
bound; the anchor is
measured when another class is; the slope when up, down and (where
fitted) steep down are each within ±30 % and none is at a bound or
loose. A fit that has not settled within its rounds, or more than a
twentieth of whose 200 have not, says so (`converged` false) and
measures nothing; a system that cannot be solved counts as not
settled. A 90 % interval is what it says: with pair-to-pair
differences in the data, about one measured factor in ten lies outside
its interval. Legs the fitted model misses by more than a factor
of two are counted (`outliers`).

#### 7.9.5 Validation

- **Along the track.** Control pairs are held out a fifth at a time
  (by sorted order, a pair run both ways as one, so no ground is on
  both sides and nothing is random),
  the model fitted on the rest, and each held-out leg's time predicted
  from its runner's pace on that runner's other legs. Each fold is
  scored as the emitted model would be (§7.9.6): its fitted numbers
  for what the full fit measured, the base model's for the rest.
  Reported: the
  median and 90th percentile of the absolute relative error and its
  bias, for the fitted model and for the base model.
- **Against the finder.** Per control pair (at most 400 a map, evenly
  picked) the fastest route under the
  fitted model (§7.7); reported is each leg's actual time over that
  route's time at the runner's pace — its median and the share under
  0.95 (runners who found something faster than the finder did). The
  finder's route is the cheapest under the model, so the ratio is at
  least about 1 by construction: it cannot show a model to be right,
  only that the grid lacks a way runners took (well under 1) or that
  runners do not take the routes the model calls fastest (well over).

#### 7.9.6 The report and the model

The command writes one JSON report (`calibrationReportSchema`, strict)
and prints the same summary. It holds **aggregates only**: the model's
numbers; per class the metres (to 10 m), seconds, runs, legs and
control pairs it rests on, the factor, the base factor, the interval and why a factor
was kept; metres per grade bin; the validation; counts of maps,
courses, tracks, legs kept, legs the model misses by a factor of two
and legs left out per reason (a fixed list of reasons); per map — by
its position on the command line — the median distance between a
control and its pass and the share of metres on uncrossable cells; the
slope numbers the fit found with their intervals, measured or not. No
coordinate, no time of day, no id, no name, no file name; a map's
warnings and the reasons are fixed words. It says whether the fit
settled (`converged`). Under five runs with a usable leg on any one
map no report is written, and that map's line is not printed. The
model's `id` is the `--id` given: it should not name an event or a
club. The command prints each
line as it is known and names maps and records by their position only:
an unreadable file is "map 1: unreadable" or "map 1, record 3:
unreadable", never its path or its parser's message; a record of the
wrong shape is named with the schema key and the kind of fault, never
a value. In a `--tracks` directory other JSON files are passed over and
counted; a file named itself must be a record. A map file in which no
terrain is recognised, and a run whose track all lies on one class
(a course-setting file without its base map), are said so.

A model is **data** (`CostModelData`, §0.33): an id, the class factors,
the slope's four numbers, the measured classes, the anchor. It holds
measured numbers only (`modelDataOf`, §0.29): a class that is not
measured has the base model's factor, and the slope is the base
model's unless it is measured; what the fit found for the rest is in
the report's `classes[].factor`. The
repository keeps its models in `COST_MODELS`; `currentCostModel(header)`
picks the map family's (§0.31), and the editor's search and leg costs
run under it. A fitted model is adopted by adding the report's `model`
under a new id and naming it in `CURRENT_COST_MODEL_IDS`; `default-1`
stays, so a kept route's `model` keeps its meaning. The adopted models
are in §7.9.7.

The editor's note under the alternatives says how much is measured
(`data-calibrated` = `none` | `partial` | `full`): the rule-of-thumb
text; or that speeds on the named terrain are measured from GPS tracks
of top finishers and the rest is rule of thumb; or that all of it is.

#### 7.9.7 Adopted models

| id | maps | measured | from |
|---|---|---|---|
| `default-1` | sprint (ISSprOM) | nothing | rule of thumb |
| `forest-2026-1` | every other map | path 0.556 (0.53–0.62), small path 0.802 (0.76–0.84), marsh 1.073 (0.89–1.22), against forest 1 | 256 runs, 2565 legs of the best tenth of each class at four events on two forest maps, 2026-11-22 |

`forest-2026-1` differs from `default-1` in those three factors only.
What the same fit found and did not settle, and so is not in the model:
uphill about 3.7 (2.9–4.4) against the rule of thumb's 7.5, downhill no
gain (at its bound), open 0.86, rough open 0.95, slow 1.25, road 0.62,
each with a range over ±15 %. The best quarter of each class gave the
same three numbers within 0.02; leaving the night event out moved path
and small path by under 0.02 and left marsh just unsettled. On
held-out legs the model's median error equals the rule of thumb's
(9.2 % against 9.1 %) and its 90th percentile is lower (25.8 % against
27.8 %): what it changes is how routes rank against each other on
paths and marsh, not a leg's time in forest. One sprint (49 runs)
settled nothing: fixes every 5 s cut through buildings at 1:4000
(11.5 % of the metres on uncrossable cells) and there was little
forest to measure against.

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
| `packages/api/src/__tests__/course-climb.test.ts` | §6: a stated climb's source, the read rule, the field's row source, the climb to store (partial, flat, no legs) |
| `packages/api/src/__tests__/integration/course-climb.test.ts` | §6: computed after a create commits, cleared and recomputed by a move, the journal payload and token, both journal entries of an edit, typed wins and clears back, a climb without a source, a typed source over an empty climb, clone, free order, bulk end moves and bulk climb, `refreshClimbs`, marks not taken by another request while the edit is open, a climb applied from the journal, a field not stored, the column's constraint |
| `packages/api/src/__tests__/course-climb-pending.test.ts` | §6: marks are per request scope, concurrent scopes apart, `all`, a mark outside a scope dropped |
| `e2e/courses.spec.ts` "climb" | §6 "The Courses page": typing and clearing a climb, a computed climb as the placeholder with its hint |
| `packages/web/src/lib/editor/__tests__/sequence.test.ts` "an insert position names its drawn leg's index" | §4.5, §5: the selected leg's index, the route's marks, a repeated control |
| `packages/web/src/lib/editor/__tests__/hover-dot.test.ts` | §5: the pointer's store |
| `packages/shared/src/course/__tests__/leg-routes.test.ts` | §7.1, §7.3: a leg along its chosen route between its own ends, direction, a pair run twice, a marked route, the polyline's length, the stored points' bounds |
| `packages/api/src/__tests__/integration/leg-routes.test.ts` | §7.2, §7.3: a saved route chosen and every course of the pair read along it, the length unchanged, direction, choose and unchoose, one chosen route per pair (and the index), new points, a typed climb and a marked route untouched, a control run to twice with one marked leg, a moved control, refusals, another event, a removed control, delete, the backup, the checkout snapshot |
| `packages/web/src/lib/editor/__tests__/leg-routes.test.ts` | §7.4: the chosen routes by leg key, a pair's routes, a route's metres and climb, the list with the drawn line, the automatic route and the line as that route, the map's shapes, a draft's shapes |
| `e2e/course-editor-routes.spec.ts` | §7.4 in the browser: a route drawn and saved, its numbers, the leg and the course read along it, the drawn line chosen back, removal; a draft's keys (Backspace, Enter, Escape). §7.5: the automatic route round an out-of-bounds area, chosen and not removable, unchosen once a person uses another. §7.8: alternatives round the area, their times, the winner pace saved with the course, the course along its routes, **Use** |
| `packages/shared/src/route/__tests__/route.test.ts` | §7.6: codes to classes, the default model, slope; the grid's fill, holes, ranks, bridge, barrier, heights, `openDisc`, `nearestPassable`. §7.7: the cost field (distance, a gap, enclosed, slope and the reversed field); alternatives (straight, straightened, round a lake on both sides, a path against thick forest, a hill, the bounds, no way, a crossing point, a control on an obstacle, determinism); at the search's cell size: one route in open terrain, a control on a building or a cliff with a wall between, an uncrossable area thinner than a cell, a passage between two buildings, the marks after straightening, a control beside a fence, the cost of a run downhill, a bridge over drawn banks |
| `packages/shared/src/route/__tests__/leg.test.ts` | §7.6: a document's features by match or source code, a patch-hidden object, the course's out-of-bounds area, a leg's window and cell size. §7.5: the shortest legal route (the line, round a lake, no way). §7.8: a leg's cost along a polyline |
| `packages/api/src/__tests__/integration/leg-routes-auto.test.ts` | §7.5: the worker's search, a course's pairs after its edit (chosen, shortest, the line as a row without points, the climb), nothing searched while the basis holds, the basis, a moved control, not edited or deleted by hand, a person's choice over a refresh, an out-of-bounds area, a marked-route leg, a free-order course. §7.8: the winner pace stored, listed, cleared, its bounds; an object drawn with named courses (§0.25), a leg through its crossing point, two edits in a row, a search that fails (the other pairs written, the climbs computed, the pair left for the next refresh), a route saved by hand while the search runs |
| `packages/shared/src/route/calibration/__tests__/calibration.test.ts` | §7.9 on made-up terrain and runners (`world.ts`): the record (shape, `kept`, paper positions, warnings, no CRS); legs (2, 5 and 10 s fixes, a clock offset, no punch times, a control passed twice, each reason a leg is left out, a stop taken out, one and two wild fixes, a slow leg kept, a track from before the start to after the finish, a near miss); attribution (equal to the route's cost, the covering grid, a track beside a path, across one and leaving one, uncrossable metres); the fit (the linear solve, factors recovered across paces and under ±20 % leg noise, a class three times slower, blown legs, a class that is most of every leg (settling, its interval, a fit cut short), control pairs that disagree, a class on one control pair, a wandered track, records sharing pairs, too little track, an anchor without forest, the slope, determinism); held-out legs, the finder check, a model of measured numbers only, the model as data, the report's strictness and that no input number is in it |
| `packages/api/src/__tests__/calibrate-cost-model.test.ts` | §7.9: the command's arguments; a run on `e2e/test.ocd` with made-up runners from a directory of records, its report and its lines as they come; a file that is no map, a record that does not parse, a missing map or record and a record that is not JSON named by position only; under five runs on a map no report |
| `packages/web/src/lib/route/__tests__/finder.test.ts` | §7.8: the worker's state (a search needs its document), the document sent once and again when it changes, a message the worker cannot take, the legs' costs, dispose; §7.9: the model a search ran under |
| `packages/web/src/lib/editor/__tests__/leg-alternatives.test.ts` | §7.8: the pace as typed, the clock, the pace on flat forest, the course along its routes, the list's kinds and times, the map's shapes, out-of-bounds objects as obstacles |
| `packages/web/src/lib/editor/__tests__/profile-graph.test.ts` | §5: points and bounds, the leg at a distance, ticks, an axis that ends on ticks, the scale and its minimum span, the paths and their breaks, decimation, the height at a distance, label thinning, the kept preference |
| `e2e/course-editor-profile.spec.ts` | §5 in the browser: the toggle, the panel under the map and above the rail's end, the controls, the summary, the kept preference, ✕; the pointer's readout, the dot on the map, a click selecting the leg |

## Pending in this chapter

- §7.5: a map correction alone does not refresh the automatic routes
  until the next course edit or opening of the course mode (§0.26); the
  refreshes of several events are not capped together, and a refresh
  cut off by a restart between its clear and its compute leaves those
  climbs empty until the next edit or opening; an out-of-bounds object scoped by class is not an obstacle
  for them (§0.25); the refresh queue does not survive a restart; the
  editor learns of a landed route by asking again, not by a push. A
  pair no course runs any more keeps its automatic row until a
  control of it is removed.
- §7.8: the winner pace is the root course's; a variant or a copy of a
  course does not get it. Per-leg and per-course times are not stored or exported; the
  course's time is pace × length by definition (§0.32).
- §7.6: bridges, underpasses, stairs and multi-level sprint areas are
  not modelled; passable cliffs, fences and walls cost nothing to
  cross; a symbol without a recognised code is unmapped forest; a
  passage narrower than a cell between two barriers is closed.
- §7.7: sprint maps run under the rule of thumb (`default-1`): the one
  sprint calibrated settled nothing (§7.9.7). Forest maps' slope, open
  ground, slow and walk vegetation, roads, boulders and water are rule
  of thumb too.
- §7.9: a class with too little track is held at the rule of thumb
  during the fit, which leans on the classes sharing its legs; on a
  short sprint leg (under 80 m at 1:4000) a legal way round a long
  fence can pass the `wandered` bound and is left out though it is a
  route of the leg; two visits of one control closer in time than the
  clock offset's error can be cut at the wrong one; without punch times a control the track passes before it is
  due (a course crossing itself) is cut at the first pass after the
  control before it, which can be the wrong one; a mistake is not told
  from slow ground in one leg, only weighed down across many; tracks
  are put on a way only by nearness (§7.9.3): running in the forest
  10 m beside a path for 40 m reads as the path, a chord between two
  fixes still cuts corners, and on a sprint map (no snapping) a track
  a few metres off reads the lawn or the building beside the street;
  slope
  rests on the contour field only, not a ground model; the finder
  check does not say how far a runner's line was from the finder's
  routes, nor whether runners' choice between two routes follows the
  model's order; a route kept under an older model is not marked; the
  note does not say how much of one route is unmeasured terrain; the
  note's partly and fully measured texts have no test until a model is
  adopted; the thresholds of §0.29 are not settings of the command.
- §6: a climb is not recomputed when heights arrive later (a contour
  field derived, a DEM job done), on a Height data settings change or a
  `TERRAIN_VERSION` bump — until the course's next edit or its next
  opening in the editor. The printed and exported climb does not say
  that it rests on contours.
- §6: the climb's source does not travel in the journal, so a node that
  received a computed climb from a peer treats it as typed and does not
  recompute it on its own edits. Sending the source needs every peer to
  know the column first (AGENTS §7).
- §7: routes are not journaled, so a route drawn on a node that holds
  the event's lease does not come back with the journal; route writes
  have no concurrency token (the last write wins) and no undo; the
  profile graph does not mark which legs are read along a route; a
  control's hard delete takes its routes, a soft delete hides them.
- §4.1: the Class and Variant views state no climb and show no profile;
  a forked course's climb is the shown path's, not each variant's.
- §5: the map does not point back at the graph (hovering a leg on the map
  marks nothing on the profile); stretches of low confidence are not
  drawn apart; there is no table view of the profile and no keyboard
  reading of it; the phone has no profile.
- §4.4: a typed climb is cleared back to the computed one on the Courses
  page (§6), not in the editor.
- §2: the threshold was chosen on synthetic noise over the contour field;
  a comparison of `ground.lantmateriet-2m` against the contour field on
  real courses is not made (the ground field is in no test database).
- §2: a height step across a stretch without data counts as any other
  (the only case where a gap adds climb), and on the plain contour field
  a step between floating components counts too (§3); neither is
  removed, both lower the coverage or confidence share shown.
- §3: sprint maps — bridges, stairs and multi-level areas are in no
  height model; the number is shown as on any map.
