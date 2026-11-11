# Bugfix: F7's control into B was placed under the inspector

Found 2026-11-11 on `vector-map-pipeline` at `d2b4a191`: the full sharded E2E
run failed once out of 385 tests, in shard 1. Fixed the same day in
`e2e/course-editor.spec.ts` and `e2e/helpers/editor.ts`. Only the tests
changed; the app was right.

## What happened

`course-editor.spec.ts` › "F7: variations and loops › Create variation here, a
control into B, Variant and All-variations views, the unbalanced check, Loop,
export, undo" timed out in `place()` (`e2e/helpers/editor.ts`). With K armed
and tab B shown, the test clicked a point and then waited 15 s for a new site
in the mirror. No site came, and the `course.setStructure` it waited on was
never sent. It passed 5/5 when run alone (`--repeat-each=5`) and failed on the
first run of the spec file in order.

## Why

The test gets the placement point from `offLeg`, a spec-local helper: a point
half the leg a → b's length to one side of the leg's midpoint. `offLeg` checked
only two things. The point had to be inside the `map-viewer` box less a margin,
and at least 45 px from every site.

But `map-viewer` spans the whole editor, **under** its floating panels. The
inspector (`editor-inspector`, the Sequence / Selection / Checks column at the
viewer's left) lies over the map. In the failing run the controls that
`appendClear` picked gave a nearly vertical leg near the inspector's right
edge: 1 at (458, 335) and 2 at (412, 601), page px. The +½-length side came out
at (302, 445), under the inspector's "Part 2" block (the trace's `mouseClick`
shows the point). The click went to the inspector and the map never saw it, so
nothing was placed.

**Why only in context.** `appendClear` picks controls from what the shared
event already holds. The editor then fits the view to them. Both depend on the
controls and courses that earlier tests in the file (or in the shard) left
behind. Run alone, the test gets a pair whose `offLeg` point lies on open map.

F15's "All variations numbers the sites…" uses the same `offLeg` (its `into()`
helper), so it had the same exposure.

F24 (#164, mouse drags in `MapViewer.tsx`) and F23 (#163, the touch path) are
not involved. This is a plain click with K armed: no drag, no loupe, no touch.

## Fix

- **`offLeg` accepts only points that reach the map.** It now waits for the
  view to settle first. Then each candidate must be:
  - inside the viewer margin and 45 px from every site (as before)
  - 30 px from every drawn number (`course-label`)
  - outside every description sheet's drawn box, plus 12 px (`sheetBoxes`, now
    exported from the helpers; the sheet's svg ignores pointer events but
    covers the map's ink)
  - not covered by editor chrome (`coveredBy(page, p) === null`): the
    inspector, the tool rail, the action bar and the rest of `CHROME`.

  It also tries more offsets (±0.9 and ±0.25 of the leg's length besides ±0.5,
  ±0.7 and ±0.35) before it falls back to `emptyPoint`, which already skipped
  the chrome.
- **`place()` fails fast on a covered point.** `clickMap` already did this. An
  armed click over the chrome now throws `placement point (x, y) is covered by
  editor-inspector` right away, instead of a 15 s poll that names no cause.

## Verification

- The spec file in order, chromium project (the shard-1 context): failed on
  the first run before the fix, passed after it (see the PR for run counts).
- The full sharded `pnpm test:e2e`.
