# Course layer

Status: **draft** — chapter of the vector map pipeline specification,
started by sub-slice C0. The research record is
`docs/research/vector-map-pipeline/08-course-editor.md` §4.1, §4.5 and
`04-render-core.md` §7; when the two disagree, this document wins.

This chapter is normative for `packages/shared/src/course/`
(`import { course } from "@oxygen/shared"`). Its consumers are the
viewer's dynamic bucket (C4, §5), the page composer (C2,
`course-print.md`) and the derived course lengths (§4.1); the
`courses.geometry` compatibility artifact (C5) it also fed was dropped
in E5. This chapter covers how the layer is derived (§1), its v1 input
(§2), the geometry rules (§3), the lengths and the retired GeoJSON
projection (§4), the viewer
(§5), the stored course structure (§6, slice D row D0), the
concurrency rules for editing it (§7, gate G1) and the stored, scoped
course objects (§8, row D2) and the advisory checks (§9, row D6). Editing the structure on
the new canvas is `course-editor.md`'s.

## Decisions taken before the code (user, 2026-10-24)

- **Sizes.** The 7xx symbols are drawn at the library's dimensions ×
  the document factor (03 §6.6): an ISOM map at 1:10 000 gets 7.5 mm
  circles, 0.525 mm lines and 6 mm digits; an ISSprOM map 6 mm circles.
  A stored template appearance becomes a multiplier of the library
  dimension (stored ÷ legacy default, `appearanceFromTemplate`), so
  default templates print spec sizes. Legacy's 5 mm / 0.35 mm / 4 mm on
  every map is the third sanctioned difference for `course-print.md`.
- **Control numbers.** Default `numberStyle: "spec"` — the library entry
  as it is (704 upper purple without a halo on both libraries — ISOM by user decision 2026-10-24, see `map-symbols.md` §3; the leader line follows the number, so it is upper purple on ISOM too). `"knockout"` is the opt-in legacy look:
  upper purple with a 0.15 mm upper-white outline (ISSprOM 704.b) on both
  libraries.

Decided by the user 2026-10-24 for C5:

- **Stored GeoJSON at legacy sizes** (the artifact and its cuts version
  were dropped in E5, §4). The `courses.geometry` artifact
  (§4) is computed at the legacy sizes (2.5 mm circle radius, 0.35 mm
  lines) for both pipelines, because every consumer of it draws those
  sizes until it is ported (C4 viewer, C2 / C3 print). The pinned
  document is only the *feature source* of `vector` events. Spec sizes
  reach the cuts when the consumers draw from the layer itself.
- **Size-aware cuts.** Today's ±0.4 mm cut leaves ~0.03 mm of air
  around a boulder once the line's round caps are drawn, overlaps a
  boulder cluster, and overlaps every feature on a 1:10 000 map (symbols
  × 1.5). A cut now clears the feature's **own symbol radius** (as the
  map draws it; §3.4) **+ half the drawn line width + 0.25 mm of visible
  air**, and a feature is "on" the line by the same sum
  (§3.4). One rule for the layer and the artifact; stored cuts migrate
  through the `OVERPRINT_CUTS_VERSION` bump.

Decided by the user 2026-10-31 for slice D (gate G1, concurrent
editing; README "Decision gates" and decision log): optimistic
concurrency with a version token over the journal. D0 wrote the rules out
as §7; the designs weighed and why (B) won are in the decision log.

Decided by the coordinator 2026-11-02 for D6 (decision log): the
`DESCRIPTION_STALE` provenance is a new `controls.description_source`
column (§6.3) — the schema had none, and "equals autodetect at the
current position" can never detect staleness; `NUMBER_OVERLAPS` is the
placer's collision fallback and `NUMBER_UNPLACED` a visible control
visit without a label (§3.5, §9.2); a check carries no message text.

## 1. Derivation

The course layer is **derived, never stored** (08 §4.1): a pure function
of the course structure, the event's control sites, the course objects
in scope (§8), an appearance and view options, run by every consumer:

```ts
courseLayer({ structure, sites, objects, appearance, viewOptions, document, cutFeatures? }): CourseLayer
courseRenderInput(documentRenderInput(doc), layer): { objects, symbols, courseObjectOffset }
symbolise({ ...merged, fonts })   // one stream: map and course in colour order
```

The five inputs of 08 §4.1 are named fields of one object; `document`
(the aligned colour stack, library id, document factor —
`courseDocumentContext(header)`) and `cutFeatures` (§3.4) are what the
layer needs from the map. No DOM, no Node API, no fonts: the number
boxes are estimated like the legacy placer's (0.65 em per character).

**Colour stack.** The layer draws on the document's aligned stack
(`map-symbols.md` §9), completed by `courseColourStack()`:

- Lower and upper purple must be present — alignment always places both
  (`alignColourStack` step 3); a stack without them throws
  `CourseStackError` (an unmatched document must be matched first).
- **Upper white** ("Upper white for course overprint", 03 Appendix B
  row 2) is inserted **directly below upper purple** when the stack
  lacks it. The IOF table lists that row for ISSprOM, ISSkiOM and ISMTBOM
  but not for ISOM, so every ISOM document gets it here; the layer
  returns `remap` (document index → new index) and `courseRenderInput`
  re-indexes the document's symbols with `remapRenderColours`. Done at
  layer-build time, not by import alignment, so no stored document
  changes hash (Pending: fold it into stage 7 at the next importer bump).
- Course objects in their own hex colours (a `text` object's `color`, §8.3) get one row each, in
  first-use order, **on top of the stack** (`course-object:#rrggbb`,
  CMYK by the naive inverse of `cmykToHex`): legacy print draws them
  after everything else.
- **Variation tints** (§12.7, F7): with `viewOptions.allVariations` — the
  editor's All-variations view, screen only — one row per tinted
  structure's label (`course-tint:<label>`, `VARIATION_TINTS`) after the
  object rows, below a toner saver's white. Never on paper: the
  print path never sets the option (a compose fixture asserts it).

`layer.colours` is the stack the merged input is drawn with.

**Symbols.** Each 7xx entry is resolved exactly as the render bridge
resolves a canonical entry — `getLibraryEntry("<library>:<code>")`,
`resolveEntry(entry, paletteIndexOfStack(colours))`,
`scaleRenderSymbol(…, documentFactor)` (`map-symbols.md` §4, §8.3) —
then the appearance multipliers apply (§3.1). Their purple role is the
entry's (03 §2.4), so the stack decides layering: lower purple (701, 703,
705, 706, 708) sorts under black 100 % and the ISOM brown and
blue line/point rows; white-outs sit at upper white, above all map ink
and lower purple, below upper purple (704, 707, 709, 711) —
the legacy print sandwich full → lower → ink → white-outs → upper,
by construction. A white-out therefore hides lower-purple course lines
under it, as legacy print does. A white-out *outside* (a toner saver)
does not sit there: it fills its own row on top of the layer's stack
(§3.6, P1). A corridor's white band (§10.2) is no row at all: it is a
clip filter region, so the map is cut away there and every course
symbol draws over it.

**Merging.** `courseRenderInput(base, layer)` appends the layer's
symbols after the document's (re-indexed when `remap` is set) and its
objects after the document's; `objects[courseObjectOffset + i]` is
`layer.objects[i]`, whose `ref` (`site`, `leg`, `number`, `leader`,
`extra`, `object` + id) says which input it came from — the viewer's
per-object hide and hit-testing (04 §7). Map-anchored images are not in
the stream: `layer.images` carries them with their paper rectangle for
the page backends.

For consumers: when `remap` is set, every document colour at or above
upper purple moves up one index, so anything keyed on the document's
own stack must be built on `layer.colours` (or re-keyed) whenever a
course is shown, until upper white is inserted at import (Pending). The
viewer builds its static buckets on `courseColourStack(header.colours)`
from the load, course shown or not (`map-rendering.md` §5.2 "Dynamic
bucket"), so a course never re-prepares the map. `courseLayer` throws
`CourseStackError` for an unaligned stack; the viewer (C4) catches it
and draws the map without a course, with a notice, rather than fail the
view (`map-rendering.md` §5.4 "Fallback"). The
stored GeoJSON (C5) is computed on a fixed ISOM stack (§4.1), which never
throws.

**Scale.** The layer is in paper µm at the document's scale (map frame,
y-up), like the map. Printing at another scale is the page transform's
job (`T_map`, 05 §5.1), which enlarges map and course together — so an
ISOM course printed at 1:10 000 from a 1:15 000 map gets 7.5 mm circles
as the spec requires. There is no overprint factor for the 7xx symbols,
nor for course objects; `viewOptions.overprintScale`, which divided the
page-mm sizes of map-anchored layout objects, retired with them in F12
(§3.6).

## 2. Input, version 1

Paper mm at the base map's scale, y-up (the frame of `controls.xpos/ypos`
and of course GeoJSON). Gaps: compass degrees for circles (0° = +y,
clockwise, the gap sweeping clockwise from `start` to `end`), fractions
0..1 for legs — the OCD importer's and `overprint-cuts.ts`'s conventions.
Stored gaps — a site's `circle_gaps`, a structure's `LegProps.gaps` — are
the **full effective set** for that circle or leg and replace the
automatic cuts; an empty list means automatic (decision log 2026-11-01,
"Stored gaps replace the automatic cuts"; `course-editor.md` §6.3).

| Input | v1 shape | Built today from |
|---|---|---|
| `structure` | `CourseStructure` (one course), an array (several highlighted courses: legs of each, codes as numbers) or `null` (no course) — the stored form is §6; `tint?` (a label) marks an alternative of the editor's All-variations view (§12.7), read only with `viewOptions.allVariations` | `{ version: 1, id, orderMode, items, labelOffsets? }`: `items` start … finish — the start by `startName` unless `firstAsStart`, `course_controls` in order, the finish by `finishControlId` unless `lastAsFinish`; from the stored structure when there is one (§6), else from the columns — one rule for every reader (`courseSequenceOf`, §6.2: `rebuildCourseLengths`, `course-export.ts`, the print layout); `labelOffsets` from `course_controls` |
| `CourseItem` | `{ siteId, role?, leg?, numberHidden? }` — 08 §4.3's item, the leg being the leg *into* the item | `role` (`control` \| `start` \| `finish`) defaults to the site's kind — a `map_exchange` draws as a control and splits the course into parts (§10.3, §11) — (set it for `firstAsStart` / `lastAsFinish`); `numberHidden` from the visit's `number_hidden`. An item naming a `crossing_point` or `map_issue` site is skipped (they are never items, §10.3) |
| `leg` | `{ gaps?, style?, bends?, corridor?, crossing? }` — the stored `LegProps.gaps` (fractions along the leg, bends and crossing point included), `style` (`line` \| `marked_route` \| `none`, default `line`) and `bends` (paper mm), §10.1; `corridor` (`{ widthM, edge, whiteMm, whiteOpacity }`), §10.2; `crossing` (`{ controlId, section? }`, the site id of a `crossing_point` the leg runs through), §10.3 | `LegProps` of the structure's item (§6.4: written by the importers and the backfill, by the editor from D5). The v1 interim input of slice C (`path`, `pieces`, item `circleGaps`, `extras`, read from an imported `ocd` course's GeoJSON) is **retired** by D1: nothing is read from the GeoJSON |
| `sites` | `{ id, code, kind, x, y, circleGaps? }[]`, `kind` one of `control`, `start`, `finish`, `crossing_point`, `map_issue`, `map_exchange` (§6.3) | `controls` rows; `code` the display code (first punch code, else name / seq); `circleGaps` = `controls.circle_gaps`, compass degrees |
| `objects` | `CourseLayerObject[]`: the course objects (§8) — since F12 a sheet's layout objects are all page-anchored and the page layer's (§3.6) | the event's course objects in scope (§8.3) |
| `appearance` | `{ circle?, line?, number?, numberStyle? }`, multipliers (1 = the spec) | `appearanceFromTemplate(template.appearance)`; the template's `purple` is not read (the purple is the stack's row) |
| `viewOptions` | `{ allControls?, labelMode?, labels?, autoCuts?, window?, textValues?, setterMarks?, section?, allVariations? }` — `allVariations` (§12.7): the tinted structures draw on tint rows, screen only; `labels` (F15, §12.7): explicit text per control site, read before the sequence number and the code | the view: all-controls, label mode (and, for All variations, the explicit labels), the event's **Auto cuts** toggle (`Event.autoOverprintCuts`; `false` = no automatic cuts, §3.4; absent = on), the frame polygon for white-out-outside, `{course}` placeholder values; `setterMarks` (§10.3): the map-issue points and every crossing point are drawn — the editor's Course and All-controls views and the all-controls sheet set it, a course sheet never does; `section` (§11): one part of a course split by map exchanges — a part sheet in print, Layout mode and Class view set it from `course_maps.section_index`, Course mode never does |
| `document` | `{ colours, libraryId, documentFactor, mapScale }` — the aligned stack, the library, the document factor (§3.1) and the base map's scale denominator (corridor widths, §10.2) | `courseDocumentContext(header)` (`context.ts`): the viewer's worker and the print route (`pdf-page.ts`) build it from the pinned document's header; `mapScale` is `header.mapScale` |
| `cutFeatures` | `{ x, y, r? }[]` (`r` the drawn symbol's radius) | `cutFeaturesOfDocument(doc)` of the pinned document (every event since E1, §4.2) |
| `regions` | `{ rings: MapPoint[][], mode: "clip" \| "hide", symbols: "all" \| number[] \| { colours }, invert? }[]` — filter regions over the map, `rings` outer first; symbol indices are the document's, colours its own stack's | explicit regions, then every `filter_region` course object in `objects` (§8.3); the layer returns them as `CourseLayer.regions` (µm paths, colours on the completed stack) and `courseRenderInput` passes them to `symbolise` with the document's object count as `regionObjectLimit` — the rule is `map-rendering.md` §4.11 |

Free order is the structure's `orderMode` (a property of the course, not
of the view). A site at the origin (0, 0) is unpositioned and skipped,
legs connecting the remaining items (the editor's rule, `editorCourseLayer`).
Gaps follow the rule above. Crossing points, map-issue points and map
exchanges are drawn since F4 (§10.3; an exchange as a control, the
course split into parts at it since F5, §11); variations reach the layer
as materialised linear variants (§12), and in the editor as the
displayed path or, in All variations, as tinted linear branches (§12.7).

## 3. Geometry rules

The course-setting rules are symbolisation of the layer (04 §7), in
`derive.ts` (geometry, mm) and `layer.ts` (objects, µm).

### 3.1 Symbols and appearance

| Drawn | Entry | Multipliers |
|---|---|---|
| start | 701, point, `orientation: "object"` | circle → geometry, line → width |
| control circle | 703's ring → a **derived line symbol** (`<id>/arc`: the ring's colour and width, flat caps), the circle drawn as Bézier arcs, so gaps are ordinary open paths | circle → radius, line → width |
| finish | 706 | circle, line |
| number | 704 with `align: "centre"`; `knockout` → upper purple + 0.15 mm × factor halo in upper white | number → digit height and em |
| leader | 705 at 0.7 × width in the number's colour | line |
| leg | 705 (`style: "line"`, the default), 707 (`marked_route`), nothing (`none`) — §10.1 | line |
| corridor edge (§10.2) | 705 as a **derived line symbol** with round caps (`<705 id>/edge`, F19): an edge piece that ends on a circle or the 701 leaves no notch there. `CourseSymbolSet.edge`, not in `symbols`: the layer appends it after every other symbol only when it draws an edge, so a layer without one keeps its indices | line |
| marked route / restricted line / forbidden route | 707 / 708 / 711 (ISSprOM has no 711: ISOM's, same factor) | line |
| out-of-bounds area | 709; with a stroke 709.b (solid boundary), or 709.c (dashed) when the stroke is dashed | — |
| dangerous area | **derived** from the resolved 709 / 709.b / 709.c: the same stripes again at +90° (a cross-hatch of 709's width, spacing and colour), the same boundary; ids `course:dangerous`, `.b`, `.c`, code `710` — not a library entry (below) | — |
| white-out | area symbol `course:whiteout`, fill = upper white | — |
| crossing point (§10.3) | ISOM 2017-2: 710, a `line` drawn along the passage over `CROSSING_BODY_MM` (3.0 mm × document factor; the section form `CROSSING_SECTION_MM`, 6.0 mm × factor). ISSprOM 2019-2: 710.1, a point turned by `angleDeg`; the section form two 710.2 lines `CROSSING_SECTION_OFFSET_MM` (0.75 mm × factor) either side of the passage, the second reversed so both ends curve outwards. Lower purple (710.2 upper) | 710.1: circle → geometry, line → width; 710 / 710.2: line → width |
| map-issue point (§10.3) | 702, point, unrotated; upper purple | circle, line |

The dangerous area is not in ISOM 2017-2 or ISSprOM 2019-2 — their `710`
is the crossing point (03 §2.4) — so the set derives it from 709 rather
than reading a document or library 710; the number is the one ISOM 2000,
OCAD's course-setting set and Purple Pen give the cross-hatched area
(decision log, D5a). It scales with the document factor like 709.

A ring's multiplier scales its centre-line diameter, the width scaling
separately (`ringCC` geometry). Dimensions at ISOM 1:15 000, defaults:
circle radius 2.5 mm, finish 2.0 / 3.0 mm, start side 6 mm, lines
0.35 mm, digits 4.0 mm; ISSprOM 1:4 000: 3.0 mm, 2.5 / 3.5 mm, 7 mm,
0.35 mm, 4.0 mm.

### 3.2 Legs

For an `ordered` course, one leg per consecutive pair of positioned
items, centre to centre — through the item's `leg.bends` when it has
any (§10.1) and its `leg.crossing` point (§10.3): the leg's `points` are
`legPolylineOf(previous site, bends, site)` (`course/bends.ts`) — the
previous site, the bends' path with every curved segment flattened at
5 µm (F13), the site, with repeated points dropped. A crossing point
joins the bends first, as a corner, on the segment whose flattened path
is nearest it (`routedBends` on `bendSegmentAt`; ties to the earlier
segment), the neighbouring bends keeping their handles. Every anchor
(site, bend, crossing point) is a vertex of `points` verbatim. Without
handles `points` is exactly the polyline through the bends, so a corner
leg is unchanged by F13.

1. Gaps: the item's authored `leg.gaps` when non-empty, else the
   automatic ones (§3.4) when `cutFeatures` are given and the event's
   auto cuts are on. Both are fractions of the leg's length along its
   bends. `subtractLegGaps` removes them, keeping the bends inside each
   piece.
3. Each segment of each remaining piece is clipped at every **drawn**
   site with clearance = the site's extent + 0.2 × R (R = control circle
   radius): 1.2 R at a control (legacy), outer ring + 0.2 R at a finish,
   start circumradius + 0.2 R at a start (legacy used 1.2 R everywhere and
   overlapped the start triangle). Crossing and map-issue points are no
   obstacle: the leg runs through them (§10.3). What is left joins back into runs
   through the bends, and runs of 1 mm or less are dropped
   (`clipPolyline` in `derive.ts`: `clipLine`'s rule per segment, the
   1 mm rule per joined run, so a short stretch at a bend is never
   dropped on its own; a straight piece gives exactly `clipLine`'s
   result). A bend inside a site's clearance is not drawn: both
   segments into it are cut, the leg splits there.

`free_order` courses and the all-controls view draw no legs.

### 3.3 Sites

Drawn sites: the courses' sites in first-visit order, then the crossing
points their legs run through (§10.3), plus (with `allControls`) every
other positioned site in input order — a map-issue point only with
`setterMarks` — and (with `setterMarks`) every positioned crossing and
map-issue point. A site appearing in several roles takes its first.
`DerivedSite.role` is how it draws: `control` (a map exchange too),
`start`, `finish`, `crossing_point`, `map_issue`.

- **Start (701)** turned so its apex points at the next site of the
  first ordered course that starts there: `angleDeg = atan2(dy, dx) − 90`
  (the glyph's apex is +y). North when there is none (free order,
  all-controls). Legacy drew the apex north always; the turned start is
  a sanctioned difference for C3's list.
- **Control (703)**: a closed circle, or the arcs left by its gaps
  (`circleArcs`; an arc running through north is one path). Gaps: the
  site's authored `circleGaps` when non-empty, else the automatic
  cuts (§3.4) while the event's auto cuts are on. Start and finish are
  never cut. At an edged corridor's end the circle is also **opened**
  (§10.2 "Openings", F19) — at draw time only: the layer merges the
  opening with the cuts in `circleWithGaps`, `DerivedSite.cuts` never
  holds it, nothing stores it, auto cuts off leave it, and `G` neither
  sees nor writes it.
- **Finish (706)**: the entry's two rings.
- **Crossing point (710)** and **map-issue point (702)**: §10.3 —
  numberless, never cut, no placement obstacle.

### 3.4 Automatic cuts

`circleCuts` / `legGaps` in `cuts.ts` (size-aware since C5, user
decision 2026-10-24). The purple overprint must not hide compact map
detail, so it is cut around **small point objects only** — circle slits
and leg gaps reveal knolls, rocky pits and boulders; long objects
(cliffs, paths, walls, buildings, areas) stay uncut, the colour stack
keeps their ink readable without fragmenting the purple. There is no
manual cut tool; a setter's explicit gaps arrive as stored `circleGaps`
/ leg `gaps` (importers, the gap tool). Each feature carries the radius `r` of its drawn symbol; the
line it may touch is drawn `w` wide. Its **clearance** is

  c = r + w / 2 + `CUT_AIR_MM` (0.25 mm)

— the symbol, the line's half (its round or flat end reaches that far),
and visible air, so the overprint stops 0.25 mm from the symbol's ink on
paper at any print scale (print enlarges map and course together).

- **Circle** of centre-line radius R: a feature at distance d from the
  centre is on the rim when |d − R| < c; the slit opens the arc between
  the two rim points at exactly c from the feature
  (half-angle `acos((R² + d² − c²) / 2Rd)`), so a feature off the rim
  opens less than one on it. Overlapping slits merge; slits under 4° are
  dropped; a circle that would lose more than 300° is kept whole.
- **Leg** (straight, a → b): a feature at perpendicular offset δ < c
  from the segment opens the stretch between the two points at c from
  it (half-length `√(c² − δ²)`). Legs keep 1.2 R at each end (the circle
  clipping takes that anyway), gaps under 0.6 mm are dropped, never more
  than 70 % of a leg (smallest dropped first).
- **Bent leg** (`polylineLegGaps`, F1): every segment of the polyline
  opens the part of itself within c of a feature (the same half-length,
  limited to the segment), stretches meeting at a bend merge into one
  gap; the 1.2 R end keep applies at the leg's two ends only (a bend is
  not a circle), the 0.6 mm minimum and the 70 % cap to the whole leg's
  length; gaps are fractions of the bent length. A two-point leg is
  exactly `legGaps`. Only the features within reach are tested (F20b):
  a feature outside the leg's bounds grown by twice its own clearance,
  or outside a segment's bounds grown the same, is skipped — it lies
  farther than c from the line beyond every segment (a passing feature
  lies within c·√2 of a segment's bounds on each axis), so it opens
  nothing — and the rest keep their order, so the result is bit for bit
  the unfiltered loop's (`cuts-reference.test.ts`).

`R` and `w` are the drawn circle and line (`CourseMetrics.lineWidthMm`
from the 705 entry); a feature without `r` counts as
`DEFAULT_FEATURE_RADIUS_MM` (0.25 mm, an ISOM knoll). At the legacy sizes
(R 2.5 mm, w 0.35 mm) a boulder (r 0.2 mm) on the rim opens 28.7° —
1.24 mm of chord — where the old fixed ±0.4 mm opened 18.4° and left
0.03 mm between the line's round cap and the boulder; a boulder cluster
(r 0.46 mm) was overlapped outright, and on a 1:10 000 map drawn at ISOM
150 % every feature was.

**Features** (`cutFeaturesOfDocument(doc)`): point objects of visible
symbols whose **applied** match (`isAppliedMatch`) is, or — unmatched or
only suggested — whose source code is, in `CUT_CODES` = 109, 110, 203,
204, 205, 207 (knoll, elongated knoll, rocky pit, boulder, large
boulder, boulder cluster; 206 gigantic boulder is an area and excluded,
as today). `r` is the farthest ink of the symbol **the document draws**
(`pointSymbolRadiusMm`): the canonical render (library entry × document
factor) of an applied match, else the document's own render; the library
entry × document factor only when there is neither. The source is the
event's pinned document, whatever its pipeline (§4.2; the slice-C split
tied it to `vector`, slice E1 made it every event's).

**The event's toggle** (`Event.autoOverprintCuts`, written by
`course.setOverprintCuts`, read by `course.getOverprintCuts`; the
editor's `editor-toggle-cuts`, `course-editor.md` §4; D17). Off, the
layer computes **no automatic cuts** — no circle slits, no leg gaps —
whatever `cutFeatures` holds: `viewOptions.autoCuts === false` makes
`deriveCourse` ignore the features, so the objects equal those of the
same input without `cutFeatures` (one rule for the layer and the
artifact writer, which passes no features when off, §4.2). **Stored
gaps still apply**: a site's `circleGaps` and a leg's `LegProps.gaps`
are the setter's explicit choice (the gap tool, an importer) and draw as
authored with the toggle off (decided by the coordinator for D17 — for
user review). The flag reaches every consumer of the layer:

| Consumer | How it reads the flag |
|---|---|
| GL course layer (every `MapPanel`: course views, kiosk, the editors, Layout mode) | `MapPanel` reads `course.getOverprintCuts` (kiosk-readable) and passes `autoCuts` to `MapViewer` → `courseLayerRequest` → `viewOptions.autoCuts` (§5); the editors' toggle refetches the same query, so the canvas redraws without a reload. Until the query answers, cuts are on |
| Vector print (`maps.pdf`, `course-print.md` §8.2) | the route passes `event.autoOverprintCuts` as `MapRowContext.autoCuts` → `resolveSheet` → the sheet's `course.viewOptions.autoCuts` → `composePage`; `courseMap.resolveSheet` (Layout mode's sheet) does the same |
| — | Nothing stored depends on the flag since E5 dropped the `courses.geometry` artifact (whose writer cut by it): `setOverprintCuts` writes `events.auto_overprint_cuts` and nothing else — no course is rebuilt or re-journaled |

### 3.5 Numbers

- **Text**: `sequence` (1, 2, … over the first course's control items; a
  site visited twice gets `3/7`) by default for one ordered course
  outside the all-controls view; `code` otherwise, or by `labelMode`.
  `viewOptions.labels` (F15) wins over both for the control-role sites it
  names: the text is the entry's, `numberHidden` ignored; a site it omits
  keeps its code (several structures) or number. All variations sets it
  when the variants number alike (§12.7).
  Start and finish carry no number. A map exchange is a control item and
  takes its number; the numbers **continue** across it, and a part drawn
  alone (§11) keeps the whole course's numbers (answer 2).
- **Placement**: `placeControlLabels` over every drawn site (start and
  finish as obstacles with their extents), the drawn leg pieces and the
  extras' lines, with `radius` R and `labelSize` the 704 em. The placer's
  direction preferences are screen conventions, so it runs in the map
  frame flipped to y-down and its centres are flipped back — the legacy
  print's "map frame" placement, rotation-invariant. Per auto-placed
  number the placer tests only the segments within reach of its
  candidate boxes — `R + gap + 2·labelSize` (the outermost ring) plus the
  box diagonal, `2·linePad` and `0.5·labelSize` (the soft clearance) of
  the centre — in input order, so the result is bit-identical to testing
  every segment at a fraction of the cost (F20,
  `docs/bugfix-course-drag-redraw.md`; ~40 ms instead of ~350 ms on 25
  controls with smooth bends). A segment with a NaN coordinate is kept
  for the tests to judge, as before.
- **Manual positions**: `labelOffsets[siteId]` (one course only) is the
  number's centre relative to the site; emitted as is, no leader.
- **Leaders** where the placer reports a contested slot (705-derived
  line, §3.1).
- **Collisions**: a number is never dropped; when no ring has a
  collision-free slot the placer takes the least-bad box and marks it
  `collides: true` (`PlacedControlLabel`, `DerivedSite.label`), which
  §9's `NUMBER_OVERLAPS` reads. A contested slot with a leader is not a
  collision.
- **Anchor**: the text object's point is the baseline, half a digit
  below the placed centre, `align: "centre"` (the legacy SVG overlay's
  `controlNumberBaselineY`, deleted in E4c).

### 3.6 Layout objects (map-anchored: retired in F12)

The course layer draws **course objects only** (§8). Until F12 a sheet's
or template's *map-anchored* layout objects (`CourseMapObject` with
`anchor: "map"`, `course-maps.md` Data model) were drawn here too, their
page-mm sizes divided by `viewOptions.overprintScale`. F12 moved every
one of them into `course_objects` (the migration below) and retired the
branch: `CourseLayerInput.objects` is `CourseLayerObject[]`,
`viewOptions.overprintScale` is gone, `layer.images` holds `image` course
objects only, and the layout schema's anchor is the literal `"page"` (a
write naming `"map"` is `BAD_REQUEST`). A sheet's layout objects are the
page layer's (`course-print.md` §4.4): `pageObjects` (`objects.ts`) draws
them through the same builder in page mm — white-out at upper white, a
page white-out outside the frame ring at upper white, 709 / 709.b /
709.c, a solid fill or a stroke in its own colour row (dashes max(2, 5 w)
/ max(1, 2.5 w) mm), text in its colour's row (`sans` → Liberation Sans,
`condensed` → Liberation Sans Narrow, `serif` / `mono` → their families,
which ship no file: `symbolise` warns `NO_FONT`, `map-rendering.md`
§4.10; `{placeholders}` expanded; empty text skipped), images as page
images.

**Migration (F12).** `packages/api/prisma/migrations/20261109120000_map_anchored_objects_to_course_objects`
(the runbook: `docs/migrations/2026-f12-map-anchored-objects.md`). Every
map-anchored object of `map_templates.objects` and `course_maps.objects`
becomes one `course_objects` row; the geometry is copied as it is (both
are paper mm, y-up), so the object stays where it was on the map:

| Legacy object | Course object |
|---|---|
| rectangle / path, `fillMode: "whiteout"` (and the legacy `whiteoutRect` / `whiteoutPolygon` kinds) | `whiteout {}`; a rectangle as its four corners (`x, y` → `x + width` → `+ height` → back, the layer's `rectVertices` order) |
| `"whiteoutInverted"` | `toner_saver {}` — the drawn shape is the stored one (no `marginMm`) |
| `"outOfBounds"` | `oob_area`: `{}` without a stroke, `{ border: "solid" }` with one, `{ border: "dashed" }` with `dash: "dashed"` (the stroke's colour and width were never read) |
| line, or a path / rectangle with no fill (`none`, or `solid` without `fill`), stroked in **purple** | `oob_line {}` (708) when solid, `marked_route {}` (707) when `dash: "dashed"`; a closed path or a rectangle gets its first vertex appended; the stroke width goes (the 7xx symbols take the library's) |
| text | `text { text, fontSizeMm: fontSizeMm ÷ os, color, fontFamily?, align? }` at its anchor point (`maxWidthMm` goes: it was never drawn) |
| image | `image { graphicId, crop? }`, geometry the two corners `(x, y)`, `(x + width, y + height)` |

*Purple* is the row's template's `appearance.purple` or the ISOM default
`#a626ff`, case-insensitive. `os` is the overprint enlargement the
retired branch divided by: the event's base map scale (its latest map
file's document, `getBaseMapInfo`) over the print scale (a sheet's
`overrides.printScale`, else its template's; a template's own
`print_scale`), 1 without a base map or a template — so a moved text
prints at the size it did on that sheet.

The scope (§8.2): a template's objects `{ all: true }` (no template scope
exists; a template's object was drawn on every sheet of it); a course
sheet's `{ courses: [its course] }`; a class sheet's (`class_id`)
`{ classes: [its class] }`; an all-controls sheet's, and a setter sheet's
without a course, `{ all: true }`; a setter sheet with a course, that
course. The rows: `source = 'layout'` (§8.1), `version = 0`, `z` one
below the event's lowest (so they draw under the objects drawn by hand,
as layout objects drew before course objects), `seq` in the order
templates (by seq, array order), then sheets (likewise). The template and
sheet rows keep their page-anchored objects in order; a club template's
map-anchored objects (`club_map_templates.payload`, never drawn: the
import has always dropped them) are removed.

**Guard.** An object with no course-object kind is **refused, never
dropped**: a solid fill (`solid_fill`), a stroke that is not purple on a
line (`coloured_line`) or an unfilled shape (`coloured_stroke`), a stroke
on a white-out or white-out outside (`stroked_whiteout`), an area of
fewer than three vertices (`degenerate_area`) or a line of fewer than two
(`degenerate_line`), a text without a size, position or colour
(`malformed_text`) or one over the course object's 100 mm once divided
by the enlargement (`text_too_large`), an image without its graphic
(`image_without_graphic`), an unknown kind or fill mode
(`unknown_kind`, `unknown_fill`) — every body that is moved is one
`courseObjectBodySchema` reads back. The migration raises `F12 guard: …` with the count per reason and
lists each object (event, table, row seq, object id, reason) in the
error's detail; nothing is changed. A soft-deleted event
(`events.removed`) is not guarded: its refused objects are removed with
the move (E5's precedent). Objects that draw nothing — no fill and no
stroke, an empty text — are removed and counted. A second run finds no
map-anchored object and changes nothing.

**Toner saver white** (P1). A white-out outside fills its own row,
`course:toner-saver-white` ("Toner saver white", CMYK 0/0/0/0), which
`courseLayer` appends to `layer.colours` above every other row — upper
purple, document colours above it (a map's text colours often are) and
the course-object rows — only when it draws one (a `toner_saver` object
and a window; `hasTonerSaver`). Both backends paint in colour order, so
the ring is the map layer's last pass: outside the shape nothing of the
map layer shows — map ink and text, 709 / 707 / 711 objects, text
objects, and the course overprint itself (a generated hull keeps the
course 25 mm inside). The page layer (page objects, the description
block) comes after the map layer and stays on top. At upper white, below
upper purple and the object rows, the ring let 709 areas and text show
through on screen and in print (feedback 2026-11-06 item 2;
`docs/bugfix-toner-saver-draw-order.md`). A page-anchored
`whiteoutInverted` is the page layer's and keeps upper white
(`course-print.md` §4.4).

**The shape may leave the window** (P7). A hull or shape of any size
may reach past the window ring on any side, or lie wholly outside it;
the ring stays the window with the shape as its even-odd hole, so the
white covers the window outside the shape and the shape's part outside
the window, never the shape's inside. Print and the reference raster
fill it even-odd (`f*`, `evenodd`); the GL arena path triangulates it
with the crossing resolved (`map-rendering.md` §5.2 fill row). Before
P7 the GL canvas filled the whole frame white when the shape's first
vertex lay outside the window, or left a white slash when the shape
crossed an edge with its first vertex inside
(`docs/bugfix-whiteout-layout.md`).

Path vertices keep their Bézier handles (the legacy `pathData`'s
construction, deleted in E4c);
closed shapes close implicitly. Layout-object symbols are deduplicated by
content.

## 4. GeoJSON projection (retired in E5) and the derived lengths

`courseLayerGeoJson(layer, courseId?)` projected one course of the layer
onto the `courses.geometry` FeatureCollection, the compatibility artifact
C5 wrote (09 §4 C): one `Point` per positioned item (`{ symbolType,
code, id }`, + `cuts`), then one centre-to-centre `LineString` per leg
(`{ symbolType: "leg", from, to }`, + `gaps`), at the legacy sizes. E6
moved its last readers to `structure` + `courseLayer()`; it was written
for the v0.5.0 rollback until E5 dropped the column with
`geometry_source`, and the projection (`packages/shared/src/course/geojson.ts`)
went with it. An imported file's own GeoJSON is import-time data only:
the importers read its leg gaps and course-level objects (§6.4, §8) and
store nothing of it. Tests that asserted on the column assert on the
same derivation through `__tests__/helpers/course-drawn.ts`.

### 4.1 Derived lengths (`rebuildCourseLengths`)

`rebuildCourseLengths` (`packages/api/src/course-geometry.ts`, the
writer `rebuildCourseGeometry` was until E5) derives an edited course's
`legs`, `length_source` and (optionally) `length_m` from the layer on
every write that can change them, inside the write's transaction and
before its `course.upserted`:

- **Input**: the sequence `loadCourseSequences` builds by the one
  sequence rule (`courseSequenceOf`, §6.2 "Readers") as a v1 `structure`
  with one item per entry (`role` = the entry's type) over `controls`
  rows as sites (`editorCourseLayer`); no layout objects, appearance,
  view options or cut features (a leg's length is centre to centre). A
  structured course's entries carry the stored leg into them, by
  `"<previous site>><site>"` over consecutive stored items (the
  `carryLegs` convention; a pair the course runs twice takes each
  visit's own stored leg, in order): a leg's `bends` reach the layer, so its
  length is measured along them (§10.1, F1), and so does its crossing
  point when the site is live and positioned (`GeometrySeqControl.via`,
  §10.3, F4) — moving the crossing point re-measures the courses running
  through it (`control.update`'s dependants include them). Style, gaps
  and corridor never change a length. An entry with no stored predecessor
  item (a default start from the columns) has a straight leg.
- **Sizes**: the ISOM stack at factor 1 (user decision 2026-10-24);
  `courseLayer` cannot throw `CourseStackError` on that fixed stack.
- **`legs` / `lengthM`**: from the layer's derived legs
  (`legDistancesMm(layer)` = `legLengthMm(leg.points)`: centre to centre
  between consecutive positioned items of `derivation.courses[0]`,
  through the leg's bends — the flattened curve when they carry
  handles, §10.1, F13), `Math.round(d × scale /
  1000)` per leg joined with `;` and a trailing `;`, the total rounded
  once; free-order courses leave both alone; `updateLength: false` (map
  upload, rotation, position-less import) keeps `lengthM`. The distances
  are the pre-E6 sequence formula's bit for bit (unit parity test over
  repeated visits, unplaced controls and 50 generated sequences at two
  scales), so no stored length changed; a bent leg is the sum of its
  segments by the same formula, a curved one the sum over its flattened
  polyline (5 µm, F13 — corner legs are bit for bit as before).
- **`length_source`**: `'derived'` when the layer has at least one
  positioned item (`hasPositionedItems`), else NULL — what the export and
  the Eventor sync read (`course-controls-and-matching.md` "Course
  length").
- **Call sites**: course create / update / sequence edits / order mode,
  control create / move / delete / restore, copy, a position-less import;
  a map upload and a rotation correction re-derive the legs of the
  event's `length_source = 'derived'` courses for the new scale and
  re-emit them without advancing their token. The **Auto cuts** toggle
  re-derives nothing (§3.4).

### 4.2 Cut features

`loadEventCutFeatures(db, eventId)`
(`packages/api/src/event-map-objects.ts`), skipped when the event's
**Auto cuts** toggle is off:

| Event | Source | Radii |
|---|---|---|
| a pinned document (`map_files.document_hash` of the latest row), whatever `map_pipeline` (`map-storage.md` §4.6) | `cutFeaturesOfDocument` of the pinned document, memoised per hash | what the document draws (§3.4) |
| no map, no pin yet, or a missing / unreadable document | — | no cuts |

Slice E1 removed the OCAD source (the parse of the latest upload with
`cutFeaturesOfSlimObjects`): on the fixture and the five corpus maps the
document's features equal the OCAD adapter's within 1e-6 mm in x, y and
r when compared on source codes (`document-readers-parity.test.ts`,
`map-storage.md` §4.6 "Parity"); an applied symbol match can change a
feature's code — the document rule. Since E5 nothing stores cuts: the
GL layer and the print compute them at draw time from the pinned
document, so a new pin or a re-match is reflected on the next draw.
Server-side, `loadEventCutFeatures` is read by the tests that check what
the layer draws for a stored course (`overprint-cuts.test.ts`); no
production path reads it since the artifact's writer went.

### 4.3 Migration

Retired. `OVERPRINT_CUTS_VERSION` (1 OCAD-parse cuts, 2 knolls and rocks
only, 3 written by the course layer with size-aware cuts) stamped
`events.overprint_cuts_version` on the writes that rebuilt the stored
artifact; E6 deleted the lazy read-migration (`ensureOverprintCutsCurrent`)
and E5 dropped the constant with the column and the artifact.

### 4.4 Comparison

**Retired in E6** with the structure backfill (§6.4): the modules
(`course-geometry-report.ts`, `course-geometry-compare.ts`) and their
tests are deleted; this section and its numbers stay as the record (the
09 §10 fidelity input). `course-geometry-report.ts` over the pure
`course-geometry-compare.ts` read every event of the database, built
what the writer would store and compared (read-only). Its CLI,
`pnpm --filter @oxygen/api geometry:compare` (`scripts/compare-course-geometry.ts`,
which wrote `report.md` + `courses.json` to `.local/course-geometry/<date>/`),
went in E4a.

- **Editor courses** — stored vs written now, per control circle and per
  leg: same / changed / added / removed, with the opened width before and
  after (degrees, mm); rows whose points moved since they were stored
  are reported as stale — their moved controls and legs are not
  compared and the row is left out of the cut totals. (Until E1 the
  report also compared the OCAD-parse and document feature sources; the
  parity test replaces it, §4.2.)
- **Imported courses** — the 09 §10 *legacy-geometry fidelity* input to
  slice D's `LegProps.path` decision: legs, legs drawn as file pieces,
  **bent** legs (a piece more than 0.1 mm off the centre-to-centre line —
  what structure v1 without a per-leg path cannot draw), the largest
  bend, controls with authored cuts against the automatic ones
  (overlapping / authored only / automatic only), and course-level
  features by kind.

| Run | Events | Editor courses: cuts same / compared | Imported: legs / bent / authored-cut controls |
|---|---|---|---|
| Integration fixture (`overprint-cuts`, 2 events) | 2 | all same, 0 stale, document vs OCAD 0 differing | 1 / 1 / 1 (synthetic) |
| Club database (dev copy, 2026-10-24, before the v3 lazy rebuild) | 7 (6 `legacy`, 1 `vector`; 6 with a document) | 18 courses, 0 stale: circle cuts 44 same / 142 compared (40 changed, 52 added, 6 removed; opened 3602° → 4721°), leg gaps 70 same / 152 (24 changed, 42 added, 16 removed; 118 → 134 mm); document vs OCAD source differs on 16 of 18 | 261 legs / 257 pre-clipped / 0 bent (max 0.09 mm) / 125 controls with authored cuts (62 ∩ automatic, 63 authored only, 49 automatic only); description_box 70, marked_route 13 |

The club run is the coordinator's after merge (the dev database is off
limits from a worktree); its numbers go into this table. Before the
version bump migrates them, stored editor rows are the v2 cuts, so the
run measures the size-aware change itself.

## 5. Viewer

Under `vector` the viewer draws the layer through the WebGL2 backend's
dynamic bucket (`map-rendering.md` §5.2 "Dynamic bucket"; 04 §7): the
worker runs `courseLayer` on the request plus the document context and
the cut features it extracted at load, symbolises the layer alone and
prepares one always-resident part drawn in colour order with the static
buckets. The React SVG keeps the UI layer only (`map-rendering.md` §5.4
"Overlay").

**Request** (`packages/web/src/lib/course-layer-request.ts`, pure):

| Input | From the viewer |
|---|---|
| `sites` | every visible control (`visible !== false`) with a position — its own paper mm, the editor's dragged position or a move still round-tripping — `code` its display code, `kind` from its type (`overlayTypeOf`: `course.controlCoordinates`' `kind`, else the wire status 4 / 5; an exchange is a `Control`); the editor's faded off-course controls are left out (the UI layer draws them faded). Crossing and map-issue points are always visible to the request (`MapPanel`): the layer decides when they draw (§10.3) |
| `structure` | the highlighted courses (`highlight` or `highlightCourseName`) in order, one `CourseStructure` each, `id` = the course name, `items` = its control ids (start and finish as `MapPanel` completes them), `orderMode` the course's; `null` when none is highlighted. A course with variation groups in the editor (`course-editor.md` §12) is drawn as the editor shows it (`MapViewerEditorProps.courseOverride`): its overlay's controls, legs and hidden numbers replaced by the displayed path's, and in All variations the tinted branches added highlighted, each with its `tint` (§12.7) |
| `labelOffsets` | the single highlighted course's, with a drag or a pending label move winning — only with the description sheet or the editor |
| `leg`, `numberHidden`, `circleGaps` | from the stored structure (§6.4), not from the GeoJSON: each item's `leg` whole — `style`, `bends`, `gaps`, `corridor`, `crossing` (§10) — from `course.list`'s `legs` (keyed `"<from>><to>"`, public control ids; `layerPropsOfStored` maps `crossing.controlId` to the site's public id as a string, the viewer's site id, drops a crossing naming an unknown control and omits an empty leg; a pair visited twice keeps its last visit's leg) — or, for the selected leg while a bend or grip is dragged, the editor's **leg draft** (its live bends, merged after the course override, `withLegDraft`; held after the release until the list carries them; F21, `course-editor.md` §6.7), `numberHidden` from its `hiddenNumbers`, each site's `circleGaps` from `course.controlCoordinates`. A course with no stored structure has none (the automatic cuts); 707 / 708 / 709 / 711 are course objects (`objects` below) |
| `viewOptions` | `labelMode: "sequence"` for one ordered course with the sheet or the editor, else `"code"` (several highlighted courses show codes; All variations adds `labels` — numbers — when the variants number alike, F15, §12.7); `allVariations` when a highlighted course has a `tint` (§12.7); `labels` merged from the highlighted courses that carry one (the All-variations spine, F15); `allControls` when a drawn site other than a crossing or map-issue point is on no highlighted course; `autoCuts: false` when the event's toggle is off (`course.getOverprintCuts`, read by `MapPanel`; no key when on, §3.4); `setterMarks` (§10.3) in the editor's Course and All-controls views (not Class view: the class's print has none) and, in Layout mode, on the all-controls sheet (no course highlighted) |
| `objects` | the event's course objects in scope of the highlighted courses (`courseObjectsForView`, §8.2; `all`-scoped only when none is highlighted), without scope, `z` or token — `MapPanel` fetches `courseObject.list` and hands them to the viewer; no sheet's layout objects reach the viewer |
| provisional visit | the editor's armed `S` / `K` / `M` (`course-editor.md` §6.1), with exactly one highlighted course: a site `provisional` (`PROVISIONAL_SITE_ID`, the tool's kind, the cursor, the next code) — or a reused site by its id, which adds no site (`provisionalDrawn` is false; the editor then draws its own ghost circle, `course-editor.md` §6.1) — spliced into the course's items (`spliceProvisional`): a control before the `insertAt`-th control visit (repeats counted), else before the finish, else last; a start replaces the course's start, a finish its finish (else they lead / end). The leg the visit splits takes no stored leg — no gaps, style, bends or corridor (they are keyed by the drawn neighbours) |
| `appearance` | `{}` — the spec sizes × the document factor (decision "Sizes") |
| `layout` (Layout mode, D7) | the sheet as `composePage` passes it (`course-layout.md` §1): the course objects (the sheet's layout objects are the page part's since F12, §3.6), `appearanceFromTemplate(template.appearance)` instead of `{}`, `window` (the frame grown by `RING_BLEED_UM`, `course.mapLayerWindow`) and `textValues`; and `page`, which the worker turns into the page part (`map-rendering.md` §5.2). So the course changes size on a mode switch when the template's multipliers are not 1 — the preview is the print |
| `cutFeatures` | added by the worker: `cutFeaturesOfDocument(doc)` once per document load |

**Reply.** The derivation (sites with number positions and leaders, legs
with their drawn pieces), the symbol sizes and the hit index come back with
the part; the UI layer sizes its rings from them, the editor hit-tests the
index (`map-rendering.md` §5.5) and
the viewer mirrors the drawn numbers and legs as a hidden DOM list
(`map-rendering.md` §5.4 "Attributes").

**Unaligned stack.** A document whose stack throws `CourseStackError`
draws no course, with a notice, until it is re-imported (§1;
`map-rendering.md` §5.4 "Fallback").

## 6. Structure

Slice D row D0 (research 08 §4.2, §4.3, §4.8). A course is stored as a
**structure**, `courses.structure JSONB` — the §2 `CourseStructure`
type widened to the whole 08 §4.3 item union so slice F never reshapes
the column. `NULL` means "not written yet": every reader then reads the
columns of §6.2, which describe the same course.

### 6.1 Stored shape

```ts
// packages/shared/src/course/structure.ts — courseStructureSchema (Zod)
{ version: 1, id, orderMode: "ordered" | "free_order", items: Item[] }
Item =
  | { kind?: "control", siteId, role?: "control" | "start" | "finish",
      leg?: LegProps, numberHidden?: boolean }            // leg = the leg *into* the item
  | { kind: "variation", id, alternatives: { label, items: ControlItem[] }[] /* ≥ 2 */, loop? }
LegProps = { style?: "line" | "marked_route" | "none", gaps?: { from, to }[],
             corridor?: { widthM, edge, whiteMm, whiteOpacity },
             crossing?: { controlId, section? },
             bends?: { x, y, hIn?: { x, y }, hOut?: { x, y } }[] }  // pathVertexSchema (F13)
```

- **Bends are path vertices** since F13 (`pathVertexSchema`, the course
  objects' vertex): paper mm, handles as offsets from their vertex, both
  optional, so every stored corner bend parses unchanged and there was no
  migration. The handle fields follow the vertex schema (unknown keys in
  a vertex are dropped, as in a course object's geometry); a non-finite
  handle is refused. What a handle draws: §10.1.

- **Site ids** are control UUIDs in the column (journal-portable; a
  public id is a punch code and can change). The tRPC **wire form**
  (`courseStructureWireSchema`, `course.setStructure` input,
  `course.detail.structure`) carries public control ids instead; the
  server maps at the boundary (AGENTS §7: "tRPC inputs use seq").
- **Rules** (Zod; issue messages are the codes): alternatives hold
  controls only, so groups never nest; a group is never first or last
  (`VARIATION_UNANCHORED`) nor next to another group
  (`VARIATION_OVERLAP`); group ids and alternative labels are unique
  (`VARIATION_ID_DUPLICATE`, `VARIATION_LABEL_DUPLICATE`); at least two
  alternatives — an empty alternative is a straight leg from anchor to
  anchor (user, 2026-11-07, slice F answer 5; F6). **All of them may be
  empty** since F7: *Create variation here* writes A and B empty in one
  `setStructure` (`course-editor.md` §12), so F6's refusal
  `VARIATION_ALL_EMPTY` became an advisory check of the same code (§9.2;
  decided on the user's standing instruction 2026-11-07, for review —
  answer 5's "not all of them" and its "saves at once" cannot both hold
  for a new group). Such a group materialises identical variants under
  distinct keys until a control lands. Rules that need the sites
  (`structureSiteIssues`, called by `course.setStructure` since F4):
  unknown site (`SITE_UNKNOWN`, a leg's crossing point included), a group
  holding a map exchange (`VARIATION_CROSSES_EXCHANGE`), a crossing or
  map-issue point as an item, top level or in an alternative
  (`SITE_KIND_NOT_ITEM`: they are never items, slice F split), a leg
  `crossing` naming a site that is not a `crossing_point`
  (`CROSSING_KIND`). `setStructure` answers the first with
  `PRECONDITION_FAILED` (`<code>: control <public id>`) and writes
  nothing. Items and legs are strict objects: unknown keys are refused,
  not dropped.
- **`crossing.controlId`** is a site reference like `siteId`: a UUID in
  the column, a public id on the wire (`legPropsSchemaOf(siteId)`;
  `structureToWire` / `structureFromWire` map it, in alternatives too).
  `structureSiteIds` lists the crossing points after the items, so every
  reader that resolves a structure's sites resolves them, and
  `coursesNamingInStructure` names the courses whose legs run through a
  site.
- **Not stored**: `labelOffsets` (one source, `course_controls`; readers
  fill them in, the wire form carries them), and C0's interim
  file-authored `leg.path` / `pieces` / item `circleGaps` / `extras` —
  the slice D split decided "no `LegProps.path`": authored circle cuts
  are `controls.circle_gaps`, authored leg gaps `LegProps.gaps`, 707 /
  708 / 709 / 711 course objects (§6.4).
- **Groups are materialised** into child courses, one per variant, in
  the write's transaction (§12, F6). The three slice-F kinds are
  accepted since F4: a map exchange is an ordinary item, crossing and
  map-issue points are refused as items (above).
- Helpers: `linearStructure(id, items, { orderMode, labelOffsets })`,
  `structureControlItems` / `structureControlIds` (a group by its first
  alternative — 08 §4.3's root path), `structureDiff` (§7),
  `hasVariations`; for variants (§12, `variants.ts`)
  `materialiseVariants`, `variantStructure`, `variantCount`,
  `structureSiteIds` (every alternative), `pruneSiteFromStructure`.

### 6.2 The column mirror

What timing, export, the kiosk and the Courses page read stays in the
flat columns, written **in the same transaction** as the structure and a
pure function of it (`splitStructure`, `packages/api/src/course-structure.ts`):

| Structure | Columns |
|---|---|
| a leading item whose site is a start | `start_name` = that site's name (else `""`) |
| a trailing item whose site is a finish | `finish_control_id` (else `NULL`) |
| a leading / trailing *control* with `role: "start"` / `"finish"` | `first_as_start` / `last_as_finish` |
| every other item, in order | `course_controls` (`position`, `control_id`, `number_hidden`; label offsets from the wire form's `labelOffsets`, else kept per control) |
| `orderMode` | `order_mode` |

The structure names only what the course **explicitly** references: a
course that uses the event's default start (lowest-seq start, `start_name
= ""`) has no start item, and the readers complete it exactly as before,
so creating a new start still re-points those courses. This is a
deviation from 08 §4.3's "items start … finish", read as *explicit*
items (decided 2026-10-31 by the coordinator on the user's delegation,
decision log "D0"): legacy re-pointing of implicit starts is unchanged,
D1's backfill is a pure function of the columns, and the new editor
makes a course explicit on its first save. The inverse,
`structureFromColumns`, gives every course written before D0 the
structure its columns describe (`course.detail` reports
`structureStored: false` for those). The columns can hold legacy state no
structure expresses — `start_name` beside `first_as_start` (the name is
ignored), the flags on a course without controls, the name of a deleted
start (matches no live start). Rewriting the structure *from* the columns
(`course.update`, `bulkUpdate`, `control.delete`) writes the column only
and leaves such state alone; every reader resolves it the same way as
before D0. `course.setStructure` writes the columns from the structure
and so normalises it.

**Who writes it.** `course.setStructure` (the structure is the input);
`course.update`, `course.create` and `course.bulkUpdate` (the linear
shortcut: the structure is rewritten from the columns they wrote, an
item keeping its `leg` when it still follows the same site);
`course.clone` (the source's structure); `control.delete` (the courses
whose `course_controls` or stored structure name the control lose the
item, an explicit start / finish included); `control.update` changing a
site's **kind** (the stored structures that name it are re-mirrored:
`splitStructure` now reads the site differently — a control that became
a start leads its course as the explicit start). A start is found by
name in `start_name`, so a site turned into a start without a name
mirrors as `""` and the legacy readers fall back to the default start;
name a start when creating it (the editor's **Add start** does). `course.importCourses` resets it
to `NULL` until D1 makes the importers write it. Peers apply it from the
`course.upserted` payload like any column. A root with variation groups
is written through `setStructure` only — the linear shortcuts refuse
its sequence fields (`ROOT_HAS_VARIATIONS`) — and its variants by
`syncVariants` alone (§12) — except `control.update { kind }`, which
re-mirrors every stored structure naming the site, a variant's included,
with the same result; `control.delete` prunes a root in every
alternative and re-materialises it.

**Readers.** One rule, `courseSequenceOf` (`course-structure.ts`, E6),
used by `loadCourseSequences` (`course-geometry.ts`, hence `legs` and
lengths), the IOF / PPen export
(`course-export.ts`) and the print layout (`layoutCourseEnds`,
`course-print.md` §5.2): the explicit start, the sequence and the
explicit finish from the structure when a valid one is stored, from the
columns otherwise (a NULL structure reads as `structureFromColumns`
describes it — what the editor gets from `course.detail`), and an absent
start / finish completed by the event's lowest-seq one unless
`first_as_start` / `last_as_finish`. Sites are drawn by their kind
(`role` matters to the mirror and to IOF's `@type`), and a soft-deleted
site drops out as `start_name` does (the callers pass live rows only).
A course written through `setStructure` is drawn and measured exactly as
the one `course.update` writes for the same sequence (integration test).

### 6.3 Sites' new fields

| Column | Type | Meaning |
|---|---|---|
| `controls.kind` | ENUM `control_kind`: `control`, `start`, `finish`, `map_exchange`, `crossing_point`, `map_issue` | what the site is (08 §4.2); all six written since F4 (below) |
| `controls.circle_gaps` | JSONB `[{ start, end }]`, compass degrees | manual circle gaps on the site (same in every course) |
| `controls.notes` | TEXT, default `""` | setter / controller notes; writing them needs `courses.review` |
| `controls.checked_at`, `checked_by` | TIMESTAMPTZ, UUID (no FK — journaled to nodes without the users) | field check-off (`control.check`) |
| `controls.version`, `courses.version` | BIGINT, default 0 | the §7 token |
| `course_controls.number_hidden` | BOOLEAN, default false | hide this visit's number (08 §4.2) |
| `controls.description_source` | TEXT NULL, CHECK `auto` \| `manual` (migration `20261102120000_control_description_source`; D6, not in 08 §4.2) | who wrote `description`: `auto` when an autodetect path filled it (`control.create` / `control.update` with `autoDescribe`), `manual` when a write carried an explicit `description` — **a manual edit that equals the autodetect result is still `manual`**; clearing the description clears it to NULL; NULL for rows written before D6 and for imported descriptions (`course.importCourses` writes none: neither autodetect nor a setter's edit) — unknown, never stale. It travels in `control.upserted` with the other portable fields (additive: phase-1 journal consumers ignore it). Read by `DESCRIPTION_STALE` (§9) |

`kind` and `status` 4 / 5 are **kept in sync for one release** (08 §4.8):
`control.create` derives `kind` from `status`; `control.update` writing
`kind` sets `status` (start / finish, else back to `ok` from start /
finish) and writing `status` sets `kind`. The migration backfilled
`kind` from `status`. Readers in the API use `kind`, falling back to
`status` for rows not rewritten yet.

**The slice-F kinds (F4).** `control.create { kind? }` writes any of the
six (default from `status`, as before); `status` follows a start /
finish kind and is otherwise the input's (`ok` when the input said 4 /
5). Crossing and map-issue points are **code-less** (unlike starts and
finishes since F32, below): named `Passeringspunkt N` / `Kartutdelning N` by the server (the
`Start N` / `Mål N` convention), no autodetected description, and given
a seq above `MARK_SEQ_BASE` (10 000) so their public id — the seq, having
no code — never meets a punch code (`uuidsOfPublicIds` resolves codes
first; an allocated seq of 50 named control 50; decided on the user's
standing instruction 2026-11-07, for review). A map exchange takes codes
like a control (it is punched). `control.update { kind }` re-mirrors as
before, but a change that would leave a stored structure invalid is
refused with `PRECONDITION_FAILED`, nothing written
(`assertKindChangeAllowed`): a site that is an item of a course (any
alternative, or a column's start / finish) cannot become a crossing or
map-issue point (`SITE_KIND_NOT_ITEM`), and a crossing point some leg
runs through cannot become another kind (`CROSSING_KIND`), and a site in
a variation's alternative cannot become a map exchange
(`VARIATION_CROSSES_EXCHANGE`).
`control.delete` of a crossing point strips `leg.crossing` from every
structure naming it (`pruneSiteFromStructure`; the token advances, one
`course.upserted` each — also on a course whose structure the delete
rewrites from its columns, which carries the legs over); `restore` +
`setStructure(before)` is the editor's undo. `course.controlCoordinates`
carries `kind`.

**Starts and finishes take a code (F32; user decision 2026-11-12).** A
control's public id is its first punch code, else its seq
(`publicControlId`, `control-id.ts`). A start or finish is a physical
unit programmed with a code (non-control units use codes below 10: 1 is
clear, 2 is normally check), so `control.create { status: 4 / 5 }` or
`{ kind: "start" / "finish" }` **without `codes`** stores the lowest free
code in 3–10, then 11–30 (`lowestFreeStartCode`); when 3–30 are all held
it is refused `PRECONDITION_FAILED` `START_FINISH_CODES_EXHAUSTED`,
nothing written. A code is **free** when it is no numeric part of a live
row's `codes` and no seq of a live row without a numeric first code (a
legacy code-less start with seq 3 holds 3); the duplicate check of
`control.create` / `control.update` refuses a code equal to such a seq
too (`CONFLICT`). The allocation and the row's write are one transaction
under a per-event `pg_advisory_xact_lock`, so parallel creates take
distinct codes. Given `codes`, a start or finish is checked as a control
is; the code is editable (`control.update { codes }`, clearing it to `""`
stays allowed — the legacy shape), and `control.update { kind: "start" /
"finish" }` on a row without a numeric code allocates one the same way.
The code travels in `control.upserted` with the row. So a new start's
public id is its code, and the seq-as-id that once met a punch code (a
start with seq 80 beside control 80, `bugfix-first-leg-from-start.md`)
is not handed out any more. **Existing code-less starts and finishes are
left as they are** (no backfill; user decision): they keep the seq
fallback, and their seq counts as held. **Display:** a start or finish
is shown by its **name** — `displayCode` (`control-id.ts`): start /
finish → name, else code, else seq; every other site code → name → seq —
on map labels and sites (`course.controlCoordinates.code`, the layer's
`site.code`), sheets, check params and the IOF / Purple Pen export `Id`;
the code is for ids and punch matching, and the Controls page's code
column shows it. ROC / online-input punches keep the event's mapping
table (out of F32's scope).

### 6.4 Importers and backfill

Slice D1 (user: "nothing of an imported course lives only in the
GeoJSON"). The row names this "§6.3"; §6.3 is the sites' fields, so it
is the next number.

**Importers.** `course.importCourses` (OCD, Purple Pen, IOF; through
`resolveImportAlignment` as before) writes, per course, `persistStructure`
of a linear structure beside the geometry — start, controls and finish
all **explicit** as the file names them (so `finish_control_id` is set
where the import used to leave it NULL; D0's choice (a): the structure
names what the course explicitly references) — and the mirror follows.
`orderMode` is the file's. An existing course keeps its label offsets
(`persistStructure`'s default), where the old `deleteMany` / `createMany`
dropped them. From an **OCD** file, with positions:

| File | Becomes |
|---|---|
| 703 slits (`ParsedControl.cuts`, now filled by the parser) | `controls.circle_gaps` — the file's cuts are the effective set: a control without any gets `[]`. IOF / PPen files carry none and leave the column alone |
| 705 pieces (and OCAD 2018's two-point 704) of a leg | `LegProps.gaps` on the item the leg runs into: the pieces are projected onto the centre line, the uncovered stretches between the first and last piece are the gaps (fractions, four decimals); the clearance at the circles is not a gap, nor is anything narrower than 0.2 mm (touching pieces). No bends are stored: the club run found 0 of 261 (§4.4) |
| 707 lines | `marked_route` objects |
| 708 and 709 lines | `oob_line {}` (708) |
| 711 lines | `oob_line { symbol: "711" }` |
| 709 polygons | `oob_area {}` (no border); the closing vertex is dropped |

Every object is scoped to the courses of the file whose geometry carries it
(`{ courses: [uuid], classes: [] }`: the T-code map for 707, every course
of the file for 708 / 709 / 711), never `all`.

Identical objects (kind, props, geometry) across courses are one object.
The 704 leg-cut polygons and the 760000 description box are not objects
(the first is a masking device for legs the layer cuts itself, the second
is the description sheet): they stay in the stored GeoJSON for its legacy
consumers. 708 lines are new to the parser (`restricted_line`, `sym`
708000). Objects are written with `writeCourseObject` and marked
`course_objects.source = 'import'` (migration
`20261101130000_course_objects_source`, nullable, not on the wire): an
OCD import first deletes the `source = 'import'` objects whose scope names a
course it rewrites and writes the file's, so a re-import replaces exactly
those: never an object drawn in the editor, nor another file's (an event can
be fed from more than one file). A backfilled row (same marker) is superseded
by a re-import the same way. An import with positions sets
`length_source = 'file'` (the file's published length); the file's
GeoJSON is import-time data only — E5 dropped the `courses.geometry` /
`geometry_source` columns it was also stored in. An IOF / PPen re-import
(a format without leg gaps) of an existing course writes the file's
positions, length and a linear structure whose stored legs (`LegProps`:
gaps an OCD import or the editor wrote) are carried where the leg still
runs between the same two sites (`carryLegs`), and leaves `circle_gaps`
alone (the XML carries none). Until E5 that carry applied only over an
`ocd`-sourced course (the column said so); with `geometry_source` gone
it applies to every existing course, so a gap-less file never clears
authored gaps — the rule `circle_gaps` already followed (decision log
2026-11-07, E5). (The older "keep the OCD geometry unless the controls
drifted > 30 m" rule never fired — `bugfix-stale-ocd-course-geometry.md`;
E6 deleted `isOcdGeometryStaleVsXml`.) **PPen `<gaps>` are not read**
(no fixture, no research record; Pending).

**The structure from IOF and Purple Pen files** (row F9;
`iof-coursedata-export.md` "Importing it back", `ppen-import-export.md`).
Each item's leg is the file's leg props joined (`importedLegProps`,
`course-import-structure.ts`): the gaps above (OCD), a Purple Pen
`<leg>`'s **bends** (drawn into the parser's leg feature, so the import
alignment moves them; read back by `legBendsOfFeatures`), an IOF
`TapedRoute` / `FunnelTapedRoute` as `style: "marked_route"` and an IOF
`CrossingPoint` row as the leg's `crossing` (`section` for
`MandatoryOutOfBoundsAreaPassage`). The crossing point itself is a
code-less `crossing_point` site named by its IOF `Id`, seq above
`MARK_SEQ_BASE` (§6.3), matched on a re-import by name among the crossing
points only — never an item, and never a control row rewritten into one.
An IOF `Extensions` map-exchange marker makes a **new** site
`kind: "map_exchange"`; an existing site keeps its kind (the F4 kind-change
rules are not re-implemented in the import's raw writes). Courses of one
`CourseFamily` import as separate linear courses — no variation group is
inferred (§12); the family is shown on the preview's course rows. A free
order course takes no leg props. On a re-import `carryLegs` merges: the
file's props win, the stored ones fill in what the file is silent on
(an IOF file has no bends, a PPen file no style), so an IOF / PPen round
trip keeps what the editor authored (decided on the user's standing
instruction, 2026-11-07, for review). Two consequences: a file cannot
*remove* a crossing point or a marked route (a leg without them is
indistinguishable from a silent one — a leg loses them in the editor),
and carried bends are paper-mm points, so a leg whose controls the file
moves keeps bending through the old points until the setter moves them
(gaps are fractions and follow the leg).

**Tokens.** One HLC is taken for the `reference.imported` entry before its
payloads are serialised and stamped on the `courses.version` and
`controls.version` of every row the import wrote, so an editor open on
any of them gets a version `CONFLICT` on its next write (§7), and a peer
applying the entry holds the same tokens. Course objects take their own
token. Rows the import soft-deleted under `replaceAll` are stamped too. The
import is not atomic (structure, objects, tokens and the journal entry are
separate statements, as before: a crash in between is repaired by running it
again). Import-time `differing` is `null`: `basePayload` reads
`course.upserted` / `control.upserted` entries only, not the rows inside
a `reference.imported` one (Pending).

**Backfill** (research 09 §5) — **retired in E6**: E0 ran it on prod
(every live course has a structure, `release-slice-e.md` §0) and every
write path stores one, so the module, its CLI, the Maintenance card,
`event.structureBackfill*`, their tests and the E2E spec are deleted. A
course still without a structure reads from its columns (§6.2), but an
`ocd` course's authored gaps, cuts and objects that only its GeoJSON
holds are not recovered any more: an instance upgrading from before
slice D runs v0.5.0's backfill first (`release-slice-e.md`). What it
did, as the record: `pnpm course:backfill-structure
[--event <nameId>] [--dry-run] [--out <dir>]` and the Maintenance tab's
"Course structures" card (`event.structureBackfillStatus` / `…Start`,
admin, synchronous, all events) filled `structure` where it was `NULL`
(`removed = false`):

- the structure is the one the columns describe
  (`loadExplicitStructure`); only the `structure` column is written (like
  `rewriteStructureFromColumns`: the flat columns stay as they are), no
  token is advanced and nothing is journaled — it derives what the columns
  already replicate;
- an `ocd` row also takes its stored GeoJSON's authored data, when the
  geometry's control points are the structure's control sites one for one
  (else the report says so and moves nothing); the start and finish points
  are matched to a start / finish item when there is one — a row the old
  importer wrote has no finish item (`finish_control_id` was never set) and
  often a start by name only (`alignPointsToItems`): leg gaps from the pieces, cuts into
  `controls.circle_gaps` where the control's is empty, and the objects
  above — each `source = 'import'`, an equal object already imported is
  not written again and a course-scoped one only adds the course to its
  scope;
- **one transaction per course** (`BEGIN … COMMIT`, the course row locked,
  `structure IS NULL` re-checked inside): a failed course is reported and
  rolled back, the others continue; a second run finds nothing to do;
- the report compares, per course, the stored GeoJSON with what the layer
  regenerates from the new structure and the controls' cuts (§4.4's
  comparison): the points' bounding box and the controls' positions
  (largest shift, mm), the circle cuts (compared / same) and the legs the
  file drew as pieces against those that regenerate with a gap. The CLI
  prints one line per course and, with `--out`, writes `report.json`.

| Run | Courses | Bbox Δ / position Δ (mm) | Circle cuts same / compared | Legs with pieces / regenerated with gap |
|---|---|---|---|---|
| Integration fixture (`course-structure-backfill`, 2 `ocd` + 1 editor course) | 3 | 0 / 0 | 1 / 1 | 1 / 1 |
| Club database (dev copy, 2026-11-01: 61 filled / 0 skipped / 0 failed; 21 courses without geometry, 23 `ocd`, 17 editor) | 61 | `ocd` ≤ 15.67 / ≤ 0.064; editor ≤ 21.05 / 0.000 (positions match; the bbox shift of editor rows and of demo_competition / E is not analysed — hygiene item) | `ocd` 114 / 114; editor 87 / 141 | `ocd` 17 / 257; editor 0 / 0 |

The club run is the coordinator's after merge (the dev database is off
limits from a worktree, as for §4.4); its numbers go into this table.

## 7. Concurrency

Gate G1, decided by the user 2026-10-31 (decision log): **optimistic
concurrency with a version token**, over the existing journal. A client
edits from a row's token and sends it back; the server refuses a stale
one. (The other designs weighed — last-write-wins with visibility only,
a server-side merge log, a CRDT — and why are in the decision log; the
merge log is the upgrade path if real use shows frequent structure
conflicts, and would sit on the same token.)

**Token.** The HLC of the journal entry that last wrote the row — its
`course.upserted` / `control.upserted` — mirrored onto `courses.version`
/ `controls.version` in the same transaction as the emit: the emit takes
the clock reading, stamps the row, then reads the payload, so the entry
carries the token it set and a peer applying it holds the same token
(`referenceJournal.ts`). `0` for rows written before D0. On the wire it
is a **decimal string** (`version`, `baseVersion`): an encoded HLC
exceeds 2^53 and tRPC runs without a transformer.

**Separate tokens.** `course.setStructure`, `course.update` and every
other write of the course itself advance the course's token;
`control.update` and `control.check` the control's. A control move
rebuilds its courses' geometry and re-journals them **without** advancing
their token (`emitCourseUpserted(…, { advanceVersion: false })`; so do
the map-upload and cut-setting rebuilds), so a structure edit and a field
move never conflict with each other. `control.delete` advances the
token of the courses whose structure lost the control, and a site's kind
change the token of the courses re-mirrored for it (§6.2): the course as
timing reads it changed.

**Writes.** `course.setStructure`, `course.update` and `control.update`
take an optional `baseVersion`. Inside the write transaction the row is
locked (`SELECT … FOR UPDATE`) and its token compared; a mismatch is
tRPC `CONFLICT` with

```ts
data: { kind: "course" | "control", id /* public id */, version, current, differing }
```

beside tRPC's own `code` / `httpStatus` / `path` (`errorFormatter` in
`trpc.ts`; the client narrows with `versionConflictOf(error.data)` —
the duplicate-code `CONFLICT` has no `kind`). `version` and `current`
are the server's row now: the wire-form structure (course) or the
control's editor fields. `differing` compares the client's **base** with
that row — the item ids (public control ids; a group by its id) outside
the longest common subsequence of the two item lists, plus sites whose
label offset changed (`structureDiff`), or the control's field names
(`controlFieldsDiff`). The base is read from the journal: the entry
whose HLC is `baseVersion` *is* the row as the client saw it. When that
entry is not on this node (token `0`, or pruned) `differing` is `null`.
`baseVersion` stays optional for one release so clients that predate it
keep last-write-wins; importers and the backfill send none (they replace
by design). Course objects carry the same token per object (§8.4).

**Client rules** (the new editor, D4 / D11). A **field move** on a stale
control is re-sent with the fresh token automatically when the other
side changed only fields the move does not touch (description, code,
notes, kind, circle gaps, checked); when the other side also moved it,
the editor shows "moved by X at T" with both positions and the user
keeps one. A **structure edit** on a stale structure is never merged: the
editor refreshes, re-renders the sequence with a one-line notice naming
the differing items, and the user redoes the edit — concurrent
reordering is always a conflict, by design.

**Courses page, Layout mode and the editor's write client.** They send
the token through the same mutations: a `VersionBook`
(`packages/web/src/lib/version-book.ts`) keeps the newest token per row
from the list refetches and each mutation's result — `course.update`,
`control.update`, `course.setControlLabelOffset`, `course.create` /
`clone` return the row's token, `control.delete` the tokens of the
courses it advanced — so undo / redo and back-to-back writes send their
predecessor's token; on a version
`CONFLICT` they invalidate and show "Changed elsewhere — reloaded"
(`courses:changedElsewhere`). One rule for every writer of the same rows.

**Presence and live refresh** (D11; `course-editor.md` §11). No new push
channel: a heartbeat `course.presence { courseId, mode, clientId }` upserts
a row in `course_presence` (`(course_id, client_id)` key, `ON DELETE
CASCADE` with the course and the event; a table because up to two Cloud
Run instances serve one event, so not process memory) and answers the
event's other live rows. TTL **30 s**: a row older than that is neither
shown nor kept (the next heartbeat of any client sweeps the event's stale
rows). The editor sends it every 5 s, the cadence of the existing
`useExternalChanges` poll; it is a mutation of its own because the poll's
`competition.counterState` is a read-only counter query and presence is
volatile, never journaled or shipped to peers. Live refresh is cache
invalidation, not journal replay: the `oCourse` / `oControl` watermarks
already invalidate the `course` / `control` queries, and a course token the
client did not write earns a one-line notice. "Moved by X at T" reads
`actorId` and the physical part of `hlc` of the row's last `*.upserted`
journal entry (`course.lastChange`, `control.lastChange`).

**`map_patches` (slice G, no code).** Patch operations are idempotent and
commutative: each op is keyed by `(object id, op id)` and sets a state
(hidden, colour override, …) rather than applying a relative change, so
applying twice equals once and two devices' patches merge through the
journal in any order.

## 8. Course objects

Row D2 (research 08 §4.5, §4.8). Purple / white objects stored per event
with a **scope**, drawn by the layer with the course on screen and in
print: out-of-bounds areas and lines, white-outs, a toner saver, free
marked routes, map text and logos, and filter regions. They are the
stored, scoped kind of a sheet's map-anchored layout objects, which F12
moved into them (§3.6).

### 8.1 Table and kinds

`oxygen.course_objects` (migration `20261101120000_course_objects`):

| Column | Type | Meaning |
|---|---|---|
| `id` | `UUID` `uuidv7()` | row id |
| `event_id` | `BIGINT` → `events` `ON DELETE CASCADE` | |
| `seq` | `INT`, `allocate_event_seq` | public id on the wire; unique per event |
| `kind` | `TEXT`, CHECK over the nine kinds below | |
| `geometry` | `JSONB` | `PathVertex[]`: paper mm, y-up, the layout path's vertex / Bézier shape (`{ x, y, hIn?, hOut? }`) |
| `props` | `JSONB` default `{}` | per kind, below; stored as on the wire |
| `scope` | `JSONB` | `{ "all": true }` or `{ "courses": [uuid], "classes": [uuid] }` (§8.2); no foreign key |
| `z` | `INT` default 0 | draw order among the event's objects (`z`, then `seq`) |
| `version` | `BIGINT` default 0 | the §7 token (§8.4) |
| `source` | `TEXT` NULL, CHECK `import` / `layout` (migrations `20261101130000_course_objects_source`; D1 deviation from D2's table; `layout` F12) | `import` for what the importers and the backfill wrote (§6.4; a re-import replaces exactly those), `layout` for what F12 moved from a template's or sheet's map-anchored layout objects (§3.6), NULL for an object drawn by hand; not on the wire |
| `created_at`, `updated_at` | `TIMESTAMPTZ` | `set_updated_at` |

`courseObjectBodySchema` (`packages/shared/src/course/objects.ts`)
validates `{ kind, geometry, props }`; props are strict (an unknown key is
refused, not dropped); a geometry of the wrong length is refused with an
issue message starting `OBJECT_GEOMETRY`.

| Kind | Geometry | Props | Drawn as |
|---|---|---|---|
| `oob_area` | ≥ 3 vertices, closed | `border?: "none" \| "solid" \| "dashed"` (default none); `hatch?: "709" \| "710"` (default 709) | 709; 709.b with a solid boundary, 709.c dashed; with `hatch: "710"` the dangerous area's cross-hatch (§3.1) with the same boundaries |
| `oob_line` | ≥ 2 | `symbol?: "708" \| "711"` (default 708) | 708 out-of-bounds boundary or 711 out-of-bounds route |
| `whiteout` | ≥ 3, closed | — | `course:whiteout` at upper white (§3.6) |
| `toner_saver` | ≥ 3: the hull — D13's editor generates the smooth offset hull of the course's sites, so its segments carry `hIn` / `hOut` and the hole ring below has Bézier flags (the hull's own straight edges stay straight) | `marginMm?` (how D5 / D13 generated it, 25 mm by default since D13; the drawn shape is the stored hull), `holeRadiusMm?` (reserved; the editor does not set it and builds no control holes) | white-out *outside* the hull in the toner saver white, the map layer's top row (§3.6, P1): the `viewOptions.window` ring with the hull as an even-odd hole; without a window (the viewer) not drawn, warning `WINDOW_MISSING` |
| `marked_route` | ≥ 2 | — | 707 |
| `text` | 1: the anchor | `text`, `fontSizeMm`, `fontFamily?`, `color?` (hex), `align?` | a text symbol: upper purple, or an own colour row for `color` (§1); `{placeholders}` expanded with `viewOptions.textValues` |
| `image` | 2: opposite corners | `graphicId`, `crop?` | `layer.images` (a graphic of the event), drawn by the page backends |
| `filter_region` | ≥ 3 points, **no** Bézier handles (a polygon; one outer ring) | `{ mode: "clip" \| "hide", symbols: "all" \| idx[] \| { colours }, invert? }` — D3's region exactly | not an object: a `regions` entry (`map-rendering.md` §4.11) |
| `inset_frame` | ≥ 2 | — | reserved for micro insets: typed, refused on write (`PRECONDITION_FAILED`), never drawn |

Sizes are **paper mm at the map's scale**, like the 7xx symbols: the
geometry and a text's `fontSizeMm` are not divided by the print
enlargement (the page transform enlarges them with the map; F12 divided
a moved text's page size once, §3.6). The 7xx kinds take the library's dimensions × the document
factor × appearance (decision "Sizes"): 08 §4.5's per-object width,
cross spacing, dash and white-out opacity are not stored (decision log,
D2).

### 8.2 Scope

An object is drawn with a course when its scope is `{ all: true }`, or
names the course, or names a class that runs it — the class's own
course or a course of its forking pool (`classes.course_id`,
`class_course_pools`). A view with no course (all controls) draws the
`all`-scoped objects only. Both lists empty is a parked object, drawn
nowhere. `courseObjectInScope(scope, drawn | null)` is the rule
(`drawn` = the drawn courses and the classes running them); the API
resolves classes from the tables (`classesByCourse`). The viewer does not
resolve classes itself (`class.list` names a class's own course, not its
pool): every wire object carries `inCourses`, the public ids of the
courses its scope resolves to by the same rule (`null` for `all`), and
`courseObjectsForView` keeps those with a highlighted course among them.

On the wire the scope names courses and classes by public id (`seq`);
the row holds UUIDs. A write naming an unknown course or class is
`BAD_REQUEST` naming it; a course or class removed later simply matches
nothing and drops out of the wire scope.

### 8.3 Drawing

`courseLayer` takes course objects in `objects` beside a sheet's layout
objects (`isCourseObject`: a course object has `geometry`) and draws them
after the course in input order — the caller passes them in draw order —
with `ref = { kind: "object", id: "course-object:<id>" }`. Every
`filter_region` object becomes a region after the explicit `regions`
input, so a stored region acts exactly like D3's (never on the course).

- **Print.** `maps.pdf` (vector path) loads the event's objects once per
  request; each sheet takes those in scope of its course, or the
  `all`-scoped ones for an all-controls sheet (`sheetForMapRow` →
  `SheetInput.course.objects`), and `composePage` hands them to the layer
  with the sheet's objects. Filter regions therefore reach the PDF as
  D3's clip paths by construction (`course-print.md` §5.1).
- **Viewer.** `MapPanel` fetches `courseObject.list` (kiosk-readable;
  cached until reload like `course.list` — a writer, D5, invalidates it),
  keeps the objects in scope of the highlighted courses
  (`courseObjectsForView` over `inCourses`) and hands them to `MapViewer`
  (`courseObjects` prop), whose request carries them (§5); the worker's
  layer lifts the regions. The kiosk map is
  `MapPanel` with the runner's course highlighted, so it draws the
  `all`-scoped objects and that course's. A `toner_saver` is not drawn
  on screen (no frame).
- **Editor.** Hit-testing, selecting, drawing and editing objects are
  the editor's (`course-editor.md` §7, D5); importers writing their 707 /
  708 / 711 lines and 709 polygons as objects is D1.

### 8.4 API and tokens

`courseObject.*` (`packages/api/src/routers/courseObject.ts`), the wire
type `course.CourseObject = { id: seq, kind, geometry, props, scope, z, version, inCourses }`
(`inCourses`: §8.2, read-only):

| Procedure | Access | |
|---|---|---|
| `list` | `courses.view` or the event's kiosk key | the event's objects ordered `z`, `seq` |
| `create { kind, geometry, props, scope, z? }` | `courses.edit` | returns the object with its token |
| `update { id, baseVersion?, geometry?, props?, scope?, z? }` | `courses.edit` | the kind is fixed; an absent field keeps the stored one, a sent one (`null` included) is validated with the rest |
| `delete { id, baseVersion? }` | `courses.edit` | |
| `reorder { ids }` | `courses.edit` | `z` = the position in `ids`; takes and advances no token |

Writes are not lease-guarded: objects are cloud-owned non-critical data
(08 §4.8), like the sheets; a venue holding a checkout keeps its
snapshot's copy until the next checkout.

**Token** (§7). Objects are not journaled, so their token is not a
journal entry's HLC: every `create` / `update` mints one from the node's
clock (`encodeHlc(nextServerHlc())`) and stamps `version` in the same
write. `update` / `delete` with a `baseVersion` lock the row (`FOR
UPDATE`) and compare; a stale one is tRPC `CONFLICT` with
`data: { kind: "object", id, version, current, differing: null }` —
`current` the object now, `differing` always null (there is no base to
diff against). No `baseVersion` is last-write-wins. The client rule is
the structure rule: refresh and redo.

### 8.5 Snapshot and dump

`course_objects` rows travel in the checkout snapshot
(`SNAPSHOT_TABLES`, rows verbatim with their UUIDs, `seq`, scope UUIDs
and token; `map-storage.md` §7.2) and in the per-event dump after
`class_course_pools` (`BACKUP_TABLES`; `map-storage.md` §7.3) — the
venue's kiosk map draws them (08 §4.8; 07 §9.2).

## 9. Checks

Row D6 (research 08 §4.2, §5.6, §6). Advisory course-setting checks:
the editor lists them (`course-editor.md` §8), marks them on the canvas
and counts them on the top bar's course-info button (P2); `course.setStructure` returns them.
**Nothing blocks a save.** `VARIATION_UNBALANCED` and
`VARIATION_ALL_EMPTY` are F7's (the editor's, §9.4); the
crossing-point exemption is F4's (§9.3), `EXCHANGE_WITHOUT_SHEET` and the
per-part sheet test F5's (§11).

### 9.1 The function

`courseChecks(input)` (`packages/shared/src/course/checks.ts`) is pure
and deterministic: paper mm, y-up, like the layer's input (§2).

| Input | Type | Meaning |
|---|---|---|
| `structure` | `CourseStructure \| null` | the course checked (layer form, §2); null = event-wide checks only |
| `sites` | `CheckSite[]` | every site of the event: `{ id, code, codes: number[], kind, x, y, description?: { d? } \| null }`; `x = y = 0` is unpositioned (§3.3) |
| `document` | `{ libraryId, obstacles } \| null` | the base map's library and its obstacles (`checkObstaclesOfDocument`, §9.3); null on a legacy map |
| `sheets` | `CheckSheet[] \| null` | the windows of the course's sheets (`MapWindow` of `course-maps/schema.ts`), each with the part it prints, `section?` (`course_maps.section_index`, §11; absent = every part); null or empty skips `CONTROL_OUTSIDE_SHEET` and `EXCHANGE_WITHOUT_SHEET` |
| `objects` | `CourseLayerObject[]`, optional | the course objects in scope (§8.2); `oob_area` and `oob_line` (708) are obstacles |
| `derivation` | `CourseDerivation \| null`, optional | the layer's result for this course (§1); null skips `NUMBER_*` |
| `mapScale` | `number \| null` | map scale denominator; metres = paper mm × scale / 1000; null skips the distance checks |
| `groups` | `CheckVariationGroup[]`, optional (F7) | the course's variation groups: `{ id, anchor, next, loop, alternatives: { label, items: { siteId, leg? }[] }[], exitLeg? }` — the control before the group, the item after it, each alternative's items with the legs into them, the leg into `next`; absent = none (the server passes none) |

The `structure` the editor passes is its **displayed path** (F7,
`course-editor.md` §12): each group by the alternative the view shows, so
the leg, number and description codes follow what is drawn.

A check is `{ code, siteIds, leg?, at, params? }`: the sites involved
(public ids on the wire), for a leg `{ from, to, index }` (index of the
leg in the course's positioned sequence), `at` the point to locate and
mark (paper mm), `params` what the message shows (`a` / `b` codes,
`distanceM`, `limitM`, `feature`, `code`, `from` / `to`, `symbol`;
`DESCRIPTION_STALE` also carries `suggested`, the column-D code the map
suggests now, which the message does not show). There is no message text: the web formats
it from `editor:check_<CODE>` (AGENTS.md §9). Output order: the table
order below, then the order of the input (sites, then the course's items).

### 9.2 Codes

| Code | Scope | Rule | Threshold |
|---|---|---|---|
| `CONTROL_TOO_CLOSE` | event | two positioned `control`-kind sites closer than the limit, one check per pair, `at` the midpoint | 30 m; **15 m at sprint scale**: the document's library is ISSprOM 2019-2, or (no document) the map scale is 1:5 000 or larger |
| `SAME_FEATURE_TOO_CLOSE` | event | two positioned `control` sites with the same non-empty column D within the limit | 60 m |
| `CODE_BELOW_31` | event | a `control` site with a punch code < 31 | — |
| `CODE_DUPLICATE` | event | a punch code on more than one site | — |
| `CODE_INVERTIBLE` | event | a code that reads as another site's code upside down (digits reversed, 6 ↔ 9, 0 / 1 / 8 unchanged, any other digit not invertible): 66 / 99, 68 / 89, 161 / 191, 86 / 98 …; a code that reads as itself (69, 88, 181) is not a finding | — |
| `CONTROL_OUTSIDE_SHEET` | course | a positioned item of the course outside every window in `sheets` that prints one of the item's parts (§11: on a course split by map exchanges an item is tested against its own part's windows — the exchange against both parts'; a window without `section` stands for every part) | — |
| `EXCHANGE_WITHOUT_SHEET` | course | a course of ≥ 2 parts (§11) with sheets, one part of which has no window of its `section`; `at` and `siteIds` the exchange bounding the part (part 1: the first exchange, part n: the exchange that opens it), `params { part, code }` (`part` 1-based) | — |
| `NUMBER_UNPLACED` | course | a `control` visit (a map exchange counts as a control here and for `DESCRIPTION_MISSING`) whose number is not hidden and that has no label in `derivation` (in practice an unpositioned site); when the derivation drew one part (`DerivedCourse.section`, §11) only that part's visits are tested, by both `NUMBER_*` codes | — |
| `NUMBER_OVERLAPS` | course | a derived site whose label has `collides` (§3.5: the placer fell back to a box that intersects a circle, a number or a line) | — |
| `DESCRIPTION_MISSING` | course | a `control` item whose site has no description or no column D | — |
| `DESCRIPTION_STALE` | course, server | a `control` item whose `description_source` is `auto` (§6.3) and whose stored description differs from the autodetect result at the site's position now (e.g. after a map re-upload) | — |
| `LEG_CROSSES_OOB` | course | a leg (ordered courses; centre to centre between consecutive positioned items, through its bends and its crossing point (§10.3): every segment is tested, `at` is the first hit along the leg, an area's inside test at each segment's midpoint) that crosses or runs inside an out-of-bounds obstacle: document 709 areas and 708 lines, `oob_area` and `oob_line` (symbol 708) course objects; **not** an obstacle the leg's crossing point sits on (§9.3) | — |
| `LEG_THROUGH_UNCROSSABLE` | course | a leg (as for `LEG_CROSSES_OOB`, bends and crossing point included, the same exemption) that crosses or runs inside an uncrossable document obstacle: `UNCROSSABLE_CODES` 201 (impassable cliff), 301 (uncrossable body of water), 307 (uncrossable marsh), 411 (impassable vegetation), 515 (impassable wall), 518 (impassable fence), 520 (area that shall not be entered), 521 (building), 529 (prominent uncrossable line feature) — the same in ISOM 2017-2 and ISSprOM 2019-2 | — |
| `VARIATION_UNBALANCED` | course, editor (F7) | a group whose alternatives' lengths differ by more than the tolerance of the longest (08 §5.6). An alternative is measured anchor → its controls → `next`, along each leg's bends and crossing point (the exit leg's props are every alternative's); an empty plain alternative is the straight leg; in a loop each petal runs anchor → its controls → anchor and empty petals are not compared. One check per group, `siteIds` and `at` the anchor, `params { a, b, lengthA, lengthB, diffPct, unit }` (shortest and longest; metres with a scale, else paper mm) | `VARIATION_BALANCE_TOLERANCE` = 10 % |
| `VARIATION_ALL_EMPTY` | course, editor (F7) | a group none of whose alternatives holds a control yet (valid, §6.1: every variant is the same straight leg); at the anchor, `params { code }` | — |

Event-scoped codes run over every site, whether or not the course visits
it: the IOF distance and code rules are about the controls in the
terrain. Course-scoped codes run over the course's items only.

### 9.3 Document obstacles

`checkObstaclesOfDocument(doc)` reads a pinned document as
`cutFeaturesOfDocument` does (§3.4): a symbol's code is its applied
match's canonical code, else its source code; hidden symbols are
skipped. It keeps line and area objects of the `UNCROSSABLE_CODES`
(kind `uncrossable`) and of 708 / 709 (kind `oob`) as polylines of their
on-curve vertices (Bézier handles skipped; an area's outer ring only,
holes ignored — the approximation snapping makes, `course-editor.md`
§6.2), paper mm. A leg hits an obstacle when its segment intersects a
polyline edge (an area's ring closed), or, for an area, when the leg's
midpoint lies inside the ring. Point objects are not obstacles.

**The crossing-point exemption** (F4). A leg whose `crossing` names a positioned `crossing_point` site is
exempt from `LEG_CROSSES_OOB` / `LEG_THROUGH_UNCROSSABLE` at every
obstacle whose polyline (an area's ring closed) comes within
`CROSSING_REACH_MM` = 1.0 mm of the site — the obstacle the setter put
the crossing on; snapping puts a site on the line, 710's half-gap is
0.3–0.75 mm. Other obstacles on the same leg still report, and the leg
tested is the routed one (through the crossing point), so a crossing
beside a building takes the leg round it. Crossing and map-issue points
are not items, so no leg starts or ends at one; as `kind` ≠ `control`
they take no distance, code-range or description check (decided on the
user's standing instruction 2026-11-07, for review).

### 9.4 Where it runs

| Where | Codes | Inputs |
|---|---|---|
| Editor (client) | all but `DESCRIPTION_STALE` | the page's structure (`checkStructureOf`: the displayed path since F7, each item's leg with its `bends` and `crossing`, F4 — before F4 the client dropped the legs, so it ignored bends) and its groups (`checkGroupsOf`, F7), sites, `checkObstaclesOfDocument` over the decoded document (memoised per document), the course's sheet windows from `courseMap.list` with each sheet's `sectionIndex` (F5), the objects in scope, the viewer's derivation (`onCourseInfo`) |
| `course.checks { courseId }` (server, `courses.view`) | all but `CONTROL_OUTSIDE_SHEET`, `EXCHANGE_WITHOUT_SHEET`, `NUMBER_UNPLACED`, `NUMBER_OVERLAPS` (`sheets` and `derivation` null) and the `VARIATION_*` codes (no `groups`: the server's sequence is the root's first alternatives), plus `DESCRIPTION_STALE` | the stored structure or its columns (each entry's leg with its bends and crossing point, `loadCourseSequences`, F4), the event's sites, the map scale (`loadEventCrs`), the pinned document's obstacles (every event with a pin, `map-storage.md` §4.6; memoised per document hash), the autodetect objects of the same document for `DESCRIPTION_STALE`, the objects in scope |
| `course.setStructure` | as `course.checks`, for the written course | — |

Without a pinned document the server has no map (`map-storage.md`
§4.6): no scale, so no distance codes (`CONTROL_TOO_CLOSE`,
`SAME_FEATURE_TOO_CLOSE`), no obstacles and no `DESCRIPTION_STALE` — until E1
a `legacy` event took the scale from the OCAD file.

The editor shows its own list and adds the server's `DESCRIPTION_STALE`
checks. The layout checks need the viewer's placement at the document's
sizes and the resolved sheet windows, which the server does not compute
for a check (decision log, D6).

## 10. Leg properties

A leg is the item's `leg` (08 §4.3 `LegProps`, §6.1): the leg *into*
the item, between it and the previous positioned item. F1 makes `style`
and `bends` real, F2 `corridor`, F4 `crossing` (§10.3).

### 10.1 Styles and bends

| `style` | Drawn | Library entry | Colour row |
|---|---|---|---|
| `line` (default) | the leg's pieces — **nothing** when the leg has a corridor (§10.2 "No centre line", F14) | 705 | lower purple (ISOM), as §1 |
| `marked_route` | the leg's pieces, dashed along the whole piece through its bends | 707 (ISOM / ISSprOM: 0.35 mm, 2.0 / 0.5 mm dashes × the document factor) | upper purple (03 §2.4: a route is followed, not read through) |
| `none` | nothing | — | — |

- **Bends** (`bends`, paper mm) bend the leg into a polyline through
  them for **every** drawn style — a bent 705 is Purple Pen's bend
  (slice F split, 2026-11-07). The derivation's `points` are the
  previous site, the bends and the site, repeated points dropped (§3.2).
  The automatic cuts (§3.4 "Bent leg"), the stored `gaps` (fractions of
  the bent length) and the clipping at the sites (§3.2 step 3) apply to
  the polyline.
- **Curves** (F13; feedback 2026-11-08 item 1). A bend is a path vertex
  `{ x, y, hIn?, hOut? }` (§6.1): segment *i* of `[previous site,
  …bends, site]` is a cubic Bézier when its start has `hOut` or its end
  `hIn` (controls `start + hOut`, `end + hIn`; a missing one is its
  anchor — the course objects' rule, §8.3), else a straight segment.
  **The sites are corners**: handles go on bends only (user answer
  2026-11-08 Q1): a handle stored on a site is never read, and a curved
  first or last segment leaves its site towards the bend's own control
  point. `legPolylineOf(a, bends, b)` (`course/bends.ts`)
  flattens each cubic at **5 µm** (the stage's tolerance, built in µm
  so the flattener's 10 nm floor is not hit; a cubic gives `k` points at
  `t = j / k`), keeps every anchor verbatim and drops repeats. That one
  polyline is the leg's `points`, so the pieces, stored and automatic
  gaps, clipping at the sites, cuts, number placement, the hit pieces,
  the corridor (§10.2), the checks (§9.2), the lengths (§4.1) and every
  web readout follow the curve with no rule of their own. **Legs stay
  polylines** in the pass stream and the PDF (the flattened pieces; 705
  and 707's dashes laid along them); course objects keep their cubics
  (§8.3). `bendSegmentAt(a, bends, b, pt)` → `{ index, t, dist, point }`
  is the bend segment nearest a point by flattened distance (ties to the
  lower index; `t` the segment's own parameter): where a crossing point
  joins (§3.2) (the editor's *Add bend here* finds its segment with
  `nearestEdge` on the vertex path since F16, `course-editor.md` §6.7). `reverseBends` runs a leg backwards (the
  vertices reversed, each one's `hIn` and `hOut` swapped).
- **Dashes** are laid by `symbolise` along each piece as one path, so a
  dash runs round a bend; every backend draws the slices it returns
  (the PDF one subpath per dash, never `d`, `course-print.md` §4.3).
  707 has no special treatment in the layer: `layer.ts` picks the
  symbol (`idx.markedRoute`, already resolved for the 707 course object)
  by `legLine(leg)` (F14): `"line"` (705) for `line` without a corridor,
  `"marked_route"` (707) for `marked_route` with or without one, `null`
  (no object) for `none` and for a `line` leg with a corridor. The
  editor's hit-test reads the same function (`course-editor.md` §5), so
  a leg without a line on paper is a leg without a hit piece.
- **`none`** emits no object and so no pass and no hit-index piece; the
  derivation keeps the leg's `pieces` (numbers avoid it, §3.5) and its
  `style`, and the leg keeps its index (`ref` ids of the legs after it
  are unchanged). Its number, its sites and its length are as for a
  drawn leg.
- **Length** follows the bends (08 §4.3 "Lengths and climb"): the
  stored `legs` / `length_m` (§4.1), `sequenceLegMeters` and the editor's
  leg-length label (`lib/editor/leg-length.ts`) measure along them —
  along the flattened curve (F13: a quarter circle of radius 20 mm
  measures `10π` within 0.02 mm); `style` never changes a length, nor
  will a corridor (F2). While a bend or grip is dragged the editor's
  inspector measures the leg draft instead (F25, `course-editor.md` §6.7
  "Readouts follow the bends"); the stored length changes on the write.
- **Checks**: `LEG_CROSSES_OOB` / `LEG_THROUGH_UNCROSSABLE` test the bent
  polyline, the flattened curve since F13 (§9.2); `VARIATION_UNBALANCED`
  measures along it.
- **The start** still turns to the next site (§3.3), not to the first
  bend.
- **Where the props reach the layer** (user, 2026-11-07): the
  structure's items as stored for the lengths (`course-geometry.ts`,
  §4.1); the print's sheet resolution copies the item's **whole** stored
  leg (`course-maps/resolve-sheet.ts`, `course-print.md` §5.2), so
  `maps.pdf` and Layout mode's sheet print bends, 707 and `none`; the
  viewer's request carries the whole leg too since F2
  (`layerPropsOfStored` → `course.list.legs` → `MapPanel` / `MapViewer`
  → `course-layer-request.ts`, §5).

### 10.2 Corridors

`corridor: { widthM, edge, whiteMm, whiteOpacity }` (08 §4.3; semantics
by the user, 2026-11-07, SLICES F answer 1): the map shows **inside**
the corridor; a **white band** `whiteMm` wide lies outside its edge,
beyond which the map shows again (a large `whiteMm` is the classic
all-white corridor map); `edge` draws the boundary in purple.

- **Units.** `widthM` is the corridor's full width on the ground:
  `widthMm = widthM × 1000 / document.mapScale` (§2 `document`), so the
  derivation's `DerivedLeg.corridor` is `{ widthMm, whiteMm, edge }`.
  `whiteMm` is paper mm at the base map's scale — the structure's frame,
  like `bends` (§2) — and is not divided by the print enlargement: printing at
  another scale enlarges it with the map (§1 "Scale").
- **Along the leg.** A corridor follows the leg's `points` (the previous
  site, the bends, the site), never its `pieces`: gaps and the clipping
  at the sites do not change it, a `style: "none"` leg keeps its
  corridor, and a corridor never changes a length (08 §4.3, §4.1).
- **Geometry** (`corridor.ts`, `corridorGeometry(derivation.courses,
  mouths, options?)`; `mouths` is the drawn sites and the symbols'
  centre-line extents, optional — without it there are no mouths and no
  openings; `options.terminalEnd` is the band's end at a terminal end,
  "Ends" below, `TERMINAL_END` when absent — the layer passes none).
  Per course, consecutive corridor legs of equal `widthMm` and `whiteMm`
  are one run (repeated and straight-through points dropped). A run's
  buffer at a distance `h` is **one ring per run** (user answer
  2026-11-08 to F13's corridor question, replacing F2's rectangle per
  segment and disc per vertex): the left offset, a round cap at the end,
  the right offset back, a round cap at the start. At each vertex the
  outer side turns along an arc about it and the inner side runs through
  the vertex itself (the offset point of the segment before, the vertex,
  the offset point of the segment after), so the ring's **nonzero**
  winding covers exactly the round-joined buffer even where it crosses
  itself; arcs and caps are flattened at 5 µm, so a turn too small to
  need it (below about 6.6° at a 3 mm half width — "round joins at turns
  > 10°" of the answer, made exact to the tolerance) is one chord. A run
  of one point is a disc. `polygon-clipping`'s union, nonzero per input
  ring, cleans every run's ring and joins the runs; its output rings are
  simple. Why: a flattened curved leg (F13) has ~90 vertices, and the
  union of ~180 pieces per leg cost 0.6 s for one leg and crashed
  `polygon-clipping` ("Unable to find segment in SweepLine tree") at ten;
  one ring per run measured 6 / 44 / 158 ms for 1 / 10 / 30 curved legs.
  The
  **inside** is the union of every run's buffer at `widthMm / 2` over
  every drawn course; the **band** is the union of the runs' buffers at
  `widthMm / 2 + whiteMm` (runs with `whiteMm > 0`; flat at a terminal
  end, "Ends") less the inside. So
  corridors **join**: at a site, at a change of width, where two
  courses' corridors cross, nothing of one corridor's band lies inside
  another. The rings are integer µm, simple and properly nested, drawn
  even-odd like every stream path (`map-rendering.md` §3.1). The booleans
  are `polygon-clipping`'s: even-odd over overlapping pieces cuts a hole
  at every join and the stream has no non-zero fill, so `strokeOutline()`
  (non-zero by contract) cannot build the band.
- **The last result is kept** (F20b). `corridorGeometry` keeps its last
  call's input key and result and returns that result — the same object —
  while everything the geometry reads is unchanged: per course its id and
  per leg its index (the edges' refs), for a corridor leg its ends,
  width, band, edge and points, and with `mouths` the extents and the
  sites a corridor leg ends at (id, role, position, turn; `-0` apart from
  `0`), and the terminal end (F22: `options.terminalEnd`, so two calls
  that differ only in it give two results). So a request that leaves the corridors as they were — a number, a
  course object or a control of another course dragged over a corridor
  course, a number style — pays nothing for them; a moved corridor
  control recomputes, and so does a circle or line appearance (it
  changes the extents and the legs' points). Callers treat the result as read-only. It is the
  row's "per-run ring cache" widened to the whole geometry: a course of
  one width is one run, whose key changes on every move of its controls.
- **Drawing the band** (user, 2026-11-07): the band is a generated
  **`clip` filter region** (`symbols: "all"`, `map-rendering.md` §4.11),
  appended to `CourseLayer.regions` after the explicit and the stored
  ones. Only document objects are filtered (`regionObjectLimit`), so
  every map colour is cut away inside the band and the paper shows white,
  while the course — circles, the legs that draw a line (below), numbers,
  the edge, layout and course objects — draws over it with the stack and the 7xx colour roles
  unchanged. No band (`whiteMm` 0 on every corridor) adds no region.
- **`whiteOpacity`** is stored and validated (0 … 1) but drawn opaque: a
  clip removes the map wholly. A translucent band needs a paint with
  alpha over the same rings (`map-rendering.md` §8). The editor shows no
  field for it until then (F25, `course-editor.md` §6.7): a stored value
  is kept on every corridor write.
- **Mouths** (F19, user feedback 2026-11-08 item 6, "the way
  Coursecraft does it"; answers 1–3). Every control, finish or start
  that a corridor leg — edged or not — starts or ends at is a mouth: its
  symbol at its **centre-line extent** joins the inside union — 703's
  disc of radius R, 706's outer ring's disc, the 701 triangle at its
  circumradius turned by the site's `angleDeg` (apex north without
  one) — and that shape grown by the **largest `whiteMm`** of the
  corridor legs ending there joins the outer union (none when that is
  0). So the map shows inside the symbol and the band wraps it — all
  round where corridors continue at the site, and only its near half,
  up to the line through its centre, at a corridor's terminal end
  ("Ends", F22). A
  symbol that a leg's round end there already encloses (that leg's half
  width h ≥ the extent) adds nothing to the inside, and its grown shape
  nothing to the outer union when a banded leg's `h + whiteMm` reaches
  as far: **h ≥ R keeps the geometry before F19** — the circle sits
  inside the corridor (answer 1). A run that starts or ends at a joined
  701 ends **flat**, its sides carried back along the leg until both
  meet the triangle (or not at all when they start inside it): its round
  end would bulge past the triangle's base. A site the corridor only
  passes over, without a leg of it ending there, is no mouth.
- **Ends** (F22, user feedback 2026-11-09 item 2, "the way Coursecraft
  does it … doesn't extend further than the middle of the control
  circle"; answers 1–4 in `feedback-2026-11-09.md`). A site is a
  **terminal end** when exactly one corridor-leg end lies there,
  counted by site id over every drawn course — a lone leg's ends, the
  first and last site of a run that no other corridor leg meets. A
  control inside a run, a change of width or band, two courses'
  corridors meeting, a loop and a reversal (A → B → A, one site id) all
  have two or more and keep the F19 join: the band never gets thinner
  where a corridor continues (answer 4). A start is never terminal: its
  run ends as in F19, flat at a joined 701 or round, and the band frames
  the whole triangle (answer 2). A finish is terminal like a control,
  its R the 706's outer ring. At a terminal end (option 3 of the
  sketches, answer 1):
  - the **run's band** ends **flat on the line through the site** across
    the leg — the bearing of its last millimetre (`END_BEARING_UM`: on a
    flattened curve the chord of its last 1 mm, not a µm segment) — with
    **one corner each side**. Where the band reaches past the circle
    (h + w > R, R the symbol's extent, 0 without a drawn mouth) the
    corner's radius is r = min(w, h + w − R), the arc about (−r,
    ±(h + w − r)) in the end's frame (x along the leg towards the site,
    the line at x = 0), and the mouth adds nothing: the end is the run's
    band alone, with no bump (user, 2026-11-09, on the sketch: "fix the
    bump first"). So the face on the line spans ±(h + w − r) ≥ ±R — ±R
    exactly while w > h + w − R, i.e. h < R — the arc is tangent to the
    line at its end and lies above the circle near the line (the boundary
    R + √(r² − (r − ε)²) ≥ √(R² − ε²)), and the circle's near half stays
    in the white up to the line; beside the circle at the line the white
    is h + w − R wide. At h ≥ R, r = w: the band's plain corner rounded by
    `whiteMm` (answer 1). At the default (50 m, 5 mm at 1:15 000: h 1.67,
    R 2.5) r = 4.17. Built as the run's ring at h + w with a flat end
    through the site, less `cornerWedges`: the ring past the line within
    h + 2w (a curved run's own sides reach across it) and, per side, the
    square corner between the line and r before it, out to h + 2w, less
    the quarter disc of radius r tangent to the line and the side;
    nothing farther than √((h + 2w)² + w²) from the site changes;
  - where the band is **no wider than the circle** (h + w ≤ R), the run's
    band alone would leave the circle's sides on the map, so the **mouth's
    grown symbol** wraps it with its **near half** (the side the leg comes
    from): the disc of radius R + w cut on the same line, its face
    spanning the circle's diameter (±R), each corner the arc tangent to
    the line at ±R and, inside, to the grown disc — radius
    w(2R + w) / (2(R + w)), between w / 2 and w (decision log, F22: the
    coordinator's reading of answer 1, kept by the user's fix for this
    case). The run's own corners (radius w) lie inside it, so the end has
    one outline. A corner of radius w on the disc exists only for w ≤ R
    and leaves a face √(R² − w²) < R, so the circle would leave the white
    before the line. The shape changes at h + w = R: below it the half
    disc reaches R + w, above it nothing reaches past h + w;
  - **the inside, the edges and the openings are unchanged** (answer 3),
    bit for bit. A wide corridor (h ≥ R) keeps its round end with the
    circle inside it and its edge's closed ring; the half of that round
    end behind the line now lies on the map. A terminal end without a
    drawn mouth (no `mouths`, an undrawn site, an exchange or map-issue
    point) is cut the same way with R = 0 — and without `mouths` a start
    is cut too (its role is unknown); the layer always passes them.

  A corridor that only passes over a terminal site keeps its band whole:
  the cut is subtracted from the terminal run's own ring before the
  union, so no other run loses anything. Nor does the run's own earlier
  part (spec review of F22; answer 4): the cut is the **terminal leg's**
  alone. The buffer of every other leg of the run (`bodyNear`: of those
  legs, the stretches less than h + 2w behind the end line somewhere and
  within √((h + 2w)² + w²) + h + w of the end) is taken out of the cut
  before the difference, and those legs keep their band — a hairpin, a
  figure eight whose end lies on its first leg, a short last leg that
  turns back or turns sharply (the previous leg's band beside the end
  and in the end's corners). The control where the terminal leg starts
  keeps its join: a last leg shorter than h + w leaves that control's
  round wrap reaching past the end line (the corridor continues there).
  A run whose other legs stay out of the end's reach — the usual case —
  is cut by the wedges alone. The terminal leg's own bends are its own:
  a leg that bends back within h + 2w of its end (≈ 175 m at the
  editor's default 50 m / 5 mm at 1:15 000) is cut with it there. `{ terminalEnd: "round" }`
  gives the band before F22 (a round end at h + w and the whole grown
  symbol); the tests compare the two.
- **Openings** (F19). An edged leg with h < R at a **control** opens
  the circle **where it lies inside that leg's own corridor**: the arcs
  of the circle (radius R about the site) within h of the leg's
  polyline — bends and flattened curves included — each between two
  **junctions** where the leg's sides cross the circle (found on 0.5°
  samples, the ends bisected to 1e-7 rad). On a straight end segment
  that is exactly compass `θ ± asin(h / R)`, θ the segment's bearing,
  the junctions `c + u·√(R² − h²) ± n·h`. An arc opens when **at least
  one** of its junctions lies within 20 µm of the inside's boundary. Two legs at a control open two sectors; at a turn
  they overlap through the inner corner (where each leg covers one of
  the other's junctions) and `circleArcs` merges them. A wider corridor
  at the site covers both junctions: no opening. Never for a start or a
  finish (answer 2, §3.3), never for `edge: false` (answer 3), never at
  h ≥ R (answer 1), never at a circle the corridor only passes.
  `CorridorGeometry.openings` maps site id → compass gaps; the layer
  draws them with the circle's cuts (§3.3). **Drawn, not cuts**: not in
  `DerivedSite.cuts`, not stored, not under `autoCuts`, never baked by
  `G` into `circleGaps`, not exported.
- **The edge** (`edge: true`): the inside's boundary where it runs along
  an edged leg — boundary points within 20 µm of half that leg's width
  from it, its round end at a site counted only where no unedged
  corridor leg meets it and the site is no joined mouth (F19: there the
  round end lies inside the symbol, or past a 701's base) — less every
  boundary piece on a mouth's outline (both ends within 10 µm of the
  same symbol: the symbol's, never the edge's). So an edge piece ends
  where a straight side meets the circle, the 706 or the 701. Stroked
  with `705/edge` (§3.1: 705 with round caps; lower purple, 705's width
  × the document factor × `appearance.line`), closed where a whole ring
  qualifies (a lone leg at least as wide as its circles), else open
  pieces. Because it is the union's boundary, an
  edge never crosses into a joined or crossing corridor, and a leg
  without `edge` next to one with it draws no line on its own sides. The
  objects follow the legs; their `ref` is `{ kind: "corridor", id:
  "<courseId>:<leg index>" }`, and the editor's hit-test takes them as no
  target.
- **No centre line** (user feedback 2026-11-08 item 2, F14; deviates
  from F2, where the leg's 705 was drawn over the band): a leg with a
  corridor and `style` `line` draws **no** 705 — on screen and in print
  alike, both reading `legLine` (§10.1). Inside a corridor the edge
  marks the route, and the centre line only obscured the map the
  corridor shows. The edge is still `edge` (default on, `course-editor.md`
  §6.7); with `edge: false` the corridor is the band alone. A
  `marked_route` leg keeps its 707 inside a corridor, and `none` is
  unchanged. Nothing else moves: the derivation keeps the leg's `pieces`,
  `style` and `corridor`, so the numbers still avoid it (§3.5), the cuts,
  the stored `gaps` (`G` still writes them) and the lengths are as
  before, and the leg keeps its index. The editor selects such a leg from
  its derived pieces and draws a guide along it (`course-editor.md` §5,
  §6.7).
- **Screen and print** need nothing of their own: the viewer's worker
  filters its static buckets with `layer.regions` on every course reply
  (`map-rendering.md` §5.2 "Filter regions") and draws the edge in the
  dynamic bucket; the print route's `composePage` passes the regions to
  `symbolise` (`course-print.md` §5.2), the PDF as a `W*` clip round the
  map passes.

### 10.3 Crossing points, map-issue points and map exchanges

Row F4 (research 08 §4.2 `kind`, §4.3 `crossing`; 03 §2.4 roles). The
three slice-F site kinds are drawn at once.

- **Never items** (slice F split): a `crossing_point` site is named by a
  leg's `crossing` or stands alone, a `map_issue` site stands alone. The
  structure refuses them as items (`SITE_KIND_NOT_ITEM`, §6.1) and the
  layer skips such an item. A `map_exchange` is an ordinary item drawn
  and numbered as a control circle — its final drawing, on both parts
  of the course it splits (§11).
- **Routing** (`LegProps.crossing { controlId, section? }`): the crossing
  point joins the leg's polyline on its segment nearest the site
  (`routedBends`, the editor's *Add bend here* rule; on a curved leg the
  segment whose flattened curve is nearest, and the point joins as a
  corner — F13, §3.2), so the leg runs
  `previous site → bends before → crossing → bends after → site`. The
  drawing, its gaps (fractions of the routed length), the derived length
  (§4.1), the editor's leg metres and `G` target and the leg checks
  (§9.3) read the same polyline. A crossing naming a missing,
  unpositioned or non-crossing site is ignored. A free-order course has
  no legs, so no crossing.
- **Drawn**: a crossing point whenever a drawn ordered course's leg runs
  through it, or with `allControls`, or with `setterMarks`; numberless,
  never cut, never a clip obstacle for a leg nor a number-placement
  obstacle. `angleDeg` is the direction of passage, counter-clockwise
  from +x: the chord from the polyline point before the site to the one
  after it on the first ordered course whose leg names it (the leg's
  direction when straight, the bisecting chord when the leg bends at the
  site; on a curve the chord of the flattened points either side, F13);
  **90 (north–south) when no drawn leg names it**. `section` is
  that leg's `crossing.section`. The symbols are §3.1's: ISOM's 710 is a
  line entry whose length "follows the crossing", but a site has no
  length and 08 §4.3's `section` is a boolean, so the layer draws it
  over a fixed body — 3.0 mm × document factor (ISSprOM 710.1's size),
  6.0 mm for the section form; ISSprOM draws 710.1 turned, or for a
  section two 710.2 lines at ±0.75 mm × factor, the second reversed
  (decided on the user's standing instruction 2026-11-07, for review; a
  stored section length is Pending). `ref` `{ kind: "site", id }`.
- **Map-issue points** draw 702, upper purple, unrotated (a free site has
  no route to lie across), **only with `viewOptions.setterMarks`** (08
  §4.2 "renders only in setter views"): the editor's Course and
  All-controls views, Layout mode on the all-controls sheet, and the
  all-controls and setter sheets in print (`resolveSheet`; F10, a setter
  sheet its group's, `course-layout.md` §8). A course sheet, a class sheet and Class view never set it.
- **Description rows**: a leg through a crossing point derives a 13.3
  row (13.4 with `section`) after the control the leg leaves
  (`control-descriptions-and-editor-geometry.md` "Course-level
  instructions").
- **Print**: a course sheet's `sites` include the crossing points its
  legs run through (`courseInputOfLayout` reads them from the event's
  controls), its items keep the whole stored leg; the all-controls sheet
  types its sites by `kind` (`resolveMapLayout`; a crossing or
  map-issue point is no row of its description block) and sets
  `setterMarks`.

## 11. Sections

Row F5 (research 08 §4.3 "sections", §4.6 "sheets per section", §5.3
"Map exchange"; 03 §2.4). A course with map exchanges is printed in
**parts**, one sheet each; answer 2 (user 2026-11-07) settled the
drawing — 08 §7's fixture had numbering restart per section.

- **`sectionsOf(items, isExchange)`** (`structure.ts`): the inclusive
  index ranges `{ index, from, to }` of a sequence split at the entries
  `isExchange` names. The exchange **ends part n and opens part n + 1**,
  so it lies in both; a course without one is one part over everything;
  two adjacent exchanges make a part of their two circles; an exchange
  first or last is allowed (the setter's call, no check). Part identity
  is the site's kind — the stored structure gains no field (08 §4.3
  names no section marker). The layer splits its positioned sequence
  (unplaced sites split nothing), `autoSheets` counts the placed exchange
  visits of the course mirror (`partCountOf`), `resolveMapLayout` splits
  the layout's placed controls, `courseChecks` the positioned visits —
  the same parts everywhere.
- **`viewOptions.section`** draws one part of a **single** structure with
  ≥ 2 parts: that part's sites, legs and numbers. Part 1 has the start,
  the last part the finish; the exchange is a numbered control circle
  on both. Numbers are counted over the **whole** sequence before the
  part is cut out, so part 2 opens with the exchange's own number
  (answer 2), and a site visited in both parts carries only its part's
  numbers. Out of range, a one-part course or several structures draw
  the whole course unchanged — so every sheet without parts (all of
  them, `section_index` 0) draws as before. `DerivedCourse.section {
  index, count }` reports a part drawn; its `sequence` and `legs` are the
  part's.
- **The description block** of every part carries the **whole course**
  (answer 2): header, rows, `{controls}` and the derived **13.5** row
  after each exchange control (`buildDescriptionSheet { exchanges }`,
  `control-descriptions-and-editor-geometry.md` "Derived rows").
- **ISOM 715** (continuing point after a map exchange, 03 §2.4) is not
  drawn: answer 2 makes the exchange a numbered control circle on both
  parts (decided on the user's standing instruction 2026-11-07, for
  review).
- **Sheets**: one own sheet per part (`course_maps.section_index`,
  `course-layout.md` §6), the window of a sheet without a stored centre
  centred on its part's controls (`course-print.md` §5.2);
  `EXCHANGE_WITHOUT_SHEET` names a part whose sheet is missing (§9.2).

## 12. Variants and materialisation

Slice F row F6 (research 08 §4.3 "Materialisation", §4.8, §6, §7). A
course whose stored structure has variation groups is a **root**; each of
its concrete variants is a **child** `courses` row written by the server
in the same transaction as the root's structure. A child is an ordinary
linear course for every reader — timing (`performReadout` reads
`runner.courseId ?? class.courseId`), results, the Eventor upload, the
IOF / Purple Pen export (where the root is not written: each variant is a
`<Course>` with the root's name as its `CourseFamily`, a class on the root
assigned to each — F9, `iof-coursedata-export.md` "Variants"), print, the kiosk — and read-only for every
writer. It stays in every course list (`course.list`); a consumer that
must not offer it filters on `parentCourseId` (decided on the user's
standing instruction, 2026-11-07, for review). Section numbering keeps
§11 for F5's map-exchange sections.

### 12.1 Keys and the linear variant

`packages/shared/src/course/variants.ts`, pure:

- `materialiseVariants(structure)` → `{ key, items }[]`: the cartesian
  product over the groups in item order (the first group varies slowest).
  A plain group contributes one alternative at a time; a **`loop`** group
  (butterfly) every visiting order of its alternatives, permutations in
  lexicographic order of the stored alternatives (`AB`, `BA`; three
  alternatives give six). `[]` for a structure without groups.
- `uniformVariantNumbers(structure, isNumbered)` (F15; All variations,
  §12.7) → `Map<siteId, number> | null`: over every variant's path
  (`variantOrders` → `pathOfOrders`) the items `isNumbered` accepts are
  counted 1, 2, …; the map site → number when **every visited site has
  exactly one number across all variants**, else `null`. The predicate
  is the caller's (the stored structure knows neither site kinds nor
  positions): role `control` — a map exchange is one, the start, finish,
  crossing and map-issue points are not — and positioned, what the layer
  numbers. An unequal fork, every loop with two or more non-empty petals (the anchor is visited again; a loop with one has no repeat and numbers as a plain fork) and
  a top-level site visited twice give `null`; two forks in a row continue
  the numbers across both; one unequal group makes the whole course
  codes.
- **Keys.** A group's key is its alternatives' labels in visiting order,
  the variant's key the groups' keys concatenated (`"AC"`, `"ABA"`). A key
  depends on the groups alone, so an edit outside them keeps every key and
  so every child row. Two variants with the same key (multi-letter labels
  can collide) are refused (`VARIANT_KEY_DUPLICATE`), as are more than
  `MAX_VARIANTS = 100` variants (`VARIANT_LIMIT`; `variantCount` counts
  without building them) — both `PRECONDITION_FAILED` from
  `course.setStructure`.
- **Items.** Control items are copied as stored, `leg` and `numberHidden`
  included — the leg into an alternative's first control is the leg from
  the anchor, the item after the group keeps its own leg. A loop returns to
  its anchor (the control before the group): between two consecutive
  non-empty alternatives the anchor is visited again as `{ siteId }` (its
  `numberHidden` kept, no `role` or `leg`); the visit after the last
  alternative is the structure's own next item, which the setter places
  (08 §4.3 "loop groups share both anchors"). An **empty alternative**
  (§6.1, answer 5) adds nothing: the variant runs a straight leg from
  anchor to anchor, and in a loop adds no anchor visit.
- `variantStructure(structure, key)` → the variant as a v1 linear
  structure (`{ version: 1, id, orderMode, items }`, no groups; null for an
  unknown key) — the column shape every consumer reads, so the layer,
  print, lengths and export learn nothing about groups (slice F's
  "A variant is a linear structure"). F7's Variant view and F8's pages
  draw it (a page reads the materialised child, which holds the same
  structure, `course-print.md` §4.6).
- `allVariationStructures(structure)` (F8) → `{ spine, branches }`: the
  spine and one branch per alternative of §12.7, generic over the site
  id like `pathOfOrders`. The editor's All-variations view tints the
  branches (`allVariationDraws`); the all-variations print draws them in
  the one purple.
- **Paths** (F7). `variantOrders(structure)` → `{ key, orders }[]` in the
  same order: each variant's groups' visiting orders by group id (a plain
  group one label, a loop its permutation). `pathOfOrders(structure,
  orders?)` → `{ items, paths }` is the one walk behind both:
  `materialiseVariants` is `pathOfOrders` over each variant's orders, and
  the editor's Course view walks the displayed alternatives
  (`course-editor.md` §12; a group missing from `orders` shows its first
  alternative, a loop every alternative in stored order). `paths[i]` says
  where `items[i]` comes from: `{ itemIndex }` (a top-level item),
  `{ itemIndex, alt: { label, index } }` (an alternative's item) or
  `{ itemIndex, anchorVisit: true }` (a loop's repeated anchor, no item of
  its own). Generic over the site-id type, so the wire form walks too.
- `structureSiteIds(structure)` lists every site of every alternative;
  `pruneSiteFromStructure(structure, siteId)` removes a site from the top
  level and from every alternative (groups kept — since F7 also one left
  with every alternative empty, §6.1) and dissolves a group then left
  first or last (`VARIATION_UNANCHORED`) or right after another group
  into its first alternative, so the result passes §6.1 whenever the
  input did.

### 12.2 Storage

| Column | Type | Meaning |
|---|---|---|
| `courses.parent_course_id` | `UUID NULL → courses ON DELETE CASCADE` | the root this row is a variant of; NULL for every other course |
| `courses.variant_key` | `TEXT NULL` | the variant's key; set exactly when `parent_course_id` is (`CHECK`) |
| — | `UNIQUE (parent_course_id, variant_key)`, index on `parent_course_id` | one row per key; NULLs are distinct, so ordinary courses never collide |

Migration `20261108120000_course_variants`, additive (AGENTS §7). On the
wire a variant names its root by **seq** (`parentCourseId`), as every
tRPC id. The columns travel in `course.upserted` like any other
(`portableFields`), in the checkout snapshot and in the backup dump as
ordinary `courses` rows.

### 12.3 Materialisation (`syncVariants`)

`packages/api/src/course-variants.ts`. After the root's
`persistStructure`, inside the write's transaction, `syncVariants(tx,
eventId, rootId, { labelOffsets? })` brings the children in line with the
root's stored structure:

- one child per key: **created** for a new key, **rewritten** for an
  existing one, **revived** (`removed = false`, same uuid — the unique
  pair forbids a second row, and a stable uuid keeps runner pointers and
  journal identity) for a key that returns;
- each child: `name` = `"<root name> <key>"`, `climb_m`,
  `number_of_maps`, `shorten`, `description_instructions` copied from the
  root, `order_mode` the root's; `structure` = the variant (`id` = the
  child's uuid) written through `persistStructure`, so `course_controls`,
  `start_name`, `finish_control_id` and the flags are its mirror (§6.2);
  label offsets from the write's wire form when it carries them, else a
  live child keeps its own and a new one takes the root's;
  `legs` / `length_m` / `length_source` by `rebuildCourseLengths`;
- a child whose key is gone is **soft-deleted** (`removed = true`), and
  every runner whose `course_id` named it gets `course_id = NULL`; after
  the pools are written, every runner of a class whose pool changed —
  those nulled included — is dealt a variant of the new pool
  (`reconcileClassVariants`, F6b's invariant "every runner in a pooled
  class has a variant", `course-controls-and-matching.md` "Forked courses
  and variants"); a nulled runner whose class has no pool stays null;
- a root that is removed, or whose structure has no groups any more, ends
  with no live child;
- the root keeps `course_controls` = the first alternatives
  (`structureControlItems`, 08 §4.3's root path), so a reader that does
  not know variants still sees a course.

### 12.4 Journal and pools

`emitVariantSync` journals what `syncVariants` touched, **after** the
root's own `course.upserted` (a peer applying a child needs the parent
row; 08 §4.3 "journaled through the existing `course.upserted` entries,
one per affected row"):

- one `course.upserted` per child written (in `materialiseVariants`'
  order) or soft-deleted (after them, `removed: true`);
- one `class.upserted` per class whose pool changed (its `coursePools`
  carry the pool);
- one `runner.updated { cardNo, runnerId, fields: { courseId } }` per
  runner whose variant changed — the seq she was dealt, or null when her
  class has no pool (F6b; before F6b always null). `buildRunnerUpdateData`
  translates `courseId` (a course seq, or null) so the entry replays
  through `events.push`, and a peer takes the seq instead of re-picking.

**Pools** (08 §4.3 "the editor's job ends at producing the pool"): every
class whose `course_id` is a root has exactly one `ClassCoursePool(classId,
stage 0, child)` per live child; a soft-deleted child leaves every pool.
Written by `syncVariants` for the classes on the root, and by
`syncClassPool` when a class's course changes (`class.create`,
`class.update { courseId }`, `class.bulkUpdate { courseId }`) — a class
picking a root after its variants exist pools them too, and a class
moving to a plain course loses them (decided on the user's standing
instruction, 2026-11-07, for review — decision log "F6: pools written
when a class picks a course"). Only pool rows of variants are touched;
`stage` > 0 (relay legs) stays timing's (08 §12). `syncClassPool` then
reconciles the class's runners (F6b) and returns them; its callers
journal them after the `class.upserted` (`emitRunnerVariants`; the
import after its `reference.imported` entry).

### 12.5 API

- `course.setStructure` accepts groups (§6.1) and materialises in the
  same transaction; refused on a variant.
- `course.variantList { courseId }` → `[{ variantKey, courseId (seq),
  lengthM, runnerCount }]` (`runnerCount`: non-removed runners on the
  variant, every class on the root — F6b), the live children in key order; `[]` for a course without
  groups and for a variant. Kiosk keys may read it (as `course.list`).
- `course.list` / `course.detail` carry `parentCourseId` (the root's seq
  or null) and `variantKey`. A root's `detail.structure.labelOffsets`
  includes the offsets its variants hold for controls outside the first
  alternatives, so the wire form round-trips them.
- **Writes that are refused** (`PRECONDITION_FAILED`, the code first in
  `message`):
  - `COURSE_IS_VARIANT` — any write on a child: `setStructure`, `update`,
    `bulkUpdate` (the whole call), `delete`, `setControlLabelOffset`. A
    variant changes through its root.
  - `ROOT_HAS_VARIATIONS` — `course.update` on a root with `controlIds`,
    `startControlId`, `finishControlId`, `orderMode`, `firstAsStart` or
    `lastAsFinish`, and `course.bulkUpdate` with `orderMode`,
    `firstAsStart` or `lastAsFinish` when `ids` holds a root (the whole
    call): each rewrites the structure from the columns (§6.2), which
    would flatten the groups.
- **Writes that reach the variants**: `course.update` of a root's
  `name` / `climb` / `numberOfMaps` / `descriptionInstructions` (any of
  them; a `length`-only update does not) and `bulkUpdate` of `climb` /
  `numberOfMaps` re-run `syncVariants`
  (renamed `"<new name> <key>"`); `setControlLabelOffset` on a root
  writes the root's and its variants' rows of that control (one
  `course.upserted` each), so a control only in alternative B can be
  given an offset; `course.delete` of a root soft-deletes its variants
  (journaled, runners nulled); `course.clone` of a root clones a root and
  materialises its variants (`"<clone name> <key>"`, every label offset
  of the source), a variant's clone is a plain linear course.
- `control.delete`: a root naming the control in any alternative
  (`coursesNamingInStructure` walks every alternative) loses it through
  `pruneSiteFromStructure`, is re-mirrored and re-materialised; its
  variants are written by that alone, one entry per row. A plain course
  is rewritten from its columns as before (§6.2).
- `course.importCourses`: a variant is never matched by name; a root
  replaced by an imported course becomes linear and its variants are
  soft-deleted — they travel in the `reference.imported` entry (roots
  before variants), its classes' pools with it, the nulled runners as
  `runner.updated` after it. `replaceAll`'s wipe soft-deletes variants in
  bulk, so the import then clears every runner and pool row still naming
  a removed variant (`clearRemovedVariants`), and a class the file maps
  to a course gets that course's pool (`syncClassPool`).

### 12.6 Courses page

The table's rows are the roots (filter, sort, selection and the
"N courses" count act on them). A root with variants shows a purple
"2 variants" badge (`course-variant-count-<seq>`), and its variants
follow its row, indented and read-only (`course-variant-row-<seq>`: the
key, the variant's name, controls, length, maps; no checkbox, template,
edit or delete — one action since F8, `export-variant-<seq>`: its map on
the root's sheets, `maps.pdf?variants=<root>:<key>`). The root's row
adds `export-all-variations-<seq>` (`?allVariations=`), and its
`export-course-<seq>` prints every variant (`course-print.md` §4.6). The root's expanded detail keeps name, length
and maps editable; its controls and order mode are disabled with a
one-line hint (`course-variations-hint`), since `course.update` refuses
them.

**A variant's detail (F17).** A variant's row expands like the root's: a
click on the row (its name cell included) toggles the same `?course=<seq>`
param (`useNumericSearchParam("course")`), so one row is open at a time
across roots and variants, the URL deep-links a variant, and both rows carry
`aria-expanded`. The detail is the same `CourseInlineDetail` with
`readOnly`: `course.detail` serves a child as it serves a root (its own
`course_controls`, §12.3's mirror), so `course-detail-controls` and the chip
strip show the **variant's own** sequence, with name, length and maps
disabled, no order-mode select, a hint (`course-variant-hint`) that the
root's structure writes it and the course editor changes it, and no "Used by
classes" panel (classes point at the root; a child's `classes` is `[]`, so
the panel would wrongly say "not assigned"). The detail adds no delete,
clone or editor link; the row keeps its one action, the map export. The
page's map highlights the expanded variant by its own name
(`<root> <key>`), among the visible roots' variants like a root's.

### 12.7 Variation tints (screen only)

Row F7 (08 §5.3 "all variations overlay … in distinct purple tints on
screen only — print is always one variant", §12 "Variation tints on
screen"). The layer learns no groups: the editor's All-variations view
(`course-editor.md` §12) hands it linear structures — the course's
**spine** (its top-level items; across a plain group a `style: "none"`
leg, a loop keeps its anchor → next leg) and one **branch** per
alternative (anchor → its controls → the next item; a loop's petal back to
the anchor; an empty plain alternative the straight leg; an empty petal
none), each branch with `CourseStructure.tint` = its label and an id of
its own (`<course>#<group>/<label>`).

With `viewOptions.allVariations` the layer appends one colour row per
label, in first-use order, **on top of the stack** after the
object rows and below a toner saver's white (`withTintColours`:
`course-tint:<label>`, named `Variation <label>`, CMYK from
`VARIATION_TINTS` — six purples, distinct on screen, cycling), and draws
with copies of 705 and 703 on those rows: a tinted structure's 705 legs
(707 and `none` legs as ever) and the circles of the sites that only
structures with that one tint visit (a site the spine visits stays plain
purple). Numbers, starts, finishes and everything else are unchanged.
On top of the stack the tints draw over black: a screen overview, not an
overprint.

**Numbers when the variants number alike (F15; the user's answer Q4,
2026-11-08).** All variations labels the sites by number when
`uniformVariantNumbers` is not `null` — every visited site has exactly one
sequence number in every variant that visits it (equal forks) — and by
code otherwise (unequal forks, loops of two or more petals). The numbers travel as
`viewOptions.labels` (site id → text, §3.5): the spine's draw carries
them on screen (`course-editor.md` §12), the all-variations sheet on
paper (`course-print.md` §4.6), both from the same helper, so the two
agree. The labels are the variant numbers (`S 31 [A:32 | B:33] 34 F`:
31 is 1, 32 and 33 both 2, 34 is 3). **`numberHidden` is ignored in
All variations** — as the view draws every alternative, a hidden visit
in one variant has no single answer — so a hidden number shows here, as
the codes always did. Tints, the one purple in print and `allVariations`
as a non-print option are unchanged.

**Never on paper.** Without the option a `tint` is ignored — the layer's
output equals the untinted structures' — and nothing in the print path
sets it: `PageInput.course.viewOptions` is a `Pick` without
`allVariations` (and with `labels`, F15; a hint, not a guarantee — `resolve-sheet.ts` adds
options through spreads), and the guard is the fixture: `composePage` of
tinted structures emits the plain stream with no tint row
(`print/__tests__/compose.test.ts`). F8's all-variations page
prints every alternative in the one purple: the same spine and branches
(`allVariationStructures`) without `tint`, no `allVariations` option,
codes — or the numbers of the equal fork above (F15; `course-print.md`
§4.6; a second compose fixture checks the plain colour table). Decided on the user's
standing instruction (2026-11-07), for review: branches rather than
groups in the layer (keeps "a variant is a linear structure"); the tint
rows on top rather than beside lower purple (no document re-index for a
screen-only view); one row per label, shared by groups with the same
label.

## Tests

| Layer | Where | What |
|---|---|---|
| unit | `packages/shared/src/course/__tests__/colour-stack.test.ts` | upper white inserted below upper purple with the remap; ISSprOM unchanged; source colours above upper purple; refusal without purples; `hexToCmyk` ↔ `cmykToHex`; object rows on top |
| unit | `symbols.test.ts` | ISOM / ISSprOM dimensions, document factor, appearance multipliers, knockout, roles, 711 borrowed; F19: the corridor edge `705/edge` with round caps, 705's colour and width × factor × `line`, not in `symbols`; the dangerous area: 709's hatch in both diagonals, 709.b / 709.c's boundaries, scaled like 709 (both libraries); arcs within 1 µm of the circle, gaps as open arcs, an arc through north one path |
| unit | `cuts.test.ts` | clearance = symbol + half line + air at both arc ends and both gap ends, on / off the rim and the line by the same sum, wider for bigger symbols and lines, default radius, north wrap, whole circle; library radii (`cutSymbolRadiusMm`), OCAD symbol radii (`ocadCutSymbolRadiiMm`), `cutContextForScale`; `cutFeaturesOfDocument` (applied match, source code, suggested match, hidden symbol, line object, own render, factor fallback) |
| unit | `cuts.test.ts` "polylineLegGaps" | §3.4 "Bent leg" (F1): a straight leg equals `legGaps`, fractions along the bends, one gap across a bend, end keep at the ends only, the 70 % cap |
| unit | `course/__tests__/cuts-reference.test.ts` (fixture `__fixtures__/cuts-reference.json`) | §3.4 (F20b): 40 seeded cases of 12 legs (straight, bent, cubic up to 84 points) over up to 2000 features with and without `r` plus clusters on the legs (the 70 % cap), several `R` and `w`, through `polylineLegGaps` and `circleCuts`, recorded before the prefilter and compared bit for bit; `UPDATE_CUTS_REFERENCE=1` re-records (only for an intended change) |
| unit | `derive.test.ts` "bends and styles" | §10.1: `legLengthMm`, a bent leg's points and pieces clipped at both sites, repeated / on-site bends dropped, stored gaps at the bent mid-length, a piece unbroken through a bend just after a gap, nothing within a site's clearance with a bend inside it, an automatic gap across a bend, the resolved style and `none`'s pieces |
| unit | `layer.test.ts` "leg styles" | §10.1: a `marked_route` leg draws 707 through its bend, upper purple, more than three dash slices, after black; a `none` leg draws nothing, numbers unchanged |
| unit | `checks.test.ts` "test the bent polyline" | §9.2: a bend round the building clears it, the first hit along the bends |
| PDF | `packages/shared/src/print/__tests__/write-page.test.ts` "a marked-route leg" | §10.1 print: the route is one extra stroke of dash subpaths at 707's width, in purple after black, no `d` operator |
| unit | `course/__tests__/corridor-reference.test.ts` (fixture `__fixtures__/corridor-reference.json`) | §10.2 (F20b): 66 cases — h = R, a lone wide leg, a one-point run, a 701 wider than the triangle, edged meeting unedged, a reversal, and 60 seeded courses (straight, bent and cubic legs, widths 2–8 mm, bands 0–5 mm, edged or not, one width or mixed, a turned start, a second course crossing or sharing legs, a passing site, with and without mouths) — recorded before F20b; each case's inside, band, edges and openings as a SHA-256 of their JSON plus counts, compared bit for bit; `UPDATE_CORRIDOR_REFERENCE=1` re-records (only for an intended change). F22: a SHA-256 per component (`parts`: inside, band, edges, openings; added on unchanged geometry first, every combined hash byte-equal), `UPDATE_CORRIDOR_REFERENCE=band` re-records only if every inside, edges and openings hash stays (F22 re-recorded 31 of 66 bands, nothing else; its review fix — a run's own earlier part keeps its band in the cut — moved 4 of those again: the reversal and three seeded loops); "F22: only the band's terminal ends moved": per case the inside, edges and openings equal to `{ terminalEnd: "round" }`, every band outline vertex of either result off the other's outline (> 2 µm) within √((h + 2w)² + w²) or R + w (+ 20 µm) of a terminal end, no new band ring under 0.01 mm², more than 10 and fewer than 66 bands changed |
| unit | `corridor.test.ts` "the last call's result is kept" | §10.2 (F20b): the same input → the same object; a moved point, a width, a band, the edge, the course id, a leg's index, no mouths, a moved mouth site, its role, a start's turn, an extent each recompute and equal a fresh call; `-0` is not `0`; a site no corridor leg ends at does not count; F22: the terminal end option recomputes (two options in a row, two results) |
| unit | `corridor.test.ts` "terminal ends (F22)" | §10.2 "Ends": `TERMINAL_END` the default; a lone leg h < R (inside, edges, openings equal to `{ terminalEnd: "round" }`; the map behind each circle where the band was, the near half in the band up to the line, the mouth's corners arcs of radius w(2R + w) / (2(R + w)) about (r, ±R) or the run's own); without mouths a flat face at ±h on the leg's points with corner arcs of radius w about (w, ±h); h ≥ R (round inside end and closed edge kept, no band past the line); the finish (R the 706's, its near half wrapped up to the line); the start unchanged (turned and not, and h ≥ its extent); a run passing behind or over its own terminal end (a hairpin, a figure eight with its end on its first leg, a short last leg turning back at the editor's default 50 m / 5 mm, a short last leg at a right angle) keeps the other legs' band, the end itself still cut; one corner where the band reaches past the circle (user: "fix the bump"; w < R, w = R, w > R at the default 50 m / 5 mm, h ≥ R): nothing past the line, nothing farther from the leg than h + w (no bump), the face's ends at ±(h + w − r), every corner vertex on the arc of radius r = min(w, h + w − R) about (r, ±(h + w − r)), the circle's near half in the white or the inside; h + w ≤ R: the mouth's near half (face ±R, corners of radius w(2R + w) / (2(R + w)) internally tangent to the R + w disc, nothing past R + w, the circle wrapped); a property over h 0.5–4 mm and w 1–8 mm (R 2.5): the arc above the circle near the line (analytic, ε from 0.1 µm to r), the circle's near half wrapped, nothing past h + w (h + w > R) or R + w; a run through a control (middle unchanged, both ends cut); never thinner — a width change, a band change, two courses meeting, a reversal on one site id, a turn: band membership on a 0.1 mm grid round the site equal to the pre-F22 band; a corridor passing over a terminal site keeps its band; a curved end (simple rings, the map behind it); two options in a row two results |
| unit | `corridor.test.ts` | §10.2 geometry: a straight leg (inside, band, the map beyond, round ends — with `{ terminalEnd: "round" }` since F22, as are F19's band-wrap probes at a lone leg's ends), a bend (no inner notch, round outer join), consecutive corridors joined, mixed widths at a site and two courses crossing, degenerate inputs (out and back, collinear legs, the same leg on two courses) give simple rings, `whiteMm` 0 has no band, edges along edged legs only (closed for a lone leg, none on an unedged course); F19 "mouths and openings": a control's disc in the inside and the band to R + `whiteMm`, h ≥ R equal to the rings without mouths (answer 1), a finish's outer ring, the turned 701 (and unturned), a passing control no mouth, `edge: false` a mouth without opening or edge, the larger `whiteMm` of two legs, the edge two open pieces ending within 30 µm of the junctions, no edge behind the 701 (flat run end), a corridor wider than the 701 at its centroid with its sides carried back to it, the openings `θ ± asin(h/R)` with the junctions on the boundary, a turn and a straight run through a control (two sectors), none where a wider corridor covers the junctions, a curved leg (F16 smooth bend: end segments far shorter than √(R² − h²)) opening both circles about 2 asin(h/R) wide with its junctions on the boundary and the edges ending on them, a bend inside the circle opening where the corridor crosses it |
| unit | `derive.test.ts` "corridors" | §10.2: `widthM` → paper mm at the document's `mapScale`, `whiteMm` kept; points, gaps, pieces and length unchanged; a `none` leg keeps its corridor |
| unit | `layer.test.ts` "corridors", "courseDocumentContext" | §10.2: the band one `clip` region of every symbol after the explicit and stored ones (probes inside / in the band / beyond); `symbolise` masks the map's 516 there and no course pass; the edge `705/edge` strokes on the edge line, ref `corridor` (F19: two open pieces from the 701 to 31's opened circle; a 120 m corridor one closed outline); none without `edge`; a `none` leg keeps band and edge; F19 "openings": 31's circle one open arc ending within 30 µm of the junctions, the derivation's sites equal to the plain layer's, the start alike, a smooth-bend leg opening it too, whole with `edge: false` and at h ≥ R, merged with an overlapping stored gap (the cuts still the stored one), kept with auto cuts off, a passing control whole; no band at `whiteMm` 0; §2 `mapScale` from the header on both branches; F14: the `legLine` table, a corridor leg no `leg` object (edge, band, pieces and numbers kept), a `marked_route` one still 707 |
| unit (web) | `packages/web/src/lib/editor/__tests__/hit.test.ts` "a corridor's edge" | §10.2 through the real worker: the edge's `corridor` refs are no target; the corridor leg has no hit piece and hits from `uiLegsOf` (F14); F19: the circle at its end opened (cuts `[]`), its centre hits only through the UI circle, its far rim through the arc, its opening not at all; a `marked_route` one keeps its piece; the reply's static-bucket filter carries the band's mask |
| PDF | `write-page.test.ts` "a corridor leg (F2, F14 …)" | §10.2 print: the band a `q … W* n … Q` clip (frame, outer ring, hole) round map strokes only — no purple course stroke inside it; the edge one extra closed stroke (`h S`) in the circles' purple at 70 w; one open purple stroke fewer than the plain page (no 705 along the corridor leg, F14) |
| PDF | `write-page.test.ts` "a narrow edged corridor (F19)" | §10.2 print, 40 m at 1:10 000 (h 2 < R 3.75): 31 and 32 no longer closed strokes but open arcs; the edge two open strokes under `1 J` at 70 w; open purple = plain − 1 + 2 + 2; the circles keep flat caps |
| unit / integration | `packages/api/src/__tests__/course-structure.test.ts` "layerPropsOfStored", `integration/course-structure.test.ts` "course.list carries every stored leg whole" | §5: the stored legs whole by public ids, `crossing` as the site's public id (string; an unknown one dropped, F4), an empty leg omitted, no `legGaps` |
| unit | `structure.test.ts` "slice-F kinds (F4)", `variants.test.ts` | §6.1: `SITE_KIND_NOT_ITEM` for a crossing / map-issue item (top level, in an alternative), an exchange item passes, `CROSSING_KIND` / `SITE_UNKNOWN` for a leg crossing, the wire form takes the crossing by public id; `structureSiteIds` lists the crossing points after the items; `pruneSiteFromStructure` strips a crossing and keeps the rest of the leg |
| unit | `derive.test.ts`, `layer.test.ts`, `symbols.test.ts` "crossings and map-issue points" | §10.3: `routedBends` (nearest segment, before / after a bend); the leg through the site, its length grown; 710 numberless, uncut, no clip, turned along the chord; the section reported; an unreferenced crossing and a map-issue point only with setter marks (north–south), crossings with `allControls`; an exchange numbered as a control; a crossing / map-issue item skipped. ISOM 710 one line over the body (6 mm section) in lower purple; ISSprOM 710.1 turned, a section two 710.2 lines either side, the second reversed; 702 only with `setterMarks`, unrotated; the library entries per standard |
| unit | `checks.test.ts` "a leg through a crossing point" | §9.3: exempt at the obstacle the crossing sits on (on it, within 1 mm), a second obstacle still reported, 2 mm off exempts nothing, the routed polyline goes round the building |
| unit | `packages/api/src/__tests__/course-structure.test.ts` "crossingRowsOf", wire form | §10.3: the rows anchored after the item the leg leaves, `null` after the start; the crossing mapped both ways, in alternatives |
| unit | `course-geometry.test.ts` "measures a leg through its crossing point" | §4.1: `via` routes the length |
| integration | `packages/api/src/__tests__/integration/course-crossings.test.ts` | §6.3 / §10.3: code-less crossing and map-issue points (names, seq above `MARK_SEQ_BASE`), an exchange with codes, status sync, `controlCoordinates.kind`; `setStructure` refuses a crossing item, a crossing naming a control, an unknown one, nothing written; accepts an exchange item and a crossing leg (column uuid, wire public id, `course.list.legs`, `course_controls` items only, the lengths' sequence through it); kind changes refused while an item / while routed, free ones accepted; a moved crossing rebuilds its courses; delete strips the legs (token, journal), restore + `setStructure(before)`; print: a course sheet's sites hold the crossing and its 13.4 row, only the all-controls sheet sets setter marks and holds the map-issue point, no row for it |
| integration | `course-checks.test.ts` "a leg through a crossing point on the building's wall" | §9.4 server: the exemption over the pinned document; the crossing point takes no site check |
| E2E | `e2e/map-vector-layer.spec.ts` "a stored marked-route leg draws 707's dashes", "a stored bent leg draws through its bend" | §5 / §10.1 on screen: a leg stored through `course.setStructure` reaches the GL canvas — dashes with yellow gaps between them, and purple on the bent piece with the straight chord's midpoint left yellow |
| unit | `course-geometry.test.ts` "legs along their bends" | §4.1: a bent leg's length, style and corridor change nothing |
| integration | `control-editor.test.ts` "course.setStructure with bends" | §4.1: `legs` / `length_m` along the bends through `setStructure`, a `none` leg still counted |
| unit (web) | `course-editor.test.ts` `sequenceLegMeters`, `editor/__tests__/leg-length.test.ts` | §10.1: readouts along the bends, label at the bent mid-length |
| unit | `packages/shared/src/course/__tests__/bends.test.ts` | §10.1 curves (F13): no handles ⇒ exactly `[a, …bends, b]` (repeats dropped); a cubic flattened within 5 µm of the exact curve, anchors verbatim; a quarter circle of radius 20 measures `20 + 10π` within 0.02 mm; a site never curves a segment; `bendSegmentAt` (curved segment at its apex with `t` ≈ 0.5, straight ones near the ends, ties to the lower index); `reverseBends` swaps the handles and flattens to the same length; determinism |
| unit | `structure.test.ts` "takes a bend's handles", `derive.test.ts` "curved bends", `checks.test.ts` "test the flattened curve" | §6.1 / §10.1 / §9.2 (F13): handles parse in the column and wire forms, corners byte-equal, a non-finite or half handle refused, `structureDiff` sees a handle; the leg's `points` the flattened curve with the anchors, clipped at both sites; a stored gap at mid-length sits at the apex, not the chord's midpoint; a cut at the apex, none beside the chord; a crossing joined on the curved segment as a corner with the neighbours' handles kept, turned along the curve; a curve pulled through a building reports it where the corners do not; `VARIATION_UNBALANCED` along a looping handle |
| pass-stream + golden | `scenes.test.ts` "course-legs-curved", `e2e/__golden__/map-gl/course-legs-curved.png` | §10.1 (F13): a curved 705 stroke through the curve's mid-point within 5 µm and its bend vertex, far from the chord; a curved 707 in upper purple; a crossing point on a curved leg, turned along it; snapshot, reference raster, WebGL2 and PDF tiers |
| unit / integration | `course-geometry.test.ts` "curved legs", `integration/control-editor.test.ts` "course.setStructure with handles", `integration/course-export.test.ts` "a curved leg" | §4.1 (F13): the length along the curve (corners measure their own); stored `legs` through `setStructure`, the handles read back whole by `course.list`; IOF `LegLength`s / `Length` = stored; Purple Pen's flattened bends within a metre |
| unit | `ppen-course-export.test.ts` "curved legs" | §6.4 / `ppen-import-export.md` (F13, answer Q3): a corner leg writes what it did; a curved leg's `<location>` points within 0.1 mm of the curve, its bend among them, no handles; the round trip as corners within 0.1 mm and a metre |
| unit (web) | `editor/__tests__/bends.test.ts` "curved bends", `leg-length.test.ts` "curved legs", `course-editor.test.ts` "measures a curved leg" | §10.1 (F13): the editor's `legPolyline` is the layer's; *Add bend here* on a curve lands between its bends as a corner; a moved bend keeps its handles; the label and `sequenceLegMeters` along the curve; a dragged control's leg out reversed with its handles swapped |
| E2E | `e2e/course-editor.spec.ts` "F13: Bézier bends" | §10.1 on screen and in print: a curved leg written over tRPC reads back whole, its drawn pieces through the bend, purple at the apex and none at the chord's midpoint, the leg's metres longer than the chord, `maps.pdf` one page |
| unit | `derive.test.ts` | legs and clearances, circles in the way, unpositioned sites, automatic vs authored gaps, the event's auto cuts off (no automatic slits / gaps, authored ones kept, §3.4), authored pieces and bends, free order, all-controls, start rotation, sequence / repeated / code numbers, y-down placement, manual offsets, multi-course |
| unit | `layer.test.ts` | one `symbolise` call with a document: warning-free, lower purple under black, re-indexed document colours, object offsets; turned start, arcs, legs; auto cuts off = the objects without cut features; knockout halo order; sprint sizes; layout objects (white-out, 709.b, rows on top, text values, page-mm sizes); toner-saver ring and its warning; the toner saver white (P1: a `toner_saver` and a `whiteoutInverted` map object fill the top row, the last pass after black, upper purple and a layout text's row; none for a plain white-out or without a window); images; `courseDocumentContext` |
| pass-stream | `scenes.test.ts`, snapshots in `render/__fixtures__/streams/course/` | the course scenes (`map-rendering.md` §6.3; `course-leg-styles` since F1, `course-corridor` since F2, `course-legs-curved` since F13 — symbolised with the layer's regions, masks in the snapshot; `course-corridor` re-recorded in F14: no 705 along its three corridor legs, in F13: one buffer ring per run, and re-shaped in F19: a 60 m edged run S → 31 → 32 and a 150 m unedged leg, the mouths, 31 opened twice, the round-capped edge; re-recorded in F22: the band stops on the line through 33, its only terminal end — the golden `course-corridor.png` changed in 4 032 px, all in one box round 33; `scenes.test.ts` probes the map behind 33 and the band beside the leg before it) warning-free and equal to their snapshots at 1 µm, plus each scene's rule |
| unit | `packages/api/src/__tests__/course-geometry.test.ts` | `editorCourseLayer`: sequence in order with roles, centre-to-centre legs, unpositioned controls skipped, free order without legs, no automatic cuts; `hasPositionedItems` (`length_source` derived / NULL); `legDistancesMm(layer)` from the derived legs = the pre-E6 sequence formula bit for bit (fixtures + 50 generated sequences, per-leg and total rounding at two scales, E6); `courseLengthM` |
| unit | `packages/api/src/__tests__/document-readers-parity.test.ts` | cut features of the document = the legacy OCAD adapter's (now a test oracle, `__tests__/helpers/ocad-oracle.ts`) within 1e-6 mm on the fixture and the corpus (§4.2) |
| unit | `packages/api/src/__tests__/course-sequence.test.ts` | §6.2 "Readers" (E6): `courseSequenceOf` — columns (defaults, `start_name`, a live `finish_control_id`, unmatched fall back, the flags), a stored structure (explicit ends, no ends → defaults, roles), a deleted explicit start, an invalid column read as the columns, no starts / finishes |
| integration | `packages/api/src/__tests__/integration/overprint-cuts.test.ts` | what the layer draws for a stored course with the pinned document's cut features (`drawnCuts`, E5): rim slit over the boulder across north, no gap through the building, leg gap over the boulder, cuts follow a move, a course created before the map is cut once the upload pins, the toggle off draws none and writes nothing else (course row and journal untouched); two events pinning the same map read the same features and cut alike within 1e-6, no cuts without a pin; the toggle off reaches the vector print (composed sheet = the page without cut features, a stored circle gap still drawn) and `getOverprintCuts` reads with a kiosk key (§3.4) |
| integration | `control-editor.test.ts`, `journal-completeness.test.ts`, `course-export.test.ts`, `eventor-reentry.test.ts` | the drawn course (`helpers/course-drawn.ts`) and lengths on create / move / delete / copy, `length_source = 'derived'`; `course.upserted` payloads carry no `length_source`; the export's length and the Eventor sync key on `length_source` (E6; the E6 migration's backfill test went with `geometry_source` in E5) |
| unit | `packages/shared/src/course/__tests__/structure.test.ts` | §6.1: C0's linear shape accepted, the 08 leg props, groups and loops, an empty alternative beside a non-empty one (answer 5), a group of empty alternatives only (F7); nesting, overlap, unanchored, duplicate ids / labels, < 2 alternatives, out-of-range gaps refused; interim `path` / `pieces` / `circleGaps` and `extras` refused; the wire form; site rules; `linearStructure`, `structureControlIds`; `structureDiff` (equal, moved, added, removed, leg / offset changes) |
| unit | `packages/shared/src/course/__tests__/variants.test.ts` | §12.1: no groups → no variants; the product in item order and its keys; legs and flags copied; loop permutations with the anchor between them, three alternatives → six; an empty alternative a straight leg (and no anchor visit in a loop); the anchor visit's fields; keys stable across an edit outside the groups; multi-letter labels and colliding keys; `variantCount` without building; `variantStructure` = the product's row, parsed by the column schema; `structureSiteIds`; `pruneSiteFromStructure` (every alternative, an emptied alternative kept, all emptied kept (F7), unanchored / adjacent dissolved, the label offset); F7: `variantOrders` (keys and orders in the product's order), `pathOfOrders` = each variant, row paths (top level, an alternative's index, the loop's anchor visit), a missing / unknown order shows the first alternative, an all-empty group's identical variants, the wire form |
| unit | `layer.test.ts` "variation tints (§12.7, F7)", `colour-stack.test.ts` "variation tint rows" | §12.7: with `allVariations` the rows on top in first-use order, distinct tints, a tinted course's 705 and the circle only it visits on its row, the spine's untouched; without the option the layer equals the untinted one, no tint row; the rows below a toner saver's white; `withTintColours` cycling and `indexOf` |
| unit | `packages/shared/src/print/__tests__/compose.test.ts` "variation tints never print" | §12.7: `composePage` of a tinted structure = the plain one's stream, no `course-tint:` colour; `allVariations` is no `PageInput` option (`@ts-expect-error`) |
| unit | `checks.test.ts` "variation groups (§9.2 VARIATION_*, F7)" | §9.2: unbalanced beyond 10 % at the anchor with the shortest / longest, within 10 % none, an empty alternative the straight leg, bends and a crossing lengthen, the shared exit leg, a loop's petals (an empty one skipped), all empty → `VARIATION_ALL_EMPTY`, an unpositioned anchor skipped, paper mm without a scale, the codes' order |
| unit (web) | `course-layer-request.test.ts` "variation tints (F7)" | §5: a tinted course carries its tint and sets `allVariations`, codes with several courses; none without a tint; F15: a spine's `labels` become `viewOptions.labels`, none without one |
| unit | `variants.test.ts` "uniformVariantNumbers (F15)" | §12.1 / §12.7: an equal fork numbers both alternatives alike, an unequal fork / a loop of two petals (one petal has no repeat) / a repeated top-level site → `null`, two forks continue the numbers, an unequal second fork makes it codes, a shared control at the same position only, rejected items take no number, an exchange counts, wire ids |
| unit | `derive.test.ts` "numbers (§3.5)" | §3.5 / §12.7 (F15): `viewOptions.labels` wins over the sequence and over codes with several structures, an omitted site keeps its code, the start is not labelled, `numberHidden` ignored |
| integration | `variant-pages.test.ts` "the all-variations page numbers an equal fork (F15)" | §12.7 / `course-print.md` §4.6: an equal fork's page carries `labels` (1, 2, 2, 3) and its block rows 1, 2, 2, 3, still no tint and no `allVariations`; an unequal fork has neither |
| integration | `packages/api/src/__tests__/integration/course-variants.test.ts` | §12.2–12.5: one child per variant (name, key, parent, copied fields, linear structure with its own id, mirror, lengths as the root's path), journal root first then children; `variantList`, `list` / `detail` by seq; a loop's permutations; an empty alternative, all empty accepted with identical children (F7); colliding keys and the cap refused, nothing written; re-materialisation (same rows across an outside edit, a new key, every key gone → soft-deleted and the runner nulled with its `runner.updated`, keys back → the same uuids); `runner.updated { courseId }` replayed through `events.push`; label offsets of every alternative round-trip; pools (a class on the root, a class picking it later, a key added / dropped, a plain course clears); the refusals (`ROOT_HAS_VARIATIONS`, `COURSE_IS_VARIANT`, nothing written); name / climb / maps mirrored; an offset set through the root; clone of a root and of a variant; delete of a root; `control.delete` of a control in alternative B only (one entry per row) and of a group's anchor (dissolved); an import over a root; an import with `replaceAll` over a root (the runner on a variant nulled and journaled, the pool emptied); a peer applying a root's and its variant's `course.upserted` through `events.push`; the migration's unique pair and `CHECK`; a checkout snapshot exported and imported with its children and pools (the backup dump is `SELECT *` per table, so the children are ordinary `courses` rows there) |
| integration | `packages/api/src/__tests__/integration/runner-variants.test.ts` | §12.3–12.4 with F6b: a vanished variant's runner dealt one of the remaining pool (the entry carries the seq), a class onto / off a root deals / clears its runners after its `class.upserted`; the rest of F6b is listed in `course-controls-and-matching.md` "Test coverage" |
| integration | `journal-completeness.test.ts` "course.setStructure with a group" | §12.4: the variants' `course.upserted` (parent, key, name), the class's `coursePools`, the vanished variant's `runner.updated { courseId: null }` |
| E2E | `e2e/courses.spec.ts` "a course with variations lists its variants under it" | §12.6: a root written by `course.setStructure` over HTTP shows "2 variants", its two variant rows right under it with no controls of their own, the roots-only count, and a read-only sequence in its detail; F17: variant B's row expands to its own codes (`181;183;184`, disabled, name disabled, hint, no order mode), the root's detail closes (`aria-expanded`), `?course=<variant>` reopens it, a second click closes it. `course-variants.test.ts` "variantList, list and detail…" adds the contract: a child's `detail` carries its own `controlCodes` and `classes: []` |
| unit | `packages/api/src/__tests__/course-structure.test.ts` | §6.2: `splitStructure` (explicit start / finish, implicit default, role start / finish, a start mid-sequence), `structureFromColumns` and its round trip, wire ↔ stored mapping |
| unit | `packages/api/src/__tests__/version-conflict.test.ts` | §7: the `errorFormatter` lifts the payload beside tRPC's fields and leaves the duplicate-code `CONFLICT` alone; `controlFieldsDiff`; `baseVersionSchema` |
| integration | `packages/api/src/__tests__/integration/course-structure.test.ts` | kind ↔ status sync, the slice-F kinds written (F4), circle gaps; `course.update` writes a structure, token = the entry's HLC, structure and token in the payload; a pre-D0 course reads from its columns; `setStructure` mirror (start / finish, sequence, hidden numbers, label offsets not in the column), geometry byte-identical to `update`'s, variations and unknown controls refused; stale course token → `CONFLICT` with current and differing, nothing written, no token = LWW; stale control token → differing fields; `differing: null` at token 0; separate tokens both ways; `control.delete` prunes and advances; seeded groups hold `courses.review`; a controller checks off and writes notes but cannot move |
| unit (web) | `packages/web/src/lib/__tests__/version-book.test.ts` | §7 `VersionBook`: newest token as an integer compare, list seeding, the conflict payload off a client error, public id after a code change |
| E2E | `e2e/courses.spec.ts` "an edit from a stale copy…" | §7 over HTTP: another client renames the course while this page's poll is held; this page's edit is refused, the notice shows, the page reloads the other write |
| unit | `packages/api/src/__tests__/course-import-structure.test.ts` | §6.4: pieces → leg gaps (one piece none, two pieces one gap as fractions, either direction, touching pieces and off-axis pieces), per-course leg gaps by `from>to`, the object kinds and scopes, dedupe, leg cuts and description boxes ignored; F9: a bent leg feature's inner vertices as bends (straight and pre-clipped legs none, first of a pair wins), `importedLegProps` joining gaps / bends / style / crossing |
| unit | `packages/api/src/__tests__/course-structure.test.ts` "carryLegs" | §6.4 (F9): a leg carried to an item that still follows the same site, none on a new predecessor; the item's own props win, the carried ones fill in |
| unit | `iof-course-export.test.ts` "course structure (F9)", `ppen-course-export.test.ts` / `ppen-course-parser.test.ts` (F9) | §6.4, §12: `CourseFamily`, the crossing point's control and row, `TapedRoute`, the exchange marker, each round-tripped; a foreign file's folded rows; Purple Pen `<leg>` bends both ways, the leg measured along them |
| integration | `packages/api/src/__tests__/integration/course-export.test.ts` (F9) | §4.1 (F1 Q2 B): a bent course's exported `LegLength`s and `Length` equal the stored `legs` / `length_m` (IOF and Purple Pen); a forked event: variants with their family, root omitted, class per variant, crossing row, taped route, exchange marker, no map-issue point, every variant's legs equal its stored ones |
| unit | `ocd-course-parser.test.ts` | §6.4: the parser fills `cuts` and reads 708 |
| integration | `packages/api/src/__tests__/integration/course-import-structure.test.ts` | §6.4: `e2e/test.ocd`, a Purple Pen and an IOF file leave stored, explicit structures and the mirror; the written rows hold the `reference.imported` HLC; a parsed OCD bundle: slits → `circle_gaps`, pieces → `leg.gaps`, objects with scopes and `source`, a re-import replaces them and keeps a hand-drawn one; an XML re-import over an `ocd` course leaves its column byte-equal, carries the leg gaps on an unchanged leg and drops them on a reordered one, and writes the file's positions; an XML import over a non-`ocd` course writes its geometry and `length_source = 'file'` (E6); F9: an IOF file with a family, a crossing point (passage), a taped route and the exchange marker → the family in the preview, two linear courses and no root, a `crossing_point` site above `MARK_SEQ_BASE` that is no item, the finish's leg `{ style, crossing }`, a `map_exchange` site; a re-import matches the crossing point by name |
| golden | `e2e/__golden__/map-gl/course-*.png`, `packages/api/src/render/__tests__/golden-files.test.ts`, `e2e/map-gl-golden.spec.ts` | reference raster = committed golden; WebGL2 ≤ 0.5 % (`map-rendering.md` §6.2). The PDF tier joins in C3 |
| unit (web) | `packages/web/src/lib/__tests__/course-layer-request.test.ts` | the §5 request rules (offsets only with the sheet or the editor; `autoCuts: false` only when off; F4: `overlayTypeOf`, crossing / map-issue sites never make the view all-controls, `setterMarks` and a leg's `crossing` passed through, `sheetCrossings`); the provisional visit (a control at a position, before the finish, past the end, repeats counted; start / finish replace or lead / end; a reused site adds no site, `provisionalDrawn` agrees with the site pushed (P4); the split leg loses its stored gaps; ignored without exactly one highlighted course); §8.2 scope by highlighted course over `inCourses`, all-controls = `all` only, parked nowhere; objects without scope / `z` / token / `inCourses` |
| unit | `packages/shared/src/course/__tests__/objects.test.ts` | §8.1 each kind accepted (`hatch` included), short geometry / unknown props / an unknown `hatch` / bad filter props / Bézier region refused; §8.2 the scope truth table; §8.3 each kind onto its symbol (709 / 709.b / 709.c, the dangerous area and its boundaries for `hatch: "710"`, 708 / 711, 707, white-out), Bézier handles kept, text upper purple or own row and not divided by the enlargement, image corners, toner saver with and without a window and with Bézier handles (bezier flags in the hole ring only), `inset_frame` and `filter_region` draw nothing |
| unit | `layer.test.ts` "a stored filter_region course object" | §8.3: the same region as the explicit one, after it; hides the document's 516 |
| unit | `layer.test.ts` "course objects as F12 moved layout objects" | §3.6: white-out at upper white, 709 / 709.b / 709.c by border, a text's own row on top at paper mm (no division), the toner saver ring and its white row last (P1), `WINDOW_MISSING`, an image to `layer.images` as `{ graphicId, crop, rectUm }` |
| pass-stream | `scenes.test.ts` "course-objects", `print/__tests__` page scenes "page-ring", "page-rotated" | §3.6: the fixtures' former map-anchored objects written as the course objects F12 makes; the stream snapshots unchanged byte for byte — the move draws the same |
| integration | `course-objects-migration.test.ts` | §3.6 the F12 migration on a scratch database built to the migration before it: the guard refuses all eleven reasons of a live event (a solid fill, a black stroke and line, a stroked white-out, short areas and lines, an image without its graphic, a text without a size or over 100 mm at os 0.75, an unknown kind and fill), names each in the detail and changes nothing; after the runbook's fix-ups every kind maps (whiteout, legacy `whiteoutRect`, toner saver, 709 / .b / .c, 708 / 707 from purple lines and closed outlines, a template's own purple, text ÷ os with the latest map's scale and a sheet's print-scale override, image corners), scopes per row type (template, course / class / all-controls / setter sheets), `source = 'layout'`, `version 0`, `z` under a hand-drawn object, seq order; invisible objects removed; a soft-deleted event's refused object removed; club payloads stripped; page objects kept in order; every body parses; a second run changes nothing |
| integration | `course-print.test.ts` "F12" | §3.6: a sheet's map-anchored white-out and text, migrated on the shared database, are `source = 'layout'` objects scoped to its course; the sheet keeps its page object; the composed page draws the white-out at upper white and the text at 4 mm on paper |
| E2E | `course-editor.spec.ts` "F12" | §3.6: a legacy map-anchored white-out and 709 area seeded on a sheet and migrated: listed in Course mode scoped to the course, the map's ink under the white-out gone on the canvas, the sheet's `maps.pdf` one page with one more hatch |
| unit | `packages/api/src/__tests__/version-conflict.test.ts` | §8.4: the object `CONFLICT` payload |
| integration | `packages/api/src/__tests__/integration/course-objects.test.ts` | §8.4: every kind created and listed in draw order with public ids; `inset_frame`, unknown course / class, bad body refused; update advances the token, `hatch: "710"` round-trips, `"711"` refused; stale token → `CONFLICT` with the object now and nothing written, none = LWW, stale delete; reorder keeps tokens; kiosk-key read, viewer cannot write; §8.2 class scope through `course_id` and the pool, the same resolution on the wire (`inCourses`); §8.5 snapshot round trip verbatim |
| integration | `course-print.test.ts` "course objects on the page" | §8.3 print: a sheet takes the objects in scope (all-controls: `all` only), they add passes over the map, `hatch: "710"` adds one hatch pass, a stored filter region hides map objects |
| integration | `backup.test.ts` | §8.5: the dump's `course_objects` section |
| E2E | `e2e/map-vector-layer.spec.ts` "a stored white-out course object paints the map white" | §8.3 viewer: an `all`-scoped white-out created through the API turns open yellow ground white on the GL canvas, yellow beside it unchanged |
| unit (web) | `packages/web/src/map-gl/__tests__/worker-course.test.ts`, `engine.test.ts` | the dynamic bucket (`map-rendering.md` §5.2); a document boulder slits a circle, `viewOptions.autoCuts: false` drops it and keeps a stored circle gap (§3.4); P7: a toner saver whose first vertex is left of the window, one crossing its bottom with the first vertex inside, and a toner saver beyond both sides — the toner white covers the window outside the shape and not its inside (§3.6) |
| E2E | `e2e/map-vector-layer.spec.ts`, `map-control-circles.spec.ts`, `map-multicourse.spec.ts` | lower purple under black at a crossing; labels under both pipelines (`map-rendering.md` §5.4) |
| unit | `packages/shared/src/course/__tests__/checks.test.ts` | §9: a fixture per code — both distance thresholds (library, scale fallback), event-wide distances, same feature, codes below 31 / duplicate / invertible (and the upside-down table), sheets null / empty / outside, numbers from `collides` and missing labels (hidden visits skipped), descriptions, legs through areas (crossing and inside), 708 lines, course objects (711 skipped), free order, unpositioned items; output order; `checkObstaclesOfDocument` (applied match, source code, suggested match, hidden, Bézier handles, holes, points) and the codes' library names |
| unit | `packages/shared/src/__tests__/control-label-placement.test.ts`, `course/__tests__/derive.test.ts` "number collisions" | §3.5: `collides` on a boxed-in number, absent on a clear map and a contested cluster; a NaN segment judged as before the F20 cull |
| unit | `packages/shared/src/__tests__/control-label-placement-reference.test.ts` (`__fixtures__/control-label-placement-reference.json`) | §3.5 (F20): 77 seeded cases — 64 courses dense to sparse with curved legs, 3 at ×1000 and 3 at ×0.01, 6 hatched clusters, far and degenerate segments — equal to the result recorded on the pre-cull placer, bit for bit (`UPDATE_PLACEMENT_REFERENCE=1` re-records, only for an intended change) |
| unit | `course/__tests__/drag-budget.test.ts` (fixture `drag-course.ts`) | §3.5, §10.2 (F20): 25 controls, one smooth bend per leg, 3000 cut features → > 800 segments after the cuts; `placeControlLabels` < 400 ms, `deriveCourse` < 500 ms (loose: they catch the quadratic coming back); F20b, the same course with a 50 m edged corridor and a 5 mm band on every leg: one run, 25 openings, `polylineLegGaps` over every leg < 100 ms, `corridorGeometry` < 600 ms for a moved course and < 20 ms for the same one (the kept result), `courseLayer` < 1000 ms |
| integration | `packages/api/src/__tests__/integration/course-checks.test.ts` | §9.4 over the pinned `e2e/test.ocd`: distance, invertible, missing description and the building leg with public ids; an `oob_area` in scope; `setStructure` returns the same list; a viewer reads it; §6.3 `description_source` writes (auto, manual even when equal, NULL on clear, auto on a re-describing move) and `DESCRIPTION_STALE` for a moved auto description only; a legacy event has no obstacle codes |
| unit | `structure.test.ts` "sectionsOf (F5)", `derive.test.ts` "sections (§11, F5)", `checks.test.ts` "map exchange parts (§11, F5)" | §11: one part without an exchange, the exchange in both parts, adjacent exchanges, an exchange first / last; numbers continue across the exchange, part 1 / part 2 drawn alone (no start on part 2, the exchange numbered on both, legs of the part only, `section` reported), a control visited in both parts, out of range / one part / several structures unchanged; `EXCHANGE_WITHOUT_SHEET` at the exchange after `CONTROL_OUTSIDE_SHEET`, none with every part covered / no sheets / one part, `CONTROL_OUTSIDE_SHEET` per part, a section-less window for every part, the exchange a control for descriptions, `NUMBER_*` over the derived part |
| pass stream + golden | `scenes.test.ts` "course-exchange", `e2e/__golden__/map-gl/course-exchange.png` | §11: part 2 alone — the exchange circle numbered 2, 33 numbered 3, no start, legs 32 → 33 → F |
| integration | `auto-templates.test.ts` "part sheets of a map exchange (F5)", `course-maps` print | §11 with `course-layout.md` §6: part sheets created (names, `section_index`, one template, NULL centre), class sheets per part, idempotent; `resolveSheet` of each part centred on its controls with the whole block and 13.5, `viewOptions.section` on the part sheet; `maps.pdf?courses=` one page per part; a deleted part sheet recreated by the next `autoSheets`, a removed exchange's part sheet kept |
| unit (web) | `course-layer-request.test.ts` "map exchange (F5)" | an exchange control is a `map_exchange` site, still on course; a sheet's `section` reaches `viewOptions`; `sheetExchanges` |

## Where things live

| Path | Contents |
|---|---|
| `packages/shared/src/course/types.ts` | input / output types, `appearanceFromTemplate` |
| `packages/shared/src/course/context.ts` | `courseDocumentContext(header)` |
| `packages/shared/src/course/colour-stack.ts` | `courseColourStack`, object colour rows, `hexToCmyk` |
| `packages/shared/src/course/symbols.ts` | the 7xx set: resolution, appearance, derived 703 / leader / white-out (`courseSymbols`, exported for the viewer's sizes, C4) |
| `packages/shared/src/course/arcs.ts` | Bézier circles and arcs |
| `packages/shared/src/course/cuts.ts` | `CUT_CODES`, `CUT_AIR_MM`, `circleCuts`, `legGaps`, `polylineLegGaps`, `cutFeaturesOfDocument`, `pointSymbolRadiusMm`, `cutSymbolRadiusMm`, `ocadCutSymbolRadiiMm`, `cutContextForScale` |
| `packages/shared/src/course/derive.ts` | the geometry rules (§3.2–3.5), `legLengthMm` (§10.1), the resolved corridor (§10.2), `routedBends` and the crossing angle (§10.3) |
| `packages/shared/src/course/bends.ts` | §10.1 curves (F13): `legPolylineOf` (the leg flattened at `LEG_FLATTEN_TOLERANCE_MM`, 5 µm), `bendSegmentAt`, `reverseBends`, `isCurvedSegment`, `hasCurvedBends`, `PPEN_FLATTEN_TOLERANCE_MM` |
| `packages/shared/src/course/corridor.ts` | `corridorGeometry`: the joined insides, the band and the edges (§10.2), on `polygon-clipping` |
| `packages/shared/src/course/objects.ts` | course objects (§8): schema, scope, `courseObjects`; `pageObjects` for the page layer's layout objects (§3.6) |
| `packages/api/prisma/migrations/20261109120000_map_anchored_objects_to_course_objects/` | F12's move of map-anchored layout objects (§3.6; runbook `docs/migrations/2026-f12-map-anchored-objects.md`) |
| `packages/shared/src/course/layer.ts` | `courseLayer`, `courseRenderInput` |
| `packages/shared/src/course/geojson.ts` | `courseLayerGeoJson` |
| `packages/shared/src/course-maps/{overlay-geometry,control-label-placement}.ts` | `clipLine` (per-obstacle clearance), `subtractLegGaps`, `circleArcs`, `placeControlLabels` (F20: the per-circle segment cull) — shared with the legacy overlay |
| `packages/shared/src/course/__tests__/drag-course.ts` | the F20 drag fixture (a seeded 25-control smooth-bend course, the placer's input from a derivation; F20b: `corridor` on every leg, `dragMouths`), for the budget tests; its `seeded` generator also drives the placer, corridor and cuts references |
| `packages/shared/src/course/__tests__/__fixtures__/` | F20b's reference fixtures: `corridor-reference.json`, `cuts-reference.json` |
| `packages/shared/src/render/__fixtures__/course/` | the course scenes |
| `packages/api/src/course-geometry.ts` | the lengths writer (§4.1): `editorCourseLayer`, `hasPositionedItems`, `legDistancesMm`, `loadCourseSequences`, `rebuildCourseLengths` |
| `packages/api/src/event-map-objects.ts` | cut features (§4.2): `loadEventCutFeatures` over the pinned document (`map-store/event-document.ts`) |
| `packages/api/src/course-import-structure.ts`, `course-import-objects.ts` | §6.4: pieces → gaps and the object bodies (pure), writing import-marked objects; `routers/course.ts` `importCourses` (the backfill and its CLI went in E6) |

| `packages/shared/src/course/structure.ts` | §6.1: `courseStructureSchema`, `courseStructureWireSchema`, `structureSiteIssues`, `linearStructure`, `structureControlIds`, `structureDiff` |
| `packages/api/src/course-structure.ts` | §6.2: `splitStructure`, `structureFromColumns`, `courseSequenceOf` (the readers' rule, E6), `carryLegs`, `persistStructure`, `rewriteStructureFromColumns`, wire mapping, `assertCourseVersion` |
| `packages/shared/src/course/variants.ts` | §12.1: `materialiseVariants`, `variantStructure`, `variantCount`, `variantKeyDuplicates`, `structureSiteIds`, `pruneSiteFromStructure`, `MAX_VARIANTS`; F7: `variantOrders`, `pathOfOrders`, `groupOrder`; F15: `uniformVariantNumbers` |
| `packages/shared/src/course/colour-stack.ts` (`withTintColours`, `VARIATION_TINTS`), `layer.ts` (`variationTints`) | §12.7: the screen-only tints |
| `packages/web/src/lib/editor/variation-view.ts` | §5 / §12.7: the editor's drawn course of a grouped structure (`courseDrawOf`, `allVariationDraws`, `withCourseOverride`) |
| `packages/api/src/course-variants.ts` | §12.3–12.4: `syncVariants`, `emitVariantSync`, `syncClassPool`, `clearRemovedVariants`, `assertMaterialisable`, `assertNotVariant`, `rootStructureOf`; called by `routers/course.ts`, `routers/control.ts` (`delete`), `routers/classRouter.ts` |
| `packages/api/src/version-conflict.ts`, `referenceJournal.ts`, `trpc.ts` (`withVersionConflict`) | §7: lock and compare, the base from the journal, the emits that stamp the token, the error shape |
| `packages/web/src/lib/version-book.ts` | §7 the client's row tokens |
| `packages/web/src/lib/course-layer-request.ts` | the viewer's request (§5), `courseObjectsForView` (§8.2) |
| `packages/shared/src/course/objects.ts` | §8: `courseObjectBodySchema`, `courseObjectScopeSchemaOf`, `courseObjectInScope`, `isCourseObject`, `filterRegionOf`, the kinds' drawing |
| `packages/api/src/course-objects.ts`, `routers/courseObject.ts` | §8.4: wire ↔ row, scope ids, `writeCourseObject` (shared with D1's importers), `loadCourseObjects`, `classesByCourse`, `objectsInScope`; the router |
| `packages/web/src/map-gl/worker.ts` (`courseReply`), `engine.ts` (`setCourse`) | the dynamic bucket that draws it |
| `packages/shared/src/course/checks.ts` | §9: `courseChecks`, `checkObstaclesOfDocument`, `UNCROSSABLE_CODES`, `OOB_CODES`, `invertedCode` |
| `packages/api/src/course-checks.ts`, `event-map-objects.ts` (`loadEventCheckDocument`), `description-autodetect.ts` (`describeAt`, `descriptionsEqual`) | §9.4: the server's list, `DESCRIPTION_STALE`; `routers/course.ts` `checks`, `setStructure` |

## Pending in this chapter

- **Viewer sheet objects and appearance**: the viewer draws the course
  objects in scope (§8.3) but no sheet's layout objects and the spec
  appearance; a sheet's objects and template appearance on the map are
  D7's (Layout mode).
- **Structure, beyond D1** (§6): the layer reads `numberHidden`, the
  site's `circle_gaps` and `LegProps.gaps` since D1, `style` and `bends`
  since F1 (§10.1), bends with handles (curves) since F13 (§10.1),
  `corridor` since F2 (§10.2), `crossing` since F4
  (§10.3); Purple Pen's `<leg>` bends and IOF crossing points / taped
  routes are imported since F9 (§6.4); Purple Pen's `<gaps>` /
  `<flagging>` and crossing / map-issue kinds, and OCAD / Purple Pen
  corridors, are not parsed by the importers; no importer writes a
  handle (Purple Pen's bends are corners — a curve goes out flattened at
  0.1 mm and comes back as corners, `ppen-import-export.md`). No editor
  gesture writes a handle until F16 (`course-editor.md` §6.7). Map exchanges split a course into parts since F5 (§11).
  Variations are materialised since F6 (§12).
- **A crossing's section length** (§10.3): 08 §4.3's `section` is a
  boolean, so the section form draws at 6 mm × factor; a stored length
  (`section: { lengthMm }` and a Leg-section field) waits for a row that
  needs true lengths (decided on the user's standing instruction
  2026-11-07, for review).
- **Variations, beyond F7** (§12): the editor authors groups since F7
  (`course-editor.md` §12) and its picker lists roots only; a variant is
  still an ordinary course in every other course list, a deep link opens
  it in the editor, and a save is refused (`COURSE_IS_VARIANT`).
  Per-variant pages, the all-variations print and Class view / Layout
  mode per variant landed with F8 (`course-print.md` §4.6), and the
  all-variations numbers (equal forks) with F15 (§12.7); the
  IOF family export landed with F9 (runners' variants and the dealing
  with F6b, the desk's accept of another variant's run with F6c —
  `course-controls-and-matching.md` "Forked courses and variants"). An
  imported `CourseFamily` stays separate linear courses (no group
  inference, F9). A loop does not check that the item after it is its
  anchor (the setter's; not added in F7). The server's `course.checks`
  computes no `VARIATION_*` code (§9.4). A 100-variant save is one
  transaction of about a thousand
  queries (`setStructure` allows it 30 s); a batched child write is the
  lever if real courses get near the cap.
- **A translucent corridor band** (§10.2, F26 deferred): `whiteOpacity`
  is stored and drawn opaque until the stream carries alpha
  (`map-rendering.md` §8); the editor's field returns with it.
- **Per-request cost on corridor courses** (§10.2). A control drag on a
  corridor course re-derives the corridors on every request (one request
  in flight since F20, `map-rendering.md` §5.2 "Engine"), and so does a
  bend or grip drag on a corridor leg since F21 (the leg draft, §5,
  `course-editor.md` §6.7): the kept result's key spans every course's
  corridor-leg points, so a drag on a corridor leg recomputes the
  corridors per request, while a drag on a leg without a corridor reuses
  the kept result. On
  the corridor drag fixture (`dragCourse({ corridor })`: 25 controls, one
  smooth bend per leg, a 50 m edged corridor with a 5 mm band on every
  leg, 1:15 000, mouths, 3000 cut features; Node, development machine)
  F20b took the request from about 230 to about 180 ms with only
  bit-identical levers (F22's terminal end adds a few tens of ms on a
  run's terminal end, decision log, F22): `polylineLegGaps` 22 → 1.6 ms (the feature
  prefilter, §3.4), `openingsOf` 10 → 4 ms (the circle point once per
  sample, segments rejected by bounds), `edgesOf` 16 → 12 ms (candidates
  per ring edge, numeric cells), and the kept result (above) for every
  request that leaves the corridors alone (0.1 ms). What is left is
  `polygon-clipping`: the inside union about 34 ms, the outer union about
  69 ms, the band's difference about 17 ms — no bit-identical lever
  reaches it (any re-association of the unions moves vertices).
  Measured and not taken (user, 2026-11-08, F20b answers): a per-leg
  cleaned-ring cache with a second union (inside 34 → 22, outer 69 →
  39 ms, but the boundary moves up to 5–7 µm in 28 of the 66 reference
  cases and the round joins at sites become two caps), and adaptive
  `edgesOf` sampling (moves edge-piece ends by up to a 50 µm step).
  `fastFilter` saves nothing here: the band is a `clip` region, decided
  by object bounds with or without it (`map-rendering.md` §5.2 "Filter
  regions"). The candidate for a later row (user: identity only in
  F20b): drag-time corridors on the `fastFilter` model — approximate
  while dragging (e.g. the per-leg cache), exact on release, the result
  at rest unchanged.
- **Corridor openings are geometric only** (§10.2, F19): no stored
  form, no `G` editing of them, not in the IOF XML / OCAD exports; the
  circle opens where the corridor meets it and nowhere else. A
  corridor wider than the 701 across its leg (a side that never meets
  the triangle) ends flat at the site with a step beside the triangle.
- **Tokens, beyond D1** (§7): the `differing` of a conflict caused by an
  import is `null` (the base lives inside a `reference.imported`
  entry); presence and "moved by X at T" (D11). The new editor's client rules landed in D4
  (`course-editor.md` §3).
- **Dangerous areas at import**: D1's importers write 709 polygons as
  `oob_area {}`; an OCAD / Purple Pen cross-hatched 710 area is not read
  as `hatch: "710"` (D5a added the prop only).
- **Course objects, beyond D2** (§8): a toner saver on screen (the
  editor outlines it, `course-editor.md` §7), holes in a stored
  filter region, `inset_frame` (micro insets, slice F).
- **Fidelity of the F12 move** (§3.6): a purple line's stored width and a
  template object's per-sheet text size (each sheet had its own
  enlargement; the moved text takes the template's print scale) are not
  kept; a sheet's object now draws on every sheet of its course (a map
  exchange's other parts included) and a template's on every sheet of the
  event; a moved `image` prints but is not previewed on the canvas (no
  mode draws image course objects yet, `course-layout.md` Pending
  "GL-drawn images"; Layout mode showed a map-anchored image). A
  per-sheet scope is not planned.
- **Upper white at import**: insert the row in stage-7 alignment
  (`colour-align.ts`) at the next importer bump, so `courseColourStack`
  never has to remap.
- **Custom purple**: a template's `appearance.purple` other than the IOF
  purple is not applied on the vector path (the purple is the stack's
  CMYK); appearance work in slice D decides whether it stays.
- **Checks, beyond D6** (§9): exact Bézier and hole
  geometry for obstacles; the
  server's `CONTROL_OUTSIDE_SHEET` / `NUMBER_*` / `VARIATION_*`; a re-describing move
  still keys on "equals autodetect at the old position", not on
  `description_source`.
- **Number boxes from font metrics**: the placer estimates boxes as
  0.65 em per character (shared with the legacy overlay); measuring the
  shaped text would change placements and is left for when the legacy
  overlay is retired (slice E).
