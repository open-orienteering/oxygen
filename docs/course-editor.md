# Course Editor

The course editor is an interactive, map-based editing surface for
controls and courses. It builds on the Phase 1 backend work documented in
[control-descriptions-and-editor-geometry.md](control-descriptions-and-editor-geometry.md):
`control.create` / `control.update` accept paper-mm positions and derive
WGS84 server-side, and moving a control rebuilds straight-leg `editor`
geometry for every course that visits it.

Route: `/:nameId/course-editor` (shell overflow menu → "Course Editor").
Deep links: `?course=<seq>` pre-selects a course, `?control=<code>`
pre-selects a control — the pencil icons in the Actions column of the
Courses and Controls pages link here with those params.

## What it does

The editor is **tool-less**: every map click resolves to a selection —
an existing control, or a *phantom* point (dashed blue ring) on empty
map or on a course leg — and a small floating menu next to it offers the
actions that apply there. There is no mode to switch first.

### Contextual actions

| Click | Selection marker | Menu offers |
|-------|------------------|-------------|
| Empty map | Phantom ring at the point | **Add control** (`control.create`, code from the club control-series allocation, falling back to smallest unused ≥ 31), **Add start** and **Add finish** (code-less `control.create` with status 4/5, auto-named "Start N" / "Mål N"); with a course selected also **Add to \<course\>** (create + append, one undo entry) |
| An existing control | Dashed selection ring, toolbar readout (code + mm position) | **Add to \<course\>** (append via `course.update { controlIds }`; hidden for start/finish — they are implicit), **Remove from \<course\>**, **Radio** / **Radio off**, **Edit description** and **Delete control**. A selected start/finish that is not the one the selected course uses offers **Use as start/finish for \<course\>**. An info line above the actions reads *"Also in: …"* when the control is used by other courses |
| A course leg (course selected) | Phantom ring on the leg | **Insert into course** — creates a control and inserts it into the sequence at that leg |

Other gestures and keys:

| Gesture | Effect |
|---------|--------|
| Drag a control | Local render during the drag; one `control.update { xpos, ypos }` on release. If the control is used by other courses, an amber chip follows the drag: *"Affects: Lång, Kort"* — the move rebuilds those courses' geometry too |
| `Delete` / `Backspace` | Deletes the selected control (with confirmation). The server cascades it out of every course sequence and rebuilds their geometry — no ghost rows (see [bugfix-control-delete-course-cascade.md](bugfix-control-delete-course-cascade.md)); the undo entry restores the control **and** its course memberships |
| `Escape` | Dismisses the phantom, then the control selection, then deselects the course — and only with nothing left to dismiss exits fullscreen. In fullscreen, MapPanel holds a [Keyboard Lock](https://developer.mozilla.org/en-US/docs/Web/API/Keyboard/lock) on `Escape` (Chromium) so a short press reaches this cascade instead of the browser instantly dropping out of fullscreen; holding Esc still exits (browser-enforced) |
| `H` | Toggles **Hide other controls** (needs a selected course, same as the toolbar button) |
| `Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`) | Undo / redo, up to 50 entries |

### Course building

All course building happens in a floating panel *inside* the map box
(see "In-map course panel" below) — there is no page sidebar.

| Action | Effect |
|--------|--------|
| Panel: name + **Create** | `course.create`; the name field suggests event classes that have no course and whose names are not already used by a course. An exact case-insensitive match links the new course to that class in the same transaction. The new course is selected for editing (not undoable — there is no `course.restore`) |
| Panel: **Clone** | Opens an inline name field, then `course.clone` copies the sequence, start/finish assignment and course settings into a newly selected course. Class assignments are not copied |
| Panel: click a course | Selects it — its sequence panel opens; on the map the course's controls stay full-strength purple with 1, 2, 3… numbering while every other control **fades** to ~30 % opacity (Purple Pen style, still clickable) |
| Panel: ↑ / ↓ / ✕ per row | Reorder within, or remove from, the sequence |
| Toolbar: **Hide other controls** | Escalates the fade to fully hidden (start/finish stay) — MapPanel's `filterMode="course"` |

The panel shows the display sequence the server's geometry builder
uses — event start, course controls, event finish — with per-leg terrain
meters computed client-side (`sequenceLegMeters`: straight-line paper mm
× map scale / 1000, mirroring `course-geometry.ts`) and the total +
control count in the footer.

The **Inventory** card is a separate collapsible panel below the course
panel (`editor-inventory-panel`). It groups the club's active control
allocation by series, shows free/total counts and borrowed/SRR badges, and
marks every code already used anywhere in the event (including secondary
codes). An **Assign codes from** selector (`editor-alloc-series`) overrides
the allocation source: *Automatic (priority order)* walks the club's series
priority as before, while picking a specific series allocates that series'
free codes first (falling back to priority order once it is exhausted).
The active series is highlighted in the list and named in the collapsed
header. When **Radio** is enabled on a non-SRR code, the editor offers an
inline swap to the first free SRR unit. Declining keeps the original code;
an empty allocation enables radio directly, and an exhausted allocation
enables it with a non-blocking notice.

`firstAsStart` and `lastAsFinish` are legacy-only settings. The editor and
Courses page no longer offer write controls for them. Existing migrated
courses retain the flags, geometry/export continue honoring them, and the
Courses list shows a read-only legacy badge.

While the editor is open the map never auto-pans: `MapPanel` skips its
focus-on-selection behaviour in editor mode, because every sequence edit
changes the highlighted course's control set and would otherwise refit
the viewport mid-edit. The initial view fits **all positioned controls
with a margin** (`MapPanel`'s `fitToControls` — the same behaviour as
the Courses/Controls map panes), so a map with wide empty borders opens
zoomed to where the action is; container resizes (e.g. fullscreen)
refit the same bounds. The control-descriptions overlay is on by
default (`defaultShowDescriptions`) — toggleable from the map toolbar
as usual. Gesture help lives in an i-circle popover on that toolbar
(same pattern as the start-draw settings), not a page heading — the
shell tab already names the page. With **no course selected** the sheet lists every positioned
control instead of nothing (`descriptionsAllControls`, titled with the
localized "All controls" via MapViewer's `allControlsTitle` prop — the
viewer itself stays i18n-free), so descriptions are usable while
placing controls, before any course exists.

### In-map course panel

Fullscreen promotes MapPanel's root div, so anything outside the map
box disappears while editing there. The whole course UI therefore lives
in a floating panel at the map's top-left
(`data-testid="editor-map-course-selector"`): the create-course row,
the course list (rows `editor-course-item`, each with control count and
length, the selected one highlighted, scrolling at `40vh` so a big
screen shows more courses), and — with a course selected — the full
display sequence (`editor-sequence`) with per-leg meters and ↑/↓/✕
buttons, the count + total-length footer, and a clone footer (button →
inline name field). The panel grows with its content up to the map's
full height; the header row collapses everything down to the selected
course's name. The series inventory lives in its own card stacked below
(see above), so reference data never interleaves with course editing.

Mechanically it is a generic `mapOverlay?: React.ReactNode` slot on
`MapPanelPublicProps`: MapPanel wraps the viewer in a `relative`
container and renders the node in a full-height, `pointer-events-none`
strip down the left edge (`z-[8]`, below the context menus at 9), so a
long sequence scrolls inside the panel instead of overflowing the map
and clicks pass through everywhere the panel isn't.

### Control descriptions

**Edit description** on a selected control opens a modal IOF
description editor (`components/ControlDescriptionEditor.tsx`): symbol
grids per sheet column — C (which of similar, 11 symbols), D (control
feature, 73 symbols grouped landforms → special items), F (combination,
3) and G (flag location, 8 feature parts × 8 directions + 6
non-directional) — plus a free-text dimensions field (column E) and a
live preview row. Saving issues `control.update { description }`
(`null` when everything is cleared), which is undoable like any other
edit. Descriptions live on the control row (see
`control-descriptions-and-editor-geometry.md`), so they follow the
control across courses.

The stored encoding is OCAD course-setting text codes; the SVG symbols
are keyed by IOF number. `lib/control-description-options.ts` pairs
every pickable symbol with a canonical OCAD code chosen so the
untouched converters in `iof-symbols.ts` map it straight back — the
round-trip is asserted for all 157 options in
`lib/__tests__/control-description-options.test.ts`. Symbol tooltips
come from `iof-symbol-meta.ts` (generated by
`scripts/generate-iof-symbol-meta.mjs` from the svg-control-descriptions
package, which carries Purple Pen's symbol names) with complete English
and Swedish coverage; the few IOF 2018 symbols Purple Pen lacks Swedish
for are patched in the generator. Fields the user does not touch keep
whatever encoding the OCD importer stored — several OCAD codes can mean
the same symbol, and both render identically.

### Description autodetect

When a placed control has **no description yet** — which is every
freshly placed one, and the reducer auto-selects those — the context
menu grows a *Suggested description* block: what the base map says the
control sits on, one click to apply. The applied description is a
normal undoable `control.update { description }`, so `Ctrl+Z` takes it
back off. A **drag re-opens the question**: the just-moved control gets
suggestions even when it already has a description (the old one
described the old spot); applying one, or saving via the modal editor,
settles it again (`lastMovedId` in `CourseEditorPage`).

The pipeline:

```
control.suggestDescription { x, y }        (paper mm, eventProcedure)
  → loadEventMapObjects(db, eventId)      event-map-objects.ts (cache)
  → suggestDescriptions(objects, x, y)    description-autodetect.ts (pure)
  → [{ d, g?, isom, distanceMm }] ≤ 3
```

- **`event-map-objects.ts`** — the tile pipeline discards the parsed
  `OcadFile` after rasterising, so this module keeps its own cache,
  modelled on `event-crs.ts`: per event, invalidated when a newer
  `map_files.uploaded_at` appears. It stores only what search needs
  (`sym`, `objType`, coordinates, bbox) and only for symbols the mapping
  table knows, which drops contours, course overprint and text — the
  bulk of a real map.
- **`@oxygen/shared`'s `isom-description-map.ts`** — ISOM 2017-2 symbol
  number → `{ d, kind, g? }`, keyed by `Math.floor(sym / 1000)` (OCAD
  encodes the symbol as `isom × 1000 + variant`, so 204000 → 204 →
  boulder → `"2.004"`). `d` values are the same canonical OCAD codes
  `control-description-options.ts` uses, and `g: true` marks features
  with a definite centre, where a side-of suggestion means something —
  "N side of the boulder" yes, "N side of the path" no. The table lives
  in `shared` so the web test
  (`lib/__tests__/isom-description-map.test.ts`) can resolve every entry
  through the real OCAD→IOF converters and the symbol library: a typo
  like `"2.04"` fails loudly instead of rendering an empty cell.
- **`description-autodetect.ts`** — bbox prefilter (expanded by the
  radius), then exact distance: euclidean for points, min
  point-to-segment for lines, 0 inside the ring for areas (ray cast) and
  distance to the boundary outside it.   Default radius 3 mm ≈ one control
  circle. Results are deduped per **column-D code** — several ISOM
  symbols share one (footpath 505 and vehicle track 504 are both
  5.002), and the user picks a description, not a map symbol — sorted
  nearest-first, capped at 3.
  Column G comes from the compass bearing feature → control, snapped to
  8 directions and emitted as `11.101`…`11.108`; paper Y points north,
  hence `atan2(dx, dy)`. Controls within 0.3 mm of the feature count as
  *on* it and get no direction.

Labels and symbol SVG are resolved by the page (`iofSymbolName`,
`IOF_SYMBOLS`) and handed to the viewer ready-made as
`editor.suggestions`, the same contract as `moveWarnings`: the viewer
knows where the menu goes, not what a boulder is called in Swedish.

**Deferred on purpose**: column C (which of several), column F
(junction / crossing), between-features, column E dimensions, text and
rectangle object types, and refined G for lines (side-of vs on-line).
Those need either information the map does not carry or guesses, and a
missing suggestion is cheaper than a wrong one.

### Automatic overprint cuts

The purple overprint must not hide important map detail, so course
setters cut it: **circle slits** where a control circle crosses black
features (rock and man-made symbols) or knolls, and **leg gaps** where a
leg line passes over black features. Oxygen computes both automatically
— there is no manual cut UX (yet); the cuts simply follow the map.

- **When**: at every geometry rebuild (`rebuildCourseGeometry` — course
  create/update, control move/delete) and after a map upload, which
  rebuilds all `geometrySource: "editor"` courses so cuts follow the new
  map. Imported (`ocd`/`xml`) geometry keeps its file-authored cuts and
  is never touched.
- **Where**: `packages/api/src/overprint-cuts.ts`, pure and unit-tested.
  It reuses the slimmed base-map object cache built for the description
  autodetect (`event-map-objects.ts`) and stores the result *in* the
  course GeoJSON: `properties.cuts` (`{start, end}` compass degrees, the
  same convention the OCD importer writes) on control point features,
  `properties.gaps` (`{from, to}` fractions of the leg) on leg features.
  No schema change — it all rides in the existing `geometry` JSONB.
- **Which symbols**: a static ISOM-number table (`CUT_KINDS`) — rock
  (201–207, 215), black man-made (502–518, 521–532), and knolls
  (109/110, slits only — a leg over a knoll is normal). Pattern-fill
  areas (boulder fields, stony ground) are excluded: their dots are
  symbol fill, not objects, so a cut at the invisible area boundary
  would look random. Blue/green/yellow symbols never cut.
- **Geometry rules**: cuts are deliberately *tight* — the overprint
  stroke is 0.35 mm wide and a compact ISOM point symbol ~0.5 mm across,
  so clearing much more than the feature itself just fragments the
  circle without revealing more map. Point features cut the rim (or the
  leg, centered on the projection) when they sit within **0.45 mm** of
  it, opening **±0.4 mm** of ink — about 18° of rim, 0.8 mm of leg. Line
  features cut **±0.35 mm** at each rim/leg crossing, wider for oblique
  leg crossings (`half-width / sin θ`, capped at 1.2 mm). Solid black
  areas (buildings, canopies, ruins, gigantic boulders) cut the whole
  stretch of rim/leg *inside* them (rim sampled every 4°, leg via
  entry/exit intersection parameters). Overlapping cuts merge; slivers
  (< 4° / < 0.6 mm) drop; sanity caps keep a circle whole when > 300°
  would vanish and never erase more than 70 % of a leg. Legs also keep
  3 mm (1.2 × circle radius) at each end — the viewer clips that zone
  around circles anyway.
- **Rendering**: circle `cuts` were already consumed by the viewer's
  `drawBrokenCircle` (OCD-imported slits used the same path). Leg `gaps`
  are new: `subtractLegGaps` in `MapViewer.tsx` splits the screen-space
  polyline into kept sub-polylines (fractions survive the projection —
  a leg is locally linear) before the usual circle clipping; gapped
  segments carry `data-leg-gapped="true"` for tests.

Placement and dragging work in **map millimetres** (the `xpos`/`ypos`
paper coordinate space) — the viewer converts screen pixels via an
affine transform. When `course.mapMetadata` carries **calibration
points** (three mm↔WGS84 corner pairs derived from the OCAD file's CRS
at upload, persisted on `map_files`), those are preferred; otherwise the
transform falls back to positioned control coordinates as before. The
calibration path is what makes the editor fully usable on a virgin
event: upload a map, click anywhere, place the first start/control
before any other coordinate data exists.

## Architecture

Three layers, each deliberately small:

```
CourseEditorPage (pages/CourseEditorPage.tsx)
  │  owns: selection + phantom (useReducer over lib/course-editor.ts),
  │        contextual action list, in-map course panel (course list +
  │        sequence, via MapPanel's mapOverlay slot), undo stack, tRPC
  │        mutations, keyboard shortcuts, toolbar UI, deep-link
  │        consumption
  ▼  editor: MapViewerEditorProps (memoized)
MapPanel (components/MapPanel.tsx)
  │  data wiring — forwards the `editor` prop, disables auto-focus in
  │  editor mode
  ▼
MapViewer (components/MapViewer.tsx)
     owns: gesture recognition (click vs drag threshold), local drag
     rendering, selection ring + phantom ring, context-menu rendering,
     hit targets, sequence numbering, red course-membership colouring
```

- **`lib/course-editor.ts`** — a pure reducer (`selectedControlId`,
  `selectedCourseId`, `phantom {x, y, insertAt}`) plus
  `nextFreeControlCode()`, `nextSeriesControlCode()` (optional preferred
  series, then club inventory priority, then the ≥ 31 gap-fill
  fallback), inventory grouping and SRR
  selection helpers, `sequenceLegMeters()` and
  `courseMembership()` (control id → names of the courses using it,
  driving the "Also in" info line and the drag warning chip).
  Unit-tested in `lib/__tests__/course-editor.test.ts`.
- **`lib/undo-stack.ts`** — a bounded stack of `{ undo, redo }` closure
  pairs. The page pushes an entry after every successful mutation: move
  → `control.update` with the prior position, sequence change →
  `course.update` with the prior `controlIds`, delete →
  `control.restore`, create → `control.delete`/`control.restore`.
  Entries whose undo/redo throws are dropped (the error is surfaced in
  the toolbar); the rest of the stack stays usable. Unit-tested in
  `lib/__tests__/undo-stack.test.ts`.
- Mutations run through the **vanilla tRPC client** (`utils.client`)
  rather than `useMutation` hooks, so each handler can await the
  round-trip, push its inverse pair, and share one pending/error state.
  Rapid sequence edits are serialized by the UI (each append waits for
  the refetch before the next click lands); there is no client-side
  op-queue.
- **`MapViewerEditorProps`** (exported from `MapViewer.tsx`) — the
  contract: `selectedControlId`, `phantom`, `contextActions`,
  `contextInfo`, `suggestions` + `suggestionsHeading` (base-map
  description rows), `courseControlIds` + `fadeNonCourse` (fading),
  `moveWarnings` (pre-formatted drag chips — the page owns i18n, the
  viewer owns positioning), `onMapClick`, `onMoveEnd`, `onSelect`,
  `onLegClick`. Editing is enabled iff the prop is set, so every other
  MapPanel call site is untouched. Callbacks must be stabilized by the
  caller — the object flows through MapPanel's shallow-equality `memo`.
- The page renders its **own inline MapPanel** (`fillContainer` inside a
  fixed-height container) instead of driving the shared wide-screen
  shell pane via `MapSlot`. Editing gestures stay scoped to the page and
  never leak into the persistent panel other pages configure.

### Context menu rendering

The menu entries come from the page (`EditorContextAction[]` — id,
label, click handler, optional danger variant, plus
`EditorDescriptionSuggestion[]` for the autodetect rows), but the viewer
renders them: it is the only layer that knows the map transform. The menu
is plain HTML (`data-testid="editor-context-menu"`, buttons
`editor-action-<id>`, suggestion rows `editor-suggestion-<isom>` inside
`editor-suggestions`) positioned next to the anchor — the selected
control's symbol or the phantom point — via the mm→pixel affine plus
`innerToContainer`, which undoes the north-offset CSS rotation the
overlay SVG lives under, so the menu text always stays upright. It is
hidden while a drag is in flight and when the anchor scrolls out of
view. `mousedown` on the menu is stopped so it never starts a pan or an
empty-map click.

### Drag without snap-back

A drag renders locally (no network) while the pointer is down. On
release the viewer fires `onMoveEnd` **once** and remembers the drop as
a `{from, to}` entry in a `pendingMoves` map: as long as the `controls`
prop still reports the position the drag started from (`from`), the
control renders at `to`. Without this the control would snap back to
its stale position for the duration of the round-trip.

Bridges are deleted as soon as the refetched data reports `to` (or the
control disappeared), and the page bumps `editor.moveEpoch` on every
undo/redo, which clears all bridges at once. Both matter: an undone
move puts the data back at exactly `from`, which a live bridge would
misread as "stale — keep showing `to`", making undo look like a no-op
(see [bugfix-course-editor-undo-snapback.md](bugfix-course-editor-undo-snapback.md)).

No optimistic React Query cache write is done for moves on purpose: the
overlay renders from `lat`/`lng`, which only the server can derive (it
needs the map file's CRS), so a client-side cache patch of `mapX`/`mapY`
alone would place the circle wrong.

### Hit targets

The visible control symbols are stroke-only (`fill="none"`), so their
clickable area is just the outline. In editor mode the viewer adds an
invisible **filled** circle per control (`data-testid="editor-control-hit"`,
`data-control-code`) on top of all other overlay elements — the whole
symbol interior becomes grabbable, and E2E tests get a stable selector.
Similarly, every drawn leg of a highlighted course gets an invisible fat
hit-line (`data-testid="editor-leg-hit"`, 12 px stroke) that fires
`onLegClick(courseName, legIndex, pt)`. The page wires it only while a
course is selected; the click anchors a phantom carrying the insert
position — nothing is created until the user picks **Insert into
course** from the menu.

### Insert-on-leg index mapping

Leg *i* of the rendered route connects positioned display-sequence rows
*i* → *i+1* (start and finish legs included, unpositioned controls
skipped — the same rules as the server's geometry builder). The page
inserts the new control before the row the leg ends at, or appends when
the leg ends at the finish. For courses that visit the same control
twice the first occurrence wins — acceptable until butterfly courses
become a real use case.

### Sequence numbering and fading on the map

`MapViewer` already numbers controls 1, 2, 3… in description mode when
exactly one course is highlighted; editor mode reuses the same path
(`sequenceNumbering = (showDescriptions || editor) && single highlight`),
so the on-map labels always match the panel's sequence rows while
editing.
While a course is selected (`editor.fadeNonCourse`), regular controls
not in `editor.courseControlIds` render at 30 % opacity — circle, code
label and leader line — while course members and start/finish stay at
full strength. Everything remains overprint purple (no recolouring);
the contrast alone marks the edited course, and faded controls keep
their hit targets so "click → Add to course" still works on them.

## Testing

- **Unit**: `packages/web/src/lib/__tests__/course-editor.test.ts` —
  reducer transitions (selection, phantom anchoring via map-click and
  leg-click, course selection clearing the phantom, escape cascade,
  delete-clears-selection),   `nextFreeControlCode` (gap filling,
  multi-code controls, ≥ 31 floor), `nextSeriesControlCode` (priority
  order, used-code skip, duplicate-code series, exhaustion fallback,
  SRR passthrough), `courseMembership` (ordering,
  dedup for repeat visits, unused controls absent) and
  `sequenceLegMeters` (unit conversion, unpositioned-control bridging,
  no-scale fallback).
  `lib/__tests__/undo-stack.test.ts` — undo/redo ordering, redo-branch
  clearing, cap eviction, failed-entry dropping.
  `lib/__tests__/isom-description-map.test.ts` — every autodetect table
  entry resolves to a real column-D symbol and renders; the eight
  side-of codes resolve to column-G symbols.
  `packages/api/src/__tests__/description-autodetect.test.ts` — ranking
  over synthetic objects: nearest-first, radius cutoff, point/line/area
  distance, area containment, per-column-D-code dedupe, all eight
  bearings, unmapped symbols ignored.
  `packages/api/src/__tests__/overprint-cuts.test.ts` — automatic cuts
  over synthetic objects: rim slits for boulders/knolls (not for a
  feature under the circle centre), both crossings of a line, buried
  rim stretches inside a building, wrap-around slits, non-black symbols
  ignored, leg gaps for points / oblique line crossings / building
  interiors, end-zone preservation, merging and both sanity caps, and
  the geometry decorator (start/finish untouched, stale cuts removed).
- **E2E**: `e2e/course-editor.spec.ts` — imports `test.ocd` for
  coordinates + map, then: place a control via the contextual **Add
  control** action, read the suggested code from the toolbar, drag it to
  another verified-empty spot, assert the stored mm position changes,
  reload and re-select to   prove persistence, delete it via the
  contextual **Delete**; build a course (append two existing controls
  via their context menus — asserting the non-course fading appears —
  plus create-and-append on empty map), reorder it, undo/redo, reload to
  prove persistence, remove a control, insert-on-leg via the contextual
  **Insert into course**, and cross-course awareness (a control shared
  with a second course shows "Also in: …" in the menu and the
  affects-chip during drag); the delete cascade (deleting an in-course
  control drops its sequence row, undo restores control + membership,
  and **Remove from course** takes a control out without deleting it);
  the `H` shortcut and the Escape cascade in fullscreen (deselect first,
  exit fullscreen only once the cascade is empty);
  deep-link from the Courses and Controls
  pages' pencil icons; the description sheet listing all controls
  (titled "All controls") until a course is selected; the in-map course
  panel (containment in the fullscreen root, selecting through it,
  collapsing list + sequence); the toolbar i-popover for the
  gesture hint (no extra page heading); the base-map
  suggestion (place a control in mapped terrain, apply the first
  suggestion, confirm a column-D symbol is set, `Ctrl+Z` clears it);
  the automatic overprint cuts (the fixture plants a boulder on control
  79's rim and one on the 79→80 midpoint — building a course through
  them must render a slit circle and a `data-leg-gapped` leg); and
  the Escape cascade (phantom → selection). The spec calls `reseed()` in `beforeAll` since
  it mutates seed data, and every test runs `ensureCoursesAndMap`
  (idempotent import) because a failed test restarts the Playwright
  worker, which re-runs the reseed.
- The server-side halves (position storage, WGS84 derivation, geometry
  rebuild, the delete cascade out of course sequences) are covered by
  the integration tests in
  `packages/api/src/__tests__/integration/control-editor.test.ts`;
  `integration/description-autodetect.test.ts` covers
  `control.suggestDescription` end-to-end against the OCD fixture's
  boulder and building (see
  [e2e-test-ocd-fixture.md](e2e-test-ocd-fixture.md));
  `integration/overprint-cuts.test.ts` proves the cuts land in the
  stored geometry (rim slit over the fixture boulder, leg gap through
  the building), recompute when a control moves away, and that a map
  upload rebuilds editor-course geometry with fresh cuts.

Printing goes through
[iof-coursedata-export.md](iof-coursedata-export.md): the Courses page
exports the whole course set as IOF 3.0 CourseData XML for Condes /
Purple Pen / OCAD.
