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
`objectRing` / `objectPivot` / `ringShapes` (a turned text, rectangle or
image as drawn, J9),
`descriptionRect`, `alignedCentre`, `pageDelta`, `gridSnap` (placement on
the grid; drags move in whole millimetres), `pageBounds`.

### What is drawn, and by whom

| Part | Drawn by | As in the PDF |
|---|---|---|
| Base map | static buckets | the map layer's document part |
| Course, course objects | the dynamic bucket (`courseLayerRequest` with `layout`: the course objects in view, the template's appearance, `viewOptions { window, textValues }` — what `composePage` passes; a former map-anchored layout object is a course object since F12, `course-layer.md` §3.6) | the map layer's course part |
| Layout objects (all page-anchored), the description block | the **page part**: `course.pageLayer` (extracted from `composePage`, the same stream) through `T_map⁻¹` into paper mm (`pageStreamInMap`), its colour indices offset past every map colour so it draws after the map — the PDF's page layer after the map layer | the page layer |
| Map clip | the renderer scissors every map colour to the frame (`pageClip`) | the frame clip |
| Paper edge, printable margin (dashed red), frame (purple, solid when selected), grey surround | UI layer (`editor-layout-paper` / `-printable` / `-frame`) | — |
| Images (page objects and `image` course objects) | the page part and the dynamic bucket: image passes in `page:graphics` / `course:graphics` (J6, `map-rendering.md` §5.2 "Images"), crop, rotation, flips, opacity and Multiply as printed | embedded PNG |

The label mode is the viewer's own rule (sequence numbers for one ordered
course, codes for the all-controls sheet), which agrees with
`resolve-layout.ts` by construction; `resolveSheet`'s `labelMode` is not
passed.

So **the preview is the PDF**: the page objects and the block are the
composer's own stream, symbolised in the worker (`map-rendering.md` §5.2
"Page part"), and the map outside the frame is not drawn.

**What differs on screen** (recorded, decision log D7):

- Images (J6, superseding D7's UI-layer images): a texture at most 2048 px
  on its longer side (a larger graphic is softer than its print when
  zoomed in deep), an SVG rasterised at its placed size on the map
  (smaller than it prints for a map-layer image on an enlarged sheet),
  and an outline while it loads.
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

`courseMap.resolveSheet` (`courses.view`) wraps `resolveSheet` through
the row mapping `maps.pdf` uses (`sheetInputForMapRow`; both in
`@oxygen/shared`, `course-maps/{resolve-sheet,sheet-rows}.ts` since G13):

- `{ seq }` → a sheet; `{ templateSeq, courseSeq? }` → a template
  previewed with a course (the window centred on the course, as
  `mapTemplate.previewLayout`). `NOT_FOUND` for an unknown sheet,
  template or course; `PRECONDITION_FAILED` for a sheet without a
  template.
- `{ seq | classSeq, variantKey? }` (F8; 08 §6's `layout.resolveSheet
  { …, variantKey? }`, taken as the existing procedure's key): a root's
  sheet as that variant prints it (`rowForVariant`, `course-print.md`
  §4.6) — its course, numbering, block and `{variant}`, on the window
  the variants share; `variantKey` in the answer (null otherwise). A key
  the sheet's course has no live variant of — any other sheet, or a key
  the editor's structure has before its write lands — reads the sheet
  as is, on the same shared window (decided on the user's standing instruction 2026-11-07, for
  review: no error while the editor is ahead of the server).
- Returns `scope`, the raw `sheet` (seq, name, kind, course, class,
  `sectionIndex` — the part it prints, F5 —, window centre, overrides,
  objects) and `template` (page settings, objects) the
  editor writes back, the resolved `document` and `window`, `page` (the
  composer's page input: paper, frame, window, the layout objects,
  text values, the block), `block` (rows, header, title, also when
  hidden), `appearance`, `labelMode`, `windows` (this
  sheet's and the course's other sheets', for validation), `controls`,
  the block's row counts and `mapScale`.

`courseMap.list` validates a root's sheet per variant (F8): every
variant's placed sites against the course's windows, an outside control
named by its key (`CourseMapValidationIssue.variantKey`), and a NULL
centre resolves to the shared one (`sharedWindowCentre`).

The editor builds the page request from its snapshot and this read
(`pages/editor/layout/model.ts` `layoutRequestOf`): objects of both
scopes, the scale's text value at the snapshot's print scale, the block
where the snapshot puts it, and a course sheet's part (`section`, from
`sheet.sectionIndex`; `course-layer.md` §11) — so Layout mode and Class
view draw a part sheet's part as it prints. `courseMap.list` items carry
`sectionIndex` too, and their `resolved.window` is the part's.

## 2. Layout mode

Entered by the mode switch (`editor-mode-layout`) or a deep link
(`?course=<seq>&mode=layout&sheet=<seq>` / `&template=<seq>`; §4), and
its URL keeps `mode=layout` with the shown sheet or template while it is
open (`course-editor.md` §1 "URL").
The reducer keeps the selected course and drops the tool, phantom and
selections of Course mode.

**Scope.**

- *Sheet* (`courseMap.saveLayout`): the course's first own sheet (by
  `sortOrder`, `seq`; a class's sheets are not a course's, §6) unless one
  was opened; in Class view the class's first sheet, else the course's;
  view *All controls* shows the all-controls sheet. Without a sheet
  (`editor-layout-no-sheet`) the inspector offers *Create sheet*
  (`editor-layout-create-sheet`, `layout.autoSheets { courseId }`, which
  also gives a template-less sheet its template, §6), and in view *All
  controls* *Create the all-controls sheet*
  (`editor-layout-create-all-controls`, `autoSheets { allControls: true }`;
  it opens). An opened course sheet
  gives way to the default when the top bar picks another course or view
  *All controls*. A course sheet draws only
  its course (`filterMode: "course"`), as it prints. The top bar's course
  picker switches the sheet; the inspector's picker
  (`editor-layout-sheet-picker`) chooses among the course's sheets.
  Editable: the sheet's objects, the block (visible, cell size,
  position), the print scale override and the window centre; a sheet
  write never touches the template (`saveLayout` writes the sheet only).
  The template's objects are drawn **locked**, with the link
  `editor-layout-edit-template`. The sheet's actions
  (`editor-layout-sheet-actions`, `courses.edit`; E-pages, the Maps
  page's): its **name** (`editor-layout-sheet-name`, `courseMap.update
  { id, name, baseVersion }`, one undo entry); **Add a sheet**
  (`editor-layout-add-sheet`, a course's own sheet only: `courseMap.create`
  on the same template, named `<course> 2`, `<course> 3`, … —
  `nextSheetName` — and opened); **Delete this sheet**
  (`editor-layout-delete-sheet`, confirmed; back to the default sheet). A
  class sheet has the name only (it follows its class's override, §6).
  **Recalculate** (`editor-layout-recalculate`, F10) on the all-controls
  sheet and a setter sheet refits it (`layout.recalculateSheet`, §6, §8).
  Create, delete and recalculate are not undo entries, as the editor's
  course create (`course-editor.md` §3). A setter sheet (F10, §8) opens
  from the *Setter maps* section and stays open when the top bar picks
  another course or view; the inspector's picker lists its scope's
  setter sheets.
- *Template* (`mapTemplate.update`): previewed with the top bar's course.
  Editable: the name (`editor-layout-template-name`, in the snapshot:
  written with the rest, one undo entry), paper, orientation, print scale,
  margin (the frame keeps its distance to the margin), appearance (circle,
  line, number, purple), the block's defaults and the template's objects.
  **New template** (`editor-layout-new-template`: paper A3/A4/A5,
  orientation, scale, margin, the name defaulting to the key's —
  `NewTemplateForm`; `mapTemplate.create`, then it opens) and **Delete this
  template** (`editor-layout-delete-template`, confirmed; its sheets keep
  their layout without a template — `ON DELETE SET NULL` — and the view
  returns to the course's sheet, which is then the no-sheet state) are not
  undo entries. No align
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
`courseMap.saveLayout`, `courseMap.update` (E-pages: the sheet's name)
and `mapTemplate.update` take an optional `baseVersion`; the row is locked (`FOR UPDATE`) and a stale token is tRPC
`CONFLICT` with `VersionConflictData { kind: "sheet" | "template", id
(seq), version, current (the row now), differing: null }`. Layout mode
sends the newest token it has seen (`VersionBook`: the read's, raised by
every write result — `saveLayout` answers `{ ok, version }`) and shows a
conflict as the editor's refresh notice: the read is refetched and the
user redoes the gesture — two whole snapshots are never merged. Without
`baseVersion` a write is last-writer-wins; every Layout write sends one
(the Courses page's `applyToCourses` and the class overrides are not
token-guarded row writes). Layout mode's book is the editor's own (`EditorWrites`,
`course-editor.md` §3 "Tokens"), and its sheet and template writes go one
per row in flight (`writeRow`, CRS-053): a second gesture inside one round
trip — a scale field committed by a canvas click, then a block drag —
waits for the first and sends its token, instead of the token both read
before. Each gesture is sent on the end of this client's own chain from
the token its snapshot was built on, so a gesture built on one that was
refused is refused too rather than sent on the newer token the refusal
brought (which would overwrite the other setter's change).
`recalculateSheet` queues with them. An undo or redo of a sheet or
template follows D6 (`course-editor.md` §3 "Undo after another editor's
change"): it goes through only while the sheet (or the template, for a
template gesture) is as this client left it, else it is skipped with the
notice.

**Keys** (08 §5.3 Layout column): `V` select, `H` header, `T` text, `D`
description block, `W` white-out, `L` line, `R` rectangle, `P` polygon
`I` image (opens the graphics picker beside the rail, J8; a click on
the page before a graphic is picked places nothing; there is no key for
white-out outside, see §3),
`F` fit page, `Tab` / `Shift+Tab` next / previous object, `Delete` the
selected path's focused vertex (§3), else the selected object (or hides
the block), `Enter` closes the polygon being drawn (from three vertices),
`Escape` first cancels a mouse drag in flight — a move, resize, align
map, vertex, rotate or crop drag ends with nothing written and its
preview dropped (the viewer's rule, `course-editor.md` §3, F24; user
2026-11-11) — then leaves crop mode (J9), then drops the tool (a polygon being drawn is discarded), then the
selection; `Ctrl+Z` / `Ctrl+Y` undo / redo; `Ctrl+D` duplicates the
selected object 3 mm right and down on the page with a new id, `Ctrl+C` /
`Ctrl+X` copy / cut it, `Ctrl+V` pastes the clipboard's page object with
its bounds' centre on the pointer (else the view's centre), kept on the
printable area and selected (J12; `duplicatePageObject`,
`pastePageObject`, one `saveLayout` and one undo entry each; with `V`,
for a setter who may edit). The clipboard is the editor's
(`course-editor.md` §7 "Duplicate, copy, cut, paste"): a course object
does not paste here (*The clipboard holds a course object: paste it in Course mode.*), nor an image
whose graphic is neither the event's nor the club's. The grid toggle
(`editor-snapping`) moves in 1 mm steps; a polygon's vertices are placed
on the 1 mm page grid with it.

**Inspector** (`layout/LayoutInspector.tsx`): the sheet / template section
(`editor-layout-sheet`, `editor-layout-scope` with `data-scope`,
`data-sheet`, `data-template`), the selection's properties
(`editor-layout-selected`: text, size, align, colour; fill mode, line
colour, width), the scope's objects (`editor-layout-object-row`)
with the validation issues (`editor-layout-issue`, `validate.ts`'s codes,
computed live from the snapshot), the selection's style fields
(`editor-layout-style-*`, J8, §3 "Style fields"); the graphics library
is the `I` picker beside the rail (`editor-layout-graphics`, with the
hint `editor-layout-image-hint`; J8 moved it there from J2's inspector
section; the `GraphicPicker`, J2: the event's graphics,
then the club library's, as tiles `editor-layout-graphic-tile` with a
`thumb.png` thumbnail, name, pixel size and bytes; the thumbnail is the
Place button `editor-layout-graphic-place-<id>`; *Save to club*
`…-save-club-<id>` on an event graphic; *Delete* `…-delete-<id>`, a
second click confirming; upload `…-upload`, PNG or SVG up to 16 MiB each,
checked before the file is read; several files can be picked at once
(J20): they upload one after another, the button counts them
(*Uploading 2 of 5…*), and a file that fails is named in the error
while the rest still upload); then the template's key (§5),
the classes (§6) and **Club templates** (`editor-layout-club`, collapsed;
E-pages): the club library's rows (`editor-layout-club-row-<id>`) with
*Bring in* (`…-club-import-<id>`: `mapTemplate.loadFromClub` under a free
name, `base (2)`, …; it opens; the template loads whole — every layout
object is page-anchored since F12, `course-maps.md` "Base-map changes
and club templates") and delete (`…-club-delete-<id>`, confirmed), and *Save this
template to the club library* (`editor-layout-save-to-club`, a name
prompt). The library is shared between events: none of these is an undo
entry.

## 3. Page objects

Layout mode creates and edits **page-anchored objects only**: since F12
(`course-layer.md` §3.6) the layout schema's anchor is the literal
`"page"`, there is no anchor to choose or show, and what was anchored to
the map is a course object — drawn in Layout mode with the course,
edited in Course mode (`course-editor.md` §7).

The rail (`layout/LayoutRail.tsx`, `editor-layout-rail`,
`editor-layout-tool-<key>`) arms a tool; a click places at the page point
and selects the new object; a drag with a tool armed pans. `P` is the
exception: it draws (below).

| Key | Places | With |
|---|---|---|
| `H` | header text `{course}`, 6 mm | `createObjectAt("text")` |
| `T` | text `{course}`, 4 mm | `createObjectAt("text")` |
| `I` | the picked graphic at its aspect, 30 mm on the longer side (a square when its pixel size is unknown), fitted and clamped to the printable area (J8) | `createImageObjectAt` |
| `D` | shows the block at the click (selects it when shown) | `constrainDescription` |
| `W` | white-out rectangle, no border | `createObjectAt("rectangle")` |
| `L` / `R` | line, rectangle | `createObjectAt` |
| `P` | a closed polygon, **drawn** vertex by vertex (D16) | the course editor's area flow, then `createObjectAt("path")`'s defaults |

`L`, `R` and `P` are not in 08 §5.2's list: existing templates hold them
and `vector` events would otherwise have lost them against the legacy
editor (decision log D7; that editor was deleted in E4c).

**`P` draws a polygon** (D16) with the course editor's area flow
(`course-editor.md` §6.4: `areaBinding` / `step` in `tools/polygon.ts`,
`AreaKind` `layout_path`, closed, three or more vertices, curves) and its
convention, **smooth by default, Alt for sharp** (F18): a click places a
smooth vertex (handles from its neighbours, `smoothHandles`, wrapped at
the close), `Alt` at the press a corner, click-drag pulls symmetric
handles by hand (`Shift` 45°), a placed vertex dragged to adjust it,
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
touch the flow is the course editor's (taps place smooth vertices, no
corners or pulled handles); Layout itself stays off the phone mode switch (`course-editor.md` §10 and Pending, "Layout on a phone").

**No tool for white-out outside** (D14). D7 added an `O` tool that placed
a closed path with `fillMode: "whiteoutInverted"` (white everywhere in
the frame except the shape); 08 §5.2's Layout tool list never had it,
and the course toner saver (`course-editor.md` §6, `A` then `S`) now
does that job for ink saving on a course. The tool is gone from the rail
and the keys; the **fill mode stays** in the inspector's fill select
(`layoutFill_whiteoutInverted`, "White-out outside"), so an object that
has it (legacy templates, earlier D7 sheets) stays editable and a `P`
polygon can still be turned into one, for template-level ink saving on
an all-controls or class sheet. A map-anchored one became a course
`toner_saver` in F12 (`course-layer.md` §3.6): like a toner saver drawn
in Course mode it covers everything the map layer draws outside its
shape — map text, 709 areas, the course — on the canvas and in the PDF
alike, its white the map layer's top row (P1). A white-out outside of
any size — a page-anchored shape or a toner saver — may cross the frame
from any side or lie beyond it: it hides only what is outside its shape,
on the canvas as in the PDF (P7, `docs/bugfixes/whiteout-layout.md`). A
plain white-out is a single ring and was never affected.

With `V`: a click selects an object of the scope, topmost first
(`layoutObjectAt`): text, rectangles and images **by their bounds**;
lines and **paths by their outline** — within the handle tolerance (7 px
in page mm) of the path along its curves (`nearestEdge`), a closed path
included, so a press **inside** a closed path is not on it (D16, the
course editor's area rule, `course-editor.md` §5 / D12): it reaches the
object under it, else selects the frame or pans. Text, rectangles and
images are hit by their box **as drawn**, turned (J9). A drag moves the
object (`translateMapObject`, kept on the printable area as drawn by
`constrainMapObjectExtent`: a turned box by its turned extent); a line
object's ends and a text's corners resize (`resizeMapObject` with the
printable clamps; a turned text's drag is taken into its own frame and,
as a turned box's, not clamped), a rectangle's or image's corners resize as
"Transform handles" below; the block moves by its own drag. A click on nothing inside the frame selects the frame; elsewhere
it deselects.

**Style fields** (J8; `layout/model.ts` `styleShowOf`, `styleChangeOf`):
the inspector reuses Course mode's style fields (`StyleFields`,
`course-editor.md` §7 "Inspector") under the ids `editor-layout-style-*`.
Every page object has opacity and, unless it is a white-out, blend
(Normal / Multiply); text, rectangles and images add rotation (text
about its anchor, a box about its centre); an image adds flips, width /
height with the aspect lock, the crop and *Cut out graphics below* (J15,
`knockout`: the image cuts the page images below it, course-layer.md
§3.6 "Knockout images"); a rectangle adds width and height without the
lock. Page objects are page
mm, y down, so the fields edit them through a y-negating adapter
(`styleGeometryOf`, `rectOfStyleGeometry`) and the same pure rules as
Course mode (`lib/editor/style-fields.ts`: a default value removes its
key, a size is typed about the centre, a crop moves the box so the
visible pixels stay put). Each commit replaces the whole object: one
`saveLayout`, one undo entry. A typed size is at most the printable
area (an image is scaled down whole, keeping its ratio); a commit that
changes the box or the rotation is then moved back onto the printable
area by its drawn extent (`constrainMapObjectExtent`, the turned box as
validation reads it), so at the margin the page wins over the crop's
"pixels stay put"; opacity, blend and flips move nothing. Turning a fill to white-out (or white-out outside) drops a blend
(`fillModePatch`). The aspect lock is Layout's own (on by default), not
shared with Course mode's.

**Transform handles** (J9; Course mode uses the same module in paper mm since J11, `course-editor.md` §7 "Transform handles"; `lib/editor/transform-gestures.ts`, the
shared module Course mode's images use too, `course-editor.md` §7; mouse
only — Layout's binding is exclusive, so a finger never reaches them,
user answer 5). A selected text, rectangle or image is outlined by its
turned box (`editor-layout-selection`) with a handle on each drawn corner
(`editor-layout-handle`) and a **rotate knob** (`editor-layout-rotate`)
24 screen px above its top edge, on the box's own up. The knob's drag
sets `rotationDeg` from the pointer's turn about the pivot (a box's
centre, a text's anchor, user answer 6) since the press, so it never
jumps; Shift snaps to 15°; 0° removes the key; the result is kept on the
printable area by its drawn extent, as the rotation field. A rectangle's
or image's corner resizes in the box's own frame with the opposite drawn
corner fixed (`resizeBox`, 2 mm a side at least): an image keeps its
ratio while the aspect lock is on (the default) and a rectangle while
Shift is held — Shift inverts the lock, read live during the drag. An
unturned box stays on the printable area with its opposite corner fixed
(a locked one scaled back whole, keeping its ratio) and an unlocked
corner on the 1 mm grid as before (a locked corner is on the diagonal,
not the grid); a turned box's resize is not clamped — validation lists a
corner off the page (`object_outside_page`). Lines and paths get no knob
(user answer 4): see "Rotate and flip a line or path".

**Crop mode** (J9): a double-click on the selected image, or the
inspector's *Crop by its edges* (J11: renamed from *Crop on the page*, the label is shared with Course mode) (`editor-layout-style-crop-mode`, not
shown on a coarse pointer), shows the whole graphic's outline dashed
(`editor-layout-crop-full`) and a handle on the middle of each edge
(`editor-layout-crop-edge`, `data-edge`); the corners and the knob are
hidden and the body still moves the image. An edge drag moves the crop
side under that edge — a flip mirrors which source side that is — while
the opposite side stays, and the box follows so the visible pixels keep
their scale and place on the page (`cropEdge` through `cropChange`:
whole per cent, inside the graphic, at least 1 % and 1 mm a side). One
write and one undo entry per drag; *Reset crop* stays a field. Escape,
*Done cropping*, another selection or a tool leave crop mode, which is
page state and not an undo step.

**Rotate and flip a line or path** (J9): lines and paths store no angle,
so the inspector's buttons (`pages/editor/TransformButtons.tsx`, ids
`editor-layout-transform-*`) bake the change into the vertices and their
Bézier handles about the centre of the path's bounds
(`transformPathOf`): *Turn* by the angle field (`…-angle`, 15° by
default, clockwise as seen), *Turn 90°*, *Flip ↔* and *Flip ↕*; the
result is kept on the printable area by `constrainMapObjectExtent` (one
larger than the area is pinned at its top-left). One write each; a whole
turn writes nothing.

**A selected path** (closed or open — `L` lines are open paths) takes
the course editor's geometry gestures (`course-editor.md` §7 "Editing
geometry"; `lib/editor/geometry-gestures.ts`, shared with `V` in Course
mode) in **page mm**, the space it is stored in (every layout object is
page-anchored since F12). It is drawn as its outline along the curves
(`editor-layout-selection`), a handle per vertex (`editor-layout-handle`,
`data-index`, the focused one `data-focused`) and a grip per Bézier
handle (`editor-layout-grip`, `data-which`). Pressing order vertex →
grip → edge:

| Gesture | Edit |
|---|---|
| drag a vertex | moves it, its handles with it; the vertex kept on the printable area; with the grid on the offset goes in whole millimetres |
| click a vertex | focuses it (no write); `Delete` removes it (`deleteVertex`, down to 3 vertices closed, 2 open; at the minimum nothing) |
| drag a vertex with `Alt` held | moves it like a plain drag, snapped and clamped the same (F18: no handles pulled) |
| drag a grip | the handle moves by the pointer's offset, a mirrored / smooth pair kept; `Alt` held (live) breaks it |
| `Alt`-click a vertex | switches it corner / smooth (`toggleSmooth`: handles retracted, or smooth handles from its neighbours in page mm); an open path's end corner: nothing |
| double-click on an edge, off the vertices | inserts a **smooth** vertex there (`insertAtEdge`: on a straight edge collinear `smoothHandles`, on a curve the split that keeps its shape), focused; with `Alt` a corner |
| drag the edge | moves the whole path (`translateMapObject` / `constrainMapObject`, as any object) |

Each drag is one write and one undo entry, previewed live; a click
writes nothing. The focused vertex belongs to the selected path: another
selection, a click elsewhere, or an undo that leaves it out of range
drops it. The pure edits are `lib/editor/geometry-edit.ts`; the legacy
editor's `insertPolygonVertex` is not used.

Not in D7 / D16 (Pending): Shift-click multi-select, the frame's own
resize handles in template scope, edge snapping.

## 4. Align map and entry points

**Align map** (08 §4.6 "moving the window is align map as today"): select
the frame, then drag inside it. The sheet moves over the fixed map and the
window centre follows the drag in paper mm (`alignedCentre`), whatever the
window's rotation; the drop writes `courseMap.saveLayout` with the new
centre, and undo writes the old one. The stored centre is the record
the legacy editor kept (it moved the terrain under a fixed sheet; the
record is the same). With nothing selected a drag pans.

**Entry points.** The Courses page's *Edit layout*
(`edit-course-map-<seq>`, the course's first own sheet that has a
template, as Layout's default) navigates to the
editor's Layout mode (`layoutEditorHref`, `lib/editor/layout-href.ts`);
the all-controls sheet is view *All controls* in Layout mode; a template
is reached from a sheet's template link, by *New template* or *Bring in*.
Layout mode is the only editor of a sheet or a template. The retired
Maps and Map templates pages redirect (`/maps` → the Courses page,
`/map-templates[?template=]` → Layout mode; `retiredPageHref`, E-pages).
Layout's shown sheet or template is in the editor's URL (`sheet=` /
`template=` beside `mode=layout`, F31, `course-editor.md` §1 "URL"), so a
reload reopens it; a sheet or template that is not the event's gives way
to Layout's default and leaves the URL.
The legacy `MapLayoutEditor` was deleted in E4c, its map preview
`window.png` in E4a (`course-print.md` §10).

**What stays in `course-maps.md`:** the data model (templates, sheets,
overrides), coordinate spaces, validation codes, the Courses page's print
overview ("Where sheets and templates are managed") and club templates.

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
templates keep their names and the key is shown as a badge (the Courses
page's `course-template-badge-<course>`, the Layout inspector's
`editor-layout-template-badge`).

**Created when needed.** `ensureAutoTemplate` returns a key's auto
template, creating it named after the key (`A4 portrait 1:10000`; a
taken name gets ` (2)`, …). A new one takes its seed's margin and
appearance, and — when the seed has the same paper and orientation (a
class at another scale) — its frame, block and objects too; otherwise the
frame inside the margin and the block top right
(`defaultTemplateSettings`).

**Extra templates** are created explicitly. *New template* (§2, and
"New template…" in the Courses page's picker) makes its key's auto
template unless the key has one, then an extra — the key rule above. The Layout inspector's
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

**Sheet rows** (`course_maps`, 08 §4.6) gain `section_index` (the part
of a course split by map exchanges the sheet prints, `course-layer.md`
§11; 0 for every sheet of a one-part course), `class_id` (a class sheet, below; `ON DELETE
CASCADE`) and `props` (a setter sheet's group, §8). A course's **own** sheets have
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
   **Part sheets** (F5; 08 §4.6 "auto-created from the structure"): a
   course split by map exchanges (`course-layer.md` §11; the parts are
   its placed exchange sites plus one, `partCountOf` over the course
   mirror) has one own sheet per part. A part without an own sheet of its
   `section_index` gets one on the course's template — the parts share
   it, fitted on the whole course; only the window differs — named
   `<course> · part n` (part 1 the course's name; the server writes no
   localised name, as *All controls*), window centre NULL (centred on
   the part's controls, `course-print.md` §5.2), `sort_order` after the
   course's other sheets. A part sheet the setter deleted comes back on
   the next `autoSheets` (Export ▾ runs it), never by itself. A sheet of
   a part that no longer exists (the exchange removed) is **kept**: no
   automation deletes a layout the setter may have edited, and it prints
   the whole course (its `section` is out of range) until the setter
   deletes it. *Add a sheet* (E-pages) and `courseMap.create` write
   `section_index` 0. (Decided on the user's standing instruction
   2026-11-07, for review.)
2. *Class sheets.* Every class of the course with `print_scale` or
   `sheet_template_id` gets sheet rows keyed by `class_id`: one per course
   sheet (name `<sheet> · <class>`; window centre, objects, block, sort
   order and `section_index` copied) when the class has none; when it
   has some, one per course sheet of a part the class has no sheet of
   (F5: a new exchange gives every overriding class its part sheet). Its template is `sheet_template_id`, else the auto
   template of the course template's paper and orientation at the class's
   scale (created from the course template). With both set and the scales
   different, the sheet's `overrides.printScale` is the class's. Existing
   class sheets are re-pointed, not recreated (their own edits stay); a
   class sheet whose class no longer overrides, or runs another course, is
   deleted. Two classes sharing a course and an override each get their
   own rows.

**The all-controls sheet** (`autoSheets { allControls: true }`; E-pages):
the event's one `kind = 'all_controls'` sheet (named *All controls*,
window centre NULL — centred on the controls), created on demand on the
auto template of the key that fits every placed control of the event:
step 1's rule — the busiest template's paper, orientation and scale,
`fitOrientation` turning it when only the other orientation holds them. A
sheet without a template gets that template; an existing one is answered
(`allControlsSheet`). With `courseId` too both parts run; `{}` leaves it
alone. **Recalculate** (F10, `layout.recalculateSheet { sheet }`; 08 §4.6
"can be recalculated; moved items stay fixed until recalculated") refits
it to every placed control of the event, keeping its paper: the auto
template of the orientation and standard scale `fitScale` picks (§8,
its current orientation preferred, its template seeding the look), the
window centre back to NULL, `overrides.printScale` dropped (a Layout
save writes one) and the block's position back to the template's
(`overrides.description` keeps `visible` and the cell size, loses `x` /
`y`). A placement of the block that avoids the controls is not computed
(Pending). It is
a setter view (F4, `course-layer.md` §10.3): it draws every crossing
point and the map-issue points (702), on screen in Layout mode and in
print; a course or class sheet draws only the crossing points its legs
run through.

**Class overrides** (`classes.print_scale`, `classes.sheet_template_id`
`ON DELETE SET NULL`; 08 §4.4) are written by `layout.setClassOverride
{ classId, printScale?, sheetTemplateId? }` (`courses.edit`; null clears),
which runs `autoSheets` for the class's course in the same transaction —
not by `class.update` (`manageRace`): they are layout data. They are
cloud-owned and **not journaled**: `class.upserted` leaves both columns
out (`referenceJournal.ts`), since a peer may not hold the template row.
A venue checkout carries them with the class rows and the templates
(G18, `map-storage.md` §7.2; NULL when the exporter sent no templates),
and `layout.` writes on a box are forwarded to the cloud.
The Layout inspector's *Classes* section (`editor-layout-classes`,
`editor-layout-class-<seq>` with `data-sheets`) edits them per class of
the sheet's course — scale (`…-class-scale-<seq>`, blank = none),
template (`…-class-template-<seq>`, *Auto* = none) — one undo entry each;
*Open* shows the class's sheet. `layout.classOverrides { courseId }`
reads them. The Courses page's print overview stays per course: class
sheets are left out of its template and status columns (SLICES "Decided
in this split").

**Printing a class** (`rowForClass`, `@oxygen/shared` `course-maps/sheet-rows.ts`, both
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
leaves it. In Layout mode Class view opens the class's sheet. A class on
a root (F8) is drawn as one variant (`resolveSheet { classSeq,
variantKey }`): Variant ▾ picks it, the first key by default
(`course-editor.md` §12).

**The sheet key** in the top bar's course-info popover (`editor-stats-sheet`,
`data-key`, `course-editor.md` §2; 08 §5.2 put it in a status bar, P2 moved it):
`1:<scale> <paper> <orientation>` of the shown sheet, in Layout mode and
Class view. The map's own scale is not in the popover since P6: it is the
map-info dialog's (`course-editor.md` §2); the phone's peek line shows it
when no sheet is shown.

## 7. Export

**Export ▾** in the editor's top bar (`editor-export`; 08 §5.2, phase-1
entries; `lib/editor/export-menu.ts`), each on an existing route:

| Entry | Route | First |
|---|---|---|
| This sheet (`editor-export-sheet`, Layout mode on a sheet; E-pages) | `maps.pdf?maps=<sheet>` | — (the sheet exists) |
| This course (`editor-export-course`) | `maps.pdf?courses=<course>` — a root's sheets once per variant (F8; label *This course (n variants)*) | `autoSheets { courseId }` |
| This variant (`…-variant`; F8, a root only) | `maps.pdf?variants=<root>:<key>` — the view's variant (Variant view's, or the one Class view / Layout mode draw); label *This variant AB · 12* with its assigned runners (`course.variantList.runnerCount`); disabled without a shown key | `autoSheets { courseId: root }` |
| All variations (`…-allVariations`; F8, a root only) | `maps.pdf?allVariations=<root>` — each own sheet once, every alternative in the one purple, for officials (answer 4) | `autoSheets { courseId: root }` |
| One map per runner (`…-courseRunners`; F8, a root only) | `maps.pdf?courses=<root>&copies=runners` — each variant page once per assigned runner, in key order; label with the runners in all; disabled with none | `autoSheets { courseId: root }` |
| This class (`…-class`, Class view only) | `maps.pdf?classes=<class>` | `autoSheets { courseId }` |
| All courses (`…-all`) | `maps.pdf` (every own sheet and the all-controls sheet) | `autoSheets {}` |
| All controls (`…-allControls`) | `maps.pdf?allControls=1` | `autoSheets { allControls: true }` (E-pages) |
| Setter maps (`…-setter`; F10) | `maps.pdf?setter=1` (every setter sheet of the event, §8) | — (generating needs a group count: Layout mode's *Setter maps*; none → the route's "No setter maps found" on the error line; controls in no setter map → its 400 naming them, §8 "Controls added after generation") |
| Make maps available offline (`…-offline`; G17) | no download: stores every map export of the event on this device (`course-print.md` §8.6 "Offline"); the button shows the progress | `autoSheets {}` and `{ allControls: true }` |
| Description sheets… (`…-descriptions`; F11) | opens the dialog (`editor-descriptions-dialog`), then `descriptions.pdf?classes=<seq,…>&copies=&cell=` (`course-print.md` §6.4) | — (no sheet row) |
| IOF XML (`…-iofxml`), Purple Pen (`…-ppen`) | `/api/export/course-data?format=` | — |

So a course without a template exports: its first sheet is made on the
auto template of its key; so does an event without an all-controls sheet.
Without `courses.edit` nothing is created first (no all-controls sheet:
the route's "No maps found" on the error line). The Courses page's
per-course export (`export-course-<course>`) and its export menu's *All
maps* / *All controls* do the same (`course-maps.md` "Where sheets and
templates are managed"); a variant's row has `export-variant-<seq>`
(`?variants=<root>:<key>`) and a root's row `export-all-variations-<root>`
(F8), each ensuring the root's sheets. This sheet is a phase-1 entry 08
§5.2 does not list: the Maps page's *Selected map*, kept so a second
sheet prints alone; on a root's sheet it prints every variant too.

**Where the PDF is made** (G16; `course-print.md` §8.6): every `maps.pdf`
entry above — and the Courses page's exports — goes through
`downloadMapsPdf` (`lib/download-api.ts`; Export ▾ through
`downloadExport`, which recognises a `maps.pdf` URL): after `autoSheets`,
the browser asks `GET /api/maps/:nameId/print-job` with the entry's query
and composes the PDF itself when the device can, else downloads
`maps.pdf`. Selection, order, caps, file name and the error line are the
route's either way (a job error is `maps.pdf`'s message). Description
sheets, IOF XML and Purple Pen are always the server's.

**Offline** (G17; `course-print.md` §8.6 "Offline"): *Make maps available
offline* — here, in the Courses page's export menu
(`course-export-offline`) and in the sync panel — stores the event's
print jobs, their graphics, the faces and the document on the device;
opening Layout mode refreshes them silently (at most every 30 min, no
sheet created). With no network a map entry composes from the stored
job: the `autoSheets` step is skipped, the PDF downloads, and the notice
under Export ▾ (`editor-export-notice`; on the Courses page
`course-maps-notice`) says *Printed offline from the maps stored on
{{time}}*. An export that was not stored says so (*not stored on this
device*) on the error line.

**`maps.pdf`'s selection** (`selectPrintPages`, `course-print.md` §4.6,
§8): one of `maps=<seq,…>`, `courses=<seq,…>` (a variant's seq prints
that key on its root's sheets), `classes=<seq,…>`, `setter=1`,
`variants=<root>:<key,…>` (one root, its live keys; printed in key
order), `allVariations=<root>`; `allControls=1` beside the unfiltered or
alone. `copies=runners` (only that value) with `courses`, `classes` or
`variants`, and `spare=<0–500>` with it. A root's own sheet never prints
as the root. The unfiltered export skips a sheet a variant was given of
its own before F8 (it prints on its root's). 08 §5.2's "variants… · loops
composite" became the four entries above; a loop prints as its variants,
no separate composite (decided on the user's standing instruction
2026-11-07, for review). `autoSheets` of a variant is its root's (it
creates no sheet for a variant); *All courses* ensures roots and plain
courses only; a root's first window is fitted over every alternative's
sites (08 §4.6 "fits the course").

**Description sheets…** (F11; 08 §4.6, §5.2 "descriptions") opens a dialog
(`pages/editor/DescriptionSheetsDialog.tsx`) instead of downloading at
once: classes (`editor-descriptions-class-<seq>`, every class with a
course checked; *All* / *None*), copies (`-copies-count` runners +
vacancies, `-copies-fill` one full sheet, `-copies-n` with a number
1–500), cell size (`-cell`, 5 / 6 / 7 mm, default 6) → *Download PDF*
(`-download`; disabled with no class or an invalid number), which
downloads `descriptionSheetsUrl(…)` — always explicit `classes=`, in class
order — and closes; a route error shows on the dialog's error line
(`-error`). It is a modal like the map-info dialog: no keydown reaches
the editor's shortcuts while it is open, Escape closes only it. The
Courses page's export menu has the same entry
(`course-export-descriptions`) opening the same dialog. Nothing is
created first: the sheets print on demand (`course-print.md` §6.4).

**`maps.pdf?classes=<seq,…>`** (`course-maps.md` API): per class, in the
order asked, its class sheets, else its course's own sheets as the class
prints them (§6); exclusive with `maps` / `courses` / `setter` (400). `?courses=`
and the unfiltered export print the courses' own sheets only (the
unfiltered one also the all-controls sheet); a class
sheet prints through `classes` or `maps`, a setter sheet through
`setter` or `maps` (F10). A course split by map
exchanges prints one page per part (its part sheets in `sort_order`,
F5); *This course* creates the missing part sheets first.

## 8. Setter maps

F10 (08 §4.6 "Setter maps", §5.5, §6 `layout.setterMaps`). A setter map
is the page a control setter takes out: the controls of one area, at a
scale that holds them on A4. There is no Setter view in the top bar
(slice F split, since P2 / P6): a setter map is a **sheet** (Layout mode
shows it as any sheet) and a **Field-mode pick** (`course-editor.md` §9).
Unless stated, what follows was decided on the user's standing
instruction (2026-11-07), for review (README decision log, "F10").

**Rows.** `course_maps.kind = 'setter'` (migration
`20261108150000_course_maps_setter_kind`), `course_id` NULL for the
event's setter maps or the course's for a course's, `class_id` NULL,
`section_index` 0, `props` = `setterSheetPropsSchema` `{ setter: n,
controlIds: [controls.id …] }` (`course-maps/schema.ts`), `overrides =
{ description: { cellSizeMm: 5 } }` (`SETTER_DESCRIPTION_CELL_MM`, 08
"5 mm description cells"), window centre NULL. Written by
`layout.setterMaps` (the groups) and, for a control added afterwards,
`layout.adoptToSetters` (below) only: `courseMap.create` takes no `setter`
kind.

**`layout.setterMaps { courseId?, groups }`** (`courses.edit`, one
transaction, 60 s): `groups` 1 … 20 (`MAX_SETTER_GROUPS`) and at most the
scope's placed sites (else `BAD_REQUEST`; no placed site →
`PRECONDITION_FAILED`; an unknown course → `NOT_FOUND`).

1. *The scope's sites* (`setterScopeSites`), placed ones only: without
   `courseId` every site of the event; with it the course's start,
   controls and finish (the one sequence rule, `layoutCourseEnds`) and the
   crossing points its legs run through — and in both scopes the event's
   map-issue points (702 belongs to no course; it is what a setter fixes on
   the way).
2. *The groups* (`groupSites`, `packages/shared/src/course-maps/setter-groups.ts`):
   k-means on paper coordinates (map mm), deterministic — the sites in
   `seq` order, seeds by farthest-first traversal from the lowest-seq site
   (ties: lower seq), Lloyd iterations (≤ 100; a site tied between two
   centroids stays; an emptied group takes the site farthest from its
   centroid among groups of two or more), groups numbered west → east by
   centroid x (then north first), each group's sites in `seq` order. The
   same input always gives the same groups and numbers.
3. *The sheets*: the scope's setter rows are **deleted** and one row per
   group is written — *Regenerate* replaces them (their own edits are
   lost; the UI confirms). Each is on the A4 auto template of the key
   fitted to its group (`fitScale` below; the event's busiest template's
   orientation preferred and its margin and look seeded,
   `ensureAutoTemplate`), named `Setter n` (the event's) or
   `<course> · Setter n` (English, as *All controls*), `sort_order` after
   the scope's other sheets.

The answer: `{ sheets: [{ seq, setter, controls: [public control id …] }],
createdTemplates }`.

**The fit** (`fitScale`, `course-maps/auto-template.ts`; 08 §4.6 "compute
scale, orientation … to fit everything on A4"): of
`STANDARD_PRINT_SCALES` = 1:4 000, 5 000, 7 500, 10 000, 15 000, largest
map first, the first scale at which one orientation (the preferred
first) holds the sites' extent at print scale plus `COURSE_FIT_MARGIN_MM`
= 6 mm on every side inside the printable area (§6's `fitOrientation`
rule at each scale); none → 1:15 000 in the orientation that comes
closer. The map's scale is the base map's (1:10 000 without one). The
busiest template (§6, decision (3)) no longer counts setter sheets, and a
template only setter sheets use is never it: their fitted keys are not
the event's look.

**What a setter sheet draws** (`sheetInputForMapRow` → `setterSheetInput`,
`@oxygen/shared` `course-maps/sheet-rows.ts`; `course-print.md` §5.2): the all-controls
branch of `resolveMapLayout` (`kind === "setter"` joins it: no layer
change) over the group's sites only — every site by its kind (702 for a
map-issue point, 710 for a crossing point, start, finish), labels by code,
`viewOptions { allControls: true, setterMarks: true }`, no course
structure (a course's setter map draws no legs), the `all`-scoped course
objects; the description block lists the group's control rows in code
order, no IOF header, titled with the row's name, at 5 mm. `courseMap.list`
and `courseMap.resolveSheet` answer `setter { index, controls, unassigned }` (public
control ids in the block's code order; `unassigned` below; null for other kinds), and a
setter sheet is validated against its own window only (its controls are
its group's: no sibling windows).

**Move to next setter** (`layout.moveToSetter { controlId, sheet }`; 08
"a manual 'move to next setter' click"): the control (public id) leaves
the setter sheet of `sheet`'s scope that holds it and joins `sheet`; both
rows get a new version and their windows stay (08 "moved items stay fixed
until recalculated"); the same sheet is a no-op, a control in none of the
scope's setter maps `BAD_REQUEST`, a sheet that is not a setter's
`NOT_FOUND`. The client picks *next* (`nextSetterSheet`,
`lib/editor/setter-maps.ts`): the following sheet in setter order, the
last one's next the first. One undo entry (undo moves it back to its
sheet); the versions it answers are seeded for both rows.

**Controls added after generation** (a removed course's setter maps report nothing; CRS-002, review D5: no silent
auto-assign). `layout.setterMaps` writes the groups once; a control
created or added to a course afterwards is in none of them and would print
on no setter map. A scope with setter maps whose sites
(`setterScopeSites`) are not all in a group is **flagged**, never fixed on
its own:

- `courseMap.list` and `resolveSheet` answer `setter.unassigned` (public
  control ids, ascending; the same on every sheet of the scope), and
  `list` adds the validation issue `setter_unassigned` to each setter row
  of the scope (`valid: false`). A scope without setter maps reports
  nothing.
- `maps.pdf?setter=1` and `print-job?setter=1` answer **400** `N controls
  are in no setter map: 87, 91. Add them in Layout mode (Setter maps).`
  Printing by `maps=` seqs is not blocked (Pending).
- `layout.adoptToSetters { courseId? }` (`courses.edit`; same lock as
  `moveToSetter`) adds each such site to the scope's setter map whose
  group centroid (the mean of its placed members) is nearest
  (`nearestGroupIndex`, `setter-groups.ts`; a tie goes to the lower setter
  number, an empty group is skipped unless all are empty), bumps the
  changed rows' versions and answers `{ sheets: [{ seq, version, added }] }`.
  The windows stay until *Recalculate*, as for *Move to next setter*.
- Layout mode's *Setter maps* section shows the warning
  (`editor-layout-setter-unassigned`, `data-count`: the count and codes)
  and, with edit rights, **Add to nearest setter map**
  (`editor-layout-setter-adopt`; not an undo entry, like Generate);
  Field mode shows the same line, read-only
  (`editor-field-setter-unassigned`), when a setter map with unassigned
  controls is picked.

**Recalculate** a setter sheet (`layout.recalculateSheet`, §6): refitted
to its group as the all-controls sheet is to every control — template,
window centre NULL, no scale override, the block on the template's spot.

**Layout mode's *Setter maps* section** (`editor-layout-setter`,
`pages/editor/layout/SetterSection.tsx`, after *Classes*, shown with or
without a sheet): the scope (`editor-layout-setter-scope`: every placed
control of the event in view *All controls* or without a course, else
the top bar's course — `setterScopeOf`), the number of setters
(`editor-layout-setter-groups`, default the scope's count or 2),
*Generate* / *Regenerate* (`editor-layout-setter-generate`, a confirm
when it replaces; the first new sheet opens; not an undo entry), the
scope's sheets (`editor-layout-setter-row`, `data-setter`, `data-sheet`:
"Setter n · k controls", a click opens it); with a setter sheet open its
controls in code order (`editor-layout-setter-control`,
`data-control-id`) each with **Move to next setter**
(`editor-layout-setter-move`; disabled with one sheet). On the canvas
Layout mode draws the view's controls over a setter sheet (the editor's
own layer request, F7's files); print, the block and the lists are the
group's (Pending).

**Export ▾ → Setter maps** (§7, `maps.pdf?setter=1`): every setter sheet
of the event, course seq (the event's last), sort order, seq.

## Tests

| Layer | Where | What |
|---|---|---|
| unit (shared) | `packages/shared/src/course/__tests__/page-layer.test.ts` | §1 "What is drawn, and by whom": the page layer |
| unit (shared) | `packages/shared/src/print/__tests__/page.test.ts` | `inverseMapLayerTransform` round-trips (0°, 25°) |
| unit (shared) | `print/__tests__/compose.test.ts`, `write-page.test.ts`; `packages/api/src/render/__tests__/pdf-golden.test.ts` | unchanged after the extraction |
| unit (web) | `packages/web/src/map-gl/__tests__/worker-course.test.ts` | the page part: none without a page; its colours after every map colour, the table repeated; the page white-out at the stack's upper white; a text in paper µm; the frame ring; the block; P7: a page-anchored white-out outside crossing the frame's left edge covers the frame outside its shape and not its inside |
| unit (web) | `map-gl/__tests__/engine.test.ts`, `view.test.ts` | the page part uploaded as `P`, drawn after the course part, `pageClip` passed, both released on clear; `scissorOfRing` |
| unit (web) | `lib/__tests__/course-layer-request.test.ts` | `layout`: the page passed through, the course objects only (F12), appearance, window, text values |
| unit (web) | `lib/editor/__tests__/layout.test.ts` | page-view maths: the window, page ↔ view round trips (rotated), y flip, sheet shapes, page bounds, hit-testing (D16: a closed path by its outline, not inside — an object under it reachable; a curved edge along its curve, not its chord; an open path without a closing edge), handles, the block's rectangle, align, page offset, grid; `pathFromView` (handles mapped through the rotated, y-flipped window; a vertex outside clamped) |
| unit (web) | `pages/editor/__tests__/layout-bindings.test.ts`, `layout-model.test.ts`, `lib/editor/__tests__/state.test.ts` | §3: the D16 `P` flow and page-object gestures |
| unit (web) | `lib/editor/__tests__/geometry-gestures.test.ts`, `pages/editor/__tests__/bindings.test.ts`, `polygon.test.ts` | D16's extraction: pressing order, a drag in the caller's units, Alt-drag moves and Alt-click toggles (F18), focus (none for fixed kinds), cancel, insert (smooth, Alt a corner, a filter region a corner; on a curve the split, Alt retracting the new vertex), the shapes with the caller's ids; `selectBinding`'s cases unchanged; `layout_path` is a closed, curved kind of three |
| integration | `packages/api/src/__tests__/integration/course-maps.test.ts` "resolveSheet" | a sheet (window centre, page, text values, block, template / sheet split, overprint, sibling windows), `saveLayout` never writes the template, `PRECONDITION_FAILED` without a template; a template with and without a course (alone: the window is the frame centred on the map origin, the text values — `previewLayout`'s former case); `NOT_FOUND` |
| integration | `course-maps.test.ts` "update: CONFLICT on a stale baseVersion…", "creates, duplicates and applies…", "supports several maps…" | §6: sheet updates, tokens and `CONFLICT`, duplicate and apply (E-pages) |
| unit (shared) | `packages/shared/src/__tests__/auto-template.test.ts` | §5, §6: the key, decision (3), `fitOrientation`, `defaultTemplateSettings` |
| unit (web) | `lib/editor/__tests__/export-menu.test.ts`, `template-key.test.ts`, `state.test.ts`, `pages/editor/__tests__/layout-model.test.ts` | Export ▾ entries, routes and what is ensured first; courses in a template / at its key, the move-out target, extra names; Class view in the reducer; the sheet key |
| unit (web) | `lib/editor/__tests__/export-menu.test.ts` "description sheets…", "descriptionSheetsUrl" | F11: the entry opens the dialog, ensures nothing and is never disabled; the URL names the classes, copies mode and cell (and `gap` when given) |
| E2E | `e2e/course-editor-layout.spec.ts` "F11: description sheets", `e2e/courses.spec.ts` "Export → Description sheets…" | the dialog from Export ▾ and from the Courses page's menu → `…_descriptions.pdf` with one A4 page per class (`course-print.md` §9.1) |
| integration | `packages/api/src/__tests__/integration/auto-templates.test.ts` | §6 (`autoSheets`, key sync, class sheets, tokens), §7 `maps.pdf?classes=`; the migration backfill |
| integration | `auto-templates.test.ts` "the all-controls sheet on demand" | §6, §7: the all-controls sheet on demand (E-pages) |
| unit (web) | `lib/editor/__tests__/layout-href.test.ts` | §2, §7: the editor URL for a sheet and the retired page links |
| unit (web) | `lib/editor/__tests__/export-menu.test.ts`, `pages/editor/__tests__/layout-model.test.ts`, `src/__tests__/new-template-form.test.ts`, `lib/__tests__/template-picker.test.ts`, `lib/__tests__/shell-tabs.test.ts`, `lib/structured-search/__tests__/new-anchors.test.ts` | §2, §6, §7: the Export menu, the layout model, the new-template form |
| E2E | `e2e/course-maps.spec.ts` "the Courses page and Layout mode (E-pages)" | §2, §6, §7: the Courses page and Layout mode (E-pages) |
| E2E | `e2e/course-maps.spec.ts` "export a course that has no template yet" | §7; `course-print.md` §8.6 (G16): device compose = `maps.pdf`, `deviceMemory` fallback |
| unit (web) | `print/__tests__/imports.test.ts` "mapsPdfTarget", `print/__tests__/client.test.ts` | §7 "Where the PDF is made", `course-print.md` §9.1 (G16) |
| E2E | `e2e/course-maps.spec.ts` "the retired Maps and Map templates pages redirect…" | E-pages: `/maps?course=1` → `/courses?course=1`, `/map-templates` → Layout mode; neither tab is shown |
| E2E | `e2e/course-editor-layout.spec.ts` "Course editor auto templates" | §5, §6, §7: auto templates, class sheets, export |
| E2E | `e2e/course-editor-layout.spec.ts` "Course editor layout" "graphics: upload an SVG…" | E3 (ported from `course-maps.spec.ts`'s legacy layout editor): the graphics picker uploads an SVG (`graphics.upload`), its Place button arms the image tool, a click on the page places it (one `saveLayout`, an `image` row in the list and in `courseMap.get`); selected from the list and deleted, gone from both; J2: the tile's thumbnail loads at 256 px and shows "4096 × 4096 px", *Save to club* adds a club tile, a confirmed delete removes each; J8: the picker opens from `editor-layout-tool-I` |
| E2E | `e2e/course-editor-layout.spec.ts` "J20: several files picked at once…" | J20: three files picked at once, the middle one a `.txt`: both SVGs get tiles and are listed by `graphics.list`, the error names the `.txt` file only |
| unit (web) | `lib/__tests__/graphics-picker.test.ts` "uploads several files in order…" | J20: `uploadEach` sends in order, reports progress, collects named failures and keeps going |
| Unit | `lib/__tests__/map-layout-editor.test.ts`, `pages/editor/__tests__/layout-model.test.ts`, `layout-bindings.test.ts` | J8: `createImageObjectAt` at the graphic's aspect; a white-out fill drops blend; `styleShowOf` per kind; the y-down adapter round trip; `styleChangeOf` as a whole-object write (a removed key stays removed), a box kept on the page, a rotation kept on the page by its turned box, opacity moving nothing, a typed size capped to the printable area; a crop of a rotated, flipped (and already cropped) page image keeping a source pixel in place through `course.imageCorners`; the lock XOR Shift on an image's corner |
| Unit / E2E | `pages/editor/__tests__/layout-model.test.ts`; `e2e/course-editor-layout.spec.ts` (style fields) | J15: `styleShowOf` gives `knockout` on images only; duplicate and paste keep it; in the browser the page image's checkbox saves `knockout: true`, a white-out has none |
| E2E | `e2e/course-editor-layout.spec.ts` "J8: style fields on page objects…" | J8: `I` without a graphic places nothing; an image placed from the picker at its aspect, drawn in its colour; opacity 0 shows the page and 100 removes the key; Multiply and Normal; rotation; width with the lock and one undo; flip H; a crop to the left half and one undo restoring box and crop (each one `saveLayout`); a white-out without blend or lock, its width alone; a text's rotation |
| Unit | `lib/editor/__tests__/transform-gestures.test.ts`, `lib/editor/__tests__/layout.test.ts`, `pages/editor/__tests__/layout-bindings.test.ts`, `layout-model.test.ts` | J9: `boxRing` as `imageRing` and about a pivot; the knob above the top edge, turned; `resizeBox` keeping the opposite corner at 0° and 30°, the lock, the minimum; `rotationAt` (a quarter turn is +90, no jump at the press, 15° steps, normalised); `cropEdge` moving one side and keeping the pixels in place through `course.imageCorners` at 0°, 30°, flipped; its stops; `rotateVertices` / `flipVertices` with handles; a turned rectangle hit as drawn, handles on its turned corners, a text turned about its anchor; the binding's knob drag (90°, Shift steps, a cancel writes nothing), a turned image's corner keeping its opposite with Shift live, a rectangle's ratio only with Shift, crop mode by double-click with edges only and one write; a locked unturned corner kept on the page with its ratio; a move of a turned box kept on the page as drawn without a jump; a turned text's corner taken into its frame; `cropEdge` on top, bottom and left under both flips on a cropped, turned image; `transformPathOf` on a curved path, a flip, the legacy line, kept on the page, boxes refused |
| E2E | `e2e/course-editor-layout.spec.ts` "J9: transform handles on page objects…" | J9: the knob dragged a quarter turn (one `saveLayout`, undo), Shift in 15° steps, Escape mid-drag writes nothing; a double-click shows four crop edges and hides the knob, the right edge dragged a quarter in crops and shrinks the box in one write, undo restores box and crop, Escape leaves crop mode with the image selected; another selection leaves crop mode for good (reselected, corners and no edges); an `L` line's *Turn 90°* and *Flip ↔* each one write |
| Unit / E2E | `pages/editor/__tests__/layout-model.test.ts` (J12), `e2e/course-editor-layout.spec.ts` "J12: Ctrl+D duplicates a page object…" | J12: `duplicatePageObject` 3 mm right and down with a new id, kept on the page; `pastePageObject` centred on the point and kept on the page; in the browser `Ctrl+D` (one `saveLayout`, the copy at +3, +3), `Ctrl+C` and `Ctrl+V` at the pointer (centred there), `Ctrl+X`, a course object's entry refused on the error line with nothing written |
| E2E | `e2e/course-editor-layout.spec.ts` "Course editor layout" "P draws a polygon…" | D16, F18: `P`, two Alt-clicks (corners), a click-drag and a plain click, closed on the first vertex → one `saveLayout`; `courseMap.get` has a closed path of 4 points whose dragged vertex has `hOut` down-right on the page and `hIn` opposite, the plain click's vertex smooth handles, the Alt-clicks' none; the path selected, `V` armed, 4 handles and 4 grips; a double-click on the top edge → 5 points and a focused handle, `Delete` → 4; `Escape` discards a polygon being drawn (no write, `V` armed), `Enter` closes one of three clicks (one write); the sheet's `maps.pdf?maps=` draws more `c` operators than before |
| E2E | `e2e/course-editor-layout.spec.ts` "Course editor layout" | §2, §3: Layout mode from the Courses page, sheet shapes, page objects |
| E2E | `e2e/course-editor-placing.spec.ts` "P1: …" "Layout mode: a toner saver hides…" | P1: on a probe course sheet in Layout mode a 709 `oob_area` (`courseObject.create`) shows purple on the canvas (`inkIn`); with a `toner_saver` elsewhere on the map, no purple pixels are left inside the 709 square (638 purple pixels with the ring at upper white) |
| E2E | `e2e/course-editor-layout.spec.ts` "P7: a white-out outside crossing the frame…" | P7: two 709 squares, one inside every shape, one outside: a toner saver whose first vertex is left of the frame, then one across the frame's bottom with its first vertex inside — the inside square keeps its purple, the outside one shows none; a page-anchored white-out outside rectangle dragged with `V` past the frame's bottom, then past its left edge (one `saveLayout` each) — the same after each |
| integration | `auto-templates.test.ts` "part sheets of a map exchange (F5)" | §6 |
| unit (web) | `pages/editor/__tests__/layout-model.test.ts` "a course sheet's part" | `layoutRequestOf` carries `section` for a course sheet, none in template scope |
| unit (shared) | `packages/shared/src/__tests__/setter-groups.test.ts`, `auto-template.test.ts` "fitScale" | §8 |
| unit (web) | `lib/editor/__tests__/setter-maps.test.ts`, `export-menu.test.ts` "setter maps" | §8 |
| unit (web) | `lib/editor/__tests__/export-menu.test.ts` "of a course with variants" | §7 (F8) |
| integration | `packages/api/src/__tests__/integration/variant-pages.test.ts` | §1 `resolveSheet { variantKey }`, `courseMap.list` per variant, §7 the selection (`course-print.md` §9.1 lists it) |
| integration | `packages/api/src/__tests__/integration/setter-maps.test.ts` | §6, §8 (CRS-002: `unassigned`, the `setter_unassigned` issue, the 400, `adoptToSetters` in the event and a course scope) |
| unit (shared) | `packages/shared/src/__tests__/setter-groups.test.ts` | `groupSites`, `nearestGroupIndex` |
| E2E | `e2e/course-editor-layout.spec.ts` (F10) | the warning after a control is added, *Add to nearest setter map* |
| E2E | `e2e/course-editor-layout.spec.ts` "F10: setter maps" | §8 |
| E2E | `e2e/field-mode.spec.ts` "Field mode on a desktop" "the setter-map picker…" | `course-editor.md` §9 |
| E2E | `e2e/course-editor-status.spec.ts` "F5: map exchange" | §6, §7: map exchange parts as own sheets, `EXCHANGE_WITHOUT_SHEET` |

## Pending in this chapter

- **`maps=` seqs of setter sheets are not blocked** when controls are in no setter map (§8 "Controls added after generation"); only `?setter=1` is.
- **Stale members of a setter group**: a control removed from a course stays in the group's `controlIds`; only missing controls are reported.

- **A per-runner named map** (the runner's name on her map): F8 prints
  the per-variant stack sized by the assigned runners
  (`copies=runners`) but no names; a separate feature if wanted. A
  spare count in the menus (the route takes `spare=`) is not offered.
- **A fitted description placement** (08 §4.6 "compute … description
  placement"): *Recalculate* (F10, §6, §8) fits scale and orientation and
  puts the block back on the template's spot; a placement that avoids the
  controls is not computed. The all-controls sheet's *creation* still
  takes the busiest key's scale (only *Recalculate* fits one).
- **A setter sheet on the canvas** (F10, §8): Layout mode draws the
  view's controls over a setter sheet, not only its group — the editor's
  layer request is F7's files (`course-layer-request.ts`, `MapPanel`,
  `MapViewer`); print and the lists are the group's.
- **Class sub-rows on the Courses page's overview**: not planned (decided
  in the split); ClassesPage shows no override fields.
- **Print-preview toggle** (05 §5.12): waits for print profiles.
- **Canvas editing beyond move / resize / rotate and the path gestures**:
  multi-select, frame handles, edge snapping.
- **Crop mode's finer steps and content pan** (J9): an edge drag steps
  in whole per cent, as the fields; a body drag in crop mode moves the
  image, not the content under the crop.
- **Transform handles on touch** (user answer 5): mouse only.
- **Rectangles by outline?** Layout closed paths hit by outline (D16);
  rectangles, text and images still by bounds — flagged for the user
  (feedback 2026-11-04, "Flagged for the morning").
