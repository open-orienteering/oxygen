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

## Not in this fix (F20b)

On corridor courses `corridorGeometry` adds 126–230 ms per request and
`polylineLegGaps` 22–40 ms at 3000 cut features. Their cost is F20b's
(a per-run ring cache, adaptive edge sampling, a feature prefilter by the
leg's box), after F19 changes the same files.

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
