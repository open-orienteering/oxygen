# Bugfix: the page oracle composited premultiplied pixels as straight alpha

## What happened

The page oracle (`packages/api/src/render/page-raster.ts`,
`docs/course-print.md` §7.5) draws a composed page in two layers: the map
layer rasterised over the frame on a transparent background, and the page
layer over the sheet, both composited onto white paper by `over()`. The
layers come from resvg, whose `pixels` are **premultiplied** RGBA
(50 % cyan is `(0, 128, 128, 128)`), but `over()` composited them as
straight alpha (`src · a + dst · (1 − a)`). Every partly covered pixel
lost `c · a · (1 − a)` of each channel: up to a quarter of the channel
value at a half-covered edge. Black was untouched (`c = 0`); saturated
colours (cyan water, purple, the greens) came out darker along every
anti-aliased edge.

The page goldens (`e2e/__golden__/map-gl/page-*.png`) did not show it:
their map layers cover the frame with opaque fills, so no map pixel is
partly transparent, and their page layers are black and white. The PDF
golden tier (§9.2) therefore passed. The C7 corpus print run (§11) found it:
real maps leave paper white between objects, and the oracle disagreed with
the poppler raster of the same page on 0.9–4.8 % of the pixels, every one
an edge pixel with a saturated channel (`255` in the PDF raster, `~195`
in the oracle).

## The fix

`over()` adds the premultiplied source as it is: `src + dst · (1 − a)`.
The committed page goldens re-render byte-identical (no partly
transparent pixels to change). On the corpus, backend parity dropped from
4.77 % to 0.49 % (crop-b) and from 0.89 % to 0.24 % (sprint).

## Tests

`packages/api/src/render/__tests__/page-raster.test.ts` "composites the
layers' premultiplied pixels": a premultiplied half-covered cyan pixel
over white is `(127, 255, 255)`, and an edge pixel of a cyan fill from
`rasterisePassStream` on a transparent background keeps G and B at 255
after compositing. The test fails on the old formula.
