# Course editor

Normative chapter for the new course editor: one editor on the GL canvas
of the vector pipeline, Course mode first (slice D). Research record:
`docs/research/vector-map-pipeline/08-course-editor.md` §5 (editing
experience), 04 §7 (hit-testing on the shared stage), 09 §3 (gated
reads); decisions in the research README's decision log (2026-11-01,
"D4", "D5"). The work queue is `SLICES.md` (rows D4–D11).

The legacy editor (`CourseEditorPage`) was retired in E3 (the flip,
2026-11-06) and deleted with its chapter in E4b; the repository history
keeps both. The server behaviours it shared with this editor live in
their own chapters: description autodetect in
`course-controls-and-matching.md` "Description autodetect", automatic
cuts in `course-layer.md` §3.4, the control number in `course-layer.md`
§3.5.

## 1. Route and modes

`/:nameId/course-editor` (shell overflow menu → "Course Editor"; the
pencil icons of the Courses and Controls pages deep-link here) mounts
through `CourseEditorRoute` (`pages/editor/CourseEditorRoute.tsx`):

```
mount = new editor          (every event, since E3)
```

There is no gate any more (the slice D flag `map.editor.vector` and the
per-event switch are gone, `map-pipeline-switch.md` history note). The
map panel inside the editor answers the cases without a drawable map
(`map-rendering.md` §5.4 "Selecting the layer"):

- **No map at all**: the editor mounts and its `MapPanel` shows the
  upload prompt (*Upload map*, *From club library*) where the canvas would
  be; the rail, inspector and course lists work, the canvas tools have
  nothing to act on until a map is uploaded. Decided overnight by the E3
  session (for user review): the least new UI — the panel's existing
  prompt, no editor-specific empty state.
- **A map without a pinned document**: the import state
  (`map-import-state`), not tiles.
- **No WebGL2 / a lost context**: the layer's message (§5.4 "Layer").

**URL** (F31; `feedback-2026-11-11-merge.md` item 4 and answers 1–2).
The address bar follows the editor's key modes, so a reload or a shared
link restores them (`lib/editor/url.ts`: `parseEditorUrl`,
`editorSearchFor`):

| Param | Value | Absent |
|---|---|---|
| `course` | the selected course's seq | no course |
| `mode` | `layout` \| `field`; on a phone also `course` | Course mode (a phone: Field, §10) |
| `view` | `all` \| `class` \| `variant` \| `all-variations` | Course view |
| `class` | Class view's class (seq), with `view=class` | — |
| `variant` | Variant view's key, with `view=variant`; in Class view and Layout the variant drawn when it is not the first (F8) | the first variant |
| `sheet` / `template` | Layout's shown sheet or template (seq), with `mode=layout` | — |
| `control` | inbound only: the Controls page's pencil (`?control=<id>`, the control's id) | — |

- **Written by `replace`, never `push`** (answer 1): every change of
  course, mode, view, class, variant or Layout's sheet replaces the
  history entry, so Back leaves the editor in one step. The query is
  written in the table's order with the defaults left out; params the
  editor does not own are kept. `layoutEditorHref` builds its link with
  `editorSearchFor`, so it lands already canonical.
- **Never written** (answer 2): the selection (control, leg, object), the
  tool, the phantom and the preferences (hide other controls, snapping,
  the placement loupe). `control=` is read once and gone from the first
  write.
- **Read once, checked against the data.** The editor reads the URL when
  it mounts and takes each param as the data that checks it loads: the
  course against `course.list`; Class view's class against the course's
  classes (`layout.classOverrides`); a variant and *All variations*
  against the course's structure (a course without variations has
  neither); `control` against the control list; Layout's sheet and
  template against `courseMap.list` / `mapTemplate.list` (`useLayoutMode`
  drops an unknown target to its default). The URL is written only once
  every param is taken or dropped (`hydration` in `EditorPage`). The query
  cache is persisted (offline-first) and fresh for 5 s, so a value found
  in it is taken, but a miss counts only after a fetch since the page
  mounted (or a failed one): a link to a sheet or course made since the
  last answer is not dropped (`checkInbound`, `fetchIfIdle`).
- **An invalid param falls back to its default and leaves the URL**: a
  value of the wrong shape (`mode=bogus`, `course=abc`), a course,
  class, variant, sheet or template that is not the event's (a deleted
  course selects none), a `class` without `view=class`, `view=class`
  without a class, a `sheet` outside Layout. Nothing reports it.
- **Mode.** The URL's `mode` wins on every device; with no `mode` a phone
  opens Field (§10), the desktop Course (`initialModeFor`). `mode=field`
  is always written, so a link from a phone opens Field on a desktop too.
  A phone in Course mode writes `mode=course` (Course is not its
  default), so a reload keeps it; a desktop omits it. `mode=layout` on a
  phone opens Field and leaves the URL (Layout is a desktop mode, §10).
- **Inbound links** keep working unchanged: the Courses page's pencil
  (`?course=<seq>`), the Controls page's (`?control=<id>`), the Courses
  page's *Edit layout* (`layoutEditorHref`, `course-layout.md` §4) and
  the retired pages' redirects. The editor rewrites them to their
  canonical order once taken.

**Modes** (08 §5.1): Course, Layout, Field share one canvas, selection and
undo history. Course mode is this chapter; **Layout mode** — the sheet as
the view, course edits locked — is `course-layout.md`; Field mode is D9's
(§9; the initial mode on a phone, §10). The **view** picker
offers *Course* (the selected course full-strength, other controls faded)
and *All controls* (every site with its code, no legs; the inspector keeps
the selected course). *Class* (`editor-view-class`, a picker of the
selected course's classes) is the course as that class prints it —
`course-layout.md` §6 "Class view". A variant view is F7's; there is no setter view (slice F split): a setter map is a sheet and a Field-mode pick (§9, `course-layout.md` §8).

## 2. Anatomy

The editor renders inside one `MapPanel` (unchanged), whose fullscreen
subtree holds everything: the panel's toolbar row carries the top bar,
its in-map strip (`mapOverlay`) the tool rail and the inspector,
and the description editor is its `fullscreenOverlay`. So fullscreen (the
panel's own button and Keyboard Lock on Escape) keeps the whole editor.
The lock is taken once per fullscreen session, keyed on the editor being
present rather than on the editor prop object, which changes on every
hover with an armed tool; re-locking per render made Chrome re-show its
exit bubble on every pointer move
(`docs/bugfix-fullscreen-bubble-flicker.md`, `e2e/editor-fullscreen.spec.ts`).

| Part | `data-testid` | What it holds |
|---|---|---|
| Top bar (`TopBar.tsx`) | `editor-top-bar` | course picker (`editor-course-picker`; roots and plain courses — a materialised variant is edited through its root, §12), view (`editor-view-course` / `-all` / `-class`, and for a course with variations `editor-view-variant` (Variant ▾) and `editor-view-all-variations`, §12), mode (`editor-mode-course` / `-layout` / `-field`; icons alone when the row is short, "Top bar" below), undo / redo (`editor-undo` / `-redo`), hide other controls (`editor-hide-others`), auto cuts (`editor-toggle-cuts`), the placement loupe toggle (`editor-placement-loupe`, a magnifier, lit — `aria-pressed` — when on; §10 "Loupe", F27), Export ▾ (`editor-export`, icon + label, `course-layout.md` §7), the map info (`editor-map-info`, below), the course-info button and the save indicator (below), who else has a course open (§11), help popover; MapPanel adds descriptions, fullscreen and the viewer its zoom on the same row |
| Tool rail (`ToolRail.tsx`; Layout mode: `layout/LayoutRail.tsx`, `editor-layout-rail`, `course-layout.md` §3) | `editor-tool-rail` | `editor-tool-<key>` for `V`, `S`, `K`, `M`, `X` (map exchange, §6.9), `C` (crossing point, §6.8), `A` (menu `editor-area-menu`, `editor-area-<kind>`, and `editor-area-corridor` — §6.7), `T`, `G`; the snapping toggle `editor-snapping` (§6) |
| Action bar (`ActionBar.tsx`) | `editor-action-bar` | the selection's or phantom's entries, horizontal, centred under the selection, hidden during a drag; ids `editor-action-<id>` as the legacy popover's. Always inside the viewer, 8 px from its edges (`lib/editor/action-bar-place.ts`): near a side it is shifted sideways, and when it does not fit below the selection it goes above it (`data-placement="below" \| "above"`). It is never wider than the viewer less 16 px. The *Also in* line is one line cut with an ellipsis, with the whole list in its `title` (the inspector lists the courses too) (`docs/bugfix-action-bar-off-viewer.md`). The viewer positions it (`actionLayout: "bar"`); on a phone the same list is the bottom sheet's peek row (`actionLayout: "host"`, §10) |
| Inspector (`Inspector.tsx`, `modes/CourseMode.tsx`, `modes/ObjectSection.tsx`) | `editor-inspector` | collapsible sections: course (create, sequence — a variation group as a nested block `editor-variation`, §12 —, visit order, description sheet — `editor-description-instructions`, §4 —, clone), selection (a site: code, kind, position, description summary, "also in", hidden number, notes — §6.6; several controls: `editor-multi` with the bulk actions — §6.5; a course object: `editor-object` — §7; a leg: `editor-leg` — §6.7, `modes/LegSection.tsx`), inventory (`editor-inventory-panel`, collapsed), checks (`editor-checks`, §8) |
| Map info (`MapInfoDialog.tsx`, model `lib/editor/map-info.ts`; P6) | `editor-map-info` → `editor-map-info-dialog` | a map icon button (`IconMap`, `components/map-icons.tsx`) in the top bar right after Export ▾ (`aria-haspopup="dialog"`, `aria-expanded`); a click opens a modal (`role="dialog"`, `aria-modal="true"`, centred over a dimmed backdrop; the close button `editor-map-info-close`, a backdrop click or Escape closes it). Its header shows the map's file name (`editor-map-info-name`, `data-name`) or, without a map, `editor-map-info-none`. Its rows, each only when it has a value: the scale `editor-map-info-scale` (`data-scale`, `1:10 000`), the north lines `editor-map-info-north` (the `NorthLinesBadge` sentence, `north-lines-badge` with `data-north-lines`; *No magnetic north lines found* when the file has none), the file `editor-map-info-file` (size and upload time, `data-bytes`, `data-uploaded`); then the document section `editor-map-info-document` (`data-source`, `data-objects`, `data-symbols`, `data-colours`; read from the loaded document's header, absent while it loads or the import runs) with `editor-map-info-source` (OCAD and its version, or OpenOrienteering Mapper), `-content` (objects · symbols · colours), `-symbol-library` (the matched symbol library and version; not `-library`, which is the action below), `-crs` (EPSG code and name) and `-importer`. Its actions: *Review symbols* (`editor-map-info-review`, a link to `/<event>/map-review/<documentHash>`, only once the document exists — `map-symbols.md` §8.7), *Replace map* (`editor-map-info-replace`; *Upload map* without a map; the hidden `accept=".ocd"` input), *From club library* (`editor-map-info-library`, only when the club library lists a map; opens `club-map-picker`, `club-library.md`). An upload's progress, error and the stale-north-lines notice (`map-upload-notice`) show in the dialog's footer |
| Course info (`EditorStatus.tsx` `StatsButton`, model `lib/editor/status.ts`) | `editor-stats` → `editor-stats-popover` | an icon button in the top bar (`aria-haspopup="dialog"`, `aria-expanded`) with the check count as its amber badge (`editor-stats-badge`, `data-count`, absent at zero, §8); a click opens the popover (`role="dialog"`; a second click, an outside click or Escape closes it — Escape closes only the popover, the editor's Escape cascade of §3 is not stepped, so an armed tool stays armed). Its rows, each only when it has a value, in this order: `editor-stats-controls` (`data-count`), `editor-stats-length` (`data-m`), `editor-stats-climb` (`data-m`), the shown sheet's key in Layout mode and Class view (`editor-stats-sheet`, `data-key`, `course-layout.md` §6), `editor-stats-snapping` when on, `editor-stats-checks` (`data-count`, amber). No map scale since P6: it is the map-info dialog's (`courseInfoRows`). With no course and no sheet the popover says *No course* |
| Save indicator (`EditorStatus.tsx` `SaveIndicator`) | `editor-save-state` | in the top bar after the course-info button: a dot and the save state's words (`data-state` = `saved` / `saving` / `error` / `conflict`, `role="status"`, `aria-live="polite"`, the words also its `title`). `saved` / `saving` are the dot alone (green / grey pulsing; the words `sr-only`), so P2 adds a dot (≤ 16 px) and an icon button (≤ 32 px) to the top bar's row (how the row makes room on a laptop screen: "Top bar" below, F29); `error` / `conflict` show their words (`editor-save-state-text`, red) at every width — a failed or conflicting save never hides behind a popover or a tooltip |
| Conflict notice | `editor-conflict` | §3 |
| Field mode (§9) | `editor-inspector-field`, `editor-field-selection`, `editor-nudge-pad`, `editor-field-offline` | the control list with distance / bearing and check-off in place of the sequence; the selection's distance, check-off and nudge pad; no tool rail |
| Phone chrome (§10) | `editor-field-top-bar`, `editor-overflow`, `editor-sheet`, `editor-field-add` | below 640 px: the compact top bar, the bottom sheet (peek: the status line `editor-status` — `StatusBar.tsx`: `editor-status-kpis`, `editor-status-checks`, `editor-save-state` —, selection, action bar) and the floating `+` instead of the top bar, rail and inspector strip above |

**Top bar: icons when the row is short** (F29, feedback-2026-11-11 item 2
and answer 3). The row is `MapPanel`'s `map-toolbar`, a CSS size container
(`@container/toolbar`, `container-type: inline-size`); the top bar
collapses on that row's content width (inside its padding), not the
viewport's, so the same rule holds
in fullscreen, with the shell's container (F28) and in a narrow window. The
classes are `components/top-bar-collapse.ts` (`TIER1_PX`, `TIER2_PX` and the
literal Tailwind `@max-[…px]/toolbar:` strings):

| Row content width | What shows |
|---|---|
| ≥ 1600 px | every label |
| < 1600 px (tier 1) | the labels of `editor-hide-others`, `editor-toggle-cuts`, `map-toggle-descriptions` (MapPanel's, in the editor only — `labelClassName` is set when the panel has an `editor`, so other pages' map panels keep the `sm` rule alone) and `editor-export` are hidden, and the course picker's *Course* word; the buttons show their icons (Export ▾ is icon + label + ▾ since F29, `IconExport`) |
| < 1170 px (tier 2) | in addition the mode switch shows its icons alone: `IconModeCourse` (a start triangle, a leg and a control circle), `IconModeLayout` (a sheet with its map frame and title bar), `IconModeField` (a control flag), `components/map-icons.tsx` |
| narrower still | `flex-wrap` on the top bar, the last resort |

The view group (Course · All controls · Class ▾ · Variant ▾ · All
variations) stays text at every width. A hidden word is `display: none`;
every control keeps its test id and its accessible name: the toolbar
buttons through `aria-label` (as on a phone), the mode buttons through
`aria-label` and `title` (the word, also the tooltip), the course picker
through `aria-label` (its `<label>` word may be hidden), Export ▾ through
`aria-label` "Export ▾". Below `sm` (640 px) the phone chrome replaces the
top bar (§10) and `ToolbarButton`'s own `sm` rule still hides every label.

The thresholds are measured (`e2e/editor-top-bar.spec.ts`, the E2E seed's
widest row: *Bana 1* with its Class ▾): the full row's content is 1346 px
in English and 1374 px in Swedish; a course with variations adds Variant ▾
and All variations (about 200 px), so tier 1 starts below 1600 px. Tier 1
saves about 385 px (410 px in Swedish), leaving at most about 1161 px with
variations, so tier 2 starts below 1170 px; it saves about 60 px more.
Presence chips (§11) and long course names (the picker is capped at
10 rem) can still wrap the row below that. At 1840 × 1090, the user's
laptop, the row's content is about 1760 px with F28's wide editor, so
every label shows (in the boxed `max-w-7xl` it had before F28 it was
1190 px, tier 1): one row.

**No status bar on the desktop** (P2, feedback 2026-11-06 item 3): the
status bar under the inspector took room on small laptop screens. Its
save state is the top bar's save indicator, everything else the
course-info popover; the pending leg's length is read at the pointer
only (§6.1). The phone keeps the status line in its sheet's peek row
(§10), where the top bar has no room for the indicator.

**No map footer** (P6, feedback 2026-11-07 item 3): the legacy editor's
map-info row under the map (MapPanel's `showMapInfo`: file name, north
lines badge, *Review symbols*, *Replace map*, *From club library*) is
gone with the prop, so the map reaches the panel's bottom. Everything it
held, with the map scale (out of the course-info popover) and the
document's details, is the map-info dialog behind the top bar's map icon
(table above). The upload and club-picker logic is
`components/useMapReplace.ts` with `components/ClubMapPicker.tsx`, shared
by MapPanel's drop zone (no map yet; its *Upload map* and
`use-club-map` stay on every page) and the dialog; each caller keeps its
own progress and error, and a success refreshes `course.mapFileInfo` and
`course.mapMetadata` through the query cache, so the editor and the
panel follow either. The dialog is a modal: Escape closes the club
picker, then the dialog, and never steps the editor's Escape cascade
(§3), so an armed tool stays armed and a selection stays selected; while
it is open no key reaches the editor's shortcuts (a window capture-phase
listener), focus starts on its close button and Tab / Shift+Tab cycle
inside it (or inside the club picker over it). The top bar mounts its button, which owns the upload state
(an upload started in the dialog survives closing it); the dialog is
portalled to the fullscreen element when there is one (MapPanel's root,
so it shows in fullscreen) and to the body otherwise — the top bar's row
is a stacking context under the shell's header, which an in-place layer
could not dim. Desktop only: the phone's top bar is `FieldTopBar` (§10), which
has no map icon. The *Use new map engine* toggle went with the switch in
E3, the colour-profile select with the legacy raster in E4a, the
footer's *Show all controls* toggle (dead in the editor, which passes a
toolbar) with the footer in P6.

**The editor fills the window** (F28, user 2026-11-11,
`feedback-2026-11-11-merge.md` item 1): outside fullscreen the editor is
not boxed. The shell gives the `course-editor` route the wide container at
every viewport width, not only from 2200 px: the header's inner row and
`shell-container` are `w-full` with the shell's side padding
(`px-4 sm:px-6 lg:px-8`), and the container's vertical padding is `py-3`
instead of `py-6`. Every other route keeps `max-w-7xl` (1280 px) below
2200 px and the two-pane layout above it; the editor publishes no map props,
so at 2200 px and up the shell's map pane stays hidden on its route.
`editor-page` is `h-[calc(100dvh-99px-1.5rem)]`, `min-h-[420px]`: the
viewport less the shell's header (99 px: the 56 px row, the 42 px tabs row
and the header's 1 px border) and the container's `py-3` (1.5 rem), so the page is
exactly one screen with no band under the editor (the legacy
`calc(100dvh - 200px)` left about 50 px). The banners above the content —
the clock-skew banner and a card notification — are in flow and not
subtracted: while one shows, the page scrolls by its height. The
phone's `fixed inset-0` (§10) and fullscreen (MapPanel's root) are
unchanged. The class names the header's height as a constant, so a change
to the shell's header (`CompetitionShell.tsx`) updates it too. The
inspector's height follows the editor's: when its open sections do not fit,
each shrinks and scrolls its own content (`InspectorSection`'s body is
`overflow-y-auto`) rather than painting over the next section's header,
which at 1280 × 720 hid the Leg section's *Crossing section* box under
*Checks*.

## 3. Selection, undo, autosave, conflicts

**Selection** (`lib/editor/state.ts`): the legacy reducer
(`lib/course-editor.ts` — selected course, selected control, phantom with
an optional insert position) plus mode, view and *hide other controls*.
Escape steps back: phantom → control → course; with nothing left it
leaves fullscreen. A mouse drag in flight is cancelled first (F24; user
answer 2026-11-11): the viewer ends it before the cascade — a control or
a number snaps back and nothing is written (no `control.update`, no
`course.setControlLabelOffset`, no `setStructure`), a tool's gesture
gets `onPointerUp(null)` (a bend, grip or object drag drops its draft,
a lasso selects nothing), and the loupe goes (§10 "Loupe"). The cascade
then runs as without a drag; the release that follows does nothing
(`lib/editor/mouse-drag.ts` `escapeCancels`; a touch drag is left
alone). `H` toggles hide-others (needs a course); a course
change switches it off with the course.

**One gesture, one write, one undo entry.** `UndoStack(50)` of inverse
pairs; an entry whose undo / redo fails is dropped and the error shown.
There is no save button: every write goes out as the gesture ends and the
top bar's save indicator (§2; on a phone the sheet's peek line, §10)
says *Saved* / *Saving…* / *Not saved* / *Changed elsewhere*.
Undo / redo bump the viewer's `moveEpoch` so an undone move renders at the
restored position.

**Tokens** (`lib/editor/write-client.ts`, `EditorWrites`): every
`course.setStructure`, `course.update { descriptionInstructions }`
(`setInstructions`, §4) and `control.update` sends `baseVersion` from a
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
`removeSite` (every visit), `removeVisit` (one), `moveVisit`, `setRole`,
for a leg `setLegProps` — §6.7 — and the group edits of §12)
in **control-sequence positions** — the items between an explicit leading
start and trailing finish, of the **displayed path** when the course has
variation groups (each group shown by its displayed alternative, §12). An
item whose predecessor changes loses its
`leg` (its gaps, bends and corridor described the old leg); the item after
a group keeps its leg while the group changes. The editor's first save of a
course makes it explicit (`explicitStructure`, `lib/editor/sequence.ts`):
the start and finish it is drawn with — the event default completing an
implicit one — become items (`course-layer.md` §6.2). The inspector's rows
are `displaySequence` (start, controls, finish) with per-leg metres
(`sequenceLegMeters`: paper mm × scale / 1000); a course with a map
exchange lists its parts (§6.9).

| Gesture / entry | Write | Undo |
|---|---|---|
| click empty map | phantom (`editor-phantom`) + action bar: **Add control** / **Add start** / **Add finish** / **Add map-issue point** (§6.8), with a course also **Add to ‹course›** | — |
| Add control | `control.create { codes, xpos, ypos, autoDescribe }` (code from the club allocation, `editor-alloc-series` overrides the series; SRR codes get radio); the new control is selected with `V`'s ring and the action bar (§6.1, P4) | `control.delete` / redo `control.restore` |
| Add to ‹course› (phantom) | create + `setStructure(appendSite)` | `setStructure(prev)` + delete / restore + `setStructure(next)` |
| Add start / finish | code-less `control.create { status: 4 / 5 }` (named "Start N" / "Mål N") | delete / restore |
| **Add map-issue point** (§6.8) | code-less `control.create { kind: "map_issue" }` (named "Kartutdelning N") | delete / restore |
| `X`, click (§6.9) | `control.create { codes, kind: "map_exchange", … }` + `setStructure(insertSite)` at the insertion point; over an existing exchange only the `setStructure` | as Add to ‹course› |
| `C` on a selected leg, click (§6.8) | `control.create { kind: "crossing_point" }` + `setStructure(setLegProps { crossing })`; over an existing crossing point only the `setStructure` | as Add to ‹course› |
| Leg section: crossing ✕, *section* (§6.8) | `setStructure(setLegProps { crossing })` | `setStructure(prev)` |
| click a leg (selected course) | phantom with the insert position (`insertIndexForLeg`: before the row the leg ends at, last when it ends at the finish) + **Insert into course**; the phantom is the **selected leg** — the inspector's *Leg* section (§6.7) and, on desktop and tablet, **Add bend here** | — |
| Leg section: style, bends ✕, corridor *Add* / fields / *Remove* (§6.7) | `setStructure(setLegProps)`: the item's `leg` patched, its other props kept | `setStructure(prev)` |
| **Add bend here** (leg phantom) | `setStructure(setLegProps { bends })`: a **smooth** bend at the nearest point of the nearest segment (`insertBendAt`; F16) — `Alt` held on the click: a corner | `setStructure(prev)` |
| **Create variation here** (a top-level leg phantom, desktop and tablet; §12) | `setStructure(createGroup)`: a group with empty alternatives A and B between the leg's ends; A is shown and active | `setStructure(prev)` — the group and its variants go |
| variation block: a tab (`editor-variation-tab-<label>`), `1–9` on the selection's group (§12) | — the alternative shown in Course view and where `K` goes | — |
| variation block: ＋ (`editor-variation-add`), ✎ / double-click a tab (`editor-variation-rename`, `-label`), ✕ (`editor-variation-remove`), *Loop* (`editor-variation-loop`), a row dropped on a tab | `setStructure(addAlternative / renameAlternative / removeAlternative / setLoop / moveToAlternative)` | `setStructure(prev)` |
| drag a bend handle (`V`, selected leg) | one `setStructure(setLegProps { bends })` on release, the bend's handles moved with it | `setStructure(prev)` |
| drag a bend grip (`V`, selected leg; F16) | one `setStructure(setLegProps { bends })` on release: that handle moved, the pair mirrored unless `Alt` | `setStructure(prev)` |
| `Alt`-click a bend handle, or the bend row's **Smooth** / **Corner** (F16) | one `setStructure(setLegProps { bends })`: the bend corner ↔ smooth | `setStructure(prev)` |
| `Delete` / `Backspace` with a focused bend | `setStructure(setLegProps { bends })` without it | `setStructure(prev)` |
| `A` → **Corridor on selected leg** (`C`) | `setStructure(setLegProps { corridor })` with the default corridor | `setStructure(prev)` |
| Insert into course | create + `setStructure(insertSite)` | as Add to ‹course› |
| click a control | select; action bar: **Add to ‹course›** (append), **Remove from ‹course›** (every visit), **Reset number position**, **Radio** / **Radio off** (SRR swap offer as legacy), **Edit description**, **Delete control**; a start / finish not used by the course offers **Use as start / finish for ‹course›** (`setRole`) | `setStructure(prev)`; radio is not undoable (as legacy) |
| drag a control | one `control.update { xpos, ypos, autoDescribe: true }` on release (none after Escape or a mouseleave, §3); affects-chip "Affects: …" for shared controls; during the drag the layer follows at the worker's rate (`map-rendering.md` §5.2 "Engine", F20) | `control.update` with the old position and description |
| drag a number | `course.setControlLabelOffset` on release (none after Escape or a mouseleave, §3) | the previous offset |
| Delete / Backspace, **Delete control** | confirm, `control.delete` (the server cascades it out of every structure) | `control.restore` + `setStructure(before)` for every course that held it (read with `course.detail` before the delete) |
| **Edit description** | modal `ControlDescriptionEditor` → `control.update { description }` | the previous description |
| after a move of a hand-described control | one *Suggested: …* row in the action bar (`control.suggestDescription`) | the previous description |
| inspector ↑ / ↓, drag a row | `setStructure(moveVisit)` | `setStructure(prev)` |
| inspector ✕ | `setStructure(removeVisit)` (that visit) | `setStructure(prev)` |
| inspector code | inline edit → `control.update { codes }` | the previous codes |
| visit order | `setStructure({ orderMode })` | `setStructure(prev)` |
| description sheet: finish variant (`editor-finish-kind`), finish length (`editor-finish-length`), special row add / anchor / kind / length / remove (`editor-add-special`, `editor-special-row` → `-after`, `-kind`, `-length`, `-remove`) | `course.update { id, descriptionInstructions, baseVersion }` — the whole value, with the course's token | `course.update` with the previous value (`null` when there was none) |
| create / clone | `course.create` (suggests classes without a course; an exact name links it) / `course.clone` | not undoable (no `course.restore`) |
| auto cuts | `course.setOverprintCuts` | not undoable (an event setting). The GL layer, the vector print and the legacy geometry follow it (`course-layer.md` §3.4, D17): off, no automatic slits or leg gaps; stored circle and leg gaps still draw. The canvas redraws once the toggle's `course.getOverprintCuts` refetch answers |

Free-order courses show codes instead of numbers and no legs or leg
metres, as before. The description sheet is MapPanel's (on by default on
desktop, all controls until a course is selected).

**Description instructions** (E3b; `courses.description_instructions`,
`control-descriptions-and-editor-geometry.md` "Course-level
instructions"). The course section's *Description sheet* block
(`editor-description-instructions`) is collapsed to one summary line
(`editor-instructions-summary`: the finish variant and the instruction
count) so the sequence keeps the inspector's height; opened, it edits:

- the **finish variant**, the options of `FINISH_OPTIONS`
  (`lib/control-description-options.ts`): 14.1 taped route to finish, 14.2
  navigate to the finish funnel, 14.3 no tapes — labelled by
  `iofSymbolName`. A course with none shows (and prints) 14.3;
- the **finish length** in metres: blank prints the measured
  last-control → finish distance, as before;
- **special-instruction rows**, the options of `SPECIAL_OPTIONS`
  (13.1–13.6), each after the start or after one of the course's controls
  (public id; a control visited twice gets the row after every visit, as
  the sheet builds it), with an optional length printed in the symbol.
  *Add instruction* appends 13.1 after the start.

The pure edits are `lib/editor/instructions.ts` (`setFinish`,
`addSpecial`, `updateSpecial`, `removeSpecial`; lengths that are not
positive drop, metres are whole, an empty value is `null`). The block shows
the stored value with the specials anchored off the course left out
(`instructionsOnCourse`; the sheet drops them and `setStructure` prunes
them), and the page shows its own last write — a gesture's, an undo's or a
redo's — until `course.list` carries it, so a second edit builds on the
first. Gestures queue behind each other so each write sends its
predecessor's token; one queued behind a refused write is dropped with it
(it was built on the refused value). The write is the existing
`course.update` with `descriptionInstructions` alone: the course's token
is checked as `setStructure`'s, a stale one is a course conflict
(`refresh`, never merged, §3), and the structure, its mirror and geometry
are not touched (it is not the linear shortcut). The token it returns
counts as this client's own (§11). The on-map sheet reads the value from
`course.list`; Layout mode's block and the print read it through
`resolveSheet` / `courseMap.list` (`course-print.md` §5.1, §6.2), whose
query the write invalidates. Desktop inspector only: the phone has no
inspector (§10).

## 5. Hit-testing and the UI layer

The editor hit-tests the course layer's **symbolised shapes** on the
shared stage (04 §7; `map-rendering.md` §5.5), not SVG hit targets:

- Every course reply carries the layer's hit index —
  `hit: { stream, refs }`, the symbolised pass stream with layer-local
  object ids and each object's `ref` (`site`, `leg`, `number`, `leader`,
  …) — and `CourseInfo` hands it to the viewer.
- On pointer-down the viewer (any `editor`) converts the point to paper
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
- The filter region's **eyedropper** (§6.4) asks the *document* which
  symbol is under a click, also on the main thread
  (`lib/editor/symbol-pick.ts`, built once per document hash like the
  snap index): the objects whose stored box, grown by the tolerance,
  holds the point are symbolised with the shared stage
  (`documentRenderInput(doc, { only })`, `map-document-format.md` §8;
  `render.symbolise` without fonts) and hit-tested with
  `render.hitTest`. The **topmost** hit within the tolerance wins (6 CSS
  px) — not the nearest, as for the course layer: a map has areas under
  everything, whose interior is distance 0, so the nearest rule would
  always pick the area; topmost picks what is drawn on top near the
  click (a path beside it, the open land under it away from it). Hidden
  symbols are never picked; texts are picked by their stored box (no
  fonts on the main thread) and count as on top. Nothing goes to the
  worker.
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
- A leg with **no line** — `style: "none"`, or a `line` leg with a
  corridor (F14): `course.legLine(leg) === null`, the layer's own
  predicate (`course-layer.md` §10.1–10.2) — has no layer object, so no
  hit-index piece: the viewer passes the derivation's pieces of such
  legs as `UiLeg`s (`uiLegsOf`), which hit
  within the tolerance of their polyline after the layer's objects and the
  UI sites and before the UI areas, as `{ kind: "leg" }` — a leg made
  invisible stays selectable (§6.7), and so does a corridor leg along its
  hidden line (the guide marks it, §6.7). A corridor's edge (`ref`
  `corridor`) is no target.
- Every drawn control of the course is also a UI site (`uiSites`, its
  centre and the circle's radius), hit after the layer's objects: a
  circle with gaps, or opened by a corridor (F19, `course-layer.md`
  §10.2 — drawn, never a cut), is open arcs whose interior does not hit,
  so a click at its centre selects it through this fallback. A whole
  circle hits in the layer first, so nothing changes for it.
- While an armed tool's provisional visit is drawn (§6.1) only real sites
  are targets: `editorHitAt`'s `accept` passes over everything else and
  over the `provisional` site, so the shape below (a control to reuse)
  is found through the cursor's own circle.
- A drag stays a layer request: each move updates the input, the engine
  keeps one request in flight and posts the latest when it answers
  (`map-rendering.md` §5.2 "Engine", §5.4), so the circle follows at the
  derivation rate (F20, `docs/bugfix-course-drag-redraw.md`). Main-thread
  symbolisation of the dragged object is not needed so far.
- The selection ring, phantom, affects-chip and action bar stay UI layer
  (screen space), and so does everything a tool draws (§6: ghost, leg
  length, polygon, handles, gap arcs, lasso, multi-selection rings, object
  outlines — `editor-tool-layer`) and a dragged control's leg lengths. The
  armed tools' pending legs are the layer's (§6.1). Selection *highlight* through the
  dynamic bucket is Pending.
- Hit-testing is the shared stage's only (E4b deleted the SVG hit
  targets and the `sharedHitTest` opt-in); the viewer mirrors every
  editor site as a hidden `editor-site` (`data-x` / `data-y`, paper mm)
  next to the layer's `course-site` / `course-leg` mirror, which is what
  tests use. A map whose colour stack the course layer cannot draw on
  (`CourseStackError`, `map-rendering.md` §5.4 "Fallback") has no hit
  index: its editor cannot select or drag until the map is re-imported.

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
tool's press places a corner (§6.4, F18). `onPointerDrag` returns the
point the drag placed, paper mm — the snapped bend, a bend's or an
object's grip, an object's vertex; nothing for a body drag, a lasso or
within the slop — and the viewer draws the touch stem and the loupe at
it (F23), or the mouse loupe above the cursor (F24, §10 "Loupe"). A
placing tool (`S`, `K`, `M`, `X`, `C`, `T`) sets `hoverPoint`: the point a
click (or *Place*) would drop now, paper mm — the provisional point,
snapped, or a reused site's centre (`placeBinding`: the ghost's `at`;
`textBinding`: the page's snapped hover); null without a hover. Only those
tools set it, so "a placing tool is armed" is `hoverPoint !== undefined`,
and the viewer magnifies it for the placement loupe (F27, §10 "Loupe")
without snapping or resolving a reuse itself. A tool that sets
`touchPress` is offered one-finger presses on a coarse pointer too,
before the viewer's own targets, with `touch` set on the pointer (V with
a selected leg, §6.7 "Tablet"; every other press stays the viewer's
touch rules, §10). Tools draw UI-layer shapes
in paper mm (`ToolShape`: circle — true size, line, handle, grip — a
screen-size Bézier handle on a thin line from its vertex — and text). The tool state is `EditorState.tool`
(`lib/editor/state.ts`); an active tool opens no action bar.

| Key | Tool | |
|---|---|---|
| `V` | select / move | the default; §4, plus Shift-click, lasso, objects (§6.5, §7) |
| `S` / `K` / `M` | start / control / finish | armed, §6.1 |
| `X` | map exchange | armed, a control in §6.1's chain (§6.9) |
| `C` | crossing point | armed, §6.8 (with the `A` menu open, `C` is its *Corridor on selected leg*, §6.4) |
| `A` | areas | a menu: out-of-bounds area, out-of-bounds line, white-out, filter region, toner saver, marked route (§6.4); *Corridor on selected leg* (§6.7) |
| `T` | map text | one click places it (§7) |
| `G` | gaps | on the selected circle or leg (§6.3) |
| `L` | placement loupe | toggles the loupe over a placing tool's hover (§10 "Loupe", F27); not in Layout mode |
| — | snapping | the rail's toggle (§6.2) |

**Escape** cancels a mouse drag in flight first (§3, F24), then drops
an active tool (back to `V`), then a multi-selection, then a selected
object, then the §3 cascade. `V`
returns to select from any tool; right-click exits an exclusive tool.

### 6.1 Placement (`S`, `K`, `M`)

`pages/editor/tools/placement.ts` (pure) keeps the chain:

- **Arming.** The tool **stays armed** until exited. The insertion point
  is the control selected when it was armed (after it), the leg clicked
  (its insert position, §4), otherwise the item before the finish; `S`
  anchors at position 0. Without a course the tools only create sites.
- **Ghost** (`editor-ghost`, `editor-ghost-label`,
  `editor-ghost-description`): *number · code* — the sequence number at
  the insertion point and the next code from the club allocation
  (`nextSeriesControlCode`, the inventory's series) — and the top
  autodetect description under the cursor (`control.suggestDescription`,
  asked 150 ms after the pointer rests, rounded to 0.1 mm). Over an
  existing control of the tool's kind the ghost sits on it and reads
  **Add ‹code›**. The circle at true paper size (the layer's `metrics`,
  reported by the viewer's `onCourseInfo`; a finish adds its inner
  circle) is drawn by the UI layer (`editor-ghost`, `placeBinding`) only
  when the layer draws no provisional visit — no course selected, the
  All-controls view, or a reuse (`provisionalDrawn` in
  `lib/course-layer-request.ts` is false). With a course the layer's
  provisional circle is the one circle at the cursor; a second, thinner
  UI-layer circle on top of it was the "blue thin circle" of feedback
  2026-11-07 item 1 (P4, [bugfix](bugfix-ghost-circle-doubles-the-layer.md)).
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
  ghost's label and description stay in the UI layer (its circle only
  when the layer draws none, above); there is no dashed UI-layer leg. In a fast chain the leg from a control placed
  a moment ago appears once the lists refetch. No model object exists
  between clicks. The viewer's course list (`MapPanel`'s `courseOverlays`,
  `lib/course-overlay-ids.ts`) carries each course's start and finish
  whatever its control count, so the splice has an end to join: the
  course's own `startControlId` / `finishControlId` when they name a live
  control of the role; else, for a legacy course with controls, the start
  nearest its first control and the finish nearest its last; else (no
  controls, no explicit end — a fresh course) the event default of
  `course-layer.md` §6.2 (lowest id, `effectiveRoleControlId`, as the
  inspector's rows). No start under `firstAsStart`, no finish under
  `lastAsFinish`. A start just placed with `S` therefore draws its leg to
  the cursor on the first `K` hover (P5; before, a course without controls
  reached the layer with no start, and only the length label showed).
- **Leg length** (`editor-leg-length`): the first pending leg's length
  on the ground as a UI-layer label at its midpoint, "‹n› m" rounded to
  the metre (paper mm × the map scale, `lib/editor/leg-length.ts`). It is
  the pending leg's one readout, beside the pointer: since P2 there is no
  status-bar number (`editor-pending-leg-length` is gone). While a control is
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
  `editor.tool.exclusive`, D12). A control placed from the phantom's
  *Add control* in `V` is selected with its dashed ring and the action
  bar, whose contextual actions apply to it (P4, feedback 2026-11-07
  item 1, reverting P1's `placed` flag). The phantom (`editor-phantom`) only marks a click on empty
  map in `V`, before any control exists; a tool drops it. The action bar does not open. The insertion point advances and the new site is the anchor.
- **Drag** pans (the tool is exclusive), with the placement loupe on as
  well (F27: the user rejected a press-and-hold that would place on the
  release; the loupe is a toggle instead, §10 "Loupe"). **`Ctrl+Z`** undoes the last
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
site, a polygon vertex, a dragged bend (§6.7) and a text anchor snap to the nearest **point
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
`LegProps.gaps` (fractions of the **bent length** — the polyline
from the previous site through the leg's `bends` to the site, the length
the layer applies them along since F1, `course-layer.md` §10.1 — at least
0.4 mm; on a leg without bends that is the centre-to-centre leg),
written with `setStructure` on the item the leg runs into. The tool
projects the pointer onto the nearest point of that polyline and draws
the target and the gaps along it (user 2026-11-07, F3 Q1 A). A
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
one cannot be left without it (that takes the event's **Auto cuts**
toggle, which drops every automatic cut and keeps the stored lists,
`course-layer.md` §3.4). A leg's effective gaps come from the course the layer draws
(Course view); in the All-controls view the layer draws no legs and the
tool starts from the stored ones.

### 6.4 Area tools (`A`)

`A` opens the menu of kinds next to the rail button (`editor-area-menu`,
a portal at the button's screen position so nothing in the overlay strip
covers it); a second key picks the kind — the **`A` chord**: `O`
out-of-bounds area, `L` out-of-bounds line, `W` white-out, `F` filter
region, `S` toner saver, `R` marked route (`AREA_KEYS`, shown in the
menu). Below them, **Corridor on selected leg** (`editor-area-corridor`,
`C`, `CORRIDOR_KEY`) writes the selected leg's corridor (§6.7); it is no
area kind (not in `AREA_CHOICES`, so the phone's `+` menu does not list
it) and is disabled without a selected leg, on a leg that already has a
corridor, and on a phone. The chord key is read only while the menu is open, so `S` does
not arm the start tool there; `Esc` or `A` closes the menu. A click on a
menu item does the same.

The same flow draws Layout mode's `P` polygon (`AreaKind`
`layout_path`, closed, not in the `A` menu; `course-layout.md` §3).

`pages/editor/tools/polygon.ts`: **smooth by default, Alt for sharp**
(F18, the user's answer of 2026-11-08 to feedback Q2, reversing D15's
Alt = smooth). The press places the vertex where it went down (snapped):

- **A click places a smooth vertex.** Its handles are not pulled but
  follow its neighbours by uniform Catmull-Rom, `smoothHandles` in
  `lib/editor/geometry-edit.ts`: `hOut_i = (P_{i+1} − P_{i−1}) / 6`,
  `hIn_i = −hOut_i` (the tangent at the vertex is parallel to its
  neighbours' chord; a sixth makes the cubic the Catmull-Rom spline).
  Every `step` re-settles every smooth vertex from its current neighbours
  (`smoothed` in `tools/polygon.ts`): the last vertex placed is a corner
  until the next one lands, then curves, and moving it or a neighbour
  before closing recomputes its handles. **Closed kinds wrap at close**
  (the first vertex's prev is the last, the last's next is the first —
  applied when the flow is done); **an open line's ends stay corners**
  (no neighbour on one side).
- **Alt at the press places a corner** (mouse only). Alt with a click on
  the first vertex closes with the first vertex a corner (a vertex pulled
  there at the first press keeps its handles); Alt with a double-click
  makes the double-click's own vertex a corner — with the mouse its first
  press places that vertex, so the Alt that counts is the one at that press
  (`step`'s `double-click` event carries `corner` too, for a caller that
  sends no press).
- **Click-drag shapes the curve by hand** (Mapper / Illustrator): once the
  pointer is 3 px from the press the drag pulls **symmetric handles** out
  of the vertex — `hOut` = the drag vector, `hIn` its negation
  (`pull-handles`, `symmetricHandles`) — Alt or not, and `Shift` turns the
  handle to the nearest 45° (`constrain45`), live. The pull wins over the
  automatic handles: neighbours landing or moving leave a pulled vertex
  alone. A drag back within 3 px of the press returns the vertex to its
  press's kind (smooth, or a corner with Alt).

The kinds live only in the drawing state: a `DrawVertex` is a stored
vertex plus `corner` (Alt at the press) or `pulled` (a click-drag);
neither is smooth. Every finishing path (`click` on the first vertex,
`double-click`, `enter`, and the page's `Enter` key, which goes through
`step`) settles the smooth vertices with the wrap and **strips the
flags**: the created geometry is ordinary `PathVertex`es with handles,
one `courseObject.create` and one undo entry as before. After closing a
smooth vertex is a curve vertex like any other (its handles mirrored, §7
"Editing geometry"); nothing remembers that it was automatic. Stored
objects are untouched by the change: a corner drawn before F18 or
imported stays a corner until it is toggled (§7).

Since the tool takes every press on the map, **a drag no longer pans
while an area is being drawn** (the wheel zooms). **On touch**, where taps
place vertices through `onClick` and one finger still pans, **taps follow
the default — smooth vertices** (answered by the user on 2026-11-08) —
and there is neither Alt nor a pull, so a touch-drawn area has no corners
until a vertex action bar with **Smooth** / **Corner** buttons exists
(Pending). Drag a placed vertex (`editor-polygon-vertex`) to adjust it
before closing (its handles move with it); close by a double-click or a
click on the first vertex, `Esc` cancels; `Enter` finishes any kind once
it has its minimum vertices. The preview (`editor-polygon`) follows the
curves (§7 "Editing geometry") and shows the hover point as the smooth
vertex a plain click would place — standing in as the last vertex's next
and, for a closed kind of three or more, as the first vertex's prev (the
ring the close would make); Alt is not previewed (the hover carries no
modifier). Nothing provisional is written to the state, and only handles
in the state get grips (`editor-polygon-grip`). A **filter region** stays
a polygon: the schema refuses handles (`course-layer.md` §8.1), so its
vertices are corners, it ignores Alt and its click-drag is a corner.

*Window managers:* Xfce and older KDE bind Alt + left-drag (and on some
setups Alt + left-click) to moving the window, so the press never reaches
the browser; there the user rebinds the window manager's modifier (Xfce:
*Window Manager Tweaks → Accessibility*, the key used to grab and move
windows; KDE: *Window Behaviour → Window Actions*, the modifier key). The
same holds for `V`'s Alt gestures (§7 "Editing geometry"). The editor
offers no second key for it: Shift is 45° and Ctrl is the macOS context
menu.

Line kinds
(out-of-bounds line, marked route) end by a double-click or `Enter` from
two vertices and never close on the first vertex. On closing the object is created (§7: `{ all: true }`
scope, the kind's default props), the tool returns to `V` and the new
object is selected with its inspector. A filter region being drawn is
outlined only: it starts with nothing picked (§7), so it hides nothing
until its symbols are chosen in the inspector, where every change is live.
The inspector's **eyedropper** (*Pick from map*, `editor-filter-pick`,
`aria-pressed`) arms the exclusive tool `pick-symbol`: crosshair cursor,
no selection ring or action bar, no rail button lit, a drag pans and a
click (a tap) picks — the symbol under the click (§5) joins the selected
region with its **whole group** (§7: every document symbol of its
heading), one `courseObject.update` and one undo entry per pick; in
*picked colours* the colour of the drawn pass under the click joins
instead, and a region on *all* becomes a pick of that group. The tool
stays armed over several picks (consecutive picks build on each other
while the stored object catches up); a line under the button
(`editor-filter-pick-note`, `data-kind` `added` / `already` / `miss`)
says what the last pick added, that its group was already in the region
(no write), or that nothing pickable was there (empty map, or a symbol
the list leaves out). `Esc`, `Enter`, `V`, right-click or the
button again leave it; it is dropped when the selection stops being a
filter region and on any mode change (filter regions are edited in
Course mode). The **toner saver** needs no drawing: it is generated
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
  the action bar; not in All variations, §12).
- **`1`–`9`** show and activate the n-th alternative of the selection's
  variation group (§12; with `V`).
- `Delete` / `Backspace` deletes the multi-selection, else the selected
  leg's **focused bend** (§6.7), else the selected object's **focused
  vertex** (§7 "Editing geometry"), else the selected object, else the
  selected control.

### 6.6 Site fields

The selection inspector writes three fields of 08 §4.2: **kind** (all six:
control, start, finish, map exchange, crossing point, map-issue point;
F4) with `control.update { kind }` (`course-layer.md` §6.3 keeps
`status` in step and refuses a change that breaks a stored structure) —
crossing and map-issue points are disabled while the site is on a course
("on a course"), and a crossing point some leg runs through keeps its
kind ("a leg runs through it"), the option's title and label saying why;
the map-issue option's title otherwise says what the point is (§6.8) —, **notes** (`control.update { notes }`, on
blur; `courses.review`), and for a control on the selected course
**Hide the number on this course** — `numberHidden` on every visit of the
site in the structure (`setNumberHidden`, `setStructure`). Each is one
undo entry.

### 6.7 Legs: styles, bends, corridors

The editor side of `LegProps` (08 §4.3, §5.2 inspector "leg: style,
gaps, corridor, crossing"; the layer's rules are `course-layer.md` §10).
A **selected leg** is the leg-click phantom on the selected course
(§4: `phantom.insertAt` set) in Course mode, in Course or Class view, on
an ordered course: there is no second selection model, so Escape, a
course switch and arming a tool drop it as they drop the phantom; Layout
mode drops the phantom, and Field mode keeps it but shows no selected
leg (the mode is part of the rule). Its item is the row the leg runs into
(`legForInsert`, `lib/editor/sequence.ts`, the inverse of
`insertIndexForLeg`): `rows[i]` is `explicitStructure(…).items[i]`, and
the leg is that item's `leg`. Where the two do not line up (an explicit
start or finish whose site is missing from the event's controls: the
inspector has no row for it) there is no selected leg and no `G`
target on a leg, and the leg metres take no bends, rather than reading
or writing another item's leg.

**Inspector.** The selection slot shows the *Leg* section (`editor-leg`,
`modes/LegSection.tsx`, title "Leg ‹from› → ‹to›" by code):

- **Style** (`editor-leg-style`): *Line* (705, the default, stored as no
  `style`), *Marked route* (707 along the leg), *None* (no line; numbers,
  cuts and the leg's hit unchanged, §5). With a corridor and *Line* a
  note under it (`editor-leg-style-corridor-note`) says the line is
  hidden inside the corridor and its edge marks the leg (F14,
  `course-layer.md` §10.2 "No centre line").
- **Bends** (`editor-leg-bend`, `data-index` / `data-x` / `data-y` paper
  mm, `data-curve` `smooth` (a handle stored) / `corner`, `data-focused`):
  one row per bend in order, its kind named after its point, a click
  focuses it, ✕ (`editor-leg-bend-remove`) removes it;
  `editor-leg-bends-empty` without bends. The focused row shows
  **Smooth** (`editor-leg-bend-smooth`) and **Corner**
  (`editor-leg-bend-corner`), the bend's current kind disabled: each is
  the Alt-click below, one write — the tablet's way to switch a bend
  (F16; no Alt on touch). No numeric edit: the handle, its grips and
  *Add bend here* place them. A hint line (`editor-leg-bends-hint`)
  says how to add one while the leg has none (`legBendsHint`) and names
  the gestures once it has bends (`legBendsEditHint`), so a leg without
  bends keeps the section's height of before (the inspector's Checks
  header sits over a scrolled section's lower rows).
- **Corridor** (`editor-leg-corridor`): **Add corridor**
  (`editor-leg-corridor-add`) writes the default corridor — 50 m wide,
  edge on, a 5 mm white band, opacity 1 (decision log, F3: a band visible
  at once); with one, the fields width m (`-width`, > 0), white mm
  (`-white`, ≥ 0), the edge checkbox (`-edge`) and **Remove**
  (`-remove`). There is **no White opacity field** (F25, user answer
  2026-11-10: hidden until the band can draw translucency, F26): the band
  draws opaque whatever `whiteOpacity` says (`course-layer.md` §10.2), so
  the field and its "opaque for now" note are gone. The stored value is
  kept: every corridor write spreads the stored corridor, and the API
  still validates it (0–1). A number is written on blur or
  Enter; a value outside its range is not written and the field shows the
  stored value again. On the map (F19, `course-layer.md` §10.2) the
  circles, the 701 and the 706 the corridor ends at are mouths: the map
  shows inside them and the band wraps them. Where the corridor ends —
  a control or the finish no other corridor leg starts or ends at (F22,
  `course-layer.md` §10.2 "Ends") — the band stops on the line through
  the circle's centre, its corners rounded, and the map shows behind the
  circle; where corridors continue, and at the start, the band wraps the
  symbol all round as before. With the edge on, the edge
  lines end on the symbol, and a circle wider than the corridor **opens**
  where the corridor meets it. The opening is drawn, not a gap: `G`
  neither shows nor edits it, it is never stored, and it follows the
  corridor when the corridor changes or goes. A corridor at least as wide
  as the circle encloses it whole. Start and finish are never opened, and
  without the edge nothing opens.

**Map.** In `V`, the selected leg draws its outline (`editor-leg-outline`,
dashed: the leg as the layer draws it, `legPolyline(from, bends, to)` —
the curve flattened at 5 µm, exactly from → bends → to without handles),
a handle per bend (`editor-bend-handle`, `data-index`, `data-focused`;
the focused one active) and a grip per stored Bézier handle
(`editor-bend-grip`, `data-index`, `data-which` `in` / `out`). The
gestures are §7's "Editing geometry" on the open path
`[from, …bends, to]` (F16, user answer Q2 of feedback 2026-11-08: the
same convention as every vertex tool, F18 — **smooth by default, Alt
for sharp**), edited through `geometry-edit.ts` by `lib/editor/bends.ts`
(`legPath`, edited with `closed: false`: an open path, curves allowed).
The sites are the path's fixed ends: they are never dragged here and
never carry a handle (an open path's ends have no smooth form, a split
gives a corner end no handle, and only the bends — the path without its
two ends — are written back), and handles exist on bends only (user
answer Q1).

- **Pressing order**: a bend handle, then a grip, within the handle
  reach (7 CSS px; a finger 14 px, `2 × HANDLE_PX`, F23), before anything
  else under it (the leg would be a leg click); then the selected
  object's and the usual §6.5 ones. A finger's press takes only a bend
  or a grip: anything else is the viewer's (§10).
- **Drag a bend** (past 3 px; with `Alt` too, F18): the bend moves,
  snapped (§6.2), its handles with it (`moveBend`); the outline follows on
  the UI layer and the **course layer follows live** (F21, below); the
  release writes once and focuses it. A release without movement focuses
  it.
- **`Alt`-click a bend**: focuses it and toggles it (`toggleBendSmooth` =
  `toggleSmooth`): a bend with a handle becomes a corner, a corner
  becomes smooth with handles from its neighbours (`smoothHandles`:
  `hOut = (next − prev) / 6`, `hIn = −hOut`, the neighbours being the
  adjacent bends or sites). One write.
- **Drag a grip** (past 3 px, not snapped: a handle is shape, not a
  place): the handle moves by the pointer's offset (`dragBendGrip` =
  `dragGrip`): a mirrored pair stays mirrored, a smooth pair keeps the
  other's length, a lone handle moves alone; `Alt` held (live) breaks the
  pair, `Shift` turns the handle to 45°. The layer follows live (F21,
  below). The release writes once and focuses the bend; a click on a grip
  does nothing.
- **Live redraw** (F21, user feedback 2026-11-09 item 1; replaces F16's
  "no layer request per move"): on every move of a bend or grip drag the
  binding reports the leg's live bends (`LegBends.onBendsDraft`, after
  `moveBend` / the grip's `dragBendGrip`; nothing before 3 px, nothing on
  a click or an `Alt`-click). The page keeps them as the **leg draft**
  (`MapViewerEditorProps.legDraft`: the course's name, the leg's key
  `"<fromId>><toId>"`, the bends) and the viewer merges it into the
  drawn courses after the course override (`withLegDraft`, only that
  leg's `bends`; its style, gaps, corridor and crossing kept;
  `course-layer.md` §5). So the layer re-derives the course as the write
  will leave it — the line or the 707 pieces and their cuts, the
  numbers, the corridor's inside, band, edge and openings and every
  drawn course's union — one request in flight, the latest winning
  (F20, `map-rendering.md` §5.2 "Engine"). No fast filter or approximate
  corridor while dragging (identity-only levers, F20b). Every leg of the
  selected course, corridor or not, in every view where a leg is
  selectable. The release still writes once (`onBendsChange`). The draft
  is **held** from the release until the course drawn under it — the
  override's own draw for a course with groups (§12), else
  `course.list`'s leg — carries the written bends, or leaves the bends it
  showed at the release (another write landed; the `pendingMoves` rule,
  §6.2), so the band does not jump back between the write and the
  refetch. A live draft shows only while its leg is selected. A
  cancelled drag (`onPointerUp(null)`, a mouseleave) and a failed write
  drop it; `Escape` ends the drag itself — the viewer cancels any mouse
  drag before the page's cascade (§3, F24), the binding's
  `onPointerUp(null)` — so its release writes nothing, and the page drops
  the draft; undo / redo (and the conflict notice's refresh) end
  it (`moveEpoch`). An `Alt`-click's write is held the same way. The
  rules are `shownLegDraftOf` (`lib/editor/variation-view.ts`). The
  inspector's metres read the same shown draft (F25, "Readouts follow the
  bends" below).
- **Add bend here** (`editor-action-add-bend`, the leg's action bar):
  a bend on the segment whose (flattened) path is nearest the phantom's
  point, at that segment's nearest point (`insertBendAt`, `nearestEdge`
  on the path), so the leg keeps its order of vertices and its shape:
  **smooth** — on a straight segment with handles from its neighbours
  (collinear with the segment, so the leg is unchanged until a grip or
  the bend moves), on a curved one by `insertVertex`'s de Casteljau
  split (the curve kept, the neighbours' facing handles shortened);
  with `Alt` held on the click, a **corner** (on a curve the split's
  handles of the new bend dropped, the neighbours' kept). The new bend is
  focused. The double-click on a leg stays *insert control* (§6.5, D5);
  a double-click on a handle or grip inserts nothing.
- **Stored corner bends** (imports, F3's bends) stay corners until edited:
  a drag moves no handle into them, a neighbour's insert leaves them
  alone.
- `Delete` / `Backspace` removes the focused bend (§6.5). Bend focus is
  page state keyed by the leg's item and cleared by another leg click,
  undo and redo.
- A bend and its handles are paper mm, rounded to 0.01 mm half away from
  zero (so a mirrored pair stays exactly mirrored; a handle that rounds to
  nothing is dropped); every gesture is one `setStructure`
  and one undo entry.

**The corridor guide** (F14, user feedback 2026-11-08 item 2): the layer
draws no line along a `line` leg with a corridor (`course-layer.md`
§10.2), so the UI layer draws a blue dashed guide
(`editor-corridor-guide`, `data-course`, `data-leg` — the derived
course's id and the leg's index) along the derived `points` (bends and
the crossing point joined) of **every** corridor leg of the selected
course, always: wherever its legs are clickable — Course mode in Course,
Class or Variant view, desktop and phone, with any tool (an armed tool
keeps it: `withCorridorGuides` wraps the active binding) — and never in
All variations, All controls, Layout or Field mode, nor in print. A
`marked_route` or `none` leg with a corridor gets one too (the guide
follows the corridor, not the line). In `V` on desktop and tablet the
selected leg's own outline replaces its guide (no second line while a
bend is dragged). The guide only draws: a click on it is the viewer's
leg click (the leg hits through its UI leg, §5), which selects it.

**Writes.** Every change is one `setStructure` with the item's `leg`
patched by `setLegProps(s, itemIndex, patch)` — the patch's keys replace
the item's, the others stay; a key set to `undefined`, `style: "line"`
and an empty `bends` list are removed, and a leg left empty goes — and
one undo entry (`applyStructure`). `setLegGaps` (§6.3) is a patch of
`gaps`. An item whose predecessor changes loses its whole `leg` (§4).

**Readouts follow the bends** (`course-layer.md` §10.1 "Length"): the
inspector's leg metres (`sequenceLegMeters` with each row's stored
bends, and the crossing point joined by `routedBends`, §6.8), a dragged
control's leg labels (`dragLegShapes` with `bendsInto`) and the `G`
tool's target (§6.3, through the crossing point too) all run along the
polyline. The bend handles and the dashed leg outline are the stored
bends only (the crossing point is a site, moved as one). A
`course-leg` mirror item carries its leg's resolved `data-style`.
A stored bend may carry Bézier handles (F13, `course-layer.md` §10.1):
the layer draws the curve, and every readout above and the dashed
outline read the shared flattened polyline (`legPolyline` =
`course.legPolylineOf`), so every editor composition of
`[from, …bends, to]` is the drawn curve (F16); *Add bend here* finds its
segment on the path itself (`nearestEdge`, the exact cubics).

**During a bend or grip drag** (F25, user feedback 2026-11-10 item 3)
the inspector's metres follow the leg draft the canvas draws (the shown
draft, live and held, "Live redraw" above), as a dragged control's leg
labels follow the control: `legMeterInputs` (`lib/editor/sequence.ts`)
gives every row whose leg is the draft's (`"<fromId>><toId>"` of the row
before and the row, as the canvas keys it — a loop's repeated leg is one)
the drafted bends in place of the stored ones, the crossing point still
routed in (`routedBends`), and `sequenceLegMeters` measures them. So the
row's `editor-leg-meters`, the sequence footer's `km` and the total sum
the drafted leg. Only a draft of the selected course counts (a held
draft outlives a course switch until the list catches up). Without a
draft the metres are the stored bends' as before; a cancelled drag,
`Escape` and a failed write drop the draft and the stored metres show
again; a held draft keeps the released metres until the structure
carries them. The status bar's length stays the derivation's
(`courseChecks.lengthM`, which reads the draft one round trip behind,
F21), falling back to the total.

**Phone** (08 §5.5 "desktop-only by design", §10): a tapped leg shows the
section in the sheet with every control disabled and the line *Leg
editing is for desktop and tablet* (`editor-leg-readonly`); no handles,
no *Add bend here*, no corridor entry (user answer 1, 2026-11-10: the
phone stays read-only).

**Tablet** (F23; a coarse pointer with the desktop layout, §10): one
finger drags the selected leg's bend handle or grip. The viewer offers
the press to V (`touchPress`) before its own targets; within **14 px**
of a bend handle — or, failing that, a grip — it takes the gesture, and
the leg click under it does not fire. Past 3 px of finger travel the
point rides **48 px above the finger** on the dashed stem
(`editor-touch-handle`, `liftedPoint`) with the loupe above it (§10
"Loupe"): a bend drawn there snapped, a grip moved by the lifted
finger's offset from the press (so it jumps up by the lift at the start,
as a control does). The course layer follows live (F21's draft,
unchanged); the lift writes once where the point is drawn and focuses
the bend. A tap (no travel past 3 px) focuses the bend with no write; a
second finger or `touchcancel` cancels (`onPointerUp(null)`: the draft
dropped, nothing written). There is no Alt on touch: a bend drag moves
the bend with its handles, a grip drag keeps the pair mirrored (F18's
defaults), and the bend row's **Smooth** / **Corner** switches a bend
(F16). Field mode shows no selected leg on any device, so it is
unchanged.

### 6.8 Crossing and map-issue points

Row F4 (08 §4.2 `kind`, §4.3 `crossing`, §5.2 rail `C`; the layer's
rules `course-layer.md` §10.3). Both are sites that are never items.

- **`C`** arms the crossing tool in §6.1's placement flow
  (`PlacementTool` `"crossing"`, rail button `C` lit; a plain `C` —
  with the `A` menu open the key is still *Corridor on selected leg*).
  Armed with a **selected leg** (§6.7) the chain's `insertAt` names that
  leg; otherwise it places free sites. The **ghost** is 710's two lines
  on the UI layer (`editor-ghost`, `data-role="crossing_point"`,
  `data-angle`), turned along the selected leg's segment nearest the
  cursor (north–south without a leg), labelled *Crossing point*; it adds
  no provisional visit (no number, no pending leg). **The click** (snapped)
  on a leg creates the site (code-less `control.create { kind:
  "crossing_point" }`, named "Passeringspunkt N") and sets the leg's
  `crossing` (`setLegProps(itemIndex, { crossing: { controlId } })`) —
  one undo entry, the site selected — and **returns to `V`**: one
  crossing per leg, and the selected leg is consumed by the write
  (`endsChain`; decided on the user's standing instruction 2026-11-07,
  for review). Over an existing crossing point the click routes the leg
  through it (no new site). Without a leg the tool stays armed and every
  click places a free crossing point. `Esc`, `V` and right-click exit.
  `K`'s reuse never takes a crossing or map-issue point.
- **Leg section** (§6.7): a *Crossing point* row (`editor-leg-crossing`):
  the site's code (`editor-leg-crossing-code`), *Crossing section (13.4)*
  (`editor-leg-crossing-section`, `crossing.section`) and *Remove*
  (`editor-leg-crossing-remove`); without one *None — C on the leg places
  one*. Each is one `setLegProps` write. An item whose predecessor
  changes loses its `leg`, the crossing with it (§4).
- **Add map-issue point** on the empty-map action bar
  (`editor-action-add-map-issue`): a code-less `control.create { kind:
  "map_issue" }` at the phantom, named "Kartutdelning N". Its tooltip
  (`title`, `EditorContextAction.title`, on the bar and the phone's
  host; F14, feedback 2026-11-08 item 4) and the kind select's map-issue
  option's (§6.6) say what it is: IOF 702, where runners receive their
  maps, shown on the all-controls and setter maps only, never on a course
  map (`mapIssueHint`, en + sv).
- **A selected crossing or map-issue point**: the action bar is *Delete*
  only (no radio, no description, no course entries); the inspector keeps
  notes and the kind select (§6.6). Delete strips the legs through a
  crossing point server-side (`course-layer.md` §6.3); undo restores the
  site and writes each course's structure back.
- **Setter marks**: the Course and All-controls views draw every
  crossing point and the map-issue points (702); Class view draws only
  the crossings its legs run through, as the class's print. Layout mode
  draws them as the sheet prints: setter marks on the all-controls sheet.
- **The on-map description sheet** derives the 13.3 / 13.4 rows from the
  course's legs (`sheetCrossings`), as print does (§4 "Derived
  instruction rows" in `control-descriptions-and-editor-geometry.md`).
- **The Controls page** marks the slice-F kinds with a badge
  (`control-kind-badge`, `data-kind`) beside the status.
- Desktop and tablet; the phone has no `C` key and no + menu entry for
  them yet (Pending).

### 6.9 Map exchange

Row F5 (08 §5.2 rail `X`, §5.3 "Map exchange"; the layer's rules
`course-layer.md` §11, the sheets `course-layout.md` §6).

- **`X`** arms the exchange tool in §6.1's placement flow
  (`PlacementTool` `"exchange"`, rail button `X` lit). It is a **control
  in the chain** (`isVisitTool`): the same insertion point (after the
  selected control, at a selected leg, else before the finish), the same
  ghost (`number · code`, the pending legs, the autodetected
  description) and provisional visit (a `map_exchange` site the layer
  draws as a control), and **the chain continues** after the click — the
  next click with `X` or, after `K`, a control goes after the exchange;
  `K` ↔ `X` keep the chain; `M` still ends it; `Ctrl+Z` steps back. The
  click (snapped) creates the site — `control.create { codes, kind:
  "map_exchange", autoDescribe }`, the code from the club allocation as
  a control's — and inserts it (`insertSite`), one undo entry. Over an
  existing **exchange** site the click reuses it; `X` reuses no other
  kind (`K` may reuse an exchange: it is a control).
- **The sequence** (§4) shows **part headings** when the course has an
  exchange (`partHeadings`, `lib/editor/sequence.ts`): *Part 1* before
  the first row and *Part n + 1* after the n-th exchange row
  (`editor-seq-part`, `data-part`); the exchange's row carries
  `data-exchange`. Numbers continue across the exchange (answer 2).
- **Course mode draws every part** (no `section`); Layout mode and Class
  view draw a part sheet's part (`layoutRequestOf` → `section`,
  `course-layout.md` §1). Layout mode's sheet picker lists the part
  sheets by name (`<course> · part n`), and `editor-layout-scope` carries
  `data-section`.
- **Export ▾ this course** creates the missing part sheets first
  (`layout.autoSheets`) and prints one page per part.
- **`EXCHANGE_WITHOUT_SHEET`** (§8): a part without a sheet, once the
  course has sheets — *Part n has no sheet — Export creates it, or add
  one in Layout mode*.
- **The on-map description sheet** derives the 13.5 row after each
  exchange (`sheetExchanges`), as print does.
- Desktop and tablet; the phone has no `X` (Pending), as `C`.

## 7. Course objects in the editor

The editor reads `courseObject.list` (MapPanel's cache, until reload) and
invalidates it after every write. On the canvas it shows the objects
`courseObjectsForView` keeps for the view (the selected course's, else
the `all`-scoped ones) — the layer draws them (`course-layer.md` §8.3);
filter regions and toner savers are outlined by the UI layer. Since F12
the objects a sheet or template once anchored to the map are course
objects too (`course-layer.md` §3.6): listed, drawn and edited here like
any other, with `source = 'layout'` that the wire does not carry.

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
  | filter region | mode (hide / clip); symbols: all, **picked symbols** or **picked colours** (the document's colour rows, a CMYK swatch and the name); **invert** ("show only these inside"); the **eyedropper** (§6.4). Picked symbols are listed **one entry per heading** (`lib/editor/symbol-groups.ts`, feedback 2026-11-06 item 5): a symbol's heading is the library code of its applied match (`isAppliedMatch`: automatic or reviewed — `601` for a match to `601.b`), else its source code's base (`101.1` → `101`; a non-numeric code such as `graphic` stays whole), so a heading's variants, minimum-size and tag-line versions and duplicates are one entry (`editor-filter-symbol-<heading>`, `data-members` the member indices) that toggles all its members: checked when all are picked, indeterminate when some are (an older region), and a toggle completes a partial group. Named from the library heading in the UI language when a member's match is applied, else by its first member's source name; a swatch (`editor-filter-swatch`): the library preview of the most used member's applied entry, else the server's preview of the most used member's own drawing (`/api/map-documents/:hash/symbols/:idx.png`, event-scoped). **Not listed**: hidden symbols (OCAD's hidden status, OMAP helpers), symbols no object uses, and symbols drawn through a proxy (`missing` ones, and those with neither a drawing nor an applied match — a region selects by the drawn symbol, never the proxy). Headings of the document's library come first in code order; headings outside it (club codes, frames, legends), `graphic` entries and rectangles fold under **Other** (`editor-filter-other`, collapsed). The search matches the heading, its library names in both languages and the members' source codes and names, and opens Other. Presentation only: the stored `symbols` stay document symbol indices (`course-layer.md` §8), nothing changes at import |
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
(`course-layout.md` §3). The convention is the drawing's (§6.4, F18):
**smooth by default, Alt for sharp** — an inserted vertex is smooth, Alt
makes it a corner, and Alt-click switches a vertex between the two. It
lives in the shared module, and a selected leg's bends take it unchanged
(F16, §6.7: the open path `[from, …bends, to]`, its sites fixed corners).

| Gesture | Edit | |
|---|---|---|
| drag a vertex handle (`editor-object-handle`) | moves the vertex, its handles with it | as before (§7) |
| click a vertex handle | focuses it (drawn filled, `data-focused`) | no write; a text's anchor or an image's corner is never focused, so `Delete` deletes the object |
| `Delete` / `Backspace` with a vertex focused | `deleteVertex` down to the kind's minimum; at the minimum nothing happens | the object is deleted from the inspector, or after a click on its body — an area's edge — (which unfocuses) |
| drag a vertex with `Alt` held | moves the vertex like a plain drag (F18: no handles pulled) | D5b's Alt-drag "pull symmetric handles" is gone: on a stored vertex the handles come from Alt-click (smooth), then a grip |
| double-click on an edge (within the 7 px handle reach, not on a vertex) | `insertAtEdge` at the nearest point (`nearestEdge`, `insertVertex`): a **smooth vertex** (F18) — on a straight edge its handles from its neighbours (`smoothHandles`, the closed wrap; collinear with the edge, so the shape stays until it moves), on a curve a **de Casteljau split**, so the shape stays as it was | the new vertex is focused |
| `Alt` + double-click on an edge | the same insert as a **corner**: on a straight edge no handles; on a curve the split's handles of the new vertex dropped (its neighbours' shortened handles kept) | |
| drag a grip (`editor-object-grip`, `data-index`, `data-which` `in` / `out`) | the handle moves by the pointer's offset (so a press beside the grip does not jump it) — `dragGrip`: a mirrored pair stays mirrored; a smooth pair (opposite, different lengths — a split's) stays smooth with the other's length kept; a lone or broken handle moves alone (`Shift`: 45°) | |
| `Alt` held on a grip (live) | breaks the pair: only that handle moves | the pair stays broken afterwards |
| `Alt`-click a vertex | `toggleSmooth`: a vertex with a handle becomes a corner (`retractHandles`); a corner becomes smooth (`smoothHandles` from its neighbours, the closed wrap) | an open line's end corner has no smooth form: nothing; a filter region: nothing |

- **Kinds** (`vertexRule`, kept in step with `courseObjectBodySchema` by
  a test): closed areas (`oob_area`, `whiteout`, `toner_saver`) ≥ 3
  vertices, lines (`oob_line`, `marked_route`) ≥ 2, curves allowed;
  `filter_region` ≥ 3 without curves — it ignores Alt (a drag moves its
  vertex, Alt-click writes nothing, an insert is a corner), it has no
  grips; `text` (one anchor) and `image` (two corners) take no
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
  sheet windows (`courseMap.list`, the course sheets whose course is the
  selected one, each with its `sectionIndex` — §6.9; none →
  `CONTROL_OUTSIDE_SHEET` and `EXCHANGE_WITHOUT_SHEET` are not evaluated), the
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
- **KPIs** in the top bar's course-info popover (§2, `editor-stats-*`):
  controls, length, climb; the check count is its amber row
  (`editor-stats-checks`, `data-count`) and the button's badge
  (`editor-stats-badge`), shown when there is one. On a phone the
  sheet's status line (`editor-status-kpis`, `editor-status-checks`, §10).
  Length is the sum of the layer's leg polylines (`DerivedLeg.points`)
  × the map scale, the course's stored length until the viewer has
  derived it — and while it draws one part of the course (Layout mode on
  a part sheet, §6.9), whose legs are not the course's. Climb is the course's stored climb (`courses.climb`,
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
- **A setter map** (F10; 08 §5.5 "the selected course or setter map";
  `course-layout.md` §8): above the list, when the event has setter
  maps, the picker `editor-field-setter-picker` (*None*, then every setter
  sheet — the event's first, then by course and setter number,
  `allSetterSheets`). Picked, the list (`editor-field-list`,
  `data-setter` = the sheet's seq) is that setter's controls in the
  sheet's code order (`courseMap.list` `setter.controls`,
  `setterRowInputs` in `lib/editor/setter-maps.ts`; start and finish as
  such, every other kind a checkable control row), with the same
  distance, bearing, tap and check-off, and a line
  `editor-field-setter-kpi` "Setter n · k/m checked"; a course need not be
  selected. *None* is the course's list. The pick is the list's
  (`FieldSection`, phone and desktop alike): the top bar's course picker
  and the peek line's KPI stay the course's, and the canvas keeps the
  course's highlight (Pending: a setter's controls highlighted on the
  map needs the layer request, F7's files). Decided on the user's
  standing instruction (2026-11-07), for review.
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
  shell's header); MapPanel has no map-info row (P6 took it out on
  every page) and the phone has no map-info dialog, so its peek line
  keeps the map scale (the desktop's moved to the dialog, §2). One finger pans
  the map as in fullscreen (`editor.fullBleed` — there is no page to
  scroll), two fingers pan and zoom.
- **Compact top bar** (`editor-field-top-bar`, in MapPanel's toolbar row
  beside its descriptions and fullscreen buttons): back to the Courses
  page (`editor-back`), the course picker (`editor-course-picker`), the
  mode switch Course · Field (`editor-mode-*`; Layout stays a desktop
  mode), the overflow `editor-overflow` → `editor-overflow-menu` with undo,
  redo, the view picker, hide other controls, auto cuts and the placement
  loupe toggle (F27; the desktop ids, a pressed dot when on). No tool rail, no inspector strip, no course-info button or save
  indicator (the peek line below has both), no map icon (§2's map-info
  dialog is the desktop's).
- **Bottom sheet** (`components/editor/BottomSheet.tsx`, `editor-sheet`,
  `data-detent` = `peek` / `half` / `full`): *peek* (120 px) holds the
  status line (`editor-status`: KPIs, check count and save state, the
  phone's form of the desktop's course-info popover and save indicator,
  §2), Field mode's "n/m checked", the
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

**Gestures** (coarse pointer, shared hit-test path; `lib/editor/touch.ts`):

| Gesture | Effect |
|---|---|
| Tap a control | Selects it (no movement, no write) |
| One finger on the **selected** control | Drags it at once |
| One finger on an **unselected** control | Pending: moving > 10 px pans the map; lifting before 500 ms selects it; holding still for **500 ms** selects it and starts a move (a short vibration where supported) |
| Dragging a control by touch | Drawn **48 px above the finger** on a dashed stem (`editor-touch-handle`) so the finger never covers it; dropped where it is drawn; leg lengths and the affects-chip as with a mouse; the **loupe** above it (below) |
| One finger on a **bend handle or grip of the selected leg** (tablet) | V takes it before the leg (`touchPress`, reach 14 px): dragged 48 px above the finger on the stem with the loupe, snapped, the layer live; one write on lift; a tap focuses (§6.7 "Tablet", F23) |
| Two fingers | Always pan / zoom the map; a second finger cancels a pending press, an armed control drag or a bend / grip drag, and selections are suppressed for 400 ms after (today's rule) |
| A control's number | Drags only when its control is selected; otherwise as an unselected control |
| Tap a course object | Selects it (V's binding: its outline and handles) — a line on its stroke, a closed area on its outline (12 px, §5); a tap inside an area, or elsewhere, is a map tap |
| Two fingers, one on a handle of the **selected area object** (or line) | Scale it about its centroid by the fingers' spread (`selectBinding.onPinch`, the handle reach doubled to 14 px): drawn live as a draft, one `courseObject.update` and one undo entry on lift, nothing when the spread stayed within 1 %; the map does not pinch with it |

Hit tolerance is **12 CSS px** on a coarse pointer (6 with a mouse) — the
"large hit areas" of 08 §5.5 — on the same `editorHitAt` path (§5).
**Loupe** (08 §5.5 "Precision"; D9b, F24). While a point is dragged on
the GL canvas — by touch a control or a bend or grip of the selected leg
(F23), with the mouse a control, a bend or grip of the selected
leg, or a course object's vertex or grip (F24) — a circle
(`editor-loupe`, **120 CSS px**) shows the map at **×2.5** about the
dragged point, oriented as the map: the snapped control, bend, grip or
vertex the drag places (`onPointerDrag`'s return for a tool, §6). By touch the point is the handle, 48 px above
the finger, and the loupe appears and goes with the stem; it sits **16 px
above the handle**, so the 1× control stays visible. With the mouse there
is no lift and no stem: the loupe sits **16 px above the cursor**, which
keeps its crosshair (or the tool's cursor) at 1×. When that would leave the
map box at the top it flips to 16 px below the finger or the cursor; its
edge is kept 4 px inside the box sideways (`loupePlacement`, its lift 48 or
0). The element carries `data-pointer` (`touch` / `mouse`) and takes no
pointer events. A mouse drag shows it once it has passed the 3 px click
slop, always — there is no setting (user, 2026-11-10) — and it goes on the
release, on the viewer's `mouseleave` cancel and on Escape (§3). A gesture
that places no point shows none: a body drag of an object, a lasso, the
`G` tool, an area's pulled handles, Layout-mode drags, and a number dragged
by mouse or by touch (F30; user 2026-11-11: a number is a label, not a point
to place, and the loupe over it was no help — it deviates from F24's "a
number"). A number's drag is otherwise as before: the 3 px slop, the number
following the pointer, Escape cancelling it (§3) with nothing written, and
one `course.setControlLabelOffset` on the release. The picture is the GL
layer's: one more `renderDocument` per frame over the resident visible
set into an offscreen target, drawn into the circle of the canvas
(`map-rendering.md` §5.5 "Loupe"); the element is the ring and a
crosshair at the drop point over it, so the course layer's dragged
circle (one layer round trip behind the pointer) and the crosshair meet
when the reply is in. UI-layer shapes that happen to lie under the
circle (a check marker, a leg-length label) draw over the loupe at 1×.
It shows during every such drag, whatever the zoom: 08 §5.5's "at high
zoom" is read as the loupe's own magnified view, not a zoom gate. The
nudge pad stays the exact tool.

**The placement loupe** (F27; user 2026-11-11,
`research/vector-map-pipeline/feedback-2026-11-11.md`). Placing is a click,
so a drag loupe never shows while placing. A toggle adds one: the top-bar
magnifier (`editor-placement-loupe`, §2), the same item in the phone's
overflow menu, and the key `L` (§6). It is a per-browser preference,
`localStorage` `oxygen.editor.placementLoupe` (JSON, off by default),
not editor state: no undo entry, remembered between sessions. When it is
on and a placing tool (`S`, `K`, `M`, `X`, `C`, `T`; the binding's
`hoverPoint`, §6) is armed, the same `editor-loupe` and GL inset show
**while hovering**, centred on the point the click would place (the
provisional point, snapped, or the reused site's centre; not the raw
cursor), 16 px above the cursor (`loupePlacement` with lift 0, flipped
below it at the map's top). It follows the cursor during a left-drag pan
too (the map and the point under it move together); the drag still pans
and places nothing, and a click still places (§6.1 — the user rejected a
press-and-hold that would have placed on the release). On a coarse pointer
the pin-drop flow (§6.1 "Touch": Field mode, the tablet) hangs it 16 px
above the centre crosshair, centred on the point *Place* would drop; the
crosshair wins over a stray mouse position there (`placementLoupe` in
`lib/editor/touch.ts`). A drag in flight shows F24's / D9b's loupe instead,
whatever the toggle says. The element carries `data-mode` (`hover` /
`drag`) beside `data-pointer`, and both loupes carry the magnified point
as `data-x` / `data-y` (paper mm). It goes when the pointer leaves the
map, when the tool is disarmed (`Esc`, `V`, `Enter`, right-click, `M`'s
chain end, *Done*) and when the toggle goes off; turning it on with the
pointer resting over the map shows it at once (the viewer keeps the last
cursor). `V`, the area tools, `G`, the eyedropper and Layout mode never
show it. The cost is the drag loupe's: one inset render per frame while
it shows (`map-rendering.md` §5.5).

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

## 12. Variations and loops

Row F7 (08 §5.2 inspector and view picker, §5.3 "Variation authoring",
`1–9`, §5.4 Variant view, §5.5, §5.6; slice F answer 5). The stored
groups and their materialisation are `course-layer.md` §6.1 and §12; the
editor reads and writes them through `course.setStructure` like every
other structure edit — one write and one undo entry per gesture.

**Create a group.** A selected **top-level** leg (§6.7: the leg phantom;
both ends top-level items, no group between them — `canCreateGroup`)
offers **Create variation here** in its action bar
(`editor-action-create-variation`, after *Add bend here*; desktop and
tablet). It writes `createGroup`: a group `{ kind: "variation", id:
"v<n>", alternatives: [A: [], B: []] }` before the leg's end item — the
leg's start is the group's **anchor**. Both alternatives start empty and
the group is saved at once (answer 5); an empty alternative draws as the
straight leg, so nothing moves on the map until a control lands. The
leg's props (style, bends, gaps, corridor, crossing) stay on its end item:
they become the group's exit leg, every alternative's. The new
group's A is shown and activated (below). No nesting: a leg into, inside
or out of a group offers no *Create*, nor does Variant view (Course view
is where groups are made).

**The displayed path.** In Course view each group is shown by one
alternative — its **active** one (default the first) — and a loop by
every alternative, the active one first (`courseViewOrders`); in Variant
view each group by the variant's order. That path
(`course.pathOfOrders`, `course-layer.md` §12.1) is what the inspector
lists (`displaySequence(structure, sites, orders)`: each row's `path`
names its item, an alternative's item or a loop's repeated **anchor
visit**), what the canvas draws (`courseOverride`, below), what the leg
metres, the leg phantom and the checks read, and what every
structure-edit position means. So:

- **Inserting on a group's legs goes into the group** (`insertSite`): on
  the leg into an alternative's control it lands before it in that
  alternative; on the leg out of an alternative's last control (the exit
  leg, or a loop's leg back to the anchor visit) after it; on the
  straight leg of an empty active alternative into it (a loop's empty
  petal has no leg: the leg after the anchor stays the drawn petal's,
  unless every petal is empty). The leg into the anchor stays top-level. Before F7 the positions skipped groups and were
  off by one after a group.
- **↑ / ↓ and a dragged row keep their level** (`moveVisit`): a top-level
  row passes a group without entering it, an alternative's row moves
  within the displayed path.
- **A loop's anchor visit** is no item: its row has no ✕, ↑ / ↓ or drag,
  and the leg into it has no Leg section.
- `removeSite` (*Remove from ‹course›*) takes the control out of every
  alternative too; a group left first, last or beside another dissolves
  into its first alternative (the schema's rule); one with every
  alternative empty stays (`course-layer.md` §6.1, `VARIATION_ALL_EMPTY`
  is a check).
- The item after a group keeps its `leg` while the group changes (its
  predecessor is the group); an alternative's first item has the leg from
  the anchor.
- *Add to ‹course›* appends at the top level, before the finish.

**The block** (`modes/VariationBlock.tsx`, `editor-variation`,
`data-group`, `data-loop`) sits in the sequence after the anchor's row;
the group's rows follow it indented (`data-group`, `data-alternative`,
`data-anchor-visit`). Its parts:

| Part | `data-testid` | Write |
|---|---|---|
| a tab per alternative (`aria-pressed` on the shown one; its control count beside the label) | `editor-variation-tab-<label>` | none: the alternative is shown and activated; a row dragged onto a tab moves to the end of that alternative (`moveToAlternative`) |
| ＋ | `editor-variation-add` | `addAlternative`: an empty one, the next free capital (A … Z, then A2 …); it is shown |
| ✎, or double-click a tab | `editor-variation-rename` → `editor-variation-label` | `renameAlternative`: a blank or taken label is ignored |
| ✕ | `editor-variation-remove` | `removeAlternative` of the shown one with its controls; with two alternatives the group dissolves into the other's controls |
| *Loop (butterfly)* | `editor-variation-loop` | `setLoop`: the variants become the visiting orders (`AB`, `BA`), the anchor visited between the alternatives |
| on a phone | `editor-variation-readonly` | the tabs still switch the shown alternative; the rest is disabled and the line says editing is for desktop and tablet (08 §5.5) |

**Activating an alternative** (a tab, `1–9`). `1`–`9` pick the n-th
alternative of the **selection's group** — the group of the selected leg,
of the selected control's row, else the group activated last
(`EditorState.focusGroupId`). Activating shows the alternative in Course
view (from Variant or All variations too), and claims `K`: armed with
nothing selected, the chain starts at the end of that alternative
(`alternativeEndAt`), so successive placements fill it. Escape drops the
claim before the course (the alternative stays shown); a course change
resets the active alternatives.

**Views** (top bar; `EditorView` `variant`, `all-variations`). For a
course with groups the view group gains **Variant ▾**
(`editor-view-variant`: every key, `course.variantOrders` of the
structure being edited — the keys `course.variantList` answers once the
write lands) and **All variations** (`editor-view-all-variations`, a
toggle back to Course view):

- *Variant*: the variant's path with its own numbering, editable as Course
  view (its legs insert into the variant's alternatives). An edit that
  drops the shown key (*Loop*, a removed alternative, an undo) returns to
  Course view.
- *All variations*: a read-only overlay — no leg clicks, no Leg section,
  no provisional visit, no *Create*. The canvas draws the spine and one
  branch per alternative in distinct purple tints, labelled by **number**
  when the variants number alike — every visited site has exactly one
  sequence number across them, the forks are equal (F15; the user's
  answer Q4) — else by code, as with loops and unequal forks
  (`course-layer.md` §12.7; `numberHidden` is ignored here). Screen only: Export ▾ prints per variant
  and an all-variations page in one purple (F8, `course-print.md` §4.6).

**The canvas.** `course.list` carries the root's first alternatives, so
for a course with groups the page hands the viewer `courseOverride`
(`MapViewerEditorProps`, `lib/editor/variation-view.ts`): in Course and
Variant view the displayed path as the course (`courseDrawOf`: controls,
legs keyed by drawn neighbours, hidden numbers), in All variations the
spine and the tinted branches (`allVariationDraws`; the spine's draw
carries `labels` — site id → number — exactly when
`course.uniformVariantNumbers` over the items the layer numbers (role
`control`, positioned: `EditorPage.tsx` passes the predicate) is not null,
and `courseLayerRequest` turns it into `viewOptions.labels`); `withCourseOverride`
replaces the overlay of the course's name (its `labels` too) and adds the branches
highlighted. The description sheet and the multi-course leg labels leave
the tinted branches out. **Class view and Layout mode draw a root as one
variant** (F8), as it prints: `sheetVariant` — the remembered key while
the structure has it, else the first — is passed to
`courseMap.resolveSheet { seq | classSeq, variantKey }` (block,
`{variant}`, the shared window; `course-layout.md` §1) and drawn as the
variant's path (`courseOverride`, also on Layout mode's viewer props).
There Variant ▾ (`editor-view-variant`, showing the drawn key) changes
only the key — the view and mode are kept (the `variant` action sets
`variantKey` alone in Class view or Layout mode); *All variations* is
Course mode's and hidden in Layout mode. Variant view entered in Course
mode stays Variant view in Layout mode. Export ▾'s variant entries
follow the shown key (`course-layout.md` §7). Decided on the user's
standing instruction (2026-11-07), for review: the first key by default
(the canvas always shows something that prints).

**Membership.** A control in any alternative is on the course (not
faded, *Remove from ‹course›* offered); "also in" counts a variant as its
root, once.

**Checks** (§8). The leg, number and description checks run over the
displayed path; `VARIATION_UNBALANCED` (alternatives more than 10 % apart)
and `VARIATION_ALL_EMPTY` over the groups (`checkGroupsOf`;
`course-layer.md` §9.2). Both are the editor's: `course.checks` has no
groups (§9.4 there).

**Decided on the user's standing instruction (2026-11-07), for review**:
an all-empty group is valid (answer 5's "not all of them" became a check,
so *Create* can save A and B empty); insertion on a group's legs goes into
the group; `1–9` act on the selection's group; activating an alternative
claims `K`; All variations is read-only, labelled by number when the variants number alike (F15) else by code; Variant ▾ lists
the keys of the structure being edited; the course picker lists roots;
group ids `v<n>`, new labels the next free capital.

## API

The course and control mutations the editors write through (08 §6;
`course-layer.md` §6–7 for the structure and the tokens). Public ids
throughout: a course by its `seq`, a control by its first code (else its
seq). Tokens are decimal strings.

| Procedure | Capability | Input | Returns |
|---|---|---|---|
| `course.setStructure` | `courses.edit` | `{ courseId, structure /* wire form */, baseVersion? }` | `{ version, checks }`: the written course's `course.checks` list |
| `course.checks` | `courses.view` | `{ courseId }` | `CourseCheck[]`: `{ code, siteIds /* public ids */, leg?: { from, to, index }, at: { x, y }, params? }` (`course-layer.md` §9; no message text — the web formats `editor:check_<CODE>`) |
| `course.update` | `courses.edit` | today's fields + `baseVersion?`; with `controlIds` the linear shortcut: writes a structure. The editor sends `{ id, descriptionInstructions, baseVersion }` alone (§4), which leaves the structure as it is | `{ ok, version }` |
| `control.update` | `courses.edit`; `notes` alone `courses.review` | today's fields + `kind`, `circleGaps`, `notes`, `baseVersion?` | `{ ok, version }` |
| `control.check` | `courses.review` | `{ controlId, checked }` | `{ version }` |
| `course.setControlLabelOffset`, `course.create`, `course.clone` | `courses.edit` | unchanged | as before, plus the course's `version` |
| `control.delete` | `courses.edit` | unchanged | `{ ok, courses: { id, version }[] }` — the courses whose structure lost the control |
| `course.list` / `course.detail` | `courses.view` | — | rows with `version`; `detail` adds `structure` (wire form) and `structureStored` |
| `control.list` / `control.getById` | `courses.view` | — | rows with `version`, `kind`, `circleGaps`, `notes`, `checkedAt` |
| `course.presence` | `courses.view` | `{ courseId, mode: "course" \| "layout" \| "field", clientId }` | `{ ttlMs, others: { courseId, courseName, name, mode }[] }`: the event's other live editors (§11) |
| `course.lastChange` / `control.lastChange` | `courses.view` | `{ courseId }` / `{ id }` | `{ name, at /* ISO */ } \| null`: actor and time of the row's newest `*.upserted` entry (`name` empty without a sign-in) |

A stale `baseVersion` answers `CONFLICT` with `data: { kind, id, version,
current, differing }`. Variation groups are written since F6 and authored
since F7 (§12; `course.variantList { courseId }` lists the variants); the
slice-F site kinds since F4.

## Tests

**The E2E layout (D10, E3).** `e2e/course-editor.spec.ts` is the editor's
spec and runs under two Playwright projects: `chromium` (desktop Chrome)
runs every desktop describe, `mobile` (Pixel 7; `MOBILE_SPECS`) runs the
touch describe at the end of the file. Each describe skips on the other
device through the `isMobile` fixture, so a file run reports the other
half as skipped (the tablet describe, F23, runs under `chromium` with its
own `test.use({ hasTouch, isMobile, viewport: 1024 × 768 })` and skips
`mobile` by the project's name) — one file, one fixture import, no duplicated flows. The
phone has no desktop flows to run: it opens in Field mode with no rail or
inspector (§10), so 09 §4 D's "green on the mobile project" is
`field-mode.spec.ts` plus this touch subset. The legacy page's spec,
`course-editor-legacy.spec.ts`, was deleted with the switch in E3, the
page itself in E4b.

Hygiene (AGENTS §12): `reseed()` once in `beforeAll`; the fixture import
(`e2e/test.ocd` courses and map) is idempotent per test (`openEditor` →
`ensureCoursesAndMap`; the phone describe imports from a desktop context,
`ensureFixtureFromDesktop`); courses a test creates carry a prefix and go
with the next reseed; controls, objects, sheets and templates it creates
are deleted in `finally` through `cleanup` (best effort, never failing or
hanging the test it closes); a seed control a test edits (code,
description, position) is written back in `finally`.

**`e2e/helpers/editor.ts`** is the editor specs' shared helper module
(`course-editor.spec.ts`, `field-mode.spec.ts`, `course-presence.spec.ts`;
the presence spec keeps its own `open` / `clearCodes` copies, outside D10's
area):
paper ↔ page through the viewer's `data-centre-x/y`, `data-px-per-um`,
`data-rotation` (`toPage`, `toPaper`), the mirrors (`sites`, `legPieces`,
`labelOf` from `course-label`, `siteCuts` from `course-site`, `toolShapes`,
`objectRow` / `geometryOf`), the gestures in paper terms (`select` — a
click on the circle, retried past a lagging hit index, an earlier action
bar dropped first; `arm`; `place` with an armed tool; `placeOneShot`; `drag`
/ `dragMm`; `pressInside` / `pressOnEdge` for the area-press rule of §5 /
§7), `emptyPoint` / `clickMap` / `coveredBy` (the chrome the editor floats
over the map), the fixture and navigation (`openEditor`, `newCourse`,
`regularCodes`), server-side calls (`trpcCall`, `cleanup`), prints
(`printed` / `analysePdf`: page count and size, hatch passes, curved fills,
`c` operators of `maps.pdf`; `probeTemplate`, `allControlsSheet`) and two
contexts (`desktopContext`, `freezeExternalPoll`).

**Conflicts in E2E.** The two-context describe opens B as a second desktop
context on the same event; A's `competition.counterState` answers are held
at the first one seen (`freezeExternalPoll`), because D11's live refresh
would otherwise re-seed A's token within the 5 s poll and make the stale
write a race. This is a test mechanism, not a product rule: a real client
whose poll ran meanwhile simply does not conflict (decision log, D10).

| Layer | Where | What |
|---|---|---|
| unit (shared) | `packages/shared/src/render/__tests__/hit-test.test.ts` | §5: topmost first, stroke reach = half width + tolerance, even-odd fills, closed-stroke interior on request, glyph discs, text glyph boxes, object filter, distance |
| unit (web) | `packages/web/src/map-gl/__tests__/worker-course.test.ts`, `engine.test.ts` | the course reply's hit index (local ids, refs `site` / `leg` / `number`, a site found at its centre; null on clear) and its way to the host |
| unit (web) | `packages/web/src/lib/editor/__tests__/hit.test.ts` | §5 over the real worker: interior and ring, start and finish, legs with course and index, empty map, tolerance, numbers, UI-layer sites under layer objects; closed areas by their outline only (D12): inside an `oob_area` / a white-out → null, its edge → the object, a 709.b border not grabbing the interior, a control and a leg inside a white-out still hit, a line by its stroke, a `UiArea`'s interior → null |
| unit (web) | `lib/editor/__tests__/url.test.ts` | §1 "URL" (F31): every writable state round-trips through `editorSearchFor` → `parseEditorUrl`; defaults omitted (no course, Course mode, Course view; Class view's and Layout's first variant); the fixed order; a phone writes `mode=course`, `mode=field` is always written; `control` read and never written; foreign params kept; every invalid case dropped and named (non-integer, zero, negative, leading-zero and over-long ids, an unknown mode or view, `class` without Class view and the reverse, Variant view without its key, a key where nothing draws one, `sheet` / `template` outside Layout, both at once); the cleaned URL after a bad inbound; `checkInbound` takes a cached hit, rejects a miss only after a fetch since mount or an error, and `fetchIfIdle` fetches once. `field.test.ts` "initial mode": the URL's mode wins on both devices, `layout` on a phone is Field |
| unit (web) | `lib/editor/__tests__/conflict.test.ts`, `write-client.test.ts` | §3: rebase vs moved vs refresh, unknown base, structure never merged; tokens sent and advanced, one re-send, `EditorConflict`, code re-keying, delete seeding |
| unit (web) | `lib/editor/__tests__/structure-edit.test.ts`, `sequence.test.ts`, `state.test.ts` | §4: sequence positions, insert / append / remove / move / role, legs dropped on a new predecessor; display sequence, explicit structure, leg → insert position; §3 Escape cascade, hide-others, modes |
| unit (web) | `pages/editor/__tests__/action-bar.test.ts` | §4: the entries per selection, the legacy ids; a leg: *Add bend here* only where the leg can be edited (§6.7), its click's Alt handed to the page (F16); empty map: *Add map-issue point* with its tooltip key (F14), a crossing / map-issue point: *Delete* only (§6.8) |
| unit (web) | `pages/editor/__tests__/placement.test.ts` "C: the crossing tool", `bindings.test.ts` "the crossing ghost", `lib/editor/__tests__/checks.test.ts` "legs keep their bends and crossing point" | §6.8: armed on a leg it names the leg, free otherwise; no number or pending leg; a placement on a leg ends the chain (`endsChain`), a free one stays armed; switching arms afresh; the ghost's two lines along the passage (east, north), no circle, its label, the rail lights `C`; `checkStructureOf` keeps bends and the crossing (public id as a string) |
| E2E | `e2e/course-editor.spec.ts` "F4: crossing and map-issue points" (`chromium`) | §6.8: a selected leg, `C` (lit), the ghost `crossing_point`, a click → one `course.setStructure`, back to `V`, one `course-site` `data-role="crossing_point"` whose `data-angle` is the leg's direction, the leg's drawn piece has a vertex within 0.3 mm of it, the on-map sheet's wide row `data-symbol-key="13.3"`; the Leg section names it, *Crossing section* → 13.4 (`data-section`); two undos → 13.3 again, then no crossing and no row. *Add map-issue point* on empty map → a `course-site` `data-role="map_issue"` in Course view, the kind select reads it; the course sheet's `maps.pdf` has the same stroke count, the all-controls print gains strokes (`analysePdf.strokes`) |
| unit (web) | `lib/editor/__tests__/structure-edit.test.ts` "leg props", `bends.test.ts`, `sequence.test.ts` (with "legMeterInputs"), `pages/editor/__tests__/rail.test.ts` | §6.7: `legMeterInputs` (F25): without a draft each row's point with its stored bends, a draft replaces the bends of its leg's rows only (a leg without bends gets them, an unknown key changes nothing, a loop's repeated leg at every visit), the crossing point routed into the drafted bends, an unpositioned row null and the row after it undrafted; `setLegProps` merges and keeps the other props, drops `undefined` / `line` / empty bends and an empty leg, no-op on the first item; a leg whose predecessor changes still loses it; bends inserted on the nearest segment (first, middle, last) smooth with handles from their neighbours, Alt a corner, a curved segment split with its shape kept (F16), toggled corner ↔ smooth and set by Smooth / Corner, a grip mirrored / Alt / Shift, every number at 0.01 mm, moved with their handles, removed; distance, fraction, point and slice along the bent length; `legForInsert` the inverse of `insertIndexForLeg` (unpositioned rows skipped); the corridor chord key outside `AREA_CHOICES` |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` "V on a selected leg", "V on a selected leg: the live draft", "leg gaps", `gaps.test.ts` | §6.7: outline through the bends and a handle per bend (`data-focused`); a drag redraws, writes once with the moved (snapped) bend; a click focuses; a cancelled drag writes nothing; a double-click on a handle inserts no control. F16 ("smooth bends, grips, Alt"): the outline the flattened curve, a grip per handle (none on a corner); a grip drag by the pointer's offset, mirrored, the outline following, one write and the bend focused; Alt live breaks the pair, Shift 45°; a grip click or cancelled drag writes nothing, a double-click on a grip inserts no control; a handle beats a grip; a bend drag keeps its handles, Alt or not; Alt-click toggles both ways, one write. §6.3: gaps along a bent leg (fractions of the bent length, the target and gaps drawn along it). F21 ("the live draft"): a bend drag reports its snapped bends past 3 px, never before, and the release writes once without a draft call; a cancelled bend or grip drag reports null and writes nothing; a click, an Alt-click and a grip click report no draft; a grip drag reports its mirrored pair, Alt live; without `onBendsDraft` the gestures work as before |
| unit (web) | `lib/editor/__tests__/variation-view.test.ts` "the editor's leg draft", "the shown leg draft", `bends.test.ts` "bendsEqual", `lib/__tests__/course-layer-request.test.ts` "the editor's leg draft (F21)" | §6.7 (F21): `withLegDraft` patches only that leg's `bends` on the course of its name (style, gaps, corridor, the other legs and courses kept, the input not mutated), an empty list removes them and an empty leg drops out, no draft or no such course gives the overlays as given, and it applies after the override; `shownLegDraftOf`: a live draft only while its leg is selected, a held one until the drawn leg equals the written bends or leaves the ones drawn at the release (and across a leg change), none from another undo epoch; `bendsEqual` by value (absent ≡ empty, a one-sided or zero handle differs); the draft reaches the request as that leg's bends with its corridor kept |
| unit (web) | `lib/editor/__tests__/hit.test.ts` "a leg with no line", "a corridor's edge …" | §5, §6.7: a `none` leg has no hit-index piece; `uiLegsOf` hits it from the derivation's pieces, a circle at its end wins, `accept` passes over it; F14: a corridor leg likewise (no hit piece, a UI leg, the edge no target), a `marked_route` one keeps its piece |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` "V on a selected leg: touch (F23)" | §6.7 "Tablet", §6 (`touchPress`, the placed point): V opts in only with a selected leg; a touch press takes a bend at 10 px and declines it at 16 px (the mouse's 7 px unchanged), takes a grip at 10 px, declines an object, a site and empty map (nothing selected); `onPointerDrag` returns nothing within the slop, then the snapped bend (one write on release there) or the dragged grip, and an object's dragged vertex or grip, nothing for a body drag or a lasso; a tap focuses with no write; a cancel drops the draft with no write |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` "corridor guides" | §6.7 (F14): one blue dashed `editor-corridor-guide` per corridor leg along its points with `data-course` / `data-leg`, under the tool's shapes; the tool's hooks kept (a press on a guide declines; an armed tool stays exclusive); no guides → the binding unchanged, no binding → the guides alone |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` "hoverPoint: the placing tools' point for the placement loupe (F27)" | §6, §10 "Loupe" (F27): `placeBinding`'s `hoverPoint` is the ghost's `at` (null without a ghost); `textBinding`'s the page's snapped hover (null without one), its `onHover` passed through and its click placing the same snapped point; V, the area tool, `G` and the eyedropper set no `hoverPoint` |
| E2E | `e2e/course-editor.spec.ts` "F3: legs — styles, bends, corridors" (`chromium`), "F3 on a phone" (`mobile`) | §6.7: a leg made a marked route → its `course-leg` pieces `data-style="marked_route"`, `none` and the leg still selects by a click, two undos back to `line`; *Add bend here* → one `editor-bend-handle`, dragged 60 px → the drawn leg has a vertex within 0.3 mm of it and the row's metres grow, `Delete` removes it (metres back, both controls still on the course); `A` then `C` → the default corridor, no map colour left in the band beside the edge (`inkAt` "map" = 0, > 0 before), F22: map colour behind both controls (within the pre-F22 wrap R + 5 mm, beyond the inside's round end; > 0 before and after — 0 on the pre-F22 band), the entry disabled with a corridor, the course's sheet prints one page, no `editor-leg-corridor-opacity` (F25), a width of 0 and a white band of −1 not written (the stored values shown again), a width of 80 written with the stored `whiteOpacity` 1 kept (F25), *Remove* brings the map back, undo the corridor; F14: no purple along the leg's middle inside the corridor (> 0 before and after *Remove*) while the edge is purple, the Style note shown, with the leg selected no `editor-corridor-guide` (its outline instead), deselected exactly one, none in All controls and one again in Course view, a click on the leg (where it is clearest of other sites — every F3 leg click, `legClickPoint`) selects it again, after *Remove* no guide and no note. F19: R read from the gap tool's target; both circles purple across the opening's middle before the corridor, the corridor narrowed to about 1.2 R (the default 50 m can be as wide as the circle on the fixture map: h ≥ R, the circle whole inside it), then no purple there, purple on the circles' far sides and at all four junctions, a click at the end control's centre selects it (the UI circle, §5), purple across the openings again after *Remove*. F16: *Add bend here* stores a smooth bend (`hOut` ≈ (b − a) / 6, `hIn` = −`hOut`), `data-curve="smooth"`, two `editor-bend-grip`, the outline 3 points and the metres unchanged; the upper grip on screen (clear of the action bar) dragged 60 px → one write, the pair still mirrored, the outline > 3 points, the metres grow; the same grip dragged again with Alt → only its handle changes; Alt-click the bend → no handles stored, `data-curve="corner"`, no grips, *Corner* disabled; *Smooth* → two grips again; two undos back to the corner, then to the broken pair; the course's sheet prints one page; Alt held on *Add bend here* → a corner (no handles, no grips, *Smooth* enabled). F21 (appended): *Add bend here*, the handle held (mouse down, `dragHold`) at least 2h + 12 mm off the chord where the probes clear every site, read held (`inkAt(…, true)`: the overlays transparent, not hidden — a hidden overlay sends the viewer a `mouseleave`, its gesture cancel; F24: the held probes lie clear of the mouse loupe's circle, `loupeCircleAt` — the apex up the screen, or down when the loupe would cover the band beyond it, with ≥ 20 probes of each band clear) → purple at the held apex, row b's `editor-leg-meters` at least the apex's two straight pieces long (F25: a leg through the apex is no shorter), no `course.setStructure` request yet; the release → the same metres while the write is in flight, exactly one request, the stored bend within 0.5 mm of the apex, the line still there, the metres unchanged; undo → the bend back on the chord, no purple at the apex, the chord's metres; the default corridor → the chord's band white, the map at the apex's band; held again → the band beyond the apex white and the map beside the chord, no request; the release → one, the stored bend at the apex and both probes unchanged (no jump back); undo → the chord's band white again; held once more → the apex's metres, and `Escape` → the chord's metres before the release (F25), the release sends no request and the stored bend stays on the chord. F24 (§10 "Loupe"): control a held with the mouse (`dragHold`) → `editor-loupe` with `data-pointer="mouse"`, `data-scale` 2.5, 120 px, its bottom 16 px above the cursor (its top 16 px below at the map's top), centred over it within the box (±1 px), no `editor-touch-handle`; the canvas in it (read held) has purple and differs in > 10 % of its pixels from the same circle at 1× after the drag; the pointer leaving the viewer → no loupe, no control or course write (the presence heartbeat aside), the control where it was; held again and `Escape` → no loupe while the button is down, the release writes nothing, the control where it was (§3; the cascade drops the course, picked again); F30: control b's number held → no `editor-loupe` (the drag itself still runs), `Escape` → no write, the number where it was; held again → still none, the release → exactly one `course.setControlLabelOffset`; *Add bend here*, the handle held 60 px off the leg → the loupe, the UI handle within 0.5 mm of the cursor's paper point, the release → none, one write, the stored bend there; a press on the handle moved 1 px and released → no loupe; the handle held again and `Escape` → no loupe, no write, the stored bend unchanged. "F24: the loupe on an object's vertex drag" (an `oob_area` through `courseObject.create`, selected by its outline): a vertex held with the mouse → `editor-loupe` (`data-pointer="mouse"`, 16 px above the cursor or below it at the top), no stem, a vertex handle within 0.5 mm of the cursor's paper point; `Escape` → no loupe while held, no `courseObject.update` on release, `data-geometry` as stored. On a phone a tapped leg shows `editor-leg` read-only with `editor-leg-readonly` and no *Add bend here* |
| E2E | `e2e/course-editor.spec.ts` "F23: bend drags on a tablet" (`chromium`, `hasTouch` + `isMobile` at 1024 × 768; skipped on `mobile`) | §6.7 "Tablet", §10: `data-layout="desktop"` with `(pointer: coarse)`; a tapped leg's section editable, *Add bend here*; a finger 10 px beside the handle moved down-right and held → `editor-touch-handle` and `editor-loupe` visible, the UI handle within 0.6 mm of the point 48 px above the finger, the loupe's bottom 16 px above that (or its top 16 px below the finger when it flips at the map's top) and centred over the finger (±1 px), no `course.setStructure` yet; the lift → exactly one, the stored bend within 0.6 mm of the lifted point with its handles unchanged, focused, stem and loupe gone; the upper grip pressed on its far side and dragged → the loupe, one write, its handle changed and the pair mirrored, the bend in place; a bend drag joined by a second finger → no write, the bends unchanged; after an undo (the bend unfocused) a tap on the handle → focused, no write, the bends as before |
| E2E | `e2e/course-editor.spec.ts` "F27: the placement loupe toggle" (`chromium`) | §10 "Loupe" (F27): a new course, `K` armed, `editor-placement-loupe` `aria-pressed="false"` → a hover shows the ghost and no `editor-loupe`; the button → pressed, `localStorage` `oxygen.editor.placementLoupe` = `true`; a hover → `editor-loupe` `data-mode="hover"`, `data-pointer="mouse"`, 120 px, its bottom 16 px above the cursor (top 16 px below at the map's top), centred over it within the box (±1 px); the canvas in it (read held: overlays transparent) has purple; `L` → off, no loupe with the pointer still, the same circle at 1× differs in > 10 % of its pixels; `L` → on, the loupe back with no move; `dragHold` 60 px → the loupe follows the cursor, the release → the view centre moved, no control or course write (the presence heartbeat aside), the site count unchanged; a click (`place`) → one new site; the cursor 3 px off an existing control's centre (the ghost *Add ‹code›*) → the loupe's `data-x` / `data-y` within 0.01 mm of the site's centre, the cursor's paper point > 0.1 mm off it; the pointer out of the viewer → none; `Escape`, `T` armed → the loupe on a hover; `Escape` (`V`) → none on a hover; a reload → still pressed, `K`'s hover → the loupe; the button → off, the ghost and no loupe. "a mouse drag keeps F24's loupe with the toggle on": a control held in `V` → `data-mode="drag"`, `data-pointer="mouse"`; `Escape` → none |
| E2E | `e2e/editor-top-bar.spec.ts` "F29: the top bar fits one row at 1840 × 1090 and collapses by the row's width" (`chromium`) | §2 "Top bar" (F29): *Bana 1* (with Class ▾) at 1840 × 1090 → every item of `map-toolbar` on one line, the band the row's width gives; at 2400 / 1500 / 1100 px (each asserted to land in its band before and after F28) → every label / tier 1 (`[data-toolbar-label]` of hide-others, cuts, descriptions, Export's and the picker's word hidden, mode words shown) / tier 2 (the mode words hidden, their icons shown), one row each; at every width the combobox *Course*, the buttons *Hide other controls*, *Auto slits*, *(Hide) descriptions*, *Export ▾* and the Mode group's *Course* / *Layout* / *Field* (test id and `title` checked) resolve by role and name, and the view group keeps its words |
| E2E | `e2e/course-editor.spec.ts` "Course editor (new, GL canvas)" (`chromium`) | §1: the editor mounts (never `course-editor-page`), and on an event with no map it mounts over the panel's upload prompt (no viewer); the shell (`C` enabled since F4, `X` since F5); place → move → undo / redo → reload → select on the canvas → delete; create a course, append two controls, add-to-course on the map, reorder + undo, insert on a leg, remove, reload with `?course=` (explicit start / finish rows); deep links, `H`, Escape cascade; the Courses page's `course-edit-link` and the Controls page's `control-edit-link` open the new editor on the course / with the control selected (one `editor-selection-ring`) |
| E2E | `e2e/course-editor.spec.ts` "Course mode (§4)" (`chromium`) | delete cascade: a control on two courses is deleted from the action bar — the site goes, both structures lose it (the open one's rows, the other through `course.list`), `Ctrl+Z` restores the site and both visits; *Remove from course* drops one visit and keeps the site; inline code edit in the sequence (`editor-seq-code` → 997: the row's `data-control-id` and the site follow, `Ctrl+Z` back; a duplicate code → `editor-error` "already exists"); free order (`editor-order-mode`): the hint, no reorder arrows, the layer draws no legs and labels the circles with their codes, a number drag still writes `course.setControlLabelOffset`; a number drag (the shared hit-test's `number` target): the `course-label` moves, persists over a reload, *Reset label* puts the automatic place back, undo the dragged one; clone (`editor-clone-*`, "A (copy)" prefilled, same rows) and no `editor-toggle-first-start` / `-last-finish` even with a legacy-flag course in the event |
| E2E | `e2e/course-editor.spec.ts` "Course mode descriptions (§4)" (`chromium`) | the description editor: Escape closes only the dialog (the control stays selected), column C which-of-similar with written titles (`desc-opt-label-0.1N`), a boulder and dimensions with the live preview (`desc-dim-input` → `desc-preview`), saved, reloaded, the summary; *Clear* + save stores none, `Ctrl+Z` writes the saved description back (the control's own description written back after); a control placed on the map is described from the base map (no suggestion offered, a pressed option in `desc-editor`), after a move it stays selected with its action bar and at most one suggestion; the description sheet: "All controls" with every control until a course is picked, then course E's card (event name, course name, the finish row's measured metres, the thick rules); description instructions (E3b): the collapsed block's summary, the finish variant 14.1 (one `course.update`; the sheet's finish row changes, `course.list` has it), a special row with 60 m (a wide row with "60 m"), anchored after a control by its punch code — `courseMap.resolveSheet`'s block has the special after that control and the 14.1 finish —, `Ctrl+Z` puts it after the start again, all persisted over a reload |
| unit (web) | `lib/editor/__tests__/instructions.test.ts`, `write-client.test.ts` | §4 description instructions: finish variant and length, add / update / remove a special, normalisation (lengths, whole metres, empty → `null`), specials off the course left out, the length field's parse; `setInstructions` sends the course's token, seeds the result as own, `null` clears, a stale token is a `refresh` never re-sent |
| integration | `packages/api/src/__tests__/integration/course-structure.test.ts` "concurrency", `course-maps.test.ts` | §4 description instructions: `course.update { descriptionInstructions, baseVersion }` advances the token and leaves the structure, `course_controls` and geometry as they were; `course.list` / `detail` echo it; a stale token → `CONFLICT` (kind `course`), nothing written; `null` clears. The same value in `resolveSheet`'s block and `courseMap.list`'s print rows, a special anchored by the punch code (the control's seq differs) |
| E2E | `e2e/course-editor.spec.ts` "Automatic cuts" (`chromium`) | `course-layer.md` §3.4 through the mirror: a control whose rim passes the fixture's boulder (68 / 42 mm; radius from the `G` target) is drawn with a cut around south (`course-site` `data-cuts`); a leg across the boulder is drawn in two `course-leg` pieces on its line, none covering the boulder. The event's auto-cuts toggle (`editor-toggle-cuts`, D17): off, the rim control's slit goes while a control's stored circle gap (`control.update { circleGaps }`) stays; on again, the slit is back |
| E2E | `e2e/course-editor.spec.ts` "conflicts (two contexts)" (`chromium`) | §3 / §11 / `course-layout.md` §2, B a second context: **structure** — B appends, A's append on the old token answers `CONFLICT` once (no re-send), `editor-conflict[data-kind=refresh]` "Changed elsewhere…", A's rows reload to B's, the redone append lands after it; **control** — B writes the description, A's move is refused once and re-sent on the server's token with no notice (B's description kept), B moves it again (after its poll showed A's move), A's next move shows `editor-conflict[data-kind=moved]` with B's x, *Keep mine* writes A's position; **sheet / template** — B aligns the map, A's align map is refused and A shows B's centre (nothing of A's stored); both in template scope, B writes the orientation, A's paper-size write is refused (B's orientation, A4 kept) |
| E2E | `e2e/course-editor.spec.ts` "touch" (`mobile`, Pixel 7) | §10 in Course mode on a phone: a tap selects (`editor-sheet-selection`), the peek row's ≥ 44 px *Append* (no `editor-action-bar` on the map) writes the structure, one finger on the selected control drags it at once, the overflow's undo puts it back; `+` → `K` → Place / Done in Course mode appends the placed control and the layer draws the leg to it |
| unit (web) | `pages/editor/__tests__/placement.test.ts` | §6.1: insertion point (before the finish, after the selected control, at a leg, `S` at 0, no course), chain advance, `Ctrl+Z` steps back, `S` → `K`, ghost number and pending legs (a start's leg runs to the first item) |
| unit (web) | `lib/editor/__tests__/leg-length.test.ts`, `lib/__tests__/course-layer-request.test.ts`, `lib/editor/__tests__/hit.test.ts` | §6.1: metres at the map scale, "‹n› m", the midpoint, a dragged control's labels (both legs, every visit, over undrawn items); the provisional visit in the request (`course-layer.md` §5); §5 `accept` passes over other targets and finds the site below a rejected one |
| unit (web) | `pages/editor/__tests__/toner-saver.test.ts` | §6.4 toner saver: every site at least the margin inside the sampled outline (and the hull sites exactly), tangent continuity at every vertex and along the straight edges, one site → four quarter arcs, two → a stadium of six vertices, collinear and duplicate sites, one cubic per ≤ 90° of turn with the handle (4/3)·tan(θ/4)·r, micrometre rounding |
| unit (web) | `pages/editor/__tests__/polygon.test.ts`, `gaps.test.ts` | §6.4: vertex flow, close on the first vertex / double-click, line kinds, vertex drag, `pull-handles` (symmetric, `Shift` 45°, back to zero the press's kind — smooth, or a corner with Alt —, a filter region stays a polygon, a moved curve vertex keeps its handles); smooth by default (F18: a placed vertex a corner until the next lands, then `(next − prev) / 6`; recomputed when it or a neighbour moves; a pull wins over a neighbour move; Alt at the press a corner through landings and moves; a filter region a polygon, Alt ignored; closed kinds wrap at close, Alt on the closing click makes the first vertex a corner; an open line's ends stay corners; every finishing path strips `corner` / `pulled`; Alt on a double-click a corner, the others wrapped; a plain click stores no flag); §6.3: compass degrees, shorter arc, minimum, merge across north, leg fractions |
| unit (web) | `lib/editor/__tests__/geometry-edit.test.ts` | §7 "Editing geometry": 8 samples per curved segment on the cubic, a curved closing segment, open paths never close; the nearest edge (closing edge, along a curve); insert on a straight edge, on the closing edge, on a curve (de Casteljau: the halves trace the original, the new vertex smooth); delete down to the minimum; symmetric handles, retract, `toggleSmooth` (F18: a corner → `smoothHandles`, a handle → a corner, the closed wrap, null for an open end corner and out of range, an open end with handles retracts), grip drags (mirrored, smooth with the other's length kept, Alt breaks, broken / lone handles alone), 45°; `smoothHandles` (D15, F18: an interior vertex `(next − prev) / 6` and its negation, the others untouched, the closed wrap at both ends, open ends corners, fewer than three never wrap, a spike a corner, out of range a copy); `vertexRule` agrees with `courseObjectBodySchema` for every kind |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` "geometry editing on a selected object", "while drawing: a press places a smooth vertex…" | §7 "Editing geometry": the sampled outline and grips; Alt-drag moves the vertex with one write (F18), a filter region's Alt-drag moves it too; Alt-click toggles (handles → a corner, a corner → smooth `(next − prev) / 6`; a filter region: no write), a plain click focuses, a body click unfocuses, the focused handle drawn; a grip drag mirrored, Alt live breaks it; double-click on an edge inserts a smooth vertex with collinear handles, Alt a corner (inside, on a vertex, on a text: nothing); a press within reach of the edge is the object's; §6.4 the area tool's press places a smooth vertex (its neighbour gaining handles on the same write), a drag past 3 px pulls handles (Shift 45°), back within 3 px the press's kind, the curved preview and its grips; Alt at the press a corner (the pull still wins, the corner kept; no Alt = smooth; a filter region ignores Alt), the closing click wraps every smooth vertex, Alt on it makes the first a corner, `onDone` carries no flags; the preview shows the hover as a smooth vertex (a ring of three curves throughout; a filter region's straight) with no provisional grips and nothing written (F18) |
| unit (web) | `lib/editor/__tests__/geometry-gestures.test.ts` | §7 "Editing geometry" after D16's extraction: the pressing order (vertex, grip, edge within reach, the inside no press, the caller's body), a vertex drag in the caller's units (nothing until it moves), Alt-drag moves and Alt-click toggles both ways (F18; the wrap at vertex 0, nothing for an open end and a filter region), focus (none for fixed kinds, the body unfocuses), a cancelled drag, insert on an edge (smooth with collinear handles, Alt a corner, a filter region a corner; on a curve the split, Alt dropping the new vertex's handles; not on a vertex, not inside, not for fixed kinds), the shapes with the caller's ids; `bindings.test.ts` unchanged is the net for `selectBinding` |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` | §6, §7: V (Shift-click, lasso, object select / move / vertex, outlines, double-click leg; D12: for every closed kind an interior press declines, selected or not, an edge press within 7 px or the hit-test's outline target drags it, a vertex still wins; a line's stroke press is the object's), armed (exclusive, right-click, touch, ghost label and leg length label, no UI-layer leg; the ghost circle only without a drawn provisional visit, a finish's two circles, P4), area (vertex drag, first-vertex close), G (rim drag, click removes, leg) |
| unit (web) | `lib/__tests__/undo-stack.test.ts` | §6.1: `UndoStack.top`, which `Ctrl+Z` while armed checks before stepping the chain back |
| unit (web) | `lib/editor/__tests__/snap.test.ts`, `hit.test.ts`, `state.test.ts`, `structure-edit.test.ts`, `write-client.test.ts` | §6.2 snap candidates and distance; §5 object targets (stream and UI-layer outline); §6 Escape order, multi-selection, object selection, tools; §6.3 / §6.6 `setLegGaps`, `setNumberHidden`; §7 object tokens |
| E2E | `e2e/course-editor.spec.ts` "tools" | §6.1 ten controls in ten clicks with `K` (the ghost label — its circle is the layer's, P4 —, no UI-layer pending leg, the leg length label "‹n› m" and no `editor-pending-leg-length` (P2), no action bar and no `editor-selection-ring` while armed, `Ctrl+Z`, `Esc`, the ring back on a click in `V`), reuse of a site; §5 / §7 the area-press rule (D12): a drag starting inside an `oob_area` (created through `courseObject.create`) moves the view (`data-centre-x`) and leaves the area unselected and unchanged, a click on its outline selects it (four handles), a drag inside the selected area pans and keeps the selection, a drag of its edge translates every vertex (one `courseObject.update`), a click inside deselects it; the armed `K` over the map: a `course-leg` piece of the course ends at the cursor's circle (absent before the hover, follows a second hover), no `editor-pending-leg`, the label = the metres from the last placed control's stored mm to the cursor's paper point at the map scale (read from the map-info dialog's `editor-map-info-scale`, P6) within 2 m (P2); a drag of the middle control shows two `editor-leg-length`, none after release; §6.5 Shift-click three controls → one add-to-course (one undo entry), §6.6 a site's notes written and reloaded; §6.3 a rim drag stores a circle gap, Reset gaps clears it; the layer draws what the tools store (D1's request path): a leg gap cuts the drawn leg, a circle gap is in the drawn site's cuts (`course-site` `data-cuts`), a hidden number leaves the site without its `course-label`; §6.4 / §7 an out-of-bounds area drawn (Alt-clicks: corners, F18), drawn on the canvas (709: purple inside it), its hatch (710) and border later set from the inspector (the stored props; 710 on the canvas is the shared layer path, probed in print only), printed (the all-controls `maps.pdf`: one page, the 709 hatch's clip-and-stroke operators present with the `all`-scoped area, one more run with `hatch: "710"`, gone when it is parked), selected again on the canvas (a click on its outline), deleted and undone; §6.4 / §7 "Editing geometry" a curved white-out in three clicks and one drag (two Alt-clicks — corners —, a click-drag that shows two `editor-polygon-grip`, the closing click): the stored vertex has `hOut` = the drag on paper and `hIn` its negation, the selection outline has 8 samples per curved segment, the all-controls `maps.pdf` gains exactly one curved fill (a fill path with `c` segments — the base map has its own); a double-click on a straight edge inserts a smooth vertex at its midpoint (handles 3 → 4, `hOut` ≈ the edge on paper / 6, grips 2 → 4), a click focuses it and `Delete` removes it (the object stays), `Ctrl+Z` brings it back, `Alt`-click on the corner b makes it smooth (grips 4 → 6, `hOut` stored), `Alt`-click again a corner (6 → 4, no handle stored); §6.4 smooth by default (F18): three clicks, Alt held at the third — no grips until the third lands, then two — and a plain closing click store `g[1].hOut` = `(g[2] − g[0]) / 6` (and ≈ the clicks' chord on paper / 6), `hIn` its negation, `g[0].hOut` = `(g[1] − g[2]) / 6` (the wrap), the Alt corner `g[2]` without handles, no `smooth` / `corner` / `pulled` key stored, four grips, and one `Ctrl+Z` removes the object (one undo entry); a filter region hides the 505 path under it live (canvas ink probe; its entry is the heading `editor-filter-symbol-505`, §7); §6.4 the toner saver (`A` then `S`, D13): `marginMm` 25, Bézier arcs stored, the outline sampled, and the course's `maps.pdf` (its sheet made first) carries at least one more `c` operator per stored curved vertex than without it (D13's deferred print check) |
| unit (web) | `lib/editor/__tests__/symbol-groups.test.ts` | §7 filter region: one entry per heading (an applied match's library heading, `601.b` + `601` merged; else the source base, `101.1` joins `101`; a suggested match is not applied), library names by UI language (`sv`, `sv-SE`), hidden / unused / missing / proxy-drawn symbols not listed, library headings first in code order and Other last (a rectangle frame, `graphic`), swatches (the most used applied entry, else the document symbol), search (heading, both library names, member codes and names), all / some / none, a toggle completes or removes the whole group, the group of a symbol, the swatch URLs (versioned library path; event-scoped document preview) |
| unit (web) | `lib/editor/__tests__/symbol-pick.test.ts` | §5 / §6.4 the eyedropper's pick over an encoded document: objects per symbol, an area inside it with its pass colour, a line over the area within the tolerance (topmost wins), the area beyond half width + tolerance, a hidden symbol never, a text by its box, a proxy-drawn point by its disc, empty map null |
| unit (shared) | `packages/shared/src/map-document/__tests__/render-bridge.test.ts` "a subset of objects" | `map-document-format.md` §8: `docIdx` maps each render object to its document object; `only` symbolises the listed objects and keeps the symbol table aligned |
| unit (web) | `lib/editor/__tests__/state.test.ts`, `pages/editor/__tests__/bindings.test.ts` "the eyedropper binding" | §6.4: `pick-symbol` dropped by Escape first (the object stays selected) and by any mode change; the binding is exclusive with a crosshair, a click picks with 6 px × `mmPerPx`, right-click exits, no shapes; `railKeyOf` lights no rail button |
| E2E | `e2e/course-editor.spec.ts` "filter symbol picker" (`chromium`) | §6.4 / §7 (P3): a filter region over the 505 path, *picked symbols*: `editor-filter-symbol-505` with `data-members="3"` and "Path", `601` named "Magnetic north line" (601.0 matched to 601.b), no entry with a source code (`.`), the 505 swatch image loaded, the 850 frame only under Other, the search "path" → one entry; the eyedropper armed (`aria-pressed`, `V` not lit, no `editor-selection-ring`), a click on the path → one `courseObject.update`, `"symbols":[3]`, the 505 box checked, the note "505 Path", the band's ink below a third; still armed, a second click on the path → note `already`, `Esc` → `V` with the region still selected |
| integration | `packages/api/src/__tests__/integration/course-print.test.ts` "course objects on the page" | §7 print: the row's "reference-raster pixel probe" of a printed course object is this test's page raster, not the E2E's — no HTTP route rasterises a composed page, and poppler is on the runner for the unit / integration jobs, not the E2E job (coordinator 2026-11-01) |
| unit (web) | `packages/web/src/lib/editor/__tests__/checks.test.ts` | §8: sites and the explicit structure as `courseChecks` takes them, two controls 20 m apart, the server's `DESCRIPTION_STALE` merged in order, markers (rings, a leg cross, unpositioned skipped), length from the leg polylines, locate |
| E2E | `e2e/course-editor.spec.ts` "Course editor checks" | §8: two controls 20 m apart → the count beside the section title, the row (`CONTROL_TOO_CLOSE`, "20 m"), a marker on each site, the course-info button's badge = the popover's checks row (P2); a click selects the first site and centres the view on the pair's midpoint |
| integration | `packages/api/src/__tests__/integration/course-presence.test.ts` | §11: the heartbeat shows the others and never the caller; one row per client, moved by a new course or mode; the 30 s TTL (hidden at read, swept by the next beat; kept just inside it); the signed-in name; a row goes with its course; unknown course refused; `control.lastChange` names the actor and time |
| unit (web) | `lib/editor/__tests__/presence.test.ts`, `write-client.test.ts` | §11: `name · course · mode` entries (open course first, "Someone", distinct keys), `courseChangedElsewhere` (moved token, own write, first sight), the own-token set |
| E2E | `e2e/course-presence.spec.ts` | §11, two browser contexts: B in Field mode shows in A's bar as "‹course› · Field" (here), A in Course mode in B's; a move in A moves the control in B within the poll; A leaving ages out of B's bar (TTL); a control appended in A re-renders B's sequence with `editor-external-change`, none in A |
| unit (web) | `lib/editor/__tests__/field.test.ts` | §9, §10: the fix through `mapGeo` and back (a SWEREF99 TM frame), accuracy in paper mm, distance at two scales, bearing from paper north with the wrap at north, the list in course order (blank without a fix or a position), the nudge steps (0.1 mm, 1 m at 1:10 000 / 1:15 000, µm rounding), detent heights and snapping, the band offset, the initial mode |
| unit (web) | `lib/editor/__tests__/mouse-drag.test.ts` | §3, F24: Escape cancels the tool's mouse gesture, a control's drag or a number's drag (the tool's first: it took the press), nothing without a drag, never a touch drag |
| unit (web) | `lib/editor/__tests__/touch.test.ts` | §10 gestures: a selected control drags at once; an unselected one: tap selects, drag past the slop pans, long press selects and moves (also when a late move fires it), a second finger cancels; the lift; the loupe's constants and place (above the handle, flipped below the finger at the top, kept inside sideways); F24: with no lift (a mouse drag) 16 px above the cursor, flipped below it at the top, clamped sideways, the touch call unchanged; F27: `PLACEMENT_LOUPE_KEY` is `oxygen.editor.placementLoupe`; `placementLoupe`: off, no point (no placing tool), no pointer or a drag in flight → none; on with a cursor → the cursor and the point, `mouse`; with the crosshair (also beside a cursor) → the crosshair, `touch` |
| unit (web) | `components/__tests__/top-bar-collapse.test.ts` | §2 "Top bar" (F29): the tier classes name the `toolbar` container and carry `TIER1_PX` / `TIER2_PX` (Tailwind reads them literally, so the numbers live twice); tier 1 is the wider |
| unit (web) | `map-gl/__tests__/view.test.ts` "loupeView", `engine.test.ts` "the loupe" | §10 "Loupe": the view (the dragged point at the centre, distances × 2.5, the rotation kept); one more draw of the resident visible set into the inset target, composited at the box, no rebuild or worker request (`map-rendering.md` §5.2) |
| unit (web) | `lib/editor/__tests__/state.test.ts` "showSelectionRing" | §6.1: the selection ring is drawn in `V` and not while an exclusive tool is armed (D12); a control just placed in `V` keeps it — the state has no `placed` flag, a `select` of the selected control is a no-op, Field keeps the selection and Layout drops it (P4) |
| unit (web) | `lib/__tests__/course-editor.test.ts` | `placed` selects the control and clears the phantom |
| unit (web) | `lib/__tests__/course-layer-request.test.ts` "provisional visit" | `provisionalDrawn`: false without a visit or for a reuse, true otherwise, and the layer adds the `provisional` site exactly then (P4) |
| E2E | `e2e/course-editor.spec.ts` "P1: …" "no blue circle beside a placed control while K is armed…" (`chromium`) | §6.1, D12: with `K` armed (hover, after each of two placing clicks) and after switching to Field, Course and Layout no `editor-phantom` and no `editor-selection-ring` |
| E2E | `e2e/course-editor.spec.ts` "P4: the dashed ring back after placing…" (`chromium`) | §4, §6.1, P4: `K` armed without a course draws the `editor-ghost` circle with its label; with a course no `editor-ghost` while hovering and after a placing click (`editor-ghost-label` "‹n› · ‹code›", no ring, no action bar); over an existing control "Add ‹code›" with the `editor-ghost` circle (a reuse); in `V` the phantom's *Add control* selects the new control with one `editor-selection-ring` and a visible `editor-action-bar` |
| unit (web) | `lib/editor/__tests__/state.test.ts`, `write-client.test.ts` | §9: Field entered and left keeping the selection, Layout entered dropping all but the course (`course-layout.md`); `checkControl` sends no token and seeds the control's |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` "pinch-scale" | §10: `scaleAbout` (handles scale with it), a finger on the ring starts it, the draft per move, one write on lift, nothing selected / cancelled / within 1 % writes nothing |
| unit (web) | `lib/editor/__tests__/status.test.ts` | §2, §3, §8, §10 (P2): the peek line's rows for a course (controls · length · climb · scale · checks, numeric `data`), without a course (scale only), the sheet key in place of the scale, snapping on, zero climb and checks absent; the desktop popover's `courseInfoRows` (P6): no scale row, no rows without a course and a sheet, the sheet key kept; the badge (the count, none at zero); the save indicator (`saved` / `saving` the dot alone, `error` / `conflict` always show their words) |
| Unit | `lib/editor/__tests__/action-bar-place.test.ts` | §2: the action bar centred under the selection; shifted inside at the left and right edges; the start kept in view when the viewer is narrower than the bar; above the selection near the bottom, below when it just fits, below and shifted up when it fits neither way; the size-0 first frame clamped to the margins |
| E2E | `e2e/course-editor.spec.ts` "The action bar stays inside the viewer" (`chromium`) | §2: fourteen courses through every control (a long *Also in*). On the leftmost clear control the bar, *Add to …* and the ellipsised Also-in line lie inside the viewer, and the line's `title` names the last course; *Add to …* writes. On the lowest clear control the bar lies inside the viewer vertically (`data-placement="above"` and above the control when it does not fit below); *Add to …* writes. The viewer's `scrollLeft` / `scrollTop` stay 0 |
| E2E | `e2e/course-editor.spec.ts` "P2: the status bar out of the footer" (`chromium`) | §2, §3 (P2): no `editor-status` on the desktop; `editor-save-state` inside `editor-top-bar` reaches `saved`; `editor-stats` opens the popover (`aria-expanded`) with the controls (`data-count` 0, then 1 after a `K` placement) and length rows and no `editor-stats-scale` (P6), a second click and an outside click close it, Escape with `K` armed closes it and leaves `K` pressed (a second Escape returns to `V`); at 1280 × 720 with `saved` the words take no room (width ≤ 1 px, the title set), the indicator is ≤ 16 px and the button ≤ 32 px wide; at 1024 × 700 a `control.create` aborted at the network → `data-state="error"` with `editor-save-state-text` visible, non-empty and inside the viewport. The shell test ("mounts the new editor") asserts the indicator and the button visible and no `editor-status`; the Layout / Class view test reads the sheet key from `editor-stats-sheet` |
| unit (web) | `lib/editor/__tests__/map-info.test.ts` | §2 (P6): the map-info dialog's rows with a loaded document (name · scale · file, then source · content · library · CRS · importer, their `data`), the map's rows only while the document loads or the import runs, no library and no CRS (rows absent, an OOM source named in full), no map (no rows), an unknown size (the date alone), the club picker's KB / MB rule |
| E2E | `e2e/course-editor.spec.ts` "P6: the map footer out; the map-info dialog" (`chromium`) | §2 (P6): no footer — the viewer reaches `map-panel`'s bottom (< 4 px), no `map-review-link`, *Replace map* or `use-club-map` in the panel; `editor-map-info` follows `editor-export` in document order and opens `editor-map-info-dialog` (`role="dialog"`, `aria-modal`, `aria-expanded`; focus inside it through five Tabs and six Shift+Tabs) with the name (`.ocd`), the scale (`data-scale`, "1:"), the north row, the file (`data-bytes` > 0), the document (`data-source="ocad"`, objects and symbols > 0, importer `ocad-‹n›`), *Review symbols* (`href` `/map-review/‹64 hex›`), *Replace map*, at most one *From club library*; the close button and a backdrop click close it, and the course-info popover has no scale row; *Replace map* opens a single-file chooser with `accept=".ocd"` and changes nothing; the backdrop is the element at the page's corner (it covers the shell's header); Escape with `K` armed closes only the dialog (a letter pressed while open does not switch the tool; the next Escape returns to `V`), and with a control selected keeps the selection and the course; an event with no map: `editor-map-info-none`, no scale, no review, *Upload map*. `e2e/map-review.spec.ts` and `e2e/club-map-library.spec.ts` reach the review link, the north-lines badge and the club picker through the dialog (the picker's Escape closes it before the dialog's; a pick from it closes the picker, keeps the dialog without an error, and its `editor-map-info-file` `data-uploaded` follows the new map row); `e2e/mobile-layout.spec.ts` asserts no `editor-map-info` and no *Replace map* in the phone editor; `e2e/editor-fullscreen.spec.ts` opens the dialog in fullscreen (inside `document.fullscreenElement`), and its Escape keeps fullscreen |
| E2E | `e2e/editor-url.spec.ts` (`chromium`) | §1 "URL" (F31): from the Courses page, a pick → `?course=`; Class view → `view=class&class=`, Course view drops them; Layout → `mode=layout&sheet=<the course's sheet>`; a reload restores the course, Layout and the sheet, then Class view; Field + All controls → `mode=field&view=all`; `history.length` unchanged by every change and one Back lands on `/courses`; `mode=bogus&view=nope` → Course mode, Course view, only `course=` left; a class not the course's → Course view, `view` / `class` gone; `mode=layout&sheet=99999` → Layout, the sheet gone; a deleted course → no course, `course` gone; the Courses page's pencil lands on its course (`course=` only), the Controls page's on its control with `control=` gone; on a Pixel 7 viewport no `mode` → Field and `mode=field`, Course → `mode=course` kept over a reload, `mode=layout&sheet=1` → Field and `mode=field` |
| E2E | `e2e/editor-space.spec.ts` (`chromium`) | §2 "The editor fills the window" (F28): at 1840 × 1090 `editor-page` is at least the viewport less 64 px wide, its bottom within 16 px of the viewport's and not below it, the page has no vertical scroll (`scrollHeight` ≤ `innerHeight`), the header's inner row (`shell-header-inner`) is as wide; on `/courses` `shell-container` and `shell-header-inner` stay ≤ 1280 px |
| unit (web) | `lib/__tests__/course-overlay-ids.test.ts` | §6.1 (P5): the overlay ids of a start-only course (the regression) and a finish-only one; a full course with explicit ends; the explicit ends win over the nearest; the legacy fallback to the start nearest the first control and the finish nearest the last; no controls and no explicit end → the event default (lowest id); a stale id or one of the wrong role treated as none; none under `firstAsStart` / `lastAsFinish`; no start or finish in the event; an end already at the head or tail not repeated; an unpositioned first control keeps the explicit start, else the default |
| E2E | `e2e/course-editor.spec.ts` "P5: the pending leg from a just-placed start" (`chromium`) | §6.1 (P5): on a fresh course the armed `K`'s hover draws a `course-leg` piece from the default start (the inspector's start row) to the cursor; `S` places a start (`course.setStructure`), the start row names it and `K` is pressed; the hover shows `editor-leg-length` "‹n› m" and a `course-leg` piece from the new start's rim to the cursor's; the click adds the control row, and after `Esc` (no label) the leg start → control is still drawn |
| E2E | `e2e/field-mode.spec.ts` (`mobile` project: Pixel 7, `vector`) | §10: opens in Field mode, full-bleed, compact bar and overflow, no rail / inspector / `editor-stats`, the sheet's status line (`editor-status`, `editor-save-state` `saved`) (P2), ≥ 44 px targets; §9: `setGeolocation` → the marker with its accuracy, every row's distance and bearing = the paper geometry at one scale; detents (tap, handle drag to full) and a list row's control centred above the sheet; a quick drag on an unselected control pans without selecting, a long press selects, shows the stem and the loupe (`editor-loupe`, 120 px, above the handle; the canvas inside it differs from the same circle after release — the 1× map — and has the map's purple; gone on release) and drops the control 48 px above the finger (persisted); two fingers cancel a pending press and zoom; nudge 2 × 0.1 mm, 1 m, the x field, four undos back; `+` → `K` → Place above the sheet adds a site, Done; F27: the overflow's `editor-placement-loupe` (pressed dot) on → `localStorage` `true`, no loupe without a tool; `+` → `K` → `editor-loupe` `data-pointer="touch"`, `data-mode="hover"`, 120 px, its bottom 16 px above `editor-touch-crosshair`'s centre and centred on it (±1 px), its `data-x` / `data-y` within 3 mm of the crosshair's paper point (snapped); the overflow → off → none, the same circle at 1× differs in > 10 % of its pixels; on again → the loupe, *Done* → none; a tap on an `oob_area`'s outline (created through `courseObject.create`) selects it, a tap inside deselects it (D12), and two fingers on its corners scale it by their spread, the map's zoom unchanged; check-off persists over a reload; offline: the notice, `+` disabled, a long-press move snaps back. "Field mode on a desktop" (desktop viewport in the same spec): the mode switch, no rail, the list's distance after a fix, check-off and `Ctrl+Z`, back to Course mode; F10: the setter-map picker (*None* + two after `layout.setterMaps { groups: 2 }`), Setter 1 picked → its controls in the sheet's order and the KPI, *None* → the course's list |
| unit (web) | `lib/editor/__tests__/setter-maps.test.ts` "a setter's Field rows" | §9 (F10): the sheet's order, start / finish as such, other kinds as controls, unknown ids left out, distance / bearing / checked through `fieldRows` |
| unit, integration, E2E | `course-layout.md` "Tests" | Layout mode |
| unit (web) | `pages/editor/__tests__/placement.test.ts` "X: the map exchange tool", `rail.test.ts` "railKeyOf", `lib/editor/__tests__/sequence.test.ts` "part headings" | §6.9: `X` armed, numbered and advanced as a control, `K` ↔ `X` keep the chain, not a chain end; the rail lights `X`; the exchange row marked, part 1 before the first row and part 2 after the exchange, none without one |
| E2E | `e2e/course-editor.spec.ts` "F5: map exchange" | §6.9: `X` after a selected control → the ghost `2 · code`, the chain stays armed, three rows with the exchange second and two part headings, the exchange labelled 2, the on-map 13.5 row; Export ▾ this course → two pages, two own sheets with different windows; Layout mode → part 2's sheet (`data-section` 1) deleted → `EXCHANGE_WITHOUT_SHEET` with *Part 2* |
| unit (web) | `lib/editor/__tests__/structure-edit.test.ts` "variation groups (F7)" | §12: the displayed path's sequence; a position after a group at the top level (the off-by-group regression); the group's legs insert into it (into, out of, an empty active alternative), the leg into the anchor top-level; ↑ / ↓ keep a row's level; a loop's anchor visit takes no ✕, move or leg, its legs belong to the alternatives, B active first; `removeSite` in every alternative, an all-empty group kept, an unanchored one dissolved; the item after a group keeps its leg, an alternative's first item's leg dropped when its predecessor changes; `setLegProps` by path; `setNumberHidden` in alternatives; `createGroup` / `canCreateGroup` (top-level legs only, `v1`, `v2`); add / remove (two left: dissolve) / rename (blank, taken) / loop; `moveToAlternative` |
| unit (web) | `lib/editor/__tests__/sequence.test.ts` "variation groups (F7)", `state.test.ts` "variations (F7)" | §12: rows' paths in the explicit structure and their group, a loop's anchor-visit row, the leg's path, `courseViewOrders`, `variationBlocks` after the anchor, `alternativeEndAt`; the reducer's Variant view (needs a key), All variations, the active alternative (to Course view, claims `K`, Escape drops the claim before the course), a course change resets them; F8 "in Class view and Layout mode a key picks the variant drawn": the key alone changes (view, class and mode kept), null = the first, another class resets it, Variant view kept into Layout mode |
| unit (web) | `lib/editor/__tests__/variation-view.test.ts`, `checks.test.ts` "structure with a group", `pages/editor/__tests__/action-bar.test.ts` "Create variation here" | §12: `courseDrawOf` (legs by drawn neighbours, the crossing as a string, hidden numbers), `allVariationDraws` (F15: the spine carries the shared numbers when the variants number alike, never otherwise, the override carries them; spine with a none leg, a branch per alternative, the shared exit leg, a loop's petals), `withCourseOverride`; the checks' displayed path and `checkGroupsOf`; *Create variation here* after *Add bend here*, only when the page says so |
| E2E | `e2e/course-editor.spec.ts` "F7: variations and loops" (`chromium`), "F7 on a phone" (`mobile`) | §12: a leg → *Create variation here* → one block with tabs A (pressed) and B, `course.variantList` `A`, `B`; tab B, `K` with nothing selected → the control is B's row; Variant ▾ B numbers it 2, A numbers the anchor's next 2; All variations → the two alternatives' legs in different tints (canvas pixels); `VARIATION_UNBALANCED` listed and locating the anchor; *Loop* → `AB`, `BA`; F8: Export ▾ *This course (2 variants)* → two pages, *All variations* → one, *One map per runner* disabled; Layout mode's Variant ▾ shows AB, no *All variations*, BA picked keeps the mode and *This variant BA* prints one page; three undos → loop, the control, the group gone; F15 (a second test): a control into B and one into A → All variations labels both 2, the anchor 1 and the exit 3; a second control into B → codes again. On a phone a group written over tRPC shows its block with `editor-variation-readonly`, ＋ and *Loop* disabled, and tab B switches the rows |

## Pending in this chapter

- **The top bar past tier 2** (§2 "Top bar", F29): below 1170 px of row
  only the mode words have gone; the view group, presence chips, a save
  error's words and course names longer than the seed's still wrap the row
  (`flex-wrap`, the last resort the user chose). The thresholds were
  measured with the seed's widest course and an estimate for Variant ▾ /
  All variations, not with a seeded variation group.
- **The selected leg's highlight** (§6.7): the selected leg has no
  highlight beyond the UI outline.
- **The leg's gaps in the Leg section** (08 §5.2 "leg: style, gaps,
  corridor, crossing"): gaps stay the `G` tool's (§6.3); the crossing row
  is F4's (§6.8).
- **The placement loupe on the phone's `T`** (§10 "Loupe", F27): the
  phone's text tool takes taps (no pin-drop crosshair), so the toggle shows
  no loupe there; the + menu's `K`, `S`, `M` have it above the crosshair.
- **Crossing and map-issue points and map exchanges on the phone** (§6.8,
  F4; §6.9, F5): the phone's + menu offers none of them, and its rail has
  no `C` or `X`; a tapped crossing or map-issue point or exchange selects
  (delete, notes) as any site.
- **A picked setter map on the canvas** (§9, F10): Field mode lists the
  setter's controls, but the map keeps the course's highlight; drawing the
  setter's group highlighted goes through the layer request (F7's files).
- **Variations, beyond F7** (§12): Variant ▾ and All variations are the
  desktop top bar's — the phone's overflow menu offers neither (its block
  switches the alternative shown); without Variant ▾ there, Class view
  and Layout mode of a root draw its first variant. Rows move between alternatives by a drop on
  a tab (to the end); a drop at a position inside another alternative is
  ↑ / ↓ after it. A course ending `… group, finish` takes an armed `K`
  with nothing selected and no activated alternative into the group (its
  last leg is the group's exit leg); select the last top-level control
  first to append at the top level.

- **Selection highlight through the dynamic bucket** (04 §7: the
  selected object's passes redrawn in a highlight colour): the selection
  and multi-selection rings and object outlines stay UI layer; D5 left it
  because it is `map-gl` work outside its area (decision log, D5).
- **Course objects**: draw order (`courseObject.reorder`) has no control
  in the editor; no image (logo) tool; `inset_frame` is slice F's.
- **Derived instruction rows**: 13.3 / 13.4 derive from the legs'
  crossing points since F4 and replace a hand-placed row of the same kind
  at the same anchor (`control-descriptions-and-editor-geometry.md`
  "Course-level instructions"); 13.5 after a map exchange since F5. The
  inspector's special rows still list the stored ones only, so a stored
  13.3 or 13.5 that a derived row replaces still shows there (its length is the
  derived row's). The server keeps `kind` a free string
  (`z.string().max(20)`); only the inspector restricts it to the 13.x /
  14.x options.
- **Course delete** stays on the Courses page.
- **One default start for every reader** (P5, for user review): the
  viewer's course list falls back to the start nearest a legacy course's
  first control (and the finish nearest its last), while the readers
  (`courseSequenceOf`: legs, lengths, print, export) and the inspector's
  rows take the event's lowest one. In an event with several starts and no
  explicit assignment the editor can draw a leg from a start the print does
  not use. Dropping "nearest" for the readers' default (one line in
  `lib/course-overlay-ids.ts`) would make them agree; kept per the
  feedback-2026-11-07 default. Also: an explicit start or finish that is
  not positioned is absent from `course.controlCoordinates`, so the
  overlay falls back for it (as the old memo did), while the readers keep
  it and skip its leg.
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
- **"Moved by X at T" by name in E2E**: the two-context conflict test
  (D10) asserts the moved notice and its position, not the actor's name
  (the E2E instance runs without per-user sign-in); the name is unit and
  integration only.
- **One-finger drag of a course object on touch** (its body or a
  vertex): a tap selects it and two fingers scale it (§10); moving it is
  the mouse's, or a later row with the object's own nudge.
- **Geometry editing on touch** (§7 "Editing geometry", §6.4): there is
  no Alt on touch, so corners while drawing, pulled curve vertices,
  handles, grips, vertex insert, vertex delete and the corner / smooth
  toggle are the mouse's; a touch-drawn area is smooth throughout (F18:
  taps follow the default, answered by the user on 2026-11-08). Corners on
  touch wait for a vertex action bar on the selection with **Smooth** /
  **Corner** buttons (and insert, delete).
- **Offline writes in Field mode** (§9 "Offline"): a queue for
  `control.update` / `control.check` with the field-move rebase on replay
  (row D9c).
- **Tablet bottom action bar** (08 §5.5 "Tablet: collapsible side
  inspector + bottom action bar"): a tablet keeps the desktop chrome and
  the action bar under the selection, with the touch gestures (§10).
- **Pin-drop for the area and text tools on a phone**: they arm from `+`
  and take taps on the map (§6.4), not the crosshair flow.
- **Map info on a phone** (P6, feedback-2026-11-07 default, for user
  review): the map-info dialog (§2) is the desktop top bar's; a phone
  entry in the overflow menu is the follow-up. The phone's peek line
  keeps the map scale meanwhile (§10).
- **Layout on a phone**: the mode switch omits it (§10, decision log
  2026-11-03; 08 §5.5 keeps template editing on the desktop); aligning
  the map by touch would be its one use — D-mobile decides.
- **The selection ring in `V`** stays for a selected control, the one
  just placed from *Add control* included (P4 reverted P1's hiding; D12
  hides it while a tool is armed);
  whether it should go entirely, now that the purple circle is the mark,
  is the user's call (feedback 2026-11-04 and 2026-11-06, flagged;
  2026-11-07 item 1 wants it after placing).
- **A view switch while armed**: switching to All controls with a
  placing tool armed keeps the chain's insertion point, so the page still
  computes a provisional visit the layer does not draw (no highlighted
  course). P4 draws the ghost circle there (`provisionalDrawn` is gated on
  Course / Class view at the binding); re-arming the chain on a view
  switch would make the visit itself correct (pre-existing since D5a).
  When the viewer has fallen back to no course layer (`CourseStackError`,
  the banner says so) the page still reports the visit drawn, so the
  ghost has no circle there either; the binding does not see the
  viewer's fallback (P4 review, left as is).
- **Flattening the symbol table at import** (feedback 2026-11-06 item 5,
  the option not taken by P3): merging a heading's variants and dropping
  frames and helpers in the importer would change every document's
  content hash and the importer version and re-import every map, for what
  is a display problem; §7's grouping gives the same list without touching
  documents, print or the layer. The user may still choose it (decision
  log, P3).
- **Proxy-drawn objects are not filterable**: a region selects by the
  drawn symbol, and an object drawn through a proxy (a `missing` symbol,
  or one with neither a drawing nor an applied match) carries the proxy's
  index, so §7 leaves such symbols out and the eyedropper reports a miss
  on them. Selecting them would need the region to carry the document
  symbol (a `course-layer.md` §8 change).
- **Eyedropper texts and touch**: texts are picked by their stored box
  (a point text near its anchor only, no fonts on the main thread, §5);
  on a coarse pointer the eyedropper takes taps with the mouse's 6 px
  tolerance, not §10's 12 px and not the crosshair flow.
