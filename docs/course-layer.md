# Course layer

Status: **draft** — chapter of the vector map pipeline specification,
started by sub-slice C0. The research record is
`docs/research/vector-map-pipeline/08-course-editor.md` §4.1, §4.5 and
`04-render-core.md` §7; when the two disagree, this document wins.

This chapter is normative for `packages/shared/src/course/`
(`import { course } from "@oxygen/shared"`). Its consumers are the
viewer's dynamic bucket (C4, §5), the page composer (C2,
`course-print.md`) and the `courses.geometry` compatibility artifact
(C5). The course *structure* beyond today's linear sequence, its storage
and editing concurrency are slice D's (decision G1, recorded before D);
this chapter covers what C needs: how the layer is derived (§1), its v1
input (§2), the geometry rules (§3), the GeoJSON projection (§4) and the
viewer (§5).

## Decisions taken before the code (user, 2026-10-24)

- **Sizes.** The 7xx symbols are drawn at the library's dimensions ×
  the document factor (03 §6.6): an ISOM map at 1:10 000 gets 7.5 mm
  circles, 0.525 mm lines and 6 mm digits; an ISSprOM map 6 mm circles.
  A stored template appearance becomes a multiplier of the library
  dimension (stored ÷ legacy default, `appearanceFromTemplate`), so
  default templates print spec sizes. Legacy's 5 mm / 0.35 mm / 4 mm on
  every map is the third sanctioned difference for `course-print.md`.
- **Control numbers.** Default `numberStyle: "spec"` — the library entry
  as it is (ISOM 704 lower purple without a halo, ISSprOM 704 upper
  purple without an outline). `"knockout"` is the opt-in legacy look:
  upper purple with a 0.15 mm upper-white outline (ISSprOM 704.b) on both
  libraries.

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
705, 706, 708; ISOM 704) sorts under black 100 % and the ISOM brown and
blue line/point rows; white-outs sit at upper white, above all map ink
and lower purple, below upper purple (707, 709, 711; ISSprOM 704) —
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
`CourseStackError` for an unaligned stack; call sites (C4, C5) catch it
and fall back (legacy overlay, legacy GeoJSON) rather than fail the
view or the write.

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
| `structure` | `CourseStructure` (one course), an array (several highlighted courses: legs of each, codes as numbers) or `null` (no course) | `{ version: 1, id, orderMode, items, labelOffsets?, extras? }`: `items` start … finish — the start by `startName` unless `firstAsStart`, `course_controls` in order, the finish by `finishControlId` unless `lastAsFinish` (`rebuildCourseGeometry` / `course-export.ts`); `labelOffsets` from `course_controls`; `extras` from imported geometry |
| `CourseItem` | `{ siteId, role?, leg?, circleGaps? }` — 08 §4.3's item, the leg being the leg *into* the item | `role` defaults to the site's kind (set it for `firstAsStart` / `lastAsFinish`) |
| `leg` | `{ path?, pieces?, gaps? }` | imported `ocd` courses only (decision of the slice-C split): `path` the authored polyline with bends, `pieces` the file's preclipped 705 pieces, `gaps` authored fractions. Retired by D's `LegProps.path` |
| `circleGaps` | `{ start, end }[]` | imported `ocd` `cuts` |
| `extras` | `{ kind: "marked_route" \| "restricted_line" \| "forbidden_route" \| "oob_area", points }[]` | imported geometry's course-level 707 / 708 / 711 lines and 709 polygons |
| `sites` | `{ id, code, kind: "control" \| "start" \| "finish", x, y }[]` | `controls` rows; `code` the display code (first punch code, else name / seq) |
| `objects` | `CourseMapObject[]`; only `anchor: "map"` ones are drawn | the sheet's layout objects (`course-maps` schema) |
| `appearance` | `{ circle?, line?, number?, numberStyle? }`, multipliers (1 = the spec) | `appearanceFromTemplate(template.appearance)`; the template's `purple` is not read (the purple is the stack's row) |
| `viewOptions` | `{ allControls?, labelMode?, overprintScale?, window?, textValues? }` | the view: all-controls, label mode, print enlargement, the frame polygon for white-out-outside, `{course}` placeholder values |
| `cutFeatures` | `{ x, y }[]` | `cutFeaturesOfDocument(doc)` (vector events), the legacy OCAD parse (C5) |

Free order is the structure's `orderMode` (a property of the course, not
of the view). A site at the origin (0, 0) is unpositioned and skipped,
legs connecting the remaining items (`buildEditorGeometry`'s rule).
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

`circleCuts` / `legGaps` in `cuts.ts` are `overprint-cuts.ts`'s rule
(`docs/course-editor.md` "Automatic overprint cuts") over a feature list:
a compact point feature within 0.45 mm of the rim or the leg centreline
gets a cut 0.4 mm either side; slits under 4° dropped, a circle that
would lose more than 300° kept whole; legs keep 1.2 R at each end, gaps
under 0.6 mm dropped, never more than 70 % of a leg (smallest dropped
first). With radius R and scale s = document factor, the reach, cut
half-width and minimum gap are × s and the circle is the drawn one — at
ISOM 1:15 000 with the default appearance the numbers are exactly the
legacy ones.

**Features** (`cutFeaturesOfDocument(doc)`): point objects of visible
symbols whose **applied** match (`isAppliedMatch`) is, or — unmatched or
only suggested — whose source code is, in `CUT_CODES` = 109, 110, 203,
204, 205, 207 (knoll, elongated knoll, rocky pit, boulder, large
boulder, boulder cluster; 206 gigantic boulder is an area and excluded,
as today). The caller chooses the source: the pinned document for
`vector` events, the legacy OCAD parse otherwise (C5, decision of the
slice-C split).

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

Points first, then legs, then extras — `buildEditorGeometry` +
`decorateOverprintCuts`'s shape and order, so an editor course's stored
GeoJSON keeps its consumers (legacy viewer, kiosk, lengths, exports).
Clipped leg pieces and numbers are not projected: consumers clip and
place themselves today.

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

## Tests

| Layer | Where | What |
|---|---|---|
| unit | `packages/shared/src/course/__tests__/colour-stack.test.ts` | upper white inserted below upper purple with the remap; ISSprOM unchanged; source colours above upper purple; refusal without purples; `hexToCmyk` ↔ `cmykToHex`; object rows on top |
| unit | `symbols.test.ts` | ISOM / ISSprOM dimensions, document factor, appearance multipliers, knockout, roles, 711 borrowed; arcs within 1 µm of the circle, gaps as open arcs, an arc through north one path |
| unit | `cuts.test.ts` | the `overprint-cuts.test.ts` cases on feature lists, radius and factor scaling, `cutFeaturesOfDocument` (applied match, source code, suggested match, hidden symbol, line object) |
| unit | `derive.test.ts` | legs and clearances, circles in the way, unpositioned sites, automatic vs authored gaps, authored pieces and bends, free order, all-controls, start rotation, sequence / repeated / code numbers, y-down placement, manual offsets, multi-course |
| unit | `layer.test.ts` | one `symbolise` call with a document: warning-free, lower purple under black, re-indexed document colours, object offsets; turned start, arcs, legs; knockout halo order; sprint sizes; layout objects (white-out, 709.b, rows on top, text values, page-mm sizes); toner-saver ring and its warning; images; `courseDocumentContext` |
| unit | `geojson.test.ts` | editor course in `buildEditorGeometry` + cuts shape, free order, preclipped pieces and extras, course by id |
| pass-stream | `scenes.test.ts`, snapshots in `render/__fixtures__/streams/course/` | the five course scenes (`map-rendering.md` §6.3) warning-free and equal to their snapshots at 1 µm, plus each scene's rule |
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
| `packages/shared/src/course/cuts.ts` | `CUT_CODES`, `circleCuts`, `legGaps`, `cutFeaturesOfDocument` |
| `packages/shared/src/course/derive.ts` | the geometry rules (§3.2–3.5) |
| `packages/shared/src/course/objects.ts` | layout objects (§3.6) |
| `packages/shared/src/course/layer.ts` | `courseLayer`, `courseRenderInput` |
| `packages/shared/src/course/geojson.ts` | `courseLayerGeoJson` |
| `packages/shared/src/course-maps/{overlay-geometry,control-label-placement}.ts` | `clipLine` (per-obstacle clearance), `subtractLegGaps`, `circleArcs`, `placeControlLabels` — shared with the legacy overlay |
| `packages/shared/src/render/__fixtures__/course/` | the course scenes |
| `packages/web/src/lib/course-layer-request.ts` | the viewer's request (§5) |
| `packages/web/src/map-gl/worker.ts` (`courseReply`), `engine.ts` (`setCourse`) | the dynamic bucket that draws it |

## Pending in this chapter

- **Viewer layout objects and appearance**: the viewer passes no layout
  objects and the spec appearance; a sheet's objects and template
  appearance on the map are slice D's.
- **Structure and concurrency** (G1, before slice D): `courses.structure`,
  variations, map exchanges, crossing and map-issue points, per-course
  hidden numbers, site-level manual `circle_gaps` (08 §4.2), corridors,
  `LegProps.path` replacing the v1 leg input, the 08 §4.5
  `course_objects` table with scopes and filter regions.
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
