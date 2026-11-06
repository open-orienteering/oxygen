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
map per event.

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

`packages/shared/src/course-maps/geometry.ts` owns this math. Page-anchored
objects remain fixed when the map window moves; map-anchored objects move with
terrain and are clipped to the map frame.

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
- shared text, line, rectangle, and white-out objects in `objects`
- `auto_key` (`<paper>-<orientation>-<scale>`) and `is_extra`: the
  template's key and whether another template is that key's auto one
  ([`course-layout.md`](course-layout.md) §5)
- `version`, the concurrency token (`course-layout.md` §2)

`CourseMap` stores:

- course or all-controls kind
- optional template
- map-window centre
- per-map overrides and objects
- ordering among several maps for one course
- `class_id`: set on a class's sheet (a class print override,
  `course-layout.md` §6), NULL on a course's own sheets; `section_index`
  (0 until map exchange) and `props`
- `version`, the concurrency token

`Class` carries the print override: `print_scale` and
`sheet_template_id` (`ON DELETE SET NULL`). Layout data, not journaled.

Both event-scoped tables use UUIDv7 plus per-event `seq`. Deleting an event
cascades through all maps and templates. Deleting a course cascades through
its maps; deleting a template leaves maps in place with `template_id = NULL`
so the UI can report and repair the invalid assignment.

`graphics` stores uploaded SVG or PNG images (BIGSERIAL id, 2 MB cap,
mime-checked at upload; SVG content is parsed and rejected if it contains
scripts, event handlers or external references). `event_id NULL` marks a
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
- `layout` — `autoSheets { courseId? }`, `classOverrides { courseId }`,
  `setClassOverride { classId, printScale?, sheetTemplateId? }`
  (`course-layout.md` §5–§6)
- `courseMap` — list with validation (each row with its `class` and the
  template's key), get, create, update, delete, reorder,
  `saveLayout` (`templateObjects` optional: omitted, the template is not written);
  `resolveSheet` (a sheet, a template previewed with a course, or a class
  as it prints — `{ classSeq }`, Class view — as the composer draws it:
  the read of the new editor's Layout mode, `course-layout.md` §1, §6);
  `saveLayout` takes an optional `baseVersion` and answers the new
  `version`
- `graphics` — list (event + club), upload (base64), saveToClub, delete

REST:

```text
GET /api/maps/:nameId/maps.pdf
    ?maps=1,2
    ?courses=3,4         (the courses' own sheets)
    ?classes=5,6         (per class: its sheets, else its course's as it prints)
    ?allControls=1

GET /api/maps/:nameId/graphics/:id
```

Both require `courses.view`. The legacy layout editor's map preview,
`GET /api/maps/:nameId/window.png`, went in E4a and the editor itself
(`MapLayoutEditor`) in E4c (`course-print.md` §10). Three API shapes
have had no web caller since E4c and stay until E-pages reworks the
routers: `mapTemplate.previewLayout`, `courseMap.saveLayout`'s
`templateObjects` option, and `courseMap.list`'s per-row overlay fields
(`controls`, `legs`, `descriptionRows`, `descriptionHeader`,
`labelMode`) — Layout mode reads `courseMap.resolveSheet` instead.
`maps.pdf` is composed from
the document in a worker thread, off the event loop (`course-print.md`
§8); a document whose colour stack is not aligned is a 400 with the
reason.
Combined PDF pages are ordered by course, map `sort_order`, then map
`seq`; with `classes`, by the classes in the order asked. One of `maps`,
`courses`, `classes` (400 otherwise); without a selection, every course's
own sheet and the all-controls sheet — a class's sheets print through
`classes` or `maps` only (`course-layout.md` §7).

## Maps and Map templates pages

Use **Map templates / Kartmallar** to define reusable output:

1. Search by name, paper, orientation, scale or usage. Create an A3, A4, or
   A5 template, then expand its row to edit orientation, print scale and
   margin.
2. Open **Edit template layout** to place shared text, paths, rectangles,
   white-outs and the control-description block in the course editor's
   Layout mode.
3. Save stable templates to the club library from the row action. **Import
   from club library** opens a modal instead of mixing club and event
   templates in the same table.

Use **Maps / Kartor** for course assignments and per-map changes:

1. Every course has a row, including courses without an assigned map. Search
   by course, class, template, status or number of maps. Choose a template
   inline, or select several course rows and apply one from the bulk action
   bar.
2. Expand a row to rename, validate, export or delete individual maps and add
   a second sheet for a map exchange.
3. Open **Edit layout** for map-window placement and course-specific objects
   in the course editor's Layout mode. Shared template objects are visible
   but locked; open the template to change them.
4. Export one map, every map for a course, the all-controls map, or the whole
   event as PDF.

**Which editor opens.** **Edit layout** (also on the all-controls row) and
**Edit template layout** open the course editor's Layout mode for every
event (`/:nameId/course-editor?mode=layout&sheet=<seq>[&course=<seq>]` /
`&template=<seq>`, built by `layoutEditorHref`): the sheet drawn on the
GL canvas through the composer's page layer, every gesture one write and
one undo entry — [`course-layout.md`](course-layout.md). The pages hold
no editor of their own: the legacy `MapLayoutEditor` (an SVG paper
canvas over a `window.png` raster of the unwarped OCAD window) was
unreachable from E3 and deleted in E4c, with the shared SVG emitters it
and the legacy PDF page drew with (`objects-svg.ts`,
`course-overlay-svg.ts`, `description-svg.ts`). Until E-pages folds the
pages into Layout mode and the Courses page, they stay as lists: create,
rename, delete, validate and export sheets and templates, assign a
template inline or in bulk, and the club library.

Validation issues on the Maps page are translated by code
(`template_missing`, `map_scale_missing`, `control_outside_frame`,
`description_outside_page`, `object_outside_page`) with human labels for
objects rather than UUIDs.

The control-description block is the same sheet the course editor shows on
the map: `resolve-layout.ts` builds it with the shared `buildDescriptionSheet`
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
by `overprintScale = mapScale / printScale` (computed in
`resolveMapLayout`, passed to `courseLayer()`), so a 1:15000 map printed at
1:7500 gets Ø 10 mm circles, 0.7 mm lines and 8 mm digits. Number
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
- descriptions or page-anchored objects outside the paper
- missing template (added by the API list resolver)

Map-anchored objects are exempt from the printable-area check: they follow
the terrain and are clipped to the map frame when printed, so moving the
window until they fall off-page is by design. The Map templates page shows a
status pill per template (Ready / issue count) computed from the template's
own page-anchored objects, mirroring the Maps page status column.

## Base-map changes and club templates

Map-anchored objects are stored in OCAD paper millimetres — the same space as
`course_maps.window_center` and (scaled to metres) the event's controls. A
revision of the same map project keeps everything aligned. Replacing the
base map with a differently georeferenced file shifts map-anchored objects
exactly as much as every control and course; the course setter re-aligns as
usual.

Club library templates are the exception: map-anchored objects reference the
source event's map coordinates. `mapTemplate.loadFromClub` therefore strips
map-anchored objects on import and reports how many were removed. Page-
anchored layout (logos, titles, description position) is kept. Saving *to*
the club library still stores every object so re-import into the same event
loses only the map-anchored ones.

For several maps on one course, a control is valid when at least one map
contains it.

## Future forking contract

Forks will be authored on a root course, while concrete variants are
materialised as child course rows for MeOS/Eventor-compatible timing.
`course_maps.course_id` always references the root. Each map layout is shared
by all variants, while PDF export emits one page per variant with its own
course overlay and description block. `{variant}` is already reserved as a
text placeholder.
