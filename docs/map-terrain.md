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

`solveTerrain(graph, opts?)` (`terrain/solve/`, H2; import
`@oxygen/shared/src/terrain/solve/index.js`) decides for every chain of
§2 which side is uphill and gives every region a level: an integer
number of contour intervals, 0 the lowest region of its connected set. It
reads only the `ContourGraph` and does not change it; the interval in
metres is H3's (header) and H9's (measured). Sides: `+1` uphill is left
of the chain's drawing direction, `−1` right, `0` undecided.

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
4. **The ≥ 90 % index target moves to H9** (user, 2026-11-14, after a
   corpus run): from the map alone H2 puts 85.5 % of club-2026's main
   index ladder on one residue and 57–65 % of its three small ones
   (final run, §3.9; 87.5 / 56–61 % when the question was put); with
   perfect (DEM) signs the same solve reaches 85.5 % and 49–65 %. The
   limit is the band graph — bands that leak around a gap span two
   levels (§3.3) — not the signs. H2 lands with leak-aware tiers and
   trial-checked index repair; H9 carries the index target with the DEM.
   Splitting multi-level bands in the graph is a pending item.
5. **A ladder area, for the index target, is an index phase**: the
   index contours whose DEM median falls on one peak of the median mod
   25 m (5 intervals) holding ≥ 8 % of the index length. club-2026's index
   contours lie on three such phases, which T2's 5 m contour phase cannot
   separate; the 5 m figure is reported beside it.

### 3.1 Evidence

Each evidence item says which side of one chain is uphill, with a weight.
The classes and the order in which they are applied are the split's
(SLICES "Decided in this split"); the external side comes first (answer 14).

| Class | Source | Weight | Rule |
|---|---|---|---|
| `dem` | `opts.external` (H9) | 1 | one item per chain with a non-zero side |
| `tick` | slope tick `101.b` | 4 | on the chain within 0.3 mm; the tick points downhill (the glyph's +y turned counter-clockwise by the object's angle, §1.3); dropped when `|sin|` between tick and chain < 0.5 |
| `cliff` | tagged cliff (§1.2) | 1.5 | tags point downhill. A cliff whose midpoint lies within 0.5 mm of a chain speaks about that chain (dropped below `|sin|` 0.7); otherwise it speaks about the chains on both sides by ray (0.5 … 4 mm); cliffs shorter than 0.3 mm end to end are skipped |
| `lake` | water area (§1.3) | 1.5 | rays every 0.5 mm along the outer ring, outwards, 0.2 … 10 mm; a chain hit by ≥ 4 rays and ≥ 20 % of them lies above the lake; rings under 2 mm² skipped |
| `top` | an innermost closed chain | 2 | a closed, non-leaky chain whose inside region borders no other chain and does not touch the outside is a top: uphill inside |
| `formTick` | slope tick `103.b` on an open form line | 1.5 | by ray from the tick, 0.25 … 8 mm both ways; ticks on closed form lines are skipped |

A **ray** marches through the region raster in half cells to the first
chain; it stops at the outside, and is dropped when it grazes the chain
(`|sin|` < 0.3). From a known downhill direction the chain met downhill
is seen from its uphill side and the chain met uphill from its downhill
side; both rays are dropped when they meet the same chain, and a ray is
dropped when it crosses a form line first (it then describes a detail,
not the band). T1's constants, unchanged; T1's per-map tick-direction
detection and its automatic cliff-convention flip are not kept (they
never fired on the corpus).

### 3.2 Staged signs

Evidence is applied in **stages**; a stage only touches chains still
undecided. In a stage the signed weights are summed per chain; the sign
of the sum decides and the chain's class is the strongest contributor on
the winning side (ties to the class earlier in the table). A chain with
items on both sides counts in `evidence.conflictingChains`.

1. `dem` (when `opts.external` is given);
2. `tick`, `cliff`, `lake`, `top` together;
3. `formTick` — only where stages 1–2 and what follows them left a chain
   open;
4. the flagged heuristics of §3.4.

After every stage the solve **settles**: two-contour slope propagation,
then index repair (§3.5) and closure (§3.4) in turn, until nothing
changes (at most 60 rounds). **Slope propagation**: in a region bordered
by exactly two chains one is its lower and the other its upper boundary,
so a decided chain decides the other.

Every decided chain has a **root**: itself for direct evidence and the
heuristics, the root of the chain it was propagated from for slope
propagation. A chain is **flagged** when its root's class is flagged
(closure, band-drain, band-upper, closed-hill — answer 15); index repair
lifts the flag of a group it confirms or flips (§3.5).

With an external side, a tick, cliff or lake that disagrees with it on
the same chain sets a bit in `externalDisagrees` (tick 1, cliff 2,
lake 4); the external side decides (§3.0, 1).

### 3.3 Levels

Region levels come from a **weighted union-find with offsets**: every
edge says `level(a) − level(b) = d`.

| Edge | `a`, `b` | `d` |
|---|---|---|
| pair of a decided chain | uphill, downhill region | 1, or the step index repair set |
| cliff link (§2.6) | second, first region | 0 (assumed), or the step index repair set |
| pair of an undecided chain | left, right region | 0 |

Edges are taken in **trust tiers**, and within a tier by most samples
first (ties by edge key):

| Tier | Edges |
|---|---|
| 1 strict | pairs of unflagged chains |
| 2 flagged | pairs of flagged chains |
| 3 weak pair | pairs along a cliff (≥ 50 % of the pair's samples within 0.5 mm of a cliff line) or beside a band that spans two levels |
| 4 | cliff links with a step set by index repair |
| 5 | other cliff links (weak links) |
| 6 | pairs of undecided chains (weak links) |

A band **spans two levels** when a chain sees it on both of its sides at
`max(3, 2 %)` of its samples (§2.6's pair rule applied to the
same-region pairs, leaky chains and partial leaks alike): the band runs
around the chain, so it joins the bands of two levels into one region.
Its pairs are weak, so levels reach the regions around it by other paths
first. On club-2026 this alone moved the index contours of T2's main 5 m
ladder from 66 % to 78 % on one residue, the share of length on its true
level from 62 % to 71 % and the drift RMS from 2.05 to 1.16 intervals
(§3.9).

An edge whose regions are already joined **closes a cycle** with the
difference `d′` the levels already give:

- decided chain: `d′ = d` consistent; `d′ ≥ 1` otherwise **multi-step**
  (`chainStep = d′`: contours merged into this one, e.g. along a cliff);
  `d′ ≤ 0` a **conflict** (`conflict` += the pair's share of the chain's
  samples);
- cliff link: `cliffStep = d′`, source `implied`.

A tree edge of tier 5 or 6 is a **weak link**: it keeps the surface
continuous but says nothing about the step. `regionComponent` is the
union over tiers 1–4; `regionWeak` marks regions whose component is not
that of their connected set's root block. Levels are normalised so that
the lowest region of each connected set is 0. A chain's **level** is the
higher floor of the two sides of its pair with most samples (the highest
contour level it stands for); `NO_LEVEL` without pairs.

### 3.4 Flagged heuristics

Every decision here is flagged and is its own root.

- **Closure** (in every settle): an undecided chain whose strongest
  pair's two regions are already levelled in one component takes the
  sign of their difference (when it is not 0). It runs in T1's place,
  between the strict stages; run after the band rules it was 63 % true
  on club-2026, here 79 %.
- **Band-drain**: in a region bordered by three chains or more that does
  not touch the outside, whose known chains (at least two) are all upper
  boundaries and which has one unknown chain, that chain is its lower
  boundary.
- **Band-upper**: in a region bordered by three chains or more with a
  known lower boundary, the unknown chains are upper boundaries.
- **Closed-hill**: the last default — an undecided closed, non-leaky
  chain is a hill.

They run in rounds (band-drain, else band-upper, else closed-hill; one
rule per round, at most 200 rounds), each followed by a settle.
`opts.heuristics: false` leaves those chains undecided.

### 3.5 Index repair

Every fifth contour is an index contour, so two index contours' levels
should differ by a multiple of five. Index repair turns that into steps
and signs (`opts.indexRepair`, default on).

- **Neighbours**: each index chain with pairs takes its up to 4 nearest
  other index chains, by bands crossed (breadth first over chain pairs
  and cliff links, at most 12 bands; ties by chain). Each neighbour pair
  weighs `min(length i, length j)`.
- **Votes**: the level forest of §3.3 is read as a tree. A neighbour
  pair in one connected set whose tree path crosses a **suspect edge**
  (tier ≥ 2) votes on it for the shift (mod 5) of the edge's far side
  that would put the pair on one residue. A chain's place in the tree is
  the region whose floor is its level.
- **Proposals**: an edge whose modal shift holds ≥ 80 % of its vote
  weight proposes one change, by tier: a weak pair takes the step
  `k ∈ 1 … 5` that gives the shift; a cliff link the step that gives it
  within `0 … 4` towards the untagged side when the cliff is tagged
  (tags point downhill), else within `−2 … 2`; an undecided chain the
  sign whose step `±1` gives it (class `index`, strict); a flagged
  group — its root and every chain with that root — is **flipped** when
  the shift is not 0 (class `index` on the root, `corrected` on the
  group) and **confirmed** when it is 0 (its flag lifted). Flips are
  proposed only in the last settle, after the heuristics.
- **Trial**: each proposal is applied on its own and kept only when the
  weight of neighbour pairs on one residue rises (a confirmation: does
  not fall) and the conflict length does not grow; otherwise it is
  undone. Proposals are taken in tree order from the roots; votes are
  collected again in the next pass (at most 8 passes per settle).

Strict chains are never flipped (T2: tick, cliff and lake 99.8–100 %
true, top 98 %). A drifted block and a second contour ladder look the
same from the map alone (§3.0, 3); repair only ever moves a suspect edge
and only keeps a change the index contours agree with, so a ladder
border inside strictly chained contours is left as it is. H1's band
graph limits what repair can reach (§3.0, 4).

Measured against hard index anchors (index pairs joined first at the
rounded counted step): they put 97 / 99 % of club-2026's index contours
on one residue per 5 m ladder but broke the levels around them (drift
RMS 1.7 → 3.1 intervals on club-2026, 5.9 on crop-b) and were dropped.

### 3.6 The report and the components

`TerrainReport` is plain JSON; shares are fractions of contour length.

| Field | Meaning |
|---|---|
| `share.strict`, `share.flagged` | decided chains, by their flag |
| `share.decided` | strict + flagged, conflict length removed — **the 3D gate reads this** (answer 7, §3.0) |
| `share.undecided`, `share.leakyUndecided`, `share.leakySigned` | undecided non-leaky and leaky chains; leaky chains that evidence decided |
| `share.conflict`, `share.multiStep` | conflict length (a chain whose conflict share exceeds ½ counts whole, else by its share); length of chains with `chainStep` > 1 |
| `byClass` | length by deciding class, `conflict`, `none`, `leaky` |
| `evidence` | items per class, `conflictingChains` |
| `external` | source, chains, length share decided by it, disagreements per class; null without |
| `levels` | components, largest component's share and levels, multi-step chains, weak regions |
| `index` | index length, neighbour pairs, `consistency` (weight share of neighbour pairs in one connected set on one residue), `modalShare` (T1's figure: the largest component's index length on its modal residue), and repair counts: steps set, groups flipped (and their length), groups confirmed, chains decided, proposals unresolved |
| `components` | the 8 largest: length share, confidence, levels, index consistency |

A **component** (`TerrainComponent`) is a set of regions joined by tiers
1–4 with its decided chains; **confidence** = (strict length − conflict
length) / length.

### 3.7 Interface

```ts
type EvidenceClass = "dem" | "tick" | "cliff" | "lake" | "top" | "formTick";
type SignClass = EvidenceClass | "slope" | "index" | "closure" | "bandDrain" | "bandUpper" | "closedHill";
const SIGN_CLASSES: readonly ["none", "dem", "tick", …];        // signClass indexes this
interface SideEvidence { chain: number; side: 1 | -1; weight: number }
type EvidenceSet = Record<Exclude<EvidenceClass, "dem">, SideEvidence[]>;
interface ExternalSide { source: string; side: Int8Array }      // per chain, H9
interface SolveOptions { evidence?: EvidenceSet; external?: ExternalSide; heuristics?: boolean; indexRepair?: boolean }
interface TerrainSolution {
  side: Int8Array; signClass: Uint8Array; flagged: Uint8Array; root: Int32Array; corrected: Uint8Array;
  chainLevel: Int32Array; chainStep: Uint8Array; conflict: Float32Array; externalDisagrees: Uint8Array;
  regionLevel: Int32Array; regionComponent: Int32Array; regionWeak: Uint8Array;
  cliffStep: Int32Array; cliffStepSource: Uint8Array;            // per graph.cliffLinks entry: implied / index / assumed
  components: TerrainComponent[]; report: TerrainReport;
}
function gatherEvidence(graph: ContourGraph): EvidenceSet;
function solveTerrain(graph: ContourGraph, opts?: SolveOptions): TerrainSolution;
```

The building blocks (`buildForest`, `slopeFix`, `repairPass`,
`indexNeighbours`, the probes) are exported for tests and for H3 / H9.

### 3.8 Determinism

The same graph and options give the same solution field for field: edges
are sorted with key tie-breaks, regions and chains are visited in index
order, maps iterate in insertion order, and nothing reads the clock or a
random source. The graph is not mutated.

### 3.9 Measured on the corpus

A `.local/` script (not committed) solves the five corpus maps and
compares the result with ground truth from Lantmäteriet's 1 m model,
sampled on H1's chains the way T2 did (a chain's side: median of
left − right at ±8 m on the 5 m-smoothed model, decided at ≥ 0.4 m, ≥ 65 %
agreement and ≥ 90 % coverage; its height: the median along it). Shares
of contour length, 2026-11-14:

| Map | strict (T1 def.) | T1 | strict | flagged | decided | true sign | T1 true | solve ms |
|---|---|---|---|---|---|---|---|---|
| crop-a | 94.3 | 94.8 | 90.6 | 8.6 | 99.2 | 99.4 | 99–99.5 | 90 |
| crop-b | 94.2 | 95.3 | 97.5 | 2.0 | 96.9 | 99.4 | 99–99.5 | 58 |
| club-2026 | 86.5 | 87.0 | 82.8 | 14.3 | 94.1 | 96.4 | 96.6 | 604 |
| club-full | 85.0 | 85.4 | 83.2 | 12.8 | 92.7 | 96.8 | 96.3 | 1642 |
| sprint | 81.9 | 81.9 | 85.5 | 8.5 | 90.3 | 99.0 | 99–99.5 | 32 |

"strict (T1 def.)" counts T1's strict classes (tick … closure) whatever
they descend from, conflict length removed (§3.0, 2); T1's figures were
measured on T1's graph (H1 has 6 / 10 more snap joins on the club maps,
§2.8). True sign per class on club-2026 (share of contour length in
brackets): cliff 99.9 (29.3), tick 100 (20.8), top 98.3 (15.1), slope
98.7 (9.0), closure 78.7 (6.0), band-upper 78.2 (5.8), lake 100 (3.4),
form tick 91.9 (2.7), band-drain 100 (1.8), slope from a flagged root
80.5 (0.5), index 70.6 (0.3); on club-full: cliff 99.5, top 97.3, slope
96.6, tick 99.1, band-upper 85.0, closure 79.2, form tick 94.6,
band-drain 98.8, lake 100, index 100. T1's hold-out (one evidence class
against the others) is not repeated: the DEM truth replaces it.

**Index contours on one residue**, per index ladder (§3.0, 5; each
ladder's index length in mm), per component:

| Map | H2 | H2 without index repair | H2 with the DEM side | T1 (per map, 5 m) |
|---|---|---|---|---|
| crop-a | 100 (1208) | 98.4 | 100 | 100 |
| crop-b | 93.2 (1170) | 93.2 | 93.2 | — |
| club-2026 | 85.5 (4049) / 64.8 (594) / 61.5 (958) / 56.5 (436) | 85.5 / 57.3 / 56.6 / 49.3 | 85.5 / 48.7 / 64.7 / 59.0 | 62.8 |
| club-full | 35.8 (6686) / 46.6 (5117) / 70.3 (686) / 71.4 (1993) | 43.9 / 49.2 / 60.1 / 72.0 | 38.7 / 49.4 / 78.5 / 84.9 | 30 |

On T2's two 5 m ladders club-2026 reads 84.3 / 52.9 %. The DEM's own
levels put only 88.5 / 50.5 % of club-2026's index contours on one
residue per 5 m ladder, which is why the target is read per index phase.

**Level drift** (intervals): each tight chain's DEM level on its 5 m
ladder against the solve's, one offset per (component, ladder); share of
compared length exactly right, off by 1, 2, ≥ 3, and the RMS:

| Map | exact | 1 | 2 | ≥ 3 | RMS | without repair: exact / RMS | T1 (T2) |
|---|---|---|---|---|---|---|---|
| crop-a | 99.4 | 0.6 | 0 | 0 | 0.08 | 99.1 / 0.13 | |
| crop-b | 91.6 | 6.9 | 1.5 | 0 | 0.36 | 91.6 / 0.36 | |
| club-2026 | 74.4 | 8.3 | 7.9 | 9.4 | 1.20 | 75.1 / 0.96 | block-wise ±1–3 |
| club-full | 36.6 | 20.8 | 13.7 | 28.9 | 2.80 | 38.6 / 3.04 | block-wise ±6–8 |
| sprint | 61.6 | 36.9 | 1.5 | 0 | 0.65 | 61.6 / 0.65 | |

The baseline before H2's changes (T1's solve on H1's graph, closure
flagged, no leak tiers) was 61.8 % exact / RMS 2.05 on club-2026 and
41.7 % / 2.23 on club-full. Index repair's net effect on the corpus is
small and of mixed sign (club-2026's small ladders gain 5–8 points,
club-full's largest loses 8); club-full's drift stays block-wise even
with the DEM's signs (43 % exact), the graph limit of §3.0, 4.

Time: the solve takes 1.6 s on club-full (5617 chains, 10 495 regions)
on top of §2's graph, on a shared 16-core machine.

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
| `terrain/solve/__tests__/evidence.test.ts` | tick direction and side, grazing and off-chain ticks dropped, tops by orientation and not around another chain, a tagged cliff between contours and on a contour, lakes and the 2 mm² floor, form ticks on open lines, dropped on closed lines and across another form line (§3.1) |
| `terrain/solve/__tests__/levels.test.ts` | union-find offsets, a ladder levelled from 0, multi-step on a cycle, conflict share, weak pairs after strict ones, pairs beside a two-level band weak, tier order, weak links and their components, a step set by index repair, no level without pairs (§3.3) |
| `terrain/solve/__tests__/solve.test.ts` | slope propagation and roots, evidence both ways by weight, the external side first, over a tick (disagreement reported) and over closure, band-upper flagged and inherited, heuristics off, closed-hill, cliff-borne pairs and two-level bands, determinism and no mutation, report shares, leaky-signed (§3.2–3.4, 3.6, 3.8) |
| `terrain/solve/__tests__/index-repair.test.ts` | a cliff hiding two contours recovered from the index contours (step 2, source `index`), the zero default without repair or without an index contour above; a flipped flagged group corrected, a strictly decided nest left alone (§3.5) |
| `terrain/solve/__tests__/fixtures.ts` | the graph fixture with chain lookup, ticks, arcs |
| `.local/h2/{truth,measure,ladders}.mts` (not committed) | the corpus run against Lantmäteriet's 1 m model (§3.9) |

## Pending in this chapter

- §3: bands that span two levels are only demoted in the level forest,
  not split; splitting them (H1's raster) is what would lift the levels
  further (§3.0, 4). No row yet.
- §3: the index target (≥ 90 % per index ladder) is H9's, with the DEM
  (§3.0, 4).
- §3: 10 §2.1's depressions, spot heights and text labels are not
  evidence (the split's order leaves them out).
- §4–5 The height field: interpolation, format, sampling, `deriveTerrain` (H3).
- §6 The DEM anchor (H9); §7 DEM providers (H10).
- Storage of the derived artifact is `map-storage.md` (H4).
