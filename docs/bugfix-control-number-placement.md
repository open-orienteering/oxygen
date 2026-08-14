# Bugfix: ambiguous control-number placement in congested clusters

## What happened

On the course map, control numbers could end up closer to a *neighbouring*
control's circle than that circle's own number. Reported on
Ungdomsserien regionfinal SO, course H16: controls 82 and 84 sit ~11 map-mm
apart (≈110 m on the ground at 1:10,000) with control 102 close by and four
H16 legs (90→84, 84→91, 83→82, 82→63) fanning out of the pair. Both "82" and
"84" were drawn in the gap north-east of circle 82 — the map read as if the
left circle were 84.

## Why

Label placement was inline, untested code in `MapViewer.tsx` with three
structural problems:

1. **No ambiguity term.** The cost function penalized being *near* another
   circle (step thresholds at 2× and 3× radius from the circle center) but
   had no notion of a label belonging to its own circle. A candidate slot
   pointing straight at a neighbour was fine as long as it cleared the 3r
   ring — and in a congested cluster it was often the cheapest slot left,
   because every other slot was near a leg line.
2. **Step-function costs.** All penalties were flat constants (+100/+20/
   +50/+30), so in clusters many candidates tied and the outcome was decided
   by the tiny ±1/±2 direction biases.
3. **Phantom obstacles.** Line avoidance used center-to-center legs of
   *every* course in the event — including the 12 courses not drawn on
   screen — pushing labels around for no visible reason.

## Fix

Placement now lives in a pure, unit-tested module:
`packages/web/src/lib/control-label-placement.ts`
(`placeControlLabels(circles, lines, opts)`), mirroring the existing
`course-leg-labels.ts` pattern. Changes to the algorithm:

- **Ownership/ambiguity cost**: a candidate closer to a foreign circle than
  to its own is hard-rejected (+300 and up); approaching parity is graded
  quadratically from a 0.6 distance ratio. This is the term that fixes the
  82/84 cluster.
- **Graded costs everywhere**: foreign-circle proximity (judged against the
  label box diagonal, and against each circle's real radius — finish outer
  ring, start triangle), already-placed-label overlap (with a small margin),
  and line proximity all fall off continuously instead of stepping.
- **Only what is on screen counts**: obstacles are the *visible* circles,
  and line avoidance uses exactly the drawn segments — precise OCD geometry
  polylines (legs, marked routes, forbidden routes) plus fallback
  straight-line legs of highlighted courses. Courses not rendered no longer
  influence placement. If the visible set changes, labels may move — that
  is intended.
- **Zoom-stable**: every cost term is a ratio of the input dimensions, so
  placement is invariant under uniform scaling. Since `MapViewer` scales
  symbol sizes and pixel distances by the same zoom factor, the chosen slot
  per control does not change while zooming or panning (verified by a
  scale-invariance unit test).
- **Deterministic**: circles are sorted numerically by id inside the module
  and exact ties break on a fixed slot order, so results are independent of
  input order and stable across renders.

`MapViewer.tsx` now collects `drawnLineSegs` while rendering course lines,
builds the placement input from visible controls (labels only for regular
controls; start/finish are obstacles with their true extents), and renders
the returned positions. ~50 lines of inline cost logic were deleted.

## Tests

`packages/web/src/lib/__tests__/control-label-placement.test.ts` — the
regression suite uses the real 82/84/102/64 geometry from the reported
event and asserts, among others:

- every label is strictly closest to its own circle,
- "84" is farther from circle 82 than "82" is (the literal reported symptom),
- no label overlaps another label or a foreign circle,
- placement is scale-invariant and input-order-independent,
- per-circle radius overrides (finish double ring) are respected.

## Follow-up: coherent distances and hard collision constraints

A second report (the ordinal-1 controls of the same event) showed three
residual problems: "95" drawn on top of circle 73, the "87" and "108"
numbers colliding, and "106" placed needlessly far from its circle while
its neighbours hugged theirs.

### Distance model

The 12 hand-tuned per-axis offsets are gone. Candidates now lie on
**rings**: 16 evenly spaced directions, and along each direction the box
center distance is solved exactly (per closest-feature region of the
box — x-edge, y-edge or corner) so that the label box's closest point
sits at a fixed clearance from the circle edge:

```
clearance = gap + k · (labelSize / 2),  gap = 0.2 · labelSize,  k = 0..4
```

Every number on the map therefore sits at the *same visual distance*
from its circle — regardless of direction and digit count — unless its
inner rings are physically full. That is the coherence rule: everything
is as close as geometry allows, uniformly.

### Hard constraints

Circle and label collisions are no longer soft costs:

- a candidate whose box intersects any circle (closest-point-on-rect vs
  circle test, using each circle's real radius) is rejected outright;
- so is a candidate whose box intersects an already-placed label box.

Rings are tried inner-to-outer; the first ring with a surviving
candidate wins, and survivors are ranked by the existing graded soft
costs (ambiguity/ownership, circle crowding, label crowding, line
proximity, direction preference). If **every** ring is exhausted the
least-penalized candidate overall is used — a number is never dropped.

### Placement order

Labels are placed greedily, **most-crowded circle first** (neighbour
count within `2·radius + 2·labelSize`, ties broken by id). Enclosed
controls get first pick of the scarce collision-free pockets; roomy
controls always have another free direction. The order depends only on
geometry, so results remain independent of input order.

### Claim radii and the 95 case

Each labeled circle has a **claim radius** — the smallest center distance
its own label can ever have (innermost ring, narrowest box axis):

```
claim = radius + gap + min(labelWidth, labelHeight) / 2
```

A foreign label sitting inside a circle's claim radius is *guaranteed*
to misread — no placement of the rightful number can reclaim nearest
status. Candidates that intrude are heavily penalized, but as a **soft
cost**, not a hard rejection: brute-force analysis of the reported
cluster showed why. Control 95 is enclosed by six circles within
7.5 map-mm, and:

- its closest collision-free slot (6.2 mm out) sits 4.68 mm from circle
  73 — inside 73's 5.30 mm claim, i.e. it would read as 73's number
  (the original bug shape);
- its closest *non-intruding* slot is 9.16 mm out and tangent to
  circle 73 to the hundredth of a millimetre — unreachable by any sane
  discrete search;
- the chosen pocket at 9.5 mm is within 4 % of that theoretical
  optimum, at the cost of grazing circle 88's claim by 0.2 mm.

Treating intrusion as a hard constraint exiled 95's label past 11.5 mm
and knocked 61 and 71 off their preferred slots — strictly worse. The
soft cost keeps close slots viable while steering any cluster that
*does* have a non-intruding same-ring alternative toward it. Unit tests
pin both properties: no label except 95 intrudes on any claim radius,
and 95 stays close (under 10 mm) instead of being exiled. Since 95 is
contested wherever it goes, it also carries a leader line — see below.

### Leader lines for contested labels

When the chosen slot is contested — some foreign circle ends up closer
to the number than its own circle, which is provably unavoidable in
packs where circles overlap — the placement module emits a **leader
line**: a thin tick from the digits to the edge of the label's own
circle (`PlacedControlLabel.leader`, drawn by `MapViewer` in the
overprint colour at 0.7× the circle stroke). Leader lines are not
standard orienteering overprint, but the all-controls view is an
organizer's working view with far more clutter than any competition
map, and the tick resolves what proximity cannot. On ordinary maps no
label is contested and no line is drawn.

With ambiguity thus resolved by the line, contested labels no longer
need to stand off at a distance: the direction grid was doubled to 32
(half-steps of 11.25°) so tight clusters can thread needles the
16-direction grid missed. Control 95 now sits on the innermost ring
6.2 mm from its circle (the position a human picked when hand-testing
in devtools) with a leader line, instead of 9.5 mm away in a pocket.

### Outcome on the reported cluster

With the real ordinal-1 geometry (where the circle pairs 87/88, 87/108,
62/70 and 70/106 physically overlap): all ten labels sit on the
innermost ring at the exact uniform gap, no box touches a circle or
another box, and every label is nearest to its own circle — except 95,
which is enclosed by six circles within 7.5 map-mm (its Voronoi cell is
smaller than the minimum label clearance, so no unambiguous spot exists
at all) and instead sits tight to its circle with a leader line. The
regression tests in `control-label-placement.test.ts` encode exactly
these properties.
