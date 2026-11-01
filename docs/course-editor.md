# Course editor

Normative chapter for the new course editor: one editor on the GL canvas
of the vector pipeline, Course mode first (slice D). Research record:
`docs/research/vector-map-pipeline/08-course-editor.md` §5 (editing
experience), 04 §7 (hit-testing on the shared stage), 09 §3 (gated
reads); decisions in the research README's decision log (2026-11-01,
"D4"). The work queue is `SLICES.md` (rows D4–D11).

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
| Tool rail (`ToolRail.tsx`) | `editor-tool-rail` | `V` (select / move) only; D5 adds the creation tools |
| Action bar (`ActionBar.tsx`) | `editor-action-bar` | the selection's or phantom's entries, horizontal, centred under the selection, hidden during a drag; ids `editor-action-<id>` as the legacy popover's. The viewer positions it (`actionLayout: "bar"`); D9 docks the same list as the mobile bottom bar |
| Inspector (`Inspector.tsx`, `modes/CourseMode.tsx`) | `editor-inspector` | collapsible sections: course (create, sequence, visit order, clone), selection (code, kind, position, description summary, "also in"), inventory (`editor-inventory-panel`, collapsed), checks (`editor-checks`, placeholder until D6) |
| Status bar (`StatusBar.tsx`) | `editor-status` | the selected course's control count and length, the map scale (the sheet key is D8's, climb and checks D6's), the save state (`editor-save-state`, `data-state` = `saved` / `saving` / `error` / `conflict`) |
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
  so a click never waits a worker round trip. A hit-test request over the
  *document* stream (snapping, Map mode) arrives with D5.
- A drag stays a per-move layer request: the layer re-derives in the
  worker and the reply redraws (`map-rendering.md` §5.4). Main-thread
  symbolisation of the dragged object is not needed so far.
- The selection ring, phantom, affects-chip and action bar stay UI layer
  (screen space). Selection *highlight* through the dynamic bucket is
  Pending.
- With shared hit-testing the viewer renders no `editor-control-hit` /
  `editor-leg-hit` / `editor-label-hit` elements; it mirrors every editor
  site as a hidden `editor-site` (`data-x` / `data-y`, paper mm) next to
  the layer's `course-site` / `course-leg` mirror, which is what tests use.
  The legacy page leaves `sharedHitTest` off and keeps its SVG targets.

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
| E2E | `e2e/course-editor-legacy.spec.ts` | the legacy page, unchanged (`chromium`) |

## Pending in this chapter

- **Selection highlight through the dynamic bucket** (04 §7: the
  selected object's passes redrawn in a highlight colour): the selection
  ring stays UI layer; D5 (with multi-select).
- **Description instructions** (finish variant, special instructions)
  are edited in the legacy editor only.
- **Course delete** stays on the Courses page.
- **Tools, gaps, snapping, multi-select, course objects** — D5; **checks
  and KPIs** (climb, check count, leg distances from the layer) — D6;
  **Layout mode** — D7; **export menu, class view, sheet key** — D8;
  **Field mode, mobile chrome, loupe** — D9; the rest of the E2E rewrite
  and the `map-vector` / `mobile` projects — D10; **presence and "moved
  by X at T"** — D11.
- The colour-profile and north badge are the map-info row's, unchanged.
