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
| `mode` | `layout` \| `field` \| `map` (§13); on a phone also `course` | Course mode (a phone: Field, §10) |
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
  last answer is not dropped (`checkInbound`, `fetchIfIdle`); a miss while
  a fetch is in flight waits for it. Layout applies the same check to every
  sheet or template it opens, so a create-then-open awaits its list's
  refetch first (*New extra template*, `KeySections.tsx`). Until the
  URL has been taken, a late answer (a class or variant after a cache
  miss) may still set the view over a click made in that moment.
- **Normalised on landing**, as the reducer has it: `mode=layout` with
  `view=variant&variant=<key>` is Layout drawn as that variant
  (`mode=layout&variant=<key>`); a Layout link with a sheet and a variant
  but no `course` loses the variant (the view is taken before the sheet
  brings its course — `layoutEditorHref` always sends the course).
- **Layout's `sheet=` / `template=`** is the target Layout shows — its
  default when none was opened — written as soon as it is known, before
  its resolve lands.
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
  phone opens Field and leaves the URL (Layout is a desktop mode, §10);
  so does `mode=map` (Map mode, §13, is desktop only), which a desktop
  always writes.
- **Inbound links** keep working unchanged: the Courses page's pencil
  (`?course=<seq>`), the Controls page's (`?control=<id>`), the Courses
  page's *Edit layout* (`layoutEditorHref`, `course-layout.md` §4) and
  the retired pages' redirects. The editor rewrites them to their
  canonical order once taken.

**Modes** (08 §5.1): Course, Layout, Field and Map share one canvas and
undo history. Course mode is this chapter; **Layout mode** — the sheet as
the view, course edits locked — is `course-layout.md`; Field mode is D9's
(§9; the initial mode on a phone, §10); **Map mode** — the event's map
corrections, course edits locked, desktop only — is §13 (G6). The **view** picker
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
| Top bar (`TopBar.tsx`) | `editor-top-bar` | course picker (`editor-course-picker`; roots and plain courses — a materialised variant is edited through its root, §12), view (`editor-view-course` / `-all` / `-class`, and for a course with variations `editor-view-variant` (Variant ▾) and `editor-view-all-variations`, §12), mode (`editor-mode-course` / `-layout` / `-field` / `-map`, §13; icons alone when the row is short, "Top bar" below), undo / redo (`editor-undo` / `-redo`), hide other controls (`editor-hide-others`; in Map mode its slot is `editor-hide-overprint`, §13), auto cuts (`editor-toggle-cuts`), the placement loupe toggle (`editor-placement-loupe`, a magnifier, lit — `aria-pressed` — when on; §10 "Loupe", F27), Export ▾ (`editor-export`, icon + label, `course-layout.md` §7), the map info (`editor-map-info`, below), the course-info button and the save indicator (below), who else has a course open (§11), help popover; MapPanel adds descriptions, fullscreen and the viewer its zoom on the same row |
| Tool rail (`ToolRail.tsx`; Layout mode: `layout/LayoutRail.tsx`, `editor-layout-rail`, `course-layout.md` §3; Map mode: `V` and `N` and its own `editor-snapping`, §13) | `editor-tool-rail` | `editor-tool-<key>` for `V`, `S`, `K`, `M`, `X` (map exchange, §6.9), `C` (crossing point, §6.8), `A` (menu `editor-area-menu`, `editor-area-<kind>`, and `editor-area-corridor` — §6.7), `T`, `G`; the snapping toggle `editor-snapping` (§6) |
| Action bar (`ActionBar.tsx`) | `editor-action-bar` | the selection's or phantom's entries, horizontal, centred under the selection, hidden during a drag; ids `editor-action-<id>` as the legacy popover's. Always inside the viewer, 8 px from its edges (`lib/editor/action-bar-place.ts`): near a side it is shifted sideways, and when it does not fit below the selection it goes above it (`data-placement="below" \| "above"`). It is never wider than the viewer less 16 px. The *Also in* line is one line cut with an ellipsis, with the whole list in its `title` (the inspector lists the courses too) (`docs/bugfix-action-bar-off-viewer.md`). The viewer positions it (`actionLayout: "bar"`); on a phone the same list is the bottom sheet's peek row (`actionLayout: "host"`, §10) |
| Inspector (`Inspector.tsx`, `modes/CourseMode.tsx`, `modes/ObjectSection.tsx`) | `editor-inspector` | collapsible sections: course (create, sequence — a variation group as a nested block `editor-variation`, §12 —, visit order, description sheet — `editor-description-instructions`, §4 —, clone), selection (a site: code, kind, position, description summary, "also in", hidden number, notes — §6.6; several controls: `editor-multi` with the bulk actions — §6.5; a course object: `editor-object` — §7; a leg: `editor-leg` — §6.7, `modes/LegSection.tsx`), inventory (`editor-inventory-panel`, collapsed), checks (`editor-checks`, §8) |
| Map info (`MapInfoDialog.tsx`, model `lib/editor/map-info.ts`; P6) | `editor-map-info` → `editor-map-info-dialog` | a map icon button (`IconMap`, `components/map-icons.tsx`) in the top bar right after Export ▾ (`aria-haspopup="dialog"`, `aria-expanded`); a click opens a modal (`role="dialog"`, `aria-modal="true"`, centred over a dimmed backdrop; the close button `editor-map-info-close`, a backdrop click or Escape closes it). Its header shows the map's file name (`editor-map-info-name`, `data-name`) or, without a map, `editor-map-info-none`. Its rows, each only when it has a value: the scale `editor-map-info-scale` (`data-scale`, `1:10 000`), the north lines `editor-map-info-north` (the `NorthLinesBadge` sentence, `north-lines-badge` with `data-north-lines`; *No magnetic north lines found* when the file has none), the file `editor-map-info-file` (size and upload time, `data-bytes`, `data-uploaded`); then the document section `editor-map-info-document` (`data-source`, `data-objects`, `data-symbols`, `data-colours`; read from the loaded document's header, absent while it loads or the import runs) with `editor-map-info-source` (OCAD and its version, or OpenOrienteering Mapper), `-content` (objects · symbols · colours), `-symbol-library` (the matched symbol library and version; not `-library`, which is the action below), `-crs` (EPSG code and name) and `-importer`. Its actions: *Review symbols* (`editor-map-info-review`, a link to `/<event>/map-review/<documentHash>`, only once the document exists — `map-symbols.md` §8.7), *Replace map* (`editor-map-info-replace`; *Upload map* without a map; the hidden `accept=".ocd"` input), *From club library* (`editor-map-info-library`, only when the club library lists a map; opens `club-map-picker`, `club-library.md`). An upload's progress, error and the stale-north-lines notice (`map-upload-notice`) show in the dialog's footer |
| Course info (`EditorStatus.tsx` `StatsButton`, model `lib/editor/status.ts`) | `editor-stats` → `editor-stats-popover` | an icon button in the top bar (`aria-haspopup="dialog"`, `aria-expanded`) with the check count as its amber badge (`editor-stats-badge`, `data-count`, absent at zero, §8); a click opens the popover (`role="dialog"`; a second click, an outside click or Escape closes it — Escape closes only the popover, the editor's Escape cascade of §3 is not stepped, so an armed tool stays armed). Its rows, each only when it has a value, in this order: `editor-stats-controls` (`data-count`), `editor-stats-length` (`data-m`), `editor-stats-climb` (`data-m`), the shown sheet's key in Layout mode and Class view (`editor-stats-sheet`, `data-key`, `course-layout.md` §6), `editor-stats-snapping` when on, `editor-stats-checks` (`data-count`, amber). No map scale since P6: it is the map-info dialog's (`courseInfoRows`). With no course and no sheet the popover says *No course* |
| Save indicator (`EditorStatus.tsx` `SaveIndicator`) | `editor-save-state` | in the top bar after the course-info button: a dot and the save state's words (`data-state` = `saved` / `saving` / `error` / `conflict` / `queued` — Field mode's writes waiting in the outbox, §9 "Offline", D9c —, `role="status"`, `aria-live="polite"`, the words also its `title`). `saved` / `saving` are the dot alone (green / grey pulsing; the words `sr-only`), so P2 adds a dot (≤ 16 px) and an icon button (≤ 32 px) to the top bar's row (how the row makes room on a laptop screen: "Top bar" below, F29); `error` / `conflict` show their words (`editor-save-state-text`, red) at every width — a failed or conflicting save never hides behind a popover or a tooltip; `queued` shows its words too, amber |
| Conflict notice | `editor-conflict` | §3 |
| Map mode (§13) | `editor-mode-map`, `editor-hide-overprint`, `editor-inspector-map-object`, `editor-map-object` (`-none`, `-symbol`, `-swatch`, `-hide`, `-restore`), `editor-corrections` (`-count`, `-none`, `-apply`), `editor-correction-row` (`-locate`, `-revert`), `editor-map-none`, `editor-map-disabled`, `editor-map-readonly`, `editor-tool-N`, `editor-map-node`, `editor-map-node-grip`, `editor-map-nodes-hint`, `editor-map-nodes-none` (`data-reason`), `editor-snapping` (Map mode's own, "Nodes") | the inspector's *Map object* and *Corrections* sections in place of the course's; the rail's `V`, `N` and snapping toggle |
| Field mode (§9) | `editor-inspector-field`, `editor-field-selection`, `editor-nudge-pad`, `editor-field-offline` | the control list with distance / bearing and check-off in place of the sequence; the selection's distance, check-off and nudge pad; no tool rail; the outbox notice (offline, or writes waiting: the count, Retry / Discard; §9 "Offline") |
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
| < 1220 px (tier 2) | in addition the mode switch shows its icons alone: `IconModeCourse` (a start triangle, a leg and a control circle), `IconModeLayout` (a sheet with its map frame and title bar), `IconModeField` (a control flag), `IconModeMap` (a folded map sheet with a pencil, §13), `components/map-icons.tsx` |
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
widest row: *Bana 1* with its Class ▾): the full row's content was 1346 px
in English and 1374 px in Swedish before G6; Map mode's entry (§13) adds
41 px with its word (measured, English; 32 px as an icon), so about 1387 px
and 1420 px. A course with variations adds Variant ▾ and All variations
(about 200 px), so tier 1 starts below 1600 px. Tier 1 saves about 385 px
(410 px in Swedish), leaving at most about 1202 px with variations (about
1214 px in Swedish), so tier 2 starts below 1220 px (1170 px before G6's
fourth mode); it saves about 70 px more.
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
Escape steps back: an image's crop mode (J11, §7 "Transform handles";
the image stays selected) → phantom → control → course; with nothing left it
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
result — so back-to-back writes send their predecessor's token. One write
per row is in flight: a write of a row with one in flight waits for it to
settle (`EditorWrites.serial`) and then reads the token its result seeded —
Ctrl+Z pressed twice before the first undo's reply is two writes in order,
not two on one token (docs/bugfix-editor-overlapping-course-writes.md). A
refused write passes the token its refusal seeded to the next; writes of
different rows do not wait for each other.
`course.setControlLabelOffset`, `course.create` / `clone` and
`control.delete` take no token and seed the ones they return
(`setControlLabelOffset` advances the course's token, so it queues as a
course write). Map mode's
`mapPatch.applyChange` / `setEnabled` (§13, `applyPatchChange`,
`setPatchEnabled`) take none either: the patch merges per op id,
last-writer-wins (`map-patches.md` §3.2).

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

**Queued writes** (D9c, §9 "Offline"): Field mode's moves and check-offs
that could not go out wait in the device's outbox and replay in order
under the same rules, each move on the token it was queued with; a
`moved` on replay is the same notice, its buttons settling the entry.
One gesture is still one undo entry; offline, undo / redo run only those
entries, and an undo back to where a waiting move started drops it.

## 4. Course mode

Course mode's gestures and keys below are locked in Layout mode
(`course-layout.md`) and Map mode (§13): neither gets the control, label,
leg or map-click callbacks, and their rails and keys are their own.

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
| Add start / finish | `control.create { status: 4 / 5 }` without codes: the lowest free unit code in 3–10, then 11–30, is its code and id (F32, `course-layer.md` §6.3); named "Start N" / "Mål N" and shown by that name | delete / restore |
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
  (`lib/editor/symbol-pick.ts`, built once per document hash and patch
  version like the snap index, over the effective document — G4: hidden
  objects are not picked or counted, an object of a patch symbol is not
  picked by symbol): the objects whose stored box, grown by the tolerance,
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
  An `image` course object is a **filled** `UiArea` (J7, superseding
  J6's outline-only rule): its box turned by `rotationDeg` (`imageRing`)
  hits anywhere inside, exactly (no reach), but after every other target
  — a control, a number, a leg, a line's stroke and every other area's
  outline win over it, so a control inside a lucka is still grabbed.
  An **unselected** image takes no press: a drag inside it pans the map,
  and a click there, off every other target, selects it (the page's map
  click, `imageAt` in `lib/editor/image-box.ts`, so a touch tap does the
  same); §7.
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
placing tool (`S`, `K`, `M`, `X`, `C`, `T`, and `I` with a graphic picked) sets `hoverPoint`: the point a
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
| `I` | image (J7) | the graphics picker opens beside the rail's button (`editor-image-picker`: the event's graphics, then the club's; upload, save and delete with `courses.edit`); a tile's Place arms that graphic, then one click places it (§7); nothing is placed before a graphic is picked (`editor-image-hint`). Course mode only; the phone's `+` menu has no entry (Pending) |
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
not snap — read once per document hash (and patch version) into a 2 mm
grid, on the main thread (the document bytes are the viewer's
`useMapDocument` copy). The grid is of the effective document (G4,
`map-patches.md` §2.4): objects the event's patch hides do not snap,
modified and added ones snap where it puts them. The
viewer applies `editor.snap` to its control drags; the tools snap their
own points.

The grid holds vertices only. The nearest point **on a line** is
`nearestOnLines(doc, pt, maxMm, symbolFilter, skip?)` beside it (row G28):
the line objects of the effective document whose symbol passes the filter
(hidden objects and symbols, and object `skip`, left out), curves
flattened to 0.01 mm, the reach inclusive, a tie to the lower index; it
returns the point, its distance, and the hit part with its two end nodes.
A linear scan with a bounding-box reject, asked twice per line by the GPS
tracks' end snap (§13 "GPS tracks: junctions"), not on pointer moves.

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
- **`Ctrl+D`** duplicates the selected object, **`Ctrl+C`** / **`Ctrl+X`**
  copy / cut it, **`Ctrl+V`** pastes (J12, §7 "Duplicate, copy, cut,
  paste"); with `V`, in Course mode, for a setter who may edit. `Cmd` on a
  Mac.

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
  (`-remove`), and **White opacity (%)** (`-opacity`, 0–100 in steps of
  5, stored 0–1; J13, F26 folded in — it was hidden since F25 while the
  band drew opaque). Below 100 the band is translucent: the map shows
  through it, veiled (`course-layer.md` §10.2). One opacity draws every
  band — the most transparent one in view — which a hint under the fields
  says (`editor-leg-corridor-opacity-hint`). Every corridor write spreads
  the stored corridor, and the API
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
  undo entry. A **selected image** (J7) is outlined by its turned box
  (not the stored diagonal) with four corner handles: a press on a corner
  (7 px) resizes it in its own frame, the opposite corner fixed where it
  is drawn, keeping the box's current ratio while the aspect lock is on
  (`EditorState.aspectLock`, on by default; the inspector's checkbox),
  at least 1 mm a side (`resizeBox`, `lib/editor/transform-gestures.ts`, shared with Layout mode since J9); Shift
  inverts the lock, read live during the drag (J11); a press inside it (its hit) moves
  it; a corner is never focused, so `Delete` deletes the image. A press
  on a control inside the selected image is the control's. While dragging, the page hands
  the viewer the object as a **draft** (`draftObjects`, drawn instead of
  the stored one with the same id) and, for a filter region,
  `draftFast` — the layer's fast bbox predicate during the drag, the exact
  one on release (`map-rendering.md` §4.11).
- **Create**: `A` (§6.4), `T` (a click places a map text: "Text",
  4 mm, upper purple, `{ all: true }`, then selected) and `I` (J7: a
  click places an `image` of the picked graphic, its box centred on the
  snapped point at the graphic's aspect from `graphics.list`'s pixel size,
  30 mm on its longer side — map-scale paper mm like a text's size, so
  45 mm on paper for a 1:15 000 map printed at 1:10 000 — a 30 mm square
  when the size is unknown; `{ all: true }`, one `courseObject.create`,
  selected, the tool back to `V`). While armed with a graphic, a dashed
  ghost of the box follows the hover (`editor-image-ghost`).
  Default props: filter region `{ mode: "hide", symbols: [] }` (nothing
  hidden until symbols are picked), others the kind's defaults
  (`course-layer.md` §8.1).
- **Inspector** (`modes/ObjectSection.tsx`) — every change one
  `courseObject.update`, one undo entry:

  | Kind | Props |
  |---|---|
  | out-of-bounds area | hatch: *Out of bounds (709, stripes)* / *Dangerous area (710, cross-hatched)* (`course-layer.md` §3.1; the name first — in ISOM 2017-2, 710 is the crossing point); border none / solid / dashed |
  | out-of-bounds line | 708 / 711 |
  | map text | text, size (paper mm); opacity (%), blend (Normal / Multiply), rotation (°, about the anchor, J4) |
  | image (J7) | opacity (%), blend, rotation (°, about the centre), flip H / V, width and height (mm, about the centre; the aspect lock), crop (whole %: left, top, width, height, each side ≥ 1 %, kept inside the graphic), *Reset crop* and *Crop by its edges* (J11, crop mode; not on a coarse pointer), *Cut out graphics below* (J15, `editor-style-knockout`) |
  | line or area other than the toner saver (J11) | *Turn by °*, *Turn 90°*, *Flip ↔*, *Flip ↕* (§7 "Transform handles") |
  | toner saver | margin; *Regenerate from the course* |
  | filter region | mode (hide / clip); symbols: all, **picked symbols** or **picked colours** (the document's colour rows, a CMYK swatch and the name); **invert** ("show only these inside"); the **eyedropper** (§6.4). Picked symbols are listed **one entry per heading** (`lib/editor/symbol-groups.ts`, feedback 2026-11-06 item 5): a symbol's heading is the library code of its applied match (`isAppliedMatch`: automatic or reviewed — `601` for a match to `601.b`), else its source code's base (`101.1` → `101`; a non-numeric code such as `graphic` stays whole), so a heading's variants, minimum-size and tag-line versions and duplicates are one entry (`editor-filter-symbol-<heading>`, `data-members` the member indices) that toggles all its members: checked when all are picked, indeterminate when some are (an older region), and a toggle completes a partial group. Named from the library heading in the UI language when a member's match is applied, else by its first member's source name; a swatch (`editor-filter-swatch`): the library preview of the most used member's applied entry, else the server's preview of the most used member's own drawing (`/api/map-documents/:hash/symbols/:idx.png`, event-scoped). **Not listed**: hidden symbols (OCAD's hidden status, OMAP helpers), symbols no object uses, and symbols drawn through a proxy (`missing` ones, and those with neither a drawing nor an applied match — a region selects by the drawn symbol, never the proxy). Headings of the document's library come first in code order; headings outside it (club codes, frames, legends), `graphic` entries and rectangles fold under **Other** (`editor-filter-other`, collapsed). The search matches the heading, its library names in both languages and the members' source codes and names, and opens Other. Presentation only: the stored `symbols` stay document symbol indices (`course-layer.md` §8), nothing changes at import |
  | white-out | opacity (%) (no blend: a white Multiply leaves the map unchanged; the stored field stays legal) |
  | marked route | — |

  The style fields are `StyleFields.tsx` (shared with Layout mode from
  J8), their writes `lib/editor/style-fields.ts`: opacity is stored 0–1
  and shown in %; a default value (100 %, Normal, 0°, flip off, the full
  crop, *Cut out graphics below* off) removes its key, so an untouched
  object's props stay as before. **Cut out graphics below** (J15, user
  2026-11-19) writes `props.knockout: true`: the image cuts the images
  below it in the course layer by its box (course-layer.md §3.6
  "Knockout images"), so hatches placed over a whole-map overlay show the
  map through their openings, and moving a hatch moves the hole. Its
  hint (`styleKnockoutHint`) says so. Duplicate, copy and paste carry the
  flag with the rest of the props. A
  size or crop edit writes geometry and props in one update. A **crop
  edit keeps the visible pixels' scale and place**: the box shrinks or
  grows by the crop and its centre moves with the crop's centre, through
  the flips and the rotation (as J9's crop mode), so *Reset crop* gives
  the whole graphic back at the same scale. The crop, not the box, keeps
  each side at least 1 mm (at least 1 %, and at least the fraction that
  is 1 mm at the image's scale), so the scale always holds. A size field
  writes the geometry only; undo restores what the inspector showed, and
  a failed write drops the drafts and the inspector's optimistic values.
  During a crop the canvas draws the new crop in the new box at once (a
  props draft beside the geometry draft).

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
  — the stored vertices with their handles, `-props`, `-scope`;
  `data-attach` — the wire `attach` as JSON, empty when free — and
  `data-drawn` — the `x,y` pairs where it is drawn, empty when its
  control is not drawn, J10).

### Attached objects

Row J10 (`course-layer.md` §8.1 "Attachment"). Any object but a toner
saver may follow a control: moving the control moves the object and
writes nothing to it. The editor works on the object **where it is
drawn** (`lib/editor/attach.ts` `shownObject`): its geometry moved by
the control's drawn position minus `at`, and `at` that position, so the
layer draws it at the same place. The drawn positions are the layer's
derivation's sites (`courseInfo.derivation.sites`; before the layer
reports, the stored coordinates), so a dragged control's object follows
the drag's result, not a stale row. Selection, the hit-test (the
viewer's closed-area rings resolve the same way), every gesture, the
inspector and drafts use the shown object, a canvas gesture's start
(the undo's "before") included; an object whose control is not drawn in
the view is not shown or selectable, and a selected one is dropped from
the selection when its control stops being drawn (user answer 8).

- **Writes.** Every write that sends geometry sends `attach` with it
  (the shown one), so undo puts back the shape and the offset together.
- **Inspector** (`editor-object-attach`, `data-attached` the control's
  code, empty when free): *Attached to <code>* or *Not attached*, then
  - *Attach to nearest* (`editor-object-attach-nearest`): the drawn site
    nearest the object's centre (`objectCentre`: a text's anchor, else
    its vertices' bounds' centre; `nearestSite`); it stays where it is
    drawn (`attachPatch`).
  - *Attach to a control I click* (`editor-object-attach-pick`,
    `aria-pressed` while armed): the next control selected becomes the
    one it follows, and the object is selected again. The button again,
    selecting another object, a selection cleared to nothing (Escape, a
    click on empty map) or leaving Course mode or `V` cancels it, so
    nothing attaches once the armed button is out of sight.
  - *Centre on control* (`editor-object-centre`): moved so its centre is
    on its control (the nearest when free) and attached to it
    (`centrePatch`).
  - *Detach* (`editor-object-detach`, attached only): free, kept where it
    is drawn (`detachPatch`).

  Each is one `courseObject.update { geometry, attach }` and one undo
  entry. Disabled when no control is drawn.
- **A deleted control** (user answer 7): nothing is written to the
  object; the API reads it as detached where it was drawn
  (`course-layer.md` §8.4), so it stays in place and *Detach* is gone;
  undo of the delete (`control.restore`) attaches it again.

### Transform handles

Row J11 (`course-layout.md` §3 "Transform handles"; user answers 4–6).
Course mode uses Layout mode's module, `lib/editor/transform-gestures.ts`,
directly in paper mm (y-up; no adapter, no printable-area clamp: Course
mode has no page). Mouse only.

- **Rotate knob** (`editor-object-rotate`): a selected image's sits 24
  screen px above its top edge along the box's own up; a selected map
  text's on a 24 px stem from its anchor along its own up (a text stores
  no box: no corners, resize or crop on the canvas; its size stays the
  font-size field). Dragging it sets `rotationDeg` from the pointer's turn
  about the pivot since the press — an image's centre, a text's anchor
  (user answer 6) — so it never jumps; Shift snaps to 15°, read live;
  0° drops the key; the value is in (−180°, 180°] in 0.1° steps
  (`rotationAt`). One `courseObject.update { props }` (no geometry, so no
  `attach`), one undo entry; during the drag the canvas and the inspector
  show a props draft. The drag carries only its change (the rotation, or
  the crop and the box); the page applies it to the props shown at that
  moment — the last props sent included, so an inspector edit committed by
  the press's blur is kept — and those are the undo's "before". A
  cancelled drag puts back only the drafts it found.
- **Pressing order** on a selected image or text: the knob (it wins over
  what lies under it, as a corner does), a corner or a crop edge, the
  body.
- **Crop mode** (an image): a mouse double-click on the selected image
  itself (not on a leg or control inside it, which keep their
  double-click, nor on a corner handle), or
  the inspector's *Crop by its edges* (`editor-style-crop-mode`,
  `aria-pressed`; *Done cropping* leaves). The whole graphic shows dashed
  (`editor-object-crop-full`) with an edge handle per side
  (`editor-object-crop-edge`, `data-edge`); the corners and the knob are
  hidden and the body still moves. An edge drag moves that crop side (a
  flip mirrors which source side it is), the opposite side stays, and the
  visible pixels keep their scale and place (`cropEdge` through
  `cropChange`: whole per cent, inside the graphic, at least 1 % and 1 mm
  a side). One `courseObject.update { geometry, props }`, one undo entry.
  It is page state, not an undo step; Escape (the cascade's first step,
  §3), *Done cropping*, another selection, another tool or mode leaves
  it; it is not offered on a coarse pointer.
- **Turn and flip** of a line or area (`oob_area`, `oob_line`,
  `whiteout`, `marked_route`, `filter_region`; not the toner saver, whose
  shape is the course's hull — user answer 4, "lines and areas"): the
  inspector's *Turn by °* (15° by default, clockwise as seen), *Turn 90°*,
  *Flip ↔* and *Flip ↕* (`editor-object-transform-*`, the shared
  `TransformButtons`) bake the change into the vertices and their Bézier
  handles (`transformVertices`) about the centre of the vertices' bounds
  — the centre *Centre on control* puts on its control, so a centred
  attached object turns about its control. One `courseObject.update
  { geometry }`; a whole turn writes nothing. An image's flips stay the
  inspector's checkboxes (J7).
- **Attached objects**: all of it acts on the shown object (§7 "Attached
  objects"); the crop and the turn send geometry and so `attach`.
- Escape during a knob or crop drag cancels it as any drag (§3, F24):
  nothing written, then the cascade.

### Duplicate, copy, cut, paste

Row J12 (user answers 9 and 10). One app clipboard, not the system's:
`lib/editor/clipboard.ts` holds **one** object — a course object in Course
mode, a page object in Layout mode (`course-layout.md` §2 "Keys") — in
memory and in `localStorage` (`oxygen.editor.clipboard`, `v: 1`), so it
crosses sheets, templates, events, reloads and tabs. It is read at paste
time; an unreadable or older entry is empty; a blocked or full storage
keeps the memory copy (this tab still pastes). The keys work with `V`, in
Course mode, for a setter who may edit, on `keydown` only (no context-menu
item yet); a held key does not repeat. Copy and cut leave a text selection on the page to the browser. A stored entry a paste could not read (a course entry without valid points, props or scope, a page entry that does not parse) is empty.

- **`Ctrl+D`**: a copy of the selected object **as shown** (an attached
  object at its drawn place, a drag's geometry or props draft included, else the props last sent), 3 mm right and
  3 mm down on paper (`duplicateBody`), the same scope; an attached object
  stays attached to the same control with its `at` kept. One
  `courseObject.create`, one undo entry, the copy selected.
- **`Ctrl+C`**: the shown object's kind, geometry, props, scope, the
  courses that scope resolved to (`inCourses`) and its attachment, with
  the event it was copied in (`courseEntry`). **`Ctrl+X`**: copy, then the
  object's delete (one undo entry, as `Delete`).
- **`Ctrl+V`** with no control selected: the copy's centre (the centre of
  its vertices' bounds, `objectCentre`) on the pointer's last place on the
  map, or on the view's centre when the pointer is off it; **free** — a
  pointer paste never attaches (`pasteAt`). One create, one undo entry,
  the copy selected.
- **`Ctrl+V` with controls selected** (one, or a multi-selection; user
  answer 10): one copy on each selected control that is drawn here,
  attached to it — at the copied offset when the original was attached
  (its geometry moved by the control's position minus the original `at`),
  else centred on it (`pasteOnSite`). The copies are created in turn
  (`createObjects`; a failure deletes the ones made) and are **one** undo
  entry; the controls stay selected. None of them drawn here: *None of the
  selected controls is drawn in this view.* (`clipboardNoDrawnControl`).
- **Scope** (user answer 9, `pasteScope`): the original's, when it was
  copied in this event and would be drawn in this view (`all`, or a course
  it resolved to is drawn); else the current course (`{ courses: [id] }`),
  or `all` in view All. A duplicate keeps its scope.
- **Refused**, the reason on the page's error line (`editor-error`), nothing
  written: a page object's entry (`clipboardWrongType`); an image whose
  graphic is neither this event's nor the club's (`graphics.list`, fetched at
  paste time; a failed fetch says so, `clipboardGraphicsUnknown`;
  `clipboardGraphicMissing`); a filter region that picks symbols or
  colours, copied in another event (its ids are that map's,
  `clipboardRegionForeign`; one that hides *all* pastes); a toner saver
  onto controls (it cannot attach, `clipboardUnattachable`).
- Sizes are copied as paper mm verbatim: an object copied from a map of
  another scale keeps its paper size (Pending).

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
- **Offline** (row D9c; 08 §5.5 "Offline", §12 "Field-mode conflicts";
  decision log, D9 and D9c). Field mode's moves — a long-press drag, a
  nudge, the pad's numeric fields — and its check-offs, with their undo /
  redo, go through the device's **outbox** (`lib/offline/control-outbox.ts`,
  the page's `useFieldOutbox`). The map keeps drawing from the cached
  document (B4, `map-storage.md` §7.1).
  - **When a write queues.** Offline (`navigator.onLine` false), while
    entries already wait (order is kept), or when the request gets no
    answer from a server (a tRPC client error without an error body). A
    server's answer of any kind is never re-queued. Online with an empty
    queue a write goes out at once, as in the other modes, and its
    conflicts are §3's.
  - **Storage.** The Dexie table `controlWrites` in `oxygen-offline`
    (version 4, additive; `offline-architecture.md` "Station
    resilience"), keyed by an increasing `seq` — the replay order — with
    the event's `nameId`. It survives a reload and a browser restart; the
    timing journal's `events` outbox and `events.push` are not used
    (decision log, D9c: they carry last-writer-wins upserts without the
    version token).
  - **One move and one check entry per control.** A second move of a
    control merges into its entry: the first `from` and token are kept,
    the newest position taken. A move back to where the entry started,
    or a check-off toggled back, drops the entry — an undo offline sends
    nothing. An entry in flight is never dropped: the newer value goes
    out after it (from where the first put the control, on the token that
    write returned). The count shows controls waiting, not gestures.
    An entry keeps its class across merges, so the replay applies the
    right row of §3: a **move** entry (it has a `from`) stays a pure move
    — the position and `autoDescribe`, as online — even when an undo's
    description restore merges into it (offline nothing reached the
    server, so the restore is the stored description, and the move rule
    must not re-send a description over one edited elsewhere); a **plain**
    entry (an undo of a move already sent, restoring its description,
    no `from`) stays plain — the newest position and the newest
    description restore — and a conflict on it is "changed elsewhere"
    (*failed*), never a rebase. A drain starting clears a flight flag left
    by a tab closed mid-send. Decided by the D9c session (planner's
    recommendation, the class rule after the spec review), for the
    user's review.
  - **Each move keeps the token it was queued with** (§3 "Tokens"):
    `updateControl(input, from, { baseVersion })`. After reconnect the
    refetch seeds the `VersionBook` with the server's newer token, which
    would hide a move made elsewhere meanwhile. A check-off sends none, as
    online.
  - **Shown at once.** The queued positions and check-offs are patched
    into the query cache (`course.controlCoordinates`, `control.list`
    `checkedAt`) over the server's last rows, re-applied after every
    refetch; the canvas, the list, the pad and the peek KPI read them
    there. An entry that drops out offline shows the server's value
    again; a sent one holds until the refetch answers.
  - **Replay** on mount, when the device comes back online, when the tab
    is shown again and every 10 s while entries wait and the browser
    says it is online; one tab at a time (`navigator.locks`). Entries go
    out in `seq` order through `EditorWrites` under §3's rules:
    - the other side changed only fields a move does not touch → the
      move is re-sent once on the server's token, no notice;
    - the other side moved the control too → the entry stays as a
      *conflict* and becomes the moved notice (`editor-conflict`,
      `data-kind="moved"`, "Moved by ‹who› at ‹time› to x, y" from
      `control.lastChange`, §11), one at a time: **Keep mine** sends it
      again from their position on the server's token, **Keep theirs**
      drops it. A new move of that control does what Keep mine does,
      from where it now is. A `moved` answer at the entry's own position
      is the write having landed before its answer was lost: done;
    - an undo's write restoring a description (not a move) that cannot
      be merged, or any server refusal (`NOT_FOUND`, `FORBIDDEN`, a
      leased event's "checked out to venue") → the entry is kept as
      *failed*, never dropped silently; no answer → the drain stops, the
      rest wait.
  - **The notice** `editor-field-offline` (`FieldQueueNotice`) shows in
    Field mode while offline and in any mode while entries wait:
    `data-online`, `data-pending` (entries pending or in conflict),
    `data-failed`. Offline with nothing waiting: "Offline — moves and
    check-offs are kept on this device and sent when the connection is
    back."; with *n* waiting: "Offline — *n* changes waiting to be sent.",
    online "Sending *n* changes…"; failed ones: "*n* changes not sent:
    ‹reason›" with **Retry** (`editor-field-queue-retry`; a move then goes
    on the book's newest token) and **Discard**
    (`editor-field-queue-discard`). The save indicator reads `queued`
    ("Waiting to send", amber, words shown) while entries wait and
    `error` while one has failed — never *Saved* (§2).
  - **Another mode's move of a waiting control.** A drag in Course or
    Layout mode of a control whose move waits in the outbox (a conflict
    not yet chosen, a failed entry, a write with no answer) goes through
    the outbox too and merges into that entry, so the two cannot race and
    a later Keep mine or Retry sends the newest position.
  - **What stays online-only.** `+` (a create needs server-allocated ids)
    is disabled offline; the site fields of §6.6 (description, codes,
    notes) and every other mode's writes are not queued and fail with
    *Not saved*. Undo / redo offline run only Field mode's queued
    entries: any other entry's write would fail and §3 would drop it.
  - Decided by the D9c session (planner's recommendation), for the
    user's review: the sibling table rather than `events.push`; the
    coalescing; the `queued` save state; only Field mode's moves and
    check-offs queue, drained by the open editor in any mode.

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
  mode switch Course · Field (`editor-mode-*`; Layout and Map stay
  desktop modes), the overflow `editor-overflow` → `editor-overflow-menu` with undo,
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
mode switch's, *Map* included since G6), those on the open course first and highlighted
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

## 13. Map mode

Map mode (08 §5.2–§5.3, the Map column; row G6) edits the event's map
corrections: the **patch** (`map-patches.md`) over the pinned document.
The document itself never changes. G6 is the shell with select, hide and
move; G7 adds the nodes tool `N` ("Nodes" below); G9 the drawing tools
`P` `L` `A`, the symbol picker and *Change symbol* ("Drawing", "Symbol
picker" below); reverse / split / join and holes G10 ("Line and area
operations" below), unresolved ops G11's
(their *Attach* / *Drop* as undo entries and a `symbol` entry's *Attach*
G12b's), promote G12's (the editor half G12b, "Promote" below); G27 the
GPS tracks' Tracks tool `T` ("GPS tracks: editing" below).

**Entering it.** `mode=map` (§1 "URL", always written); the mode group's
fourth entry `editor-mode-map` (`IconModeMap`, a map sheet with a pencil);
desktop only — the phone's mode switch omits it and `mode=map` on a phone
opens Field and leaves the URL, as `mode=layout` does (08 §5.5). Entering
it drops the tool, phantom, the control, multi and course-object selections
(as Layout does); the course stays selected and drawn. **Course edits are
locked**: the viewer gets Map mode's own editor props (`modes/MapMode.tsx`
`useMapMode`, shaped like `useLayoutMode`): no control drag, label drag,
leg click or map click, and an `exclusive` binding, so a click on a control
selects no control; the rail is `V`, `N`, `P`, `L`, `A`, `T`
(`editor-tool-rail`, `editor-tool-<key>`; the armed one `aria-pressed`) and
Map mode's own snapping toggle (`editor-snapping`, "Nodes"); `S` `K` `M`
`X` `C` `G` do nothing. Entering the mode, or another document, arms
`V`. Undo / redo
are the page's (one stack across modes, §3). Without a pinned document the
mode opens and its inspector says so (`editor-map-none`). Without
`courses.edit` (`mapPatch` writes need it, `map-patches.md` §3.2) it is
view-only: select, locate, `H`, `F`; no hide, move, revert or toggle,
and no drawing, change symbol or line and area operation.

**Gestures and keys** (the bindings are `tools/bindings.ts`
`mapSelectBinding` for `V`, `mapNodesBinding` for `N` ("Nodes"),
`mapPointBinding` for `P`, `mapDrawBinding` for `L` and `A`
("Drawing") and `mapTracksBinding` for `T` ("GPS tracks: editing"); the key
table `modes/map/keys.ts`):

| Gesture / key | Map mode |
|---|---|
| Click | asks the viewer's hit-test (`mapObjects.onHitTest`, `map-rendering.md` §5.5 "Document objects") at 6 CSS px and selects the topmost hit (`hits[0]`, the eyedropper's rule, §5); a click on empty map deselects. A late answer (a newer click went) is dropped |
| Drag the selected object | moves it: the press must be on the selected object's drawn shape (tested on the main thread by its symbolised shape, the eyedropper's mechanism); a press elsewhere pans. The object follows through the viewer's draft (`mapObjects.draft`); the release writes one `modify` (below). Escape or the pointer leaving writes nothing; a release without movement writes nothing and is a click (the hit-test again) |
| `Tab` / `Shift+Tab` | steps through the **hit stack** under the last click, topmost down, wrapping — the only way to reach an area under a path; with no click stack (a selection made from *Corrections*, or none) it steps through the **corrected objects** in *Corrections* order (rows whose object is missing skipped), centring each (user 2026-11-15, G6 question 1; 08 §5.3's "next object" over a whole document has no order a user follows) |
| `Delete` / `Backspace` | hides the selected object (*Hide*); in `N` with a node focused it deletes the node instead ("Nodes") |
| `H` | hides the course overprint (and shows it again): the viewer requests no course layer, mirrors no course sites (`editor-site`, `course-site`) and draws no description sheet (`MapViewerEditorProps.hideCourse`). The top bar's `editor-hide-overprint` button, in the slot of `editor-hide-others` (lit, `aria-pressed`, while on). Map mode's own, off on entering |
| `F` | fits the map (the document's bounds, `boundsMm`, through `viewRequest.bounds`) |
| `V` | the select tool |
| `N` | the nodes tool ("Nodes"; user 2026-11-15, G7 question 1) |
| `P` / `L` / `A` | the point, line and area tools ("Drawing"); nothing while drawing is disabled |
| `T` | the Tracks tool ("GPS tracks: editing"; G27): trim and split the selected GPS track; nothing while the GPS tracks are off |
| `Enter` | finishes the line or area being drawn ("Drawing"), or closes *Cut hole*'s ring ("Line and area operations") |
| `Escape` | a drag in flight first (dropped, nothing written), then an armed *Join* or *Cut hole* (dropped, a hole's ring with it; "Line and area operations"), then the line or area being drawn (dropped), then an open *Change symbol* picker, then the palette of a `symbol` entry's *Attach* ("Unresolved", G12b), then the GPS tracks' convert panel (closed, nothing written; §13 "GPS tracks: convert"), then (in `N`) the focused node, then any tool but `V` back to `V`, then the selection, then fullscreen; never the course. As in §3 (F24), the keypress that drops a drag also takes the next step |

The selected object is drawn highlighted (the edit part, `mapObjects.selected`;
an outline for an area, G5) and the canvas carries `data-selected-objects`.

**Ops** (`modes/map/model.ts`; `map-patches.md` §1.1–§1.2). Objects are
named as the hit-test names them: `{ source: sourceIndex }` for a document
object, `{ added: id }` for one the patch adds.

| Gesture | Change sent | Undo |
|---|---|---|
| *Hide* a document object | `put [{ op: "hide", sourceIndex }]` | `remove ["hide:<n>"]` |
| *Restore* | `remove ["hide:<n>"]` | `put` the hide again |
| *Hide* an added object | `remove ["add:<id>"]` (§1.1: hiding an added object removes it) | `put` the add again |
| Move a document object | `put [{ op: "modify", sourceIndex, coords, angle? }]` | the previous `modify` put back, else `remove ["modify:<n>"]` |
| Move an added object | its `add` op rewritten with the moved `coords` | the previous `add` put back |
| A node gesture on a document object ("Nodes") | `put [{ op: "modify", sourceIndex, coords, angle? }]`, `coords` every ring written back | as a move |
| A node gesture on an added object | its `add` op rewritten with the new `coords` | the previous `add` put back |
| Draw a point, line or area ("Drawing") | `put [{ op: "add", id, type, symbol, coords, angle? }]`, with `putSymbols` on a library symbol's first use | `remove ["add:<id>"]` (the symbol stays, `map-patches.md` §1.5) |
| *Change symbol* of a document object ("Symbol picker") | `put [{ op: "resymbol", sourceIndex, symbol }]` (+ `putSymbols`); back to the object's own symbol: `remove ["resymbol:<n>"]` | the previous `resymbol` put back, else removed |
| *Change symbol* of an added object | its `add` op rewritten with the `symbol` (+ `putSymbols`) | the previous `add` put back |
| *Rotation* of a document point ("Inspector") | `put [{ op: "modify", sourceIndex, coords, angle }]`, `coords` its effective ones; back to the document's own shape and angle: `remove ["modify:<n>"]` | as a move |
| *Rotation* of an added point | its `add` op rewritten with the `angle` (0 omitted) | the previous `add` put back |
| *Reverse* a line ("Line and area operations") | `put [{ op: "modify", sourceIndex, coords }]` (an added line's `add` rewritten), the coordinates reversed | as a move |
| *Split at node* | `put [the first part's modify (or add rewritten), { op: "add", id, type: 2, symbol, coords }]`; a loop: the `modify` alone | the previous op put back, else removed; the new `add` removed |
| *Join* | `put [the selection's modify (or add rewritten), { op: "hide", sourceIndex }]` for a picked document line; `put [the selection's op], remove ["add:<id>"]` for a picked added one; closing a loop: the selection's op alone | every id back as it was before: the previous ops put back, the hide removed, the picked `add` put again |
| *Cut hole* / *Remove hole* on an area | `put [{ op: "modify", sourceIndex, coords }]` (an added area's `add` rewritten), the ring appended / dropped | as a move |
| *Revert* a correction | `remove [opId]` | `put` the op again |
| *Attach* an unresolved correction ("Unresolved", G12b) | `mapPatch.attachUnresolved { documentHash, key, sourceIndex?, symbol? }`: the server puts the op and drops the entry | `applyChange { remove [opId] or put [the op it replaced], putUnresolved { key: entry } }` (the symbol stays); redo is the procedure again |
| *Drop* an unresolved correction (G12b) | `removeUnresolved [key]` | `putUnresolved { key: entry }`, the entry as it was |

- A move's `coords` are every effective coordinate of the object (an
  existing `modify`'s, an `add`'s, else the document's) shifted by **one
  integer delta** `round(Δmm × unitsPerMm)` — the shape moves rigidly,
  flags and the count kept; an existing `angle` is kept. There is no
  offset form in the model.
- Every gesture is **one `mapPatch.applyChange { documentHash, put, remove }`
  and one undo entry** (§3): the undo is the inverse change computed from the
  patch before the gesture; redo sends the change again; a failed undo or
  redo drops the entry and shows the error. Writes carry no token
  (`applyChange` takes no `baseVersion`; two editors on one op id are
  last-writer-wins, `map-patches.md` §3.2), so there is no conflict notice.
  **One gesture's write at a time**: while one is in flight the next
  gesture (hide, move, *Restore*, revert, a placed point, a closing click,
  *Change symbol*, *Rotation*, *Attach*, *Drop*, a line or area operation)
  is refused — its inverse would be
  computed from a patch that is not yet the reply's — and a held Delete
  hides once (its key repeat is ignored).
- **Committing** (`map-rendering.md` §5.5 "Committing is the host's"):
  the reply `{ version, patch }` becomes the session's copy
  (`setMapPatch`, which every viewer of the event follows) and
  `course.mapMetadata`'s `patchVersion`; the draft is kept until the
  layer has drawn that version or a later one (`VectorMapObjects.onPatchDrawn`,
  called with each version the canvas comes to show; versions are the
  row's increasing token), so the object never jumps back. A refused write (`PATCH_STALE`,
  `PATCH_DOCUMENT_MISMATCH`, `PATCH_NO_DOCUMENT`, a venue box offline)
  drops the draft, shows the editor's error (translated per code) and
  reloads the map metadata and the patch.
- After *Hide* the object stays selected, shown as hidden with *Restore*;
  a hidden object is never hit (§2.4 there), so it is reached again through
  its *Corrections* row.

**Inspector** (`modes/map/ObjectSection.tsx`, `modes/map/Corrections.tsx`):

- **Map object** (section `editor-inspector-map-object`; `editor-map-object`,
  `data-ref` = `source:<n>` or `added:<id>`, `data-hidden`, `data-symbol`
  the effective symbol index; `editor-map-object-none` without a
  selection): the symbol's number and name (`editor-map-object-symbol`:
  an applied match's library entry, its name localised, else the source
  code and name; a patch symbol's own), its swatch
  (`editor-map-object-swatch`, the symbol list's `swatchUrl`: the
  library's preview for an applied match and for a patch symbol — of the
  entry its key names (`map-patches.md` §1.3), in the library's colours —,
  the document symbol's otherwise), and
  *Hide* (`editor-map-object-hide`) or *Restore*
  (`editor-map-object-restore`) by whether `hide:<sourceIndex>` is in the
  patch. For a point, line or area that is not hidden, *Change symbol*
  (`editor-map-object-change-symbol`, `aria-expanded` while its picker is
  open; "Symbol picker"); for a point whose effective symbol is
  orientable ("Drawing"), *Rotation* (`editor-map-object-rotation`, a
  number field in degrees, counter-clockwise, the stored `attrs.angle` ÷ 10;
  Enter or leaving it writes, Escape restores; the value normalised to
  0–359.9, written in 0.1°, a value equal to the current one writes
  nothing). Both are disabled as *Hide* is. For a line *Reverse*, *Split
  at node* and *Join*, for an area *Cut hole* and *Remove hole* (row G10,
  "Line and area operations").
- **Corrections** (`editor-corrections`, its count `editor-corrections-count`,
  `editor-corrections-none` when empty): every op of the patch in op-id
  order (`editor-correction-row`, `data-op-id`, `data-op`, and
  `data-issue` with the `applyPatch` issue code, `map-patches.md` §2.3 —
  computed with the patch taken as enabled, so a switched-off patch still
  reports them). A row click selects its object and centres the view on
  it; *Revert* (`editor-correction-revert`) removes the op.
- **Unresolved** (row G11; `map-patches.md` §4): when the pin moved and
  some corrections could not follow their objects, a block under the
  list (`editor-corrections-unresolved`, `data-count`; absent when there
  are none) lists the patch's `unresolved` entries in key order
  (`editor-correction-unresolved`, `data-key`, `data-op`, `data-reason`
  `target` | `symbol`): the op, the symbol it was on (the target's,
  else the op's symbol, else the patch symbol key) and the reason
  (*object not found* / *symbol not found*). They are drawn nowhere and
  not stepped by Tab. `editor-corrections-count` stays the count of ops.
  - A **row click** (`editor-correction-unresolved-locate`) centres the
    view on the entry's old place (row G12b): its target anchor's box
    centre, else an add's own box (its coordinates ÷ the entry's
    `unitsPerMm`), paper mm, which editions share (`map-patches.md` §4.2
    step 3); without either the row has no locate. The selection is left
    as it is (*Attach* needs it).
  - *Attach* (`editor-correction-attach`; `map-patches.md` §4.3; user
    2026-11-15, G11 question 2):
    - a `target` entry of a hide, modify or resymbol goes onto the
      document object (`source:<n>`) selected on the map; enabled with
      one selected;
    - a `symbol` entry — a resymbol whose symbol is gone, any add — opens
      the symbol picker under its row (`aria-expanded`;
      `editor-map-palette` in the add's kind, else the resymbol's
      object's, with the hint `editor-map-palette-attach`), and a pick
      attaches it with that symbol (row G12b; user 2026-11-15, G9
      question 1). Opening it arms `V` (dropping a drawing in progress)
      and closes *Change symbol* and the convert panel; one palette is on
      screen at a time. Escape, the button again, *Change symbol*, another
      tool, the entry going or attaching becoming impossible close it;
    - both need `courses.edit` and *Apply corrections* on (as hide). The
      change is computed in Map mode on the pinned document
      (`mapDocument.attachUnresolved`, so a refusal is said without a
      write and the inverse is known) and sent as
      `mapPatch.attachUnresolved`, whose server copy makes the same
      change; one write, one undo entry ("Ops").
  - *Drop* (`editor-correction-drop`) removes the entry
    (`applyChange { removeUnresolved }`), one undo entry whose undo puts it
    back (`putUnresolved`, row G12b); with `courses.edit`, also while the
    corrections are off (as *Revert*).
  - Both are Map-mode gestures (row G12b, the G11 "Not yet" lifted):
    through `commit`'s one-write interlock, a refusal on the editor's
    error line (translated per code, `PATCH_ATTACH_REFUSED` with its
    reason) with the metadata and the patch reloaded, as every Map-mode
    write. `editor-corrections-unresolved-error` is gone (the procedure
    for the do and redo steps and the error line: decided overnight on the user's standing instruction (2026-11-13), confirmed by the user 2026-11-17). The block is
    presentational (`modes/map/Corrections.tsx`); its rows are
    `modes/map/unresolved.ts` `unresolvedRows` over the session's
    patch.
- **Apply corrections** (`editor-corrections-apply`, a checkbox) is
  `mapPatch.setEnabled` (`map-patches.md` §1.4): off, every consumer —
  screen, print, the venue — draws the pinned document; the list keeps its
  ops. It is an event setting, not an undo entry (as auto cuts, §4); the
  box shows the value asked for while its write is in flight.
  **While it is off, hide, *Restore*, move, drawing, *Change symbol*,
  *Rotation* and the line and area operations are disabled** with the
  reason shown (`editor-map-disabled`); revert (a hide's row included)
  and the toggle stay (user 2026-11-15,
  G6 question 3: the viewer merges a draft over the drawn patch, and a
  disabled patch draws as the identity, so a drag would show nothing).

**Presence** (§11): Map mode reports `mode: "map"`, labelled as the mode
switch's *Map* (user 2026-11-15, G6 question 2).

### Nodes

The nodes tool `N` (row G7; 08 §4.7 "node editing with Bézier handles",
§5.3 the Map column) edits the nodes of the **selected line or area**. It
is a tool of its own, not `V`'s drag (user 2026-11-15, G7 question 1: on a
dense map a press by a node and a move of the object compete; OCAD's and
Mapper's split): `V` selects and moves, `N` shows and edits nodes. In `N`
a click selects as in `V` (the hit-test, Tab's stack), except a click
within reach of the selected object's edge, which keeps it and drops the
focused node; a press that is not on a node or grip is not the tool's, so
a drag there pans and nothing moves the whole object.

**Which objects.** The selected object's nodes are shown when it is a line
or an area, not hidden, its coordinates parse (below), it has at most
**2000 nodes** over all its rings (`MAP_NODES_MAX`; user 2026-11-15, G7
question 2: the handles are UI-layer elements and the page has no view to
cull them to), and the gestures can write (`courses.edit`, *Apply
corrections* on). Otherwise the inspector says why
(`editor-map-nodes-none`, `data-reason` `kind` — a point or text —,
`hidden`, `encoding`, `too-many`, `read-only`, `disabled`); while nodes are
shown it shows the gestures' hint (`editor-map-nodes-hint`). Both only
while `N` is armed and an object is selected. While a write is in flight
the handles stay and a press on them is refused (§13 "Ops").

**Coordinates and vertices** (`lib/editor/geometry-edit.ts`
`ringsOfCoords` / `coordsOfRings`; `map-document-format.md` §4). The
object's effective coordinates (the patch's, else the document's) become
rings of vertices in paper mm (document units / `unitsPerMm`, the axes as
stored — the space of the move and the hit-test), which the §7 edits take
unchanged:

- A cubic is anchor, control (`bezierFirst`), control (`bezierSecond`),
  anchor: the controls become the first anchor's `hOut` and the second's
  `hIn`. A control on its own anchor is no handle, unless both are (the
  segment stays a curve); a broken run (a lone control, a ring that starts
  or ends on one) makes the object not node-editable (`encoding`) rather
  than rewritten.
- A `hole` flag starts the next ring; on writing it is set on the first
  point of every ring after the first, so deleting a hole's first node
  keeps the hole. A `hole` flag on the object's very first point would be
  lost on writing, so such an object is not node-editable (`encoding`). Every ring of an area is closed; a line whose last
  anchor sits on its first (three anchors or more) is a closed ring too,
  so its start never tears open.
- A ring that writes its close out (its first point repeated at the end)
  keeps doing so, the repeat written at the first vertex with the
  repeat's own flags as read (`endFlags`, none included); an implicitly
  closed ring gains the repeat, without flags, only when its closing
  segment becomes curved (an implicit close is straight).
- An anchor's other flags (corner, dash, gap, no-left, no-right) ride on
  its vertex (`Vertex.flags`, the low byte) through every edit, and so do
  its control points' own bits besides the curve ones (no-left /
  no-right on a curve: the out-handle's from bit 8, the in-handle's from
  bit 16); an inserted node has none. Corner / smooth here is the handles
  only (F18): the flag bits are never set or cleared.
- Writing rounds every point to whole document units. Unedited, the round
  trip is exact: every line and area of `e2e/test.ocd` and of the local
  corpus maps comes back coordinate for coordinate, flags included
  (checked once locally, G7; the corpus stays in `.local/`).

**Gestures** (`tools/bindings.ts` `mapNodesBinding`, through
`geometry-gestures.ts` and `geometry-edit.ts` as §7 "Editing geometry";
reach 7 px `HANDLE_PX`, a drag past 3 px `MAP_DRAG_PX`; mouse only):

| Gesture | Edit |
|---|---|
| drag a node (`editor-map-node`, `data-ring`, `data-index`, `data-focused`) | moves it with its handles; snapped when snapping is on (below); the node is focused after |
| click a node | focuses it (drawn filled) |
| `Alt`-click a node | `toggleSmooth` (a handle → a corner, a corner → smooth from its neighbours, the closed wrap; an open end corner: nothing) |
| drag a grip (`editor-map-node-grip`, `data-ring`, `data-index`, `data-which`) | `dragGrip` by the pointer's offset: a mirrored or smooth pair kept, `Alt` (live) breaks it, `Shift` 45°; never snapped |
| double-click the edge (within reach, off a node) | `insertAtEdge`: a smooth node (on a curve the de Casteljau split), `Alt` a corner; focused; never snapped. At the cap (2000 nodes) nothing is inserted: the object would lose its handles |
| `Delete` / `Backspace` with a node focused | `deleteVertex` down to the ring's minimum — 2 nodes open, 3 closed; at the minimum nothing happens. Without a focused node it hides the object as in `V` |

- **Pressing order**: a node, then a grip, over every ring (the outline,
  then the holes).
- **Writes**: each gesture is one `modify` (an added object's `add`
  rewritten), one `mapPatch.applyChange` and one undo entry (§13 "Ops"); a
  click that focuses, a drag that rounds to the coordinates already there,
  a cancelled drag (Escape, the pointer leaving) write nothing. A drag
  whose release finds the patch changed since its press (an undo, a
  *Revert*, a reply that landed meanwhile) or a write still in flight is
  dropped the same way — it was made on the old coordinates — and
  `Delete` is ignored while a node or grip is held.
- **Live redraw**: during a drag the gesture's op is the viewer's draft
  (`mapObjects.draft`, `map-rendering.md` §5.5 "Document objects"), drawn
  from the dynamic bucket; it is kept until the canvas draws the reply's
  version, as a move's. The handles are drawn from the draft while there
  is one, else from the model, so they never jump back.
- **Focus** is the tool's state: dropped when the selection changes, on
  undo / redo and *Revert* (its index may name another node), on leaving
  `N`, and by a click on the edge or any click that selects (the same
  object included); it survives the gesture that set it.
- **Snapping** (08 §5.3 "Node snapping"; §6.2): the Map rail's
  `editor-snapping` — Map mode's own toggle, off on entering the mode (the
  page's Course-mode toggle is outside Map mode). On, a dragged node lands
  on the nearest point object's centre or line / area vertex within
  0.5 mm (`SNAP_MM`) of the effective document **with the edited object
  left out** (`snapIndexOf` over the model's document, the object masked
  as hidden; built on the first snapped drag per model and selection), so
  a node never snaps to where it started or to its own neighbours.

### Drawing

The point, line and area tools `P`, `L`, `A` (row G9; 08 §4.7 "draw
point/line/area with a palette", §5.2 the Map rail) add objects to the
patch: each finished object is one `add` op (`map-patches.md` §1.2), one
`mapPatch.applyChange` and one undo entry (§13 "Ops"). A text is not
drawn (slice G: no text creation).

- **Arming.** The rail's `editor-tool-P`, `-L`, `-A` or the keys. Arming
  one drops the selection, Tab's stack and an open *Change symbol*, and
  opens the symbol picker ("Symbol picker") filtered to the tool's kind
  (point, line, area). The tools are **disabled** — the buttons
  `disabled` with the reason as their title (one text, `mapDrawOff`,
  naming the right to edit courses and *Apply corrections*; without a
  pinned document the inspector already says so, `editor-map-none`), the
  keys do nothing — without `courses.edit`, while *Apply corrections* is
  off, and without a pinned document; an armed drawing tool goes back to `V` when one of
  those becomes true. The binding is exclusive with a crosshair cursor;
  a click selects nothing.
- **The symbol.** The tool draws with the picker's chosen symbol of its
  kind. With none chosen a click does nothing and the picker says so
  (`editor-map-palette-pick`). The choice is remembered per kind for the
  document while the page is open — leaving Map mode and coming back keeps
  it, another document drops it (`doc:<i>` / `patch:<key>`, so a library
  item that became a patch symbol on first use stays chosen).
- **First use** (`modes/map/symbols.ts` `symbolPut`, `map-patches.md`
  §1.3; reused by G26): a document item is `symbol: { doc: index }`; a
  library item is `symbol: { patch: key }` with `putSymbols { [key]:
  materialiseSymbol(pinned, key).symbol }` in the same change — unless
  the patch already has `symbols[key]`, which is then not put again. An
  entry that is not materialisable is never chosen (listed disabled).
  The pinned document is the model's decoded copy, so the client's
  materialisation is the server's (`map-symbols.md` §11.1
  "Deterministic").
- **The op.** `id` a lowercase UUIDv7 made when the drawing starts (the
  draft's and the write's are the same id; `map-patches.md` §2.2 orders
  added objects by id); `type` 1 point, 2 line, 3 area; `coords` in
  document units (paper mm × `unitsPerMm`, rounded); `angle` only when
  not 0.
- **Point (`P`, `mapPointBinding`).** A click places a point at the
  pointer (snapped when snapping is on). With an **orientable** chosen
  symbol — a point render with `orientation: "object"` and a rotatable
  glyph, the symboliser's rule (`render/symbolise.ts`) — a press-drag
  past 3 px (`MAP_DRAG_PX`) places it at the press and turns it: the
  symbol's x axis points along the drag, so `angle` = the drag's
  direction counter-clockwise from the paper's +x, in 0.1°, normalised to
  0–3599 (user 2026-11-15, G9 question 3; OCAD's and Mapper's gesture.
  Deviates from 08 §5.3, where a drag while armed pans). A line from the
  press to the pointer (`editor-map-point-direction`) shows the
  direction meanwhile, and the point is drawn turned through the draft;
  Escape or the pointer leaving drops it. With any other symbol a drag
  pans, as 08 §5.3 says. The tool **stays armed** with nothing selected
  (08 §5.3 "Placement flow"): ten boulders are ten clicks.
- **Line and area (`L`, `A`; `mapDrawBinding` over `areaBinding`).** The
  course editor's drawing flow (§6.4 and §7 "Editing geometry", F18,
  `tools/polygon.ts` with the kinds `map_line` — open, at least 2 nodes —
  and `map_area` — closed, at least 3): a click per node, smooth by
  default and a corner with `Alt`, a click-drag pulls a node's handles, a
  placed node is dragged to adjust; a line ends by double-click or
  `Enter`, an area closes by a click on its first node, a double-click or
  `Enter`. Placed nodes are snapped when snapping is on. Right-click or
  Escape drops the drawing. The dashed outline, the nodes and the grips
  are the UI layer (`editor-polygon`, `editor-polygon-vertex`,
  `editor-polygon-grip`); from 2 nodes (a line) or 3 (an area) the object
  is also the draft `add` in its symbol, updated as nodes are placed or
  dragged (hover sends nothing). The finished nodes are written by
  `coordsOfRings` (§13 "Nodes", "Coordinates and vertices"): curves as
  Bézier pairs, an area's ring with its first point repeated at the end.
  After the write the tool goes back to `V` with the new object
  (`added:<id>`) selected, so `N` and *Change symbol* apply at once (08
  §5.3 "Area tools").
- **Snapping** is the Map rail's `editor-snapping` ("Nodes"): a placed
  point or node lands on the nearest point object's centre or line / area
  vertex of the effective document within 0.5 mm (`snapIndexOf`, built
  once per model; nothing masked: nothing drawn is in it yet).
- **Writes.** While a write is in flight a click of `P` and a closing
  gesture of `L` / `A` are refused (the drawing is kept); the draft is
  kept until the canvas draws the reply's version (§13 "Committing"). A
  refused write drops the draft and the drawing.

### Symbol picker

The palette of `map-symbols.md` §11.2 (`mapDocument.mapPalette(pinned,
patch)`), computed in the web from the model's pinned document and the
session's patch — no procedure — is the list `editor-map-palette`
(`data-kind`): an inspector section *Symbols* above *Map object* while
`P`, `L` or `A` is armed (the tool's kind), and inside the *Map object*
section, under its *Change symbol* button, while *Change symbol* is open
(the selected object's kind: type 1 point, 2 line, 3 area). It is a list rather than 08 §5.2's rail
entry: with hundreds of entries it needs search and swatches, as the
filter region's list (P3) does.

- **Search** (`editor-map-palette-search`): a heading is shown when its
  lowercased `search` (§11.2) contains the query, trimmed and
  lowercased; empty shows all.
- **Groups** in the palette's order (`editor-map-palette-group`,
  `data-group` `library` | `ISSkiOM2019` | `other`, titled the
  document's library, *Ski-O*, *Other*), each heading's entries of the
  kind in order; a group or heading without any is left out;
  `editor-map-palette-none` when nothing is left.
- **Items** (`editor-map-palette-item`, `data-ref` `doc:<i>` |
  `patch:<key>`, `data-source` `document` | `patch` | `library`,
  `data-kind`, `data-code`, `data-objects`; `aria-pressed` on the chosen
  one, or on the selected object's effective symbol under *Change
  symbol*): the swatch (`editor-map-palette-swatch`, lazily loaded: the
  library preview of `canonicalId`, else the document symbol's own,
  `swatchUrl`), the code and the name (Swedish when the UI is and the
  entry has one). An item that is not materialisable is `disabled`, its
  title naming the missing colours.
- **Picking** under a drawing tool makes the item the tool's symbol.
  Under *Change symbol* it changes the selected object's symbol at once
  (§13 "Ops") and closes the picker: same object type only — the list
  offers only the object's kind, so `applyPatch`'s `kind-mismatch` is
  not reachable from it; a document object picked back to its own
  symbol drops its `resymbol`; the effective symbol again writes
  nothing. *Change symbol* closes on another selection, on arming a tool,
  and on Escape (in the search field too).

### Line and area operations

Row G10 (08 §4.7 "join/split/reverse lines, holes", which names the
operations only): *Reverse*, *Split at node* and *Join* on a selected
line, *Cut hole* and *Remove hole* on a selected area. The behaviour was
decided with the user (2026-11-15, the G10 planner's questions 1–8, every
recommendation; marked "answer n" below); the points marked "decided
overnight" were decided on the user's standing instruction (2026-11-13),
confirmed by the user 2026-11-17. The pure rules are `modes/map/shape-ops.ts`; the wiring is
`MapMode.tsx`.

**Buttons, no keys** (answer 7). They are buttons in the *Map object*
section (`editor-map-object-ops`), after *Change symbol* and *Rotation*,
shown for an object that is not hidden: on a **line** (type 2) *Reverse*
(`editor-map-object-reverse`), *Split at node* (`-split`) and *Join*
(`-join`), and on an added line *Snap ends* (`-snap-ends`, G28, "GPS tracks:
junctions"); on an **area** (type 3) *Cut hole* (`-cut-hole`) and, when the
area has a hole, *Remove hole* (`-remove-hole`). A point, a text and a line
text (type 6) get none (decided overnight: 08 §4.7 says "lines"). Each is
disabled as *Hide* is (`courses.edit`, no promote running — `canPatch`,
§13 "Promote" —, *Apply corrections* on, no write in flight), and while it
does not apply: `data-reason` and the reason as its title:

| `data-reason` | Buttons | Meaning |
|---|---|---|
| `encoding` | all the line ones | the curve encoding does not parse (`ringsOfCoords`, "Nodes") |
| `multi-part` | *Split*, *Join*, *Snap ends* | the line has more than one part (a `hole` flag inside a line) |
| `closed` | *Join*, *Snap ends* | the selected line is a loop |
| `no-node` | *Split* | no focused node: `N` and a click on the node to split at |
| `end-node` | *Split* | the focused node is an end (an open line's first or last, a loop's first) |
| `no-hole-node` | *Remove hole* | no focused node of a hole: `N` and a click on one |
| `no-target` | *Snap ends* | no end of the added line within 1.5 mm of a track line (G28, "GPS tracks: junctions") |

*Join* and *Cut hole* are **one-shot armed states** on the selection
(`aria-pressed`; their hint `editor-map-join-hint` /
`editor-map-hole-hint` under the section, with `data-reason` when the last
pick or ring was refused, the nodes hint hidden meanwhile). The button
again, **Escape** (first, after a drag in flight), another selection,
arming a tool, *Change symbol*, *Attach*'s palette, the convert panel, the
object hidden, and writing becoming impossible (a promote, corrections
off) drop them; so does its own write, and the write of any other line
or area operation (decided overnight). Arming closes *Change
symbol*, the attach palette and the convert panel and keeps `V` or `N`
(another tool goes back to `V`). No rail tools and no letter keys in G10.

**Writes.** Each operation is one `mapPatch.applyChange` and one undo entry
through the Map-mode `commit` (§13 "Ops": the one-write interlock, the
promote lock, a refusal on the error line with the metadata and the patch
reloaded); the inverse is `inverseChange`'s, so undo takes a join's two ops
back at once. The focused node is dropped after each (its index may name
another node). The selection stays on the object.

**Coordinates and flags** (decided overnight, from the renderer's reading,
`render/measure.ts` `pathSections` / `gapIntervals`, `render/symbolise.ts`
borders; `map-document-format.md` §4). Line operations work on the raw
effective coordinates in document units, so every flag is kept exactly;
the hole operations through the rings. `corner` (4), `dash` (8) and `gap`
(128) are read at their point and stay on it. `noLeft` (32) / `noRight`
(64) on an anchor cover the segment from it to the next anchor, so they
belong to that segment. Gap points pair up in path order; before an
operation the gaps are **balanced** (`balanceGaps`): an opener that is
never closed loses its bit, and a flagged last point that closes nothing
loses its bit — neither draws anything — so a reverse, split or join keeps
every gap where it was drawn.

- **Reverse** (`reverseChange`): the coordinates in the other order — each
  part of a multi-part line on its own, in its place, the `hole` flag on
  each later part's new first point. A cubic's two controls swap roles
  (`bezierFirst` ↔ `bezierSecond`), their own bits kept with left and right
  swapped. `noLeft` / `noRight` move to the segment's other end with left
  and right swapped (new anchor *j* takes old anchor *m − 2 − j*'s; the new
  last anchor has none), so the drawn borders stay where they were. A loop
  keeps its start node. Dash and glyph layout then run from the new start
  (the row's "dash and glyph phase follow"). One `modify` (an added line's
  `add` rewritten, its symbol and id kept); reversing twice writes the
  coordinates back, a `modify` equal to the document as a move back is.
- **Split at node** (answer 4; `splitChange`): at the focused node of `N`
  (so a line of at most 2000 nodes). An open line is cut there: the part
  from the start to the node stays the object (its `modify`, or its `add`
  rewritten, with its other corrections), the rest becomes a new added
  line (`add`, a fresh UUIDv7, type 2, the object's **effective** symbol —
  after a *Change symbol* the new one; it exists already, so no
  `putSymbols`) starting on that node; both ops in one change. The node is
  in both parts; the first part's last point drops its border bits, and a
  gap open across the node ends the first part and opens the second. A
  **loop opens at the node as one object**: its coordinates rotated to
  start and end there (the old start a node of the path again, its flags
  kept), one `modify`. Since a line whose last node sits on its first is a
  loop ("Nodes"), the result is still a loop with its start moved — as
  OCAD stores such a line (decided overnight; a loop cannot be cut in two,
  Pending). An end node does nothing (the button is disabled).
- **Join** (answers 1–3, 8; `joinChange`): *Join*, then a click on the
  other line (`tools/bindings.ts` `mapPickBinding`: exclusive, crosshair, the
  hit-test of `V` at 6 px, no press, so a drag pans). The pick is the first
  line under the click that is not the selection (decided overnight: a
  click where two lines meet must not close the selection by accident),
  else the selection itself when it is under the click — which **closes it
  into a loop**. Not a line, a loop, a multi-part line or a broken encoding
  is refused: *Join* stays armed and the hint says why (`data-reason`
  `not-line`, `closed`, `multi-part`, `encoding`, `too-many`, `too-few`,
and `kind` for a picked object no longer in the document). The nearest
  pair of ends is joined (ties in the order: the selection's end to the
  pick's start, to its end, the selection's start to the pick's end, to its
  start; decided overnight): **within 0.5 mm** (`SNAP_MM`, inclusive) the two ends become one
  node at the selection's end, with that point's corner / dash, the next
  segment's border bits and both gap toggles (an even pair cancels);
  **farther apart**, at any distance, both ends are kept and a straight
  segment joins them (the point before it loses its border bits). The
  **selection survives** with its identity, symbol and direction; the
  picked line's nodes are reversed where needed and it is **hidden** (a
  document object: `hide`) or **removed** (an added one: `remove
  ["add:<id>"]`) in the same change. Different symbols may be joined; the
  result has the selection's. The two ops are two *Corrections* rows that
  revert separately (answer 8; reverting only the hide draws the old line
  under the joined one, Pending). **Closing** (the node counts decided
  overnight): within 0.5 mm the last node moves onto the first (4 nodes or
  more, so the loop reads as one, "Nodes"), farther a straight segment back
  to the first point (3 or more); fewer is refused (`too-few`). A result over 2000 nodes from a selection within them is
  refused (`too-many`, counted on the joined result; decided overnight: the
  object would lose its handles, as an insert at the cap, "Nodes").
- **Cut hole** (answers 5–6; `cutHoleChange`): *Cut hole*, then the
  ring drawn with G9's area gesture (`mapDrawBinding` over the kind
  `map_area`: a click per node, smooth by default, Alt a corner, a drag
  pulls handles; a click on the first node, a double-click or Enter closes;
  right-click or Escape drops it with the armed state; placed nodes snapped
  when snapping is on, onto the whole effective document, the area itself
  included; decided overnight). From 3 nodes the
  area with the ring is the viewer's draft. The closed ring is appended to
  the area's coordinates (`coordsOfRings`: curves as Bézier pairs, its
  first point flagged `hole` and repeated at the end), the existing rings
  kept coordinate for coordinate: one `modify` (an added area's `add`
  rewritten), its draft kept until drawn (§13 "Committing"). **A hole is
  accepted as drawn**, as OCAD does: areas fill even-odd
  (`map-rendering.md` §3.1), so a ring outside the outline is drawn filled
  and one crossing it inverts the overlap; no containment check. While a
  write is in flight the closing gesture is held back (the ring kept, as
  G9's drawing); a ring that would take an area within 2000 nodes over
  them is refused (`too-many`, the ring kept for Escape; decided
  overnight).
- **Remove hole** (answer 5; `removeHoleChange`): in `N`, click a node of
  the hole (ring 1 or later) and press *Remove hole*: the area without that
  ring, every other ring as it was (later holes keep their flag); one
  `modify`.

### Line and area operations (G10): decided with the user (2026-11-15)

Row G10's planner asked; the user took every recommendation. These are the
answers the section above writes out.

1. **Join names the second line by a pick.** Select a line, press
   *Join*, click the other line: the nearest pair of ends is joined;
   Escape cancels. A click on the selected line itself closes it into a
   loop (its two ends joined). 08 §5.3's multi-select is still not built,
   and join does not use it.
2. **Ends that do not meet.** Within 0.5 mm on paper (`SNAP_MM`) the two
   ends become one node at the surviving line's end; farther apart both
   end nodes are kept and a straight segment joins them, at any distance.
3. **The selected line survives a join**, with its identity, symbol and
   direction; the picked line is hidden (a document object) or removed
   (an added one), its nodes reversed where needed. Two lines of
   different symbols may be joined; the result has the survivor's symbol.
4. **A split keeps the part from the line's start to the node** as the
   object (with its existing correction); the rest becomes a new added
   line with the same effective symbol; the first part stays selected.
   A split is at an existing node; a closed line opens there as one
   object; an end node does nothing.
5. **Holes.** *Cut hole* on a selected area, then draw the ring with
   G9's area-drawing gesture: one `modify`. *Remove hole*: in `N`, focus a
   node of the hole and press it.
6. **A hole is accepted as drawn**, as OCAD does: areas fill even-odd
   (`map-rendering.md` §3.1), so a ring outside the outline is drawn
   filled and one crossing it inverts the overlap. No containment check.
7. **Buttons, no keys.** *Reverse*, *Split at node*, *Join*, *Cut hole*
   and *Remove hole* are buttons in the inspector's *Map object* section,
   shown when they apply and disabled with a reason; *Join* and *Cut
   hole* are one-shot armed states that Escape drops first. No rail tools
   or letter keys in G10.
8. **A join's two corrections revert separately** (the `modify` and the
   `hide` / `remove`), as every op does; undo reverts both at once.
   Reverting only the hide draws the old line under the joined one
   (Pending).

### GPS tracks

The mapper's GPS tracks of the event (`docs/map-gps-tracks.md` §5.1, row
G25; stored by G24, `mapTrack`): a reference layer to draw the map from,
converted into map lines (G26, "GPS tracks: convert" below), and trimmed,
split and averaged (G27, "GPS tracks: editing" below); a converted line's
ends snapped to the track network (G28, "GPS tracks: junctions" below).

- **Panel** (`modes/map/tracks/TracksPanel.tsx`, the hook
  `useMapTracks.ts`, the pure list state `model.ts` and `decimate.ts`):
  the inspector section *GPS tracks* (`editor-tracks`) after
  *Corrections*. Off with the reason (`editor-tracks-disabled`,
  `data-reason` `venue` | `no-permission` | `not-georeferenced`, in that
  order) and no `mapTrack` request on a venue node, without
  `courses.edit`, or on a map without a georeference; with tracks off,
  the rest of Map mode is unchanged.
- **Import** (`editor-tracks-import`, the hidden
  `<input type="file" multiple accept=".gpx,application/gpx+xml">`
  `editor-tracks-file`; a
  drop of files on the section's body `editor-tracks-drop`, which shows
  `data-drag-over` meanwhile):
  parsed on the device and sent as `docs/map-gps-tracks.md` §5.1 says.
  While it runs the button is disabled (`data-busy`); afterwards
  `editor-tracks-import-result` (`data-imported`, the count) and one
  `editor-tracks-import-error` per refused file or track (`data-file`,
  `data-code`: a `GpxParseError` code, `too-many-points`, the server's
  `TRACK_*` code, or `failed` for a refusal without one; a refused call is
  reported under its first file). Until the node's role is known the
  section shows only `editor-tracks-loading`.
- **Rows** (`editor-track-row`, `data-track-id`, `data-state` `loading`
  | `ready` | `error`, `data-visible`, `data-points`, `data-length-m`,
  `data-outside`, `data-converted`, and `data-average` / `data-source` on
  an average and on its passes, G27): the checkbox selecting it for a
  conversion, an average or the Tracks tool (`editor-track-select`,
  enabled on a `ready` row; G26), the
  swatch (`editor-track-swatch`, `data-colour`), the name (`editor-track-name`; a click locates), the
  date (`editor-track-date`), length and points (`editor-track-stats`),
  *outside the map* (`editor-track-outside`, with the count) and
  *converted* (`editor-track-converted`), *average* (`editor-track-average`)
  and *in an average* (`editor-track-source`) when they apply, and the
  buttons show / hide (`editor-track-visible`, `aria-pressed` while
  shown), rename (`editor-track-rename`: the name becomes the input
  `editor-track-name-input`; Enter or leaving it writes, Escape drops)
  and delete (`editor-track-delete`, no confirmation — it is an undo
  entry). `editor-tracks-none` when the event has none. A converted track
  is hidden by default (G26); *Show converted*
  (`editor-tracks-show-converted`, a checkbox shown while a listed track is
  converted) draws converted tracks without an override of their own.
- **The layer.** Every visible, ready track is a UI-layer path over the
  map (`editor-gps-track`, `data-track-id`, `data-points` the drawn
  paper-mm vertices), drawn through the Map-mode binding's `shapes`
  (`tools/bindings.ts` `withTrackLayer`, which every Map-mode tool wraps
  its binding with) below the tool's own shapes; never a hit target —
  clicks still select map objects. Decimated to the pixel as §5.1 there
  says; the zoom is the last pointer event's `mmPerPx` (the wrapper reads
  it from hover, press and click). The viewer draws the description sheet
  above the UI layer, so the sheet covers a track under it until `H`
  hides the overprint.
- **Undo** (§3, one stack across modes): import, rename and delete are
  one entry each (`docs/map-gps-tracks.md` §5.1 "Rename and delete");
  show / hide and locate are none. A failed undo or redo drops the entry
  and shows the error, as Map mode's patch writes do.

### GPS tracks: convert

One or more selected tracks become line objects of the event's patch
(`docs/map-gps-tracks.md` §6, row G26; the user's answers of 2026-11-15
there). The pure part is `modes/map/tracks/convert.ts`, the panel's state
`useTrackConvert.ts`, the panel `ConvertPanel.tsx`; the write is Map
mode's `commit` (§13 "Ops").

- **Selecting and opening.** The rows' checkboxes (`editor-track-select`)
  hold the selection: session only, kept to listed `ready` rows in list
  order. *Convert to line* (`editor-tracks-convert`, the count in its
  label) under the list is disabled, its title the reason, without a
  selection, while drawing is off (`mapDrawOff`: no `courses.edit`,
  *Apply corrections* off, no document, §13 "Drawing") or while a write is
  in flight. It stays available on a converted track (a new line; the
  mark moves to it, `docs/map-gps-tracks.md` §6 answer 1). Opening arms
  `V` (a drawing in progress is dropped with its draft, *Change symbol* closes) and
  replaces the button with the panel.
- **The panel** (`editor-tracks-convert-panel`, `data-tracks`): the
  symbol picker of §13 "Symbol picker" for lines (`editor-map-palette`,
  `data-kind="line"`) with the ski-O group first — the overlay group
  `ISSkiOM2019`, or the document's own library group on an ISSkiOM map —
  and its track headings (801–813) before its others; `editor-map-palette-pick`
  while nothing is chosen. Nothing is chosen the first time (§6 answer 3).
  Then *Smoothing* (`editor-tracks-convert-smoothing`, a range 0–30 m in
  whole metres, 0 = off, default 10; the value beside it) and
  *Simplification* (`editor-tracks-convert-tolerance`, 0.02–0.5 mm in
  steps of 0.01, default 0.1), the node count (`editor-tracks-convert-nodes`,
  `data-nodes` the total, `data-max` the largest track's), the warning
  `editor-tracks-convert-warning` when a track's line has more than
  `MAP_NODES_MAX` (2000) nodes — it will not be node-editable in `N`; it is
  still one `add` —, *Snap ends to tracks* (`editor-tracks-convert-snap`, a
  checkbox, on by default; G28, "GPS tracks: junctions") with the ends it
  moves (`editor-tracks-convert-snapped`, `data-count`, shown while one
  does), `editor-tracks-convert-skipped` (`data-count`) for
  tracks that come out under two coordinates (left out), and *Convert*
  (`editor-tracks-convert-apply`, disabled until a symbol is chosen and a
  track converts, and while a write is in flight) and *Cancel*
  (`editor-tracks-convert-cancel`).
- **The line** of each track (`docs/map-gps-tracks.md` §6): the trimmed,
  projected track (outside points included), smoothed unless the window is
  0, simplified, rounded to whole document units with consecutive equal
  coordinates dropped, as an `add` of type 2 with corner nodes — byte for
  byte what `L` writes for those vertices (`drawOp`), then its ends snapped
  when *Snap ends* is on (G28). One symbol for every track of a conversion.
  Once a symbol is chosen the node count is the plan's (a cut may drop
  nodes).
- **The preview** is the viewer's draft (`mapObjects.draft`, the object
  under edit in its symbol, `map-rendering.md` §5.5) with the adds' final
  ids and the symbol's first use: drawn as soon as a symbol is chosen, and
  again on every control change; the reference tracks stay drawn over it.
  While the panel is open a move drag is off (the preview holds the draft);
  hide, revert and *Change symbol* still work (decided overnight on the
  user's standing instruction (2026-11-13), confirmed by the user 2026-11-17; G26 planner's Q5:
  the smallest restriction that keeps the one draft the preview's).
- **The write.** *Convert*: one `mapPatch.applyChange { put: [one add per
  track], putSymbols? }` (the symbol on first use, `symbolPut`), then
  `mapTrack.markConverted` with each track's `add:<id>` — one undo entry.
  The marks follow the patch on do, undo and redo as a step of their own
  (`commit`'s follow-up, in its own `run`), so a refused mark is shown and
  the entry kept, on undo and redo too; on do the entry is recorded once
  the marks have settled. Marks go only to tracks still listed. Undo removes the
  adds (the symbol stays, `map-patches.md` §1.5) and restores each track's
  mark from before (null, or an earlier conversion's op); redo does both
  again. The panel closes and the selection clears; the draft stays until
  the canvas has drawn the reply's version (§13 "Drawing").
- **Afterwards** the line is an ordinary added object: a *Corrections*
  row, selectable, `N` up to 2000 nodes, *Change symbol*, print. The track
  stays converted, and hidden unless *Show converted* or its eye, until
  the conversion is undone — not when the line is hidden, reverted or
  promoted (§6 answer 1).
- **Remembered on the device** (`localStorage` `oxygen:gps-track-convert`,
  not per event): both controls, *Snap ends* (`snapEnds`, absent = on;
  decided overnight on the user's standing instruction (2026-11-13), confirmed by the user 2026-11-17, as every other panel control), and the symbol — on its own document the
  item picked (by key), elsewhere the first item offering its library
  entry (library, patch or a document symbol matched to it); an unmatched
  document symbol on its own document only; a symbol the map cannot draw is
  not chosen.
- **Closing**: *Cancel*, Escape (after an open *Change symbol*), arming
  `N`, `P`, `L`, `A` or `T`, drawing becoming disabled, the selection becoming
  empty, leaving the mode or another document. Nothing is written.

### GPS tracks: junctions

A converted line's ends snapped onto the track network (row G28;
`docs/map-gps-tracks.md` §6.7 has the rules, answers 4–5 there the user's
of 2026-11-15). The pure part is `modes/map/tracks/snap-ends.ts` (the
track-symbol filter, `snapLineEnds`), the target search `nearestOnLines`
(§6.2), the conversion's use `convert.ts` `planConversion`, the button's
`shape-ops.ts` `snapEndsChange`.

- **What it does**: each end of the line within 1.5 mm on paper of a line
  with a track symbol (the ISSkiOM track group, matched or as a patch
  symbol; an unmatched 8xx document line symbol; not roads or paths) is
  moved onto it — onto that line's end node when one is within reach
  (the two then share a vertex; joining them is *Join*, "Line and area
  operations"), else an overshoot is cut at the crossing and a short end
  is extended straight onto the nearest point. The other line is never
  changed; the line is never its own target.
- **At conversion** ("GPS tracks: convert"): *Snap ends to tracks*
  (`editor-tracks-convert-snap`), on by default and remembered on the
  device; the preview, the node count and `editor-tracks-convert-snapped`
  (`data-count`, the ends moved) show the snapped lines before *Convert*.
  Several tracks are snapped in list order, each seeing the lines made
  before it in the batch when the symbol is a track symbol. Off, the ops
  are exactly G26's.
- ***Snap ends*** (`editor-map-object-snap-ends`) on a selected **added**
  line (any symbol; the filter is for targets) in the *Map object* section,
  after *Join*: one `mapPatch.applyChange` rewriting its `add`, one undo
  entry, the focused node dropped and an armed *Join* / *Cut hole* dropped
  as for the other operations ("Line and area operations", "Writes").
  Disabled with `data-reason` as they are: `encoding`, `multi-part`,
  `closed`, and `no-target` when no end would move. A document line gets
  no button (decided overnight on the user's standing instruction (2026-11-13), confirmed by the user 2026-11-17: the row names "an added line").

### Promote

Row G12b, the editor half of `map-patches.md` §5 (the user's answers of
2026-11-15; the API is G12a's): *Save corrections to the club map* turns
the event's corrections that apply into the club map's next version
(`modes/map/Promote.tsx` `usePromote`, the pure rules
`modes/map/promote.ts`, the dialog `modes/map/PromoteDialog.tsx`).

- **Where**: an inspector section *Club map*
  (`editor-inspector-map-promote`) under *Corrections*, shown only when
  the pin is a club version (`course.mapMetadata.clubMapVersionId`; an
  event's own upload has none, `PATCH_NOT_CLUB_MAP`). The button
  `editor-map-promote`.
- **Disabled, with the reason** (`editor-map-promote-reason`,
  `data-reason`; `data-block` on the button), in this order: `readonly`
  — no `courses.edit` (answer 9); `venue` — a venue box ("open the event
  in the cloud": `promoteStatus` is served locally and the job runs in
  the cloud, so the box could not follow it; decided overnight on the
  user's standing instruction (2026-11-13), confirmed by the user 2026-11-17); `running` — a
  promote is being sent or its job is queued or running; `off` — *Apply
  corrections* is off; `nothing` — no row of *Corrections* applies (every
  row has an issue, or there are none) (answer 5); `busy` — a Map-mode
  write is in flight (no text). `PATCH_NOT_LATEST` is not predicted: the
  refusal says to take the latest version from the club library first.
- **The dialog** (`editor-map-promote-dialog`; answer 6: promote is not
  an undo entry, so it asks first): how many corrections apply and that
  they leave the event's patch once the map is imported (the others
  stay); the label (`editor-map-promote-label`) prefilled with the
  event's name and date (`competition.dashboard`, `"<name>
  <YYYY-MM-DD>"`, cut to 200 characters; §5 defaults), trimmed, a blank
  one not sent; a line that Undo cannot undo it and Map mode's earlier
  undo steps go; *Cancel* (`editor-map-promote-cancel`, Escape, the
  backdrop) and *Save to club map* (`editor-map-promote-confirm`, Enter).
  Portalled as the editor's other dialogs.
- **Sending**: one `mapPatch.promote { label }`. It answers after the
  job's hold (30 s): the delivered patch becomes the session's
  (`setMapPatch`), the job the `promoteStatus` cache. A job already
  `done` reloads `course.mapMetadata` (the event is on the new version's
  baked document, so Map mode starts over on it, the corrections that
  were promoted gone from *Corrections*), the patch and the Club maps
  list, and says *Saved as version n* (`editor-map-promote-done`); a
  `failed` one says its error (`editor-map-promote-error`).
- **Read-only while it runs** (answer 4): while the request is in flight
  and while `mapPatch.promoteStatus` (fetched on entering the mode with a
  club pin, polled every 2 s only while the job is queued or running; no
  live channel, as for the patch) answers `queued` / `running` — also a
  promote another session started — every `mapPatch` write of Map mode is
  disabled: hide, *Restore*, move, nodes, drawing, *Change symbol*,
  *Rotation*, revert, the toggle, *Attach*, *Drop* and the GPS tracks'
  convert. The inspector's top shows `editor-map-promoting` (`data-state`,
  `data-progress`, the job's coarse progress). GPS-track writes are not
  the patch's and stay. When the job ends (done or failed) the metadata,
  the patch and the list are reloaded and the outcome said as above. A
  write that races it is refused `PATCH_PROMOTING` (its text on the
  error line).
- **Undo entries dropped** (answer 6; decided overnight on the user's
  standing instruction (2026-11-13), confirmed by the user 2026-11-17): when this session sees
  a promote start — its own request accepted, or `promoteStatus` turning
  queued / running for a job it had not seen — the page's undo stack
  drops every entry Map mode's `commit` recorded (the patch's: gestures,
  *Attach*, *Drop*, G26's conversion; `UndoStack.remove`, passed in as
  `forget`), from both the undo and the redo branch. Their inverses were
  computed against a patch the promote empties and a document the event
  leaves. GPS-track entries (import, rename, delete) stay: they do not
  touch the patch. A promote that fails does not bring the entries back.
  Until the request is accepted (up to the 30 s hold) the entries are
  still there; an undo in that window is refused `PATCH_PROMOTING` by the
  server and the entry goes, as any failed undo (§3).
- **Refusals' texts** (`promoteError_<CODE>`): `PATCH_NOT_CLUB_MAP`,
  `PATCH_NOT_LATEST`, `PATCH_NOTHING_TO_PROMOTE`, `PATCH_PROMOTING`,
  `PATCH_NO_DOCUMENT`, `PATCH_STALE`, `UNAUTHORIZED` (sign in), offline;
  any other the server's message.
- **The Club maps card** (`map-storage.md` §6.5): the version's number,
  a promoted version's label and its corrections with the
  original-file note, and *Delete version n* for the latest promoted one.

### GPS tracks: editing

Trim, split and average (`docs/map-gps-tracks.md` §5.2, row G27; the
user's answers of 2026-11-15 there). The pure parts are
`modes/map/tracks/edit.ts` (handles, split index, a split's undo, the
ranges under a trim) and `average.ts` (the worker's handler and client,
the import item), the tool's reducer `tools/tracks.ts` with its binding
`tools/bindings.ts` `mapTracksBinding`, the writes in `useMapTracks.ts`.
No patch write: none of it needs *Apply corrections*.

- **The Tracks tool `T`** (`editor-tool-T`, after `A`; key `T`) is
  disabled, its title the reason, while the *GPS tracks* section is off
  or loading, and falls back to `V` when it turns off. Exclusive: a drag
  off a handle pans. Its track is the one selected row's
  (`editor-track-select`) while visible and `ready`; the section shows
  `editor-tracks-tool-hint` (`data-state` `pick` without one, `ready`
  with it). A click goes to the nearest visible track within 6 CSS px (its
  own first on a tie, then list order): its own track splits (below),
  another is selected alone; a click on empty map does nothing. Escape goes back to `V` (the table above).
- **Trim**: the track's two handles (`editor-track-handle`, `data-track-id`,
  `data-end` `start` | `end`, `data-index` the stored point) on its stored
  points `trim.start` and `trim.end − 1`. A press within 7 CSS px takes a
  handle; past 3 px it follows the pointer along the stored points (the
  whole track: dragging back out restores; two points kept between the
  handles; on an out-and-back the point nearest in index among the near
  ones). The layer draws the live trim, and the whole track thin and grey
  under it while part is trimmed away (`editor-track-trimmed`). The release
  writes one `mapTrack.update { id, trim }` — one undo entry, nothing at
  the same point or when cancelled; until it settles the new trim stays
  drawn and no press is taken.
- **Split**: a click on the tool's track splits it at the nearer stored
  point of the nearest kept segment, when two visible points remain on
  each side (next to a handle nothing happens): one `mapTrack.split` with
  two client UUIDv7 ids (ascending, left first), the parts' points split
  on the device, the selection cleared. Undo removes the parts and
  re-imports the original under its id — at the end of the list — with its
  trim and mark; redo splits again under the same ids. Cutting out a
  stretch is split, split, delete the middle.
- **Average** (`editor-tracks-average`, the count in its label, beside
  *Convert to line*; disabled under two selected rows, `data-busy` while it
  runs): `averageTracks` with the defaults (15 m, two iterations) on the
  selected rows' trimmed lines in a module worker, the result unprojected
  and imported as one track named "Average of *n* tracks" with
  `derivedFrom` and `singlePass` — one undo entry (undo removes it, redo
  imports it again under its id). It then becomes the selection. Leaving
  the mode or the document terminates the worker and drops a job in flight
  silently.
- **An average's passes** are hidden by default while it is listed (their
  eye still shows them; *Show converted* does not), and its single-pass
  spans are dashed paths of their own (`editor-gps-track` with
  `data-single-pass="true"`, the same `data-track-id`). Converting an
  average marks its listed passes converted with its op in the same
  `markConverted`; the undo restores each one's mark from before.

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
| `course.presence` | `courses.view` | `{ courseId, mode: "course" \| "layout" \| "field" \| "map", clientId }` | `{ ttlMs, others: { courseId, courseName, name, mode }[] }`: the event's other live editors (§11) |
| `course.lastChange` / `control.lastChange` | `courses.view` | `{ courseId }` / `{ id }` | `{ name, at /* ISO */ } \| null`: actor and time of the row's newest `*.upserted` entry (`name` empty without a sign-in) |

A stale `baseVersion` answers `CONFLICT` with `data: { kind, id, version,
current, differing }`. Variation groups are written since F6 and authored
since F7 (§12; `course.variantList { courseId }` lists the variants); the
slice-F site kinds since F4.

## Tests

**The E2E layout (D10, E3; split for the CI shards).** The editor's spec is
seven files, split along its describes so that no one file outweighs a CI
shard (`docs/e2e-sharding.md` "CI"); the helpers they share are
`e2e/helpers/course-editor-spec.ts`:

| File | Describes |
|------|-----------|
| `e2e/course-editor.spec.ts` | the GL canvas, Course mode and its descriptions (§4), automatic cuts, the checks, the action bar's place (§2), variations (F7, §12) |
| `e2e/course-editor-tools.spec.ts` | the tools (§6–§7), the filter symbol picker |
| `e2e/course-editor-legs.spec.ts` | legs (F3, §6.7), Bézier bends (F13), bend drags on a tablet (F23) |
| `e2e/course-editor-layout.spec.ts` | Layout mode (`course-layout.md`), auto templates, setter maps (F10), description sheets (F11), the white-outs (P7, F12) |
| `e2e/course-editor-placing.spec.ts` | the circles while placing (P1, P4), the pending leg (P5), crossing and map-issue points (F4), the placement loupe (F27) |
| `e2e/course-editor-status.spec.ts` | conflicts between two contexts (§3), the save state in the top bar (P2), the map-info dialog (P6), map exchange (F5) |
| `e2e/course-editor-phone.spec.ts` | the phone: the touch subset, the read-only Leg section (F3), the variation block (F7) |

Project `chromium` (desktop Chrome) runs the first six, project `mobile`
(Pixel 7; `MOBILE_SPECS`) only the phone file. The desktop describes still
skip on a phone and the phone's on a desktop through the `isMobile`
fixture (the tablet describe, F23, runs under `chromium` with its own
`test.use({ hasTouch, isMobile, viewport: 1024 × 768 })`). The phone has
no desktop flows to run: it opens in Field mode with no rail or
inspector (§10), so 09 §4 D's "green on the mobile project" is
`field-mode.spec.ts` plus the phone file. The legacy page's spec,
`course-editor-legacy.spec.ts`, was deleted with the switch in E3, the
page itself in E4b.

Hygiene (AGENTS §12): `reseed()` once per file in `beforeAll`; the fixture import
(`e2e/test.ocd` courses and map) is idempotent per test (`openEditor` →
`ensureCoursesAndMap`; the phone describe imports from a desktop context,
`ensureFixtureFromDesktop`); courses a test creates carry a prefix and go
with the next reseed; controls, objects, sheets and templates it creates
are deleted in `finally` through `cleanup` (best effort, never failing or
hanging the test it closes); a seed control a test edits (code,
description, position) is written back in `finally`.

**`e2e/helpers/editor.ts`** is the editor specs' shared helper module
(`course-editor*.spec.ts`, `field-mode.spec.ts`, `course-presence.spec.ts`;
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
| unit (web) | `lib/editor/__tests__/url.test.ts` | §1 "URL" (F31): every writable state round-trips through `editorSearchFor` → `parseEditorUrl`; defaults omitted (no course, Course mode, Course view; Class view's and Layout's first variant); the fixed order; a phone writes `mode=course`, `mode=field` is always written; `control` read and never written; foreign params kept; every invalid case dropped and named (non-integer, zero, negative, leading-zero and over-long ids, an unknown mode or view, `class` without Class view and the reverse, Variant view without its key, a key where nothing draws one, `sheet` / `template` outside Layout, both at once); the cleaned URL after a bad inbound; `checkInbound` takes a cached hit, waits on a miss while a fetch is in flight, rejects one only after a fetch since mount or an error, and `fetchIfIdle` fetches once. `field.test.ts` "initial mode": the URL's mode wins on both devices, `layout` on a phone is Field |
| unit (web) | `lib/editor/__tests__/conflict.test.ts`, `write-client.test.ts` | §3: rebase vs moved vs refresh, unknown base, structure never merged; tokens sent and advanced, one re-send, `EditorConflict`, code re-keying, delete seeding |
| unit (web) | `lib/editor/__tests__/structure-edit.test.ts`, `sequence.test.ts`, `state.test.ts` | §4: sequence positions, insert / append / remove / move / role, legs dropped on a new predecessor; display sequence, explicit structure, leg → insert position; §3 Escape cascade, hide-others, modes |
| unit (web) | `pages/editor/__tests__/action-bar.test.ts` | §4: the entries per selection, the legacy ids; a leg: *Add bend here* only where the leg can be edited (§6.7), its click's Alt handed to the page (F16); empty map: *Add map-issue point* with its tooltip key (F14), a crossing / map-issue point: *Delete* only (§6.8) |
| unit (web) | `pages/editor/__tests__/placement.test.ts` "C: the crossing tool", `bindings.test.ts` "the crossing ghost", `lib/editor/__tests__/checks.test.ts` "legs keep their bends and crossing point" | §6.8: armed on a leg it names the leg, free otherwise; no number or pending leg; a placement on a leg ends the chain (`endsChain`), a free one stays armed; switching arms afresh; the ghost's two lines along the passage (east, north), no circle, its label, the rail lights `C`; `checkStructureOf` keeps bends and the crossing (public id as a string) |
| E2E | `e2e/course-editor-placing.spec.ts` "F4: crossing and map-issue points" (`chromium`) | §6.8: a selected leg, `C` (lit), the ghost `crossing_point`, a click → one `course.setStructure`, back to `V`, one `course-site` `data-role="crossing_point"` whose `data-angle` is the leg's direction, the leg's drawn piece has a vertex within 0.3 mm of it, the on-map sheet's wide row `data-symbol-key="13.3"`; the Leg section names it, *Crossing section* → 13.4 (`data-section`); two undos → 13.3 again, then no crossing and no row. *Add map-issue point* on empty map → a `course-site` `data-role="map_issue"` in Course view, the kind select reads it; the course sheet's `maps.pdf` has the same stroke count, the all-controls print gains strokes (`analysePdf.strokes`) |
| unit (web) | `lib/editor/__tests__/structure-edit.test.ts` "leg props", `bends.test.ts`, `sequence.test.ts` (with "legMeterInputs"), `pages/editor/__tests__/rail.test.ts` | §6.7: `legMeterInputs` (F25): without a draft each row's point with its stored bends, a draft replaces the bends of its leg's rows only (a leg without bends gets them, an unknown key changes nothing, a loop's repeated leg at every visit), the crossing point routed into the drafted bends, an unpositioned row null and the row after it undrafted; `setLegProps` merges and keeps the other props, drops `undefined` / `line` / empty bends and an empty leg, no-op on the first item; a leg whose predecessor changes still loses it; bends inserted on the nearest segment (first, middle, last) smooth with handles from their neighbours, Alt a corner, a curved segment split with its shape kept (F16), toggled corner ↔ smooth and set by Smooth / Corner, a grip mirrored / Alt / Shift, every number at 0.01 mm, moved with their handles, removed; distance, fraction, point and slice along the bent length; `legForInsert` the inverse of `insertIndexForLeg` (unpositioned rows skipped); the corridor chord key outside `AREA_CHOICES` |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` "V on a selected leg", "V on a selected leg: the live draft", "leg gaps", `gaps.test.ts` | §6.7: outline through the bends and a handle per bend (`data-focused`); a drag redraws, writes once with the moved (snapped) bend; a click focuses; a cancelled drag writes nothing; a double-click on a handle inserts no control. F16 ("smooth bends, grips, Alt"): the outline the flattened curve, a grip per handle (none on a corner); a grip drag by the pointer's offset, mirrored, the outline following, one write and the bend focused; Alt live breaks the pair, Shift 45°; a grip click or cancelled drag writes nothing, a double-click on a grip inserts no control; a handle beats a grip; a bend drag keeps its handles, Alt or not; Alt-click toggles both ways, one write. §6.3: gaps along a bent leg (fractions of the bent length, the target and gaps drawn along it). F21 ("the live draft"): a bend drag reports its snapped bends past 3 px, never before, and the release writes once without a draft call; a cancelled bend or grip drag reports null and writes nothing; a click, an Alt-click and a grip click report no draft; a grip drag reports its mirrored pair, Alt live; without `onBendsDraft` the gestures work as before |
| unit (web) | `lib/editor/__tests__/variation-view.test.ts` "the editor's leg draft", "the shown leg draft", `bends.test.ts` "bendsEqual", `lib/__tests__/course-layer-request.test.ts` "the editor's leg draft (F21)" | §6.7 (F21): `withLegDraft` patches only that leg's `bends` on the course of its name (style, gaps, corridor, the other legs and courses kept, the input not mutated), an empty list removes them and an empty leg drops out, no draft or no such course gives the overlays as given, and it applies after the override; `shownLegDraftOf`: a live draft only while its leg is selected, a held one until the drawn leg equals the written bends or leaves the ones drawn at the release (and across a leg change), none from another undo epoch; `bendsEqual` by value (absent ≡ empty, a one-sided or zero handle differs); the draft reaches the request as that leg's bends with its corridor kept |
| unit (web) | `lib/editor/__tests__/hit.test.ts` "a leg with no line", "a corridor's edge …" | §5, §6.7: a `none` leg has no hit-index piece; `uiLegsOf` hits it from the derivation's pieces, a circle at its end wins, `accept` passes over it; F14: a corridor leg likewise (no hit piece, a UI leg, the edge no target), a `marked_route` one keeps its piece |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` "V on a selected leg: touch (F23)" | §6.7 "Tablet", §6 (`touchPress`, the placed point): V opts in only with a selected leg; a touch press takes a bend at 10 px and declines it at 16 px (the mouse's 7 px unchanged), takes a grip at 10 px, declines an object, a site and empty map (nothing selected); `onPointerDrag` returns nothing within the slop, then the snapped bend (one write on release there) or the dragged grip, and an object's dragged vertex or grip, nothing for a body drag or a lasso; a tap focuses with no write; a cancel drops the draft with no write |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` "corridor guides" | §6.7 (F14): one blue dashed `editor-corridor-guide` per corridor leg along its points with `data-course` / `data-leg`, under the tool's shapes; the tool's hooks kept (a press on a guide declines; an armed tool stays exclusive); no guides → the binding unchanged, no binding → the guides alone |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` "hoverPoint: the placing tools' point for the placement loupe (F27)" | §6, §10 "Loupe" (F27): `placeBinding`'s `hoverPoint` is the ghost's `at` (null without a ghost); `textBinding`'s the page's snapped hover (null without one), its `onHover` passed through and its click placing the same snapped point; V, the area tool, `G` and the eyedropper set no `hoverPoint` |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` "V on an image (J7)", "I binding (J7)"; `lib/editor/__tests__/hit.test.ts` "an image (J7)"; `lib/editor/__tests__/style-fields.test.ts`; `lib/editor/__tests__/state.test.ts` "the image tool and the aspect lock (J7)"; `pages/editor/__tests__/rail.test.ts` "I (J7)" | §5, §6, §7 (J7): an unselected image declines the press; the selected one's turned outline and four corners; a body drag one draft per move and one write; a corner drag at 0° and 30° keeps the opposite turned corner, locked the ratio; a cancelled drag writes nothing; a corner click focuses nothing; `imageBoxAt` for landscape, portrait and unknown sizes; the `I` binding's ghost, `hoverPoint`, click and right-click, nothing without a graphic; the image hit below a control, a leg and a white-out's outline, inside its turned box only; opacity %, defaults removing keys, rotation clamped, size about the centre with the lock, a crop keeping the content's place at 0°, 30°, flipped, and Reset |
| E2E | `e2e/course-editor-tools.spec.ts` "I: image tool and style fields" | §5–§7 (J7): `I` lights the rail and opens the picker with its hint; Place, a click: one create, a 30 × 15 mm image of a 16 × 8 PNG, selected, `V`, four handles; unselected, a drag inside pans and leaves it, a click inside selects it; a body drag one update; a corner drag keeps 2 : 1; opacity 50 → `0.5`, Multiply, rotation 30, width 20 → height 10 with the lock, `Ctrl+Z` restores the width; crop width 50 % halves the box in one update and one `Ctrl+Z` restores box and crop; a control inside a stored image is selected by a click on it |
| E2E | `e2e/course-editor-legs.spec.ts` "F3: legs — styles, bends, corridors" (`chromium`), "F3 on a phone" (`mobile`) | §6.7: a leg made a marked route → its `course-leg` pieces `data-style="marked_route"`, `none` and the leg still selects by a click, two undos back to `line`; *Add bend here* → one `editor-bend-handle`, dragged 60 px → the drawn leg has a vertex within 0.3 mm of it and the row's metres grow, `Delete` removes it (metres back, both controls still on the course); `A` then `C` → the default corridor, no map colour left in the band beside the edge (`inkAt` "map" = 0, > 0 before), F22: map colour behind both controls (within the pre-F22 wrap R + 5 mm, beyond the inside's round end; > 0 before and after — 0 on the pre-F22 band), the entry disabled with a corridor, the course's sheet prints one page, no `editor-leg-corridor-opacity` (F25), a width of 0 and a white band of −1 not written (the stored values shown again), a width of 80 written with the stored `whiteOpacity` 1 kept (F25), *Remove* brings the map back, undo the corridor; F14: no purple along the leg's middle inside the corridor (> 0 before and after *Remove*) while the edge is purple, the Style note shown, with the leg selected no `editor-corridor-guide` (its outline instead), deselected exactly one, none in All controls and one again in Course view, a click on the leg (where it is clearest of other sites — every F3 leg click, `legClickPoint`) selects it again, after *Remove* no guide and no note. F19: R read from the gap tool's target; both circles purple across the opening's middle before the corridor, the corridor narrowed to about 1.2 R (the default 50 m can be as wide as the circle on the fixture map: h ≥ R, the circle whole inside it), then no purple there, purple on the circles' far sides and at all four junctions, a click at the end control's centre selects it (the UI circle, §5), purple across the openings again after *Remove*. F16: *Add bend here* stores a smooth bend (`hOut` ≈ (b − a) / 6, `hIn` = −`hOut`), `data-curve="smooth"`, two `editor-bend-grip`, the outline 3 points and the metres unchanged; the upper grip on screen (clear of the action bar) dragged 60 px → one write, the pair still mirrored, the outline > 3 points, the metres grow; the same grip dragged again with Alt → only its handle changes; Alt-click the bend → no handles stored, `data-curve="corner"`, no grips, *Corner* disabled; *Smooth* → two grips again; two undos back to the corner, then to the broken pair; the course's sheet prints one page; Alt held on *Add bend here* → a corner (no handles, no grips, *Smooth* enabled). F21 (appended): *Add bend here*, the handle held (mouse down, `dragHold`) at least 2h + 12 mm off the chord where the probes clear every site, read held (`inkAt(…, true)`: the overlays transparent, not hidden — a hidden overlay sends the viewer a `mouseleave`, its gesture cancel; F24: the held probes lie clear of the mouse loupe's circle, `loupeCircleAt` — the apex up the screen, or down when the loupe would cover the band beyond it, with ≥ 20 probes of each band clear) → purple at the held apex, row b's `editor-leg-meters` at least the apex's two straight pieces long (F25: a leg through the apex is no shorter), no `course.setStructure` request yet; the release → the same metres while the write is in flight, exactly one request, the stored bend within 0.5 mm of the apex, the line still there, the metres unchanged; undo → the bend back on the chord, no purple at the apex, the chord's metres; the default corridor → the chord's band white, the map at the apex's band; held again → the band beyond the apex white and the map beside the chord, no request; the release → one, the stored bend at the apex and both probes unchanged (no jump back); undo → the chord's band white again; held once more → the apex's metres, and `Escape` → the chord's metres before the release (F25), the release sends no request and the stored bend stays on the chord. F24 (§10 "Loupe"): control a held with the mouse (`dragHold`) → `editor-loupe` with `data-pointer="mouse"`, `data-scale` 2.5, 120 px, its bottom 16 px above the cursor (its top 16 px below at the map's top), centred over it within the box (±1 px), no `editor-touch-handle`; the canvas in it (read held) has purple and differs in > 10 % of its pixels from the same circle at 1× after the drag; the pointer leaving the viewer → no loupe, no control or course write (the presence heartbeat aside), the control where it was; held again and `Escape` → no loupe while the button is down, the release writes nothing, the control where it was (§3; the cascade drops the course, picked again); F30: control b's number held → no `editor-loupe` (the drag itself still runs), `Escape` → no write, the number where it was; held again → still none, the release → exactly one `course.setControlLabelOffset`; *Add bend here*, the handle held 60 px off the leg → the loupe, the UI handle within 0.5 mm of the cursor's paper point, the release → none, one write, the stored bend there; a press on the handle moved 1 px and released → no loupe; the handle held again and `Escape` → no loupe, no write, the stored bend unchanged. "F24: the loupe on an object's vertex drag" (an `oob_area` through `courseObject.create`, selected by its outline): a vertex held with the mouse → `editor-loupe` (`data-pointer="mouse"`, 16 px above the cursor or below it at the top), no stem, a vertex handle within 0.5 mm of the cursor's paper point; `Escape` → no loupe while held, no `courseObject.update` on release, `data-geometry` as stored. On a phone a tapped leg shows `editor-leg` read-only with `editor-leg-readonly` and no *Add bend here* |
| E2E | `e2e/course-editor-legs.spec.ts` "F23: bend drags on a tablet" (`chromium`, `hasTouch` + `isMobile` at 1024 × 768; skipped on `mobile`) | §6.7 "Tablet", §10: `data-layout="desktop"` with `(pointer: coarse)`; a tapped leg's section editable, *Add bend here*; a finger 10 px beside the handle moved down-right and held → `editor-touch-handle` and `editor-loupe` visible, the UI handle within 0.6 mm of the point 48 px above the finger, the loupe's bottom 16 px above that (or its top 16 px below the finger when it flips at the map's top) and centred over the finger (±1 px), no `course.setStructure` yet; the lift → exactly one, the stored bend within 0.6 mm of the lifted point with its handles unchanged, focused, stem and loupe gone; the upper grip pressed on its far side and dragged → the loupe, one write, its handle changed and the pair mirrored, the bend in place; a bend drag joined by a second finger → no write, the bends unchanged; after an undo (the bend unfocused) a tap on the handle → focused, no write, the bends as before |
| E2E | `e2e/course-editor-placing.spec.ts` "F27: the placement loupe toggle" (`chromium`) | §10 "Loupe" (F27): a new course, `K` armed, `editor-placement-loupe` `aria-pressed="false"` → a hover shows the ghost and no `editor-loupe`; the button → pressed, `localStorage` `oxygen.editor.placementLoupe` = `true`; a hover → `editor-loupe` `data-mode="hover"`, `data-pointer="mouse"`, 120 px, its bottom 16 px above the cursor (top 16 px below at the map's top), centred over it within the box (±1 px); the canvas in it (read held: overlays transparent) has purple; `L` → off, no loupe with the pointer still, the same circle at 1× differs in > 10 % of its pixels; `L` → on, the loupe back with no move; `dragHold` 60 px → the loupe follows the cursor, the release → the view centre moved, no control or course write (the presence heartbeat aside), the site count unchanged; a click (`place`) → one new site; the cursor 3 px off an existing control's centre (the ghost *Add ‹code›*) → the loupe's `data-x` / `data-y` within 0.01 mm of the site's centre, the cursor's paper point > 0.1 mm off it; the pointer out of the viewer → none; `Escape`, `T` armed → the loupe on a hover; `Escape` (`V`) → none on a hover; a reload → still pressed, `K`'s hover → the loupe; the button → off, the ghost and no loupe. "a mouse drag keeps F24's loupe with the toggle on": a control held in `V` → `data-mode="drag"`, `data-pointer="mouse"`; `Escape` → none |
| E2E | `e2e/editor-top-bar.spec.ts` "F29: the top bar fits one row at 1840 × 1090 and collapses by the row's width" (`chromium`) | §2 "Top bar" (F29): *Bana 1* (with Class ▾) at 1840 × 1090 → every item of `map-toolbar` on one line, the band the row's width gives; at 2400 / 1500 / 1100 px (each asserted to land in its band before and after F28) → every label / tier 1 (`[data-toolbar-label]` of hide-others, cuts, descriptions, Export's and the picker's word hidden, mode words shown) / tier 2 (the mode words hidden, their icons shown), one row each; at every width the combobox *Course*, the buttons *Hide other controls*, *Auto slits*, *(Hide) descriptions*, *Export ▾* and the Mode group's *Course* / *Layout* / *Field* (test id and `title` checked) resolve by role and name, and the view group keeps its words |
| E2E | `e2e/course-editor.spec.ts` "Course editor (new, GL canvas)" (`chromium`) | §1: the editor mounts (never `course-editor-page`), and on an event with no map it mounts over the panel's upload prompt (no viewer); the shell (`C` enabled since F4, `X` since F5); place → move → undo / redo → reload → select on the canvas → delete; create a course, append two controls, add-to-course on the map, reorder + undo, insert on a leg, remove, reload with `?course=` (explicit start / finish rows); deep links, `H`, Escape cascade; the Courses page's `course-edit-link` and the Controls page's `control-edit-link` open the new editor on the course / with the control selected (one `editor-selection-ring`) |
| E2E | `e2e/course-editor.spec.ts` "Course mode (§4)" (`chromium`) | delete cascade: a control on two courses is deleted from the action bar — the site goes, both structures lose it (the open one's rows, the other through `course.list`), `Ctrl+Z` restores the site and both visits; *Remove from course* drops one visit and keeps the site; inline code edit in the sequence (`editor-seq-code` → 997: the row's `data-control-id` and the site follow, `Ctrl+Z` back; a duplicate code → `editor-error` "already exists"); free order (`editor-order-mode`): the hint, no reorder arrows, the layer draws no legs and labels the circles with their codes, a number drag still writes `course.setControlLabelOffset`; a number drag (the shared hit-test's `number` target): the `course-label` moves, persists over a reload, *Reset label* puts the automatic place back, undo the dragged one; clone (`editor-clone-*`, "A (copy)" prefilled, same rows) and no `editor-toggle-first-start` / `-last-finish` even with a legacy-flag course in the event |
| E2E | `e2e/course-editor.spec.ts` "Course mode descriptions (§4)" (`chromium`) | the description editor: Escape closes only the dialog (the control stays selected), column C which-of-similar with written titles (`desc-opt-label-0.1N`), a boulder and dimensions with the live preview (`desc-dim-input` → `desc-preview`), saved, reloaded, the summary; *Clear* + save stores none, `Ctrl+Z` writes the saved description back (the control's own description written back after); a control placed on the map is described from the base map (no suggestion offered, a pressed option in `desc-editor`), after a move it stays selected with its action bar and at most one suggestion; the description sheet: "All controls" with every control until a course is picked, then course E's card (event name, course name, the finish row's measured metres, the thick rules); description instructions (E3b): the collapsed block's summary, the finish variant 14.1 (one `course.update`; the sheet's finish row changes, `course.list` has it), a special row with 60 m (a wide row with "60 m"), anchored after a control by its punch code — `courseMap.resolveSheet`'s block has the special after that control and the 14.1 finish —, `Ctrl+Z` puts it after the start again, all persisted over a reload |
| unit (web) | `lib/editor/__tests__/instructions.test.ts`, `write-client.test.ts` | §4 description instructions: finish variant and length, add / update / remove a special, normalisation (lengths, whole metres, empty → `null`), specials off the course left out, the length field's parse; `setInstructions` sends the course's token, seeds the result as own, `null` clears, a stale token is a `refresh` never re-sent |
| integration | `packages/api/src/__tests__/integration/course-structure.test.ts` "concurrency", `course-maps.test.ts` | §4 description instructions: `course.update { descriptionInstructions, baseVersion }` advances the token and leaves the structure, `course_controls` and geometry as they were; `course.list` / `detail` echo it; a stale token → `CONFLICT` (kind `course`), nothing written; `null` clears. The same value in `resolveSheet`'s block and `courseMap.list`'s print rows, a special anchored by the punch code (the control's seq differs) |
| E2E | `e2e/course-editor.spec.ts` "Automatic cuts" (`chromium`) | `course-layer.md` §3.4 through the mirror: a control whose rim passes the fixture's boulder (68 / 42 mm; radius from the `G` target) is drawn with a cut around south (`course-site` `data-cuts`); a leg across the boulder is drawn in two `course-leg` pieces on its line, none covering the boulder. The event's auto-cuts toggle (`editor-toggle-cuts`, D17): off, the rim control's slit goes while a control's stored circle gap (`control.update { circleGaps }`) stays; on again, the slit is back |
| E2E | `e2e/course-editor-status.spec.ts` "conflicts (two contexts)" (`chromium`) | §3 / §11 / `course-layout.md` §2, B a second context: **structure** — B appends, A's append on the old token answers `CONFLICT` once (no re-send), `editor-conflict[data-kind=refresh]` "Changed elsewhere…", A's rows reload to B's, the redone append lands after it; **control** — B writes the description, A's move is refused once and re-sent on the server's token with no notice (B's description kept), B moves it again (after its poll showed A's move), A's next move shows `editor-conflict[data-kind=moved]` with B's x, *Keep mine* writes A's position; **sheet / template** — B aligns the map, A's align map is refused and A shows B's centre (nothing of A's stored); both in template scope, B writes the orientation, A's paper-size write is refused (B's orientation, A4 kept) |
| E2E | `e2e/course-editor-phone.spec.ts` "touch" (`mobile`, Pixel 7) | §10 in Course mode on a phone: a tap selects (`editor-sheet-selection`), the peek row's ≥ 44 px *Append* (no `editor-action-bar` on the map) writes the structure, one finger on the selected control drags it at once, the overflow's undo puts it back; `+` → `K` → Place / Done in Course mode appends the placed control and the layer draws the leg to it |
| unit (web) | `pages/editor/__tests__/placement.test.ts` | §6.1: insertion point (before the finish, after the selected control, at a leg, `S` at 0, no course), chain advance, `Ctrl+Z` steps back, `S` → `K`, ghost number and pending legs (a start's leg runs to the first item) |
| unit (web) | `lib/editor/__tests__/leg-length.test.ts`, `lib/__tests__/course-layer-request.test.ts`, `lib/editor/__tests__/hit.test.ts` | §6.1: metres at the map scale, "‹n› m", the midpoint, a dragged control's labels (both legs, every visit, over undrawn items); the provisional visit in the request (`course-layer.md` §5); §5 `accept` passes over other targets and finds the site below a rejected one |
| unit (web) | `pages/editor/__tests__/toner-saver.test.ts` | §6.4 toner saver: every site at least the margin inside the sampled outline (and the hull sites exactly), tangent continuity at every vertex and along the straight edges, one site → four quarter arcs, two → a stadium of six vertices, collinear and duplicate sites, one cubic per ≤ 90° of turn with the handle (4/3)·tan(θ/4)·r, micrometre rounding |
| unit (web) | `pages/editor/__tests__/polygon.test.ts`, `gaps.test.ts` | §6.4: vertex flow, close on the first vertex / double-click, line kinds, vertex drag, `pull-handles` (symmetric, `Shift` 45°, back to zero the press's kind — smooth, or a corner with Alt —, a filter region stays a polygon, a moved curve vertex keeps its handles); smooth by default (F18: a placed vertex a corner until the next lands, then `(next − prev) / 6`; recomputed when it or a neighbour moves; a pull wins over a neighbour move; Alt at the press a corner through landings and moves; a filter region a polygon, Alt ignored; closed kinds wrap at close, Alt on the closing click makes the first vertex a corner; an open line's ends stay corners; every finishing path strips `corner` / `pulled`; Alt on a double-click a corner, the others wrapped; a plain click stores no flag); §6.3: compass degrees, shorter arc, minimum, merge across north, leg fractions |
| unit (web) | `lib/editor/__tests__/geometry-edit.test.ts` | §7 "Editing geometry": 8 samples per curved segment on the cubic, a curved closing segment, open paths never close; the nearest edge (closing edge, along a curve); insert on a straight edge, on the closing edge, on a curve (de Casteljau: the halves trace the original, the new vertex smooth); delete down to the minimum; symmetric handles, retract, `toggleSmooth` (F18: a corner → `smoothHandles`, a handle → a corner, the closed wrap, null for an open end corner and out of range, an open end with handles retracts), grip drags (mirrored, smooth with the other's length kept, Alt breaks, broken / lone handles alone), 45°; `smoothHandles` (D15, F18: an interior vertex `(next − prev) / 6` and its negation, the others untouched, the closed wrap at both ends, open ends corners, fewer than three never wrap, a spike a corner, out of range a copy); `vertexRule` agrees with `courseObjectBodySchema` for every kind |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` "geometry editing on a selected object", "while drawing: a press places a smooth vertex…" | §7 "Editing geometry": the sampled outline and grips; Alt-drag moves the vertex with one write (F18), a filter region's Alt-drag moves it too; Alt-click toggles (handles → a corner, a corner → smooth `(next − prev) / 6`; a filter region: no write), a plain click focuses, a body click unfocuses, the focused handle drawn; a grip drag mirrored, Alt live breaks it; double-click on an edge inserts a smooth vertex with collinear handles, Alt a corner (inside, on a vertex, on a text: nothing); a press within reach of the edge is the object's; §6.4 the area tool's press places a smooth vertex (its neighbour gaining handles on the same write), a drag past 3 px pulls handles (Shift 45°), back within 3 px the press's kind, the curved preview and its grips; Alt at the press a corner (the pull still wins, the corner kept; no Alt = smooth; a filter region ignores Alt), the closing click wraps every smooth vertex, Alt on it makes the first a corner, `onDone` carries no flags; the preview shows the hover as a smooth vertex (a ring of three curves throughout; a filter region's straight) with no provisional grips and nothing written (F18) |
| unit (web) | `lib/editor/__tests__/geometry-gestures.test.ts` | §7 "Editing geometry" after D16's extraction: the pressing order (vertex, grip, edge within reach, the inside no press, the caller's body), a vertex drag in the caller's units (nothing until it moves), Alt-drag moves and Alt-click toggles both ways (F18; the wrap at vertex 0, nothing for an open end and a filter region), focus (none for fixed kinds, the body unfocuses), a cancelled drag, insert on an edge (smooth with collinear handles, Alt a corner, a filter region a corner; on a curve the split, Alt dropping the new vertex's handles; not on a vertex, not inside, not for fixed kinds), the shapes with the caller's ids; `bindings.test.ts` unchanged is the net for `selectBinding` |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` | §6, §7: V (Shift-click, lasso, object select / move / vertex, outlines, double-click leg; D12: for every closed kind an interior press declines, selected or not, an edge press within 7 px or the hit-test's outline target drags it, a vertex still wins; a line's stroke press is the object's), armed (exclusive, right-click, touch, ghost label and leg length label, no UI-layer leg; the ghost circle only without a drawn provisional visit, a finish's two circles, P4), area (vertex drag, first-vertex close), G (rim drag, click removes, leg) |
| unit (web) | `lib/__tests__/undo-stack.test.ts` | §6.1: `UndoStack.top`, which `Ctrl+Z` while armed checks before stepping the chain back; §9 "Offline" (D9c): `nextRedo` |
| unit (web) | `lib/editor/__tests__/snap.test.ts`, `hit.test.ts`, `state.test.ts`, `structure-edit.test.ts`, `write-client.test.ts` | §6.2 snap candidates and distance; §5 object targets (stream and UI-layer outline); §6 Escape order, multi-selection, object selection, tools; §6.3 / §6.6 `setLegGaps`, `setNumberHidden`; §7 object tokens |
| E2E | `e2e/course-editor-tools.spec.ts` "tools" | §6.1 ten controls in ten clicks with `K` (the ghost label — its circle is the layer's, P4 —, no UI-layer pending leg, the leg length label "‹n› m" and no `editor-pending-leg-length` (P2), no action bar and no `editor-selection-ring` while armed, `Ctrl+Z`, `Esc`, the ring back on a click in `V`), reuse of a site; §5 / §7 the area-press rule (D12): a drag starting inside an `oob_area` (created through `courseObject.create`) moves the view (`data-centre-x`) and leaves the area unselected and unchanged, a click on its outline selects it (four handles), a drag inside the selected area pans and keeps the selection, a drag of its edge translates every vertex (one `courseObject.update`), a click inside deselects it; the armed `K` over the map: a `course-leg` piece of the course ends at the cursor's circle (absent before the hover, follows a second hover), no `editor-pending-leg`, the label = the metres from the last placed control's stored mm to the cursor's paper point at the map scale (read from the map-info dialog's `editor-map-info-scale`, P6) within 2 m (P2); a drag of the middle control shows two `editor-leg-length`, none after release; §6.5 Shift-click three controls → one add-to-course (one undo entry), §6.6 a site's notes written and reloaded; §6.3 a rim drag stores a circle gap, Reset gaps clears it; the layer draws what the tools store (D1's request path): a leg gap cuts the drawn leg, a circle gap is in the drawn site's cuts (`course-site` `data-cuts`), a hidden number leaves the site without its `course-label`; §6.4 / §7 an out-of-bounds area drawn (Alt-clicks: corners, F18), drawn on the canvas (709: purple inside it), its hatch (710) and border later set from the inspector (the stored props; 710 on the canvas is the shared layer path, probed in print only), printed (the all-controls `maps.pdf`: one page, the 709 hatch's clip-and-stroke operators present with the `all`-scoped area, one more run with `hatch: "710"`, gone when it is parked), selected again on the canvas (a click on its outline), deleted and undone; §6.4 / §7 "Editing geometry" a curved white-out in three clicks and one drag (two Alt-clicks — corners —, a click-drag that shows two `editor-polygon-grip`, the closing click): the stored vertex has `hOut` = the drag on paper and `hIn` its negation, the selection outline has 8 samples per curved segment, the all-controls `maps.pdf` gains exactly one curved fill (a fill path with `c` segments — the base map has its own); a double-click on a straight edge inserts a smooth vertex at its midpoint (handles 3 → 4, `hOut` ≈ the edge on paper / 6, grips 2 → 4), a click focuses it and `Delete` removes it (the object stays), `Ctrl+Z` brings it back, `Alt`-click on the corner b makes it smooth (grips 4 → 6, `hOut` stored), `Alt`-click again a corner (6 → 4, no handle stored); §6.4 smooth by default (F18): three clicks, Alt held at the third — no grips until the third lands, then two — and a plain closing click store `g[1].hOut` = `(g[2] − g[0]) / 6` (and ≈ the clicks' chord on paper / 6), `hIn` its negation, `g[0].hOut` = `(g[1] − g[2]) / 6` (the wrap), the Alt corner `g[2]` without handles, no `smooth` / `corner` / `pulled` key stored, four grips, and one `Ctrl+Z` removes the object (one undo entry); a filter region hides the 505 path under it live (canvas ink probe; its entry is the heading `editor-filter-symbol-505`, §7); §6.4 the toner saver (`A` then `S`, D13): `marginMm` 25, Bézier arcs stored, the outline sampled, and the course's `maps.pdf` (its sheet made first) carries at least one more `c` operator per stored curved vertex than without it (D13's deferred print check) |
| unit (web) | `lib/editor/__tests__/symbol-groups.test.ts` | §7 filter region: one entry per heading (an applied match's library heading, `601.b` + `601` merged; else the source base, `101.1` joins `101`; a suggested match is not applied), library names by UI language (`sv`, `sv-SE`), hidden / unused / missing / proxy-drawn symbols not listed, library headings first in code order and Other last (a rectangle frame, `graphic`), swatches (the most used applied entry, else the document symbol), search (heading, both library names, member codes and names), all / some / none, a toggle completes or removes the whole group, the group of a symbol, the swatch URLs (versioned library path; event-scoped document preview) |
| unit (web) | `lib/editor/__tests__/symbol-pick.test.ts` | §5 / §6.4 the eyedropper's pick over an encoded document: objects per symbol, an area inside it with its pass colour, a line over the area within the tolerance (topmost wins), the area beyond half width + tolerance, a hidden symbol never, a text by its box, a proxy-drawn point by its disc, empty map null |
| unit (shared) | `packages/shared/src/map-document/__tests__/render-bridge.test.ts` "a subset of objects" | `map-document-format.md` §8: `docIdx` maps each render object to its document object; `only` symbolises the listed objects and keeps the symbol table aligned |
| unit (web) | `lib/editor/__tests__/state.test.ts`, `pages/editor/__tests__/bindings.test.ts` "the eyedropper binding" | §6.4: `pick-symbol` dropped by Escape first (the object stays selected) and by any mode change; the binding is exclusive with a crosshair, a click picks with 6 px × `mmPerPx`, right-click exits, no shapes; `railKeyOf` lights no rail button |
| unit | `lib/editor/__tests__/attach.test.ts` | §7 "Attached objects" (J10): `shownObject` moves an attached object to its control's drawn position with `at` that position, hides it without its control; attach keeps the drawn place, centre moves the centre onto the control, detach keeps the drawn place without `attach`; a text centres by its anchor; the nearest site |
| E2E | `e2e/course-editor-tools.spec.ts` "J10: attach to a control" (`chromium`) | §7 "Attached objects": a 10 mm `oob_area` on a clear spot selected by its edge; *Attach to a control I click* armed (`aria-pressed`), a click on a control → one `courseObject.update`, the object selected again, `data-attach` that control, `data-attached` its code; the control dragged 6 mm → `data-drawn` moved by the control's offset, the stored geometry unchanged and no object write; the all-controls `maps.pdf` still draws its 709 hatch; a click on its moved edge selects it; that edge dragged 3 mm up → drawn exactly 3 mm higher and no further east, `at` the control's position now; *Centre on control* → one update, its centre on the control; the control deleted → no object write, `data-attach` empty and still drawn; `Ctrl+Z` (`control.restore`) attaches it again; *Detach* → one update, drawn where it was |
| unit | `lib/editor/__tests__/transform-gestures.test.ts` (J11 cases), `pages/editor/__tests__/bindings.test.ts` "V transform handles (J11)" | §7 "Transform handles": `anchorKnob` up from the anchor and turned; `transformVertices` turns with the handles, both flips, a whole turn null; the knob on a 0° and a 30° image and a text, none on a white-out or line; a quarter-turn knob drag → `rotationDeg` 90, a draft per move, one write, no geometry; Shift mid-drag snaps; back to 0 drops the key; a text turns about its anchor; a cancelled drag drops its draft; a finger is declined; Shift inverts the lock both ways; crop mode's shapes (four edges, the whole graphic, no corners or knob), an edge drag on a turned flipped image writes `cropEdge`'s geometry and crop once, the body still moves; a double-click on the image enters crop mode, on a leg it is the leg's |
| E2E | `e2e/course-editor-tools.spec.ts` "J11: transform handles in Course mode" (`chromium`) | §7 "Transform handles": a 20 × 10 mm image and a 10 mm white-out on clear spots; the image selected; its knob dragged a quarter turn → one update, `rotationDeg` ≈ 90, `Ctrl+Z` removes it; held and `Escape` → no write; a double-click → four `editor-object-crop-edge`, no knob, *Crop by its edges* pressed; the right edge a quarter in → one update, crop width 0.75, the box 15 mm wide; `Ctrl+Z` restores; `Escape` leaves crop mode with the image selected; crop mode again, a click on the white-out's edge selects it and leaves crop mode; the white-out's *Turn 90°* and *Flip ↔* → one update each, its first corner at (−5, 5) then (5, 5) from its centre. Both objects are attached to a control as if it had moved 1 mm since they were written: the crop keeps the drawn left edge with `at` the control's position and undo puts the drawn box back; the turn writes the drawn vertices with `at` the control's position |
| unit | `lib/editor/__tests__/clipboard.test.ts`, `lib/editor/__tests__/write-client.test.ts` (`createObjects`) | §7 "Duplicate, copy, cut, paste": the entry round-trips through storage, a corrupt or older one reads empty, a throwing storage keeps the memory copy; the duplicate 3 mm right and down with its attachment; a paste at a point centred and free, onto a control at the copied offset or centred and attached; the scope rules of answer 9 (same event drawn, not drawn, view All, another event, `all`, an unscoped object); the four refusals; a batch create in order, rolled back on a failure |
| unit / E2E | `lib/editor/__tests__/style-fields.test.ts`, `clipboard.test.ts`; `e2e/course-editor-tools.spec.ts` (the J7 test) | J15 "Cut out graphics below": on writes `knockout: true`, off removes the key; duplicate, copy, both pastes and storage keep it; in the browser the checkbox writes and clears `props.knockout` |
| E2E | `e2e/course-editor-tools.spec.ts` "J12: duplicate, copy, cut, paste" (`chromium`) | §7 "Duplicate, copy, cut, paste": a 10 mm area selected; `Ctrl+D` → one create, the copy selected 3 mm right and down, scope `all`; `Ctrl+C`, the pointer on a clear spot, `Ctrl+V` → the copy centred there and selected; `Ctrl+X` takes it out; two controls Shift-selected, `Ctrl+V` → two copies attached, each centred on its control, one `Ctrl+Z` removes both; after a reload `Ctrl+V` still pastes; an image entry naming an unknown graphic → `editor-error`, nothing created |
| E2E | `e2e/course-editor-tools.spec.ts` "filter symbol picker" (`chromium`) | §6.4 / §7 (P3): a filter region over the 505 path, *picked symbols*: `editor-filter-symbol-505` with `data-members="3"` and "Path", `601` named "Magnetic north line" (601.0 matched to 601.b), no entry with a source code (`.`), the 505 swatch image loaded, the 850 frame only under Other, the search "path" → one entry; the eyedropper armed (`aria-pressed`, `V` not lit, no `editor-selection-ring`), a click on the path → one `courseObject.update`, `"symbols":[3]`, the 505 box checked, the note "505 Path", the band's ink below a third; still armed, a second click on the path → note `already`, `Esc` → `V` with the region still selected |
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
| E2E | `e2e/course-editor-placing.spec.ts` "P1: …" "no blue circle beside a placed control while K is armed…" (`chromium`) | §6.1, D12: with `K` armed (hover, after each of two placing clicks) and after switching to Field, Course and Layout no `editor-phantom` and no `editor-selection-ring` |
| E2E | `e2e/course-editor-placing.spec.ts` "P4: the dashed ring back after placing…" (`chromium`) | §4, §6.1, P4: `K` armed without a course draws the `editor-ghost` circle with its label; with a course no `editor-ghost` while hovering and after a placing click (`editor-ghost-label` "‹n› · ‹code›", no ring, no action bar); over an existing control "Add ‹code›" with the `editor-ghost` circle (a reuse); in `V` the phantom's *Add control* selects the new control with one `editor-selection-ring` and a visible `editor-action-bar` |
| unit (web) | `lib/editor/__tests__/state.test.ts`, `write-client.test.ts` | §9: Field entered and left keeping the selection, Layout entered dropping all but the course (`course-layout.md`); `checkControl` sends no token and seeds the control's; D9c: a queued move sends its own `baseVersion` over the book's newer one, rebases on a check elsewhere, throws `moved` on a move |
| unit (web) | `lib/__tests__/control-outbox.test.ts` | §9 "Offline" (D9c): coalescing (first `from` and token kept, a move back or a check toggled back drops the entry, per event and control, a conflict moved on is pending from their position on the server's token, an entry in flight never dropped; an undo's description merged into a move kept a pure move, a move merged into a plain write kept plain and replayed without `from`); the overlays (queued positions and check-offs, the same reference when nothing changes); counts; `isNetworkFailure`; the drain: enqueue order with each move's own token and `from`, `onSent`, `moved` kept as a conflict and Keep mine / Keep theirs, `moved` at our own position done, a refusal failed with Retry / Discard, `refresh` failed as changed elsewhere, a network failure stops with the rest pending, a write merged in flight sent after on the returned token, a check toggled back in flight re-sent, a stale flight flag cleared at drain start, a second drain does nothing |
| integration | `course-structure.test.ts` "a move queued before a check-off elsewhere" | §9 "Offline" (D9c): a stale move after `control.check` answers `CONFLICT` with `differing` naming `checkedAt`, not `xpos` / `ypos` — the rebase the replay relies on |
| unit (web) | `pages/editor/__tests__/bindings.test.ts` "pinch-scale" | §10: `scaleAbout` (handles scale with it), a finger on the ring starts it, the draft per move, one write on lift, nothing selected / cancelled / within 1 % writes nothing |
| unit (web) | `lib/editor/__tests__/status.test.ts` | §2, §3, §8, §10 (P2): the peek line's rows for a course (controls · length · climb · scale · checks, numeric `data`), without a course (scale only), the sheet key in place of the scale, snapping on, zero climb and checks absent; the desktop popover's `courseInfoRows` (P6): no scale row, no rows without a course and a sheet, the sheet key kept; the badge (the count, none at zero); the save indicator (`saved` / `saving` the dot alone, `error` / `conflict` / `queued` always show their words) |
| Unit | `lib/editor/__tests__/action-bar-place.test.ts` | §2: the action bar centred under the selection; shifted inside at the left and right edges; the start kept in view when the viewer is narrower than the bar; above the selection near the bottom, below when it just fits, below and shifted up when it fits neither way; the size-0 first frame clamped to the margins |
| E2E | `e2e/course-editor.spec.ts` "The action bar stays inside the viewer" (`chromium`) | §2: fourteen courses through every control (a long *Also in*). On the leftmost clear control the bar, *Add to …* and the ellipsised Also-in line lie inside the viewer, and the line's `title` names the last course; *Add to …* writes. On the lowest clear control the bar lies inside the viewer vertically (`data-placement="above"` and above the control when it does not fit below); *Add to …* writes. The viewer's `scrollLeft` / `scrollTop` stay 0 |
| E2E | `e2e/course-editor-status.spec.ts` "P2: the status bar out of the footer" (`chromium`) | §2, §3 (P2): no `editor-status` on the desktop; `editor-save-state` inside `editor-top-bar` reaches `saved`; `editor-stats` opens the popover (`aria-expanded`) with the controls (`data-count` 0, then 1 after a `K` placement) and length rows and no `editor-stats-scale` (P6), a second click and an outside click close it, Escape with `K` armed closes it and leaves `K` pressed (a second Escape returns to `V`); at 1280 × 720 with `saved` the words take no room (width ≤ 1 px, the title set), the indicator is ≤ 16 px and the button ≤ 32 px wide; at 1024 × 700 a `control.create` aborted at the network → `data-state="error"` with `editor-save-state-text` visible, non-empty and inside the viewport. The shell test ("mounts the new editor") asserts the indicator and the button visible and no `editor-status`; the Layout / Class view test reads the sheet key from `editor-stats-sheet` |
| unit (web) | `lib/editor/__tests__/map-info.test.ts` | §2 (P6): the map-info dialog's rows with a loaded document (name · scale · file, then source · content · library · CRS · importer, their `data`), the map's rows only while the document loads or the import runs, no library and no CRS (rows absent, an OOM source named in full), no map (no rows), an unknown size (the date alone), the club picker's KB / MB rule |
| E2E | `e2e/course-editor-status.spec.ts` "P6: the map footer out; the map-info dialog" (`chromium`) | §2 (P6): no footer — the viewer reaches `map-panel`'s bottom (< 4 px), no `map-review-link`, *Replace map* or `use-club-map` in the panel; `editor-map-info` follows `editor-export` in document order and opens `editor-map-info-dialog` (`role="dialog"`, `aria-modal`, `aria-expanded`; focus inside it through five Tabs and six Shift+Tabs) with the name (`.ocd`), the scale (`data-scale`, "1:"), the north row, the file (`data-bytes` > 0), the document (`data-source="ocad"`, objects and symbols > 0, importer `ocad-‹n›`), *Review symbols* (`href` `/map-review/‹64 hex›`), *Replace map*, at most one *From club library*; the close button and a backdrop click close it, and the course-info popover has no scale row; *Replace map* opens a single-file chooser with `accept=".ocd"` and changes nothing; the backdrop is the element at the page's corner (it covers the shell's header); Escape with `K` armed closes only the dialog (a letter pressed while open does not switch the tool; the next Escape returns to `V`), and with a control selected keeps the selection and the course; an event with no map: `editor-map-info-none`, no scale, no review, *Upload map*. `e2e/map-review.spec.ts` and `e2e/club-map-library.spec.ts` reach the review link, the north-lines badge and the club picker through the dialog (the picker's Escape closes it before the dialog's; a pick from it closes the picker, keeps the dialog without an error, and its `editor-map-info-file` `data-uploaded` follows the new map row); `e2e/mobile-layout.spec.ts` asserts no `editor-map-info` and no *Replace map* in the phone editor; `e2e/editor-fullscreen.spec.ts` opens the dialog in fullscreen (inside `document.fullscreenElement`), and its Escape keeps fullscreen |
| unit (web) | `pages/editor/__tests__/map-model.test.ts` | §13 "Ops": refs and op ids; *Hide* of a document object is a hide op, of an added object the add removed; *Restore*; a move is one rounded integer delta on every coordinate, flags kept, nothing for a delta under a unit or an unknown object; a move over an existing `modify` starts from its coordinates and keeps its angle; a move of an added object rewrites its add; the inverse puts back what was there and removes what was not, none for a no-op; `changes` is false for the same state again; the object's symbol (code, name, swatch) and box, a hidden one still found; the press test on the drawn shape, never on a hidden object, at a moved object's new place; *Corrections* rows in op-id order with the issue of a switched-off patch (taken as enabled) and none for a patch of another document; Tab's corrected-object list and stepping with wrap, a row whose object is missing skipped; `drawnCovers`: a draft goes once its version or a later one is drawn |
| unit (web) | `pages/editor/__tests__/map-bindings.test.ts` | §13 "Gestures and keys": `mapSelectBinding` is exclusive, a click asks the hit-test at 6 px and selects the topmost with the stack (refs only), empty map deselects, an older click's answer is dropped; a press off the selection, without `canMove` or by touch is not taken; a drag past 3 px draws the draft and writes once on release; a release without movement writes nothing and is a click; a cancelled drag drops the draft; `mapKeyAction`: V, N, H, F, Tab / Shift+Tab, Delete / Backspace (a key repeat none), Escape, and none of Course mode's tool keys or modified keys; `MAP_RAIL` is `V`, `N` |
| unit (web) | `lib/editor/__tests__/geometry-edit-coords.test.ts` | §13 "Nodes", coordinates ↔ vertices: a straight open line in paper mm and back; a cubic's controls as the ends' handles and back; a control on its own anchor no handle, written back as it was; an area with a hole as two closed rings, the hole flag on the hole's first point only; anchor flags (dash, corner + no-left, gap) through smooth, grip, retract, insert (the new vertex none, a curve's split too) and delete; a repeated close dropped and written back from the first vertex, deleting vertex 0 moves both ends; a hole's first vertex deleted moves the hole flag; a curved close repeated at the end as the first vertex's in-handle and the last's out-handle; an implicit close made curved gains the repeat (read back the same path); the repeat's own flags kept, none included; control points' own bits (no-left / no-right) kept through a grip drag and a vertex move, and on a curved repeated close; rounding to whole units; a broken curve encoding (a lone control, a ring starting or ending on one) or nothing → null |
| unit (web) | `pages/editor/__tests__/map-nodes.test.ts` | §13 "Nodes": `nodesOf` — a line's and an area's rings (the hole its own), the curve's controls as handles with an anchor flag; the reasons `kind` (a point), `encoding`, `read-only`, `disabled`, `hidden`, `too-many` above `MAP_NODES_MAX` (exactly 2000 still edited), null for an unknown object; the draft's coordinates win; `nodesOp` — one `modify` of every ring with the hole flag and the existing angle, null when it rounds to the coordinates already there; an added object's `add` rewritten; `ringRule` 2 open, 3 closed; `nodeSnapIndex` without the edited object (its vertex no candidate, a neighbour's is). `mapNodesBinding`: exclusive; a node per vertex over every ring (`data-ring`, `data-index`, `data-focused`), a grip per handle, none without rings; a node drag past 3 px drafts its ring and writes once, focused, the placed point returned; snapping moves the node and its handles onto the candidate; a grip drag by the offset, mirrored, Alt live breaks it, never snapped; node before grip over every ring, a press off them, on the edge, by touch or with a write in flight not taken; a click focuses, Alt-click toggles with one write (an open end nothing), a grip click nothing; a cancelled drag writes nothing; a click within reach of the edge drops the focus without a hit-test, elsewhere it selects as `V`; a double-click on the nearest ring's edge inserts smooth (Alt a corner), focused, nothing on a node, off the path or with a write in flight; under `withTrackLayer` the tracks stay below |
| unit (web) | `lib/editor/__tests__/{url,state,field,write-client}.test.ts` | §13 "Entering it": `mode=map` round-trips and is always written; entering Map mode keeps the course and drops the tool, phantom and selections; `mode=map` on a phone opens Field; `applyPatchChange` / `setPatchEnabled` send the hash and no token, return the reply, propagate a refusal, refuse without a `mapPatch` client |
| integration | `packages/api/src/__tests__/integration/course-presence.test.ts` "takes Map mode" | §13 "Presence": a heartbeat with `mode: "map"` lists as `map` |
| E2E | `e2e/map-mode.spec.ts` (`chromium`) | §13, on the seed's `itest` with `test.ocd` pinned, every op removed before, after and in `finally`. "the fourth mode": entered from Course mode after the map loaded → `data-mode="map"`, `mode=map` in the URL, the rail `V` (pressed) and `N` (no `editor-tool-K`), *Map object* empty; `K` and a click on a control select no control (none selected back in Course mode); `H` → `editor-hide-overprint` pressed, no `editor-site`, no `course-site`, no description sheet; again → back; `F` after a zoom fits (≤ 2× the fitted zoom). "select, hide, undo, move…": at `?mode=map` with `H`, zoomed to ≥ 16 px/mm, a lone black line found on the canvas and checked with `mapObjectsAt` (the only point or line within 0.5 mm); a click → `editor-map-object` `data-ref="source:<n>"`, the symbol named, `data-selected-objects="1"`; Tab then Shift+Tab back; Delete → one `applyChange`, `data-hidden`, the `hide:<n>` row, the line gone, `mapPatch.get` holds exactly that op; Ctrl+Z → no rows, the line back; Ctrl+Shift+Z → hidden; *Restore* → back (4 writes); a drag 0.8 mm across → one `modify`, the canvas's `data-patch-version` = the reply's, ink at the new place and none at the old; *Apply corrections* off → `editor-map-disabled`, the row kept, the line at its old place, *Hide* disabled; on → moved again, no `applyChange` for the toggle; Escape deselects; a reload keeps `data-mode="map"`, the `modify:<n>` row and the drawn version; the row's locate selects the object, *Revert* empties the list and the stored ops. "nodes (N)…" (G7, §13 "Nodes"): the same line selected, `N` → `editor-tool-N` pressed, `V` not, `editor-map-nodes-hint`, two nodes or more; the node nearest the line's dark pixel dragged 0.8 mm to an inkless spot → the line's ink within 1 mm of it along its edges (505 is dashed, so the vertex itself may sit in a gap) from the draft before any write (live), then one `applyChange`, the `modify:<n>` row, `data-patch-version` = the reply's, `mapPatch.get` that op alone, the node within 0.1 mm of the drop and focused; Ctrl+Z → no rows, the node back; a double-click on the middle of a straight edge of 1.5 mm or more (no grip on either side) → one write, one node more, the new one (index after the edge's first) focused at the click, the object still selected; Delete → one write, the count back, `data-hidden="false"`; Ctrl+Z → the inserted node back, Ctrl+Z → no ops (6 writes in all); Escape → `V` pressed, no `editor-map-node`, the line still selected |
| unit (web) | `pages/editor/__tests__/map-symbols.test.ts` (fixture `map-fixture.ts`) | §13 "Drawing", "Symbol picker", "Ops" (G9): `symbolPut` — a document symbol as it is (out of range refused), a library entry materialised with `putSymbols` the same JSON as `materialiseSymbol`'s, a key the patch holds not put again, `missing-colours` with the missing palette ids and `unknown-entry` refused; `symbolKey` / `refOfSymbolKey` round trip; `addOp` (angle only when not 0) and `addChange` parsed, merged and applied with no issue, its inverse removing the add only; `newAddId` a lowercase UUIDv7 the schema takes, ordered by time; `kindOfType`; `angleOfDrag` (0.1°, counter-clockwise from +x, normalised) and, symbolised, the glyph's x axis along the drag; `isOrientable` / `isOrientableRef` (document, library and patch symbols); `resymbolChange` — a document object's resymbol, back to its own symbol drops it, the same symbol writes nothing, a library symbol with its `putSymbols`, an added object's add rewritten; `angleChange` — a document point's modify with its coordinates, back to its own shape and angle drops it, a moved point keeps its move, an added point's add rewritten with 0 omitted; `tenthsOf` (comma, normalised, not a number); `objectInfo` of a drawn object: the patch key, the library preview swatch, the angle |
| unit (web) | `pages/editor/__tests__/map-palette.test.ts`, `map-draw.test.ts`, `map-draw-bindings.test.ts`; `polygon.test.ts` "Map mode's line and area kinds"; `map-bindings.test.ts` "Map mode's keys" | §13 "Symbol picker": `paletteView` keeps one kind and drops empty headings and groups, searches the headings' text trimmed and case-insensitive; a document item's swatch and a disabled library item's missing colour; a library item keeps its key when it becomes a patch symbol; Swedish names. §13 "Drawing": `drawOp` — a point rounded to units with its angle, a line's Bézier pairs and no close (round trip through `ringsOfCoords`), an area closed with its first point repeated, each applied with no issue; nothing below the minimum. `mapPointBinding`: exclusive with a crosshair, a click places a snapped point at 0, nothing while it cannot place, no press for a symbol that does not turn, a press-drag past 3 px aims from the press and places turned (the direction line shown), a press released without movement places at 0, a cancelled aim places nothing, under `withTrackLayer`. `mapDrawBinding`: a line ends by double-click, an area closes on its first node, a closing gesture held back (the drawing kept) while a write cannot go. `map_line` / `map_area`: open from 2, closed from 3, curves; smooth by default. Keys `P` `L` `A` and Enter, `T` (G27); `S K M X C G` none; the rail `V N P L A T` |
| integration | `packages/api/src/__tests__/integration/print-patch.test.ts` "Map mode's drawing in print (G9)" | §13 "Drawing", "Symbol picker" in print (the row's page raster; user 2026-11-15, G9 question 2: as course objects', the raster probe is integration's — poppler is not on the E2E runners): `maps.pdf` rasterised (`pdftocairo`) before and after each op, every changed pixel inside the object's 8 mm box: a path `add` with a document line symbol; a point `add` with a library point materialised on first use (`putSymbols`, stored as put); a `resymbol` of a document point to that patch symbol; G26: a converted GPS track — a line `add` with the ski-O `ISSkiOM2019:801.1` materialised on first use — inside its box (§13 "GPS tracks: convert") |
| E2E | `e2e/map-mode.spec.ts` "Map mode drawing" (`chromium`) | §13 "Drawing", "Symbol picker" (G9), with no patch row before and after (`dropEventPatch`: patch symbols are never removed by a change) and an all-controls sheet for `maps.pdf`. "L draws a path…": `L` pressed, the picker `data-kind="line"` with `editor-map-palette-pick`; a document path item (505–507, else the first document line) chosen → `aria-pressed`, the hint; two clicks and a double-click on plain map → one `applyChange` with an `add` of type 2 and `{ doc }`, no `putSymbols`; `V` pressed, the new object selected (`added:<id>`), its `add` row, ink at the middle node, more strokes in `maps.pdf`; Ctrl+Z → no rows, plain map again. "P places a point…": a library point (204, else the first library point) → the first click's change has `{ patch: key }` and `putSymbols` of that key, ink at the spot, `P` still pressed and nothing selected, the item now `data-source="patch"` and still pressed; a second click puts no symbol; two add rows; the stored patch holds that one symbol; `maps.pdf` changed; Escape → `V`. "P with a turning symbol…": a 519 (or 110) item; a press-drag 2 mm up the paper shows `editor-map-point-direction` and writes an add with `angle` 900; once drawn, a click in `V` selects it, `editor-map-object-rotation` shows 90, 45 + Enter rewrites the add with 450. "Change symbol…": the lone black line selected, *Change symbol* → `aria-expanded`, only line items, its own pressed; another document line → one `resymbol` of `{ doc }`, the picker closed, the row; `maps.pdf`'s drawing (its streams without the dates) changed, and back as before after *Revert* |
| unit (web) | `pages/editor/__tests__/map-unresolved.test.ts`, `map-promote.test.ts`; `map-model.test.ts`, `lib/__tests__/undo-stack.test.ts` (G12b parts) | §13 "Unresolved": attach kind (object / symbol), the palette's kind, the locate centre (anchor; an add's box in its unit; none), labels, rows in key order; the inverse of a drop, of its undo and of an attach (onto a free id, onto a held one); `changes` for unresolved-only changes. "Promote": offered for a club pin only, the block order, queued / running, the label (name and date, 200 characters, blank), each refusal's key; `UndoStack.remove` from both branches |
| unit (web) | `pages/editor/__tests__/map-shape-ops.test.ts`; `map-bindings.test.ts` "Map mode's Join pick" | §13 "Line and area operations" (G10): `reverseCoords` — the points reversed, `corner` / `dash` / `gap` on their node, `noLeft` / `noRight` moved to the segment's other end and swapped (the suppressed border intervals and the drawn gaps, measured with `render.PathMeasure` / `gapIntervals`, the mirror of the original's), a curve's controls swapping roles with their own bits, twice the identity, an unpaired gap balanced first, a loop's start kept, each part of a two-part line in its place; `splitCoords` — an interior node in both parts with a gap across it drawn in both, a curve's controls with their segment, an end node and out of range nothing, a loop opened as one rotated path; `joinCoords` — the four end pairings (the survivor's direction kept), merged at exactly 0.5 mm and bridged just over and at any distance, the merged node's flags and cancelling gap pair, a bridge's gaps and cleared border bits, a curve at the joined end; `closeCoords` — merge from 4 nodes, a segment back from 3, fewer refused; the changes — *Reverse* one `modify` / an added line's `add` rewritten, *Split* the first part's op and a new `add` with the effective symbol (after a `resymbol`), a loop one `modify`, *Join* the `modify` and a `hide` (a picked document line) or the picked `add` removed, an added survivor's `add` rewritten, closing a loop, the refusals (`kind`, `encoding`, `multi-part`, `closed`, `not-line`, `no-node`, `end-node`, `too-many` over `MAP_NODES_MAX`), *Cut hole* the ring appended with its first point flagged `hole` and repeated, the rest kept, a ring outside accepted, *Remove hole* the ring dropped and later holes keeping their flag, `no-hole-node`; each change applied with no `applyPatch` issue and its `inverseChange` restoring the patch (a document object with and without a prior `modify`, an added one). `mapPickBinding`: exclusive with a crosshair, a click's hit stack to `onPick`, an older answer dropped, no press, under `withTrackLayer` |
| E2E | `e2e/map-mode.spec.ts` "Map mode line and area operations" (`chromium`) | §13 "Line and area operations" (G10), with no patch row before and after, on lines and areas the test draws on plain map with a document symbol. "Reverse and Split…": a 3-node line drawn with `L` (Enter ends it), no *Cut hole* on it; *Reverse* → one `applyChange`, the `add` rewritten with its anchors reversed, one row; Ctrl+Z → the stored coordinates as drawn; *Split* `data-reason="no-node"` and disabled; `N`, an end node clicked → `end-node`; the middle node clicked (focused) → enabled; *Split* → one change of two `add`s (the same id, then a new id of type 2 with the same symbol), the first part's last anchor the second's first, the anchors all kept, two rows, the line still selected; Ctrl+Z → one row, the coordinates as drawn. "Join…": two 2-node lines 2 mm apart around a plain spot, the second (the survivor) selected; *Join* → `aria-pressed`, `editor-map-join-hint`; Escape → not pressed, still selected; *Join* again and a click on the first line → one change putting the survivor's `add` with 4 anchors and removing `add:<picked>`, not pressed, one row, the survivor selected, ink at the spot between the ends; Ctrl+Z → two rows, the spot plain. "Cut hole…": a triangle drawn with `A`, no *Remove hole*; *Cut hole* → pressed, `editor-map-hole-hint`; a ring of three clicks inside closed on its first → one change, the area's `add` with exactly one `hole`-flagged coordinate, not pressed, still selected, one row; *Remove hole* `no-hole-node`; `N` → three nodes of ring 1; one clicked → enabled; *Remove hole* → one change without a `hole` flag, no ring-1 node, no *Remove hole*; Ctrl+Z → the ring's nodes back; *Apply corrections* off → *Cut hole* and *Remove hole* disabled, on → enabled |
| E2E | `e2e/map-mode.spec.ts` "Map mode promote" (`chromium`) | §13 "Promote" (G12b; 08 §7), reseeded before and after and the series removed: no `editor-map-promote` on the seed's upload; `test.ocd` added to the club library and taken (`course.useClubMap`); `promoteStatus` routed to a running job: `editor-map-promoting` `data-state="running"`, the button `data-block="running"`, *Apply corrections* and `P` `L` `A` disabled; unrouted, the button disabled `nothing`; a lone line hidden and a path drawn in the UI; the dialog's label holds the event's name; one `mapPatch.promote`; `editor-map-promote-done`, a new `documentHash` and `clubMapVersionId`, no ops, the count 0, the line still gone and the path drawn on the baked document; Ctrl+Z writes nothing; `clubMap.list` version 2 (label, one layer, two corrections, `fileName` `test.ocd`); the card's version, label and note; *Delete version 2* → version 1, the event keeps its document with no version, no promote offered |
| E2E | `e2e/map-patch-resolve.spec.ts` (`chromium`) | §13 "Unresolved" (G11, G12b's undo, locate and symbol attach: the full list in `map-patches.md` "Tests"): on the seed's `itest`, two hides through the API, then the map replaced by `e2e/test.xmap` (upload route, `course.applyUploadedMap`); at `?mode=map` `editor-corrections-unresolved` `data-count="2"` with two `editor-correction-unresolved` rows (`data-key` the patch's keys, `data-op="hide"`, `data-reason="target"`), `editor-corrections-count` 0, `editor-correction-attach` disabled with nothing selected; *Drop* → one `mapPatch.applyChange`, one row left, still one after a reload; `H`, `F`, a click selecting a `source:<n>` object, *Attach* → one `mapPatch.attachUnresolved`, the block gone, the `hide:<n>` row, `data-hidden="true"`, `mapPatch.get` holds exactly that op; reseeded before and after |
| unit (web) | `pages/editor/__tests__/map-tracks-model.test.ts` | §13 "GPS tracks" (`docs/map-gps-tracks.md` §5.1): the disabled reason (venue, permission, georeference, in that order; an unknown role is no venue); an import plan — one track per segment in file order, names cut to 200 and file names to 255, points verbatim, `not-gpx` / `malformed` / `no-points` per file with the rest kept, skipped points / segments / waypoints, a track over 200 000 points refused by name, calls of ≤ 200 tracks and ≤ 500 000 points in order; the trimmed projection (length in ground metres, outside count, box) and `not-projectable` as the row's error; rows in list order with state, override, label, visible points; the colour stable and from the palette; locate's 5 % padding and 10 mm minimum; overrides parsed defensively and pruned; a deleted track's re-import (an average with its passes and ranges); the `TRACK_*` code. G26: a converted track hidden by default and shown with *Show converted*, the override winning both ways; an override kept only where it differs from the default; *Show converted*'s own key; the selection kept to listed `ready` rows in list order |
| unit (web) | `pages/editor/__tests__/map-tracks-convert.test.ts` | §13 "GPS tracks: convert" (`docs/map-gps-tracks.md` §6): the fixture L → one `add` (type 2, its three corners rounded, no flags or angle) at 100 and 1000 units per mm; equal to `drawOp` for the same vertices; ends pinned under smoothing (4, 10, 30 m); fewer nodes with smoothing and a larger tolerance; deterministic, the input not mutated; rounded duplicates dropped and a one-coordinate track no op; outside points converted; a conversion's ops in order, marks `add:<id>`, the previous marks for the undo, node counts, a degenerate track skipped; the change with `putSymbols` on first use only, applying over the fixture without an issue; add ids ascending; the defaults (10 m, 0.1 mm, no symbol), clamping and defensive parsing; the node count's total, largest and warning only above 2000 on one track; the symbol remembered by library entry (found as a matched document symbol elsewhere, not when disabled), on its own document the very item picked (not a sibling matched to the same entry), an unmatched document symbol on its own document only, a point or area never; the picker's ski-O group and track headings first |
| unit (web) | `pages/editor/__tests__/map-tracks-decimate.test.ts` | §13 "GPS tracks": the tolerance — half a pixel at the finer end of the octave, the default with no zoom; every point within it, ends kept, a straight line to two points, deterministic; over the 50 000-point budget the tolerance doubles until the tracks fit (and half of it would not); one 2 px path per line with its colour, `editor-gps-track` and `data-track-id` |
| unit (web) | `pages/editor/__tests__/map-bindings.test.ts` (`withTrackLayer`) | the tracks below the tool's own shapes; `exclusive`, `hoverPoint` and the press's answer kept; the zoom reported from hover (not a leave), press and click, each chained; a tool without a press handler gets none |
| unit (web) | `lib/editor/__tests__/write-client.test.ts` (track writes) | `importTracks`, `updateTrack`, `removeTracks`, `markTracksConverted`, `splitTrack` (G27, with the part ids) pass their input through and return the reply; a `TRACK_*` refusal propagates; without a `mapTrack` client they refuse |
| unit (web) | `pages/editor/__tests__/map-tracks-edit.test.ts`, `map-tracks-tool.test.ts`, `map-tracks-average.test.ts`; the G27 cases of `map-tracks-model.test.ts`, `map-tracks-decimate.test.ts`, `map-tracks-convert.test.ts` | §13 "GPS tracks: editing" (`docs/map-gps-tracks.md` §5.2 and §7 have the detail): handle ↔ stored-point index, the handles' bounds, a drag along the points (outward restoring, an out-and-back keeping its leg), the split index, the track under a click, the ranges under a trim, a split's undo; the Tracks tool's reducer (press on a handle, threshold, live trim, one write on release, nothing at the same point or cancelled, click to split / select) and `mapTracksBinding`; the averaging worker's handler, copies, client and import item; an average's passes hidden by default and listed with their marks; dashed single-pass runs; a conversion marking an average's sources once each |
| unit (web) | `lib/editor/__tests__/snap.test.ts` (G28 cases), `pages/editor/__tests__/map-tracks-snap.test.ts`; the G28 cases of `map-tracks-convert.test.ts`, `map-shape-ops.test.ts` | §13 "GPS tracks: junctions" (`docs/map-gps-tracks.md` §6.7 and §7 have the detail): `nearestOnLines` (reach inclusive, the filter, hidden and skipped objects, curves, the effective document); short, overshoot, end to end, nothing in reach, the symbol filter, both ends, flags; a batch in list order; *Snap ends* stored on by default; `snapEndsChange` one op, its inverse, `no-target`, `closed`, `multi-part` |
| E2E | `e2e/map-gps-tracks.spec.ts` (`chromium`) | §13 "GPS tracks", on the seed's `itest` with `test.ocd` pinned, every track removed before and in `finally`. The fixture `e2e/fixtures/gps-tracks.gpx` (synthetic, from `test.ocd`'s frame by `packages/api/scripts/generate-test-gpx.ts`, which also writes the expected paper mm `gps-tracks.json`) and a KML named `.gpx` through `editor-tracks-file` → one `mapTrack.import`, `data-imported="2"`, one error `not-gpx` for the KML; two rows in file order, `ready`, points, length within 0.2 m, outside 0 / 2 with the mark on the second, a date on the timed one and a dash on the other; two paths, the stroke the swatch's colour, the L's ends and corner among the drawn vertices within 0.01 mm, the outside track's far end (past the map) drawn; a row click → the view centred on the track's box within 0.5 mm and the path's page box on the projected ends and corner within 3 px; the second track trimmed to 3 points and marked converted through the API, hidden after the reload (3 points, the *converted* mark; G26), *Show converted* draws it and its eye still hides and shows it; hide → no path, kept after a reload, show → back; rename → `mapTrack.update`, the name, Ctrl+Z and Ctrl+Shift+Z each one `update`; delete → `mapTrack.remove`, the list without it; Ctrl+Z → re-imported under its id with its trim and converted mark, drawn; a drop of a GPX on `editor-tracks-drop` (`data-drag-over` while over it) → one import, a third row; a reload keeps the three rows, the name and the paths, and `mapTrack.list` holds exactly them. "convert the fixture track into a ski-O track line" (G26, `maps.pdf` from an all-controls sheet, the patch row dropped before and after): *Convert to line* disabled until the row is selected; the panel on `V`, a line picker with `ISSkiOM2019` first, nothing pressed, *Convert* disabled, the defaults 10 m / 0.1 mm, a node count, no warning; smoothing 0 → 3 nodes; picking 801.1 → the canvas at the legs' middles changes (the preview) with no write; *Convert* → one `applyChange` with one `add` (type 2, `{ patch: "ISSkiOM2019:801.1" }`, coordinates `[-1500, 1000]`, `[-1500, -1000]`, `[1500, -1000]`) and the symbol in `putSymbols`, then `markConverted`; the row converted, hidden, unselected, its path gone, a correction row, `mapTrack.list` marked; the canvas changed and `maps.pdf` with more strokes; *Show converted* on and off; Ctrl+Z → one `markConverted`, no corrections, the row unconverted and shown, the canvas and the stroke count as before; Ctrl+Shift+Z → marked again; a second conversion of the converted track → a new add without `putSymbols`, the mark moved to it, its undo moving it back; the tolerance set to 0.3 and the panel cancelled, a reload → 0.3, smoothing 0 and 801.1 pressed; Escape closes it without a write; arming `L` closes it; a refused `markConverted` (aborted) → the line written, `editor-error` shown, the mark unchanged, and Ctrl+Z still removes the line and writes the mark from before. "snap" (G28, the patch row dropped before and after): two `ISSkiOM2019:801.1` lines put through `mapPatch.applyChange` (the symbol materialised by `e2e/helpers/patch-symbol-cli.ts`), T1 upright at x = 16 mm and T2 ending at (−15.6, 10.8); the fixture converted at smoothing 0 with *Snap ends* checked → `editor-tracks-convert-snapped` `data-count="2"`, 3 nodes, one `add` `[-1560, 1080]`, `[-1500, -1000]`, `[1600, -1000]` (end to end and extended), no `remove`, T1 and T2 unchanged in `mapPatch.get`; Ctrl+Z, then off → `[-1500, 1000]`, `[-1500, -1000]`, `[1500, -1000]`; the line selected on the map (Tab through its stack), `editor-map-object-snap-ends` → one `applyChange` with the snapped coordinates, then `data-reason="no-target"`, Ctrl+Z → the recorded ends back, T1 and T2 unchanged; a reload → the checkbox still off. G27, on `e2e/fixtures/gps-passes.gpx` (two synthetic passes 3 m apart, the second covering half and recorded the other way round; the generator writes the expected average): "trim" — `T` by its key with no selection → `data-state="pick"`, no handle; a click on pass A selects it, handles at 0 and 40; the end handle dragged to point 30 → one `mapTrack.update`, 31 points, the grey rest, the path ending at point 30, the stored trim; Ctrl+Z / Ctrl+Shift+Z one `update` each; dragged back out → 41 points, no grey rest; (zoomed out clear of the inspector) the start handle to point 5 → trim `[5, 41)`; a reload keeps it; Escape → `V`, no handles. "split" — a click at point 15 → one `mapTrack.split` (16 and 26 points, ids ascending), the original's row gone, the selection cleared; a click selects the right part, a click at point 25 splits it (11 and 16); the middle deleted; its neighbours' paths end at points 15 and 25; three Ctrl+Z → three imports, the original back under its id at the end of the list with 41 points; Ctrl+Shift+Z → the same split under the same ids. "average" — *Average* disabled under two selected, one `mapTrack.import`: `derivedFrom` both passes, `sourceName` `""`, the point count and single-pass range within one of the generator's, the range to the end; the average selected, the passes hidden and marked, one solid path on the centre line (within 0.03 mm) and one dashed on pass A alone; the eye shows a pass; converting the average → one `markConverted` with its op for it and both passes, all three marked; Ctrl+Z → one `markConverted` restoring null for all three; Ctrl+Z → the average removed, the passes shown; Ctrl+Shift+Z → imported again under its id. "off on a venue node": `lease.status` answered as `venue` → `editor-tracks-disabled` `data-reason="venue"`, no import button or file input, *Corrections* still there, and no `mapTrack.` request |
| E2E | `e2e/editor-url.spec.ts` (`chromium`) | §1 "URL" (F31): from the Courses page, a pick → `?course=`; Class view → `view=class&class=`, Course view drops them; Layout → `mode=layout&sheet=<the course's sheet>`; a reload restores the course, Layout and the sheet, then Class view; Field + All controls → `mode=field&view=all`; `history.length` unchanged by every change and one Back lands on `/courses`; `mode=bogus&view=nope` → Course mode, Course view, only `course=` left; a class not the course's → Course view, `view` / `class` gone; `mode=layout&sheet=99999` → Layout, the sheet gone; a deleted course → no course, `course` gone; `mode=layout&template=<seq>` → template scope, kept over a reload, and *New extra template* there opens the new template and writes `template=<new>` (it stays open: the review's create-then-open case); the Courses page's pencil lands on its course (`course=` only), the Controls page's on its control with `control=` gone; on a Pixel 7 viewport no `mode` → Field and `mode=field`, Course → `mode=course` kept over a reload, `mode=layout&sheet=1` → Field and `mode=field` |
| E2E | `e2e/editor-space.spec.ts` (`chromium`) | §2 "The editor fills the window" (F28): at 1840 × 1090 `editor-page` is at least the viewport less 64 px wide, its bottom within 16 px of the viewport's and not below it, the page has no vertical scroll (`scrollHeight` ≤ `innerHeight`), the header's inner row (`shell-header-inner`) is as wide; on `/courses` `shell-container` and `shell-header-inner` stay ≤ 1280 px |
| unit (web) | `lib/__tests__/course-overlay-ids.test.ts` | §6.1 (P5): the overlay ids of a start-only course (the regression) and a finish-only one; a full course with explicit ends; the explicit ends win over the nearest; the legacy fallback to the start nearest the first control and the finish nearest the last; no controls and no explicit end → the event default (lowest id); a stale id or one of the wrong role treated as none; none under `firstAsStart` / `lastAsFinish`; no start or finish in the event; an end already at the head or tail not repeated; an unpositioned first control keeps the explicit start, else the default |
| E2E | `e2e/course-editor-placing.spec.ts` "P5: the pending leg from a just-placed start" (`chromium`) | §6.1 (P5): on a fresh course the armed `K`'s hover draws a `course-leg` piece from the default start (the inspector's start row) to the cursor; `S` places a start (`course.setStructure`), the start row names it and `K` is pressed; the hover shows `editor-leg-length` "‹n› m" and a `course-leg` piece from the new start's rim to the cursor's; the click adds the control row, and after `Esc` (no label) the leg start → control is still drawn |
| E2E | `e2e/field-mode.spec.ts` (`mobile` project: Pixel 7, `vector`) | §10: opens in Field mode, full-bleed, compact bar and overflow, no rail / inspector / `editor-stats`, the sheet's status line (`editor-status`, `editor-save-state` `saved`) (P2), ≥ 44 px targets; §9: `setGeolocation` → the marker with its accuracy, every row's distance and bearing = the paper geometry at one scale; detents (tap, handle drag to full) and a list row's control centred above the sheet; a quick drag on an unselected control pans without selecting, a long press selects, shows the stem and the loupe (`editor-loupe`, 120 px, above the handle; the canvas inside it differs from the same circle after release — the 1× map — and has the map's purple; gone on release) and drops the control 48 px above the finger (persisted); two fingers cancel a pending press and zoom; nudge 2 × 0.1 mm, 1 m, the x field, four undos back; `+` → `K` → Place above the sheet adds a site, Done; F27: the overflow's `editor-placement-loupe` (pressed dot) on → `localStorage` `true`, no loupe without a tool; `+` → `K` → `editor-loupe` `data-pointer="touch"`, `data-mode="hover"`, 120 px, its bottom 16 px above `editor-touch-crosshair`'s centre and centred on it (±1 px), its `data-x` / `data-y` within 3 mm of the crosshair's paper point (snapped); the overflow → off → none, the same circle at 1× differs in > 10 % of its pixels; on again → the loupe, *Done* → none; a tap on an `oob_area`'s outline (created through `courseObject.create`) selects it, a tap inside deselects it (D12), and two fingers on its corners scale it by their spread, the map's zoom unchanged; check-off persists over a reload; offline (D9c, `context.setOffline`): the notice at `data-pending` 0 and `+` disabled, two nudges → one entry drawn at once, a check-off → two and `editor-save-state` `queued`, an undo drops the check entry, no `control.update` / `control.check` request until reconnect, then the notice gone, the server at the nudged position (one `control.update`) and after a reload; after the undo a second check-off → two again, and on reconnect `control.update` then `control.check` in that order with the check-off kept; a long-press move offline with notes written elsewhere replays with no notice and keeps both; a queued nudge the server refuses (`page.route` answering a tRPC `FORBIDDEN`) → `data-failed` 1, `editor-field-queue-failed` with the reason, `editor-save-state` `error`, the position still shown and the server unchanged, Retry unrouted → sent; a nudge offline with a move elsewhere → `editor-conflict` `moved` with their x, the entry still counted, Keep mine → the server at the page's position; a `control.update` aborted at the network (`page.route`, exact procedure) queues while online, the entry and its position survive a reload, unrouted it is sent by the retry timer. "Field mode on a desktop" (desktop viewport in the same spec): the mode switch, no rail, the list's distance after a fix, check-off and `Ctrl+Z`, back to Course mode; F10: the setter-map picker (*None* + two after `layout.setterMaps { groups: 2 }`), Setter 1 picked → its controls in the sheet's order and the KPI, *None* → the course's list |
| unit (web) | `lib/editor/__tests__/setter-maps.test.ts` "a setter's Field rows" | §9 (F10): the sheet's order, start / finish as such, other kinds as controls, unknown ids left out, distance / bearing / checked through `fieldRows` |
| unit, integration, E2E | `course-layout.md` "Tests" | Layout mode |
| unit (web) | `pages/editor/__tests__/placement.test.ts` "X: the map exchange tool", `rail.test.ts` "railKeyOf", `lib/editor/__tests__/sequence.test.ts` "part headings" | §6.9: `X` armed, numbered and advanced as a control, `K` ↔ `X` keep the chain, not a chain end; the rail lights `X`; the exchange row marked, part 1 before the first row and part 2 after the exchange, none without one |
| E2E | `e2e/course-editor-status.spec.ts` "F5: map exchange" | §6.9: `X` after a selected control → the ghost `2 · code`, the chain stays armed, three rows with the exchange second and two part headings, the exchange labelled 2, the on-map 13.5 row; Export ▾ this course → two pages, two own sheets with different windows; Layout mode → part 2's sheet (`data-section` 1) deleted → `EXCHANGE_WITHOUT_SHEET` with *Part 2* |
| unit (web) | `lib/editor/__tests__/structure-edit.test.ts` "variation groups (F7)" | §12: the displayed path's sequence; a position after a group at the top level (the off-by-group regression); the group's legs insert into it (into, out of, an empty active alternative), the leg into the anchor top-level; ↑ / ↓ keep a row's level; a loop's anchor visit takes no ✕, move or leg, its legs belong to the alternatives, B active first; `removeSite` in every alternative, an all-empty group kept, an unanchored one dissolved; the item after a group keeps its leg, an alternative's first item's leg dropped when its predecessor changes; `setLegProps` by path; `setNumberHidden` in alternatives; `createGroup` / `canCreateGroup` (top-level legs only, `v1`, `v2`); add / remove (two left: dissolve) / rename (blank, taken) / loop; `moveToAlternative` |
| unit (web) | `lib/editor/__tests__/sequence.test.ts` "variation groups (F7)", `state.test.ts` "variations (F7)" | §12: rows' paths in the explicit structure and their group, a loop's anchor-visit row, the leg's path, `courseViewOrders`, `variationBlocks` after the anchor, `alternativeEndAt`; the reducer's Variant view (needs a key), All variations, the active alternative (to Course view, claims `K`, Escape drops the claim before the course), a course change resets them; F8 "in Class view and Layout mode a key picks the variant drawn": the key alone changes (view, class and mode kept), null = the first, another class resets it, Variant view kept into Layout mode |
| unit (web) | `lib/editor/__tests__/variation-view.test.ts`, `checks.test.ts` "structure with a group", `pages/editor/__tests__/action-bar.test.ts` "Create variation here" | §12: `courseDrawOf` (legs by drawn neighbours, the crossing as a string, hidden numbers), `allVariationDraws` (F15: the spine carries the shared numbers when the variants number alike, never otherwise, the override carries them; spine with a none leg, a branch per alternative, the shared exit leg, a loop's petals), `withCourseOverride`; the checks' displayed path and `checkGroupsOf`; *Create variation here* after *Add bend here*, only when the page says so |
| E2E | `e2e/course-editor.spec.ts` "F7: variations and loops" (`chromium`), "F7 on a phone" (`mobile`) | §12: a leg → *Create variation here* → one block with tabs A (pressed) and B, `course.variantList` `A`, `B`; tab B, `K` with nothing selected → the control is B's row; Variant ▾ B numbers it 2, A numbers the anchor's next 2; All variations → the two alternatives' legs in different tints (canvas pixels); `VARIATION_UNBALANCED` listed and locating the anchor; *Loop* → `AB`, `BA`; F8: Export ▾ *This course (2 variants)* → two pages, *All variations* → one, *One map per runner* disabled; Layout mode's Variant ▾ shows AB, no *All variations*, BA picked keeps the mode and *This variant BA* prints one page; three undos → loop, the control, the group gone; F15 (a second test): a control into B and one into A → All variations labels both 2, the anchor 1 and the exit 3; a second control into B → codes again. On a phone a group written over tRPC shows its block with `editor-variation-readonly`, ＋ and *Loop* disabled, and tab B switches the rows |

## Pending in this chapter

- **Attached objects in the viewer and kiosk** (§7 "Attached objects",
  J10): they follow a moved control there too (the layer resolves), but
  `courseObject.list` is cached until reload in the viewer (`course-layer.md`
  §8.3), so a removed control's object shows detached only after a
  reload. During a control drag the UI-layer outline of a selected
  attached object follows only when the drag lands (the layer's derivation
  reports then).
- **The clipboard** (§7 "Duplicate, copy, cut, paste", J12): one
  object, keys only (no context-menu or phone item); sizes are copied as
  paper mm verbatim across maps of different scales (no rescale); the
  system clipboard is not used, so nothing pastes between
  browsers. The paste point is the pointer's last place on the map: after
  a fit or a view request without a mouse move it may be off screen. To
  keep it the select tool has a hover callback, so the viewer resolves a
  hover target on each mouse move (not measured; a point-only callback
  would be cheaper).
- **Undo across a removed control** (§7 "Attached objects", J10): the
  wire shows an object of a removed control without `attach`, so a
  delete of that object, or an *Attach* / *Centre* on it, records an
  undo without the old attachment; undoing those and then the control's
  delete leaves it free. An undo that names a control deleted since
  (or whose first code changed, so its public id did) is refused
  (`BAD_REQUEST`) and said like any failed undo.

- **The top bar past tier 2** (§2 "Top bar", F29): below 1220 px of row
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

- **Map mode beyond G12b** (§13): Promote is not offered on a venue box, and its queued / running state
  is driven in the E2E only through a routed `promoteStatus` (a real job
  on the fixture ends inside the hold; "Promote"). Multi-select (Shift-click, lasso) and the
  right-click menu of 08 §5.3's Map column are not built; a single
  selection only. Map mode has no touch gestures (desktop only, 08 §5.5)
  and no phone entry.
- **Nodes beyond G7** (§13 "Nodes"): objects over 2000 nodes take no node
  editing until the UI layer is culled to the view (the viewer's `onView`,
  as the GPS tracks' Pending); one focused node at a time (no multi-node
  selection); the document's corner / dash / gap / border flags are kept,
  not edited (a split curve's new half carries none); Map
  mode's snapping toggle is its own and the status bar does not show it;
  the snap index without the edited object is built on the main thread per
  selection, its Club-full cost unmeasured; a dragged node does not snap
  to the object's own nodes (closing a line is *Join* on itself, G10).
- **GPS tracks beyond G28** (§13 "GPS tracks"): the end snap gives the
  target no node at the junction, leaves curved end segments alone and
  checks an overshoot's tail at its nodes (`docs/map-gps-tracks.md` §8);
  Bézier fitting of a converted line (polylines for
  now); trim and split at stored points only, *Average* without a cancel
  or progress, a split's parts without the original's eye override
  (`docs/map-gps-tracks.md` §8). The layer's
  decimation follows the zoom only when the pointer reports it (hover,
  press, click), so a wheel or button zoom with the pointer still keeps the
  old octave until it moves, and the layer is not culled to the view: the
  viewer reports no view change to the page (user 2026-11-15, G25
  question 1; a viewer `onView` prop is the follow-up once `MapViewer.tsx`
  is free). Tracks are not hit targets except to the Tracks tool `T`, so
  outside `T` a track is selected only from its row.
- **Map mode's second decode** (§13): the model decodes the pinned
  document on the main thread once per hash, beside the snap and pick
  indices' own decode and the worker's; a shared main-thread copy is a
  follow-up. Its Club-full cost, and the draft's (G5's Pending), are
  unmeasured.
- **A patch symbol's swatch** (§13 "Inspector", "Symbol picker"): it is
  the library's preview of the entry its key names, in the library's
  colours and at the library's size — not the materialised symbol as the
  document's stack and factor draw it; the server has no preview route for
  patch symbols.
- **Drawing beyond G9** (§13 "Drawing"): no text objects (slice G); the
  placement loupe (F27) is not offered by `P`; a point's rotation is set
  by its press-drag or the inspector, not by a handle on the map; an area
  pattern's rotation is not edited; the chosen symbol per kind is kept
  only while the page is open; the drawing tools have no touch flow (Map
  mode is desktop only). Two quick points: a point placed while the
  previous one's reply is not yet drawn replaces its draft, so the
  previous point can vanish for a frame until the canvas draws it.
- **Line and area operations beyond G10** (§13 "Line and area
  operations"): a loop cannot be cut in two — a split at a node of a loop
  only moves its start, since a line whose ends meet reads as a loop
  (answer 4 as written; decided overnight); split is at an existing node
  only (no split at a point between nodes); split and join refuse
  multi-part lines and broken curve encodings; a join over 2000 nodes is
  refused, and so is a hole that would take an area over them. Reverting
  only one of a join's two ops (answer 8) draws the old line under the
  joined one, and reverting only a split's new `add` leaves the first part
  short — every op reverts on its own; undo takes both back. The merged
  node of a join takes the selection's corner / dash and drops the picked
  end's. No keys, no rail tools, no multi-select join (answer 7), no touch.
- **Course selection highlight**: the course editor's selection and
  multi-selection rings and object outlines stay UI layer (D5 left 04 §7's
  highlight because it was `map-gl` work outside its area). G5 built the
  highlight for **document objects** (`map-rendering.md` §5.5 "Document
  objects": the edit part, `MapViewerEditorProps.mapObjects`), which Map
  mode (§13, G6) uses; course objects do not go through it.
- **Course objects**: draw order (`courseObject.reorder`) has no control
  in the editor; `inset_frame` is slice F's. **Images** (J7): no entry in
  the phone's `+` menu (the picker is desktop chrome; the `I` key works
  with a keyboard); no one-finger image drag on touch. **Transform
  handles on touch** (J11): the knob, the corners and crop mode answer
  the mouse only (user answer 5); a finger pans or selects as before, and
  crop mode is not offered on a coarse pointer.
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
- **Field mode's outbox, what D9c left** (§9 "Offline"):
  - queued writes are sent only while that event's editor is open (no
    drain from the shell or a service worker);
  - a code renumbered elsewhere while a write waits can address another
    control (the entry keys on the public id); it surfaces as `moved` or
    a failed entry;
  - a queued check-off's `checked_at` is the replay time, not the tap's
    (`control.check` takes no client time);
  - only Field mode's moves and check-offs queue: `+`, the site fields,
    notes and every other mode's writes still need a connection;
  - "Moved by ‹name›" on replay is not asserted by name in E2E (the E2E
    other side writes through the API as the admin);
  - an entry whose request never gets a tRPC answer (an HTML 502 / 503,
    a login page in front of the API) stays pending and is retried every
    10 s with no cap; Discard is offered only for failed entries;
  - the outbox is keyed by event, not by user: on a shared device one
    user's waiting writes are sent under the next user's session (a
    refusal still lands as failed);
  - an undo merged into a move while that move is on the wire goes out
    as a pure move back with `autoDescribe`, not as the description
    restore: a control that had no description can keep the one
    auto-filled for the undone position (online the undo restores it);
  - a first write of a control without stored coordinates is queued
    plain and loses `autoDescribe` when a move merges into it;
  - another mode's move of a waiting control (through the outbox) has
    no test of its own;
  - the overlay's base is the cache as found when the page mounts: a
    remount offline with overlaid rows in the persisted cache shows a
    dropped entry's queued value until the next refetch (the undo stack
    is gone after a remount, so only Discard / Keep theirs drop one).
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
