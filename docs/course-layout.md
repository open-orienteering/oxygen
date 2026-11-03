# Course layout

Layout mode of the course editor (`course-editor.md`): the printed sheet
as the view, on the same GL canvas as Course mode. Research: 05 §5.12
(the layout editor on the GL backend), 08 §4.6 (layout model), §5.2–5.4
(anatomy, Layout column, views), §5.5 (tablet); 09 §1 "Layout editor".
What a sheet and a template *are* (rows, overrides, coordinate spaces,
validation, the legacy `MapLayoutEditor`) stays in `course-maps.md`; how a
sheet *prints* stays in `course-print.md`. Slice D7.

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

- *Sheet* (`courseMap.saveLayout`): the course's first sheet (by
  `sortOrder`, `seq`) unless one was opened; view *All controls* shows the
  all-controls sheet; a course without a sheet shows "assign a template
  on the Maps page" (`editor-layout-no-sheet`). An opened course sheet
  gives way to the default when the top bar picks another course or view
  *All controls*. A course sheet draws only
  its course (`filterMode: "course"`), as it prints. The top bar's course
  picker switches the sheet; the inspector's picker
  (`editor-layout-sheet-picker`) chooses among the course's sheets.
  Editable: the sheet's objects, the block (visible, cell size,
  position), the print scale override and the window centre; a sheet
  write leaves the template's objects alone (`saveLayout` without
  `templateObjects`, which `MapLayoutEditor` still sends). The
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
there is no debounce. Sheets and templates carry **no version token**:
two setters on one sheet overwrite each other's whole snapshot, last
writer wins, as with `MapLayoutEditor` (G1 defined tokens for courses and
controls only; D11's presence is the mitigation; a token comes with a
migration, which D8's row is asked to consider — coordinator 2026-11-03). The status bar's save state is the editor's.

**Keys** (08 §5.3 Layout column): `V` select, `H` header, `T` text, `D`
description block, `W` white-out, `O` white-out outside, `L` line, `R`
rectangle, `P` polygon (`I` image is armed from the Graphics section),
`F` fit page, `Tab` / `Shift+Tab` next / previous object, `Delete` the
selected object (or hides the block), `Escape` drops the tool, then the
selection; `Ctrl+Z` / `Ctrl+Y` undo / redo. The grid toggle
(`editor-snapping`) moves in 1 mm steps.

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
and selects the new object; a drag with a tool armed pans.

| Key | Places | With |
|---|---|---|
| `H` | header text `{course}`, 6 mm | `createObjectAt("text")` |
| `T` | text `{course}`, 4 mm | `createObjectAt("text")` |
| `I` | the picked graphic, 30 mm | `createImageObjectAt` |
| `D` | shows the block at the click (selects it when shown) | `constrainDescription` |
| `W` | white-out rectangle, no border | `createObjectAt("rectangle")` |
| `O` | white-out outside, a closed path | `createObjectAt("path")` + `fillModePatch` |
| `L` / `R` / `P` | line, rectangle, polygon | `createObjectAt` |

`L`, `R` and `P` are not in 08 §5.2's list: existing templates hold them
and `vector` events would otherwise lose them against the legacy editor
(decision log D7).

With `V`: a click selects an object of the scope (topmost by bounds;
lines and open paths within the handle tolerance); a drag moves it
(`translateMapObject`, kept on the printable area by
`constrainMapObject`); the selected object's handles (corners, line ends,
path vertices) resize (`resizeMapObject` with the printable clamps;
Shift keeps an image's proportions); the block moves by its own drag. All
of it is `lib/map-layout-editor.ts`, unchanged. A click on nothing inside
the frame selects the frame; elsewhere it deselects.

Not in D7 (Pending): Shift-click multi-select, Bézier handles and vertex
insert / remove on the canvas (the helpers exist), the frame's own resize
handles in template scope, edge snapping, rotation.

## 4. Align map and entry points

**Align map** (08 §4.6 "moving the window is align map as today"): select
the frame, then drag inside it. The sheet moves over the fixed map and the
window centre follows the drag in paper mm (`alignedCentre`), whatever the
window's rotation; the drop writes `courseMap.saveLayout` with the new
centre, and undo writes the old one. The stored centre is the one
`MapLayoutEditor` stores (that editor moved the terrain under a fixed
sheet; the record is the same). With nothing selected a drag pans.

**Entry points.** The Maps page's *Edit layout* (`edit-course-map-<seq>`,
the all-controls row) and the Map templates page's
(`edit-template-layout-<seq>`) navigate to the editor's Layout mode when
the event mounts the new editor (`useCourseEditorMount`, the rule of
`course-editor.md` §1: `vector ∧ pinned ∧ map.editor.vector`, WebGL2 or
legacy disallowed) and open `MapLayoutEditor` otherwise. So `window.png`
and `MapLayoutEditor` keep serving every event the new editor does not
mount (`course-print.md` §10.6).

**What stays in `course-maps.md`:** the data model (templates, sheets,
overrides), coordinate spaces, validation codes, the Maps and Map
templates pages' tables, club templates, and the legacy editor.

## Tests

| Layer | Where | What |
|---|---|---|
| unit (shared) | `packages/shared/src/course/__tests__/page-layer.test.ts` | the page layer is the composer's (stream, colours, transform, images); only page-anchored objects; through `T_map⁻¹` a text sits at `pagePointToMap` of its page position; widths scale by `1 / scaleRatio` |
| unit (shared) | `packages/shared/src/print/__tests__/page.test.ts` | `inverseMapLayerTransform` round-trips (0°, 25°) |
| unit (shared) | `print/__tests__/compose.test.ts`, `write-page.test.ts`; `packages/api/src/render/__tests__/pdf-golden.test.ts` | unchanged after the extraction |
| unit (web) | `packages/web/src/map-gl/__tests__/worker-course.test.ts` | the page part: none without a page; its colours after every map colour, the table repeated; the page white-out at the stack's upper white; a text in paper µm; the frame ring; the block |
| unit (web) | `map-gl/__tests__/engine.test.ts`, `view.test.ts` | the page part uploaded as `P`, drawn after the course part, `pageClip` passed, both released on clear; `scissorOfRing` |
| unit (web) | `lib/__tests__/course-layer-request.test.ts` | `layout`: the page passed through, layout objects before course objects, appearance, overprint, window, text values |
| unit (web) | `lib/editor/__tests__/layout.test.ts` | page-view maths: the window, page ↔ view round trips (rotated), y flip, sheet shapes, page bounds, hit-testing, handles, the block's rectangle, align, page offset, grid |
| unit (web) | `pages/editor/__tests__/layout-bindings.test.ts`, `layout-model.test.ts`, `lib/editor/__tests__/state.test.ts` | the binding (exclusive, shapes, select / move / snap / resize / locked / align / block / place); the snapshot per scope, geometry, the request, placement per kind; the mode case |
| integration | `packages/api/src/__tests__/integration/course-maps.test.ts` "resolveSheet" | a sheet (window centre, page, text values, block, template / sheet split, overprint, sibling windows), `saveLayout` without `templateObjects` leaves the template, `PRECONDITION_FAILED` without a template; a template with and without a course; `NOT_FOUND` |
| E2E | `e2e/course-editor.spec.ts` "Course editor layout" | from the Maps page into Layout mode on the sheet; the sheet shapes; `H` places a header, the inspector makes it a long 10 mm text, and ink appears where the page layer draws it; the frame selected and dragged → `courseMap.get`'s centre moved by the drag; undo restores it; the `maps.pdf?maps=` route answers one A4 page; the template link opens template scope, an orientation change writes `mapTemplate.update`; the Map templates page's *Edit template layout* opens template scope |

## Pending in this chapter

- **Auto templates, class sheets, the sheet key, Export ▾** — D8.
- **Print-preview toggle** (05 §5.12): waits for print profiles.
- **Version token on sheets and templates** (§2): whole-snapshot LWW
  until a migration adds one (D8's migration is the natural place).
- **Canvas editing beyond move / resize**: multi-select, Bézier handles
  and vertex insert / remove, frame handles, edge snapping, rotation (§3).
- **GL-drawn images** with their crop (§1).
- **Retiring `MapLayoutEditor` and `window.png`'s document branch** —
  slice E, with the `map.editor.vector` gate.
