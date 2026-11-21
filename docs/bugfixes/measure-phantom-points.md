# Bugfix: measure tool phantom points and undo button

## Symptom

In measure mode on touch devices:

1. Placing points with no pan worked. After any pan, the dashed rubber-band
   kept a ghost endpoint where the pan finished (no vertex drawn there),
   and later legs connected through that phantom.
2. Tapping the undo HUD button removed a point and immediately placed a
   new one under the button, so undo was unusable on desktop.

## Root cause

1. **Sticky `measureCursor`.** `onTouchMove` updated the rubber-band cursor
   on every pan frame. `onTouchEnd` correctly refused to place a point
   after a pan, but never cleared the cursor. The overlay always appends
   `measureCursor` to the polyline (`allPts = [...points, cursor]`), so
   the pan-end position stayed visible.
2. **Stale viewport in touch listeners.** Native touch handlers closed over
   `screenToMapMm`, which closed over React `viewport` state. A tap right
   after a pan could compute map-mm with the pre-pan viewport.
3. **Undo click bubbled.** The measure branch of `handleMouseUp` lacked the
   `closest("button")` guard that the editor branch already had, so a
   click on the undo HUD also registered as a measure placement.

## Fix

- Clear `measureCursor` whenever the last finger lifts in measure mode.
- `screenToMapMm` reads `viewportRef` / `affineRef`; `panByDelta` syncs
  `viewportRef` immediately inside `setViewport`.
- Guard measure `handleMouseUp` with `closest("button")`; undo HUD
  `stopPropagation` on mouse/touch start and click.
- Drop the 300 ms "double-tap clears cursor" special case on touch (it
  only ate fast legitimate taps once the cursor no longer persisted).

## Tests

- Unit: `packages/web/src/lib/__tests__/measure-tap.test.ts`
- E2E: `e2e/map-viewer-gestures.spec.ts` (pan leaves no cursor; rapid taps
  place two points; desktop undo removes exactly one point)
