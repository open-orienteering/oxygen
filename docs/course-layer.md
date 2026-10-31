# Course layer

Status: **draft** — chapter of the vector map pipeline specification,
started by sub-slice C0. The research record is
`docs/research/vector-map-pipeline/08-course-editor.md` §4.1, §4.5 and
`04-render-core.md` §7; when the two disagree, this document wins.

This chapter is normative for `packages/shared/src/course/`
(`import { course } from "@oxygen/shared"`). Its consumers are the
viewer's dynamic bucket (C4, §5), the page composer (C2,
`course-print.md`) and the `courses.geometry` compatibility artifact
(C5). This chapter covers how the layer is derived (§1), its v1 input
(§2), the geometry rules (§3), the GeoJSON projection (§4), the viewer
(§5), the stored course structure (§6, slice D row D0) and the
concurrency rules for editing it (§7, gate G1). Editing the structure on
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

- **Stored GeoJSON at legacy sizes.** The `courses.geometry` artifact
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

## 1. Derivation

The course layer is **derived, never stored** (08 §4.1): a pure function
of the course structure, the event's control sites, the map-anchored
layout objects, an appearance and view options, run by every consumer:

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
- Layout objects in their own hex colours (§3.6) get one row each, in
  first-use order, **on top of the stack** (`course-object:#rrggbb`,
  CMYK by the naive inverse of `cmykToHex`): legacy print draws them
  after everything else.

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
under it, as legacy print does.

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
and falls back to the legacy overlay rather than fail the view. The
stored GeoJSON (C5) is computed on a fixed ISOM stack (§4.1), which never
throws.

**Scale.** The layer is in paper µm at the document's scale (map frame,
y-up), like the map. Printing at another scale is the page transform's
job (`T_map`, 05 §5.1), which enlarges map and course together — so an
ISOM course printed at 1:10 000 from a 1:15 000 map gets 7.5 mm circles
as the spec requires. There is no overprint factor for the 7xx symbols;
`viewOptions.overprintScale` (= mapScale / printScale) only divides the
page-mm sizes of layout objects (§3.6).

## 2. Input, version 1

Paper mm at the base map's scale, y-up (the frame of `controls.xpos/ypos`
and of course GeoJSON). Gaps: compass degrees for circles (0° = +y,
clockwise, the gap sweeping clockwise from `start` to `end`), fractions
0..1 for legs — the OCD importer's and `overprint-cuts.ts`'s conventions.

| Input | v1 shape | Built today from |
|---|---|---|
| `structure` | `CourseStructure` (one course), an array (several highlighted courses: legs of each, codes as numbers) or `null` (no course) — the stored form is §6 | `{ version: 1, id, orderMode, items, labelOffsets?, extras? }`: `items` start … finish — the start by `startName` unless `firstAsStart`, `course_controls` in order, the finish by `finishControlId` unless `lastAsFinish` (`rebuildCourseGeometry` / `course-export.ts`); `labelOffsets` from `course_controls`; `extras` from imported geometry |
| `CourseItem` | `{ siteId, role?, leg?, circleGaps? }` — 08 §4.3's item, the leg being the leg *into* the item | `role` defaults to the site's kind (set it for `firstAsStart` / `lastAsFinish`) |
| `leg` | `{ path?, pieces?, gaps? }` | imported `ocd` courses only (decision of the slice-C split): `path` the authored polyline with bends, `pieces` the file's preclipped 705 pieces, `gaps` authored fractions. Retired by D's `LegProps.path` |
| `circleGaps` | `{ start, end }[]` | imported `ocd` `cuts` |
| `extras` | `{ kind: "marked_route" \| "restricted_line" \| "forbidden_route" \| "oob_area", points }[]` | imported geometry's course-level 707 / 708 / 711 lines and 709 polygons |
| `sites` | `{ id, code, kind: "control" \| "start" \| "finish", x, y }[]` | `controls` rows; `code` the display code (first punch code, else name / seq) |
| `objects` | `CourseMapObject[]`; only `anchor: "map"` ones are drawn | the sheet's layout objects (`course-maps` schema) |
| `appearance` | `{ circle?, line?, number?, numberStyle? }`, multipliers (1 = the spec) | `appearanceFromTemplate(template.appearance)`; the template's `purple` is not read (the purple is the stack's row) |
| `viewOptions` | `{ allControls?, labelMode?, overprintScale?, window?, textValues? }` | the view: all-controls, label mode, print enlargement, the frame polygon for white-out-outside, `{course}` placeholder values |
| `cutFeatures` | `{ x, y, r? }[]` (`r` the drawn symbol's radius) | `cutFeaturesOfDocument(doc)` (vector events), the legacy OCAD parse (C5, §4.2) |

Free order is the structure's `orderMode` (a property of the course, not
of the view). A site at the origin (0, 0) is unpositioned and skipped,
legs connecting the remaining items (the editor's rule, `editorCourseGeometry`).
Variations, map exchanges, crossing points, map-issue points, per-course
hidden numbers and the site-level manual `circle_gaps` of 08 §4.2 are not
in v1 (Pending).

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
| leg | 705 | line |
| marked route / restricted line / forbidden route | 707 / 708 / 711 (ISSprOM has no 711: ISOM's, same factor) | line |
| out-of-bounds area | 709; with a stroke 709.b (solid boundary), or 709.c (dashed) when the stroke is dashed | — |
| white-out | area symbol `course:whiteout`, fill = upper white | — |

A ring's multiplier scales its centre-line diameter, the width scaling
separately (`ringCC` geometry). Dimensions at ISOM 1:15 000, defaults:
circle radius 2.5 mm, finish 2.0 / 3.0 mm, start side 6 mm, lines
0.35 mm, digits 4.0 mm; ISSprOM 1:4 000: 3.0 mm, 2.5 / 3.5 mm, 7 mm,
0.35 mm, 4.0 mm.

### 3.2 Legs

For an `ordered` course, one leg per consecutive pair of positioned
items, centre to centre (or the authored `path`):

1. Authored `pieces` → drawn as given: no clipping, no gaps.
2. Gaps: authored `gaps`, else the automatic ones (§3.4) for a straight
   leg when `cutFeatures` are given. `subtractLegGaps` removes them,
   keeping bends.
3. Each remaining segment is clipped (`clipLine`) at every **drawn**
   site with clearance = the site's extent + 0.2 × R (R = control circle
   radius): 1.2 R at a control (legacy), outer ring + 0.2 R at a finish,
   start circumradius + 0.2 R at a start (legacy used 1.2 R everywhere and
   overlapped the start triangle). Segments sharing an end point are
   joined back into polylines, so a bend keeps its join. Pieces of 1 mm
   or less are dropped (`clipLine`'s rule).

`free_order` courses and the all-controls view draw no legs.

### 3.3 Sites

Drawn sites: the courses' sites in first-visit order, plus (with
`allControls`) every other positioned site in input order. A site
appearing in several roles takes its first.

- **Start (701)** turned so its apex points at the next site of the
  first ordered course that starts there: `angleDeg = atan2(dy, dx) − 90`
  (the glyph's apex is +y). North when there is none (free order,
  all-controls). Legacy drew the apex north always; the turned start is
  a sanctioned difference for C3's list.
- **Control (703)**: a closed circle, or the arcs left by its gaps
  (`circleArcs`; an arc running through north is one path). Gaps: the
  item's authored `circleGaps` (first occurrence), else the automatic
  cuts (§3.4). Start and finish are never cut.
- **Finish (706)**: the entry's two rings.

### 3.4 Automatic cuts

`circleCuts` / `legGaps` in `cuts.ts` (`docs/course-editor.md`
"Automatic overprint cuts"; size-aware since C5, user decision
2026-10-24). Each feature carries the radius `r` of its drawn symbol; the
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
entry × document factor only when there is neither. The caller chooses
the source: the pinned document for `vector` events, the legacy OCAD
parse otherwise (§4, decision of the slice-C split).

### 3.5 Numbers

- **Text**: `sequence` (1, 2, … over the first course's control items; a
  site visited twice gets `3/7`) by default for one ordered course
  outside the all-controls view; `code` otherwise, or by `labelMode`.
  Start and finish carry no number.
- **Placement**: `placeControlLabels` over every drawn site (start and
  finish as obstacles with their extents), the drawn leg pieces and the
  extras' lines, with `radius` R and `labelSize` the 704 em. The placer's
  direction preferences are screen conventions, so it runs in the map
  frame flipped to y-down and its centres are flipped back — the legacy
  print's "map frame" placement, rotation-invariant.
- **Manual positions**: `labelOffsets[siteId]` (one course only) is the
  number's centre relative to the site; emitted as is, no leader.
- **Leaders** where the placer reports a contested slot (705-derived
  line, §3.1).
- **Anchor**: the text object's point is the baseline, half a digit
  below the placed centre, `align: "centre"` (legacy
  `controlNumberBaselineY`).

### 3.6 Layout objects

Map-anchored `CourseMapObject`s are the 08 §4.5 kinds they already are:

| Object | Drawn as |
|---|---|
| rectangle / path, `fillMode: "whiteout"` | `course:whiteout` area at upper white |
| `"whiteoutInverted"` (toner saver) | the same area: `viewOptions.window` ring with the shape as an even-odd hole; without a window, not drawn and warned (`WINDOW_MISSING`) |
| `"outOfBounds"` | 709; with a stroke 709.b, or 709.c for `dash: "dashed"`. The boundary is the library's (0.2 mm × factor, upper purple): the stored stroke colour *and width* are not read — legacy print kept the stored width in purple, a difference for C3's list |
| `"solid"` | an area in the fill's own colour row |
| any stroke (except out-of-bounds) | a line in the stroke's colour row, page-mm width ÷ `overprintScale`; `dash: "dashed"` → OCAD dashes max(2, 5 w) / max(1, 2.5 w) mm ÷ `overprintScale` |
| line | as a stroke |
| text | a text symbol in the colour's row: `sans` → Liberation Sans, `condensed` → Liberation Sans Narrow, `serif` / `mono` → their families (no file ships: `symbolise` warns `NO_FONT`, `map-rendering.md` §4.10); size ÷ `overprintScale`; `{placeholders}` expanded with `viewOptions.textValues`; empty text skipped |
| image | `layer.images` (paper µm rectangle), not in the stream |

Path vertices keep their Bézier handles (`pathData`'s construction);
closed shapes close implicitly. Layout-object symbols are deduplicated by
content.

## 4. GeoJSON projection

`courseLayerGeoJson(layer, courseId?)` projects one course of the layer
(default the first) onto today's `courses.geometry` FeatureCollection, the
compatibility artifact C5 writes for consumers not yet ported (09 §4 C):

| Feature | Geometry | Properties |
|---|---|---|
| one per positioned item, in order | `Point` | `{ symbolType: "start" \| "control" \| "finish", code, id: code }`, + `cuts` (effective gaps) on a cut control |
| one per leg (ordered courses) | `LineString` centre to centre (or the authored path) | `{ symbolType: "leg", from, to }` (codes), + `gaps` when the leg has any |
| authored pieces | one `LineString` per piece | `{ symbolType: "leg", from, to, preclipped: true }` |
| extras | `LineString` / closed `Polygon` | `{ symbolType: "marked_route" \| "restricted_line" \| "forbidden_route" \| "restricted_area" }` |

Points first, then legs, then extras — the shape and order the editor
wrote before C5, so an editor course's stored GeoJSON keeps its consumers
(legacy viewer, kiosk, lengths, exports). Clipped leg pieces and numbers
are not projected: consumers clip and place themselves today.

### 4.1 Writer (C5)

`rebuildCourseGeometry` (`packages/api/src/course-geometry.ts`) writes
`editorCourseGeometry(courseId, seq, orderMode, cutFeatures)` =
`courseLayerGeoJson(courseLayer(…), courseId)` on every write of an
editor course, for as long as the artifact has consumers (09 §4 C; 08
§4.1):

- **Input**: the sequence `loadCourseSequences` builds (start by
  `startName` unless `firstAsStart`, `course_controls` in order, finish
  by `finishControlId` unless `lastAsFinish`) as a v1 `structure` with
  one item per entry (`role` = the entry's type) over `controls` rows as
  sites; no layout objects, appearance or view options.
- **Sizes**: the document context is the ISOM stack at factor 1 — the
  legacy 2.5 mm circle and 0.35 mm line every consumer of the artifact
  draws (user decision 2026-10-24). The map enters only through the
  features' radii (§3.4). `courseLayer` cannot throw `CourseStackError`
  on that fixed stack.
- **`legs` / `lengthM`**: unchanged — `legDistancesMm` over the
  positioned sequence, `Math.round(d × scale / 1000)` per leg joined with
  `;` and a trailing `;`; free-order courses leave both alone;
  `updateLength: false` (map upload, migration) keeps `lengthM`.
- **Imported geometry** (`ocd` / `xml`) is never rewritten until the
  course is edited, which turns it into `editor` geometry (today's rule).
- Call sites and signatures are unchanged: course create / update /
  sequence edits, control create / move / delete, copy, toggle, map
  upload and rotation correction; each emits `course.upserted` after the
  rebuild, so the journal and the venue closure (08 §4.8) carry the new
  geometry as before.

### 4.2 Cut features

`loadEventCutFeatures(db, eventId, mapScale)`
(`packages/api/src/event-map-objects.ts`), skipped when the event's
**Auto cuts** toggle is off:

| Event | Source | Radii |
|---|---|---|
| `vector` with a pinned document (`pinnedDocumentHash`, the reads-only gate of `map-pipeline-switch.md` §3) | `cutFeaturesOfDocument` of the pinned document, memoised per hash | what the document draws (§3.4) |
| otherwise (`legacy`, or no pin yet) | the OCAD parse of the latest upload (`loadEventMapObjects`' cache), point objects with `⌊sym / 1000⌋ ∈ CUT_CODES` (`cutFeaturesOfSlimObjects`) | the file's own symbol definition (`ocadCutSymbolRadiiMm`, the importer's `ocadSymbolToRender`); a symbol without one: the library entry of its code in the library its scale picks × reference scale / map scale (no scale: ISOM at factor 1) |
| no map | — | no cuts |

On the fixture both sources give the same features and radii, and the
written cuts agree within 1e-6 (integration `overprint-cuts`). A
document whose blob is missing or unreadable falls back to the OCAD
parse. The map **upload** rebuilds editor courses after the import hold
(`applyEventMap`), so a `vector` event cuts against its new pin when the
import finished within it; otherwise against the OCAD parse until the
next write. A later re-match of the pin does not rebuild stored cuts.

### 4.3 Migration

`OVERPRINT_CUTS_VERSION` = 3 (1 OCAD-parse cuts, 2 knolls and rocks
only, 3 written by the course layer with size-aware cuts). An event
below it has its editor courses rebuilt on the next `course.geometry` /
`courseGeometries` read (`ensureOverprintCutsCurrent`,
`updateLength: false`) and is advanced; imported geometry untouched.

### 4.4 Comparison

`pnpm --filter @oxygen/api geometry:compare [--event <nameId>]… [--out <dir>]`
(`scripts/compare-course-geometry.ts` over `course-geometry-report.ts`
and the pure `course-geometry-compare.ts`) reads every event of the
database and writes `report.md` + `courses.json` to
`.local/course-geometry/<date>/` (never committed). Read-only: it builds
what the writer would store now and compares.

- **Editor courses** — stored vs written now, per control circle and per
  leg: same / changed / added / removed, with the opened width before and
  after (degrees, mm); rows whose points moved since they were stored
  are reported as stale — their moved controls and legs are not
  compared and the row is left out of the cut totals. On a map with a document,
  also the OCAD-parse vs document feature source (the "could differ by a
  rounding" check of the slice-C split).
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
"Overlay"); under `legacy` nothing changes.

**Request** (`packages/web/src/lib/course-layer-request.ts`, pure):

| Input | From the viewer |
|---|---|
| `sites` | every visible control (`visible !== false`) with a position — its own paper mm, the editor's dragged position or a move still round-tripping — `code` its display code, `kind` from its type; the editor's faded off-course controls are left out (the UI layer draws them faded) |
| `structure` | the highlighted courses (`highlight` or `highlightCourseName`) in order, one `CourseStructure` each, `id` = the course name, `items` = its control ids (start and finish as `MapPanel` completes them), `orderMode` the course's; `null` when none is highlighted |
| `labelOffsets` | the single highlighted course's, with a drag or a pending label move winning — only with the description sheet or the editor (the SVG overlay's rule) |
| `leg`, `circleGaps`, `extras` | for a course whose stored GeoJSON has `preclipped` legs (an imported `ocd` course, §2): each leg feature becomes the next item's `leg.pieces` when the counts match, the course's control `cuts` become `circleGaps`; a bent generated leg keeps its `path`; 707 / 708 / 711 lines and `restricted_area` polygons become `extras`. Automatic `gaps` / `cuts` in the GeoJSON are not read |
| `viewOptions` | `labelMode: "sequence"` for one ordered course with the sheet or the editor, else `"code"`; `allControls` when a drawn site is on no highlighted course |
| `objects`, `appearance` | `[]` (no sheet reaches the viewer) and `{}` — the spec sizes × the document factor (decision "Sizes") |
| `cutFeatures` | added by the worker: `cutFeaturesOfDocument(doc)` once per document load |

**Reply.** The derivation (sites with number positions and leaders, legs
with their drawn pieces) and the symbol sizes come back with the part; the
UI layer draws its hit targets, status rings and leg pills from them and
the viewer mirrors the drawn numbers and legs as a hidden DOM list
(`map-rendering.md` §5.4 "Attributes").

**Unaligned stack.** A document whose stack throws `CourseStackError`
draws the SVG course overlay over the GL map instead (§1).

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
             crossing?: { controlId, section? }, bends?: { x, y }[] }
```

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
  non-empty alternatives. Rules that need the sites
  (`structureSiteIssues`): unknown site (`SITE_UNKNOWN`), a group holding
  a map exchange (`VARIATION_CROSSES_EXCHANGE`). Items and legs are
  strict objects: unknown keys are refused, not dropped.
- **Not stored**: `labelOffsets` (one source, `course_controls`; readers
  fill them in, the wire form carries them), `extras`, and C0's interim
  file-authored `leg.path` / `pieces` / item `circleGaps` — the slice D
  split decided "no `LegProps.path`"; authored circle cuts become
  `controls.circle_gaps` and authored leg gaps `LegProps.gaps` (D1).
- **Phase 1 writes control items only.** `course.setStructure` refuses a
  structure with a variation group, and any site whose kind is a slice-F
  kind, with `PRECONDITION_FAILED`.
- Helpers: `linearStructure(id, items, { orderMode, labelOffsets })`,
  `structureControlItems` / `structureControlIds` (a group by its first
  alternative — 08 §4.3's root path), `structureDiff` (§7),
  `hasVariations`.

### 6.2 The column mirror

What timing, export, the kiosk and the legacy editor read stays in the
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
`structureStored: false` for those).

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
`course.upserted` payload like any column.

**Readers.** `loadCourseSequences` (`course-geometry.ts`, hence
`courses.geometry`, `legs`, lengths) and the IOF / PPen export
(`course-export.ts`) take the explicit start, the sequence and the
explicit finish from the structure when one is stored, from the columns
otherwise, and complete an absent start / finish from the event default
as before. Sites are drawn by their kind (`role` matters to the mirror
and to IOF's `@type`, not to the stored GeoJSON, which keeps drawing a
`first_as_start` control as a circle), and a soft-deleted site drops out
as `start_name` does. The geometry of a course written through
`setStructure` is byte-identical to the one `course.update` writes for
the same sequence (integration test).

### 6.3 Sites' new fields

| Column | Type | Meaning |
|---|---|---|
| `controls.kind` | ENUM `control_kind`: `control`, `start`, `finish`, `map_exchange`, `crossing_point`, `map_issue` | what the site is (08 §4.2); the last three are typed now and refused until slice F |
| `controls.circle_gaps` | JSONB `[{ start, end }]`, compass degrees | manual circle gaps on the site (same in every course) |
| `controls.notes` | TEXT, default `""` | setter / controller notes; writing them needs `courses.review` |
| `controls.checked_at`, `checked_by` | TIMESTAMPTZ, UUID (no FK — journaled to nodes without the users) | field check-off (`control.check`) |
| `controls.version`, `courses.version` | BIGINT, default 0 | the §7 token |
| `course_controls.number_hidden` | BOOLEAN, default false | hide this visit's number (08 §4.2) |

`kind` and `status` 4 / 5 are **kept in sync for one release** (08 §4.8):
`control.create` derives `kind` from `status`; `control.update` writing
`kind` sets `status` (start / finish, else back to `ok` from start /
finish) and writing `status` sets `kind`. The migration backfilled
`kind` from `status`. Readers in the API use `kind`, falling back to
`status` for rows not rewritten yet.

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
by design). Course objects (D2) will carry the same token per object.

**Client rules** (the new editor, D4 / D11). A **field move** on a stale
control is re-sent with the fresh token automatically when the other
side changed only fields the move does not touch (description, code,
notes, kind, circle gaps, checked); when the other side also moved it,
the editor shows "moved by X at T" with both positions and the user
keeps one. A **structure edit** on a stale structure is never merged: the
editor refreshes, re-renders the sequence with a one-line notice naming
the differing items, and the user redoes the edit — concurrent
reordering is always a conflict, by design.

**Legacy editor.** `CourseEditorPage` and the Courses page send the
token too, through the same mutations: a `VersionBook`
(`packages/web/src/lib/version-book.ts`) keeps the newest token per row
from the list refetches and each mutation's result — `course.update`,
`control.update`, `course.setControlLabelOffset`, `course.create` /
`clone` return the row's token, `control.delete` the tokens of the
courses it advanced — so undo / redo and back-to-back writes send their
predecessor's token; on a version
`CONFLICT` they invalidate and show "Changed elsewhere — reloaded"
(`courses:changedElsewhere`). One rule for both editors on the same rows.

**Presence and live refresh** (D11). No new push channel: a heartbeat
`course.presence { courseId, mode }` (TTL 30 s) in a small table (up to
two Cloud Run instances, so not in process memory), read by the existing
5 s `useExternalChanges` poll and shown in the editor's top bar. Live
refresh is cache invalidation, not journal replay: the `oCourse` /
`oControl` watermarks already invalidate the `course` / `control`
queries. "Moved by X at T" reads `actorId` and `hlc` of the control's
last `control.upserted`.

**`map_patches` (slice G, no code).** Patch operations are idempotent and
commutative: each op is keyed by `(object id, op id)` and sets a state
(hidden, colour override, …) rather than applying a relative change, so
applying twice equals once and two devices' patches merge through the
journal in any order.

## Tests

| Layer | Where | What |
|---|---|---|
| unit | `packages/shared/src/course/__tests__/colour-stack.test.ts` | upper white inserted below upper purple with the remap; ISSprOM unchanged; source colours above upper purple; refusal without purples; `hexToCmyk` ↔ `cmykToHex`; object rows on top |
| unit | `symbols.test.ts` | ISOM / ISSprOM dimensions, document factor, appearance multipliers, knockout, roles, 711 borrowed; arcs within 1 µm of the circle, gaps as open arcs, an arc through north one path |
| unit | `cuts.test.ts` | clearance = symbol + half line + air at both arc ends and both gap ends, on / off the rim and the line by the same sum, wider for bigger symbols and lines, default radius, north wrap, whole circle; library radii (`cutSymbolRadiusMm`), OCAD symbol radii (`ocadCutSymbolRadiiMm`), `cutContextForScale`; `cutFeaturesOfDocument` (applied match, source code, suggested match, hidden symbol, line object, own render, factor fallback) |
| unit | `derive.test.ts` | legs and clearances, circles in the way, unpositioned sites, automatic vs authored gaps, authored pieces and bends, free order, all-controls, start rotation, sequence / repeated / code numbers, y-down placement, manual offsets, multi-course |
| unit | `layer.test.ts` | one `symbolise` call with a document: warning-free, lower purple under black, re-indexed document colours, object offsets; turned start, arcs, legs; knockout halo order; sprint sizes; layout objects (white-out, 709.b, rows on top, text values, page-mm sizes); toner-saver ring and its warning; images; `courseDocumentContext` |
| unit | `geojson.test.ts` | editor course in the pre-C5 editor shape with cuts, free order, preclipped pieces and extras, course by id |
| pass-stream | `scenes.test.ts`, snapshots in `render/__fixtures__/streams/course/` | the five course scenes (`map-rendering.md` §6.3) warning-free and equal to their snapshots at 1 µm, plus each scene's rule |
| unit | `packages/api/src/__tests__/course-geometry.test.ts` | `editorCourseGeometry` writes the exact FeatureCollection, repeated controls, cuts at the legacy sizes on controls only and gaps on legs, no keys without features, unpositioned controls, free order; `legDistancesMm`, `courseLengthM` |
| unit | `packages/api/src/__tests__/overprint-cuts.test.ts` | the legacy adapter: which OCAD objects cut (knolls and rocks, not water / vegetation / lines / areas / 206), file radii first, sub-codes, scale fallback; the rule over them |
| unit | `packages/api/src/__tests__/course-geometry-compare.test.ts` | identical → no diffs; changed / added / removed with widths; stale row; imported fidelity (pieces, bends, authored vs automatic cuts, extras) |
| integration | `packages/api/src/__tests__/integration/overprint-cuts.test.ts` | legacy event: rim slit over the boulder across north, no gap through the building, leg gap over the boulder, cuts follow a move, upload rebuilds, lazy migration to v3, toggle; `vector` event: document features = OCAD features, the upload rebuild cuts the course created before the map, circle and leg cuts equal to the legacy event's within 1e-6, OCAD fallback without a pin, migration from the document; the comparison report over both events (all same, document vs OCAD 0, imported fidelity) |
| integration | `control-editor.test.ts`, `journal-completeness.test.ts` | unchanged and green: editor geometry and lengths on create / move / delete / copy; `course.upserted` payloads |
| unit | `packages/shared/src/course/__tests__/structure.test.ts` | §6.1: C0's linear shape accepted, the 08 leg props, groups and loops; nesting, overlap, unanchored, duplicate ids / labels, < 2 or empty alternatives, out-of-range gaps refused; interim `path` / `pieces` / `circleGaps` and `extras` refused; the wire form; site rules; `linearStructure`, `structureControlIds`; `structureDiff` (equal, moved, added, removed, leg / offset changes) |
| unit | `packages/api/src/__tests__/course-structure.test.ts` | §6.2: `splitStructure` (explicit start / finish, implicit default, role start / finish, a start mid-sequence), `structureFromColumns` and its round trip, wire ↔ stored mapping |
| unit | `packages/api/src/__tests__/version-conflict.test.ts` | §7: the `errorFormatter` lifts the payload beside tRPC's fields and leaves the duplicate-code `CONFLICT` alone; `controlFieldsDiff`; `baseVersionSchema` |
| integration | `packages/api/src/__tests__/integration/course-structure.test.ts` | kind ↔ status sync, slice-F kinds refused, circle gaps; `course.update` writes a structure, token = the entry's HLC, structure and token in the payload; a pre-D0 course reads from its columns; `setStructure` mirror (start / finish, sequence, hidden numbers, label offsets not in the column), geometry byte-identical to `update`'s, variations and unknown controls refused; stale course token → `CONFLICT` with current and differing, nothing written, no token = LWW; stale control token → differing fields; `differing: null` at token 0; separate tokens both ways; `control.delete` prunes and advances; seeded groups hold `courses.review`; a controller checks off and writes notes but cannot move |
| unit (web) | `packages/web/src/lib/__tests__/version-book.test.ts` | §7 legacy editor: newest token as an integer compare, list seeding, the conflict payload off a client error, public id after a code change |
| E2E | `e2e/courses.spec.ts` "an edit from a stale copy…" | §7 over HTTP: another client renames the course while this page's poll is held; this page's edit is refused, the notice shows, the page reloads the other write |
| unit | `packages/api/src/__tests__/courseGeometryStale.test.ts` | unchanged and green: OCD-vs-XML staleness of imported geometry |
| golden | `e2e/__golden__/map-gl/course-*.png`, `packages/api/src/render/__tests__/golden-files.test.ts`, `e2e/map-gl-golden.spec.ts` | reference raster = committed golden; WebGL2 ≤ 0.5 % (`map-rendering.md` §6.2). The PDF tier joins in C3 |
| unit (web) | `packages/web/src/lib/__tests__/course-layer-request.test.ts` | the §5 request rules (offsets only with the sheet or the editor) |
| unit (web) | `packages/web/src/map-gl/__tests__/worker-course.test.ts`, `engine.test.ts` | the dynamic bucket (`map-rendering.md` §5.2) |
| E2E | `e2e/map-vector-layer.spec.ts`, `map-control-circles.spec.ts`, `map-multicourse.spec.ts` | lower purple under black at a crossing; labels under both pipelines (`map-rendering.md` §5.4) |

## Where things live

| Path | Contents |
|---|---|
| `packages/shared/src/course/types.ts` | input / output types, `appearanceFromTemplate` |
| `packages/shared/src/course/context.ts` | `courseDocumentContext(header)` |
| `packages/shared/src/course/colour-stack.ts` | `courseColourStack`, object colour rows, `hexToCmyk` |
| `packages/shared/src/course/symbols.ts` | the 7xx set: resolution, appearance, derived 703 / leader / white-out (`courseSymbols`, exported for the viewer's sizes, C4) |
| `packages/shared/src/course/arcs.ts` | Bézier circles and arcs |
| `packages/shared/src/course/cuts.ts` | `CUT_CODES`, `CUT_AIR_MM`, `circleCuts`, `legGaps`, `cutFeaturesOfDocument`, `pointSymbolRadiusMm`, `cutSymbolRadiusMm`, `ocadCutSymbolRadiiMm`, `cutContextForScale` |
| `packages/shared/src/course/derive.ts` | the geometry rules (§3.2–3.5) |
| `packages/shared/src/course/objects.ts` | layout objects (§3.6) |
| `packages/shared/src/course/layer.ts` | `courseLayer`, `courseRenderInput` |
| `packages/shared/src/course/geojson.ts` | `courseLayerGeoJson` |
| `packages/shared/src/course-maps/{overlay-geometry,control-label-placement}.ts` | `clipLine` (per-obstacle clearance), `subtractLegGaps`, `circleArcs`, `placeControlLabels` — shared with the legacy overlay |
| `packages/shared/src/render/__fixtures__/course/` | the course scenes |
| `packages/api/src/course-geometry.ts` | the writer (§4.1): `editorCourseGeometry`, `loadCourseSequences`, `rebuildCourseGeometry`, `ensureOverprintCutsCurrent`, `OVERPRINT_CUTS_VERSION` |
| `packages/api/src/event-map-objects.ts`, `overprint-cuts.ts` | cut features (§4.2): `loadEventCutFeatures`, document / OCAD loaders, the OCAD adapter |
| `packages/api/src/course-geometry-{compare,report}.ts`, `scripts/compare-course-geometry.ts` | the comparison (§4.4) |

| `packages/shared/src/course/structure.ts` | §6.1: `courseStructureSchema`, `courseStructureWireSchema`, `structureSiteIssues`, `linearStructure`, `structureControlIds`, `structureDiff` |
| `packages/api/src/course-structure.ts` | §6.2: `splitStructure`, `structureFromColumns`, `persistStructure`, `rewriteStructureFromColumns`, wire mapping, `assertCourseVersion` |
| `packages/api/src/version-conflict.ts`, `referenceJournal.ts`, `trpc.ts` (`withVersionConflict`) | §7: lock and compare, the base from the journal, the emits that stamp the token, the error shape |
| `packages/web/src/lib/version-book.ts` | §7 legacy editor tokens |
| `packages/web/src/lib/course-layer-request.ts` | the viewer's request (§5) |
| `packages/web/src/map-gl/worker.ts` (`courseReply`), `engine.ts` (`setCourse`) | the dynamic bucket that draws it |

## Pending in this chapter

- **Retiring the artifact**: `courses.geometry` is written until its
  last consumer draws from the layer (C4 viewer, C2 / C3 print, then
  kiosk / exports in E / F); spec-size cuts reach the screen and the page
  through the layer, not through the artifact.
- **Viewer layout objects and appearance**: the viewer passes no layout
  objects and the spec appearance; a sheet's objects and template
  appearance on the map are slice D's.
- **Structure, beyond D0** (§6): the layer does not read
  `numberHidden`, the site's `circle_gaps` or `LegProps` beyond `gaps`
  yet (the editor, D4 / D5); importers write the structure and the
  backfill fills `NULL` rows, retiring C0's interim leg input (D1); the
  08 §4.5 `course_objects` table with scopes and filter regions (D2);
  variations and their materialisation, map exchanges, crossing and
  map-issue points, corridors (slice F).
- **Tokens, beyond D0** (§7): `course.importCourses` journals
  `reference.imported` and does not advance the tokens of the rows it
  rewrites, so an editor open during an import is not told (D1, with the
  importers writing the structure); presence and "moved by X at T"
  (D11); the new editor's client rules (D4).
- **Upper white at import**: insert the row in stage-7 alignment
  (`colour-align.ts`) at the next importer bump, so `courseColourStack`
  never has to remap.
- **Custom purple**: a template's `appearance.purple` other than the IOF
  purple is not applied on the vector path (the purple is the stack's
  CMYK); appearance work in slice D decides whether it stays.
- **Number boxes from font metrics**: the placer estimates boxes as
  0.65 em per character (shared with the legacy overlay); measuring the
  shaped text would change placements and is left for when the legacy
  overlay is retired (slice E).
