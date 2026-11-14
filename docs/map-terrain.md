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

## 4. The surface

`buildHeightField(graph, levels, opts?)` (`terrain/field/`, H3) turns the
band graph (§2) and the solve's levels (§3) into a height per cell.

### 4.0 Decided with the user (2026-11-14)

1. **Height unit: 1/64 of a contour interval** (7.8 cm at 5 m, range
   ±512 intervals), not the 1/8 interval of the slice H split: 0.625 m
   steps terrace a gentle slope on 3 m cells and band the hill shading.
   The header carries the scale in metres (`zScaleM`), so no reader
   assumes it.
2. **An anchored field is a re-derived field with absolute cells**, not a
   relative field plus an offset. The header carries `zOffsetM` and
   `datum: "relative" | "absolute"`; with H9's per-chain DEM heights
   (T2 answer 12) the interpolation is run again from those heights and
   written as its own field (§4.9). Per-chain heights never enter the
   format.
3. **Cell budget**: the field cell is 0.2 mm where it fits; it grows by
   whole multiples of the graph cell to stay within **4 M cells and 4096
   cells per side** (a phone's texture limit). Interpolation still runs
   on the graph raster (0.1 mm by default).

### 4.1 Method and input

The surface is the raster alternative of 10 §2.2 in T1's band form: inside
each region (a band between chains, §2.5) a cell's height lies between
the band's lower and upper chains, weighted by its **geodesic distance**
to each inside the region. It is the surface T1 drew and the user
accepted (answer 2), with T1's formulas and constants; 10 §2.2's TIN with
medial-axis points is not built.

The input is the graph (§2) and the solve's levels, read through
`FieldLevels`, a structural subset of §3's solution:

```ts
interface FieldLevels {
  regionLevel: Int32Array;  // per region: floor in intervals, 0 the lowest of its connected set
  regionWeak: Uint8Array;   // per region: reached only through a zero-step weak link
  side: Int8Array;          // per chain: +1 uphill left, −1 right, 0 undecided
  flagged: Uint8Array;      // per chain: decided by a flagged heuristic
  conflict: Float32Array;   // per chain: share of samples contradicting the levels
}
```

Heights are in intervals until §4.8. The work runs on the graph raster
(§2.4: 0.1 mm by default), so the field covers the raster's extent: the
contour pieces' box padded by 2 mm.

### 4.2 Sources

A region's **floor** is `regionLevel`; the region spans floor to
floor + 1. Each chain is walked at one cell length and probed left and
right as in §2.6 (first region cell within 1–3 cells along the normal,
skipping the chain's own cells). With `d = floor(left) − floor(right)`
(the chain's `side` when a side is unseen; 0 for a leaky chain):

| Cell | Kind | Height |
|---|---|---|
| on the high side (`d ≠ 0`) | LOW: the region's lower bound | its floor |
| on the low side (`d ≠ 0`) | UP: the region's upper bound | its floor + 1 |
| either side when `d = 0` | FORM | its floor + ½ |

A multi-step chain (§3) therefore carries its whole drop in its own
cells; a cliff link needs no sources, since the floors on its two sides
already differ by the link's step. Every form-line chain (§2.1) seeds
FORM in each region cell it crosses: a form line lies half an interval
above the contour below (10 §2.1 step 4), closed or not, ticked or not.

### 4.3 Geodesic distance

`geodesicDistance(raster, seeds)`: one pass per kind, from all its seeds
at once, 8-connected and confined to the seed's region
(`labels[j] = labels[i]`), steps 2 orthogonal and 3 diagonal (half-cell
units), as `Uint16` saturating at 65 535 (unreachable; 3.3 m on paper at
0.1 mm). Dial's algorithm on four typed-array buckets, in cell order.

### 4.4 Height in a band

With `w = 1 / (d + 1)` per kind (0 when unreachable), where at least two
kinds reach a cell and one of them is LOW or UP:

```
frac = (w_up + ½ · w_form) / (w_low + w_up + w_form)
height = floor + frac
```

Between a lower and an upper chain with no form line this is close to
linear in distance.

### 4.5 Tops, pits and empty regions

| Region reaches | `frac` | Shape |
|---|---|---|
| LOW only (a top, or the uphill band at the frame) | `½ · min(1, R / 20 m) · d_low / d_max` | a dome up to half an interval |
| UP only (a pit, or the lowest band) | `1 − ½ · min(1, R / 20 m) · d_up / d_max` | a bowl down to half an interval |
| FORM only, or nothing | ½ | flat |

`d_max` is the region's largest distance of that kind and `R` that
distance on the ground. Knolls and depressions (point symbols) are not
read.

### 4.6 Field grid, resampling, smoothing

The field cell is `k` graph cells, `k` the smallest integer with
`k · cellMm ≥ 0.2 mm` such that the field has at most 4 M cells and at
most 4096 per side (§4.0 answer 3); the field grid starts at the
raster's corner `(x0, y0)` and has `⌈width / k⌉ × ⌈height / k⌉` cells.

1. A field cell is **no-data** when more than half its graph cells lie
   outside the mapped area (label −1).
2. Its height is the mean of its region cells; barrier cells (chains,
   cliffs) are holes.
3. Two passes of a normalised box blur of radius
   `max(1, round(4 m / field cell on the ground))` average over data
   cells only, filling holes; no-data cells stay out of it.
4. A hole still empty after the blur takes the mean of its data
   neighbours, outwards (0 where nothing reaches).

T1 blurred the 0.1 mm raster; the field blurs after resampling, at the
same ground radius, for a fraction of the memory.

### 4.7 Confidence

A region is **confident** when it is not weak, it has LOW or UP sources,
and at least half of those seed samples come from **good** chains:
decided (`side ≠ 0`), not flagged, not leaky, conflict ≤ 0.5. A field
cell's bit is set when more of its region cells lie in confident regions
than not (clear on a tie, and with no region cells).

### 4.8 Quantisation

`z = round(height · 64)`, clamped to ±32 767; −32 768 is no-data. Height
0 is the floor of the lowest region of each connected set (§3); sets no
chain joins float independently. `datum` is `relative`, `zOffsetM` 0.

### 4.9 With a DEM anchor (H9, pending)

Sources then carry each anchored chain's height instead of floor or
floor + 1; the passes and weights are the same, and the field is written
with `datum: "absolute"` and its own `source` (§4.0 answer 2). Not built
in H3.

## 5. The height field

### 5.1 `HeightField`

```ts
interface HeightFieldHeader {
  version: number;          // TERRAIN_VERSION (1), bumped when §1–5 change the field a document derives
  source: "contours";       // H10 adds DEM sources
  cellMm: number; x0: number; y0: number; width: number; height: number;  // §2's Grid, y up
  groundMPerMm: number;
  intervalM: number;        // 5, or 2.5 for ISSprOM (answer 8)
  zScaleM: number;          // metres per unit: intervalM / 64
  zOffsetM: number;         // metres = z · zScaleM + zOffsetM
  datum: "relative" | "absolute";
  zMin: number; zMax: number; // over data cells; both 0 without data
}
interface HeightField { header: HeightFieldHeader; z: Int16Array; confident: Uint8Array }
```

Values sit at cell centres, row-major from the lower-left. `confident`
is bit-packed, `⌈width · height / 8⌉` bytes, cell `i` at bit `i % 8` of
byte `i >> 3` (`isConfident`): a separate plane, so the int16 grid
uploads to the GPU as it is.

### 5.2 Bytes

`encodeHeightField(field)` / `decodeHeightField(bytes)`, little-endian:

| Offset | Content |
|---|---|
| 0 | magic `OXHF` |
| 4 | u32 container version, 1 |
| 8 | u32 header byte length `n` (a multiple of 4) |
| 12 | the header as UTF-8 JSON, zero-padded to `n` |
| 12 + n | `width · height` int16 |
| then | the confidence plane |

The length must match exactly. Decoding throws `HeightFieldFormatError`
on a bad magic, an unknown container version, a header the schema
rejects, or a length that does not match; encoding throws when the planes
do not match the header. No compression: the transport's (H4). The same
field gives the same bytes.

### 5.3 Sampling

`sampleHeight(field, { x, y })` → metres or `null`: bilinear over the
four nearest cell centres, clamped at the outer centres; `null` outside
the grid or when the containing cell is no-data; no-data neighbours are
dropped and the remaining weights renormalised.
`sampleConfident(field, p)` reads the containing cell's bit (false
outside).

### 5.4 Normals

`heightNormals(field, exaggeration = 1)` → `Int8Array`, three snorm8 per
cell (x right, y up, z up): central differences in ground metres
(`cellMm · groundMPerMm`), one-sided beside no-data and at the edge, a
zero slope on an axis with no data neighbour; (0, 0, 127) in no-data
cells. Computed on demand, not stored.

### 5.5 `deriveTerrain(doc)` (pending: after H2)

H1 → H2 → §4 with the budgets above; `null` without contours, else the
field and the solve's report. The interval is 2.5 m when the document's
library is ISSprOM, else 5 m.

### 5.6 Measured on the corpus (pending: after H2)


## Tests

| Test | Covers |
|---|---|
| `terrain/graph/__tests__/inputs.test.ts` | classification by canonical id in any match state, hidden skipped, tagged / untagged cliff and tag side, tick angle (§1.1–1.3) |
| `terrain/graph/__tests__/flatten.test.ts` | Bézier chords, hole rings, malformed control run (§1.4) |
| `terrain/graph/__tests__/chains.test.ts` | snap join, continuation rule, tie by end order, no short self-closing, three ends at a cliff, gap bridged in ground metres at two scales, the three look-at cones, merge and cliff ends not bridged, short chains dropped, a dangling end, a chain cut by the frame (§2.1–2.2) |
| `terrain/graph/__tests__/raster.test.ts` | mask (closing, the 5.5 mm grid), nested rings → regions, frame ends close a band, near-miss ends `extended` onto a chain and a cliff, chains over cliffs, cell budget (§2.3–2.5) |
| `terrain/graph/__tests__/graph.test.ts` | incidence on nested rings, a leaky chain, cliff links, determinism, no contours (§2.6–2.7) |
| `terrain/graph/__tests__/synthetic.ts` | the fixture: ISOM symbols with canonical matches and library definitions, geometry in mm, a mapped area around the contours |
| `terrain/field/__tests__/codec.test.ts` | round trip, magic and layout, determinism, unaligned input, bad magic / version / length, planes against the header (§5.2) |
| `terrain/field/__tests__/sample.test.ts` | bilinear exact on a plane, clamping, offset, null outside and in no-data, renormalising at a no-data border, confidence (§5.3) |
| `terrain/field/__tests__/normals.test.ts` | a plane's analytic normal, exaggeration, flat and no-data cells, one-sided beside no-data (§5.4) |
| `terrain/field/__tests__/interpolate.test.ts` | sources by side, geodesic distance inside a region; a slope and a cone within 0.1 interval, a top and a pit, a form line at ½, a multi-step drop, a chain level on both sides, no-data, confidence, determinism; the field grid and its budget (§4) |
| `terrain/field/__tests__/levels.ts` | hand-written levels standing in for §3 |
| `.local/h1/counts.mts` (not committed) | T1's corpus counts reproduced (§2.8) |

## Pending in this chapter

- §3 The solve: evidence, uphill side, levels, `TerrainReport` (H2).
- §5.5 `deriveTerrain` and §5.6 the corpus measurements (H3, after H2).
- §6 The DEM anchor (H9); §7 DEM providers (H10).
- Storage of the derived artifact is `map-storage.md` (H4).
