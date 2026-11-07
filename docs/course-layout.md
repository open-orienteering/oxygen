# Course layout

Layout mode of the course editor (`course-editor.md`): the printed sheet
as the view, on the same GL canvas as Course mode. Research: 05 §5.12
(the layout editor on the GL backend), 08 §4.6 (layout model), §5.2–5.4
(anatomy, Layout column, views), §5.5 (tablet); 09 §1 "Layout editor".
What a sheet and a template *are* (rows, overrides, coordinate spaces,
validation, the pages) stays in `course-maps.md`; how a
sheet *prints* stays in `course-print.md`. Slices D7 (§1–§4) and D8
(§5–§7: templates by key, class sheets, Export ▾).

## 1. The page view

### Space

Layout mode does not change the viewer's space: the canvas stays the map's
paper mm (y-up), and the sheet is laid over it through the sheet's frame
and window — page mm (y-down from the paper's top-left) ↔ paper mm by
`mapToPage` / `pageToMap` (`course-maps.md` "Coordinate spaces"), which is
the print's `T_map` (`course-print.md` §4.2). Zoom is magnification: the
viewer's zoom never changes the print scale. Entering a sheet fits the
paper and resets the user bearing, so the page stands upright (the
paper view's rotation is `bearing − tilt`, the window's is `−tilt`);
`F` fits the page again (`viewRequest.bounds`, `map-rendering.md` §5.5).

`lib/editor/layout.ts` is the pure maths: `toView` / `toPage`,
`sheetWindow` (`mapWindowForFrame` with the resolved window's rotation),
`sheetShapes`, `layoutObjectAt`, `objectHandles` / `handleAt`,
`descriptionRect`, `alignedCentre`, `pageDelta`, `gridSnap` (placement on
the grid; drags move in whole millimetres), `pageBounds`.

### What is drawn, and by whom

| Part | Drawn by | As in the PDF |
|---|---|---|
| Base map | static buckets | the map layer's document part |
| Course, course objects, map-anchored layout objects | the dynamic bucket (`courseLayerRequest` with `layout`: the sheet's layout objects first, the template's appearance, `viewOptions { overprintScale, window, textValues }` — what `composePage` passes) | the map layer's course part |
| Page-anchored objects, the description block | the **page part**: `course.pageLayer` (extracted from `composePage`, the same stream) through `T_map⁻¹` into paper mm (`pageStreamInMap`), its colour indices offset past every map colour so it draws after the map — the PDF's page layer after the map layer | the page layer |
| Map clip | the renderer scissors every map colour to the frame (`pageClip`) | the frame clip |
| Paper edge, printable margin (dashed red), frame (purple, solid when selected), grey surround | UI layer (`editor-layout-paper` / `-printable` / `-frame`) | — |
| Images (page and map anchored) | UI layer (`editor-layout-image`, an SVG `<image>` of `/api/maps/<event>/graphics/<id>`) | embedded PNG |

The label mode is the viewer's own rule (sequence numbers for one ordered
course, codes for the all-controls sheet), which agrees with
`resolve-layout.ts` by construction; `resolveSheet`'s `labelMode` is not
passed.

So **the preview is the PDF**: the page objects and the block are the
composer's own stream, symbolised in the worker (`map-rendering.md` §5.2
"Page part"), and the map outside the frame is not drawn.

**What differs on screen** (recorded, decision log D7):

- Images are UI layer: drawn over everything, uncropped (`crop` is
  printed, not previewed).
- The screen-only rules of the GL view (hairline floor, glyph and text
  culling, `map-rendering.md` §5.2) apply; the print-preview toggle of
  05 §5.12 (print profile colours, `minLineWidthMm`) waits for print
  profiles (`course-print.md` Pending).
- The map clip is the frame's screen bounding box: exact while the page
  is upright, which Layout mode keeps; a user rotation tilts the page and
  the clip is then its box.
- Text uses the loaded text atlas: glyphs the atlas lacks are missing on
  screen (`TEXT_GLYPH_NOT_IN_ATLAS`), never in print.

### What the editor reads

`courseMap.resolveSheet` (`courses.view`) wraps `resolve-sheet.ts` through
the row mapping `maps.pdf` uses (`sheetInputForMapRow`, `pdf-page.ts`):

- `{ seq }` → a sheet; `{ templateSeq, courseSeq? }` → a template
  previewed with a course (the window centred on the course, as
  `mapTemplate.previewLayout`). `NOT_FOUND` for an unknown sheet,
  template or course; `PRECONDITION_FAILED` for a sheet without a
  template.
- Returns `scope`, the raw `sheet` (seq, name, kind, course, window
  centre, overrides, objects) and `template` (page settings, objects) the
  editor writes back, the resolved `document` and `window`, `page` (the
  composer's page input: paper, frame, window, objects of both anchors,
  text values, the block), `block` (rows, header, title, also when
  hidden), `appearance`, `overprintScale`, `labelMode`, `windows` (this
  sheet's and the course's other sheets', for validation), `controls`,
  the block's row counts and `mapScale`.

The editor builds the page request from its snapshot and this read
(`pages/editor/layout/model.ts` `layoutRequestOf`): objects of both
scopes, the scale's text value at the snapshot's print scale, the block
where the snapshot puts it.

## 2. Layout mode

Entered by the mode switch (`editor-mode-layout`) or a deep link
(`?mode=layout&sheet=<seq>` / `&template=<seq>`, with `&course=<seq>`; §4).
The reducer keeps the selected course and drops the tool, phantom and
selections of Course mode.

**Scope.**

- *Sheet* (`courseMap.saveLayout`): the course's first own sheet (by
  `sortOrder`, `seq`; a class's sheets are not a course's, §6) unless one
  was opened; in Class view the class's first sheet, else the course's;
  view *All controls* shows the all-controls sheet; a course without a sheet shows "assign a template
  on the Maps page" (`editor-layout-no-sheet`). An opened course sheet
  gives way to the default when the top bar picks another course or view
  *All controls*. A course sheet draws only
  its course (`filterMode: "course"`), as it prints. The top bar's course
  picker switches the sheet; the inspector's picker
  (`editor-layout-sheet-picker`) chooses among the course's sheets.
  Editable: the sheet's objects, the block (visible, cell size,
  position), the print scale override and the window centre; a sheet
  write leaves the template's objects alone (`saveLayout` without
  `templateObjects`, which nothing sends since E4c). The
  template's objects are drawn **locked**, with the link
  `editor-layout-edit-template`.
- *Template* (`mapTemplate.update`): previewed with the top bar's course.
  Editable: paper, orientation, print scale, margin (the frame keeps its
  distance to the margin; the template table instead resets a frame to the
  default for the new margin), appearance (circle, line, number,
  purple), the block's defaults and the template's objects. No align
  (a template stores no window). On a coarse pointer the inspector says
  template editing is optimised for desktop (08 §5.5); window moves on a
  sheet work by touch (the binding's drag).

**Course edits are locked** (08 §5.4): the layout binding is exclusive,
so the course layer's targets are off, and the keys are Layout's own.

**Writes.** One gesture is one whole-snapshot write and one undo entry on
the editor's shared stack, whose undo writes back the snapshot it
replaced (`course-editor.md` §3); numeric fields commit on blur / Enter;
there is no debounce. The save state is the editor's (the top bar's save
indicator, `course-editor.md` §2).

**Version tokens** (D8). `course_maps.version` and `map_templates.version`
are the G1 token for rows that are not journaled: an HLC minted by the
node clock on every write (`reorder` included), as `course_objects` (`course-layer.md` §8.4).
`courseMap.saveLayout` and `mapTemplate.update` take an optional
`baseVersion`; the row is locked (`FOR UPDATE`) and a stale token is tRPC
`CONFLICT` with `VersionConflictData { kind: "sheet" | "template", id
(seq), version, current (the row now), differing: null }`. Layout mode
sends the newest token it has seen (`VersionBook`: the read's, raised by
every write result — `saveLayout` answers `{ ok, version }`) and shows a
conflict as the editor's refresh notice: the read is refetched and the
user redoes the gesture — two whole snapshots are never merged. Without
`baseVersion` a write is last-writer-wins, as the Maps / Map templates
pages still send it (until E-pages folds them into Layout mode).

**Keys** (08 §5.3 Layout column): `V` select, `H` header, `T` text, `D`
description block, `W` white-out, `L` line, `R` rectangle, `P` polygon
(`I` image is armed from the Graphics section; there is no key for
white-out outside, see §3),
`F` fit page, `Tab` / `Shift+Tab` next / previous object, `Delete` the
selected path's focused vertex (§3), else the selected object (or hides
the block), `Enter` closes the polygon being drawn (from three vertices),
`Escape` drops the tool (a polygon being drawn is discarded), then the
selection; `Ctrl+Z` / `Ctrl+Y` undo / redo. The grid toggle
(`editor-snapping`) moves in 1 mm steps; a polygon's vertices are placed
on the 1 mm page grid with it.

**Inspector** (`layout/LayoutInspector.tsx`): the sheet / template section
(`editor-layout-sheet`, `editor-layout-scope` with `data-scope`,
`data-sheet`, `data-template`), the selection's properties
(`editor-layout-selected`: text, size, align, colour; fill mode, line
colour, width; the anchor), the scope's objects (`editor-layout-object-row`)
with the validation issues (`editor-layout-issue`, `validate.ts`'s codes,
computed live from the snapshot), the graphics library
(`editor-layout-graphics`: place, upload).

## 3. Page objects

The rail (`layout/LayoutRail.tsx`, `editor-layout-rail`,
`editor-layout-tool-<key>`) arms a tool; a click places at the page point
and selects the new object; a drag with a tool armed pans. `P` is the
exception: it draws (below).

| Key | Places | With |
|---|---|---|
| `H` | header text `{course}`, 6 mm | `createObjectAt("text")` |
| `T` | text `{course}`, 4 mm | `createObjectAt("text")` |
| `I` | the picked graphic, 30 mm | `createImageObjectAt` |
| `D` | shows the block at the click (selects it when shown) | `constrainDescription` |
| `W` | white-out rectangle, no border | `createObjectAt("rectangle")` |
| `L` / `R` | line, rectangle | `createObjectAt` |
| `P` | a closed polygon, **drawn** vertex by vertex (D16) | the course editor's area flow, then `createObjectAt("path")`'s defaults |

`L`, `R` and `P` are not in 08 §5.2's list: existing templates hold them
and `vector` events would otherwise have lost them against the legacy
editor (decision log D7; that editor was deleted in E4c).

**`P` draws a polygon** (D16) with the course editor's area flow
(`course-editor.md` §6.4: `areaBinding` / `step` in `tools/polygon.ts`,
`AreaKind` `layout_path`, closed, three or more vertices, curves): click
= corner, click-drag = curve vertex (symmetric handles, `Shift` 45°),
`Alt` at the press = smooth vertex, a placed vertex dragged to adjust it,
closed by a click on the first vertex, a double-click or `Enter`; `Esc` or
a right-click discards it. A drag pans no more while `P` is armed (the
tool takes every press, as in Course mode). The flow runs in the
viewer's paper mm over the sheet (`editor-polygon`, `editor-polygon-vertex`,
`editor-polygon-grip`; the paper, frame and images stay drawn under it);
with the grid on a vertex is snapped through the page,
`toView ∘ gridSnap ∘ toPage`. On closing, `pathFromView`
(`lib/editor/layout.ts`) maps it onto the page: each vertex `toPage(v)`,
clamped to the printable area (`clampPagePoint`), each handle
`toPage(v + h) − toPage(v)` — exact for the page ↔ view map, which is
affine (scale, the window's rotation, the y flip), so the drawn curve is
the stored curve. `pathObject` (`layout/model.ts`) stores it as
`{ ...createObjectAt("path"), points, closed: true }` — page-anchored,
black, 0.35 mm, `fillMode: "none"` — in **one** snapshot write
(`saveLayout` / `mapTemplate.update`) and one undo entry; the new path is
selected and `V` is armed again. The fixed trapezoid `P` used to place
is gone. `L`, `R`, `W`, `H`, `T`, `I`, `D` keep click placement. On
touch the flow is the course editor's (taps place corners, no curve
vertices); Layout itself stays off the phone mode switch (`course-editor.md` §10 and Pending, "Layout on a phone").

**No tool for white-out outside** (D14). D7 added an `O` tool that placed
a closed path with `fillMode: "whiteoutInverted"` (white everywhere in
the frame except the shape); 08 §5.2's Layout tool list never had it,
and the course toner saver (`course-editor.md` §6, `A` then `S`) now
does that job for ink saving on a course. The tool is gone from the rail
and the keys; the **fill mode stays** in the inspector's fill select
(`layoutFill_whiteoutInverted`, "White-out outside"), so an object that
has it (legacy templates, earlier D7 sheets) stays editable and a `P`
polygon can still be turned into one, for template-level ink saving on
an all-controls or class sheet. A map-anchored one, like the course toner
saver, covers everything the map layer draws outside its shape — map
text, 709 areas, the course — on the canvas and in the PDF alike: its
white is the map layer's top row (`course-layer.md` §3.6, P1). Rendering, print and the schema are
untouched; no stored object is changed.

With `V`: a click selects an object of the scope, topmost first
(`layoutObjectAt`): text, rectangles and images **by their bounds**;
lines and **paths by their outline** — within the handle tolerance (7 px
in page mm) of the path along its curves (`nearestEdge`), a closed path
included, so a press **inside** a closed path is not on it (D16, the
course editor's area rule, `course-editor.md` §5 / D12): it reaches the
object under it, else selects the frame or pans. A drag moves the object
(`translateMapObject`, kept on the printable area by
`constrainMapObject`); a rectangle's, text's or image's corner handles
and a line object's ends resize (`resizeMapObject` with the printable
clamps; Shift keeps an image's proportions); the block moves by its own
drag. A click on nothing inside the frame selects the frame; elsewhere
it deselects.

**A selected path** (closed or open — `L` lines are open paths) takes
the course editor's geometry gestures (`course-editor.md` §7 "Editing
geometry"; `lib/editor/geometry-gestures.ts`, shared with `V` in Course
mode) in **page mm**: a map-anchored path (legacy templates) is mapped
onto the page and back (`pagePoints` / `nativePoints`, handles as
offsets). It is drawn as its outline along the curves
(`editor-layout-selection`), a handle per vertex (`editor-layout-handle`,
`data-index`, the focused one `data-focused`) and a grip per Bézier
handle (`editor-layout-grip`, `data-which`). Pressing order vertex →
grip → edge:

| Gesture | Edit |
|---|---|
| drag a vertex | moves it, its handles with it; the vertex kept on the printable area; with the grid on the offset goes in whole millimetres |
| click a vertex | focuses it (no write); `Delete` removes it (`deleteVertex`, down to 3 vertices closed, 2 open; at the minimum nothing) |
| `Alt`-drag a vertex | symmetric handles (`Shift`: 45° on the page) |
| drag a grip | the handle moves by the pointer's offset, a mirrored / smooth pair kept; `Alt` held (live) breaks it |
| `Alt`-click a vertex with handles | retracts them |
| double-click on an edge, off the vertices | inserts a vertex there (`insertVertex`; a curve is split so it keeps its shape), focused |
| drag the edge | moves the whole path (`translateMapObject` / `constrainMapObject`, as any object) |

Each drag is one write and one undo entry, previewed live; a click
writes nothing. The focused vertex belongs to the selected path: another
selection, a click elsewhere, or an undo that leaves it out of range
drops it. The pure edits are `lib/editor/geometry-edit.ts`; the legacy
editor's `insertPolygonVertex` is not used.

Not in D7 / D16 (Pending): Shift-click multi-select, the frame's own
resize handles in template scope, edge snapping, rotation.

## 4. Align map and entry points

**Align map** (08 §4.6 "moving the window is align map as today"): select
the frame, then drag inside it. The sheet moves over the fixed map and the
window centre follows the drag in paper mm (`alignedCentre`), whatever the
window's rotation; the drop writes `courseMap.saveLayout` with the new
centre, and undo writes the old one. The stored centre is the record
the legacy editor kept (it moved the terrain under a fixed sheet; the
record is the same). With nothing selected a drag pans.

**Entry points.** The Maps page's *Edit layout* (`edit-course-map-<seq>`,
the all-controls row) and the Map templates page's
(`edit-template-layout-<seq>`) navigate to the editor's Layout mode
(`layoutEditorHref`, `lib/editor/layout-href.ts`) for every event since
E3; it is the only editor of a sheet or a template. The legacy
`MapLayoutEditor` was deleted in E4c, its map preview `window.png` in
E4a (`course-print.md` §10).

**What stays in `course-maps.md`:** the data model (templates, sheets,
overrides), coordinate spaces, validation codes, the Maps and Map
templates pages' tables and club templates.

## 5. Templates by key

Research 08 §4.6: the common case ("every A4 portrait 1:10 000 course
looks the same") is one template, created when first needed; the
uncommon case is an explicit extra template.

**The key.** `map_templates.auto_key` is `<paper>-<orientation>-<scale>`
(`A4-portrait-10000`); custom paper names its size in whole millimetres
(`custom210x297-portrait-4000`), so two custom sizes never share a key
(`templateAutoKey`, `@oxygen/shared/course-maps`). Every template write
derives it (`syncTemplateKey`, `course-maps/auto-sheets.ts`):
`mapTemplate.create`, `update`, `duplicate`, `loadFromClub`.

**Auto and extra.** Of the templates sharing a key one is the **auto**
template (`is_extra = false`), the others are **extra**; the partial
unique index `map_templates_one_auto_per_key` keeps it at one per event
and key. A template that gets a key — created, or moved to another key by
a paper / orientation / scale change — is that key's auto template unless
the key has one (then extra); an unchanged key keeps `is_extra`. A key
left without its auto template (the auto one deleted or moved away)
promotes one of its extras by **decision (3)** (user 2026-10-31): the one
with the most sheets (`course_maps` rows), ties to the oldest
(`created_at`, then `seq`) — `pickAutoTemplate`.

**Migration** (`20261103120000_auto_templates`, 09 §5): every existing
template gets its key, and per key decision (3) marks all but one
`is_extra`. No sheet is moved or deleted and **no template is renamed**:
templates keep their names and the key is shown as a badge (Map templates
page `map-template-key-<seq>`, Maps page `course-template-badge-<course>`,
the Layout inspector).

**Created when needed.** `ensureAutoTemplate` returns a key's auto
template, creating it named after the key (`A4 portrait 1:10000`; a
taken name gets ` (2)`, …). A new one takes its seed's margin and
appearance, and — when the seed has the same paper and orientation (a
class at another scale) — its frame, block and objects too; otherwise the
frame inside the margin and the block top right
(`defaultTemplateSettings`, as the Map templates page creates one).

**Extra templates** are created explicitly: the Layout inspector's
*Create extra template* (`editor-layout-create-extra`) copies the shown
template (`mapTemplate.duplicate`, which makes a copy its key's extra) as
`<name> (extra)` and, in a course sheet, moves the sheet's course to it.
The section (`editor-layout-template-key`) shows the key, the auto /
extra badge (`editor-layout-template-badge`, `data-auto-key`,
`data-extra`) and two lists — **courses in this template** and **other
courses at this scale** (courses whose own sheets use another template of
the same key; `templateCourses`). A course moves between them by drag or
by its row's button (`editor-layout-template-move-<course>`): into the
shown template, or out of it to the key's auto template (from the auto
one, to the key's first extra; `moveOutTarget`). A move is
`mapTemplate.applyToCourses` — the course's own sheets, never a class's —
and one undo entry.

## 6. Sheets and class overrides

**Sheet rows** (`course_maps`, 08 §4.6) gain `section_index` (0; map
exchange writes more in F), `class_id` (a class sheet, below; `ON DELETE
CASCADE`) and `props` (setter maps, F). A course's **own** sheets have
`class_id` NULL.

**`layout.autoSheets { courseId? }`** (`courses.edit`; 08 §6), idempotent,
in one transaction (60 s timeout); without `courseId` every course of the event:

1. *The course's own sheets.* Without one, a first sheet is created on the
   auto template of the key that fits the course; a sheet without a
   template gets that template. The key: the event's busiest template's
   paper, orientation and scale (decision (3)'s rule over all templates) —
   A4 portrait at the map's scale (1:10 000 without a map) when the event
   has none — with the orientation turned when only the other one holds
   the course (`fitOrientation`: the controls' extent at print scale plus
   `COURSE_FIT_MARGIN_MM` = 6 mm on every side inside the printable area —
   the paper less the template's margin, which is a new template's frame;
   neither → the closer). Paper and scale are not changed automatically (a setter
   decides A3 or another scale). The window centre is NULL: centred on the
   course (`centerOfControls`), "the first sheet fits the course with a
   margin" (08 §4.6).
   A concurrent first export of the same key does not fail: the insert
   is `ON CONFLICT DO NOTHING` and the key's auto template is read back.
2. *Class sheets.* Every class of the course with `print_scale` or
   `sheet_template_id` gets sheet rows keyed by `class_id`: one per course
   sheet (name `<sheet> · <class>`; window centre, objects, block and
   sort order copied). Its template is `sheet_template_id`, else the auto
   template of the course template's paper and orientation at the class's
   scale (created from the course template). With both set and the scales
   different, the sheet's `overrides.printScale` is the class's. Existing
   class sheets are re-pointed, not recreated (their own edits stay); a
   class sheet whose class no longer overrides, or runs another course, is
   deleted. Two classes sharing a course and an override each get their
   own rows.

**Class overrides** (`classes.print_scale`, `classes.sheet_template_id`
`ON DELETE SET NULL`; 08 §4.4) are written by `layout.setClassOverride
{ classId, printScale?, sheetTemplateId? }` (`courses.edit`; null clears),
which runs `autoSheets` for the class's course in the same transaction —
not by `class.update` (`manageRace`): they are layout data. They are
cloud-owned and **not journaled**: `class.upserted` leaves both columns
out (`referenceJournal.ts`), since a peer may not hold the template row.
The Layout inspector's *Classes* section (`editor-layout-classes`,
`editor-layout-class-<seq>` with `data-sheets`) edits them per class of
the sheet's course — scale (`…-class-scale-<seq>`, blank = none),
template (`…-class-template-<seq>`, *Auto* = none) — one undo entry each;
*Open* shows the class's sheet. `layout.classOverrides { courseId }`
reads them. The Maps page stays per course: class sheets are left out of
its rows (SLICES "Decided in this split").

**Printing a class** (`rowForClass`, `course-maps/pdf-page.ts`, both
pipelines): the description header and `{classes}` name that class only;
a class without its own sheets prints its course's own sheets with the
override applied — template `sheet_template_id ?? the sheet's`, scale
`print_scale ??` (with an explicit template) the template's. So the
effective scale is `print_scale ?? template.printScale` and the template
`sheet_template_id ?? auto(key at that scale)`.

**Class view** (08 §5.4, `editor-view-class` in the top bar's view group,
the selected course's classes): Course mode with its tools live, the
course drawn through `courseMap.resolveSheet { classSeq }` — the class's
first sheet, else its course's first own sheet as the class prints it
(`classView { classSeq, className, printScale, ownSheet }`) — as Layout
mode draws a sheet: the overprint at the class's scale, the page part,
the map clipped to the frame, the course only. A class opens fitted on
its page. No sheet for the class's course → `editor-class-no-sheet` and
the course as in Course view. Another course, Course or All controls
leaves it. In Layout mode Class view opens the class's sheet.

**The sheet key** in the top bar's course-info popover (`editor-stats-sheet`,
`data-key`, `course-editor.md` §2; 08 §5.2 put it in a status bar, P2 moved it):
`1:<scale> <paper> <orientation>` of the shown sheet, in Layout mode and
Class view, in place of the map scale.

## 7. Export

**Export ▾** in the editor's top bar (`editor-export`; 08 §5.2, phase-1
entries; `lib/editor/export-menu.ts`), each on an existing route:

| Entry | Route | First |
|---|---|---|
| This course (`editor-export-course`) | `maps.pdf?courses=<course>` | `autoSheets { courseId }` |
| This class (`…-class`, Class view only) | `maps.pdf?classes=<class>` | `autoSheets { courseId }` |
| All courses (`…-all`) | `maps.pdf` (every own sheet and the all-controls sheet) | `autoSheets {}` |
| All controls (`…-allControls`) | `maps.pdf?allControls=1` | — (no sheet: the route's "No maps found") |
| IOF XML (`…-iofxml`), Purple Pen (`…-ppen`) | `/api/export/course-data?format=` | — |

So a course without a template exports: its first sheet is made on the
auto template of its key. Without `courses.edit` nothing is created first.
The Maps page's per-course export (`export-course-<course>`) does the
same for a course without a map. Variants, setter maps and description
sheets arrive in F.

**`maps.pdf?classes=<seq,…>`** (`course-maps.md` API): per class, in the
order asked, its class sheets, else its course's own sheets as the class
prints them (§6); exclusive with `maps` / `courses` (400). `?courses=`
and the unfiltered export print the courses' own sheets only; a class
sheet prints through `classes` or `maps`.

## Tests

| Layer | Where | What |
|---|---|---|
| unit (shared) | `packages/shared/src/course/__tests__/page-layer.test.ts` | the page layer is the composer's (stream, colours, transform, images); only page-anchored objects; through `T_map⁻¹` a text sits at `pagePointToMap` of its page position; widths scale by `1 / scaleRatio` |
| unit (shared) | `packages/shared/src/print/__tests__/page.test.ts` | `inverseMapLayerTransform` round-trips (0°, 25°) |
| unit (shared) | `print/__tests__/compose.test.ts`, `write-page.test.ts`; `packages/api/src/render/__tests__/pdf-golden.test.ts` | unchanged after the extraction |
| unit (web) | `packages/web/src/map-gl/__tests__/worker-course.test.ts` | the page part: none without a page; its colours after every map colour, the table repeated; the page white-out at the stack's upper white; a text in paper µm; the frame ring; the block |
| unit (web) | `map-gl/__tests__/engine.test.ts`, `view.test.ts` | the page part uploaded as `P`, drawn after the course part, `pageClip` passed, both released on clear; `scissorOfRing` |
| unit (web) | `lib/__tests__/course-layer-request.test.ts` | `layout`: the page passed through, layout objects before course objects, appearance, overprint, window, text values |
| unit (web) | `lib/editor/__tests__/layout.test.ts` | page-view maths: the window, page ↔ view round trips (rotated), y flip, sheet shapes, page bounds, hit-testing (D16: a closed path by its outline, not inside — an object under it reachable; a curved edge along its curve, not its chord; an open path without a closing edge), handles, the block's rectangle, align, page offset, grid; `pagePoints` / `nativePoints` of a map-anchored path (handles as offsets, rotated); `pathFromView` (handles mapped through the rotated, y-flipped window; a vertex outside clamped) |
| unit (web) | `pages/editor/__tests__/layout-bindings.test.ts`, `layout-model.test.ts`, `lib/editor/__tests__/state.test.ts` | the binding (exclusive, shapes, select / move / snap / resize / locked / align / block / place); the snapshot per scope, geometry, the request, placement per kind; the mode case; the rail's keys have no `O`, the inspector keeps the white-out outside fill mode; D16 `P`: the flow armed over the sheet, a press places a vertex (on the page grid with snapping), the closing click hands one page path (handles mapped, clamped), right-click cancels; `pathObject`'s defaults; a selected path: its outline / handles / grips (focused active), a vertex drag (snapped offset, clamped, one write), Alt-drag handles in page mm, Alt-click retract, a grip drag mirrored and Alt-broken, a click focuses, a double-click inserts and focuses, the edge moves the path, a press inside pans, a map-anchored path edited on the page and stored in paper mm |
| unit (web) | `lib/editor/__tests__/geometry-gestures.test.ts`, `pages/editor/__tests__/bindings.test.ts`, `polygon.test.ts` | D16's extraction: pressing order, a drag in the caller's units, Alt-drag / Alt-click, focus (none for fixed kinds), cancel, insert, the shapes with the caller's ids; `selectBinding`'s cases unchanged; `layout_path` is a closed, curved kind of three |
| integration | `packages/api/src/__tests__/integration/course-maps.test.ts` "resolveSheet" | a sheet (window centre, page, text values, block, template / sheet split, overprint, sibling windows), `saveLayout` without `templateObjects` leaves the template, `PRECONDITION_FAILED` without a template; a template with and without a course; `NOT_FOUND` |
| unit (shared) | `packages/shared/src/__tests__/auto-template.test.ts` | the key (standard, custom paper), the key's name, decision (3) (most sheets, oldest, seq), `fitOrientation` (preferred kept, turned, ratio, the margin, neither fits), `defaultTemplateSettings` |
| unit (web) | `lib/editor/__tests__/export-menu.test.ts`, `template-key.test.ts`, `state.test.ts`, `pages/editor/__tests__/layout-model.test.ts` | Export ▾ entries, routes and what is ensured first; courses in a template / at its key, the move-out target, extra names; Class view in the reducer; the sheet key |
| integration | `packages/api/src/__tests__/integration/auto-templates.test.ts` | the migration's backfill (scoped to one event): keys, decision (3), no sheet moved, no rename; key sync on create / update / duplicate / delete with promotion; `autoSheets` (first sheet, auto template named by key, centred, idempotent; the event's look and a landscape turn; without a course every course); class sheets (scale → auto template at that scale; explicit template + scale → sheet override; cleared → deleted; course change); `classOverrides`; `class.upserted` without the overrides; `resolveSheet { classSeq }` (own sheet, course sheet with the override, `{classes}`); version tokens (`CONFLICT` with the row now, no token = LWW); `maps.pdf?classes=` through the composer (one page per class, `courses` / unfiltered without class sheets, 400s; E3 deleted the legacy variant, whose class-name check read the rsvg SVG) |
| unit (web) | `lib/editor/__tests__/layout-href.test.ts` | E4c: the Maps / Map templates pages' *Edit layout* link — a sheet with its course, a template with and without a preview course, a null course omitted, the event name encoded |
| E2E | `e2e/course-maps.spec.ts` "export a course that has no template yet" | a course without a map exports one A4 page from the Maps page; the auto badge; the route answers `application/pdf`; the template named by key with its key badge |
| E2E | `e2e/course-editor.spec.ts` "Course editor auto templates" | Export ▾ → this course creates the sheet and prints one page; the auto badge and the sheet key; a class scale makes a class sheet; Class view shows `1:15000`; this class exports; Create extra template moves the course, its row moves it back, undo moves it again |
| E2E | `e2e/course-editor.spec.ts` "Course editor layout" "graphics: upload an SVG…" | E3 (ported from `course-maps.spec.ts`'s legacy layout editor): the Graphics section uploads an SVG (`graphics.upload`), its Place button arms the image tool, a click on the page places it (one `saveLayout`, an `image` row in the list and in `courseMap.get`); selected from the list and deleted, gone from both |
| E2E | `e2e/course-editor.spec.ts` "Course editor layout" "P draws a polygon…" | D16: `P`, two clicks, a click-drag and a click, closed on the first vertex → one `saveLayout`; `courseMap.get` has a closed path of 4 points whose dragged vertex has `hOut` down-right on the page and `hIn` opposite; the path selected, `V` armed, 4 handles and 2 grips; a double-click on the top edge → 5 points and a focused handle, `Delete` → 4; `Escape` discards a polygon being drawn (no write, `V` armed), `Enter` closes one of three clicks (one write); the sheet's `maps.pdf?maps=` draws more `c` operators than before |
| E2E | `e2e/course-editor.spec.ts` "Course editor layout" | from the Maps page into Layout mode on the sheet; the sheet shapes; `H` places a header, the inspector makes it a long 10 mm text, and ink appears where the page layer draws it; the frame selected and dragged → `courseMap.get`'s centre moved by the drag; undo restores it; the `maps.pdf?maps=` route answers one A4 page; the template link opens template scope, an orientation change writes `mapTemplate.update`; the Map templates page's *Edit template layout* opens template scope |
| E2E | `e2e/course-editor.spec.ts` "P1: …" "Layout mode: a toner saver hides…" | P1: on a probe course sheet in Layout mode a 709 `oob_area` (`courseObject.create`) shows purple on the canvas (`inkIn`); with a `toner_saver` elsewhere on the map, no purple pixels are left inside the 709 square (638 purple pixels with the ring at upper white) |

## Pending in this chapter

- **Map exchange sections** (`section_index > 0`, auto-created from the
  structure), **setter maps** (`kind = 'setter'`, `props.controlIds`),
  **description sheets** and per-variant export — F (08 §4.6, §5.2).
- **The all-controls sheet's recalculated scale / orientation** (08 §4.6
  "computed to fit everything on A4"): `autoSheets` makes course sheets
  only; the all-controls sheet is made on the Maps page as before.
- **Class sub-rows on the Maps page**: not planned (decided in the split);
  ClassesPage shows no override fields.
- **Print-preview toggle** (05 §5.12): waits for print profiles.
- **Version token from the Maps / Map templates pages** (§2): their
  row writes (`courseMap.update`, `mapTemplate.update`) go without
  `baseVersion` (LWW) until E-pages folds the pages into Layout mode.
- **Canvas editing beyond move / resize and the path gestures**:
  multi-select, frame handles, edge snapping, rotation (§3).
- **Rectangles by outline?** Layout closed paths hit by outline (D16);
  rectangles, text and images still by bounds — flagged for the user
  (feedback 2026-11-04, "Flagged for the morning").
- **GL-drawn images** with their crop (§1).
