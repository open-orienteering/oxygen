# Bugfix: the action bar ran off the viewer (F15 E2E flake)

Found 2026-11-09 on `vector-map-pipeline`: `e2e/course-editor.spec.ts` ›
"F15: All variations numbers the sites when the variants number alike…"
failed in shard 1 of both of two full sharded runs and passed 5/5 on its own.
Fixed 2026-11-09 in the app (`MapViewer.tsx`, new
`lib/editor/action-bar-place.ts`). The test was right: the button really
could not be clicked.

## What happened

The test's second `appendClear` selects a control and clicks the action
bar's **Add to ‹course›** (`editor-action-append`). The click never landed:

```
locator resolved to <button data-testid="editor-action-append">Add to F15 numbers 45721</button>
- element is visible, enabled and stable
- scrolling into view if needed
- <div data-testid="shell-container"> intercepts pointer events
- retrying click action (×206)
```

and the test timed out waiting for the `course.setStructure` response that
click should have sent. In the failure screenshot the bar's **Also in** line
names 13 courses left by earlier tests in the same event, the bar starts left
of the map viewer, and the map inside the viewer is shifted.

## Why

The viewer placed the bar (`actionLayout: "bar"`) at
`left: clamp(anchor.x, 8, w − 8)` with `transform: translateX(-50%)` and
`top: anchor.y + r + 10`, capped at `maxWidth: w − 16`. Its **Also in** line
was `white-space: nowrap`. Three things followed:

1. **The bar's start ran past the viewer's left edge.** Thirteen course names
   on one line made the bar as wide as `maxWidth` allows, nearly the whole
   viewer. Centred on a control left of the viewer's middle, its left half
   (where *Add to …*, the first entry, sits) lay left of the viewer. The
   viewer is `overflow: hidden` and cannot scroll left of 0. The page's
   shell is what is under that point, so every click attempt hit the shell.
2. **The bar hung below the viewer.** `regularCodes` picks controls down to
   30 px above the viewer's bottom. The bar is laid out under the control,
   so it ran past the bottom edge. To reach it, Playwright's scroll-into-view
   scrolled the clipping viewer (`scrollTop > 0`). That shifts the map
   inside a viewer whose box has not moved, so every later page-to-paper
   conversion is off by the scroll.
3. **The Also-in text drew past the bar's border.** A nowrap line wider than
   the capped bar overflows it.

**Why only in the full suite.** A control is in as many courses as earlier
tests left behind with it. When this spec file runs alone, the control the
test picks is in few courses and the bar is narrow. In shard 1, other spec
files had run first in the same event. Run alone, the spec (all 67 tests,
chromium) passed. Thirteen courses through every control, created just
before the test, made it fail every run with the same call log and
screenshot.

## Fix

The bar is placed inside the viewer (`docs/course-editor.md` §2):

- `actionBarPlace` (`packages/web/src/lib/editor/action-bar-place.ts`, pure):
  **centred under the selection, shifted sideways only as far as it takes to
  stay 8 px inside the viewer**, and **above the selection when it does not
  fit below** (still below, shifted up, when it fits neither way). The bar is
  `width: max-content` (capped at `w − 16`), so its size does not depend on
  where it is put. The viewer measures it once it is mounted (before paint)
  and again on every resize (`ResizeObserver`). The bar carries
  `data-placement="below" | "above"`.
- The **Also in** line is one line cut with an ellipsis inside the bar, with
  the whole text in its `title`. The inspector's Selection section lists all
  the courses anyway.

## Tests

- Unit: `packages/web/src/lib/editor/__tests__/action-bar-place.test.ts`
  covers centring, the shift at both edges, a viewer narrower than the bar,
  the flip above near the bottom, the "fits neither" case and the size-0
  first frame.
- E2E: `course-editor.spec.ts` › "The action bar stays inside the viewer".
  Fourteen courses run through every control. On the leftmost clear control
  (left of the middle), the bar's and *Add to …*'s boxes lie inside the
  viewer, the Also-in line ends inside the bar, and its title names the last
  course; *Add to …* writes. On the lowest clear control the bar lies inside
  the viewer vertically (above the control when it does not fit below), and
  *Add to …* writes again. The viewer is never scrolled. Before the fix it
  failed on the bar's placement. F15 with the 13 leftover courses failed
  before the fix and passed 3/3 after it.

## Lesson

A clipping container (`overflow: hidden`) can still be scrolled
programmatically, and Playwright's actionability check does exactly that. A
popup laid out partly outside it is a real bug, and in a test it shows up as
an intercepted click or as later coordinates that are all off. Popups inside
the viewer must be placed inside it, not just anchored to their target.
