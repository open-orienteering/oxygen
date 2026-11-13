# Bugfix: bend drags left the map or pressed the action bar; F21's and F13's probes found no fit

Found 2026-11-11 on `vector-map-pipeline` while fixing the F7 flake (PR #165,
`docs/bugfix-f7-offleg-under-inspector.md`). Fixed the same day in
`e2e/course-editor.spec.ts` and `e2e/helpers/editor.ts`. Only the tests
changed; the app was right.

All three tests build their course with `twoControlCourse`. It picks the two
controls from what the shared event already holds, so the leg under test lands
anywhere on the map, depending on what earlier tests left behind. Each test
then assumed one geometry for that leg.

## What happened, and why

### F16 "Add bend here is smooth … Alt breaks the pair …": a 2-minute timeout

The test pulls a grip 60 px along the leg's normal (always the upward one), then
Alt-drags it 30 px further. With a leg running down the inspector's right edge
(x 350), the Alt drag went from (362, 492) to (332, 489), which is under the
inspector. The inspector lies over the viewer's box but outside its DOM. So the
drag left the viewer, and the viewer's `mouseleave` calls the tool's
`onPointerUp(null)`, a cancel (`MapViewer.tsx`, since D5). Nothing was written,
and `waitForTrpc("course.setStructure")` ran into the test's 2-minute timeout.

F3's "Add bend here, a dragged bend handle" has the same shape: a fixed 60 px
drag up, which leaves the viewer over its top edge when the leg runs along it.

F16 failed one more way, in an in-order run: "the outline straight: from,
bend, to" read 89 points, not 3. `legClickPoint` picks the point of the leg
farthest from every site, and here that was 12 % along the leg 86 → 61. Add
bend here puts the bend where the leg was clicked. A smooth bend's handles are
a sixth of the neighbours' chord (F16), so the handle reached past control 86:
the control points are still collinear, but the curve runs back over itself.
The test assumes a bend more than a sixth from both ends.

### F24 "the loupe on mouse drags — a control, a number, a bend …" (since F30: "… a control, a bend; none on a number …"): no loupe

Its bend part drags the handle 60 px up the leg's normal, presses it again
without moving (no loupe for a click), then drags it 40 px back. With a leg
along the bottom row of the control grid, the action bar is flipped above the
leg, and the 60 px drag ended on it at (547, 539). The bar stops a press
(`onMouseDown` stops propagation), so the next press at the moved handle went
to the bar. No drag started and no loupe showed. This failure was also seen
before any of these changes, in an in-order run on `d2b4a191`.

### F21 "a held bend drag redraws the course live …": three different failures

1. **"the fixture map has colour where the band goes"** (seen in the full
   sharded run and in an in-order run). The test chooses an apex for the bend
   and band probes beyond it. Once the corridor's band moves there, those probes
   must read no map colour, and before that they must read some. It never
   checked that the probes had map colour under them at all. With a leg near the
   map's top, the band beyond the apex lay on the white paper above the mapped
   area: zero map colour before the band ever got there.
2. **"no apex clear of the sites and the held loupe"** (10 of 12 runs of the test
   alone with `--repeat-each`; the repeats leave the controls that pick a leg
   along the bottom row). The search needed *every* band probe at least 6 mm
   from every site, and tried the apex only straight off the bend. Upward lay the
   next row of the fixture's control grid; downward lay off the map.
3. **The metres never followed the held bend** (1 of 8 repeats). The start, a,
   b and the finish lay in one row of the control grid, so the leg b → finish ran
   back over the whole leg a → b. The leg click selected the leg drawn on top,
   "Leg 72 → Mål 1", the bend went on that leg, and the a → b metres under test
   never changed.

### F13 "a curved leg written over tRPC draws purple at the curve's apex …": no pair

The test searches pairs of regular controls for a chord midpoint and an apex
that are both in view and 6 mm clear of every site, with the apex on plain map.
It drew its candidates from `regularCodes(page, 6)`, the first 6 controls clear
of every leg drawn when the editor opens, and tried four arch heights. Which
legs are drawn then depends on the earlier tests' courses. In some full-suite
contexts (and in an in-order run on `d2b4a191`, before these changes) no pair
passed: "a pair of regular controls with a clear apex and chord midpoint".

F23 (#163) and F24 (#164) did not cause any of this: leave-means-cancel dates
from D5. F24's loupe was already taken into account in F21's probe choice.

## Fix

- **`dragEndOnMap(page, from, dirs, dists, { endOnBar })`** (helpers). It
  returns the end of the first drag, in order of preference, whose 8 steps (what
  `drag` moves through) stay inside the viewer, 20 px from its edges, with
  nothing outside the viewer over them (`coveredBy`). The action bar is the
  viewer's child and stops only the press, so a drag may cross it, and may end
  on it as a fallback. With `endOnBar: false` the end must be clear of the bar
  too: that is for a drag whose end the next gesture presses. `turned(v, deg)`
  gives the directions.
- **F3 bend drag and F16 grip pulls:** perpendicular and up first, then ±30°,
  then the downward side. F16's first pull tries 60, 90 and 120 px with
  `endOnBar: false`, because the Alt drag presses where it ends. The Alt drag
  checks that the grip is clear before it presses.
- **F24's bend drags:** the first one is chosen the same way as F16's first
  pull (60, 90 or 120 px, `endOnBar: false`). The test checks that the moved
  handle is clear before pressing it. The Escape drag goes back towards the leg,
  or any way off it that stays on the map.
- **F13's pair search:** 16 candidates instead of 6, and the arch heights
  ±0.15, ±0.25 and ±0.35 of the leg besides ±0.2 and ±0.3. The test writes its
  leg over tRPC and clicks no control, so the larger pool costs only search time.
- **`inkedAt(page, points, kind)`** (helpers): the points whose canvas pixel is
  of `kind`, one per pixel. `inkAt` is now its count.
- **F21's probes:** the chord's band keeps only the points with map colour under
  them before any corridor (at least 20). The apex search:
  - also slides the apex 3 and 6 mm along the chord. The handles stay along u,
    so the leg's tangent at the apex is u either way.
  - filters out band probes near a site instead of rejecting the candidate.
  - requires the drag from the bend to the apex to stay on the map
    (`dragEndOnMap`).
  - keeps only the band probes with map colour under them, and needs at least
    20.

  So "= 0 once the band is there" is exactly the corridor's work.
- **F3's `twoControlCourse` and `legClickPoint`:** `legClickPoint` now picks
  its point only in the middle half of the leg (25–75 % along a → b), where its
  fallback, the midpoint, already was. It also keeps the point more than 2 mm
  from the course's other legs, and returns that clearance. `twoControlCourse` undoes a b whose leg a → b has no such point and
  picks another, up to 6 tries. `selectLeg` checks that the Leg section names
  `a → b`.

## Verification

Run under `scripts/with-verify-lock.sh`, chromium project:

- Before the fix: F21 alone with `--repeat-each=12` failed 10 of 12.
- After the fix: F3 bend, F16 and F21 alone with `--repeat-each=8` passed
  24/24.
- The final code:
  - F3 bend, F16, F21, F24 and F13 alone with `--repeat-each=4`: 20/20.
  - `course-editor.spec.ts` in order (the shard-1 context), twice: 68/68 both
    times.
  - The full sharded `pnpm test:e2e` (4 shards): 387 passed, 0 failed.
- Before the last fixes, the in-order runs and one full run each had one
  failure, each fixed above in turn: F16's bend at 12 % (the middle-half rule),
  F24's press on the bar (`endOnBar: false`, then the 10 px margin) and F13's
  pair search.
