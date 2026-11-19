# Course maps

Oxygen turns an uploaded OCAD base map and a course into a fixed-scale
printable sheet. The browser editor and server renderer share the same
paper-millimetre document model so screen placement and final PDF output use
the same geometry.

## Terminology

- **Base map / baskarta** — the uploaded OCAD file in `map_files`.
- **Map template / kartmall** — reusable paper and layout settings in
  `map_templates`.
- **Course map / karta** — one printable sheet in `course_maps`. A course can
  own several maps (for example, two map-exchange parts).
- **Club map template** — a template payload in `club_map_templates` that can
  be copied into another event.

An all-controls sheet is a `course_maps` row with
`kind = 'all_controls'` and no course. A partial unique index allows one such
map per event. A setter map (F10, `course-layout.md` §8) is a row with
`kind = 'setter'`, `course_id` NULL (the event's) or set (a course's), and
its group in `props { setter, controlIds }`; migration
`20261108150000_course_maps_setter_kind` relaxed the two CHECK
constraints that held `kind` to `course` / `all_controls`.

## Coordinate spaces and scale

The renderer keeps three coordinate spaces distinct:

| Space | Unit | Axis |
|---|---|---|
| Base map and course geometry | OCAD paper millimetres | y up |
| OCAD SVG | 1/100 paper millimetres | transformed by `ocadToSvg` |
| Page and layout objects | print millimetres | y down |

For a base map at `baseMapScale` and output at `printScale`:

```text
scaleRatio = baseMapScale / printScale
windowWidthMapMm = frameWidthPageMm / scaleRatio
```

Thus a 1:15000 base map printed at 1:7500 enlarges by 2×. UI zoom is only
screen magnification and never changes `printScale`.

`packages/shared/src/course-maps/geometry.ts` owns this math. Layout
objects are page-anchored and stay fixed when the map window moves; what
moves with the terrain (white-outs, 709 areas, map text, logos on the map)
is a course object ([`course-layer.md`](course-layer.md) §8), clipped to
the map frame.

### Orientation

The print pipeline renders the pinned document in **paper space** — no
mercator warp — so the drawn meridian lines only lean by their *in-paper
tilt* (ISOM 601.x lines are often rotated inside the drawing to fit the
sheet; Nackareservatet: 3.3°). Print therefore sets
`MapWindow.rotationDeg = -meridianTiltDeg`, where the tilt is the
document import report's `north.meridian.medianTiltDeg`, read through
`getBaseMapInfo` (0 when the file has no meridian cluster;
`course-print.md` §10). Using `-north_offset` (the bearing from true
north to the meridian direction) here would over-rotate by the
paper-to-true-north bearing (see
`docs/bugfix-course-map-print-orientation.md`). `mapToPage` /
`pageToMap` rotate about the map-frame centre when it is non-zero; the
PDF composer draws the rotated window under `T_map` (`course-print.md`
§4.2). Control-circle cut angles rotate with the map.

## Data model

`MapTemplate` stores:

- A3, A4, A5, or custom paper and portrait/landscape orientation
- print scale
- map frame, control-description placement, and appearance in `settings`
- shared text, line, rectangle, path, image and white-out objects in
  `objects`, all **page-anchored** (`anchor: "page"`, the only value the
  schema takes since F12; the map-anchored ones moved into
  `course_objects` with scope `{ all }`, [`course-layer.md`](course-layer.md) §3.6)
- `auto_key` (`<paper>-<orientation>-<scale>`) and `is_extra`: the
  template's key and whether another template is that key's auto one
  ([`course-layout.md`](course-layout.md) §5)
- `version`, the concurrency token (`course-layout.md` §2)

`CourseMap` stores:

- course or all-controls kind
- optional template
- map-window centre
- per-map overrides and (page-anchored) objects; F12 moved a sheet's
  map-anchored objects into `course_objects` scoped to its course (a
  class sheet's to its class, an all-controls sheet's `{ all }`)
- ordering among several maps for one course
- `class_id`: set on a class's sheet (a class print override,
  `course-layout.md` §6), NULL on a course's own sheets; `section_index`
  (0 until map exchange) and `props`
- `version`, the concurrency token

`Class` carries the print override: `print_scale` and
`sheet_template_id` (`ON DELETE SET NULL`). Layout data, not journaled.

Every layout object takes `opacity?` (0–1 inclusive, 0 allowed, absent =
1) and `blend?` (the literal `"multiply"`, absent = normal); text,
rectangle and image take `rotationDeg?` (degrees **clockwise as seen**,
finite within ±360, not normalised; 0 and absent alike); an image takes
`flipH?` / `flipV?` (J4; `objectOpacitySchema`, `objectBlendSchema`,
`objectRotationSchema` in `course-maps/schema.ts`) and `knockout?` (J15:
cut out the page images below it, course-layer.md §3.6 "Knockout
images"; absent = off). The stored box is
always the unrotated one: a rectangle and an image turn about its
centre, after the flips; a text about its anchor point (user 2026-11-18,
question 6). Lines and paths store no angle (an unknown key is stripped,
as for any layout key). Objects without the fields parse as before, so
no migration; an older build strips the fields on parse (decision log,
J4 rollback). How they are drawn: [`course-layer.md`](course-layer.md) §3.6.

Both event-scoped tables use UUIDv7 plus per-event `seq`. Deleting an event
cascades through all maps and templates. Deleting a course cascades through
its maps; deleting a template leaves maps in place with `template_id = NULL`
so the UI can report and repair the invalid assignment.

`graphics` stores uploaded SVG or PNG images (BIGSERIAL id, mime-checked
at upload; SVG content is parsed and rejected if it contains scripts,
event handlers or external references). An upload may be up to 16 MiB
and a stored row at most 8 MiB (J2): a PNG whose longer side is over
4096 px is resampled to 4096 by `sharp` (aspect and alpha kept, metadata
dropped); a PNG still over 8 MiB is resampled to 3072, then 2048 px, and
refused only beyond that (user 2026-11-18, question 12); a PNG that fits
is stored byte for byte; an SVG over 8 MiB is refused. An SVG whose
canvas is much larger than what it draws is stored **trimmed** to the
drawing (user 2026-11-19, "Trim new uploads"; `trimSvgUpload` in
`course-maps/svg-window.ts`, run in a print worker, `trimSvgInWorker`, so
resvg stays off the event loop): rendered by resvg at 2048 px on its longer
side, the pixels with any alpha bound the drawing, plus one probe pixel
each side; when that leaves more than 5 % of the canvas width or height
empty, the original root is wrapped in an outer `<svg>` whose `viewBox`
is those bounds (the original's own viewBox, styles and fonts keep their
meaning; the prolog, a DOCTYPE's entities included, stays in front). The
wrapped SVG is rendered once more and kept only if resvg reads it and it
still draws. Otherwise, or when it draws nothing or resvg cannot read it,
the SVG is stored byte for byte. Graphics stored before are not
changed. A PNG over 64
megapixels is refused before decoding. `width_px` / `height_px`
(nullable) hold the pixel size: a PNG's own, an SVG's (trimmed) viewBox scaled so
its longer side is 4096 px (question 14). Written at upload, copied by
`saveToClub`, computed by the venue's snapshot import; the migration
fills PNG rows from their IHDR and `graphics.list` fills any row still
NULL the first time it reads it — so that query writes, once per row: the
size, or 0 × 0 for bytes that cannot be sized (answered as no size), so
they are not read again (`course-maps/graphics.ts`
`prepareGraphicUpload`, `graphicPixelSize`). Upload preparation runs
under the print gate. Deleting a graphic that sheets still place leaves
those image objects pointing at a missing graphic: the editor and print
report it as before J2 (`IMAGE_MISSING`); the picker does not check use.

Tests (J2): `packages/api/src/__tests__/course-map-graphics-upload.test.ts`
(pixel size, the 4096 resample with alpha, the 3072/2048 fallbacks, the
2048 refusal, 64 MP and SVG over 8 MiB refused, an SVG trimmed to its
drawing (in a print worker; an Illustrator-style DOCTYPE's entities kept so the stored bytes render) and one that draws nothing kept, `thumbBox`);
`integration/graphics.test.ts` (upload sizes, the list's backfill and its
0 × 0 mark, the migration's IHDR SQL, `version` after a byte change,
`saveToClub`, `thumb.png` for PNG and SVG, the kiosk key on the three
routes, a club graphic, and not across events); `integration/venue-print.test.ts`
"a graphic over 4 MiB" (two `exportBlob` slices, imported with its size);
`packages/shared/src/__tests__/course-maps.test.ts` "layout objects:
opacity, blend, rotation, flip (J4)" (each field per kind, ranges, old
objects unchanged, validation by the rotated extent);
`packages/web/src/lib/__tests__/graphics-picker.test.ts`; E2E in
`course-layout.md`'s test table ("graphics: upload an SVG…"). `event_id NULL` marks a
club-library graphic shared across events; event rows cascade on event
delete. An `image` layout object references a graphic by id; print
embeds it in the page (PNG as is, SVG rasterised in the API at render
time — [`course-print.md`](course-print.md) §6.3).

Structured JSON is validated at every tRPC boundary with the Zod schemas in
`@oxygen/shared`.

## Rendering pipeline

`maps.pdf` composes every event's pages from its pinned map document
since E3, the flip (`course-print.md` §8; `map-pipeline-switch.md`,
history note). It reads the templates, course maps, courses, controls
and graphics:

```text
map_documents (pinned) + course_maps / map_templates rows
  -> sheetForMapRow → resolveSheet   (paper, frame, window, course structure, description rows)
  -> composePage: window objects ⊕ courseLayer() in one pass stream under T_map,
                  clipped to the frame; page objects and the description block
  -> writePage → PdfWriter (@cantoo/pdf-lib): DeviceCMYK, embedded subset fonts,
                  one document for every page
```

No SVG, no `rsvg-convert`, no raster of the map. See
[`course-print.md`](course-print.md) for the page model, the colour modes
and the differences from the legacy page that are intended
(`course-print.md` §8.4). A document whose colour stack is not aligned
is a 400 with the reason (`course-print.md` §8.1); a map without a pinned
document has no base map to print (400).

The legacy path (OCAD → SVG with the IOF colour-stack rewrite →
`rsvg-convert` → pdf-lib merge) was unreachable since E3 and went in
E4a; git history up to v0.5.0 has it.

Course symbols start from norm dimensions in output millimetres: 2.5 mm
control radius and 0.35 mm stroke by default. When a base map is enlarged
for printing, the overprint is enlarged by the same
`baseMapScale / printScale` factor. The IOF symbol
fragments formerly generated in the web package now live in
`packages/shared/src/course-maps/`, with web re-exports for compatibility.

The API production image needs no system tool or font to print: the
composer embeds the bundled Liberation files. `librsvg2-bin` and
`fonts-liberation` left the image in E4a. `qpdf` and `poppler-utils`
(which check and rasterise printed PDFs in the tests) are installed on
the CI runner only (`course-print.md` §9.4).

## API

Event-scoped tRPC routers:

- `mapTemplate` — list, create, update, duplicate, delete, apply to courses,
  save/load/delete club templates
- `mapTemplate.list` returns `autoKey`, `isExtra`, `version` and
  `sheetCount`; `update` takes an optional `baseVersion`
  (`course-layout.md` §2)
- `layout` — `autoSheets { courseId?, allControls? }` (`allControls:
  true` also ensures the event's all-controls sheet; alone it runs only
  that part; the answer's `allControlsSheet` is its seq),
  `classOverrides { courseId }`,
  `setClassOverride { classId, printScale?, sheetTemplateId? }`
  (`course-layout.md` §5–§6); `setterMaps { courseId?, groups }`,
  `moveToSetter { controlId, sheet }`, `recalculateSheet { sheet }`
  (F10, `course-layout.md` §6, §8)
- `courseMap` — list with validation (each row with its `class`, a
  setter sheet's `setter { index, controls }`, the
  template's key, `resolved` — document and window — and `validation`;
  the overlay itself is `resolveSheet`'s), get, create, update, delete,
  reorder, `saveLayout` (the sheet only: window centre, print scale,
  block, its own objects; it never writes the template);
  `resolveSheet` (a sheet, a template previewed with a course or alone,
  or a class as it prints — `{ classSeq }`, Class view — as the composer
  draws it: the read of the editor's Layout mode, `course-layout.md` §1,
  §6); `saveLayout` and `update` take an optional `baseVersion` (a stale
  one is `CONFLICT` with the row now; omitted, last writer wins) and
  answer the new `version`
- `graphics` — list (event + club, each with `widthPx` / `heightPx` and
  `version`, the bytes' version for content-keyed URLs),
  upload (base64, ≤ 16 MiB, prepared as in Data model), saveToClub,
  delete

REST:

```text
GET /api/maps/:nameId/maps.pdf
    ?maps=1,2
    ?courses=3,4         (the courses' own sheets; a root's per variant, a variant's on its root's — F8)
    ?classes=5,6         (per class: its sheets, else its course's as it prints)
    ?allControls=1
    ?setter=1            (every setter sheet, F10)
    ?variants=3:AB,BA    (those variants of one root, F8)
    ?allVariations=3     (the root's all-variations page, F8)
    &copies=runners[&spare=n]   (each page once per runner it is for, F8)

GET /api/maps/:nameId/print-job?<the maps.pdf query>   (the job maps.pdf composes, JSON; G15; version 2 carries the event's patch, G14)
GET /api/maps/:nameId/graphics/:id
GET /api/maps/:nameId/graphics/:id/print.png[?w=&h=[&crop=]]   (the PNG a print embeds; SVG needs w, h, crop = its window; G15)
GET /api/maps/:nameId/graphics/:id/thumb.png[?v=]       (≤ 256 px on the longer side, never enlarged; immutable cache; J2)
```

The three graphic routes answer `courses.view`, and the event's kiosk key
(header `x-kiosk-key` or `?k=`; J2, user 2026-11-18 Q2: the kiosk and
viewer draw images; the key reads the event's own graphics and any club
graphic by id, answer 15). `thumb.png` resamples a PNG with `sharp`
(at most 64 MP decoded) and rasterises an SVG with resvg in a print
worker, both under the print gate. An id's bytes can be replaced (a
checkout's import replaces the row under the cloud's id; an id can be
reused after deletes), so the picker asks `thumb.png?v=<version>` from
`graphics.list` (`<sizeBytes>-<updated_at ms>`; the row's trigger stamps
`updated_at` on any write) and the answer is `Cache-Control: private,
max-age=31536000, immutable` per URL; the route ignores `v`.

The other routes require `courses.view` (the kiosk key where stated). `print-job` has `maps.pdf`'s selection,
order, caps and 400s; a host composes it with `renderPrintJob`
(`@oxygen/shared/print`) to `maps.pdf`'s bytes (`course-print.md` §8.5). The web app's exports call `print-job` and compose
on the device whenever it can, falling back to `maps.pdf`
(`course-print.md` §8.6, G16); `maps.pdf` stays for API callers and
devices that cannot. The legacy layout editor's map preview,
`GET /api/maps/:nameId/window.png`, went in E4a and the editor itself
(`MapLayoutEditor`) in E4c (`course-print.md` §10). E-pages removed the
three API shapes that had no caller after it: `mapTemplate.previewLayout`
(`resolveSheet { templateSeq }` reads a template), `courseMap.saveLayout`'s
`templateObjects` option, and `courseMap.list`'s per-row overlay fields
(`controls`, `legs`, `descriptionRows`, `descriptionHeader`,
`labelMode`). `maps.pdf` is composed from
the document in a worker thread, off the event loop (`course-print.md`
§8); a document whose colour stack is not aligned is a 400 with the
reason.
Combined PDF pages are ordered by course, map `sort_order`, then map
`seq`, then variant key; with `classes`, by the classes in the order asked. One of `maps`,
`courses`, `classes`, `setter`, `variants`, `allVariations` (400 otherwise); without a selection, every course's
own sheet and the all-controls sheet — a class's sheets print through
`classes` or `maps` only, a setter sheet through `setter` or `maps`
(`courses` prints `kind = 'course'` rows only; `course-layout.md` §7).

## Where sheets and templates are managed

Since E-pages (user 2026-11-05: templates stop being a separate idea for
the user; 2026-11-07: the coordinator's sketch) there is no Maps or Map
templates page. Their work lives in two places:

**The Courses page** carries the event-wide print overview, one row per
course (its own sheets; class sheets follow their class's override,
`course-layout.md` §6):

1. **Template** — one picker (`course-template-<id>`): the event's
   templates; the **club library** (an optgroup: picking one brings it
   into the event under a free name, `base`, `base (2)`, …, then applies
   it — `mapTemplate.loadFromClub`, then `applyToCourses`); **New template…** (a dialog: paper A3/A4/A5,
   orientation, print scale, margin, the name defaulting to the key's
   name; `mapTemplate.create`, then `applyToCourses`). Beside it the key's
   **auto / extra** badge (`course-template-badge-<id>`, the key in its
   title; `course-layout.md` §5). Without `courses.edit` the name only.
2. **Print** status (`course-print-status-<id>`: *Ready*, the issue count,
   or *No map*) over the course's own sheets.
3. **Edit layout** (`edit-course-map-<seq>`) opens the course's first own
   sheet that has a template (a template-less sheet cannot resolve; the
   picker and badge show that sheet's template) in Layout mode; **the course's PDF** (`export-course-<id>`)
   ensures its first sheet under `courses.edit` (`layout.autoSheets
   { courseId }`) and downloads `maps.pdf?courses=<id>`.
4. The bulk bar's **Template** field applies a pick (the same picker) to
   the selected courses. The export menu adds **All maps** (`autoSheets
   {}` first) and **All controls** (`autoSheets { allControls: true }`
   first) beside IOF XML and PPen; without `courses.edit` they export what
   exists. Search gains `template` and `status` anchors.

**Layout mode** (`course-layout.md` §2) holds the per-sheet and
per-template actions: rename / add / delete a sheet, *Create sheet* for a
course without one, *Create the all-controls sheet* in view All, Export ▾
*This sheet*; a template's name, *New template*, *Delete this template*;
and the **Club templates** section (bring in, delete, save the shown
template to the club library).

**Old links.** `/:nameId/maps[?course=N]` redirects to
`/:nameId/courses[?course=N]`; `/:nameId/map-templates[?template=N]` to
Layout mode (`course-editor?mode=layout[&template=N]`, `retiredPageHref`).
Neither has a tab.

**Which editor opens.** Every *Edit layout* opens the course editor's
Layout mode (`/:nameId/course-editor?[course=<seq>&]mode=layout&sheet=<seq>`
/ `&template=<seq>`, built by `layoutEditorHref` in the editor's own URL
form, `course-editor.md` §1 "URL"): the sheet drawn on the
GL canvas through the composer's page layer, every gesture one write and
one undo entry — [`course-layout.md`](course-layout.md). The legacy
`MapLayoutEditor` (an SVG paper canvas over a `window.png` raster of the
unwarped OCAD window) was unreachable from E3 and deleted in E4c, with the
shared SVG emitters it and the legacy PDF page drew with
(`objects-svg.ts`, `course-overlay-svg.ts`, `description-svg.ts`).

The Maps page's object-named validation messages went with it: the
Courses page shows the issue count, Layout mode's inspector the issues by
code (`template_missing`, `map_scale_missing`, `control_outside_frame`,
`description_outside_page`, `object_outside_page`).

The control-description block is the same sheet the course editor shows on
the map: `resolve-layout.ts` (`@oxygen/shared` `course-maps/`, G13) builds it with the shared `buildDescriptionSheet`
(three-row IOF header — event / classes / course · length · climb — start row,
control rows, special-instruction rows, finish row with the measured
last-control → finish distance) and `print/description.ts`
(`descriptionBlock`) draws it with the IOF rules ([`course-print.md`](course-print.md)
§6.2); Layout mode and print draw the identical block, and
`validateCourseMap` uses the same row/header count (`descriptionBlockSize`)
for the `description_outside_page` check. All-controls maps keep a single
title row over code-sorted control rows.

Rectangles and polygons share a **Fill**: none, solid colour, white-out,
white-out outside (an even-odd ring against the map frame, the ink saver),
or ISOM 709 out-of-bounds purple cross-hatch; out-of-bounds borders default
to the ISOM 709 bounding line (0.4 mm, `OUT_OF_BOUNDS_BORDER_MM`) in the
course purple. Lines, paths and rectangle borders may be dashed
(`dash: "dashed"`). How the course layer draws them is
[`course-layer.md`](course-layer.md) §3.6 (`shared/src/course/objects.ts`).

Appearance dimensions (circle radius, line width, number height) are ISOM
dimensions **at the base map scale** — the defaults match ISOM 2017-2:
Ø 5 mm circles, 0.35 mm lines, and 4.0 mm control numbers (symbol 704).
The default purple is `#a626ff`, the sRGB equivalent of the offset CMYK
35·85·0·0 / PMS Purple from ISOM Appendix 1. Following the norm, the
overprint is enlarged together with the map: every dimension is multiplied
by `mapScale / printScale` — the page transform `T_map` enlarges the map
layer, course included ([`course-print.md`](course-print.md) §4.1) — so a
1:15000 map printed at 1:7500 gets Ø 10 mm circles, 0.7 mm lines and 8 mm
digits. Number
placement and its baseline rule are [`course-layer.md`](course-layer.md)
§3.5. History: the `20260916190000_isom_overprint_defaults` migration
bumped stored templates that still carried the old defaults (`#c026d3`,
3.5 mm) to the norm values, and a data migration snapped legacy 8 mm map
frames to the template's print margin (3 mm by default).

Templates can also be copied to and from the club library. A club template is
a snapshot: changing it later does not mutate templates already copied into
events.

## Validation

The shared validator reports:

- missing base-map scale
- controls outside every map frame for their course
- descriptions or page-anchored objects outside the paper — an object
  by its rotated extent (`courseMapObjectPageExtent`, J4: a rectangle or
  image's box turned about its centre, a text's estimated box about its
  anchor); `courseMapObjectPageBounds` stays the stored, unrotated box
  the editor hit-tests and resizes (`rotatedRectBounds` in `geometry.ts`)
- missing template (added by the API list resolver)

Course objects are not layout objects and are not checked: they follow
the terrain and are clipped to the map frame when printed, so moving the
window until they fall off-page is by design. The Courses page's Print
column shows a course's status (Ready / issue count / No map) over its own
sheets; Layout mode's inspector lists the shown sheet's or template's
issues.

## Base-map changes and club templates

Course objects are stored in OCAD paper millimetres — the same space as
`course_maps.window_center` and (scaled to metres) the event's controls. A
revision of the same map project keeps everything aligned. Replacing the
base map with a differently georeferenced file shifts them exactly as much
as every control and course; the course setter re-aligns as usual.

A club library template holds page-anchored layout only (logos, titles,
description position), so `mapTemplate.loadFromClub` brings it in whole
and answers `{ template }`. Until F12 a template could carry map-anchored
objects, which referenced the source event's map coordinates: the import
stripped them and reported the count, and the F12 migration removed them
from every club payload ([`course-layer.md`](course-layer.md) §3.6).

For several maps on one course, a control is valid when at least one map
contains it.

## Forking contract

Forks are authored on a root course, and the concrete variants are
materialised as child course rows (`courses.parent_course_id` /
`variant_key`, `course-layer.md` §12, since F6) for MeOS/Eventor-compatible
timing. `course_maps.course_id` always references the root. Each map layout
is shared by all variants, while PDF export emits one page per variant with
its own course overlay and description block (F8). `{variant}` is reserved
as a text placeholder.

Since F8 a root's sheet prints once per variant and as the
all-variations page (`course-print.md` §4.6): `maps.pdf?courses=<variant
seq>` prints that key on its root's sheets and `layout.autoSheets` of a
variant is its root's, so no variant gets a sheet of its own. A sheet a
variant was given before F8 is left in place, printed only through
`maps=` (the unfiltered export skips it).
