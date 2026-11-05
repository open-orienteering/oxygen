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
consumed once when the data loads. `?mode=layout` with `sheet=<seq>` or
`template=<seq>` opens Layout mode on that sheet or template
(`course-layout.md` §4).

**Modes** (08 §5.1): Course, Layout, Field share one canvas, selection and
undo history. Course mode is this chapter; **Layout mode** — the sheet as
the view, course edits locked — is `course-layout.md`; Field mode is D9's
(§9; the initial mode on a phone, §10). The **view** picker
offers *Course* (the selected course full-strength, other controls faded)
and *All controls* (every site with its code, no legs; the inspector keeps
the selected course). *Class* (`editor-view-class`, a picker of the
selected course's classes) is the course as that class prints it —
`course-layout.md` §6 "Class view". Variant and setter views are F.

## 2. Anatomy

The editor renders inside one `MapPanel` (unchanged), whose fullscreen
subtree holds everything: the panel's toolbar row carries the top bar,
its in-map strip (`mapOverlay`) the tool rail, inspector and status bar,
and the description editor is its `fullscreenOverlay`. So fullscreen (the
panel's own button and Keyboard Lock on Escape) keeps the whole editor.
The lock is taken once per fullscreen session, keyed on the editor being
present rather than on the editor prop object, which changes on every
hover with an armed tool; re-locking per render made Chrome re-show its
exit bubble on every pointer move
(`docs/bugfix-fullscreen-bubble-flicker.md`, `e2e/editor-fullscreen.spec.ts`).

| Part | `data-testid` | What it holds |
|---|---|---|
| Top bar (`TopBar.tsx`) | `editor-top-bar` | course picker (`editor-course-picker`), view (`editor-view-course` / `-all` / `-class`), mode (`editor-mode-course` / `-layout` / `-field`), undo / redo (`editor-undo` / `-redo`), hide other controls (`editor-hide-others`), auto cuts (`editor-toggle-cuts`), Export ▾ (`editor-export`, `course-layout.md` §7), help popover; MapPanel adds descriptions, fullscreen and the viewer its zoom on the same row |
| Tool rail (`ToolRail.tsx`; Layout mode: `layout/LayoutRail.tsx`, `editor-layout-rail`, `course-layout.md` §3) | `editor-tool-rail` | `editor-tool-<key>` for `V`, `S`, `K`, `M`, `X` / `C` (disabled, "slice F"), `A` (menu `editor-area-menu`, `editor-area-<kind>`), `T`, `G`; the snapping toggle `editor-snapping` (§6) |
| Action bar (`ActionBar.tsx`) | `editor-action-bar` | the selection's or phantom's entries, horizontal, centred under the selection, hidden during a drag; ids `editor-action-<id>` as the legacy popover's. The viewer positions it (`actionLayout: "bar"`); on a phone the same list is the bottom sheet's peek row (`actionLayout: "host"`, §10) |
| Inspector (`Inspector.tsx`, `modes/CourseMode.tsx`, `modes/ObjectSection.tsx`) | `editor-inspector` | collapsible sections: course (create, sequence, visit order, clone), selection (a site: code, kind, position, description summary, "also in", hidden number, notes — §6.6; several controls: `editor-multi` with the bulk actions — §6.5; a course object: `editor-object` — §7), inventory (`editor-inventory-panel`, collapsed), checks (`editor-checks`, §8) |
| Status bar (`StatusBar.tsx`) | `editor-status` | the selected course's control count and length, the armed tool's pending leg (`editor-pending-leg-length`, §6.1), the map scale — or the shown sheet's key in Layout mode and Class view (`editor-status-sheet`, `course-layout.md` §6) —, "snapping" when on, climb and the check count (§8), the save state (`editor-save-state`, `data-state` = `saved` / `saving` / `error` / `conflict`) |
| Conflict notice | `editor-conflict` | §3 |
| Field mode (§9) | `editor-inspector-field`, `editor-field-selection`, `editor-nudge-pad`, `editor-field-offline` | the control list with distance / bearing and check-off in place of the sequence; the selection's distance, check-off and nudge pad; no tool rail |
| Phone chrome (§10) | `editor-field-top-bar`, `editor-overflow`, `editor-sheet`, `editor-field-add` | below 640 px: the compact top bar, the bottom sheet (peek: KPIs, selection, action bar) and the floating `+` instead of the top bar, rail, inspector strip and status bar above |

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

The reload is the usual cache invalidation after every write. The moved
notice names who and when when the journal has it (§11).

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
  a number over its glyph boxes; tolerance 6 CSS px, 12 on a coarse
  pointer (§10). The nearest target
  wins, the topmost of equally near ones. A site starts the drag path, a
  number the label drag, a leg the leg click; anything else is empty map.
- Off-course controls the Course view fades are not in the layer (the UI
  layer draws them); they hit as plain circles below every layer object.
  A control whose circle has gaps (stored or automatic) is drawn as open
  arcs, whose interior does not hit; it hits the same way, as a plain
  circle below the layer's objects (D5).
- Synchronous on the main thread: the course part is hundreds of passes,
  so a click never waits a worker round trip. Snapping does not hit-test
  the document's stream either (§6.2); a request over the document stream
  is Map mode's (slice G).
- Course objects hit by their `ref` (`course-object:<seq>` → `{ kind:
  "object", id }`) like the course's own shapes: a line (`oob_line`,
  `marked_route`, `inset_frame`) by its stroke, a text by its glyph boxes.
  **Closed areas are hit only along their outline; their interior is the
  map** (D12). Every closed kind — `oob_area`, `whiteout`, `toner_saver`,
  `filter_region` (`vertexRule(kind).closed`) — is a `UiArea`
  (`editorHitAt`'s `uiAreas`, built by the viewer from the drawn objects,
  drafts included): it hits within the tolerance of its ring, the sampled
  outline of §7 "Editing geometry" (a curved area hits along its curve),
  below everything else, and the layer's own passes for it — fill, hatch,
  a 709.b / 709.c border, which answer distance 0 over the interior — are
  passed over. So a press inside an area pans the map and a click there is
  a map click, also on a selected area (§7); a control, a leg or a line
  inside an area hits as if the area were not there. `closedStrokeInterior`
  stays for the control circles. An area whose whole outline is
  off-screen is selected after zooming out (`F` fits the course).
  Imported extras do not hit.
- While an armed tool's provisional visit is drawn (§6.1) only real sites
  are targets: `editorHitAt`'s `accept` passes over everything else and
  over the `provisional` site, so the shape below (a control to reuse)
  is found through the cursor's own circle.
- A drag stays a per-move layer request: the layer re-derives in the
  worker and the reply redraws (`map-rendering.md` §5.4). Main-thread
  symbolisation of the dragged object is not needed so far.
- The selection ring, phantom, affects-chip and action bar stay UI layer
  (screen space), and so does everything a tool draws (§6: ghost, leg
  length, polygon, handles, gap arcs, lasso, multi-selection rings, object
  outlines — `editor-tool-layer`) and a dragged control's leg lengths. The
  armed tools' pending legs are the layer's (§6.1). Selection *highlight* through the
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
and a click without movement goes to the tool's `onClick` (unless the
tool takes the pointer-down itself, as the area tool does, §6.4). A
`ToolPointer` carries `shift`, `alt` (mouse only; touch never) and the
zoom's mm per px; `onPointerDrag` gets the keys held now (`{ shift, alt
}`), so Shift and Alt act live during a drag; Alt held at the area
tool's press places a smooth vertex (§6.4). Tools draw UI-layer shapes
in paper mm (`ToolShape`: circle — true size, line, handle, grip — a
screen-size Bézier handle on a thin line from its vertex — and text). The tool state is `EditorState.tool`
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
- **Pending legs, drawn by the layer.** While the tool is armed with a
  course and the pointer is over the map (on touch: the crosshair at the
  view centre), the page hands the viewer a **provisional visit**
  (`MapViewerEditorProps.provisional`: role, insertion point, cursor or
  reused site, next code) and the viewer's course request splices it into
  the course (`course-layer.md` §5): the dynamic bucket draws the legs
  into and out of the cursor with their automatic slits, the stored gaps
  of the other legs and the renumbered sequence — what the click will
  write. `S` replaces the course's start (its leg runs from the cursor to
  the first item), `M` its finish. One layer round trip per hover
  (04 §7); the hit-test then sees only real sites (a reuse), never the
  provisional circle or its legs (`editorHitAt`'s `accept`, §5). The
  ghost ring, its label and description stay in the UI layer; there is
  no dashed UI-layer leg. In a fast chain the leg from a control placed
  a moment ago appears once the lists refetch. No model object exists
  between clicks.
- **Leg length** (`editor-leg-length`): the first pending leg's length
  on the ground as a UI-layer label at its midpoint, "‹n› m" rounded to
  the metre (paper mm × the map scale, `lib/editor/leg-length.ts`) — the
  status bar's number (`editor-pending-leg-length`). While a control is
  dragged (any tool) the viewer labels both legs of every visit of it in
  the single highlighted course the same way, between the nearest drawn
  neighbours.
- **Click on empty map**: one `control.create` (+ `setStructure` insert)
  — one undo entry (§4's create-and-insert). **Click on an existing
  control**: the site is inserted (no new site). The placed control is
  selected (the chain's anchor, the inspector's row, `Ctrl+Z`'s step
  back), but no selection ring is drawn while a tool is armed — its purple
  circle is the "last placed" mark; the ring (`editor-selection-ring`) is
  `V`'s (`showSelectionRing`, `lib/editor/state.ts`: off while
  `editor.tool.exclusive`, D12). The action bar does not open. The insertion point advances and the new site is the anchor.
- **Drag** pans (the tool is exclusive). **`Ctrl+Z`** undoes the last
  placement and steps the anchor and insertion point back; the tool
  stays armed. The chain steps back only when the entry undone is a
  placement (an inspector edit made while armed is undone on its own).
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
phantom): a drag along the rim (within 10 CSS px of it, at least 1 mm on
paper) opens a gap in
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
list is "automatic" again (**Reset gaps**, `editor-gap-reset`, shown in
`G` while a list is stored, writes it) — so a circle whose only gap is an automatic
one cannot be left without it (turn the event's automatic cuts off for
that). A leg's effective gaps come from the course the layer draws
(Course view); in the All-controls view the layer draws no legs and the
tool starts from the stored ones.

### 6.4 Area tools (`A`)

`A` opens the menu of kinds next to the rail button (`editor-area-menu`,
a portal at the button's screen position so nothing in the overlay strip
covers it); a second key picks the kind — the **`A` chord**: `O`
out-of-bounds area, `L` out-of-bounds line, `W` white-out, `F` filter
region, `S` toner saver, `R` marked route (`AREA_KEYS`, shown in the
menu). The chord key is read only while the menu is open, so `S` does
not arm the start tool there; `Esc` or `A` closes the menu. A click on a
menu item does the same.

The same flow draws Layout mode's `P` polygon (`AreaKind`
`layout_path`, closed, not in the `A` menu; `course-layout.md` §3).

`pages/editor/tools/polygon.ts`: **click = corner, click-drag = curve
vertex** (Mapper / Illustrator): the press places the vertex where it
went down (snapped); once the pointer is 3 px from the press the drag
pulls **symmetric handles** out of it — `hOut` = the drag vector, `hIn` its negation
(`pull-handles`, `symmetricHandles`) — and `Shift` turns the handle to
the nearest 45° (`constrain45`), live. A drag back within 3 px of the
press leaves a corner. Since the tool takes every press on the map, **a drag no longer
pans while an area is being drawn** (the wheel zooms; on touch, where
taps place vertices through `onClick`, one finger still pans and there
are no curve vertices). Drag a placed vertex (`editor-polygon-vertex`)
to adjust it before closing (its handles move with it); close by a
double-click or a click on the first vertex, `Esc` cancels; `Enter`
finishes any kind once it has its minimum vertices. The preview
(`editor-polygon`) follows the curves (§7 "Editing geometry"), and a
curve vertex shows its two grips (`editor-polygon-grip`). A **filter
region** stays a polygon: the schema refuses handles (`course-layer.md`
§8.1), so its click-drag is a corner.

**Alt = smooth vertex** (D15): with `Alt` held at the press (mouse only;
touch never sets it) the vertex placed is **smooth** — its handles are
not pulled but follow its neighbours by uniform Catmull-Rom,
`smoothHandles` in `lib/editor/geometry-edit.ts`:
`hOut_i = (P_{i+1} − P_{i−1}) / 6`, `hIn_i = −hOut_i` (the tangent at the
vertex is parallel to its neighbours' chord; a sixth makes the cubic the
Catmull-Rom spline). The flag lives only in the drawing state
(`PolygonState.vertices[i].smooth`, a `DrawVertex`), and every `step`
re-settles every flagged vertex from its current neighbours (`smoothed`
in `tools/polygon.ts`): a smooth vertex is a corner until the next vertex
lands, then curves, and moving it or a neighbour before closing
recomputes its handles. **Closed kinds wrap at close** (the first
vertex's prev is the last, the last's next is the first — applied when the
flow is done); **an open line's ends stay corners** even when flagged
(no neighbour on one side). Alt with a click on the first vertex closes
with the first vertex smooth (replacing handles pulled there at the
first press); Alt with a double-click makes the double-click's own vertex
smooth — with the mouse its first press places and flags that vertex, so
the Alt that counts is the one at that press (`step`'s `double-click`
event carries `smooth` too, for a caller that sends no press). A **drag past 3 px is still the manual
pull** and wins: the vertex loses its flag and keeps the pulled
handles (a drag back within 3 px then leaves a plain corner). A **filter
region** ignores Alt (no curves). The preview (`editor-polygon`) shows the
provisional curve with the hover point standing in as the last vertex's
next and, for a closed kind of three or more, as the first vertex's prev
(the ring the close would make); nothing provisional is written to the
state, and only handles in the state get grips (`editor-polygon-grip`).
Every finishing path (`click` on the first vertex, `double-click`,
`enter`, and the page's `Enter` key, which goes through `step`) settles
the flags with the wrap and **strips them**: the created geometry is
ordinary `PathVertex`es with handles, one `courseObject.create` and one
undo entry as before. After closing a smooth vertex is a curve vertex like
any other (its handles mirrored, §7 "Editing geometry"); nothing
remembers that it was automatic. *Window managers:* Xfce and older KDE
bind Alt + left-drag (and on some setups Alt + left-click) to moving the
window, so the press never reaches the browser; there the user rebinds
the window manager's modifier (Xfce: *Window Manager Tweaks →
Accessibility*, the key used to grab and move windows; KDE: *Window
Behaviour → Window Actions*, the modifier key). The same holds for `V`'s
Alt gestures (§7 "Editing geometry"). The editor offers no second key for
it: Shift is 45° and Ctrl is the macOS context menu.

Line kinds
(out-of-bounds line, marked route) end by a double-click or `Enter` from
two vertices and never close on the first vertex. On closing the object is created (§7: `{ all: true }`
scope, the kind's default props), the tool returns to `V` and the new
object is selected with its inspector. A filter region being drawn is
outlined only: it starts with nothing picked (§7), so it hides nothing
until its symbols are chosen in the inspector, where every change is live. The **toner saver** needs no drawing: it is generated
from the selected course's positioned sites and is smooth without any
help — the exact **offset hull** (`pages/editor/tools/toner-saver.ts`,
`tonerSaverGeometry`): the convex hull of the site centres (one site is a
circle of four quarter arcs, two a stadium, collinear sites the stadium over
the extremes, duplicate sites one), offset outward by the margin — a straight
edge parallel to each hull edge and, at each hull vertex, an arc of radius
= margin between the two edge normals, cut into pieces of at most 90°, each
a cubic whose handle is (4/3)·tan(θ/4)·r (the formula of
`shared/src/course/arcs.ts`). Stored as ordinary `PathVertex`es: an arc
piece's two ends carry `hOut` and `hIn`, the vertex shared by two pieces of
one arc both, a straight offset edge's two ends one handle each, so the
outline is tangent-continuous and every site is at least the margin inside
it; paper mm rounded to a micrometre. The default margin is `TONER_MARGIN_MM`
= **25 paper mm** (the inspector's field shows 25 for an object without a
stored margin); it was an octagon-rounded 10 mm hull before. The object is
scoped to the course and edited like any polygon (curves print as stored,
`course-layer.md` §8.1); *Regenerate from the course* rebuilds it with the
stored margin, so an old octagonal toner saver is untouched until the user
presses it, and a margin edit in the inspector changes nothing until then
either. A margin of 0 regenerates the plain hull polygon (nothing for fewer
than three hull points).

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
- `Delete` / `Backspace` deletes the multi-selection, else the selected
  object's **focused vertex** (§7 "Editing geometry"), else the selected
  object, else the selected control.

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
  control selection) — a line on its stroke, a text on its glyphs, a
  closed area (`oob_area`, `whiteout`, `toner_saver`, `filter_region`)
  **on its outline only**: inside an area the map is the map, so a press
  there pans and a click there is a map click, also on a selected area
  (§5; D12). The inspector shows `editor-object`. Its vertices get
  handles (`editor-object-handle`): dragging one moves the vertex,
  dragging the body — a line's stroke, a text, an area's edge — moves the
  whole object — one `courseObject.update { geometry }` on release, one
  undo entry. While dragging, the page hands
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
  | out-of-bounds area | hatch: *Out of bounds (709, stripes)* / *Dangerous area (710, cross-hatched)* (`course-layer.md` §3.1; the name first — in ISOM 2017-2, 710 is the crossing point); border none / solid / dashed |
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
  (`data-object-id`, `-kind`, `-geometry` — `x,y` pairs, `-geometry-json`
  — the stored vertices with their handles, `-props`, `-scope`).

### Editing geometry

A course object's path is the stored `PathVertex` list (`course-layer.md`
§8.1): paper mm, each vertex with optional Bézier handles `hIn` / `hOut`
as offsets from it; a segment is a cubic when either end has its handle,
else straight — what the layer's `vertexPath` and print draw. The pure
edits are `lib/editor/geometry-edit.ts`; the gestures are the `V`
binding's on the **selected** object (`selectBinding`), mouse only. They
live in `lib/editor/geometry-gestures.ts` (D16: pressing order, drags,
grips, Alt, focus, insert and the selected path's shapes, in the path's
own units), which Layout mode's selected paths use too, in page mm
(`course-layout.md` §3):

| Gesture | Edit | |
|---|---|---|
| drag a vertex handle (`editor-object-handle`) | moves the vertex, its handles with it | as before (§7) |
| click a vertex handle | focuses it (drawn filled, `data-focused`) | no write; a text's anchor or an image's corner is never focused, so `Delete` deletes the object |
| `Delete` / `Backspace` with a vertex focused | `deleteVertex` down to the kind's minimum; at the minimum nothing happens | the object is deleted from the inspector, or after a click on its body — an area's edge — (which unfocuses) |
| double-click on an edge (within the 7 px handle reach, not on a vertex) | `insertVertex` at the nearest point (`nearestEdge`): a corner on a straight edge; on a curve a **de Casteljau split**, so the shape stays as it was and the new vertex is smooth | the new vertex is focused |
| `Alt`-drag a vertex | `symmetricHandles`: `hOut` = the drag vector, `hIn` its negation (`Shift`: 45°) | |
| drag a grip (`editor-object-grip`, `data-index`, `data-which` `in` / `out`) | the handle moves by the pointer's offset (so a press beside the grip does not jump it) — `dragGrip`: a mirrored pair stays mirrored; a smooth pair (opposite, different lengths — a split's) stays smooth with the other's length kept; a lone or broken handle moves alone (`Shift`: 45°) | |
| `Alt` held on a grip (live) | breaks the pair: only that handle moves | the pair stays broken afterwards |
| `Alt`-click a vertex with handles | `retractHandles`: a corner again | on a corner nothing |

- **Kinds** (`vertexRule`, kept in step with `courseObjectBodySchema` by
  a test): closed areas (`oob_area`, `whiteout`, `toner_saver`) ≥ 3
  vertices, lines (`oob_line`, `marked_route`) ≥ 2, curves allowed;
  `filter_region` ≥ 3 without curves — `Alt`-drag moves its vertex, it
  has no grips; `text` (one anchor) and `image` (two corners) take no
  insert or delete.
- **Writes**: each gesture is one `courseObject.update { geometry }` and
  one undo entry (the page's `updateObject`); during a drag the object is
  a draft as for every object drag (§7). The undo restores the geometry
  **shown** when the gesture began — the previous gesture's result while
  the list catches up, not the older stored row — so quick successive
  gestures undo one at a time; a click draws no draft and leaves the
  last write's draft in place. A press within the handle reach
  of the selected object's edge belongs to the object (a body press), so
  the double-click that inserts never reaches the map.
- **A closed area's body is its outline** (D12): for `oob_area`,
  `whiteout`, `toner_saver` and `filter_region` the selected object's
  body press is an edge within reach — 7 px (`HANDLE_PX`, `nearestEdge`),
  or the hit-test's outline target (6 px, 12 px on touch, §5) — or a
  vertex / grip. A press inside declines: a drag there pans the view and
  leaves the geometry and the selection alone; a click there is a map
  click (it deselects and raises the phantom). `selectBinding` needs no
  kind test for it: the hit-test answers `null` inside (§5), and the
  edge reach is the existing rule.
- **Pressing order** on the selected object: a vertex, then a grip, then
  the body or edge (an area: the edge only). A press elsewhere — inside a
  closed area too — is the usual §6.5 / §4 one.
- **The UI-layer outline follows the curve**: `outlinePoints` samples
  each curved segment in **8 steps** (`CURVE_STEPS`), a curved closing
  segment back to the first vertex too — for the selection outline
  (`editor-object-outline`), the always-on filter region and toner saver
  outlines, every closed area's UI-layer hit ring (§5), and the area tool's preview
  (§6.4). Hit-testing the layer's shapes needs nothing: the hit index is
  the symbolised stream, which already follows the curve.
- The focused vertex is page state: cleared when the selection changes,
  on undo / redo (its index may name another vertex then), replaced by
  the next vertex click, cleared by a click on the body (an area's edge)
  or a map click (inside an area too); it is not a step
  of the Escape cascade (§3).
- The inspector shows a one-line hint of these gestures for the kinds
  that curve (`editor-geometry-hint`).

## 8. Checks and KPIs

Row D6 (08 §5.2, §5.6; the codes, thresholds and inputs are
`course-layer.md` §9). Checks are advisory: nothing blocks a save, an
undo or a mode switch.

- **Computed live** on the client by `courseChecks` over the page's data
  (`useCourseChecks`, `pages/editor/useCourseChecks.ts`): the selected
  course's structure, every site of the event, the document's obstacles
  (`checkObstaclesOfDocument`, once per decoded document), the course's
  sheet windows (`courseMap.list`, the sheets whose course is the
  selected one; none → `CONTROL_OUTSIDE_SHEET` is not evaluated), the
  course objects in scope and the viewer's derivation (`onCourseInfo`).
  The server's `course.checks` adds `DESCRIPTION_STALE`; it refetches
  with the page's other queries after a write. With no course selected
  (all-controls view) only the event-wide codes run.
- **Inspector**: the Checks section (`editor-checks`) is collapsed by
  default, like the inventory (open, it would squeeze the selection
  section in the in-map strip); the count stands beside the title
  (`editor-checks-count`). Open, it lists one row per check
  (`editor-check-row`, `data-code`, `data-sites` = public ids), the text
  from `editor:check_<CODE>` with its `params`; none → "No findings"
  (`editor-checks-none`). **Click-to-locate**: a row selects its first
  site (a leg check: the leg's first site) and centres the view on the
  check's point without changing the zoom.
- **Canvas markers** (UI layer, `editor-check-layer`): an amber ring
  around each site of a site check, an amber cross at a leg check's
  point; `editor-check-marker` (`data-code`; a ring `data-site` and
  `data-x` / `data-y` = the site, a cross `data-x` / `data-y` = the check's
  point, paper mm). They are not hit targets: a click goes through to the map.
- **Status bar KPIs** (`editor-status-kpis`): controls, length, climb;
  beside them the check count (`editor-status-checks`, amber,
  `data-count`, shown when there is one).
  Length is the sum of the layer's leg polylines (`DerivedLeg.points`)
  × the map scale, the course's stored length until the viewer has
  derived it. Climb is the course's stored climb (`courses.climb`,
  entered on the Courses page; "manual" — there is no terrain model
  yet), shown when set.

## 9. Field mode

Row D9 (08 §5.5, §5.1 (6)): the course setter at a control site, phone in
hand. The default on a phone (§10), a mode like the others on a tablet
or desktop — the mode switch enters it everywhere, keeping the viewport,
the selection and the undo history (`editorReducer`'s `mode`).

- **Position.** Entering Field mode starts the page's GPS watch
  (`useFieldFix` → `useGeolocationWatch`, high accuracy); leaving it stops
  the watch. The page hands the fix to the viewer (`editor.fix`), which
  draws it as its locate button's marker does: `my-location-marker` with
  the accuracy ring (`data-accuracy-m`), placed through `mapGeo` like
  every other georeferenced input (04 §7; `lib/map-viewport.ts`
  `geoToInner`) — never a second coordinate system. The view centres on
  the first fix once per entry into the mode; the viewer's locate button
  still follows the fix if the user wants that. The fix's state is one
  line (`editor-field-fix`, `data-state` = `fix` / `waiting` / `denied` /
  `unavailable` (every other error of `useGeolocationWatch`) / `off`): "GPS ±8 m", "Waiting for GPS…", why there is none.
- **Distance and bearing** from the fix (`lib/editor/field.ts`): the fix
  goes to paper mm once per fix (`fixToPaper`: `geoToMm` through the
  document's frame with the event's rotation correction, as the viewer);
  distance is paper mm × scale / 1000, rounded to the metre; bearing is
  degrees clockwise from **paper north** — the map's north lines, what the
  setter's compass reads against the map — 0–359.
- **The control list** replaces the sequence section
  (`editor-inspector-field`): the selected course's start, controls and
  finish **in course order** (not by distance), each row
  `editor-field-row` (`data-control-id`, `data-kind`, `data-distance-m`,
  `data-bearing-deg`, `data-checked`; distance / bearing blank without a
  fix or a position) — tap selects the control and centres it. No course
  selected: "Pick a course to list its controls."
- **The selection** adds above the site fields of §6.6 (notes there
  unchanged): distance and bearing (`editor-field-selection-distance`),
  the check-off toggle and the nudge pad.
- **Check-off** (`editor-field-check` on each control row — start and
  finish rows carry none — and `editor-field-selection-check` for a
  selected control): `control.check { controlId, checked }`
  (`courses.review`, open decision (4)) — sets or clears `checked_at` /
  `checked_by`; no token goes in (a check-off never conflicts), the
  control's token comes back into the `VersionBook`. One undo entry; undo
  is the opposite check. The toggle reads `control.list`'s `checkedAt`, so
  it survives a reload. Disabled without `courses.review`. The peek row's
  KPIs count "n/m checked" over the course's controls.
- **Nudge pad** (08 §5.5 "Precision"; `editor-nudge-pad`): arrows
  `editor-nudge-<up|down|left|right>-<mm|m>` move the selected site by
  0.1 mm on paper, or — the unit button `editor-nudge-unit` — by 1 m on the
  ground (1000 / scale mm), along the paper axes (up = paper north); the
  numeric fields `editor-nudge-x` / `-y` (paper mm) commit on blur or
  Enter. Each press is one `control.update { xpos, ypos, autoDescribe:
  true }` with the move rule of §3 and one undo entry (back to where that
  press started). Presses faster than the refetch build on each other: they
  queue, and the pad shows the newest position until `controlCoordinates`
  has it. Positions are rounded to the µm.
- **No tool rail** on the desktop / tablet layout in Field mode: the
  setter in the field checks and moves, the keys still arm the tools. The
  phone's `+` (§10) is the field's way to create.
- **Offline** (decision log, D9). The row asked for "view + check-off
  only while offline" when no queue covers the moves; that cannot hold
  yet either, because check-off is itself a mutation: no outbox covers `control.update` /
  `control.check` (the offline outbox carries the timing journal's event
  types; course mutations are cloud-owned and "unavailable offline",
  `offline-architecture.md`), so Field mode offline **views only**:
  `editor-field-offline` says "Offline — viewing only. Moves and check-offs
  need a connection.", the nudge pad, the check toggles and `+` are
  disabled, a drag snaps back without a write. The map keeps drawing from
  the cached document (B4, `map-storage.md` §7.1). A queue for these
  writes, with the field-move rebase of §3 on replay, is row D9c (after
  the offline architecture's phase 2).

## 10. Phone and tablet

08 §5.5 "Chrome", "Gestures", "Breakpoints". *Mobile is a layout, not a
port*: the same page, state and writes.

**Breakpoints.** Phone < 640 px (`(max-width: 639px)`, the page's
`isMobile`): the layout below, Field mode the initial mode. Tablet
640–1024 and desktop: the desktop layout of §2, Course mode first. The
**gesture rules** follow the pointer (`(pointer: coarse)`), not the width,
so a tablet gets the touch rules below with the desktop chrome.

**Phone layout** (`editor-page` `data-layout="phone"`):

- **Full-bleed**: the editor covers the screen (fixed, above the app
  shell's header); MapPanel's map-info row is not shown. One finger pans
  the map as in fullscreen (`editor.fullBleed` — there is no page to
  scroll), two fingers pan and zoom.
- **Compact top bar** (`editor-field-top-bar`, in MapPanel's toolbar row
  beside its descriptions and fullscreen buttons): back to the Courses
  page (`editor-back`), the course picker (`editor-course-picker`), the
  mode switch Course · Field (`editor-mode-*`; Layout stays a desktop
  mode), the overflow `editor-overflow` → `editor-overflow-menu` with undo,
  redo, the view picker, hide other controls and auto cuts (the desktop
  ids). No tool rail, no inspector strip, no floating status bar.
- **Bottom sheet** (`components/editor/BottomSheet.tsx`, `editor-sheet`,
  `data-detent` = `peek` / `half` / `full`): *peek* (120 px) holds the
  status bar's KPIs and save state, Field mode's "n/m checked", the
  selection's name (`editor-sheet-selection`) and **the action bar** —
  the same `courseActions` entries and `editor-action-<id>` ids as §2,
  docked here as a scrolling row of ≥ 44 px buttons (`actionLayout:
  "host"`: the viewer draws none at the selection); *half* (45 % of the
  map box) and *full* (the box less 56 px) add, scrolling: description
  suggestions, the selection (Field mode's part above the site fields),
  the control list (Field) or the sequence (Course), the checks. The grab
  handle (`editor-sheet-handle`) drags between detents (released → the
  nearest) and a tap toggles peek ↔ half. **The sheet never covers the
  selection**: when it settles past peek with a control selected, and when
  a list row is tapped, the view centres the control in the band above
  the sheet (`viewRequest.offsetPx` = half the sheet's height, turned into
  the rotated frame by the viewer).
- **`+`** (`editor-field-add`, 56 px, floating above the sheet's right
  edge) opens `editor-add-menu`: control `K`, start `S`, finish `M`
  (`editor-add-<key>`), map text `T`, and the area kinds
  (`editor-area-<kind>`; toner saver needs a course with positioned
  sites). A placement tool arms D5's **pin-drop flow** (§6.1 "Touch"): the
  sheet drops to peek, the crosshair is the view centre, **Place / Done**
  (`editor-touch-bar`) sit above the sheet (`editor.bottomInsetPx`); `+` is
  hidden while a tool is armed.
- Notices (conflict, offline, errors) stack at the top of the map.

**Gestures** (coarse pointer, shared hit-test path; `lib/editor/touch.ts`,
the legacy editor untouched — `mobile-layout.md` "Course editor on touch"):

| Gesture | Effect |
|---|---|
| Tap a control | Selects it (no movement, no write) |
| One finger on the **selected** control | Drags it at once |
| One finger on an **unselected** control | Pending: moving > 10 px pans the map; lifting before 500 ms selects it; holding still for **500 ms** selects it and starts a move (a short vibration where supported) |
| Dragging a control by touch | Drawn **48 px above the finger** on a dashed stem (`editor-touch-handle`) so the finger never covers it; dropped where it is drawn; leg lengths and the affects-chip as with a mouse; the **loupe** above it (below) |
| Two fingers | Always pan / zoom the map; a second finger cancels a pending press or an armed control drag, and selections are suppressed for 400 ms after (today's rule) |
| A control's number | Drags only when its control is selected; otherwise as an unselected control |
| Tap a course object | Selects it (V's binding: its outline and handles) — a line on its stroke, a closed area on its outline (12 px, §5); a tap inside an area, or elsewhere, is a map tap |
| Two fingers, one on a handle of the **selected area object** (or line) | Scale it about its centroid by the fingers' spread (`selectBinding.onPinch`, the handle reach doubled to 14 px): drawn live as a draft, one `courseObject.update` and one undo entry on lift, nothing when the spread stayed within 1 %; the map does not pinch with it |

Hit tolerance is **12 CSS px** on a coarse pointer (6 with a mouse) — the
"large hit areas" of 08 §5.5 — on the same `editorHitAt` path (§5).
**Loupe** (08 §5.5 "Precision"; D9b). While a control is dragged by
touch on the GL canvas, a circle (`editor-loupe`, **120 CSS px**) shows
the map at **×2.5** about the dragged point — the handle, 48 px above the
finger — oriented as the map; it appears and goes with the stem. It sits
**16 px above the handle**, so the 1× control stays visible; when that
would leave the map box at the top it flips to 16 px below the finger;
its edge is kept 4 px inside the box sideways. The picture is the GL
layer's: one more `renderDocument` per frame over the resident visible
set into an offscreen target, drawn into the circle of the canvas
(`map-rendering.md` §5.5 "Loupe"); the element is the ring and a
crosshair at the drop point over it, so the course layer's dragged
circle (one layer round trip behind the finger) and the crosshair meet
when the reply is in. UI-layer shapes that happen to lie under the
circle (a check marker, a leg-length label) draw over the loupe at 1×.
It shows during every touch drag, whatever the zoom: 08 §5.5's "at high
zoom" is read as the loupe's own magnified view, not a zoom gate. Mouse
drags get no loupe (the finger is what hides the circle); the nudge pad
stays the exact tool. In the tiles view (the legacy editor)
`MapLoupe` is unchanged.

These values (500 ms, 10 px, 48 px, 12 px, the loupe's 120 px, ×2.5 and
16 px, the detent heights) are 08
§5.5's unquantified rules made concrete (decision log, D9); D-mobile
measures them on a real phone.

**On a real phone (D-mobile, manual, after D9).** Playwright mocks the fix
(`context.setGeolocation`) and the touch events; only a phone at a control
site proves the mode. The check, on the B0 device: open an event's editor
over mobile data — first frame to a usable map (seconds), the GPS fix and
its ring against the map at a known feature (metres off), the sheet in
sunlight and with gloves (can every peek target and the compact top
bar's 36 px controls be hit first time; is 44 px enough), whether the map
wobbles under a held finger before the long press fires (the pan starts
at touch-down; the slop only decides pan vs move), a long-press move of a control by a few metres and its
distance / bearing afterwards against a compass, a check-off, the
offline notice with the radio off. The numbers go here, beside the
constants above, and any constant that fails is changed with a
decision-log row.

## 11. Working together

Row D11; the rules of `course-layer.md` §7 "Presence and live refresh"
(gate G1, decided by the user 2026-10-31; no new push channel). Three
pieces, all client-visible in the top bar and the notices:

**Presence.** While a course is open and the tab visible the editor sends
`course.presence { courseId, mode, clientId }` at once and every 5 s
(`hooks/useCoursePresence.ts`; a hidden tab stops, so its row ages out).
`clientId` is random per page load: two tabs of one user are two entries,
and an editor never lists itself. The server upserts one row per
`(course, clientId)` in `course_presence` (a client's rows on other courses
go with the switch), deletes rows older than the **30 s TTL** and answers
the live rows of the event's other editors. The top bar lists them as
`name · course · mode` ("Anna · Lång · Field"; the mode label is the
mode switch's), those on the open course first and highlighted
(`editor-presence`, `editor-presence-entry` with `data-here`; two entries inline, the rest a "+n" chip, so the bar stays one row and the map keeps its height); the phone's
compact bar shows the count with the entries in its tooltip. `name` is the
signed-in user's display name, else email; an instance without sign-in
(or a user without either) shows "Someone". Presence is informational: it
never blocks a write — the version tokens (§3) do that.

**Others' changes refresh the editor while it is idle.** Unchanged
machinery: `useExternalChanges`'s 5 s poll sees the `oCourse` / `oControl`
counters move and invalidates the `course` / `control` queries, so the
sequence, the sites and the layer re-render. Beyond that, when the selected
course's token (from `course.list`) moves to one this client's own writes
did not return (`EditorWrites.ownCourseVersions`), the page shows one line,
`editor-external-change`: "‹who› changed this course at ‹time› — the
sequence was reloaded." (who and time from `course.lastChange`, the actor
and clock of the course's last `course.upserted`; without a name, "This
course was changed elsewhere — the sequence was reloaded."). It stays until
dismissed or the course changes; a structure is never swapped silently.

**"Moved by X at T".** When a control move meets a move of the same control
(§3's `moved` notice), the page asks `control.lastChange` for the control's
newest `control.upserted` — `JournalEntry.actorId` and the physical part of
its `hlc` — and the notice reads "Moved by ‹who› at ‹time› to x … mm, y …
mm." with Keep mine / Keep theirs as before. If the journal has no entry,
the §3 wording stays.

## API

The course and control mutations the editors write through (08 §6;
`course-layer.md` §6–7 for the structure and the tokens). Public ids
throughout: a course by its `seq`, a control by its first code (else its
seq). Tokens are decimal strings.

| Procedure | Capability | Input | Returns |
|---|---|---|---|
| `course.setStructure` | `courses.edit` | `{ courseId, structure /* wire form */, baseVersion? }` | `{ version, checks }`: the written course's `course.checks` list |
| `course.checks` | `courses.view` | `{ courseId }` | `CourseCheck[]`: `{ code, siteIds /* public ids */, leg?: { from, to, index }, at: { x, y }, params? }` (`course-layer.md` §9; no message text — the web formats `editor:check_<CODE>`) |
| `course.update` | `courses.edit` | today's fields + `baseVersion?`; with `controlIds` the linear shortcut: writes a structure | `{ ok, version }` |
| `control.update` | `courses.edit`; `notes` alone `courses.review` | today's fields + `kind`, `circleGaps`, `notes`, `baseVersion?` | `{ ok, version }` |
| `control.check` | `courses.review` | `{ controlId, checked }` | `{ version }` |
| `course.setControlLabelOffset`, `course.create`, `course.clone` | `courses.edit` | unchanged | as before, plus the course's `version` |
| `control.delete` | `courses.edit` | unchanged | `{ ok, courses: { id, version }[] }` — the courses whose structure lost the control |
| `course.list` / `course.detail` | `courses.view` | — | rows with `version`; `detail` adds `structure` (wire form) and `structureStored` |
| `control.list` / `control.getById` | `courses.view` | — | rows with `version`, `kind`, `circleGaps`, `notes`, `checkedAt` |
| `course.presence` | `courses.view` | `{ courseId, mode: "course" \| "layout" \| "field", clientId }` | `{ ttlMs, others: { courseId, courseName, name, mode }[] }`: the event's other live editors (§11) |
| `course.lastChange` / `control.lastChange` | `courses.view` | `{ courseId }` / `{ id }` | `{ name, at /* ISO */ } \| null`: actor and time of the row's newest `*.upserted` entry (`name` empty without a sign-in) |
| `event.mapPipeline` | kiosk or `event.view` | — | `{ pipeline, allowLegacy, editorVector }` (§1) |

A stale `baseVersion` answers `CONFLICT` with `data: { kind, id, version,
current, differing }`; a variation group or a slice-F site kind answers
`PRECONDITION_FAILED`.

## Tests

| Layer | Where | What |
|---|---|---|
| unit (shared) | `packages/shared/src/render/__tests__/hit-test.test.ts` | §5: topmost first, stroke reach = half width + tolerance, even-odd fills, closed-stroke interior on request, glyph discs, text glyph boxes, object filter, distance |
| unit (web) | `packages/web/src/map-gl/__tests__/worker-course.test.ts`, `engine.test.ts` | the course reply's hit index (local ids, refs `site` / `leg` / `number`, a site found at its centre; null on clear) and its way to the host |
| unit (web) | `packages/web/src/lib/editor/__tests__/hit.test.ts` | §5 over the real worker: interior and ring, start and finish, legs with course and index, empty map, tolerance, numbers, UI-layer sites under layer objects; closed areas by their outline only (D12): inside an `oob_area` / a white-out → null, its edge → the object, a 709.b border not grabbing the interior, a control and a leg inside a white-out still hit, a line by its stroke, a `UiArea`'s interior → null |
| unit (web) | `lib/editor/__tests__/conflict.test.ts`, `write-client.test.ts` | §3: rebase vs moved vs refresh, unknown base, structure never merged; tokens sent and advanced, one re-send, `EditorConflict`, code re-keying, delete seeding |
| unit (web) | `lib/editor/__tests__/structure-edit.test.ts`, `sequence.test.ts`, `state.test.ts` | §4: sequence positions, insert / append / remove / move / role, legs dropped on a new predecessor; display sequence, explicit structure, leg → insert position; §3 Escape cascade, hide-others, modes |
| unit (web) | `pages/editor/__tests__/action-bar.test.ts` | §4: the entries per selection, the legacy ids |
| unit (web) | `lib/__tests__/map-pipeline.test.ts`; `packages/api/src/__tests__/map-pipeline.test.ts` | §1: `courseEditorMount`; `map.editor.vector` parsing |
| integration | `packages/api/src/__tests__/integration/map-pipeline.test.ts` | §1: `event.mapPipeline` / `setMapPipeline` report `editorVector` |
| E2E | `e2e/course-editor.spec.ts` | the mount gate both ways and the shell; place → move → undo / redo → reload → select on the canvas → delete; create a course, append two controls, add-to-course on the map, reorder + undo, insert on a leg, remove, reload with `?course=` (explicit start / finish rows); deep links, `H`, Escape cascade |
| unit (web) | `pages/editor/__tests__/placement.test.ts` | §6.1: insertion point (before the finish, after the selected control, at a leg, `S` at 0, no course), chain advance, `Ctrl+Z` steps back, `S` → `K`, ghost number and pending legs (a start's leg runs to the first item) |
| unit (web) | `lib/editor/__tests__/leg-length.test.ts`, `lib/__tests__/course-layer-request.test.ts`, `lib/editor/__tests__/hit.test.ts` | §6.1: metres at the map scale, "‹n› m", the midpoint, a dragged control's labels (both legs, every visit, over undrawn items); the provisional visit in the request (`course-layer.md` §5); §5 `accept` passes over other targets and finds the site below a rejected one |
| unit (web) | `pages/editor/__tests__/toner-saver.test.ts` | §6.4 toner saver: every site at least the margin inside the sampled outline (and the hull sites exactly), tangent continuity at every vertex and along the straight edges, one site → four quarter arcs, two → a stadium of six vertices, collinear and duplicate sites, one cubic per ≤ 90° of turn with the handle (4/3)·tan(θ/4)·r, micrometre rounding |
| unit (web) | `pages/editor/__tests__/polygon.test.ts`, `gaps.test.ts` | §6.4: vertex flow, close on the first vertex / double-click, line kinds, vertex drag, `pull-handles` (symmetric, `Shift` 45°, back to a corner, a filter region stays a polygon, a moved curve vertex keeps its handles); the Alt smooth vertex (D15: a corner until the next vertex lands, then `(next − prev) / 6`; recomputed when it or a neighbour moves; a pull clears the flag and keeps its handles, a pull back is a corner; a filter region ignores it; closed kinds wrap at close, Alt on the closing click smooths the first vertex; an open line's ends stay corners; every finishing path strips the flags; Alt on a double-click); §6.3: compass degrees, shorter arc, minimum, merge across north, leg fractions |
| unit (web) | `lib/editor/__tests__/geometry-edit.test.ts` | §7 "Editing geometry": 8 samples per curved segment on the cubic, a curved closing segment, open paths never close; the nearest edge (closing edge, along a curve); insert on a straight edge, on the closing edge, on a curve (de Casteljau: the halves trace the original, the new vertex smooth); delete down to the minimum; symmetric handles, retract, grip drags (mirrored, smooth with the other's length kept, Alt breaks, broken / lone handles alone), 45°; `smoothHandles` (D15: an interior vertex `(next − prev) / 6` and its negation, the others untouched, the closed wrap at both ends, open ends corners, fewer than three never wrap, a spike a corner, out of range a copy); `vertexRule` agrees with `courseObjectBodySchema` for every kind |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` "geometry editing on a selected object", "while drawing: a press places a corner…" | §7 "Editing geometry": the sampled outline and grips; Alt-drag → symmetric handles with one write (Shift 45°), a filter region's Alt-drag moves the vertex; Alt-click retracts (a corner: no write), a plain click focuses, a body click unfocuses, the focused handle drawn; a grip drag mirrored, Alt live breaks it; double-click on an edge inserts (inside, on a vertex, on a text: nothing); a press within reach of the edge is the object's; §6.4 the area tool's press places a corner, a drag past 3 px pulls handles (Shift 45°), the curved preview and its grips; Alt at the press a smooth vertex (the pull still wins, no Alt = a corner), Alt on the closing click wraps the first vertex and `onDone` carries no flags, the preview curves a smooth vertex towards the hover with no provisional grips and nothing written (D15) |
| unit (web) | `lib/editor/__tests__/geometry-gestures.test.ts` | §7 "Editing geometry" after D16's extraction: the pressing order (vertex, grip, edge within reach, the inside no press, the caller's body), a vertex drag in the caller's units (nothing until it moves), Alt-drag (Shift 45°) and Alt-click retract, focus (none for fixed kinds, the body unfocuses), a cancelled drag, insert on an edge (not on a vertex, not inside, not for fixed kinds), the shapes with the caller's ids; `bindings.test.ts` unchanged is the net for `selectBinding` |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` | §6, §7: V (Shift-click, lasso, object select / move / vertex, outlines, double-click leg; D12: for every closed kind an interior press declines, selected or not, an edge press within 7 px or the hit-test's outline target drags it, a vertex still wins; a line's stroke press is the object's), armed (exclusive, right-click, touch, ghost and leg length label, no UI-layer leg), area (vertex drag, first-vertex close), G (rim drag, click removes, leg) |
| unit (web) | `lib/__tests__/undo-stack.test.ts` | §6.1: `UndoStack.top`, which `Ctrl+Z` while armed checks before stepping the chain back |
| unit (web) | `lib/editor/__tests__/snap.test.ts`, `hit.test.ts`, `state.test.ts`, `structure-edit.test.ts`, `write-client.test.ts` | §6.2 snap candidates and distance; §5 object targets (stream and UI-layer outline); §6 Escape order, multi-selection, object selection, tools; §6.3 / §6.6 `setLegGaps`, `setNumberHidden`; §7 object tokens |
| E2E | `e2e/course-editor.spec.ts` "tools" | §6.1 ten controls in ten clicks with `K` (ghost, no UI-layer pending leg, the leg length label = the status bar, no action bar and no `editor-selection-ring` while armed, `Ctrl+Z`, `Esc`, the ring back on a click in `V`), reuse of a site; §5 / §7 the area-press rule (D12): a drag starting inside an `oob_area` (created through `courseObject.create`) moves the view (`data-centre-x`) and leaves the area unselected and unchanged, a click on its outline selects it (four handles), a drag inside the selected area pans and keeps the selection, a drag of its edge translates every vertex (one `courseObject.update`), a click inside deselects it; the armed `K` over the map: a `course-leg` piece of the course ends at the cursor's circle (absent before the hover, follows a second hover), no `editor-pending-leg`, the label = the status bar; a drag of the middle control shows two `editor-leg-length`, none after release; §6.5 Shift-click three controls → one add-to-course (one undo entry), §6.6 a site's notes written and reloaded; §6.3 a rim drag stores a circle gap, Reset gaps clears it; the layer draws what the tools store (D1's request path): a leg gap cuts the drawn leg, a circle gap is in the drawn site's cuts (`course-site` `data-cuts`), a hidden number leaves the site without its `course-label`; §6.4 / §7 an out-of-bounds area drawn, drawn on the canvas (709: purple inside it), its hatch (710) and border later set from the inspector (the stored props; 710 on the canvas is the shared layer path, probed in print only), printed (the all-controls `maps.pdf`: one page, the 709 hatch's clip-and-stroke operators present with the `all`-scoped area, one more run with `hatch: "710"`, gone when it is parked), selected again on the canvas (a click on its outline), deleted and undone; §6.4 / §7 "Editing geometry" a curved white-out in three clicks and one drag (two clicks, a click-drag that shows two `editor-polygon-grip`, the closing click): the stored vertex has `hOut` = the drag on paper and `hIn` its negation, the selection outline has 8 samples per curved segment, the all-controls `maps.pdf` gains exactly one curved fill (a fill path with `c` segments — the base map has its own); a double-click on a straight edge inserts a corner at its midpoint (handles 3 → 4), a click focuses it and `Delete` removes it (the object stays), `Ctrl+Z` brings it back, `Alt`-drag on a corner shows two more grips, `Alt`-click retracts them; §6.4 the Alt smooth vertex (D15): three clicks with Alt held at the second — no grips until the third lands, then two — store `g[1].hOut` = `(g[2] − g[0]) / 6` (and ≈ the clicks' chord on paper / 6), `hIn` its negation, corners at `g[0]` / `g[2]`, no `smooth` key stored, and one `Ctrl+Z` removes the object (one undo entry); a filter region hides the 505 path under it live (canvas ink probe) |
| integration | `packages/api/src/__tests__/integration/course-print.test.ts` "course objects on the page" | §7 print: the row's "reference-raster pixel probe" of a printed course object is this test's page raster, not the E2E's — no HTTP route rasterises a composed page, and poppler is on the runner for the unit / integration jobs, not the E2E job (coordinator 2026-11-01) |
| unit (web) | `packages/web/src/lib/editor/__tests__/checks.test.ts` | §8: sites and the explicit structure as `courseChecks` takes them, two controls 20 m apart, the server's `DESCRIPTION_STALE` merged in order, markers (rings, a leg cross, unpositioned skipped), length from the leg polylines, locate |
| E2E | `e2e/course-editor.spec.ts` "Course editor checks" | §8: two controls 20 m apart → the count beside the section title, the row (`CONTROL_TOO_CLOSE`, "20 m"), a marker on each site, the status-bar count; a click selects the first site and centres the view on the pair's midpoint |
| E2E | `e2e/course-editor-legacy.spec.ts` | the legacy page, unchanged (`chromium`) |
| integration | `packages/api/src/__tests__/integration/course-presence.test.ts` | §11: the heartbeat shows the others and never the caller; one row per client, moved by a new course or mode; the 30 s TTL (hidden at read, swept by the next beat; kept just inside it); the signed-in name; a row goes with its course; unknown course refused; `control.lastChange` names the actor and time |
| unit (web) | `lib/editor/__tests__/presence.test.ts`, `write-client.test.ts` | §11: `name · course · mode` entries (open course first, "Someone", distinct keys), `courseChangedElsewhere` (moved token, own write, first sight), the own-token set |
| E2E | `e2e/course-presence.spec.ts` | §11, two browser contexts: B in Field mode shows in A's bar as "‹course› · Field" (here), A in Course mode in B's; a move in A moves the control in B within the poll; A leaving ages out of B's bar (TTL); a control appended in A re-renders B's sequence with `editor-external-change`, none in A |
| unit (web) | `lib/editor/__tests__/field.test.ts` | §9, §10: the fix through `mapGeo` and back (a SWEREF99 TM frame), accuracy in paper mm, distance at two scales, bearing from paper north with the wrap at north, the list in course order (blank without a fix or a position), the nudge steps (0.1 mm, 1 m at 1:10 000 / 1:15 000, µm rounding), detent heights and snapping, the band offset, the initial mode |
| unit (web) | `lib/editor/__tests__/touch.test.ts` | §10 gestures: a selected control drags at once; an unselected one: tap selects, drag past the slop pans, long press selects and moves (also when a late move fires it), a second finger cancels; the lift; the loupe's constants and place (above the handle, flipped below the finger at the top, kept inside sideways) |
| unit (web) | `map-gl/__tests__/view.test.ts` "loupeView", `engine.test.ts` "the loupe" | §10 "Loupe": the view (the dragged point at the centre, distances × 2.5, the rotation kept); one more draw of the resident visible set into the inset target, composited at the box, no rebuild or worker request (`map-rendering.md` §5.2) |
| unit (web) | `lib/editor/__tests__/state.test.ts` "showSelectionRing" | §6.1: the selection ring is drawn in `V` and not while an exclusive tool is armed (D12) |
| unit (web) | `lib/editor/__tests__/state.test.ts`, `write-client.test.ts` | §9: Field entered and left keeping the selection, Layout entered dropping all but the course (`course-layout.md`); `checkControl` sends no token and seeds the control's |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` "pinch-scale" | §10: `scaleAbout` (handles scale with it), a finger on the ring starts it, the draft per move, one write on lift, nothing selected / cancelled / within 1 % writes nothing |
| E2E | `e2e/field-mode.spec.ts` (`mobile` project: Pixel 7, `vector`) | §10: opens in Field mode, full-bleed, compact bar and overflow, no rail / inspector, ≥ 44 px targets; §9: `setGeolocation` → the marker with its accuracy, every row's distance and bearing = the paper geometry at one scale; detents (tap, handle drag to full) and a list row's control centred above the sheet; a quick drag on an unselected control pans without selecting, a long press selects, shows the stem and the loupe (`editor-loupe`, 120 px, above the handle; the canvas inside it differs from the same circle after release — the 1× map — and has the map's purple; gone on release) and drops the control 48 px above the finger (persisted); two fingers cancel a pending press and zoom; nudge 2 × 0.1 mm, 1 m, the x field, four undos back; `+` → `K` → Place above the sheet adds a site, Done; a tap on an `oob_area`'s outline (created through `courseObject.create`) selects it, a tap inside deselects it (D12), and two fingers on its corners scale it by their spread, the map's zoom unchanged; check-off persists over a reload; offline: the notice, `+` disabled, a long-press move snaps back. "Field mode on a desktop" (desktop viewport in the same spec): the mode switch, no rail, the list's distance after a fix, check-off and `Ctrl+Z`, back to Course mode |
| unit, integration, E2E | `course-layout.md` "Tests" | Layout mode |

## Pending in this chapter

- **Selection highlight through the dynamic bucket** (04 §7: the
  selected object's passes redrawn in a highlight colour): the selection
  and multi-selection rings and object outlines stay UI layer; D5 left it
  because it is `map-gl` work outside its area (decision log, D5).
- **Course objects**: draw order (`courseObject.reorder`) has no control
  in the editor; no image (logo) tool; `inset_frame` is slice F's.
- **Description instructions** (finish variant, special instructions)
  are edited in the legacy editor only.
- **Course delete** stays on the Courses page.
- **Toner saver in print**: the course's `maps.pdf` carrying the smooth hull's `c` segments has no E2E of its own (the shared `objects.test.ts` case covers the layer's Bézier flags); D10's list.
- The rest of the E2E rewrite (the editor's touch subset in the `mobile`
  project, `course-editor.spec.ts` under `map-vector`) — D10.
- **Presence names without sign-in**: an instance with auth off lists
  every editor as "Someone" (the station name could stand in, D11 left it);
  "moved by X at T" has no name there either. No leave message: a closed
  editor shows for up to 30 s.
- **Who changed a course** (`course.lastChange`) reads the newest
  `course.upserted`, which includes control-move rebuilds that do not advance
  the course's token: after X's structure edit and Y's later control move the
  notice names Y. A token-matched lookup would fix it.
- **Own kind change**: `control.update` re-mirrors the dependent courses and
  advances their tokens without returning them, so a site's kind change made
  in the editor would show its own "changed elsewhere" line; the new editor
  has no such path today.
- **"Moved by X at T" has no E2E** of its own (unit and integration only); the
  two-context conflict E2E belongs to D10.
- **Mouse loupe**: a desktop or tablet mouse drag shows no loupe (§10
  "Loupe"); the same layer prop from the mouse branch would give one.
- **One-finger drag of a course object on touch** (its body or a
  vertex): a tap selects it and two fingers scale it (§10); moving it is
  the mouse's, or a later row with the object's own nudge.
- **Geometry editing on touch** (§7 "Editing geometry", §6.4): there is
  no Alt on touch, so curve vertices, the Alt smooth vertex, handles, grips, vertex insert and
  vertex delete are the mouse's; a touch-drawn area is a polygon. A later
  row could give the selection a vertex action bar (insert, delete,
  curve / corner).
- **Offline writes in Field mode** (§9 "Offline"): a queue for
  `control.update` / `control.check` with the field-move rebase on replay
  (row D9c).
- **Tablet bottom action bar** (08 §5.5 "Tablet: collapsible side
  inspector + bottom action bar"): a tablet keeps the desktop chrome and
  the action bar under the selection, with the touch gestures (§10).
- **Pin-drop for the area and text tools on a phone**: they arm from `+`
  and take taps on the map (§6.4), not the crosshair flow.
- **Layout on a phone**: the mode switch omits it (§10, decision log
  2026-11-03; 08 §5.5 keeps template editing on the desktop); aligning
  the map by touch would be its one use — D-mobile decides.
- **The selection ring in `V`** stays (D12 hides it only while a tool is
  armed); whether it should go entirely, now that the purple circle is
  the mark, is the user's call (feedback 2026-11-04, flagged).
- The colour-profile and north badge are the map-info row's, unchanged.
