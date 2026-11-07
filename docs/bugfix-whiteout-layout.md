# Bugfix: a large white-out outside turned the map white in Layout mode

**Reported:** 2026-11-07 (user; row P7).
**Area:** the GL viewer's fill triangulation (`packages/web/src/map-gl/prepare.ts`).
Print, the reference raster and View mode were not affected.

## What happened

In Layout mode a small toner saver, or a shape with the fill *White-out
outside*, drew correctly inside the frame. A larger one that reached past
the frame did not:

- with its leftmost part outside the frame, the **whole frame went white**;
- reaching past the frame's bottom, a **white slash** of map disappeared.

A white-out outside is one even-odd area of two rings: the map window
(the frame plus 1 mm bleed), and the shape as its hole (`whiteoutOutside`
in `packages/shared/src/course/objects.ts`, `course-layer.md` §3.6). Once
the shape reaches the frame the two rings **cross**.

On the canvas, fills go through `triangulateEvenOdd`, which groups rings
into outer rings and holes by containment before handing them to earcut.
It tested whether a ring was inside another **at the ring's first vertex
only**:

- The toner saver's hull starts at its leftmost site (`convexHull` sorts
  by x). With that vertex outside the window, the hull counted as a
  second outer ring. The window was filled whole and the hull on top, so
  the whole frame went white.
- With the first vertex inside, the shape was handed to earcut as a hole
  that crosses its outer ring, which earcut does not support. For a
  rectangle earcut dropped the hole, so the frame was filled whole. For a
  curved hull it left slivers: the white slash.

A plain white-out (`W`, or the `whiteout` course object) is a single
ring. It was drawn correctly at every size and position.

The PDF fills the same rings with `f*` under the frame clip, and the
reference raster uses `fill-rule="evenodd"`. Even-odd handles crossing
rings exactly, so print was right all along. View mode and Course mode
have no window, so they draw no white-out outside at all
(`WINDOW_MISSING`).

## The fix

`triangulateEvenOdd` now checks whether a ring crosses (or touches) a
**convex** ring. The window is always a convex quad, rotated or not.

For **two rings**, which covers every white-out outside, the region is
triangulated exactly without giving earcut any hole that touches its
outer ring (`convexPairTriangles`):

- The window outside the shape: earcut of a box round both rings, with the
  shape as a hole that touches nothing. Each triangle is then clipped to
  the window.
- The shape outside the window: the shape's own earcut triangles, each cut
  by the window's edges.

Every clip is convex against convex, so nothing is bridged and rounding
cannot create a crossing.

A first version made the shape's part inside the window a hole of the
window ring. The spec review found that this still failed for a
non-convex shape with two arms crossing one edge. Sutherland–Hodgman
joins the two pieces with a zero-width bridge, and earcut dropped holes
that touch the outer ring at fractional coordinates (`strip.test.ts`'s
parity oracle covers this now).

For **more rings**, which no producer emits, the crossing ring is
replaced by its parts inside and outside the convex ring, cut into simple
rings. Containment is then tested at a boundary point that lies on no
other ring. This is best effort, because the inside parts still touch the
convex ring.

Fills with no crossing are triangulated as before, so map tiles and the
goldens are unchanged. The crossing test first filters the larger ring's
edges against the convex ring's bounds. On a 5 000-vertex ring round 100
convex holes it takes 9.0 ms, against 7.3 ms before P7. Two non-convex
rings that cross each other are still earcut's failure mode
(`map-rendering.md` §5.2). Only malformed map data produces that case.

## How it is tested

- `packages/web/src/map-gl/__tests__/strip.test.ts` "rings that cross a
  convex ring (P7)": area and point coverage for:
  - a shape whose first vertex is outside on the left;
  - a shape crossing the bottom with its first vertex inside;
  - a band reaching past both sides;
  - a non-convex L over a rotated window's corner;
  - a hole touching the outer ring's edge;
  - a shape covering the window whole;
  - a shape wholly outside the window;
  - a U and an E whose arms cross one edge, at fractional offsets and
    turns, checked against a grid even-odd parity oracle;
  - two nested non-convex rings that each cover the window.

  The crossing cases failed before the fix.
- `packages/web/src/map-gl/__tests__/worker-course.test.ts`: through the
  worker, the toner white of three crossing shapes (a toner saver from
  the left, one from below, a path reaching past both sides) covers the
  window outside the shape and not its inside. The same holds for a
  page-anchored white-out outside past the frame's left edge in the page
  part. All four failed before the fix.
- `e2e/course-editor.spec.ts` "P7: …": on the Layout canvas, one 709
  square inside the shape keeps its purple and one outside it shows none.
  This is checked for a toner saver from the left, one from below, and a
  page white-out outside rectangle dragged with `V` past the frame's
  bottom and then its left edge.
