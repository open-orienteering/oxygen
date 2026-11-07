# Bugfix: the toner saver let text and out-of-bounds areas show outside it

**Reported:** 2026-11-06 (feedback on the v0.6.0 candidate, item 2; row P1).
**Area:** course layer (`packages/shared/src/course/`), PDF composer and the
Layout-mode canvas.

## What happened

In Layout mode, and in the printed PDF, a toner saver (the course object
`toner_saver`, or a map-anchored shape with the fill *White-out outside*,
`whiteoutInverted`) whitened the map outside its shape, but map text and
out-of-bounds areas (709) still showed there.

Both backends paint in colour order: the pass stream is sorted
colour-major (`sortPassStream`, `map-rendering.md` §3.6), the GL renderer
draws per colour in stack order, and `writePage` writes the map layer's
passes in stream order. The white-out outside filled **upper white**,
which the course stack places directly *below* upper purple
(`courseColourStack`), with the layout objects' own colour rows above
that. So everything in upper purple (709 / 707 / 711, course text), every
document colour above purple (a map's text colours often are) and every
layout text in its own row painted over the white.

A plain white-out keeps that order on purpose (legacy print: full → lower
→ ink → white-outs → upper). A toner saver's job is different: nothing of
the map should print outside it.

## The fix

`courseLayer` appends one row, `course:toner-saver-white` (CMYK
0/0/0/0), on top of `layer.colours` when it draws a map-anchored white-out
outside (`hasTonerSaver` and a window), and `layoutObjects` fills the
ring with it. The ring becomes the map layer's last pass, on screen (the
worker passes `layer.colours` through; the page part's `colourBase`
still starts after it) and in the PDF. The page layer is drawn after the
map layer in both, so page objects and the description block stay
visible. A page-anchored *White-out outside* is the page layer's and
keeps upper white.

The course overprint outside the shape is covered too; a generated hull
keeps the course 25 mm inside, so this only shows on a hand-drawn shape.

## How it is tested

- `packages/shared/src/course/__tests__/layer.test.ts`: both kinds fill
  the top row and are the last symbolised pass, after black, upper purple
  and a layout text's row; no row for a plain white-out or without a
  window.
- `packages/shared/src/print/__tests__/compose.test.ts`: with a 709 area
  and a course text outside a map toner saver, the ring is the composed
  map layer's last pass.
- `packages/web/src/map-gl/__tests__/worker-course.test.ts`: the toner
  white is the last colour of the visible set, after the document's top
  row and upper purple.
- `e2e/course-editor.spec.ts` "P1: …": on the Layout canvas a 709 square
  outside a toner saver leaves 0 purple and 0 dark pixels (638 purple
  pixels with the old order).
- Golden `e2e/__golden__/map-gl/course-objects.png` regenerated: six pixels
  of the 709.b border past the ring's edge are now white.
