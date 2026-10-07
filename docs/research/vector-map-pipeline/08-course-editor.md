# 08 — Course editor: domain model, editing experience, roadmap

Status: proposed 2026-10-07 (recommendation §11); awaiting decision.
Depends on: [02](02-document-format.md) (`(documentHash, objectIndex)`
references, patch-layer constraints §10), [03](03-symbol-model.md) (7xx
overprint symbols as library entries, materialised source symbols for
drawing), [04](04-render-core.md) (dynamic bucket, hit-testing, filter
regions, course overprint as objects, UI layers), [05](05-print-pdf.md)
(page = layers; what a sheet *is* when it reaches the PDF backend),
[06](06-import-pipeline.md) / [07](07-storage-delivery.md) (club map
versions, re-resolution of object references, event-scoped tables).
Feeds: 09 (which of today's editor surfaces are replaced in which order;
`courses.geometry` retirement).

## The question

Topics 01–07 built the substrate: a vector document, a symbol model, one
renderer for screen and print, a storage model. This topic decides what is
*authored on top of it* and how:

1. **Domain model** — controls, courses and their structure (sections,
   variations, loops, map exchange), course-setting objects (out-of-bounds,
   corridors, filter regions, crossings, text), the **layout** model
   (templates, sheets, class overrides) and the **light-map-editing patch
   layer**. The layout model is here, not in 05: 05 decided how a page is
   rendered; this topic decides what a page is and who owns which part
   of it.
2. **Editing experience** — a redesign of the editor rather than a port of
   today's two editors onto a GL canvas, with a stated mobile requirement:
   the editor must remain *usable* on a phone and tablet even though the
   desktop is the primary device.
3. **Roadmap** — what the first implementation ships and in which order
   the rest follows, so the data model never has to be reshaped for a
   later phase.

Out of scope: timing semantics of forked courses (`ClassCoursePool`,
`course-controls-and-matching.md` — the editor *produces* what timing
consumes), results, Eventor sync, the GPS replay viewer.

## 1. Requirements, by persona

| Persona | Device | Needs |
|---------|--------|-------|
| Course setter, planning | Desktop, large screen | Place and move controls on the vector map at any zoom; build courses and their variations; see lengths, climb, control count and rule violations live; descriptions from the map with manual override; out-of-bounds, corridors, crossings, whiteouts; print-true preview (what is purple on screen is purple on paper); undo everything; keyboard-driven for speed |
| Course setter, in the field | Phone, one hand, sunlight, gloves | Open the event, see the map and own position (GPS), check a control site, **move a control a few metres**, edit its description, mark a control as checked, print nothing; no accidental edits while panning |
| Controller / adviser | Tablet or phone | Review courses read-only, leave notes on controls, approve |
| Organiser printing | Desktop | Templates per paper/scale, assign classes, class-level scale overrides, export PDFs per class/course/variant, all-controls map, setter maps, control-description sheets by participant counts, print profiles (05) |
| Timing (`course-controls-and-matching.md`) | Server | Concrete course rows per variant with ordered controls and codes; map exchange and loops expressed as matchable sequences; `ClassCoursePool` per leg/stage |
| Export | Server | IOF XML 3.0 CourseData per concrete variant (today's export), OCAD course file later |
| Light map editor (future) | Desktop | Hide or correct a base-map object, add a path/boulder/fence/whiteout with a real symbol, visible in every course and in print; promote the correction to the club map version (06 §6) |
| Kiosk / stations | Any | Render the course overprint for a readout without the editor (today: `courses.geometry` GeoJSON) |

Hard constraints inherited: paper millimetres are the model
(`course-maps.md`); times, codes and sequences are in the results closure
and journaled (`offline-architecture.md` "Reference data during a lease");
everything user-facing in `en` and `sv`.

## 2. Current state, and what to keep

Two editors, three overprint implementations:

- **Course editor** (`docs/course-editor.md`): tool-less — every click is
  a selection (control, phantom point, leg) with a contextual menu; in-map
  floating course panel; drag with local render and one mutation on
  release; bounded undo stack of closure pairs; IOF description editor
  with map-based autodetect; automatic overprint cuts; club control
  inventory; `H` / Escape cascade; mobile gestures (two-finger map, tap
  select, `touch-action: none` hit targets). Draws the overlay as React
  SVG in screen space (`MapViewer.tsx`).
- **Layout editor** (`docs/course-maps.md`): tool-armed (choose a tool,
  click to create); paper is the canvas; `map_templates` (paper,
  orientation, print scale, margin, frame, description block, shared
  objects) and `course_maps` (one sheet: template + window centre +
  overrides + per-sheet objects); object kinds text / line / path /
  rectangle / image with fill modes none / solid / whiteout /
  whiteout-outside / 709 hatch and `anchor: page | map`; club templates
  (map-anchored objects stripped on import); validation codes; autosave;
  shared `packages/shared/src/course-maps/` overlay helpers used by print.
- **Domain tables**: `controls` (site: codes, status start/finish, xpos/
  ypos mm, lat/lng, description, radio), `courses` (name, length, climb,
  `legs`, `finish_control_id`, `geometry` GeoJSON + `geometry_source`,
  `description_instructions`), `course_controls` (position, label
  offset), `classes.course_id`, `class_course_pools (class, stage,
  course)` for forking, `map_templates`, `course_maps`, `graphics`.
  "Future forking contract" in `course-maps.md`: forks authored on a root
  course, concrete variants materialised as child course rows,
  `course_maps.course_id` references the root.

**Keep** (they are right and tested): contextual, tool-less selection as
the default interaction; one mutation per gesture with undo pairs; the
description editor and autodetect; automatic cuts (now a symbolisation
rule of the course layer, 04 §7); the club inventory and code allocation;
`controls` as *sites* shared across courses; paper-mm positions with
server-derived WGS 84; map templates and sheets as separate things;
validation by stable codes; club templates; autosave; the gesture model
from `mobile-layout.md`.

**Change**: the two editors become modes of one canvas; the overlay is
objects in a course layer symbolised by the shared stage (no React SVG,
no second geometry path for print); the course is a *structure*, not a
flat sequence; course-setting objects get a table and a scope model;
layout templates stop being hand-created per course; a patch layer exists
for the base map; the mobile experience is designed, not adapted.

## 3. Prior art

What the established tools agree on, and where they differ, informs the
model below. Names are used for desktop tools whose behaviour is
documented publicly; web-based tools are described generically.

| Concern | Purple Pen | Condes | OCAD Course Setting | Web-based tools (generic) | Take |
|---------|-----------|--------|---------------------|---------------------------|------|
| Control identity | Control = site, shared by courses; code, description on the control | Same | Same (control objects) | Same | Keep Oxygen's model |
| Course structure | Linear + **variations** (fork) and **loops** (butterfly), lettered A/B…; variants exported as separate IOF courses in a family | Forking by "course variations" with relay allocation | Variations with map exchange | Variation groups on a leg or after a control; variations cannot nest or overlap; cannot cross a map exchange | Variation groups between two anchors; no nesting; materialised variants |
| Map exchange | "Map exchange" control; one course, several map parts | Same | Same | Parts = separate sheets, new start symbol placeable before/after the exchange | Sections → sheets |
| Leg styling | Normal, marked route, no line; per-leg gaps | Same + bend points | Same | Same + mandatory crossing point / section inserted on a leg; corridor per leg | All of these as leg properties |
| Areas | OOB (709/708/711), whiteout | Same | Any 7xx symbol | OOB with border variants; whiteout; **map simplification area** (show only chosen symbols inside); toner-saver area derived from the course | Course-setting object kinds; filter regions from 04 |
| Layout | Print area per course; "all controls" map | Print window + description position | OCAD layout objects | **Templates auto-created per (scale, paper, orientation)**; class may override course scale; all-controls and setter maps with automatic A4 layout | Auto templates with explicit extras |
| Descriptions | Full IOF editor; punch cards | Same | Same | Same + print sheets by participant count | Keep editor; add sheet printing |
| Analytics | Length, climb (manual) | Length, climb | Length, climb | Climb from contours, route-choice/difficulty estimates | Length + rule checks now; climb from contours when the document carries contour interval; difficulty out of scope |
| Mobile | None | None | None | Separate "field mode": view, setter map, GPS; editing on desktop | Field mode as a first-class mobile surface, editing kept possible |
| Map editing | None | None | Full mapping program | Light editing of objects in place (select, nodes, symbol change) | Patch layer, roadmap phase 3 |

## 4. Domain model

### 4.1 Layers of an event's map

```
 base map document (02)            immutable, by hash
   + patch layer (4.7)             event-scoped ops on that hash
   = effective base map            what the shared stage symbolises first
 course layer (derived)            7xx objects from structure + sites + objects
 course-setting objects (4.5)      stored purple/white objects with a scope
 page layer (4.6)                  template + sheet + page objects (05 "page")
```

The **course layer is derived, never stored**: controls, lines, numbers,
gaps, cuts, corridors, variation labels are computed by a pure function
`courseLayer(structure, sites, objects, appearance, viewOptions)` in
`@oxygen/shared/course` that outputs objects with library symbols
(`ISOM2017-2:701…`, 04 §7). Screen, print and the kiosk call the same
function. `courses.geometry` becomes a compatibility artifact produced by
the same function for consumers not yet ported (09).

### 4.2 Controls (sites)

Unchanged in identity: a `controls` row is a *site* with codes, position
and description, shared by every course that visits it. Additions:

| Field | Type | Why |
|-------|------|-----|
| `kind` | `control` \| `start` \| `finish` \| `map_exchange` \| `crossing_point` \| `map_issue` (replaces inferring from `status` 4/5) | Map exchange and mandatory crossing are sites too; a map-issue point is a setter's note that renders only in setter views |
| `circle_gaps` | `{start, end}[]` degrees | Manual gaps in addition to the automatic cuts (`course-editor.md`); stored on the site, since the circle is the same in every course |
| `number_hidden` | per course (on `course_controls`) | Hide a number where it cannot be placed legibly |
| `notes` | text | Controller/setter notes, field mode check-off (`checked_at`, `checked_by`) |

Validation rules evaluated live and exported as codes: code < 31; codes
that can be misread upside down (66/99, 68/89, 161/191, …) when both are
in use; duplicate codes; two controls closer than 30 m (15 m at sprint
scales) per the IOF rules; same-feature controls within 60 m; control
without description; control outside every sheet of its courses.

### 4.3 Course structure

A course is a **sequence of items**, where an item is a control reference
or a *variation group*, and the sequence is split into **sections** by
map-exchange controls:

```ts
type CourseStructure = {
  version: 1;
  items: CourseItem[];                 // start … finish, in order
};
type CourseItem =
  | { kind: "control"; controlId: string; leg?: LegProps }      // leg = the leg *into* this item
  | { kind: "variation"; id: string;                            // between the previous and next item
      alternatives: { label: string; items: CourseItem[] }[];   // "A", "B", …; items are controls only
      loop?: boolean };                                         // butterfly: alternatives return to the anchor
type LegProps = {
  style?: "line" | "marked_route" | "none";                     // 705 / 707 / nothing
  gaps?: { from: number; to: number }[];                        // fractions, manual (auto cuts are derived)
  corridor?: { widthM: number; edge: boolean; whiteMm: number; whiteOpacity: number };
  crossing?: { controlId: string; section?: boolean };          // mandatory crossing point / section on this leg
  bends?: { x: number; y: number }[];                           // paper mm, for marked routes around obstacles
};
```

Rules, enforced by the Zod schema and the editor: variation groups do not
nest or overlap; a group's alternatives contain only controls; a group
cannot span a map exchange; `loop` groups share both anchors and generate
the permutations of alternative order. Micro insets (a sub-course at
another scale inserted after an item) are *not* in version 1 of the
structure; the item union leaves room (`kind: "inset"`), roadmap §8.

**Materialisation.** Concrete variants are the cartesian product of
alternatives (loops: permutations), each written as a child `courses`
row with `parent_course_id`, `variant_key` (`"AC"`, `"BA"` for loops),
a flat `course_controls` sequence, and the derived length. The root
course keeps `structure` and a `course_controls` sequence equal to the
"all first alternatives" path so legacy consumers still see a course.
Timing and `ClassCoursePool` consume child rows exactly as today
("Future forking contract"); the IOF export emits one `<Course>` per
variant with the root's name as the family. Materialisation is a server
function run inside the same transaction as the structure write and is
journaled through the existing `course.upserted` entries (one per
affected row) — the structure is in the results closure.

Relay allocation (which team member runs which variant) stays where it
is: `ClassCoursePool(stage, course)` pools plus the timing-side
assignment. The editor's job ends at producing the pool.

**Lengths and climb.** Length = straight legs (today's
`sequenceLegMeters`) with marked routes along their bends; corridors do
not change length. Climb is computed from contour crossings (101/102
objects of the document) along the leg when the document declares a
contour interval (OMAP has it; OCAD does not — the import asks, 06
report); otherwise manual, as today.

### 4.4 Classes

`classes.course_id` stays. Additions: `print_scale` override (a class may
print the shared course at another scale), `sheet_template_id` override.
Class views in the editor show the course as that class prints it.

### 4.5 Course-setting objects

Stored purple/white objects with a **scope**, drawn in the course layer's
colour stack position (lower/upper purple, 03) and clipped to the sheet's
map frame in print:

```sql
CREATE TABLE oxygen.course_objects (
  id          UUID PRIMARY KEY DEFAULT uuidv7(),
  event_id    BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  seq         INT NOT NULL,
  kind        TEXT NOT NULL,          -- see table
  geometry    JSONB NOT NULL,         -- paper mm, y-up, same vertex/Bézier shape as layout paths
  props       JSONB NOT NULL DEFAULT '{}',
  scope       JSONB NOT NULL,         -- { all: true } | { courses: [uuid], classes: [uuid] }
  z           INT NOT NULL DEFAULT 0,
  created_at, updated_at
);
```

| Kind | Symbol / rendering | Props |
|------|--------------------|-------|
| `oob_area` | 709 cross-hatch, border 708 solid / dashed / none | cross spacing, border style |
| `oob_line` | 708 / 711 (route) | width, dashed |
| `whiteout` | white fill above the map, below purple | opacity |
| `filter_region` | 04 §7: `clip` or `hide` mode over a symbol set | `{ mode, symbols: "all" \| idx[] \| { colours } , invert }` ("map simplification": show only these symbols inside) |
| `toner_saver` | whiteout *outside* a hull around the course with holes for controls — derived on demand, stored as a snapshot so the setter can edit the hull | margin, hole radius |
| `marked_route` | 707 free line not tied to a leg | — |
| `text` / `image` | map-anchored text or logo in the map window | font, size, graphic id |
| `inset_frame` | reserved for micro insets | — |

Filter regions are the editor's expression of the 04 requirement: the
polygon is edited live, the shared stage recomputes the clipped/hidden set
during the drag (fast bbox predicate, exact on release), and print gets
the same result by construction. The `toner_saver` kind is what the
existing "white-out outside" fill mode on a rectangle grows into.

Page-anchored objects (title, logos, description block, scale bar) stay
in the layout model (4.6) because they belong to the sheet, not the map.
Both share the vertex/path schema from `@oxygen/shared/course-maps`.

### 4.6 Layout model

Today a template is hand-created and assigned per course; the common case
("every A4 portrait 1:10 000 class looks the same") is repetitive and the
uncommon case (one course needs A3) is a manual fork. Proposal:

- **Templates are keyed by `(paper, orientation, printScale)`** and
  created automatically the first time a course or class needs that
  combination, named after the key. A setter edits the auto template's
  shared objects once. An **extra template** with the same key can be
  created explicitly when one course needs a different layout; it is
  assigned by drag between "courses in this template / other courses at
  this scale".
- **Sheets** (`course_maps`) stay one row per printable page: course (root)
  or all-controls or setter map; section index for map exchange (part 1,
  part 2 → two sheets, auto-created from the structure, window centres
  independent); window centre; per-sheet overrides and objects. A class
  with a `print_scale` override gets its own sheet rows keyed by class.
- **Window defaults**: the first sheet of a course fits the course with a
  margin; moving the window is "align map" as today. The all-controls
  and setter-map sheets compute scale, orientation and description
  placement to fit everything on A4 and can be recalculated; moved items
  stay fixed until recalculated.
- **Appearance** (circle radius, line width, number height at base scale,
  purple) is per event with per-template override, as today.
- **Setter maps**: controls grouped geographically into N groups (k-means
  on paper coordinates with a manual "move to next setter" click),
  one auto-laid-out A4 sheet per setter with only that setter's controls
  and 5 mm description cells, stored as `course_maps(kind='setter',
  props.controlIds)`.
- **Control-description sheets** as a separate PDF: per class/course,
  quantity by participant count or fill-the-sheet, cell size, gap —
  a 05 page with only description blocks.
- **Print profiles** (05) attach to the event with a per-template
  override.

The boundary with 05: 05 renders `{ mapLayer, pageLayer, marksLayer }`
for one page; this topic's `resolveSheet(sheet, template, class?,
courseVariant?)` produces that input. Everything in `resolve-layout.ts`
today moves behind that function.

### 4.7 Light-map-editing patch layer

02 §10 left two options: a separate artifact keyed by document hash, or a
new document version per edit. Decision: **a separate, event-scoped patch
keyed by the document hash**, promoted to a document version only when
the club wants it.

```sql
CREATE TABLE oxygen.map_patches (
  id             UUID PRIMARY KEY DEFAULT uuidv7(),
  event_id       BIGINT NOT NULL REFERENCES oxygen.events(id) ON DELETE CASCADE,
  document_hash  TEXT NOT NULL REFERENCES oxygen.map_documents(hash) ON DELETE RESTRICT,
  ops            JSONB NOT NULL,       -- ordered PatchOp[]
  symbols        JSONB NOT NULL DEFAULT '[]',   -- materialised source symbols (03 §1), appended after the document's table
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, document_hash)
);
```

```ts
type PatchOp =
  | { op: "hide";   objectIndex: number; sourceIndex: number }
  | { op: "add";    id: string; symbolIdx: number; geometry: Geometry; type: ObjectType; rotation?: number; text?: string }
  | { op: "modify"; objectIndex: number; sourceIndex: number; geometry: Geometry }   // replaces geometry; symbol kept
  | { op: "resymbol"; objectIndex: number; sourceIndex: number; symbolIdx: number };
```

- Applied by the shared stage before symbolisation: hidden objects are
  skipped, modified ones use the patch geometry, added ones are appended
  with `objectIndex ≥ document.count` and `symbolIdx` into the combined
  symbol table. The renderer sees one effective document (04 §7
  "Appending objects").
- `sourceIndex` is stored with every op so a re-import of the same file
  (importer upgrade) re-resolves exactly, and a new map edition
  re-resolves by position + symbol with review flags (02 §7, 06 §6). The
  editor shows unresolved ops as a list to fix or drop.
- Why not a new document version per edit: every edit would invalidate
  the hash every course object and sheet references, defeat the client
  cache, and conflate "the club's map" with "this event's corrections".
- **Promote**: "Save corrections to the club map" runs the patch through
  06 stage 8–9 to encode a new document, creates a `club_map_versions`
  row (07) labelled from the event, and repoints the event to it with an
  empty patch. The event's references re-resolve via `sourceIndex`
  (unchanged for existing objects; added objects get their new indices
  from the encoder's mapping).
- Scope of editing tools, phase 3 (§8): select, move, node editing with
  Bézier handles, delete (= hide), draw point/line/area with a palette
  (03 §1: the document's symbols through their matches plus
  materialisable canonical ones), change symbol, join/split/reverse
  lines, holes. No symbol editing, no templates, no colour editing.

### 4.8 Persistence summary

| Table | Change |
|-------|--------|
| `controls` | `+ kind, circle_gaps, notes, checked_at, checked_by`; `status` 4/5 kept in sync for one release |
| `courses` | `+ structure JSONB, parent_course_id, variant_key, contour_climb_m`; `geometry` kept as derived artifact until 09 |
| `course_controls` | `+ number_hidden`; child variant rows written by materialisation |
| `classes` | `+ print_scale, sheet_template_id` |
| `course_objects` | new (4.5) |
| `map_templates` | `+ auto_key (paper, orientation, scale)`, `+ is_extra` |
| `course_maps` | `+ section_index, class_id, props`; `kind` gains `setter`, `descriptions` |
| `map_patches` | new (4.7) |

Journaling and the venue: `structure`, materialised variants and
`controls` fields that affect matching are in the results closure and
journal as today (`course.upserted` / `control.upserted`). `course_objects`,
`map_templates`, `course_maps`, `map_patches` are cloud-owned non-critical
data — but the kiosk map at a venue draws the course layer, so
`course_objects` and `map_patches` join the checkout snapshot alongside
the document (07 §9.2). Layout and print stay cloud-only during a lease.

## 5. Editing experience

### 5.1 Principles

1. **One editor, four modes** on one GL canvas: *Course*, *Layout*,
   *Field*, *Map* (light editing). Modes change the tool rail, the
   inspector and what is editable; the viewport, selection and undo
   history persist across them. Today's split into a course editor page
   and a layout editor dialog goes away.
2. **Contextual first, tools second.** Keep the tool-less default: click
   selects, the selection offers actions. Add a small tool rail for
   *creation* (start, control, finish, exchange, crossing, areas, text)
   with single-letter shortcuts, because "arm a tool, click twice" is
   faster than "click, menu, pick" when placing ten controls — the two
   models coexist, as Purple Pen's do.
3. **Paper is the truth.** Zoom is magnification; the print scale and the
   sheet frame are visible on demand in every mode; a number that fits on
   screen fits on paper.
4. **Everything live.** Lengths, climb, rule checks, descriptions, filter
   regions and auto cuts update during the gesture, not after the save.
5. **Every change is one undoable mutation**, autosaved; no save button.
6. **Mobile is a layout, not a port.** The same model and the same
   mutations, with a different chrome and gesture map (5.5).

### 5.2 Anatomy (desktop)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ‹ Event   [Course ▾ Lång]  [View ▾ Course]   Mode: Course │ Layout │ Field │ Map │
│                                              ↶ ↷   − 100 % +  ⤢   Export ▾  │
├──────┬───────────────────────────────────────────────────────────┬───────────┤
│ Tool │                                                           │ Inspector │
│ rail │                 GL canvas (04)                            │           │
│  V   │   base map + patch + course layer + objects + UI layer    │ Course    │
│  S   │                                                           │  sequence │
│  K   │   [selection ring + contextual action bar]                │  variants │
│  M   │                                                           │ Selection │
│  X   │                                                           │  props    │
│  A ▾ │                                                           │ Checks    │
│  T   │                                                           │           │
├──────┴───────────────────────────────────────────────────────────┴───────────┤
│ 12 controls · 5.8 km · 180 m ↑ · 2 checks ⚠   ·  1:10 000 A4 portrait  · saved │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Top bar**: course/class picker (search, create, duplicate, delete),
  view picker (Course / All controls / Class / Variant A·B·… / All
  variations), mode switch, undo/redo, zoom, fullscreen, export menu
  (this course · class · all · variants… · loops composite · all
  controls · setter maps · descriptions · IOF XML).
- **Tool rail**: `V` select/move, `S` start, `K` control, `M` finish,
  `X` map exchange, `C` crossing point, `A` areas (OOB, whiteout, filter
  region, corridor on a selected leg, toner saver), `T` text; in Layout
  mode: frame, header, text, image, description block, whiteout; in Map
  mode: select, nodes, point, line, area, symbol picker.
- **Canvas**: 04's renderer with the dynamic bucket for the thing under
  edit; selection ring, handles and the contextual action bar are UI
  layer (screen-space). The action bar replaces today's popover menu with
  the same entries (add to course, insert here, remove, radio,
  description, delete, reset number, gaps) laid out horizontally so the
  same component becomes the mobile bottom bar.
- **Inspector** (collapsible, resizable): course sequence with per-leg
  metres and drag-reorder; variation groups as nested blocks with A/B
  tabs; selection properties (control: code, kind, description summary
  with *edit*, gaps, notes, "also in"; leg: style, gaps, corridor,
  crossing; object: kind props, scope); checks list with click-to-locate;
  in Layout mode the template/sheet properties; club inventory as a
  collapsible section.
- **Status bar**: KPIs, sheet key, autosave state.

### 5.3 Interaction model

| Gesture / key | Course mode | Layout mode | Map mode |
|---------------|-------------|-------------|----------|
| Click empty | Phantom + action bar (add control/start/finish; "add to course" if a course is selected) | Deselect | Deselect |
| Click object | Select (control, leg, course object) | Select page/map object | Select map object (hit-test on symbolised shape, 04 §7) |
| Drag selected | Move control / vertex / object; live derived layer; affects-chip for shared controls | Move / resize / rotate; frame drag = align map | Move object or node |
| Shift-click / lasso | Multi-select controls (bulk: delete, add to course, set radio) | Multi-select objects | Multi-select |
| Double-click leg | Insert control here | — | Insert node |
| Right-click / long-press | Full action menu | Same | Same |
| `1–9` on a variation group | Switch displayed alternative | — | — |
| `Tab` / `Shift+Tab` | Next / previous control in sequence (keyboard placement review) | Next object | Next object |
| `G` | Gap mode on selected circle/leg: drag along the rim to open a gap | — | — |
| `F` | Fit course | Fit page | Fit map |
| `H` | Hide other courses' controls | — | Hide course overprint |
| Snapping | Toggle: control centre snaps to point objects' centres and line vertices within 0.5 mm (uses hit-testing) | Grid 1 mm, edges | Node snapping |

Variation authoring: select a leg → *Create variation here* splits the leg
into a group with alternatives A and B, each initially empty between the
anchors; *Add alternative*; drag controls into an alternative; *Loop*
checkbox turns the group into a butterfly (same anchor). The view picker
offers each concrete variant and an "all variations" overlay (alternatives
in distinct purple tints on screen only — print is always one variant).
Map exchange: place an exchange control (`X`) → the course splits into
sections; the inspector shows parts with their own sheets; a new start
symbol can be placed after the exchange.

Filter regions: `A` → *Filter region* → draw polygon → inspector: mode
(clip / hide), symbols (all / pick from the document's symbols through
their matches / colour class / invert → "show only"), scope. The region
updates live while dragged (04).

### 5.4 Views and visibility

- **Course view** (default): selected course full-strength, others' controls
  faded (as today), course objects scoped to it or to all.
- **All controls**: every site, codes, no legs; used to place and renumber.
- **Class view**: the course as the class prints it (scale override,
  sheet) — the layout preview without leaving Course mode.
- **Variant view**: one concrete variant with its numbering.
- **Setter view**: a setter map's controls with map-issue points.
- **Layout mode** shows the sheet (paper, margin, frame, page objects) and
  locks course edits; **Field mode** (5.5) is the mobile default.

### 5.5 Mobile and tablet

Requirement: the editor is usable on a phone — not merely rendering, but
placing, moving and describing controls, building a short course, and
checking a course in the field — while the desktop remains the place
where layout and variations are authored. Design:

- **Field mode is the mobile default** and exists on desktop too: GPS
  position and accuracy on the map (04 georeference), the selected course
  or setter map, large control hit areas, a bottom sheet listing controls
  with distance and bearing from the current position, check-off
  (`checked_at`), notes, photo-free. Switching to Course mode is one tap
  and allowed.
- **Chrome**: full-bleed canvas; a compact top bar (back, course picker,
  mode, overflow); no tool rail — a single floating **+** opens a radial
  / sheet with the creation tools; the **inspector is a bottom sheet** with
  three detents (peek: KPIs + selection name; half: properties or
  sequence; full: everything), draggable, never covering the selection
  (the canvas pans the selection above the sheet when it opens).
- **Gestures** (extends `mobile-layout.md`): one finger pans in
  fullscreen/standalone; tap selects; **drag only moves a selected
  object** — a selected control gets a visible handle offset above the
  finger so the circle is not hidden under it, and a long-press on an
  unselected control starts a move directly; two fingers always pan/zoom
  and cancel any armed tap (today's 400 ms rule); pinch over a selected
  area object scales it when the gesture starts on its handle ring,
  otherwise it zooms the map. The contextual action bar renders as the
  bottom sheet's peek row with ≥ 44 px targets.
- **Precision**: a *nudge pad* in the inspector (±0.1 mm / ±1 m arrows,
  numeric fields) for exact placement; a magnifier loupe above the finger
  during a drag at high zoom (04 renders a second small viewport of the
  same scene).
- **Desktop-only by design**: variation authoring beyond switching the
  displayed alternative, layout template editing (sheet *window* moves
  are allowed on tablet), map mode, bulk operations. These remain
  reachable but are not optimised; the UI says so rather than hiding.
- **Breakpoints**: phone (< 640 px) bottom-sheet layout; tablet
  (640–1024) collapsible side inspector + bottom action bar; desktop full
  chrome. Pointer type, not width, decides gesture rules
  (`pointer: coarse`).
- **Offline**: the document is cached (07 §9.1); mutations go through the
  existing outbox when offline and replay — a field move is one
  `control.update`; conflicts are last-writer-wins as today for
  `control.upserted`.

### 5.6 Live checks

Computed in the shared package from structure + sites + document, shown
in the inspector's Checks section and as markers on the canvas:

| Code | Rule |
|------|------|
| `CONTROL_TOO_CLOSE` | < 30 m (< 15 m at sprint scale) between distinct controls |
| `SAME_FEATURE_TOO_CLOSE` | same column-D feature within 60 m |
| `CODE_BELOW_31`, `CODE_DUPLICATE`, `CODE_INVERTIBLE` | code rules |
| `CONTROL_OUTSIDE_SHEET`, `NUMBER_UNPLACED`, `NUMBER_OVERLAPS` | layout |
| `DESCRIPTION_MISSING`, `DESCRIPTION_STALE` | descriptions (autodetect differs from stored for an unedited control) |
| `LEG_CROSSES_OOB`, `LEG_THROUGH_UNCROSSABLE` | leg through 709/708 or ISOM 201/521 class objects without a crossing point (document symbol classes from 03) |
| `VARIATION_UNBALANCED` | alternatives differ by > 10 % length |
| `EXCHANGE_WITHOUT_SHEET` | a section without a sheet |

Checks are advisory; nothing blocks a save.

## 6. API surface (sketch)

```
course.setStructure { courseId, structure }           → materialises variants, journals, returns checks
course.setLeg       { courseId, itemPath, leg }
course.variantList  { courseId }                      → [{ variantKey, courseId, lengthM }]
control.update      { … kind, circleGaps, notes }     (existing procedure, new fields)
control.check       { controlId, checked: boolean }   (field mode)
courseObject.create / update / delete / reorder
layout.templates / layout.sheets / layout.resolveSheet { sheetId, classId?, variantKey? }
layout.autoSheets   { courseId }                      → ensures templates/sheets for every section and class scale
layout.setterMaps   { groups }                        → sheets of kind 'setter'
mapPatch.get / mapPatch.apply { ops } / mapPatch.promote { label }
GET /api/maps/:nameId/sheets.pdf?… (05 backend; selection of class/course/variants/kinds)
```

`course.update { controlIds }` remains as the linear shortcut used by the
Courses page and E2E; it writes a structure with no groups.

## 7. Tests

| Layer | What |
|-------|------|
| Unit (shared) | `courseLayer()` fixtures: numbering with gaps and cuts, variation tints, section numbering restarts, corridor geometry, filter-region predicate; materialisation (product, loop permutations, variant keys, lengths); structure Zod rules (nesting, overlap, exchange crossing); checks table; `resolveSheet` (auto template key, class override, section sheets, all-controls auto layout, setter grouping determinism); patch application (hide/modify/add/resymbol, index mapping, unresolved ops after re-import) |
| Integration (api) | `setStructure` materialises child rows and pools, journals one `course.upserted` per row, re-materialises on control delete; `course_objects` scope filtering; `mapPatch.promote` creates a club version and empties the patch; snapshot carries objects and patches |
| E2E | Course mode parity with today's spec (`e2e/course-editor.spec.ts` rewritten against the GL canvas: place, drag, insert on leg, undo, descriptions, cuts); variations (create group, add alternative, switch view, export lists variants); map exchange (two sheets); filter region drawn and moved — hidden objects change live (pixel probe via the 04 reference raster); layout mode (auto template, window align, PDF contains the sheet); **mobile viewport project** (Playwright `devices['Pixel 7']`): field mode GPS mock, bottom sheet detents, long-press move, nudge pad, two-finger cancel; map mode smoke (hide an object, add a path, promote) |

## 8. Roadmap

| Phase | Ships | Depends on |
|-------|-------|-----------|
| **1 — Parity on the new stack** | One canvas, Course + Layout modes, derived course layer, `course_objects` (OOB, whiteout, filter region), auto templates + sheets, class scale override, checks, Field mode baseline (GPS, bottom sheet, check-off), export menu | 04 renderer, 05 PDF, 07 schema |
| **2 — Structure** | Variations and loops with materialisation, map exchange sections and sheets, leg styles/gaps/corridors/crossings, variant views and exports, all-controls and setter-map auto layouts, description sheets | Phase 1 |
| **3 — Map mode** | Patch layer: hide/move/nodes/add/resymbol with palette, promote to club version, unresolved-op review | 03 materialisation, 06 encoder |
| **4 — Later** | Micro insets, climb from contours (needs contour interval), toner saver, multi-select lasso polish, OCAD course export, difficulty/route-choice analytics (explicitly not planned) | — |

Phase 1 replaces today's two editors and is the gate for 09's removal of
`MapViewer`'s SVG overlay, `MapLayoutEditor`, `resolve-layout.ts`'s SVG
path and `courses.geometry` consumers.

## 9. Options

| Decision | A | B | Choice |
|----------|---|---|--------|
| Course structure storage | `structure JSONB` on the root + materialised child rows | Normalised `course_sections`, `variation_groups`, `alternatives` tables | **A** — the structure is edited as a whole, validated by one Zod schema, journaled as one row; timing never reads it (it reads child rows); normalised tables buy nothing but joins |
| Editors | One canvas with modes | Keep course editor page + layout dialog, both on GL | **A** — shared selection/undo/viewport, one gesture model to make mobile-ready, layout preview is just a view |
| Patch layer | Event-scoped ops on the document hash, promote on demand | New document version per edit | **A** (4.7) |
| Layout templates | Auto by `(paper, orientation, scale)` + explicit extras | Manual templates as today | **A** — removes the most repetitive setup; extras keep the escape hatch |
| Course layer | Derived by a shared function every time | Stored GeoJSON (today) | **A** — one implementation for screen/print/kiosk; `geometry` kept as an output for one release |
| Mobile | Field mode + bottom-sheet editor on the same model | View-only mobile | **A** — stated requirement; the cost is chrome, not model |

## 10. Effort

| Work | Estimate |
|------|----------|
| Shared: `courseLayer`, materialisation, structure schema, checks, `resolveSheet`, patch application | 4 weeks |
| Schema + API (4.8, §6), journaling of structure, snapshot additions | 2 weeks |
| Editor shell: canvas integration, selection/undo/autosave, tool rail, action bar, inspector, views, modes | 5 weeks |
| Layout mode on the new canvas (templates, sheets, page objects, align map) | 3 weeks |
| Field mode + mobile chrome (bottom sheet, gestures, nudge, loupe) | 3 weeks |
| Variations / exchange / legs (phase 2 UI) | 3 weeks |
| Map mode (phase 3 UI: nodes, palette, promote) | 4 weeks |
| Tests per §7 incl. mobile E2E project | 3 weeks |
| **Phase 1** | **≈ 14–16 weeks**; phases 2–3 ≈ 10 weeks more |

## 11. Recommendation

1. **Derive the course layer** from `structure + sites + objects` with one
   shared function used by screen, print and kiosk; retire stored
   geometry after one release.
2. **Course structure** as items with variation groups (no nesting, no
   crossing an exchange, loops as permutations) stored in `courses.structure`
   and **materialised** into child variant rows for timing and export.
3. **Controls stay sites**; add `kind`, manual circle gaps, notes and
   field check-off.
4. **`course_objects`** with scope for OOB, whiteout, filter regions
   (04's two modes, including "show only"), toner saver, free marked
   routes and map-anchored text/images.
5. **Layout**: auto templates by `(paper, orientation, scale)` with explicit
   extras; sheets per section and per class override; all-controls,
   setter-map and description-sheet auto layouts; `resolveSheet` as the
   single producer of 05's page input.
6. **Patch layer**: event-scoped ops keyed by document hash with
   `sourceIndex` for re-resolution; promote to a club map version on
   demand; editing tools in phase 3.
7. **One editor, four modes** (Course, Layout, Field, Map) on one GL
   canvas; contextual selection by default plus a creation tool rail;
   live KPIs and advisory checks; autosave and full undo.
8. **Mobile**: Field mode as the phone default, a bottom-sheet inspector,
   drag-only-when-selected plus long-press, nudge pad and loupe; variation
   and template authoring stay desktop-optimised but reachable.
9. **Phase 1 is parity plus filter regions, auto templates, checks and
   field mode**; variations and map mode follow on the same model.

## 12. Open questions carried forward

- **Contour interval** for climb: ask at import (06 report field) or on
  the club map series (07) — the latter survives re-imports; propose the
  series, defaulting from OMAP metadata when present.
- **Variation tints on screen**: distinct purple tints for "all
  variations" are screen-only; confirm no print path can ever pick them up
  (05 palette has one purple — a fixture should assert).
- **Relay variant distribution** UI (which team/leg gets which variant) is
  timing's concern; confirm the pools the editor writes are sufficient for
  the existing allocation, or whether the editor should offer the
  standard forking schemes.
- **Field-mode conflicts**: two setters moving the same control offline;
  LWW is today's rule for `control.upserted` — acceptable, but the UI
  should show "moved by X at T" on reconnect.
- **IOF XML** representation of map exchange, crossing points and corridors
  — verify against the 3.0 XSD during phase 2 and record in
  `iof-coursedata-export.md`.
- **09 ordering**: whether Layout mode ships in the same release as Course
  mode (recommended — otherwise two overlay implementations coexist again)
  or the old layout dialog survives one release on the PDF side alone.
