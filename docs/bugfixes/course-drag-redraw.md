# Bugfix: a dragged control redrew once a second or worse

**Seen** 2026-11-08 by the user on `vector-map-pipeline` after F13 (Bézier
bends), F16 (bend handles) and F18 (smooth bends by default): "If I move a
control, the circle is only redrawn once a second or worse." The editor
stayed responsive otherwise; the purple layer lagged further behind the
pointer the longer the drag lasted.

## Cause

Two things, which multiplied.

1. **The derivation got about six times dearer.** F13 flattens a curved
   leg at 5 µm, so a 25-control course with one smooth bend per leg went
   from 52 leg points to about 1100, and `deriveCourse` from 69 ms to
   about 400 ms (Node, the F20 bench). Flattening itself is 0.1 ms; 376 ms
   of the 400 were `placeControlLabels`, which tested each of a circle's
   160 candidate boxes (32 directions × 5 rings) against **every** drawn
   leg segment, for the hard line test and again for the soft line cost:
   O(labels × candidates × segments).
2. **Every pointer move was a worker request, and the worker ran all of
   them.** `MapGlEngine.setCourse` posted each input with a new
   generation; the worker answers `course` requests in order, each to
   completion, and the engine dropped every reply but the latest. A drag
   at 60 pointer moves a second queued about 24 s of worker time per
   second of drag, and the circle moved only when the worker reached the
   newest request.

The 5 µm tolerance was not the lever (a coarser one saves nothing worth
the shape), and stays.

## Fix (F20)

- **One course request in flight, latest wins**
  (`packages/web/src/map-gl/engine.ts`, `docs/map-rendering.md` §5.2
  "Engine"). While a request is in flight, `setCourse` only records the
  input; when the reply is in it is drawn (its generation is still the
  latest posted) and the last input made meanwhile, `null` included, is
  posted. Inputs in between are never sent. So the circle redraws at the
  rate the worker derives instead of falling ever further behind. The
  request made before `load` is still posted right after the load
  message, a `load` re-sends the input at once (the reply to a request
  before it answers the old document and is dropped as stale), and a
  worker `error` ends the request in flight so a waiting input is never
  stuck behind a reply that will not come. For that the worker now
  answers a course request whose derivation throws with `error`
  (`worker.ts`); before, a real worker's `onerror` reached the engine
  without effect and the inline transport (`?worker=0`, tests) delivered
  nothing.
- **The number placer tests only the segments within reach**
  (`packages/shared/src/course-maps/control-label-placement.ts`,
  `docs/course-layer.md` §3.5). Every candidate box of a circle lies
  within `radius + gap + 2·labelSize` (the outermost ring) plus the box
  diagonal of its centre; the hard test pads the box by `0.1·labelSize`
  and the soft cost reaches `0.5·labelSize` beyond it. Each circle filters
  the segments whose distance to its centre is within that reach, in the
  original order, so every test and every sum sees the same segments in
  the same order: the result is bit-identical (a segment with a NaN
  coordinate is kept, for the tests to judge as before), and the placer costs
  30–105 ms instead of 376–1490 ms on the bench's courses.

On the test fixture (25 controls, one smooth bend per leg, 3000 point
features, ~860 segments after the cuts) the placer went from 354 ms to
about 40 ms and `deriveCourse` from 378 ms to about 70 ms on the
development machine.

## Corridor courses (F20b)

After F20 a control drag on a corridor course still cost about 230 ms
per request on the corridor variant of the fixture (`dragCourse({
corridor })`: a 50 m edged corridor with a 5 mm band on every leg, F19's
mouths and openings, 3000 cut features): `corridorGeometry` about 140 ms
and `polylineLegGaps` 22 ms. F20b took only levers whose result is bit
for bit the old one (the user's rule), proven by reference fixtures
recorded before the change:

- **`polylineLegGaps` tests only the features within reach**
  (`packages/shared/src/course/cuts.ts`, `docs/course-layer.md` §3.4): a
  feature outside the leg's — or a segment's — bounds grown by twice its
  clearance can open nothing, and the rest keep their order. 22 → 1.6 ms.
- **`openingsOf` and `edgesOf`** (`corridor.ts`): the circle point is
  computed once per sample and segments are rejected by their bounds
  (10 → 4 ms); the edged segments are looked up once per ring edge, in
  ascending order, instead of once per 50 µm sample (16 → 12 ms).
- **The last corridor geometry is kept** (`corridor.ts`, §10.2 "The last
  result is kept"): returned again while nothing it reads has changed, so
  a number, course-object or other-course drag over a corridor course
  pays 0.1 ms for the corridors instead of ~130.
- **A course `error` names its generation** (`worker.ts`, `engine.ts`,
  `docs/map-rendering.md` §5.2): the engine ends only the matching request
  and never rejects a load in flight on it; before, any `error` did both.

A corridor control drag now costs about 180 ms per request. The rest is
`polygon-clipping` — the inside union ~34 ms, the outer union ~69 ms,
the band's difference ~17 ms — which no bit-identical change reaches. A
per-leg cleaned-ring cache would save ~40 ms but moves the boundary by up
to 5–7 µm, and adaptive edge sampling moves the edge's ends: both
declined by the user for F20b; drag-time corridors (approximate while
dragging, exact on release) are the candidate for a later row
(`course-layer.md` Pending).

## Tests

- `packages/shared/src/__tests__/control-label-placement-reference.test.ts`
  with `__fixtures__/control-label-placement-reference.json`: 77 seeded
  cases (courses dense to sparse with curved legs, scaled ×1000 and
  ×0.01, hatched clusters, far and degenerate segments) recorded on the
  pre-cull placer and compared as JSON, bit for bit. Shrinking the reach
  to the third ring fails it.
- `packages/shared/src/course/__tests__/drag-budget.test.ts` on the
  fixture `drag-course.ts`: `placeControlLabels` < 400 ms and
  `deriveCourse` < 500 ms. The budgets are loose: they catch the
  quadratic coming back (on a slower machine), not a fast one — the old
  placer passed them here at 354 ms, so the reference fixture and the
  numbers above are the proof of the speed-up.
- `packages/web/src/map-gl/__tests__/engine.test.ts`: one request in
  flight, latest wins (three inputs → two requests, the first and the
  last); `null` waits like any input; the inputs before `load` → one
  request with the last of them; a load overtakes the request in flight
  and its reply is dropped; an error reply releases the waiting input.
- `packages/web/src/map-gl/__tests__/worker-course.test.ts`: a course
  request whose derivation throws answers `error`, and the next request
  is answered.
- `packages/shared/src/__tests__/control-label-placement.test.ts`: a NaN
  segment is judged as before the cull.
- The course goldens (`e2e/__golden__/map-gl/course-*.png`, the scene
  streams) are unchanged; the drag E2E describes of
  `e2e/course-editor.spec.ts` and `e2e/field-mode.spec.ts` stay green.
- F20b: `packages/shared/src/course/__tests__/corridor-reference.test.ts`
  (66 cases: inside, band, edges and openings as digests, recorded before
  F20b) and `cuts-reference.test.ts` (40 seeded cases of
  `polylineLegGaps` and `circleCuts`), both bit for bit;
  `corridor.test.ts` "the last call's result is kept" (the same object
  for the same input, every input it reads recomputes); the corridor
  budgets in `drag-budget.test.ts`; `engine.test.ts` and
  `worker-course.test.ts` for the error's generation. The course goldens,
  the `course-corridor` stream and the corridor and drag E2E describes
  are unchanged.
