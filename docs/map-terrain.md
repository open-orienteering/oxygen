# Map terrain

Normative specification of **terrain derived from a map document**: the
contour graph (§1–2), the solve that gives each contour its uphill side and
level (§3), the height field (§4–5), and the DEM anchor (§6–7). Research
record: `docs/research/vector-map-pipeline/10-terrain.md` (with spike T1,
§7) and the slice H split in `SLICES.md` ("Slice H"); decisions in
`decisions/slice-h.md`. Slice H.

Implementation: `packages/shared/src/terrain/` — pure TypeScript, no Node
APIs, no randomness. `terrain/graph/` is §1–2 (H1), `terrain/solve/` is
§3 (H2), `terrain/anchor/` is §6 (H9). Consumers import by subpath,
`@oxygen/shared/src/terrain/graph/index.js`,
`@oxygen/shared/src/terrain/solve/index.js` and
`@oxygen/shared/src/terrain/anchor/index.js`; the package's root
`index.ts` re-exports none of them.

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
   contours lie on four such phases (about 23, 21, 19 and 0 m), which T2's 5 m contour phase cannot
   separate; the 5 m figure is reported beside it.

### 3.1 Evidence

Each evidence item says which side of one chain is uphill, with a weight.
The classes and the order in which they are applied are the split's
(SLICES "Decided in this split"); the external side comes first (answer 14).

| Class | Source | Weight | Rule |
|---|---|---|---|
| `dem` | `opts.external` (H9) | 1 | one item per chain with a non-zero side |
| `tick` | slope tick `101.b` | 4 | on the chain within 0.3 mm; the tick points downhill (the glyph's +y turned counter-clockwise by the object's angle, §1.3); dropped when `|sin|` between tick and chain < 0.5 |
| `cliff` | tagged cliff (§1.2) | 1.5 | tags point downhill. A cliff whose midpoint lies within 0.5 mm of a chain speaks about that chain (dropped at `|sin|` 0.7 or below); otherwise it speaks about the chains on both sides by ray (0.5 … 4 mm); cliffs shorter than 0.3 mm end to end are skipped |
| `lake` | water area (§1.3) | 1.5 | rays every 0.5 mm along the outer ring, outwards, 0.2 … 10 mm; a chain hit by ≥ 4 rays and ≥ 20 % of them lies above the lake; rings under 2 mm² skipped |
| `top` | an innermost closed chain | 2 | a closed, non-leaky chain whose inside region borders no other chain and does not touch the outside is a top: uphill inside |
| `formTick` | slope tick `103.b` on an open form line | 1.5 | on a form line within 0.3 mm; by ray from the tick, 0.25 … 8 mm both ways; ticks on closed form lines are skipped |

A **ray** marches through the region raster in half cells to the first
chain cell; it stops at the outside, and is dropped when no segment of
that chain lies within 3 cells + 0.2 mm of the hit or when it grazes the
chain (`|sin|` < 0.3). From a known downhill direction the chain met downhill
is seen from its uphill side and the chain met uphill from its downhill
side; both rays are dropped when they meet the same chain, and a ray is
dropped when it crosses a form line first (tested from 0.3 mm beyond the
ray's start, past the tick's own line) (it then describes a detail,
not the band). T1's constants, unchanged; T1's per-map tick-direction
detection and its automatic cliff-convention flip are not kept (they
never fired on the corpus).

### 3.2 Staged signs

Evidence is applied in **stages**; a stage only touches chains still
undecided. In a stage the signed weights are summed per chain; the sign
of the sum decides and the chain's class is the strongest contributor on
the winning side (ties to the class earlier in the table). A chain whose
weights cancel exactly stays undecided for that stage. A chain decided in
a stage with items on both sides counts in `evidence.conflictingChains`.

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
first (ties by edge key). A pair is weak (tier 3) whatever its chain's
flag; tiers 1 and 2 hold the other pairs of decided chains:

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
union over tiers 1–4. The forest's tree edges are read as a tree rooted,
in each connected set, at the **root block**: the tier-1 block with most
regions (ties to the block whose root region has the lowest index),
visited breadth first. `regionWeak` marks regions whose component is not
the root block's. Levels are normalised so that
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
  other index chains, by bands crossed: breadth first over chain pairs
  and cliff links from the chain's own regions (ring 0) to ring 12; an
  index chain bordering a region of ring `d` is `d` bands away; ties by
  chain. Each neighbour pair
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
  undone. Proposals are taken in tree order from the root blocks; the
  votes of one pass are collected once, so a later proposal of the same
  pass may already be satisfied and is then undone. One pass runs per
  settle round (§3.2, at most 60).

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
| `index` | index length, neighbour pairs, `consistency` (weight share of neighbour pairs in one connected set on one residue), `modalShare` (T1's figure: the largest component's index length on its modal residue), and repair counts summed over all passes: steps set, groups flipped (and their length), groups confirmed, chains decided, and `unresolved` — attempts that found no agreeing vote, no legal step or failed their trial (a standing edge counts once per pass) |
| `chains`, `lengthMm` | chain count and total contour length (0 for no chains) |
| `components` | the 8 largest: length share, confidence, levels, index consistency |

A **component** (`TerrainComponent`, in `TerrainSolution.components`,
largest first) is a set of regions joined by tiers 1–4 with its decided
chains: `id` (its root region), `regions`, `lengthMm` (decided chains),
`confidence` = (strict length − conflict length) / length,
`flaggedShare`, `minLevel` / `maxLevel` (over its regions),
`indexLengthMm`, `indexConsistency` (neighbour pairs whose first chain is
in it; null without).

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
§2.8). True sign per class on club-2026 (in brackets the class's share
of contour length among the chains the DEM decides too, conflict length
included — so they sum to more than "decided"; "slope from a flagged
root" is apart from "slope"): cliff 99.9 (29.3), tick 100 (20.8), top 98.3 (15.1), slope
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
small and of mixed sign: club-2026's small ladders gain 5–8 points but
its drift RMS rises from 0.96 to 1.20 (exact 75.1 → 74.4 %); club-full's
largest ladder loses 8 points while its RMS falls from 3.04 to 2.80; club-full's drift stays block-wise even
with the DEM's signs (43 % exact), the graph limit of §3.0, 4.

Time: the solve takes 1.6 s on club-full (5617 chains, 10 495 regions)
on top of §2's graph, on a shared 16-core machine.

## 6. The DEM anchor

`anchorLevels(graph, sampleDem, opts)` (`terrain/anchor/`, H9) reads a
digital elevation model along every chain of §2: the chain's height, the
DEM's statement of its uphill side (handed to §3 as the external side),
the contour ladder it belongs to and, where that ladder is clear, an
integer level. `anchoredHeights(graph, anchor, solved)` runs after §3's
solve and gives a height to the chains the DEM could not anchor. Both are
pure; the provider, the fetch and the paper → projected transform are
§7's (H10).

### 6.0 Decided with the user (2026-11-14)

1. **Grade is declared by the caller.** `grade: "anchor"` (Lantmäteriet's
   1 m model) or `"coarse"` (GLO-30, answer 13). A coarse DEM's side uses
   T2's GLO-30 parameters (§6.3) and enters §3 as the external side like
   an anchor-grade one (T2: 99.2 % sign agreement with Lantmäteriet). A
   coarse DEM gets per-chain heights and levels only when its own interval
   concentration R(I) ≥ 0.6 (§6.5; puit-de-laven 0.774); below that it
   gives one offset per component and a drift bound (§6.8).
2. **The interval is reported, never changed.** `intervalM` is an input
   (answer 8's assumed 5 m / 2.5 m); the report carries R at I and I/2,
   globally and within each ladder, and `intervalSuspect` (§6.5). This
   narrows answer 8's "H9 measures it": a scan would pick 2.5 m on both
   full club maps, whose two ladders sit half an interval apart. The
   per-map override stays later.
3. **A ladder area is spatial**, and the corpus target is read per area:
   on club-2026, ≥ 94 % of snapped index-contour length lies on its
   area's modal residue (mod 5), **and** snapped index length is ≥ 80 % of
   covered index length, so the target cannot be met by snapping less. If
   one connected area still holds two residues in separate blocks, areas
   are split by index residue and §6.7 says so.
4. **The DEM's side decides** against a tick, cliff or lake (§3.0 answer 1,
   which supersedes answer 14's "reported, not overridden"); H9 emits the
   side under answer 14's thresholds, unchanged.
5. **§3.0's moved index target is read per index phase and contour
   ladder** (user, 2026-11-14, after H2 merged into H9): H2's ≥ 90 % per
   index phase (§3.0, 4–5) is measured on H9's snapped levels within each
   (index phase × contour ladder of §6.6), because a level counts from its
   own ladder's phase and one index phase can hold index contours of two
   contour ladders (club-2026's phase at about 18 m: 72.8 % across both
   ladders, 100 % within each). H9's own acceptance stays answer 3's
   spatial target. §6.10 reports both readings and the literal per-phase
   figure.

### 6.1 Inputs

```ts
/** DEM height in metres at a paper position (mm, x right, y up); NaN = no data. */
type DemSampler = (xMm: number, yMm: number) => number;
interface AnchorOptions {
  intervalM: number;           // the assumed interval (answer 8)
  source: string;              // e.g. "lantmateriet-1m"; the external side's source
  grade: "anchor" | "coarse";  // §6.0 answer 1
  demCellM: number;            // ground cell of the model behind sampleDem
}
```

The sampler is in paper millimetres: the chapter's unit; §7 composes the
paper → projected transform and the provider's grid. Ground distances
below convert through `graph.inputs.groundMPerMm`.

### 6.2 Chain statistics

Each chain is sampled every 2 m on the ground (`2 / groundMPerMm` mm),
H1's walk (§2.6: first sample half a step in, a closed chain's closing
segment included). At each sample the DEM height is read; **coverage**
is valid (non-NaN) samples over all samples. Over the valid heights: the
**median** and the **half-IQR** (`(q75 − q25) / 2`), quantiles linearly
interpolated between order statistics. A chain with coverage < 0.9 is
**uncovered**.

### 6.3 The DEM side

At each sample the left and right probes sit at ±`offset` along the
normal (left = `(−ty, tx)` of the drawing direction) and read the
**smoothed** model; a sample counts when both probes are valid. Over the
counted differences `left − right`: `sideMedian` and `sideAgree`, the
share of differences with the median's sign. The side is
`sign(sideMedian)` (+1: uphill left, §3's convention) when the chain is
covered, `|sideMedian| ≥ min` and `sideAgree ≥ 0.65`; else 0.

| Grade | offset | smoothing | min |
|---|---|---|---|
| anchor | 8 m | 5 m box mean | 0.4 m |
| coarse | 20 m | none | 0.5 m |

The 5 m box mean is computed by H9 from point samples: an n × n stencil
at `demCellM` spacing along the paper axes, `n = 2·round((5 / demCellM −
1) / 2) + 1` clamped to 1…5 (5 × 5 at 1 m, 3 × 3 at 2 m); any NaN in the
stencil makes the probe NaN. The side is emitted for every chain that
passes this test, accepted by §6.4 or not; `anchor.external` is §3's
`ExternalSide` (`{ source, side: Int8Array }`).

### 6.4 Acceptance and height

A covered chain is **accepted** at half-IQR ≤ 0.3 I; else it is
**spread-failed** and §6.8 gives its height. An accepted chain's height
is its **unsnapped median** (answer 12), also when it is snapped (§6.7);
per-chain absolute heights replace the header's single offset. Under a
coarse grade that is not promoted (§6.0 answer 1) an accepted chain has
no per-chain height (status `coarse`).

Statuses: `uncovered`, `spreadFailed`, `unsnapped` ("DEM, unsnapped"),
`snapped`, `coarse`.

### 6.5 Interval concentration

**Contributors** are covered chains with half-IQR ≤ 0.25 I (anchor;
0.5 I coarse) and ground length ≥ 60 m. For a trial interval J,
`R(J) = |Σ w·e^{2πi·m/J}| / Σ w` over contributors (w the chain's length,
m its median) and the phase `arg(…)·J / 2π mod J`. The report carries
R(I), R(I/2), the global phase at I, the number of contributors, and per
ladder (§6.6) R(I) over its members. **Promotion**: a coarse DEM is
promoted when R(I) ≥ 0.6. **`intervalSuspect`** is set when R(I/2) ≥ 0.6
and less than half of the contributors' length is labelled by §6.6's
vote — two phases half an interval apart mixed everywhere, which is what
a true interval of I/2 looks like (two ladders in separate places are
labelled, so a two-ladder map is not suspect).

### 6.6 Ladders: candidates, evidence and the vote

The phase is estimated per neighbourhood, never per map (answer 12), as
discrete ladders and a vote — not T2's windowed circular mean, which
mixes two ladders at their border and splits a ladder whose phase is near
0 / I between two levels (decision log).

1. **Candidates.** A length-weighted circular density of `m mod I` over
   the contributors (100 bins, wrapped Gaussian σ = 0.06 I). Local maxima
   in descending density; one is kept when the contributors' length
   within ±0.15 I is ≥ 4 % of the total and it lies ≥ 0.2 I from every
   kept one; at most 4. A kept ladder's phase is the circular mean of the
   contributors within ±0.15 I of its peak, in [0, I). No ladder: every
   accepted chain is unsnapped.
2. **Members.** A contributor belongs to the nearest ladder within 0.2 I
   (circular distance); its **deviation** is `m − phase` wrapped to
   (−I/2, I/2].
3. **Evidence grid.** 100 m ground cells over the chains' bounding box;
   per cell and ladder, the member length passing through the cell (the
   §6.2 samples, each its step length) and the length-weighted deviation.
   Summed-area tables make every window O(1).
4. **Vote per chain.** With f_c the chain's share of its length in cell
   c, `E_l(r) = Σ_c f_c · Σ_{window(c, r)} (evidence_l − own_l)` — the
   chain's own contribution removed, so its residual is tested against
   its neighbours only. The window's half-width r grows from 1 cell
   (300 m) to 5 (1.1 km) until `T(r) = Σ_l E_l(r) ≥ 1500 m`; r = 5 if it
   never does. The chain is **labelled** with the winning ladder when
   `T ≥ 300 m` and the winner's share `E_l / T ≥ 0.6`; else unlabelled.

### 6.7 Local phase, areas, levels

- **Local phase**: the winning ladder's phase plus the mean deviation of
  its members in the winning window (own removed, same weights). It
  follows slow drift and never wraps.
- **Ladder areas**: every cell is labelled by the same vote centred on
  the cell, with all evidence; cells of one ladder form areas by
  4-connection; an area whose own ladder evidence is under 1500 m is
  dissolved (its cells unlabelled). A chain's area is the area holding
  most of its length; −1 when none.
- **Split by index residue** (§6.0 answer 3's rider): a map's index
  contours can sit on different levels in different parts of one ladder
  area (club-2026: whole 1 km blocks one level apart; the mapper's
  sources, not the DEM). After snapping, within each area every cell votes
  among the residues `ladderLevel mod 5` of the area's snapped index
  chains (their length in the area's cells; the same adaptive window and
  thresholds as the chain vote, no own removal), else no residue; the
  cells of one area and one residue (or of none) form sub-areas by
  4-connection; a sub-area with under 1500 m of the area ladder's member
  evidence is dissolved. These sub-areas are the **ladder areas** of the
  report and of `chains.area`.
- **Level**: `ladderLevel = round((median − localPhase) / I)` and
  `residual = median − localPhase − I · ladderLevel`. An accepted,
  labelled chain is **snapped** when `|residual| ≤ 0.3 I` and levels are
  allowed (anchor grade, or coarse promoted); else unsnapped.
  `ladderLevel` is absolute (`localPhase + I · ladderLevel` is the snapped
  height in metres), named apart from §3's relative `chainLevel`;
  `NO_LEVEL` (−2³¹) unless snapped.

### 6.8 After the solve: anchored heights

`anchoredHeights(graph, anchor, solved)` reads §3's per-chain `side`,
`chainLevel` and `chainStep` and per-region `regionComponent`. A chain's
component is that of the left region of its first side pair; chains
without pairs or without a level (`NO_LEVEL`) have none.

- **Accepted chains** keep the DEM median (source `dem`).
- **Component offset**: the length-weighted median of `h_j − I · L_j`
  over the component's accepted chains with a level.
- **A chain the DEM did not anchor** (spread-failed, or uncovered) with a
  level: its band neighbours are the chains sharing a region with it
  (`pairs`, `regionChains`); breadth-first to depth 3, the first depth
  with accepted chains of the same component gives candidates
  `h_j + I · (L_u − L_j)`; the height is their length-weighted median,
  clamped into [max h_j of neighbours with L_j < L_u, min h_j of
  neighbours with L_j > L_u] (source `neighbours`). It is **bounded**
  when the clamp moved it or the candidates spread over more than I/2.
  With no accepted chain within 3 bands: the component offset plus
  `I · L_u` (source `component`). With no accepted chain in the
  component: no height (source `none`, NaN). This borrows §3's step for
  the chains the DEM left out only; band-neighbour step propagation from
  DEM differences is not built (T2: worse).
- **Coarse, not promoted**: no chain has a per-chain height; the
  component offset is taken over covered chains with half-IQR ≤ 0.5 I,
  every chain with a level gets `offset + I · L_u` (source `component`),
  and the **drift bound**: where the chain's median lies more than 1.5 I
  from that height, the height moves by `I · round(residual / I)`
  (counted `driftShifted`) — the DEM keeps §3's levels within ±1 interval
  of it (answer 13). The result is flagged `coarse` (a 30 m surface
  model).

```ts
interface AnchoredHeights {
  height: Float64Array;          // metres; NaN = none
  source: Uint8Array;            // HEIGHT_SOURCE: none 0, dem 1, neighbours 2, component 3
  bounded: Uint8Array;
  componentOffset: Map<number, number>;  // component root region → metres
  coarse: boolean;
  report: { share: { dem; neighbours; component; none: number }; bounded: number;
            driftShifted: number; drift: Record<string, number> };
}
```

`report.drift` is the length share of accepted chains by
`round((h_j − offset − I · L_j) / I)`: §3's level drift against the DEM,
in intervals.

### 6.9 The report

```ts
interface AnchorReport {
  source: string; grade: "anchor" | "coarse"; intervalM: number;
  levelsAllowed: boolean; intervalSuspect: boolean;
  coverage: number;                                 // covered share of contour length
  interval: { contributors: number; rAtI: number; rAtHalfI: number; phaseM: number };
  ladders: { phaseM: number; lengthShare: number; rAtI: number }[];
  areas: { ladder: number; lengthShare: number; indexResidue: number | null; indexOnResidue: number | null }[];
  share: { sideDecided; accepted; snapped; unsnapped; spreadFailed; uncovered; unlabelled: number };
  index: { lengthMm: number; snappedShare: number; inAreasShare: number; onOneResiduePerArea: number | null };
  alongContour: { halfIqrP50: number; halfIqrP90: number };   // metres, length-weighted
}
```

Shares are of contour length. `index.snappedShare` is snapped over
covered index length, `inAreasShare` snapped index length in an area over
all snapped index length. An area's index residue is the modal
`ladderLevel mod 5` of its snapped index chains, by length;
`onOneResiduePerArea` sums every area's modal length over the snapped
index length in areas (§6.0 answer 3).

### 6.10 Measured on the corpus

H9's corpus check (`.local/h9/`, not committed: real club maps and a
licensed DEM) runs `anchorLevels` on H1's graph of the five corpus maps
with Lantmäteriet's 1 m model (T2's tiles), through a bilinear point
sampler, and compares with T2. Measured 2026-11-14:

| Map | spread-accepted % (T2) | half-IQR p50 m (T2) | R(I) / R(I/2) (T2) | side decided % | snapped % | ladders (phase m, share %) | areas | index snapped % (T2) | index on area residue % (T2 per map) |
|---|---|---|---|---|---|---|---|---|---|
| crop-a | 99.9 (99.9) | 0.33 (0.34) | 0.931 / 0.802 (same) | 99.5 | 98.8 | 0.12 / 98 | 1 | 100 (100) | 100 (98.8) |
| crop-b | 99.9 (99.9) | 0.35 (0.35) | 0.946 / 0.835 (0.946 / 0.834) | 99.5 | 99.1 | 0.15 / 98 | 1 | 99.3 (100) | 100 (100) |
| club-2026 | 95.0 (94.9) | 0.42 (0.43) | 0.439 / 0.530 (0.438 / 0.529) | 97.6 | 76.7 | 2.76 / 69, 0.33 / 23 | 14 | 85.0 (73.3) | 99.2 (94.5) |
| club-full | 96.6 (96.6) | 0.40 (0.40) | 0.184 / 0.546 (0.183 / 0.547) | 98.2 | 78.0 | 0.05 / 55, 2.75 / 39 | 19 | 81.9 (74.6) | 98.9 (66.4) |
| sprint (I = 2.5 m) | 90.5 (90.5) | 0.26 (0.26) | 0.771 / 0.521 (0.722 / —) | 95.5 | 84.8 | 0.01 / 92 | 1 | 100 (—) | 100 (100) |

- **The side** equals T2's method (median at ±8 m on the 5 m box, 0.4 m,
  65 %) on the same H1 chains on 100.00 % of the length both decide; each
  method alone decides 0.05–0.7 % of length (the stencil here is along
  the paper axes on bilinear samples, T2's a box blur of the grid).
- **R** differs from T2 only on sprint: T2 took contributors at half-IQR
  ≤ 1.25 m on every map, §6.5 takes 0.25 I (0.625 m at 2.5 m).
- **The target (§6.0 answer 3) holds on club-2026**: 85.0 % of covered
  index length snapped (floor 80 %), 99.8 % of it in an area, 99.2 % on
  its area's residue. Without the residue split (ladder areas only) the
  figure is 91.8 %: the off-residue length sits in whole blocks (3.4 km of
  index contours in one 1 km block one level below their area). T2's
  1.1 km circular mean snapped 64.1 % of club-2026's length and 73.3 % of
  its index length; the vote snaps 76.7 % and 85.0 %.
- **§3.0's index target per index phase** (H2's phases: peaks of the
  index contours' DEM median mod 25 m holding ≥ 8 % of tight index
  length, ±1.5 m), on H9's snapped levels — share of snapped index length
  on one residue across contour ladders / within each contour ladder
  (§6.0 answer 5), and the share of the phase's index length snapped:

  | Map | phase m (index km) | snapped % | on one residue % | per contour ladder % |
  |---|---|---|---|---|
  | club-2026 | 23.25 (65.3) | 91.2 | 98.3 | 100 |
  | club-2026 | 20.25 (15.4) | 79.1 | 100 | 100 |
  | club-2026 | 18.25 (7.1) | 70.4 | 72.8 | 100 |
  | club-2026 | 0.25 (6.6) | 92.0 | 94.8 | 100 |
  | club-full | 24.25 (103.3) | 89.3 | 98.9 | 100 |
  | club-full | 22.25 (78.9) | 93.7 | 100 | 100 |
  | club-full | 1.25 (10.3) | 84.6 | 100 | 100 |
  | club-full | 19.75 (35.8) | 57.1 | 100 | 100 |
  | crop-a | 0.25 (18.3) | 100 | 100 | 100 |
  | crop-b | 24.75 (17.9) | 99.3 | 100 | 100 |

  Against §3.9 (H2's map-only levels, per component: club-2026 85.5 /
  64.8 / 61.5 / 56.5 %, club-full 35.8 / 46.6 / 70.3 / 71.4 %) the DEM's
  levels reach the target wherever they are snapped; the off-residue
  length across ladders is the other contour ladder's index contours
  (66 mm, 54 mm, 91 mm, 21 mm of club-2026's four phases).
- §6.6's starting constants are kept: the vote met the target as first
  specified, so no variant (smaller fixed windows, a graph neighbourhood,
  smoothing of the cell field) was needed.
- Time on the largest map (club-full, 5617 chains): `anchorLevels` 0.9 s
  after loading (the 1 m grid and import take 10 s, outside H9).

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
| `terrain/solve/__tests__/solve.test.ts` | slope propagation and roots, evidence both ways by weight, the external side first, over a tick (disagreement reported) and over closure, band-upper flagged and inherited, heuristics off, band-drain, closed-hill, cliff-borne pairs and two-level bands, determinism and no mutation, report shares, leaky-signed (§3.2–3.4, 3.6, 3.8) |
| `terrain/solve/__tests__/index-repair.test.ts` | a cliff hiding two contours recovered from the index contours (step 2, source `index`), the zero default without repair or without an index contour above; an undecided chain decided by the index contours; a proposal undone by its trial; a flipped flagged group corrected, a strictly decided nest left alone (§3.5) |
| `terrain/solve/__tests__/fixtures.ts` | the graph fixture with chain lookup, ticks, arcs |
| `.local/h2/{truth,measure,ladders}.mts` (not committed) | the corpus run against Lantmäteriet's 1 m model (§3.9) |
| `terrain/anchor/__tests__/sample.test.ts` | quantiles, median and half-IQR on a cone and a plane, 2 m spacing at two scales, coverage and no data, a closed chain's closing segment, the box stencil and NaN in it (§6.2–6.3) |
| `terrain/anchor/__tests__/side.test.ts` | hill and pit sides, the 0.4 m and 65 % thresholds, an uncovered chain, the coarse grade's ±20 m and 0.5 m (§6.3) |
| `terrain/anchor/__tests__/interval.test.ts` | R at I and I/2 for one and two ladders, phase, weights, noise, circular deviation (§6.5) |
| `terrain/anchor/__tests__/ladder.test.ts` | candidates (one, two, the wrap, under 4 %, noise), the vote per hill and at a border, own evidence removed, the growing window and an unlabelled chain, continuous levels at the wrap, determinism (§6.6–6.7) |
| `terrain/anchor/__tests__/anchor.test.ts` | through H1's graph: a shifted ladder snapped, the external side, noise, spread-failed and uncovered chains, two ladders per area, the residue split, coarse promoted and not, no ladder, a suspect interval, determinism (§6.4, §6.7, §6.9) |
| `terrain/anchor/__tests__/resolve.test.ts` | DEM heights kept, a spread-failed chain from its neighbours, bounded, the 3-band search, the component offset, no height, the drift report, the coarse offset and drift bound, determinism (§6.8) |
| `terrain/anchor/__tests__/anchor-solve.test.ts` | with §3's `solveTerrain`: a wrong tick against the DEM — the DEM side decides, the disagreement counted; `anchoredHeights` on a real solution (§3.0 answer 1, §6.3, §6.8) |
| `terrain/anchor/__tests__/synthetic-dem.ts` | analytic DEMs (cone, pit, plane), rings, a seeded generator |
| `.local/h9/anchor.mts`, `side.mts` (not committed) | T2's corpus aggregates and side reproduced, the §6.0 answer 3 target, §3.0's index target per index phase (§6.10) |

## Pending in this chapter

- §3: bands that span two levels are only demoted in the level forest,
  not split; splitting them (H1's raster) is what would lift the levels
  further (§3.0, 4). No row yet.
- §3: 10 §2.1's depressions, spot heights and text labels are not
  evidence (the split's order leaves them out).
- §4–5 The height field: interpolation, format, sampling, `deriveTerrain` (H3).
- §6: per-chain anchored heights into the height field (H3 / H10).
- §7 DEM providers, the paper → projected sampler (H10).
- Storage of the derived artifact is `map-storage.md` (H4).
