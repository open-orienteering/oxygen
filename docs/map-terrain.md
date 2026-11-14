# Map terrain

Normative specification of **terrain derived from a map document**: the
contour graph (§1–2), the solve that gives each contour its uphill side and
level (§3), the height field (§4–5), and the DEM anchor (§6–7). Research
record: `docs/research/vector-map-pipeline/10-terrain.md` (with spike T1,
§7) and the slice H split in `SLICES.md` ("Slice H"); decisions in
`decisions/slice-h.md`. Slice H.

Implementation: `packages/shared/src/terrain/` — pure TypeScript, no Node
APIs, no randomness. `terrain/graph/` is §1–2 (H1). Consumers import by
subpath, `@oxygen/shared/src/terrain/graph/index.js`; the package's root
`index.ts` does not re-export it.

Units throughout: **paper millimetres, x right, y up** (the document's
native units divided by `header.unitsPerMm`). Distances that describe the
ground (gap bridging) are given in ground metres and converted through
`header.mapScale` (`groundMPerMm = mapScale / 1000`).

## 1. Inputs

`contourInputs(doc: MapDocument): ContourInputs` reads every object of the
document once, classifies it by its symbol and flattens its geometry (§1.4).

### 1.1 Classification

A symbol is classified by its **canonical code**: the part of
`symbol.match.canonicalId` after the `:` (`ISOM2017-2:101.b` → `101.b`;
an id without `:` has no code),
**in any match state** — `auto`, `suggested` (reviewed or not) and
`unmatched` with a non-null id alike. Terrain is derived, not drawn; a
suggestion is the matcher's best reading, and T1's verdict was measured on
it (user, 2026-11-13). This differs on purpose from the course checks
(`course/checks.ts`), which use only applied matches. Hidden symbols
(`symbol.hidden`) are skipped. The symbol kind must agree with the class:

| Class | Canonical code | Symbol kind | Role |
|---|---|---|---|
| `contour` | `101` | line | chain, barrier |
| `index` | `102` | line | chain (index part), barrier |
| `form` | `103` | line | form-line chain (not a barrier) |
| `tick` | `101.b` | point | slope tick on a contour (evidence, §3) |
| `formTick` | `103.b` | point | slope tick on a form line (evidence, §3) |
| `cliff` | `201`, `201.*`, `202`, `202.*` | line | barrier; evidence when tagged (§3) |
| `water` | `301`, `301.*`, `302`, `302.*` | area | evidence (§3) |
| `other` | number in [101, 600) | any | mapped-area mask only (§2.3) |

`other` is the only class that falls back to the source code
(`parseFloat(symbol.code)`) when the symbol has no canonical id; the named
classes never fall back. Every object of every class contributes its parts
to the mapped-area mask. Slope ticks are ISOM `101.b` / `103.b`, not `104`
(the earth bank; `decisions/slice-h.md`, T1). `201.c` (a single cliff tag
drawn as its own line) is a cliff barrier like any other `201.*` and is
untagged.

### 1.2 Cliffs: tagged or not

A cliff is **tagged** when its definition (`symbol.render`, a line symbol)
carries a glyph with a stroke part whose end point lies more than 0.1 mm
off the line (`|geometry.coords[3]| > 100` µm). The tag side is the sign
of that coordinate in the line's local frame: `+1` the tags lie left of
the drawing direction, `−1` right (ISOM draws them right, downhill).
Untagged cliffs, and cliffs whose `render` is `null`, have tag side `0`.
The canonical id's variant is not used: sources map tagged cliffs to the
plain id often enough that the definition is the reliable reading.

### 1.3 Ticks and water

A tick is its object's first coordinate and its rotation
(`attrs.angle`, 0.1°, counter-clockwise) in radians. A water area keeps its
rings of three points or more (outer first, then holes). Both are carried for §3; H1 uses them
only for counts.

### 1.4 Flattening

`flattenObject(doc, i): Float64Array[]` returns the object's parts (an
area's rings, split at hole flags), each a flat `[x0, y0, x1, y1, …]` in
paper mm. Bézier runs are read by `pathRings` / `ringSegments`
(`render/path.ts`, `map-document-format.md` §4); a malformed control run
degrades to straight lines. A cubic becomes `clamp(⌈L / 0.25 mm⌉, 3, 24)`
chords, where `L` is the length of its control polygon. A contour or form
piece with fewer than two points or shorter than 0.02 mm is dropped; a
piece is **closed** when it has at least four points and its last point
equals its first.

```ts
interface ContourPiece { pts: Float64Array; closed: boolean; index: boolean; object: number }
interface SlopeTick { x: number; y: number; angleRad: number; object: number }
interface CliffLine { pts: Float64Array; tagSide: -1 | 0 | 1; object: number }
interface WaterArea { rings: Float64Array[]; object: number }
interface ContourInputs {
  groundMPerMm: number;
  contours: ContourPiece[];      // 101 and 102, `index` set for 102
  formLines: ContourPiece[];
  ticks: SlopeTick[]; formTicks: SlopeTick[];
  cliffs: CliffLine[]; water: WaterArea[];
  extentParts: Float64Array[];   // every part of every classified object, for §2.3
  counts: InputCounts;           // objects per class, tagged cliffs
}
```

`object` is the object's index in the document, in document order; every
list is in document order.

## 2. The band graph

The research describes contour adjacency by nesting and normal sampling
(10 §2.1 step 1). Slice H builds it in T1's **band form**: contour pieces
are joined into chains, the chains and the cliffs are rasterised as
barriers, the free cells fall apart into regions (bands between
contours), and each chain separates the region on its left from the
region on its right. §3 then decides one uphill side per chain.

`buildContourGraph(doc, opts?): ContourGraph | null` runs §1 and §2.1–2.6
in order; `null` when the document has no contour pieces.

### 2.1 Snap join and the continuation rule

Pieces are joined end to end. An **end** is a piece's first or last point
with its outward unit tangent, taken from the end point back to the first
point at least 0.6 mm along the piece (or the far end, if the piece is
shorter). Two ends **continue** each other when their outward tangents
point away from each other: `t₁ · t₂ < −0.3` (a turn of less than about
70°).

Joining is greedy. Every pair of free ends within the tolerance whose
pieces may join is a candidate, scored `d + 0.2 · (1 + t₁ · t₂)` (distance
plus a penalty for a turn), so that where several ends meet in one point
the straightest pair joins first. Candidates are taken in ascending score,
ties by the ends' order (piece order, start before end); an end joins at
most once. A piece does not join its own other end when it is shorter than
`max(3 · tolerance, 1 mm)`. Chains are then emitted in this order: pieces
that were already closed (unchanged); open chains, walked in piece order
from each unlinked end (start before end); then the remaining rings,
walked from their lowest piece's start. A walk that returns to its
starting end is closed. Gaps bridged by a join add their length to the
chain; a closed chain's closing gap is not added.

The **snap join** uses a tolerance of 0.15 mm and the continuation rule
alone. Contours and form lines are snap-joined separately; form lines go
no further than this step, so a form chain's `ends` stay `dangling` as
built and carry no meaning (§3 reads form chains for their geometry only).

### 2.2 End classes and gap bridging

After the snap join every open contour chain's two ends are classified, in
this order (first match wins):

| Class | Rule |
|---|---|
| `frame` | a point straight ahead of the end (along its outward tangent, 0.25 mm steps up to 3 mm) lies outside the mapped area (§2.3) |
| `merge` | another chain lies within 0.2 mm of the end point |
| `cliff` | a cliff lies within 0.4 mm of the end point |
| `dangling` | none of the above |

Then **gap bridging** joins `dangling` ends to each other with the join of
§2.1 at a tolerance of **45 m on the ground** (`45 / groundMPerMm` mm on
paper: 3 mm at 1:15 000, 11.25 mm at 1:4 000). Ends of the other classes
do not bridge. A bridge must continue the line and each end must look at
the other: with `u` the unit vector from end `a` to end `b`,
`la = ta · u` and `lb = −tb · u`, the gap `d` is bridged when

| Gap | Condition |
|---|---|
| `d ≤ 0.6 mm` | `la > 0` and `lb > 0` |
| `0.6 < d ≤ 1.5 mm` | `la > cos 55°` and `lb > cos 55°` |
| `d > 1.5 mm` | `la > cos 40°` and `lb > cos 40°` |

A bridged chain keeps the classes of its outer ends; a chain closed by
bridging has none. Chains of 0.3 mm or less are dropped after bridging. A
chain is an **index chain** when more than half its length comes from
index-contour pieces.

During rasterisation (§2.4) a `dangling` end may become **`extended`**: the
fifth class.

| Constant | Value |
|---|---|
| snap tolerance | 0.15 mm |
| continuation | `t₁ · t₂ < −0.3` |
| turn penalty | 0.2 · (1 + t₁ · t₂) |
| end tangent | over 0.6 mm |
| frame look-ahead | 3 mm in 0.25 mm steps |
| merge / cliff radius | 0.2 mm / 0.4 mm |
| bridge | 45 m on the ground (`bridgeGroundM`) |
| minimum chain | > 0.3 mm |
| extension (§2.4) | frame ends 4 mm; dangling ends ≤ 1.5 mm |

These are T1's constants, unchanged: T1's verdict and H2's targets were
measured with them.

### 2.3 Mapped-area mask

The mapped area is where the map says something about the terrain. Every
part in `extentParts` is drawn into a grid of **0.5 mm** cells over the
contour pieces' bounding box padded by 4 mm + 3 cells (5.5 mm); what lies
beyond that grid is not drawn, so the mapped area never reaches more than
5.5 mm past the outermost contour. The drawn cells are closed with radius
**4 mm** (3-4 chamfer distance: dilate, fill everything not reachable from
the grid border, erode). `maskAt(mask, x, y)` is true inside. The mask is
coarse on purpose: it says where the frame of the mapped terrain is, not
where each line ends.

### 2.4 Barrier raster

The graph raster covers the contour pieces' bounding box padded by 2 mm,
with square cells of `max(cellMm, √(area / maxCells))` (defaults 0.1 mm
and 60 M cells). Each cell holds an `Int32` label:

| Label | Meaning |
|---|---|
| `-1` | outside the mapped area (§2.3, at the cell centre) |
| `-3` | cliff |
| `-10 − i` | chain `i` |
| `0` | free, before labelling |
| `1 … regionCount` | region |

Barriers are drawn by stepping each segment at half a cell: cliffs first,
then chains in order (a chain overwrites a cliff). A closed chain includes
its closing segment. Each `frame` end is extended 4 mm straight ahead
without overwriting another chain or the outside, so that a band cut by
the frame stays cut. Then each `dangling` end looks straight ahead from 2
cells to 1.5 mm; if it meets a cliff or another chain before the outside,
the gap is drawn onto it (without overwriting other chains or the outside)
and the end becomes `extended` (a near-miss merge).

### 2.5 Regions

Free cells are flood-filled 4-connected, in cell order (row-major from the
lower-left), into regions `1 … regionCount`; per region the cell count and
whether it touches the outside or the raster's edge.

### 2.6 Incidence, leaky chains, cliff links

Each chain is sampled every cell length along its polyline (first sample
half a step in). At a sample, the chain's left and right sides are probed
along the normal at 1, 1.5, … 3 cells, skipping the chain's own cells; the
first other label is kept when it is a region, else the side is lost. A
`(left, right)` pair counts when it occurs at least `max(3, 2 %)` of the
chain's samples. A chain is **leaky** when no pair survives or pairs with
the same region on both sides make up half or more of the surviving
samples — its band leaks around it (a gap the joins did not close); a
leaky chain has no pairs. Otherwise same-region pairs are dropped.

Region pairs are keyed as `left · 2²² + right`; `chainIncidence` throws a
`RangeError` when a raster holds 2²² regions or more (the corpus peaks
near 10⁴).

`regionChains[r]` maps each chain bordering region `r` to side bits
(`1` the region is left of the chain, `2` right). **Cliff links** are the
pairs of different regions facing each other across a cliff line (sampled
the same way), for §3–4.

```ts
type EndClass = "frame" | "merge" | "cliff" | "extended" | "dangling";
interface Chain {
  pts: Float64Array; closed: boolean;
  lengthMm: number; indexLengthMm: number; index: boolean;
  ends: [EndClass, EndClass] | null;   // null when closed
  objects: number[];                   // document objects, in walk order
}
interface SidePair { left: number; right: number; samples: number }
interface ContourGraph {
  inputs: ContourInputs;
  chains: Chain[]; formChains: Chain[];
  mask: AreaMask; raster: RegionRaster;
  pairs: SidePair[][]; leaky: Uint8Array;
  regionChains: Map<number, number>[];
  cliffLinks: [number, number][];
  stats: ContourGraphStats;
}
```

### 2.7 Determinism

The same document gives the same graph, field for field: candidate lists
are sorted with index tie-breaks, maps iterate in insertion order, flood
fill and sampling go in a fixed cell and vertex order, and nothing reads
the clock or a random source. `stats` carries counts only (no timings).

### 2.8 Measured on the corpus

H1's corpus check (a `.local/` script, not committed: the corpus is real
club maps) builds the graph of the five corpus maps and the CC0 demo map
(`docs/screenshots/fixtures/puit-de-laven.omap`), imported with no stored
decisions, and compares every count with T1's output. Measured 2026-11-13:

| Map | chains | closed | snap joins | bridged | extended | form chains | ends frame / merge / cliff / dangling | regions | components | leaky % of length |
|---|---|---|---|---|---|---|---|---|---|---|
| crop-a | 294 | 221 | 75 | 1 | 2 | 412 | 107 / 25 / 6 / 6 | 516 | 1 | 0.5 |
| crop-b | 212 | 174 | 43 | 0 | 4 | 352 | 55 / 10 / 2 / 5 | 469 | 1 | 0.5 |
| club-2026 | 2654 | 1823 | 1246 | 99 | 88 | 3593 | 429 / 686 / 240 / 219 | 4306 | 8 | 5.4 |
| club-full | 5617 | 3999 | 2263 | 148 | 194 | 7555 | 368 / 1341 / 778 / 555 | 10495 | 27 | 10.0 |
| sprint | 124 | 81 | 1 | 40 | 4 | 162 | 64 / 4 / 0 / 14 | 305 | 1 | 21.2 |
| puit-de-laven | 181 | 108 | 2 | 1 | 1 | 0 | 138 / 0 / 0 / 7 | 490 | 1 | 4.0 |

Object counts, raster sizes, bridged gaps, extended ends, form chains and
component counts equal T1's on every map; crop-a, crop-b, sprint and
puit-de-laven match T1 in every count (sprint's leaky share is 21.2 % here; T1 reported it as two shares rounded separately, 5.9 + 15.2). On the two club maps the snap
join finds more joins than T1, and the counts that follow from a join
move with it (H1 − T1):

| Count | club-2026 | club-full |
|---|---|---|
| snap joins | +6 | +10 |
| chains | −5 | −6 |
| closed chains | +1 | +4 |
| ends: merge | −10 | −12 |
| ends: cliff | 0 | −4 |
| ends: dangling | −2 | −4 |
| regions | 0 | −1 |
| contour length | +1 mm | 0 |

Every other count is equal. The cause is T1's candidate grid: it computed
a neighbour cell as `⌊(x ± tol) / tol⌋`, which skips a cell when an end
lies on a multiple of the 0.15 mm tolerance — common, since OCAD
coordinates sit on a 0.01 mm grid. H1 steps integer cells (§2.1); with
T1's key put back in for a trial run, club-2026 reproduced T1 in every
count. The extra joins are valid joins by §2.1's rule; the merge, cliff
and dangling ends they remove were the ends those joins connected.

Time for §1–2 on the largest map (club-full, 46 M raster cells): 2.7 s
to 6.4 s on a 16-core machine shared with other jobs (the slower run at
load average 26, where T1's identical mask code also ran 4× slower than
in T1), about 0.7 GB peak RSS for the whole process including the import.
T1 measured the same stages at 1.9 s. Region labelling and the raster dominate. H3 sets the height field's cell
and budget (T1: 18 s / 1.5 GB for the whole spike at 0.1 mm).

## 3. The solve: uphill side and levels

`solveTerrain(graph, opts?)` (`terrain/solve/`, H2) decides for every
chain of §2 which side is uphill and gives every region a level: an
integer number of contour intervals, 0 the lowest region. It reads only
the `ContourGraph`; the interval in metres is H3's (header) and H9's
(measured).

### 3.0 Decided with the user (2026-11-14)

1. **External (DEM) side against the map's evidence**: when an external
   side (H9: the DEM) and a tick, tagged cliff or lake speak about the same
   chain and disagree, **the external side decides**; the disagreement is
   counted per class in the report (`external.disagreements`). H9 takes
   the chain's height from the DEM median, so a sign against it would
   contradict the chain's own heights.
2. **Strict and decided**: closure is flagged (answer 15) and a decision
   propagated from a flagged chain is flagged too, so strict shares are
   lower than T1's. The report carries both `share.strict` and
   `share.decided` (strict + flagged, conflict length removed); the corpus
   comparison with T1 is made on T1's definition, recomputed by the
   `.local` script; **the 3D gate of answer 7 (80 %) reads
   `share.decided`**.
3. **Index consistency without a DEM**: the report's figure is the share
   of neighbouring index-contour pairs (by graph distance) whose levels sit
   on one residue mod 5, with T1's one-residue share of the largest
   component beside it. The map alone cannot tell a drifted block from a
   second contour ladder; the row's target (≥ 90 % on one residue per
   ladder area) is checked by the `.local` corpus script on ladder areas
   taken from the DEM's phase (T2), not by the solve.

## Tests

| Test | Covers |
|---|---|
| `terrain/graph/__tests__/inputs.test.ts` | classification by canonical id in any match state, hidden skipped, tagged / untagged cliff and tag side, tick angle (§1.1–1.3) |
| `terrain/graph/__tests__/flatten.test.ts` | Bézier chords, hole rings, malformed control run (§1.4) |
| `terrain/graph/__tests__/chains.test.ts` | snap join, continuation rule, tie by end order, no short self-closing, three ends at a cliff, gap bridged in ground metres at two scales, the three look-at cones, merge and cliff ends not bridged, short chains dropped, a dangling end, a chain cut by the frame (§2.1–2.2) |
| `terrain/graph/__tests__/raster.test.ts` | mask (closing, the 5.5 mm grid), nested rings → regions, frame ends close a band, near-miss ends `extended` onto a chain and a cliff, chains over cliffs, cell budget (§2.3–2.5) |
| `terrain/graph/__tests__/graph.test.ts` | incidence on nested rings, a leaky chain, cliff links, determinism, no contours (§2.6–2.7) |
| `terrain/graph/__tests__/synthetic.ts` | the fixture: ISOM symbols with canonical matches and library definitions, geometry in mm, a mapped area around the contours |
| `.local/h1/counts.mts` (not committed) | T1's corpus counts reproduced (§2.8) |

## Pending in this chapter

- §3 The solve: evidence, uphill side, levels, `TerrainReport` (H2).
- §4–5 The height field: interpolation, format, sampling, `deriveTerrain` (H3).
- §6 The DEM anchor (H9); §7 DEM providers (H10).
- Storage of the derived artifact is `map-storage.md` (H4).
