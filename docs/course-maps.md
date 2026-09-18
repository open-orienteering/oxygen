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

The regular map view warps its tiles into true-north mercator and then
rotates them by `-map_files.north_offset` (the bearing from true north to
the meridian direction). The print pipeline renders raw OCAD **paper
space** — no mercator warp — so the drawn meridian lines only lean by
their *in-paper tilt* (ISOM 601.x lines are often rotated inside the
drawing to fit the sheet; Nackareservatet: 3.3°). Print therefore sets
`MapWindow.rotationDeg = -meridianTiltDeg`, where the tilt comes from
`probeMeridianLines` via `getBaseMapInfo` (computed from the parsed OCAD
and cached; 0 when the file has no meridian cluster). Using
`-north_offset` here would over-rotate by the paper-to-true-north bearing
(see `docs/bugfix-course-map-print-orientation.md`).
`mapToPage` / `pageToMap` rotate about the
map-frame centre when it is non-zero. The server crops the axis-aligned
bounding box of the rotated window and wraps the base map in a `rotate`
transform, both for `window.png` (via the `rot` query parameter) and for
the PDF composer. Control-circle cut angles rotate with the map. Maps
with `north_offset = 0` — the normal case — produce byte-identical output to
before.

## Data model

`MapTemplate` stores:

- A3, A4, A5, or custom paper and portrait/landscape orientation
- print scale
- map frame, control-description placement, and appearance in `settings`
- shared text, line, rectangle, and white-out objects in `objects`

`CourseMap` stores:

- course or all-controls kind
- optional template
- map-window centre
- per-map overrides and objects
- ordering among several maps for one course

Both event-scoped tables use UUIDv7 plus per-event `seq`. Deleting an event
cascades through all maps and templates. Deleting a course cascades through
its maps; deleting a template leaves maps in place with `template_id = NULL`
so the UI can report and repair the invalid assignment.

`graphics` stores uploaded SVG or PNG images (BIGSERIAL id, 2 MB cap,
mime-checked at upload; SVG content is parsed and rejected if it contains
scripts, event handlers or external references). `event_id NULL` marks a
club-library graphic shared across events; event rows cascade on event
delete. An `image` layout object references a graphic by id and renders it
inline in the page SVG — sanitized SVG content directly, PNG as a `data:`
URI — so PDF export needs no extra fetches.

Structured JSON is validated at every tRPC boundary with the Zod schemas in
`@oxygen/shared`.

## Rendering pipeline

```text
map_files.file_data
  -> readOcad
  -> discard objects outside print window + 20 mm
  -> ocadToSvg
  -> nested SVG clipped to map frame
  -> white-outs
  -> course overlay
  -> IOF control descriptions
  -> text / lines / rectangles
  -> rsvg-convert --format=pdf
  -> pdf-lib page merge
```

Course symbols start from norm dimensions in output millimetres: 2.5 mm
control radius and 0.35 mm stroke by default. When a base map is enlarged
for printing, the overprint is enlarged by the same
`baseMapScale / printScale` factor. The IOF symbol
fragments formerly generated in the web package now live in
`packages/shared/src/course-maps/`, with web re-exports for compatibility.

`rsvg-convert` is deliberately the only PDF converter. The implementation
spike found that it kept OCAD patterns vector, rendering a 10,680-object
sprint map in about 0.8 seconds with no PDF image XObjects.
`svg-to-pdfkit` took about 14 seconds and rasterised hundreds of patterns.

OCAD user-space pattern tiles are expanded before PDF composition to work
around librsvg dropping sub-pixel tiles. The expansion repeats clipped copies
without changing the visible pattern period; see
[`bugfix-librsvg-pattern-tile-size.md`](bugfix-librsvg-pattern-tile-size.md).

The API production image therefore installs:

```bash
apt-get install librsvg2-bin fonts-liberation
```

Missing `rsvg-convert` produces a clear server error rather than silently
falling back to lower-quality output.

## API

Event-scoped tRPC routers:

- `mapTemplate` — list, create, update, duplicate, delete, apply to courses,
  save/load/delete club templates
- `courseMap` — list with validation, get, create, update, delete, reorder
- `graphics` — list (event + club), upload (base64), saveToClub, delete

REST:

```text
GET /api/maps/:nameId/window.png
    ?cx=...&cy=...&wMm=...&hMm=...&printScale=7500&dpi=120&rot=-8.5

GET /api/maps/:nameId/maps.pdf
    ?maps=1,2
    ?courses=3,4
    ?allControls=1

GET /api/maps/:nameId/graphics/:id
```

Both require `courses.view`. Preview requests are capped at 4096 pixels per
axis. Combined PDF pages are ordered by course, map `sort_order`, then map
`seq`.

## Maps and Map templates pages

Use **Map templates / Kartmallar** to define reusable output:

1. Search by name, paper, orientation, scale or usage. Create an A3, A4, or
   A5 template, then expand its row to edit orientation, print scale and
   margin.
2. Open **Edit template layout** to place shared text, paths, rectangles,
   white-outs and the control-description block. Select a course in the
   editor header to preview the template without tying it to that course.
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
3. Open **Edit layout** for map-window placement and course-specific objects.
   Shared template objects are visible but locked; follow **Edit template
   layout** to change them.
4. Export one map, every map for a course, the all-controls map, or the whole
   event as PDF.

In either editor, the paper is the canvas. **Align map** drags the terrain
under the map frame — the displayed raster and the course overlay move
together, and the freshly rendered raster swaps in seamlessly afterwards.
Mouse wheel and `−` / `+` zoom only the editor viewport. When zoomed, dragging
empty paper pans around the sheet. The editor canvas uses all available
desktop space rather than imposing a fixed maximum width. The print scale
changes only through its number field. The editor first displays a fast 120 dpi full-page raster and
then replaces it with a cached high-resolution full-page raster. Zooming and
panning only change the SVG viewport, so they do not request or blank the map.

On coarse touch screens outside fullscreen, one finger on empty canvas keeps
normal page scrolling while two fingers pan and pinch-zoom the paper. In
fullscreen, one finger pans the paper. A finger started on an editable object,
corner, vertex, Bezier handle, or description block always manipulates that
target instead of the viewport. Touch hit areas are larger than their visible
handles. Screen points are converted with the SVG's inverse screen matrix, so
letterboxing and zoom do not reduce drag distances.

The header matches the course editor: help popover, undo/redo icons, compact
zoom group, autosave status, fullscreen toggle and close. Layout changes
autosave (~1 s after each commit, flushed on close). There is no Save button.

The editor chrome is a single left column of collapsible glass cards —
**Tools**, **Page**, **Graphics**, **Objects**, **Properties** — matching the
course editor's inventory panels. One component serves both editors; template
mode hides map-only sections. On mobile all cards start collapsed to header
bars so the canvas stays visible. Tapping an object expands Properties, while
dragging an object preserves the card's current open/closed state. The Objects card lists every object of the current scope
with select and delete, and warns when a page-anchored object sits outside
the printable area (map-anchored objects are clipped to the map frame at
print, so falling outside is allowed). When editing a map whose *template*
has objects outside the printable area, the Objects card shows an amber
notice with a link to the template editor, since those objects are locked in
map scope. The Graphics card uploads SVG/PNG files, lists event and club
graphics, saves an event graphic to the club library, and arms click-to-place
for image objects. Image resize is free by default; **Ctrl/Cmd** keeps the
aspect ratio and **Shift** crops the source graphic.

The control-description block previews the real rows of the selected preview
course through the shared `renderDescriptionBlockSvg`, so its printed height
is visible while laying out the page.

Choose an object tool and click its intended page position to create it;
`Escape` cancels an armed tool. Rectangles and polygons share a **Fill**
property: none, solid colour, white-out, or ISOM 709 out-of-bounds purple
cross-hatch (0.2 mm lines / 1.2 mm gap at the base map scale, enlarged by
`overprintScale`). An optional border toggle controls stroke. Paths support
inserting and removing vertices. Alt-drag
a selected vertex to create symmetric cubic Bezier handles. Text supports
sans-serif, serif, condensed and monospace fonts; clicking a variable inserts
it at the current text cursor. Objects can be fixed to paper or anchored to
the map. `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` and `Ctrl/Cmd+Y` control undo/redo.

The canvas is grey, the physical sheet is white, and one dashed red line shows
the printable margin. Object and control-description dragging/resizing is
clamped to the printable area (resize cannot grow out the opposite edge).
New templates use a 3 mm margin by default; changing the template's print
margin also updates its map frame. A data migration snaps legacy 8 mm frames
to the current margin so the map touches the red line like other objects.

Validation issues on the Maps page are translated by code
(`template_missing`, `map_scale_missing`, `control_outside_frame`,
`description_outside_page`, `object_outside_page`) with human labels for
objects rather than UUIDs.

The layout editor and PDF composer use the same course-overlay geometry as the
regular map view: legs are clipped around controls, imported overprint gaps
and control-circle slits are retained, and control numbers avoid symbols and
course lines. Print output uses multiply blending so map detail remains
visible beneath the purple ink.

Appearance dimensions (circle radius, line width, number height) are ISOM
dimensions **at the base map scale** — the defaults match ISOM 2017-2:
Ø 5 mm circles, 0.35 mm lines, and 4.0 mm control numbers (symbol 704:
Arial, non-bold — rendered in Liberation Sans, metrically compatible).
`numberHeightMm` is the printed **digit height**; the renderer divides by
Liberation Sans's cap-height ratio (1409/2048) to get the SVG font-size,
since font-size is the em box, not the glyph height. The default purple is
`#a626ff`, the sRGB equivalent of the offset CMYK 35·85·0·0 / PMS Purple
from ISOM Appendix 1 (the same definition course-setting software uses).

Following the norm, the overprint is enlarged together with the map:
`renderCourseOverlaySvg` multiplies every dimension (including the fixed
start-triangle and finish-circle sizes) by
`overprintScale = mapScale / printScale`, so a 1:15000 map printed at 1:7500
gets Ø 10 mm circles, 0.7 mm lines and 8 mm control digits. The factor is
computed in `resolveMapLayout` and in the editor
(`baseMapScale / printScale`), keeping the on-screen preview and the PDF
identical. The `20260916190000_isom_overprint_defaults` migration bumps
stored templates that still carry the old defaults (`#c026d3`, 3.5 mm) to
the norm values; customised values are left untouched.

Templates can also be copied to and from the club library. A club template is
a snapshot: changing it later does not mutate templates already copied into
events.

The editor intentionally does not embed the regular XYZ tile layer. Screen
tiles are true-north Web Mercator images bilinearly warped from OCAD; print
composition uses the original magnetic-north OCAD paper-millimetre geometry.
No single CSS or SVG transform can map those tiles back to print space without
misaligning overlays. The preview therefore uses the same unwarped OCAD window
as PDF output. Parsed OCAD, windowed SVG and rendered PNG results are cached,
with ETags for repeat requests.

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
