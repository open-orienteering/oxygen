# Bugfix: an image course object printed without its graphic

Found and fixed 2026-11-13 by G15 (the print job, `docs/course-print.md`
§8.5) on `vector-map-pipeline`.

## What happened

An `image` course object (`course_objects`, kind `image`,
`props.graphicId`; `course-layer.md` §8.3, since F12 the home of
map-anchored images) was drawn by the composer — the sheet carries it in
`sheet.course.objects` and `composePage` places it in the map layer — but
`maps.pdf` left the picture out: the page had an empty rectangle and the
log a `maps.pdf: <sheet>: IMAGE_MISSING: graphic <id> has no image data`
warning.

## Why

The route loaded the graphics it hands the print worker by scanning the
selected `course_maps` rows' and their templates' `objects` for
`kind: "image"`. That was every image before F12. F12 moved map-anchored
images to `course_objects`, which the route reads separately
(`loadCourseObjects`) and only `sheetForMapRow` turns into sheet input —
so their graphic ids were never collected, and the worker got no bytes for
them.

## Fix

The graphics are now collected from the resolved sheets
(`sheetGraphicIds` in `course-maps/routes.ts`): every page object
(`sheet.objects`, template + sheet) and every image course object in scope
(`sheet.course.objects`). `buildPrintJob` does this once for both
`maps.pdf` and the new `print-job`, so the job's `graphics` list and the
PDF agree by construction.

## Test

`packages/api/src/__tests__/integration/print-job.test.ts` places a
cropped SVG as an image course object on a course at 1:7 500: the job
lists its graphic, a host composing the job fetches it from `print.png` at
the composer's box, the result is `maps.pdf`'s bytes, and the only
`IMAGE_MISSING` left is the deliberately foreign graphic.
