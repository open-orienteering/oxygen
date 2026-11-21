# Bugfix: the F13 apex probe read the wrong pixel, or a map line

Found 2026-11-08 on `vector-map-pipeline` (the F19 + F20 merge: 3 failures in
5 full-suite runs; F20's session saw it on the base too). Fixed 2026-11-09 in
`e2e/helpers/editor.ts` and `e2e/course-editor.spec.ts`. Test-only: the app
was right.

## What happened

`course-editor.spec.ts` › "a curved leg written over tRPC draws purple at the
curve's apex, not at the chord's midpoint" timed out on

```ts
await expect.poll(() => inkAt(page, [apex], "purple"), { timeout: 30000 }).toBeGreaterThan(0);
```

with 0 purple pixels for the whole 30 s, while the failure screenshot showed
the curve drawn through the apex. It never failed run on its own
(`-g apex --repeat-each=10`: 10/10 green), only in the full suite.

## Why

The probe reads **one canvas pixel** at the apex and asks whether it is
purple (`r − g > 50 && b − g > 50`). Two things put a non-purple pixel
there.

**1. `inkAt` rounded to the nearest pixel, not the containing one.** Pixel
`i` covers `[i, i + 1)`; `inkAt` took `Math.round(x)`, which for a point at
593.635, 137.524 reads pixel (594, 138), whose square does not hold the point
and whose centre (594.5, 138.5) is 1.3 px from it. At the editor's fit zoom
(4.75 px/mm) the 0.35 mm leg is 1.66 px wide, so that pixel is the stroke's
anti-aliased edge. Over the test map's orange area fill (255, 186, 54) a
~half-covered edge pixel is (211, 112, 155): `b − g = 43`, not purple. The
pixel that holds the point, (593, 137), was solid (166, 38, 255). Over white
the same edge pixel still counts as purple (`b − g` ≈ 109), which is why
most picks passed.

**2. A map line crossed the apex.** For another pair the containing pixel
itself was black (15, 11, 3): one of the map's black lines ran through the
apex. That is the stacking the spec requires — lower purple (705, the leg)
sorts under black 100 %, the ISOM brown and the blue line rows
(`docs/course-layer.md` §1) — so no purple there is correct. The test chose
the apex clear of sites and of the start's and finish's legs, but not of
the map's own ink.

**Why only in the full suite.** The control pair, side and bend fraction
come from a search over `regularCodes` and the editor's first view, which
depend on what earlier tests left in the shared event (courses, controls).
Run alone the search always lands on the same pair, whose apex happened to
pass; in the suite it lands on others (80 → 69 and 64 → 77 in the two
captured failures).

It was not F20's coalesced course requests: the poll re-captures the canvas
for 30 s and the drawn frame was final (the screenshot and the DOM mirror
agreed). A stale or late frame cannot keep a pixel non-purple for 30 s.

Reproduced deterministically by forcing each captured pair: 80 → 69 and
64 → 77 both failed every run, with the 7 × 7 pixel dumps above.

## Fix

- `e2e/helpers/editor.ts`: the screenshot-and-map code of `inkAt` is
  `canvasShot`, which maps a paper point to the pixel that **contains** it
  (`Math.floor`). Every `inkAt` / `inkIn` caller reads the right pixel now.
- `plainMapAt(page, at, radiusMm)`: whether the canvas is one colour (each
  channel within 8) within a radius of a point. The F13 test's search now
  also requires the apex on plain map within 0.5 mm (the leg's half width,
  a map line's half width and the pixel slop), read in the editor's first
  view after `editorReady`.

With the fix, the two captured pairs: 80 → 69 keeps its apex and passes
(the containing pixel is solid purple); 64 → 77's first apex is rejected as
not plain, the next fraction (0.2) is chosen and passes.

## Not changed

- No timeout raised, no retry added, the purple threshold unchanged.
- `e2e/map-vector-layer.spec.ts` has its own `rgb()` with the same
  `Math.round`, paired with a `toPaper` that maps a pixel's corner. Its
  probes read three points 0.1 mm apart across a stroke, so one off-by-one
  pixel does not fail them; it has not flaked. Left as is.
- `canvasInCircle` compares pixel indices with a continuous centre (a half
  pixel shift of a whole disc); it counts pixels in a region, not at a
  point, and is not affected in the same way.
