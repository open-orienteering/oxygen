# Course editor

Normative chapter for the new course editor: one editor on the GL canvas
of the vector pipeline, Course mode first (slice D). Research record:
`docs/research/vector-map-pipeline/08-course-editor.md` §5 (editing
experience), 04 §7 (hit-testing on the shared stage), 09 §3 (gated
reads); decisions in the research README's decision log (2026-11-01,
"D4", "D5"). The work queue is `SLICES.md` (rows D4–D11).

The legacy editor (`CourseEditorPage`) still mounts for `legacy` events
and while the instance flag below is off; its chapter is frozen as
[course-editor-legacy.md](course-editor-legacy.md), which also keeps the
server behaviours both editors share (description autodetect, automatic
overprint cuts, number contrast) until they get their own homes.

## 1. Route and modes

`/:nameId/course-editor` (shell overflow menu → "Course Editor"; the
pencil icons of the Courses and Controls pages deep-link here) mounts
through `CourseEditorRoute` (`pages/editor/CourseEditorRoute.tsx`):

```
mount = editorVector ∧ event == "vector" ∧ documentHash ≠ null ∧ (webgl2 ∨ ¬allowLegacy) ? new editor : CourseEditorPage
```

(`courseEditorMount`, `packages/web/src/lib/map-pipeline.ts`;
`map-pipeline-switch.md` §1, §3.6.) `editorVector` is the instance flag
`map.editor.vector` (default `false`), the temporary gate of slice D while
the editor is unproven, removed in slice E. The vector part is §3.1's
*drawn* pipeline, so a browser that falls back to tiles gets the legacy
editor. The route waits for `course.mapFileInfo`, `course.mapMetadata` and
`event.mapPipeline` before mounting either page.

Deep links: `?course=<seq>` selects a course, `?control=<code>` a control;
consumed once when the data loads.

**Modes** (08 §5.1): Course, Layout, Field share one canvas, selection and
undo history. D4 builds Course mode; the switch shows Layout (D7) and Field
(D9) disabled with "Arrives with slice D7 / D9". The **view** picker
offers *Course* (the selected course full-strength, other controls faded)
and *All controls* (every site with its code, no legs; the inspector keeps
the selected course). Class, variant and setter views are D8 / F.

## 2. Anatomy

The editor renders inside one `MapPanel` (unchanged), whose fullscreen
subtree holds everything: the panel's toolbar row carries the top bar,
its in-map strip (`mapOverlay`) the tool rail, inspector and status bar,
and the description editor is its `fullscreenOverlay`. So fullscreen (the
panel's own button and Keyboard Lock on Escape) keeps the whole editor.

| Part | `data-testid` | What it holds |
|---|---|---|
| Top bar (`TopBar.tsx`) | `editor-top-bar` | course picker (`editor-course-picker`), view (`editor-view-course` / `-all`), mode (`editor-mode-course` / `-layout` / `-field`), undo / redo (`editor-undo` / `-redo`), hide other controls (`editor-hide-others`), auto cuts (`editor-toggle-cuts`), help popover; MapPanel adds descriptions, fullscreen and the viewer its zoom on the same row |
| Tool rail (`ToolRail.tsx`) | `editor-tool-rail` | `editor-tool-<key>` for `V`, `S`, `K`, `M`, `X` / `C` (disabled, "slice F"), `A` (menu `editor-area-menu`, `editor-area-<kind>`), `T`, `G`; the snapping toggle `editor-snapping` (§6) |
| Action bar (`ActionBar.tsx`) | `editor-action-bar` | the selection's or phantom's entries, horizontal, centred under the selection, hidden during a drag; ids `editor-action-<id>` as the legacy popover's. The viewer positions it (`actionLayout: "bar"`); D9 docks the same list as the mobile bottom bar |
| Inspector (`Inspector.tsx`, `modes/CourseMode.tsx`, `modes/ObjectSection.tsx`) | `editor-inspector` | collapsible sections: course (create, sequence, visit order, clone), selection (a site: code, kind, position, description summary, "also in", hidden number, notes — §6.6; several controls: `editor-multi` with the bulk actions — §6.5; a course object: `editor-object` — §7), inventory (`editor-inventory-panel`, collapsed), checks (`editor-checks`, placeholder until D6) |
| Status bar (`StatusBar.tsx`) | `editor-status` | the selected course's control count and length, the armed tool's pending leg (`editor-pending-leg-length`, §6.1), the map scale, "snapping" when on (the sheet key is D8's, climb and checks D6's), the save state (`editor-save-state`, `data-state` = `saved` / `saving` / `error` / `conflict`) |
| Conflict notice | `editor-conflict` | §3 |

The map-info row under the map (file name, *Open review*, *Use new map
engine*, *Replace map*, colour profile) is MapPanel's `showMapInfo` as in
the legacy editor.

## 3. Selection, undo, autosave, conflicts

**Selection** (`lib/editor/state.ts`): the legacy reducer
(`lib/course-editor.ts` — selected course, selected control, phantom with
an optional insert position) plus mode, view and *hide other controls*.
Escape steps back: phantom → control → course; with nothing left it
leaves fullscreen. `H` toggles hide-others (needs a course); a course
change switches it off with the course.

**One gesture, one write, one undo entry.** `UndoStack(50)` of inverse
pairs; an entry whose undo / redo fails is dropped and the error shown.
There is no save button: every write goes out as the gesture ends and the
status bar says *Saved* / *Saving…* / *Not saved* / *Changed elsewhere*.
Undo / redo bump the viewer's `moveEpoch` so an undone move renders at the
restored position.

**Tokens** (`lib/editor/write-client.ts`, `EditorWrites`): every
`course.setStructure` and `control.update` sends `baseVersion` from a
`VersionBook` (`lib/version-book.ts`) — the newest token seen per row,
from `course.list`, `control.list`, `course.detail` and each write's
result — so back-to-back writes send their predecessor's token.
`course.setControlLabelOffset`, `course.create` / `clone` and
`control.delete` take no token and seed the ones they return.

**Conflicts** (`lib/editor/conflict.ts`; `course-layer.md` §7 "Client
rules"):

| Write | Other side changed | Client |
|---|---|---|
| move (`xpos`, `ypos`) | only fields a move does not touch (`differing` without `xpos` / `ypos`; with `differing: null`, the control is still where the move started) | re-sent once with the server's token |
| move | the position too | notice "Moved elsewhere to x, y" with **Keep mine** (re-send from the server's token) / **Keep theirs** |
| other control write (description, codes) | disjoint fields | re-sent once |
| other control write | the same field, or unknown | notice "Changed elsewhere — reloaded. Redo your edit." |
| structure | anything | never merged: notice naming the differing items, the rows reload, the user redoes the edit |

The reload is the usual cache invalidation after every write. "Moved by X
at T" (actor and time) and presence are D11's.

## 4. Course mode

Structure writes go through `course.setStructure` with the course's
token; edits are pure functions over the wire form
(`lib/editor/structure-edit.ts`: `insertSite`, `appendSite`,
`removeSite` (every visit), `removeVisit` (one), `moveVisit`, `setRole`)
in **control-sequence positions** — the items between an explicit leading
start and trailing finish. An item whose predecessor changes loses its
`leg` (its gaps described the old leg). The editor's first save of a
course makes it explicit (`explicitStructure`, `lib/editor/sequence.ts`):
the start and finish it is drawn with — the event default completing an
implicit one — become items (`course-layer.md` §6.2). The inspector's rows
are `displaySequence` (start, controls, finish) with per-leg metres
(`sequenceLegMeters`: paper mm × scale / 1000).

| Gesture / entry | Write | Undo |
|---|---|---|
| click empty map | phantom (`editor-phantom`) + action bar: **Add control** / **Add start** / **Add finish**, with a course also **Add to ‹course›** | — |
| Add control | `control.create { codes, xpos, ypos, autoDescribe }` (code from the club allocation, `editor-alloc-series` overrides the series; SRR codes get radio) | `control.delete` / redo `control.restore` |
| Add to ‹course› (phantom) | create + `setStructure(appendSite)` | `setStructure(prev)` + delete / restore + `setStructure(next)` |
| Add start / finish | code-less `control.create { status: 4 / 5 }` (named "Start N" / "Mål N") | delete / restore |
| click a leg (selected course) | phantom with the insert position (`insertIndexForLeg`: before the row the leg ends at, last when it ends at the finish) + **Insert into course** | — |
| Insert into course | create + `setStructure(insertSite)` | as Add to ‹course› |
| click a control | select; action bar: **Add to ‹course›** (append), **Remove from ‹course›** (every visit), **Reset number position**, **Radio** / **Radio off** (SRR swap offer as legacy), **Edit description**, **Delete control**; a start / finish not used by the course offers **Use as start / finish for ‹course›** (`setRole`) | `setStructure(prev)`; radio is not undoable (as legacy) |
| drag a control | one `control.update { xpos, ypos, autoDescribe: true }` on release; affects-chip "Affects: …" for shared controls | `control.update` with the old position and description |
| drag a number | `course.setControlLabelOffset` | the previous offset |
| Delete / Backspace, **Delete control** | confirm, `control.delete` (the server cascades it out of every structure) | `control.restore` + `setStructure(before)` for every course that held it (read with `course.detail` before the delete) |
| **Edit description** | modal `ControlDescriptionEditor` → `control.update { description }` | the previous description |
| after a move of a hand-described control | one *Suggested: …* row in the action bar (`control.suggestDescription`) | the previous description |
| inspector ↑ / ↓, drag a row | `setStructure(moveVisit)` | `setStructure(prev)` |
| inspector ✕ | `setStructure(removeVisit)` (that visit) | `setStructure(prev)` |
| inspector code | inline edit → `control.update { codes }` | the previous codes |
| visit order | `setStructure({ orderMode })` | `setStructure(prev)` |
| create / clone | `course.create` (suggests classes without a course; an exact name links it) / `course.clone` | not undoable (no `course.restore`) |
| auto cuts | `course.setOverprintCuts` | — |

Free-order courses show codes instead of numbers and no legs or leg
metres, as before. The description sheet is MapPanel's (on by default on
desktop, all controls until a course is selected).

## 5. Hit-testing and the UI layer

The editor hit-tests the course layer's **symbolised shapes** on the
shared stage (04 §7; `map-rendering.md` §5.5), not SVG hit targets:

- Every course reply carries the layer's hit index —
  `hit: { stream, refs }`, the symbolised pass stream with layer-local
  object ids and each object's `ref` (`site`, `leg`, `number`, `leader`,
  …) — and `CourseInfo` hands it to the viewer.
- On pointer-down the viewer (`sharedHitTest`) converts the point to paper
  mm and calls `editorHitAt` (`lib/editor/hit.ts`) →
  `render.hitTest(stream, x, y, { toleranceUm, closedStrokeInterior: true })`:
  a control's circle hits over its interior, a leg within half its width,
  a number over its glyph boxes; tolerance 6 CSS px. The nearest target
  wins, the topmost of equally near ones. A site starts the drag path, a
  number the label drag, a leg the leg click; anything else is empty map.
- Off-course controls the Course view fades are not in the layer (the UI
  layer draws them); they hit as plain circles below every layer object.
- Synchronous on the main thread: the course part is hundreds of passes,
  so a click never waits a worker round trip. Snapping does not hit-test
  the document's stream either (§6.2); a request over the document stream
  is Map mode's (slice G).
- Course objects hit by their `ref` (`course-object:<seq>` → `{ kind:
  "object", id }`) like the course's own shapes; the kinds the layer does
  not draw on screen — a filter region (a region, not an object) and a
  toner saver (no frame on screen) — hit by the outline the UI layer draws
  for them, over their interior and along the edge, below everything else
  (`UiArea`, `editorHitAt`'s last argument). Imported extras do not hit.
- A drag stays a per-move layer request: the layer re-derives in the
  worker and the reply redraws (`map-rendering.md` §5.4). Main-thread
  symbolisation of the dragged object is not needed so far.
- The selection ring, phantom, affects-chip and action bar stay UI layer
  (screen space), and so does everything a tool draws (§6: ghost, pending
  leg, polygon, handles, gap arcs, lasso, multi-selection rings, object
  outlines — `editor-tool-layer`). Selection *highlight* through the
  dynamic bucket is Pending.
- With shared hit-testing the viewer renders no `editor-control-hit` /
  `editor-leg-hit` / `editor-label-hit` elements; it mirrors every editor
  site as a hidden `editor-site` (`data-x` / `data-y`, paper mm) next to
  the layer's `course-site` / `course-leg` mirror, which is what tests use.
  The legacy page leaves `sharedHitTest` off and keeps its SVG targets.

## 6. Tools and placement

The tool rail (08 §5.2, §5.3) — each tool a **viewer binding**
(`pages/editor/tools/bindings.ts` → `MapViewerEditorProps.tool`,
`EditorToolBinding`): the viewer offers every pointer-down to the tool
first (`onPointerDown` → `true` takes the gesture: drag, up), and an
*exclusive* tool also keeps the viewer's own targets off, so a drag pans
and a click without movement goes to the tool's `onClick`. Tools draw
UI-layer shapes in paper mm (`ToolShape`: circle — true size, line,
handle, text). The tool state is `EditorState.tool`
(`lib/editor/state.ts`); an active tool opens no action bar.

| Key | Tool | |
|---|---|---|
| `V` | select / move | the default; §4, plus Shift-click, lasso, objects (§6.5, §7) |
| `S` / `K` / `M` | start / control / finish | armed, §6.1 |
| `X` / `C` | map exchange / crossing point | shown disabled: "arrives with slice F" |
| `A` | areas | a menu: out-of-bounds area, out-of-bounds line, white-out, filter region, toner saver, marked route (§6.4) |
| `T` | map text | one click places it (§7) |
| `G` | gaps | on the selected circle or leg (§6.3) |
| — | snapping | the rail's toggle (§6.2) |

**Escape** drops an active tool first (back to `V`), then a
multi-selection, then a selected object, then the §3 cascade. `V`
returns to select from any tool; right-click exits an exclusive tool.

### 6.1 Placement (`S`, `K`, `M`)

`pages/editor/tools/placement.ts` (pure) keeps the chain:

- **Arming.** The tool **stays armed** until exited. The insertion point
  is the control selected when it was armed (after it), the leg clicked
  (its insert position, §4), otherwise the item before the finish; `S`
  anchors at position 0. Without a course the tools only create sites.
- **Ghost** (`editor-ghost`, `editor-ghost-label`,
  `editor-ghost-description`): the circle at true paper size (the
  layer's `metrics`, reported by the viewer's `onCourseInfo`), *number ·
  code* — the sequence number at the insertion point and the next code
  from the club allocation (`nextSeriesControlCode`, the inventory's
  series) — and the top autodetect description under the cursor
  (`control.suggestDescription`, asked 150 ms after the pointer rests,
  rounded to 0.1 mm). Over an existing control of the tool's kind the
  ghost sits on it and reads **Add ‹code›**.
- **Pending leg** (`editor-pending-leg`): dashed anchor → cursor, and
  cursor → the next item when inserting; the anchor → cursor length in
  metres is in the status bar. No model object exists between clicks.
- **Click on empty map**: one `control.create` (+ `setStructure` insert)
  — one undo entry (§4's create-and-insert). **Click on an existing
  control**: the site is inserted (no new site). The placed control is
  selected (its ring is the "last placed" mark); the action bar does not
  open. The insertion point advances and the new site is the anchor.
- **Drag** pans (the tool is exclusive). **`Ctrl+Z`** undoes the last
  placement and steps the anchor and insertion point back; the tool
  stays armed.
- **Exit**: `Esc`, `V`, `Enter`, right-click. `S` places (or reuses) a
  start, makes it the course's start (`setRole`) and continues with `K`
  from it; `M` places a finish, makes it the course's finish and ends the
  chain (back to `V`).
- **Fast chains.** Placements run one at a time (a queue), each from the
  structure its predecessor wrote: the page keeps the structure it last
  wrote until `course.detail` catches up with its token, and the kinds,
  positions and codes of the sites it created until the lists refetch —
  ten clicks are ten placements even when they outrun the refetch.
- **Touch** (coarse pointer): a fixed centre crosshair, the ghost at the
  view centre, **Place** / **Done** (`editor-touch-place` /
  `editor-touch-done`) at the bottom; taps on the map do not place (the
  pin-drop pattern). D9 docks them in the bottom sheet.

### 6.2 Snapping

The rail's toggle (default off). A dragged control's centre, a placed
site, a polygon vertex and a text anchor snap to the nearest **point
object's centre or line / area vertex** of the map document within
**0.5 mm** on paper (`lib/editor/snap.ts`, `SNAP_MM`). The candidates are
document geometry — a point object's coordinate and the on-curve vertices
of lines and areas; Bézier control points, texts and hidden symbols do
not snap — read once per document hash into a 2 mm grid, on the main
thread (the document bytes are the viewer's `useMapDocument` copy). The
viewer applies `editor.snap` to its control drags; the tools snap their
own points.

### 6.3 Gaps (`G`)

On the selected control's circle, or on the leg last clicked (its
phantom): a drag along the rim (within 10 CSS px of it) opens a gap in
the site's `circle_gaps` — compass degrees, the shorter way round
whichever direction the pointer went, at least 3° — written with
`control.update { circleGaps }`; a drag along the leg one in the leg's
`LegProps.gaps` (fractions of the centre-to-centre leg, at least
0.4 mm), written with `setStructure` on the item the leg runs into. A
click on a gap removes it; overlapping gaps merge
(`pages/editor/tools/gaps.ts`). Each write is one undo entry. The tool
draws the circle or leg (`editor-gap-target`) and the gaps
(`editor-gap`, `data-start` / `data-end` or `data-from` / `data-to`).

A stored list **replaces** the automatic cuts for that circle or leg (the
layer's rule for authored gaps, `course-layer.md` §3.2–3.4, which the
importers' file-authored cuts follow too): the tool starts from the
circle's or leg's *effective* gaps — the stored ones, else the automatic
ones from the layer's derivation — and writes the whole list. An empty
list is "automatic" again.

### 6.4 Area tools (`A`)

`pages/editor/tools/polygon.ts`: click per vertex, drag a vertex
(`editor-polygon-vertex`) to adjust before closing, close by a
double-click or a click on the first vertex, `Esc` cancels. Line kinds
(out-of-bounds line, marked route) end by a double-click or `Enter` from
two vertices. On closing the object is created (§7: `{ all: true }`
scope, the kind's default props), the tool returns to `V` and the new
object is selected with its inspector. A filter region is live while it
is drawn: from the third vertex the polygon is sent as a draft region
with the fast predicate (§7). The **toner saver** needs no drawing: its
hull is generated from the selected course's positioned sites (each
site's margin octagon, `TONER_MARGIN_MM` = 10 mm, convex hull —
`tonerSaverHull`), scoped to the course, and edited like any polygon;
*Regenerate from the course* rebuilds it with the stored margin.

### 6.5 Selection, keys and multi-select

- **Shift-click** a control adds it to or removes it from the
  multi-selection (starting from the selected control); **Shift-drag** on
  empty map draws a free lasso (`editor-lasso`) that selects the controls
  inside (even-odd). Rings `editor-multi-ring`; the inspector shows
  `editor-multi` with **Add N to ‹course›** (appended in selection order,
  one `setStructure`), **Radio on for N** (`control.upsertConfig`, not
  undoable — as single radio), **Delete N controls** (one confirm, one
  undo entry restoring every site and every structure they were in).
- **`Tab` / `Shift+Tab`** select the next / previous control of the
  course and centre the view on it (`viewRequest.centre`); **`F`** fits
  the course, or every positioned control without one (`viewRequest.fit`).
- **Double-click a leg** inserts a new control there (§4's insert, without
  the action bar).
- `Delete` / `Backspace` deletes the multi-selection, the selected object
  or the selected control.

### 6.6 Site fields

The selection inspector writes three fields of 08 §4.2: **kind** (control
/ start / finish; map exchange, crossing point and map issue listed
disabled, "slice F") with `control.update { kind }` (`course-layer.md`
§6.3 keeps `status` in step), **notes** (`control.update { notes }`, on
blur; `courses.review`), and for a control on the selected course
**Hide the number on this course** — `numberHidden` on every visit of the
site in the structure (`setNumberHidden`, `setStructure`). Each is one
undo entry.

## 7. Course objects in the editor

The editor reads `courseObject.list` (MapPanel's cache, until reload) and
invalidates it after every write. On the canvas it shows the objects
`courseObjectsForView` keeps for the view (the selected course's, else
the `all`-scoped ones) — the layer draws them (`course-layer.md` §8.3);
filter regions and toner savers are outlined by the UI layer.

- **Select** (`V`): a click on an object selects it (exclusive with a
  control selection); the inspector shows `editor-object`. Its vertices
  get handles (`editor-object-handle`): dragging one moves the vertex,
  dragging the body moves the whole object — one `courseObject.update {
  geometry }` on release, one undo entry. While dragging, the page hands
  the viewer the object as a **draft** (`draftObjects`, drawn instead of
  the stored one with the same id) and, for a filter region,
  `draftFast` — the layer's fast bbox predicate during the drag, the exact
  one on release (`map-rendering.md` §4.11).
- **Create**: `A` (§6.4) and `T` (a click places a map text: "Text",
  4 mm, upper purple, `{ all: true }`, then selected).
  Default props: filter region `{ mode: "hide", symbols: [] }` (nothing
  hidden until symbols are picked), others the kind's defaults
  (`course-layer.md` §8.1).
- **Inspector** (`modes/ObjectSection.tsx`) — every change one
  `courseObject.update`, one undo entry:

  | Kind | Props |
  |---|---|
  | out-of-bounds area | border none / solid / dashed |
  | out-of-bounds line | 708 / 711 |
  | map text | text, size (paper mm) |
  | toner saver | margin; *Regenerate from the course* |
  | filter region | mode (hide / clip); symbols: all, **picked symbols** (the document's symbols, listed by the canonical id of their applied match, else their source code, with the name; searchable; ids `editor-filter-symbol-<code>`) or **picked colours** (the document's colour rows by name); **invert** ("show only these inside") |
  | white-out, marked route | — |

  **Scope** (`editor-scope`): *All courses*, or the courses and classes
  it belongs to (public ids on the wire, `course-layer.md` §8.2); neither
  is a parked object, drawn nowhere, which the inspector says.
- **Delete**: the inspector's button or `Delete`; undo re-creates it (a
  new `seq`: there is no `courseObject.restore`), redo deletes that one.
- **Tokens**: create seeds the object's token, update and delete send it
  (`EditorWrites.createObject` / `updateObject` / `deleteObject`); a stale
  one is `CONFLICT { kind: "object" }` → the refresh notice of §3.
- Tests read the objects from a hidden mirror, `editor-object-row`
  (`data-object-id`, `-kind`, `-geometry`, `-props`, `-scope`).

## API

The course and control mutations the editors write through (08 §6;
`course-layer.md` §6–7 for the structure and the tokens). Public ids
throughout: a course by its `seq`, a control by its first code (else its
seq). Tokens are decimal strings.

| Procedure | Capability | Input | Returns |
|---|---|---|---|
| `course.setStructure` | `courses.edit` | `{ courseId, structure /* wire form */, baseVersion? }` | `{ version, checks: [] }` (D6 fills `checks`) |
| `course.update` | `courses.edit` | today's fields + `baseVersion?`; with `controlIds` the linear shortcut: writes a structure | `{ ok, version }` |
| `control.update` | `courses.edit`; `notes` alone `courses.review` | today's fields + `kind`, `circleGaps`, `notes`, `baseVersion?` | `{ ok, version }` |
| `control.check` | `courses.review` | `{ controlId, checked }` | `{ version }` |
| `course.setControlLabelOffset`, `course.create`, `course.clone` | `courses.edit` | unchanged | as before, plus the course's `version` |
| `control.delete` | `courses.edit` | unchanged | `{ ok, courses: { id, version }[] }` — the courses whose structure lost the control |
| `course.list` / `course.detail` | `courses.view` | — | rows with `version`; `detail` adds `structure` (wire form) and `structureStored` |
| `control.list` / `control.getById` | `courses.view` | — | rows with `version`, `kind`, `circleGaps`, `notes`, `checkedAt` |
| `event.mapPipeline` | kiosk or `event.view` | — | `{ pipeline, allowLegacy, editorVector }` (§1) |

A stale `baseVersion` answers `CONFLICT` with `data: { kind, id, version,
current, differing }`; a variation group or a slice-F site kind answers
`PRECONDITION_FAILED`.

## Tests

| Layer | Where | What |
|---|---|---|
| unit (shared) | `packages/shared/src/render/__tests__/hit-test.test.ts` | §5: topmost first, stroke reach = half width + tolerance, even-odd fills, closed-stroke interior on request, glyph discs, text glyph boxes, object filter, distance |
| unit (web) | `packages/web/src/map-gl/__tests__/worker-course.test.ts`, `engine.test.ts` | the course reply's hit index (local ids, refs `site` / `leg` / `number`, a site found at its centre; null on clear) and its way to the host |
| unit (web) | `packages/web/src/lib/editor/__tests__/hit.test.ts` | §5 over the real worker: interior and ring, start and finish, legs with course and index, empty map, tolerance, numbers, UI-layer sites under layer objects |
| unit (web) | `lib/editor/__tests__/conflict.test.ts`, `write-client.test.ts` | §3: rebase vs moved vs refresh, unknown base, structure never merged; tokens sent and advanced, one re-send, `EditorConflict`, code re-keying, delete seeding |
| unit (web) | `lib/editor/__tests__/structure-edit.test.ts`, `sequence.test.ts`, `state.test.ts` | §4: sequence positions, insert / append / remove / move / role, legs dropped on a new predecessor; display sequence, explicit structure, leg → insert position; §3 Escape cascade, hide-others, modes |
| unit (web) | `pages/editor/__tests__/action-bar.test.ts` | §4: the entries per selection, the legacy ids |
| unit (web) | `lib/__tests__/map-pipeline.test.ts`; `packages/api/src/__tests__/map-pipeline.test.ts` | §1: `courseEditorMount`; `map.editor.vector` parsing |
| integration | `packages/api/src/__tests__/integration/map-pipeline.test.ts` | §1: `event.mapPipeline` / `setMapPipeline` report `editorVector` |
| E2E | `e2e/course-editor.spec.ts` | the mount gate both ways and the shell; place → move → undo / redo → reload → select on the canvas → delete; create a course, append two controls, add-to-course on the map, reorder + undo, insert on a leg, remove, reload with `?course=` (explicit start / finish rows); deep links, `H`, Escape cascade |
| unit (web) | `pages/editor/__tests__/placement.test.ts` | §6.1: insertion point (before the finish, after the selected control, at a leg, `S` at 0, no course), chain advance, `Ctrl+Z` steps back, `S` → `K`, ghost number and pending legs |
| unit (web) | `pages/editor/__tests__/polygon.test.ts`, `gaps.test.ts` | §6.4: vertex flow, close on the first vertex / double-click, line kinds, vertex drag, hulls (toner saver margin); §6.3: compass degrees, shorter arc, minimum, merge across north, leg fractions |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` | §6, §7: V (Shift-click, lasso, object select / move / vertex, outlines, double-click leg), armed (exclusive, right-click, touch), area (vertex drag, first-vertex close), G (rim drag, click removes, leg) |
| unit (web) | `lib/editor/__tests__/snap.test.ts`, `hit.test.ts`, `state.test.ts`, `structure-edit.test.ts`, `write-client.test.ts` | §6.2 snap candidates and distance; §5 object targets (stream and UI-layer outline); §6 Escape order, multi-selection, object selection, tools; §6.3 / §6.6 `setLegGaps`, `setNumberHidden`; §7 object tokens |
| E2E | `e2e/course-editor.spec.ts` "tools" | §6.1 ten controls in ten clicks with `K` (ghost, pending leg, no action bar, `Ctrl+Z`, `Esc`), reuse of a site; §6.3 a rim drag stores a circle gap; §6.4 / §7 an out-of-bounds area drawn, its border set, deleted and undone; a filter region hides the 505 path under it live (canvas ink probe) |
| E2E | `e2e/course-editor-legacy.spec.ts` | the legacy page, unchanged (`chromium`) |

## Pending in this chapter

- **Selection highlight through the dynamic bucket** (04 §7: the
  selected object's passes redrawn in a highlight colour): the selection
  and multi-selection rings and object outlines stay UI layer; D5 left it
  because it is `map-gl` work outside its area (decision log, D5).
- **Drawing what the gap tool and the hidden-number box write**: the
  editor stores `circle_gaps`, `LegProps.gaps` and `numberHidden`
  (§6.3, §6.6), but the viewer's layer request does not carry them yet
  (`course-layer.md` §6 Pending), so the canvas shows the stored gaps
  only in `G`'s own overlay.
- **Course objects**: draw order (`courseObject.reorder`) has no control
  in the editor; no image (logo) tool; `inset_frame` is slice F's.
- **Description instructions** (finish variant, special instructions)
  are edited in the legacy editor only.
- **Course delete** stays on the Courses page.
- **Checks
  and KPIs** (climb, check count, leg distances from the layer) — D6;
  **Layout mode** — D7; **export menu, class view, sheet key** — D8;
  **Field mode, mobile chrome, loupe** — D9; the rest of the E2E rewrite
  and the `map-vector` / `mobile` projects — D10; **presence and "moved
  by X at T"** — D11.
- The colour-profile and north badge are the map-info row's, unchanged.
