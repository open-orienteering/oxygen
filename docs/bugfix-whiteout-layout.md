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

`triangulateEvenOdd` now resolves any ring that crosses (or touches) a
**convex** ring before grouping. The window is always a convex quad,
rotated or not. The crossing ring is replaced by:

- its part inside the convex ring, which becomes a hole;
- its parts outside the convex ring (Sutherland–Hodgman against each edge
  of the convex ring), which are filled.

These pieces cover the same even-odd region and cross nothing. If the
inside part is the whole convex ring, the two cancel. The pieces share the
convex ring's edges, so containment is then tested at a point on each
ring's boundary that lies on no other ring, rather than at the first
vertex.

Fills with no crossing are triangulated as before, so map tiles and the
goldens are unchanged. Two non-convex rings that cross each other are
still earcut's failure mode (`map-rendering.md` §5.2). Only malformed map
data produces that case.

## How it is tested

- `packages/web/src/map-gl/__tests__/strip.test.ts` "rings that cross a
  convex ring (P7)": area and point coverage for:
  - a shape whose first vertex is outside on the left;
  - a shape crossing the bottom with its first vertex inside;
  - a band reaching past both sides;
  - a non-convex L over a rotated window's corner;
  - a hole touching the outer ring's edge;
  - a shape covering the window whole;
  - a shape wholly outside the window.

  All but the last two failed before the fix.
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
