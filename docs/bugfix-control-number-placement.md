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
