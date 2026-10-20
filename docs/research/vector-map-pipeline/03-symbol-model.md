# 03 — Symbol model

Status: decided 2026-10-07 (recommendation §9, with the light-map-editing
scope note in §1 added at decision time).
Depends on: [02](02-document-format.md) (three symbol layers, source symbol
table, colour table). Feeds: 04 (GL renderer — the IR defined here is its
input), 05 (print — CMYK palette and colour order), 06 (import — matching
and review), 08 (course editor — course-setting symbols 7xx).

## The question

Oxygen needs to draw orienteering maps from vector data and draw the course
overprint on top of them, identically on screen and in print. Three things
have to be decided about symbols for that to work:

1. **What is the rendering model** — the vocabulary of primitives
   (strokes, dashes, repeated glyphs, hatches, patterns, text) that one
   renderer must implement so that every object in an OCAD or OpenOrienteering
   Mapper (OMAP) file, and every IOF-specified symbol, can be drawn.
2. **What is the canonical library** — Oxygen's own machine-readable
   edition of the IOF symbol specifications (ISOM 2017-2, ISSprOM 2019-2,
   later ISMTBOM/ISSkiOM) with exact dimensions, colours and the
   upper/lower purple assignment, and how it relates to what a map file
   actually contains.
3. **How a source symbol is matched to a canonical one**, when matching is
   allowed to change what is drawn, how the user reviews it, and what
   happens when nothing matches.

The IOF specifications are the primary source. Prior art is examined for how
practical software has modelled the same problem (OCAD's own file model,
OpenOrienteering Mapper, Purple Pen's MapModel, `ocad2geojson`). Real maps
from the measurement corpus (README) are used to check assumptions about
what symbol tables look like in the wild.

## 1. Requirements, by consumer

| Consumer | Needs from the symbol model |
|----------|----------------------------|
| GL renderer (04) | One closed set of primitives with fully specified semantics (dash layout, glyph placement, pattern origin, hatch angle, clipping, caps/joins, minimum counts). Everything the renderer draws — matched or unmatched — must reduce to this set. Colour references resolve to a position in one draw-order stack. |
| Print / PDF (05) | The same primitives, plus CMYK per colour, the IOF colour order, spot-colour/overprint hints, and spec-exact dimensions for the overprint symbols at the print scale. |
| Import (06) | A normalisation of OCAD and OMAP symbol definitions into the IR; a matcher that proposes canonical symbols with confidence and reasons; a review UI contract; stable persistence of decisions in the document. |
| Course editor (08) | Course-setting symbols 701–715 as library entries per specification (dimensions differ between ISOM and ISSprOM, and so does the purple layer of 704), so one overlay implementation serves both. Colour-stack placement of lower purple without per-map heuristics. |
| Colour stack (today's `map-color-stack.ts`) | A replacement for the name/CMYK classification of "what sits above lower purple": with matched symbols the answer is known per symbol, not guessed per colour. |
| OCAD export (02) | The source symbol table must survive untouched; matching never rewrites it. |
| Light map editing (future, 08) | A palette of symbols the user may draw new objects with (a path, a boulder, a fence, a whiteout), every entry of which is a *source* symbol of the document so a new object is an ordinary object; a deterministic IR → source-symbol conversion for symbols the document lacks. |
| Tests | Every library entry renderable in isolation to a golden image; every corpus map renderable with zero unsupported-primitive warnings. |

Scope note. Oxygen is not a mapping program: the library needs no symbol
*editing* tools, and matching never rewrites the source table. But **light
map editing is an explicit future requirement** (decision log, 2026-10-07):
the small corrections a course setter makes the week before an event —
a new path, a boulder, a fence that has gone, a whiteout. Nothing in this
topic implements it, but the model must not preclude it:

- A new object references a **source symbol** (`symbolIdx`), exactly like
  an imported one, so the renderer, the document format and OCAD export
  need no special case. Drawing with a canonical symbol the document has no
  match for therefore means *materialising* a source symbol from the
  canonical IR definition into the document's source table (the IR covers
  both formats' fields — Appendix C read right-to-left — so IR → OCAD/OMAP
  symbol is a deterministic conversion, with the colours aligned to the
  document's stack by §6.3). The object never points at the library.
- The drawing palette is the document's source table *presented through
  its matches* (so the UI can offer "505 Footpath" even when the source
  calls it `505.1 Stor stig`), plus the canonical entries that can be
  materialised.
- Where edited objects live — a patch layer keyed by document hash, or a
  new document version — is 02 §10 / 08. The symbol model is indifferent.

## 2. Primary sources: the IOF specifications

### 2.1 Documents in force

| Specification | Edition in force | Reference scale | Enlargement rule | Symbols (headings) |
|---|---|---|---|---|
| ISOM 2017-2 | Revision 6, 20 Jan 2024; valid 1 Feb 2024, mandatory 1 Jan 2025 | 1:15 000 | "all lines, symbols and screens shall be enlarged proportionally (for the map scale 1:10 000 this means to 150 %)" (§2.9.1); graphical minimum dimensions scale with it (§2.11.3) | 113 |
| ISSprOM 2019-2 | Revision 6, 1 Feb 2024; same validity | 1:4 000 | "The map scale shall be 1:4 000 … Enlargement to the scale 1:3 000 is always recommended"; course symbols "shall be enlarged proportionally (to 133 % for 1:3 000)" | 104 |
| ISMTBOM 2022 | 2022 | 1:15 000 base; symbol set ×1.2 at 1:12 500, ×1.5 at 1:10 000/1:7 500/1:5 000 | — | not inventoried here |
| ISSkiOM 2019 | 2019 | 1:15 000 base; symbol set and course symbols scale differently per scale | — | not inventoried here |
| IOF Map Specifications — Printing and Colour Definitions | Revision 4, Sep 2024; valid 1 Dec 2024 (supersedes Feb 2022 edition, previously "ISOM 2017 Appendix 1") | — | — | colour table + colour order |

All are published by the IOF Map Commission at
<https://orienteering.sport/iof/mapping/> under CC BY-ND 4.0. ISOM 2030 is
under revision (no draft dimensions published); ISInOM (indoor) is a
pre-print. Both are out of scope but the library must be versioned so a new
edition is a new library id, not an in-place change.

Both ISOM and ISSprOM (Rev 6) added a chapter **"3.8 Precise definition of
symbols"**: 10× drawings with every dimension of the point symbols and
tagged lines (104, 105.2, 107, 111, 112/303, 115, 201, 202, 203, 207, 208,
311–313, 417, 419, 516, 518, 524–529, …). Together with the per-symbol
drawings this is enough to author the library without consulting any
vendor's symbol set. Dimensions are stated in mm at the reference scale,
with the conventions OM (outside measure), IM (inside measure), CC (centre
to centre), and an arrow where a symbol is orientated to north.

Automatic extraction of the dimensions from the PDFs is not reliable
(`pdftotext -layout` scatters the dimension labels of each drawing; see
`.local` notes). The library is therefore authored by hand from the
drawings and checked by tests against a hand-typed table, not generated.

### 2.2 Symbol inventory

Counted from the Rev 6 texts (full list in Appendix A). "Type" is the
spec's P/L/A/T classification; several symbols have two drawings/types.

| Spec | Total | Point | Line | Area | Text | Mixed (L,P / L,T / P,T) |
|------|------:|------:|-----:|-----:|-----:|--------------------------|
| ISOM 2017-2 r6 | 113 | 32 | 42 | 33 | 1 (704) | 102 (L,T), 510/511/512 (L,P), 603 (P,T) |
| ISSprOM 2019-2 r6 | 104 | 31 | 38 | 34 | 1 (704) | 102 (L,T) |

Observations that shape the library:

- The spec's numbering already has **sub-numbers** (105.1/105.2, 203.1/203.2,
  501.1–501.3, 509.1/509.2, 512.1–512.3, 513.1/513.2, 710.1/710.2). These are
  distinct symbols, not variants.
- Many single headings describe **several drawable variants**: 302 with
  solid or dashed outline or none; 201/202 with or without tags; 509 railway
  with its white infill; 520 as solid olive or vertical stripes; 404 with
  white or green dots; 508 with yellow/white/green background; 704 with
  optional white outline (ISSprOM). The library needs one entry per
  *drawable* variant, so ~113 headings become roughly 180–220 entries per
  spec. OpenOrienteering Mapper's ISOM set has 191 top-level symbols (82 of
  them sub-numbered) for the same spec, its ISSprOM set 185 (96
  sub-numbered); that is a fair estimate of the authoring volume.
- Several symbols are **composites** the spec describes as one: 412
  cultivated land = yellow fill + black dot pattern; 509 railway = black
  double line + white gaps + black dashes; 302 = blue 50 % area + outline.
  OMAP models them as "combined symbols"; OCAD models them as a single
  symbol with fill + hatch/structure + border. The IR must allow one symbol
  to produce several draw passes in different colours (§6.2).
- The same number can mean **different geometry per spec**: 101 contour is
  0.14 mm in ISOM and 0.21 mm in ISSprOM; 703 circle Ø 5.0 mm vs Ø 6.0 mm;
  201 is 0.35 mm vs 0.50 mm. Library ids must be qualified by spec
  (`ISOM2017-2:101`, `ISSprOM2019-2:101`).
- Numbers also **change meaning across editions**: 527 is Fodder rack in
  ISOM 2017 and was Settlement in ISOM 2000; 411 Vegetation impassable was
  removed in ISOM 2017-2 but exists in ISSprOM 2019-2; 203 (ISOM 2000 rocky
  pit) became 203.1. The corpus confirms this matters (§5).

### 2.3 Colours

The 2024 revision of *Printing and Colour Definitions* removed the separate
"CMYK colour definition" chapter and made the colour-order table the single
definition. The table (Appendix B) lists 42 colours in draw order with CMYK
and per-spec applicability. Changes versus the 2022 edition that affect
Oxygen:

| Colour | 2022 | Rev 4 (2024) |
|---|---|---|
| Brown 100 % | 0/56/100/18 (PMS 471) | **25/75/100/0** |
| Brown 50 % (road infill, paved area) | 0/28/50/9 | **10/35/50/0** |
| Brown 30 % | 0/17/30/5 | **6/23/33/0** |
| Green 100 % | 76/0/91/0 | **80/0/100/0** |
| Green 60 % | 46/0/55/0 | **48/0/60/0** |
| Green 30 % | 24/0/27/0 | **24/0/30/0** |
| Black area screen (214 bare rock) | 30 % | **35 %** (ISOM/ISSprOM Rev 6 change log: "Change of colour: black 30 % → 35 %") |
| Olive (520) | "Yellow 100 % + Green 50 %" 38/27/100/0 | same values, renamed "Olive green" |
| New | — | Orange for Ski-O 0/60/100/0; "Dark green for hedges in forest" (ISOM) separated from "Dark green line symbols" (ISSprOM) |

Unchanged: Black 0/0/0/100, Blue 100/0/0/0, Yellow 0/27/79/0,
Purple 35/85/0/0, Purple 50 % 18/43/0/0, Dark green 100/0/80/30.

Consequences:

- Oxygen's current purple `#a626ff` is an sRGB rendering of 35/85/0/0 and
  stays. But the *canonical palette* must be versioned by the colour
  document edition, because a club map imported in 2023 (brown 0/56/100/18)
  and one from 2025 (25/75/100/0) are both "correct" and should not be
  silently normalised to one value — the palette the document was authored
  against is recorded; the renderer may offer "render with IOF 2024 colours"
  as an explicit option.
- Every map in the corpus has 42–154 colours (Appendix C of 02 and §5
  below), far more than the 42 IOF colours, because mappers add intermediate
  screens, "below X" helper colours and club-specific colours. The canonical
  palette is a *target* for matched symbols, never a constraint on the
  source table.
- RGB is derived from CMYK by one fixed conversion shared by the GL
  renderer and the PDF *preview* (the PDF itself writes DeviceCMYK, topic
  05). The naive `rgb = (1-c)(1-k)` conversion that `ocad2geojson` and OCAD
  use on screen is adequate and, more importantly, what users are used to
  seeing; an ICC transform is a 05 option, not part of the model.

### 2.4 Colour order and upper/lower purple

The spec's answer to overprint on digital printers is *ordering*, not
blending: "lower purple" is placed below black 100 %, brown 100 % line/point
and blue 100 % line/point colours (ISOM), so those features knock the course
out; "upper purple" sits above everything. Which course symbol goes where
is stated per symbol and **differs between specs**:

| Symbol | ISOM 2017-2 r6 | ISSprOM 2019-2 r6 |
|---|---|---|
| 701 Start | lower | lower |
| 702 Map issue point | upper | upper |
| 703 Control point | lower | lower |
| 704 Control number | **lower** | **upper** (optional white outline 0.1–0.15 mm) |
| 705 Course line | lower | lower |
| 706 Finish | lower | lower |
| 707 Marked route | upper | upper |
| 708 Out-of-bounds boundary | lower | lower |
| 709 Out-of-bounds area | upper | upper |
| 710 Crossing point | lower (710 is a line symbol in ISOM) | 710.1 point: lower; 710.2 crossing section (line): upper |
| 711 Out-of-bounds route | upper | — (not in ISSprOM) |
| 712 First aid post | lower | — |
| 713 Refreshment point | lower | — |
| 714 Temporary construction or closed area | — | upper (purple outline + purple 50 % fill) |
| 715 Continuing point after map exchange | lower | lower |

What sits *above* lower purple also differs per spec (Appendix B): in ISOM
it is black 100 %, blue 100 % point and line, brown 100 % point and line,
green 100 % point, dark green hedges, white for railway; in ISSprOM only
black 100 %, green 100 % point, white for railway and purple 50 %. Brown and
blue line/point colours are *below* lower purple in ISSprOM. This is
exactly the per-profile table `map-color-stack.ts` encodes today by
classifying colour names; with a canonical library the classification is a
property of the matched symbol's colour, not a regex on the colour name.

OpenOrienteering Mapper's symbol sets implement this with two purples
("Purple for course overprint" at priority 0 and "Purple for track symbols"
below black/green/blue/brown 100 %), and assign 701/703/705/706/708/710 to
the lower one. Purple Pen 3.5 (2025) added a "Layer" option that inserts
lower-purple features between the map's colour layers; Condes documents the
same split (and notes the trade-off: no overprint effect for map colours).
OCAD uses PDF blend modes instead. All four agree that for digital output
the course symbols must be *split* into two layers; Oxygen already does
(`docs/map-color-stack.md`), and the library makes the split data-driven.

### 2.5 Licence

The specifications are CC BY-ND 4.0. Implementing a specification is not
making a derivative of the document; Oxygen's library is an independent
work that *conforms to* ISOM/ISSprOM and must credit the IOF Map Commission
as the source of the dimensions. The PDFs, their drawings and the text are
not redistributed in the repository. Vendor symbol sets (OCAD AG's `.ocd`
templates; OpenOrienteering Mapper's GPL-3.0 `.omap` sets) are *not* copied
into the library either — they are consulted as a cross-check during
authoring (see open question in §10 on using the OOM sets as a test
oracle).

## 3. How the source formats define symbols

### 3.1 OCAD (what `ocad2geojson` exposes)

Symbol numbers are stored ×1000 (`505001` = 505.001); sub-numbers are
free-form and heavily used (§5). Status: normal / protected / hidden. Four
symbol types with the following fields (names as in the reader):

| Type | Fields | Element primitives |
|---|---|---|
| Point | `elements[]` | element `type` 1 line, 2 area, 3 circle, 4 dot; `color`, `lineWidth`, `diameter`, `coords[]` in 1/100 mm relative to the symbol origin, with the same per-coordinate flag byte as objects (Bézier, holes) |
| Line | `lineColor`, `lineWidth`, `lineStyle` (0 bevel joins + flat caps, 1 round + round, 4 miter + flat; bit 2 = pointed ends), `distFromStart`, `distToEnd`, dash model `mainLength`, `endLength`, `mainGap`, `secGap`, `endGap`, `minSym`; repeated primary symbol `nPrimSym`, `primSymDist`; `doubleLine` (`dblMode` 0/1/2, `dblFlags`, fill/left/right colours and widths, `dblLength`/`dblGap` for dashed borders, `dblBackgroundColor`); `decrease` (`decMode` 0 none / 1 to end / 2 both ends, `decLast`, OCAD 12: `decSymbolSize/Distance/Width`); framing `frColor`, `frWidth`, `frStyle`; element lists `primSymElements`, `secSymElements`, `cornerSymElements`, `startSymElements`, `endSymElements`, each a point-symbol-like element list; `useSymbolFlags` |
| Area | `fillOn`, `fillColor`; hatch `hatchMode` 0/1/2 (single/cross), `hatchColor`, `hatchLineWidth`, `hatchDist`, `hatchAngle1/2`; structure `structMode` 0/1 aligned/2 shifted rows, `structWidth`, `structHeight`, `structAngle`, OCAD 12 irregular `structIrregularVarX/Y`, `structIrregularMinDist`, `structDrawingMode` (clip / completely inside / centre inside / partially inside); `borderOn`, `borderSym` → a line symbol; `elements[]` = the pattern glyph |
| Text | `fontName`, `fontColor`, `fontSize` (1/10 pt), `weight`, `italic`, `charSpace`, `wordSpace`, `alignment`, `lineSpace`, `paraSpace`, `indentFirst/Other`, tabs, line-below `lbOn/lbColor/lbWidth/lbDist`, framing `frMode` (0 none, 1 shadow, 2 line, 3 rectangle), `frStyle`, `frColor`, `frWidth`, `frOfX/Y`, `pointSymOn` + element list |

The dash model deserves spelling out because it is the hardest thing to
replicate exactly. OCAD lays out dashes **per section between dash points /
corner points**: a section of length *L* is divided so that it starts and
ends with a dash of `endLength`, interior dashes of `mainLength` are
separated by `mainGap`, the count is chosen so dashes are stretched/shrunk
as little as possible, and `minSym` sets the minimum number of gaps (−1 ⇒
none). `secGap` splits each main dash into two with a small gap (ISOM 507
less-distinct footpath), `endGap` does the same for end dashes. Primary
symbols (fence tags) use the same section layout with `primSymDist` and
`nPrimSym` glyphs per spot; secondary symbols sit at section centres;
corner symbols at corner points; start/end at the ends.

Colour table: parameter string type 9 (number, name, CMYK, overprint flag
`o`, transparency, spot-colour separations); render order is the position
in the string list. OCAD also has a per-colour "overprint" flag used by OCAD
and Purple Pen to emit PDF blend modes.

### 3.2 OpenOrienteering Mapper (`.omap`/`.xmap`, XML)

Five symbol types: `type` 1 point, 2 line, 4 area, 8 text, 16 combined.
Units are **1/1000 mm** (µm) integers; angles in radians. Codes are strings
(`"101"`, `"509.0.1"`), with a `name`, `description` and an icon PNG. Fields
(from `src/core/symbols/*.h`, the symbol-set XML and the manual):

| Type | Fields |
|---|---|
| Point | `inner_radius`, `inner_color`, `outer_width`, `outer_color` (a built-in disc + ring), `rotatable`, `elements[]` where each element is a *nested symbol* (point/line/area) with its own coordinates — so a point symbol's parts are tiny line and area symbols, not a separate primitive type |
| Line | `color`, `line_width`, `minimum_length`, `join_style` (bevel 0 / miter 1 / round 2), `cap_style` (flat 0 / round 1 / square 2 / pointed 3), `start_offset`, `end_offset`, `dashed`, `segment_length`, `end_length`, `show_at_least_one_symbol`, `minimum_mid_symbol_count`, `minimum_mid_symbol_count_when_closed`, `dash_length`, `break_length`, `dashes_in_group`, `in_group_break_length`, `half_outer_dashes`, `mid_symbols_per_spot`, `mid_symbol_distance`, `mid_symbol_placement` (centre of dash / of dash group / of gap), `suppress_dash_symbol_at_ends`, `scale_dash_symbol`, sub-symbols `start_symbol`, `mid_symbol`, `end_symbol`, `dash_symbol` (each a point symbol), `borders` (left/right `color`, `width`, `shift`, optionally dashed with its own `dash_length`/`break_length`) |
| Area | `inner_color`, `min_area`, `rotatable`, `patterns[]` with `type` 1 line hatch (`line_spacing`, `line_offset`, `line_width`, `color`, `angle`) or 2 point grid (`line_spacing`, `line_offset`, `offset_along_line`, `point_distance`, `angle`, nested point symbol), `no_clipping` option (completely inside / centre inside / partially inside), `rotatable` per pattern |
| Text | `font_family`, `font_size` (µm; "how big the letters really are depends on the design of the font"), `bold`, `italic`, `underline`, `line_spacing`, `paragraph_spacing`, `character_spacing`, `kerning`, `icon_text`, framing (`framing_mode`, `framing_line_half_width`, shadow offsets), `line_below` (width, distance), tabs |
| Combined | `parts[]` referencing other symbols (possibly `private` inline ones); e.g. 302 = part 61 (fill) + part 60 (outline), 509 railway = private "inner black dashes" + outer double line |

Colours: `priority` (= draw order), `name`, CMYK floats, `opacity`,
`spotcolors` (named spot colour or components, `knockout` flag), separate
`cmyk method` / `rgb method`. The ISOM set has 35 colours and the ISSprOM
set 32, including deliberate duplicates ("Black below upper brown 50 %",
"Black below lower brown 50 %") that exist only to get the knock-out order
right — a reminder that colour *identity* and colour *value* are different
things in these files.

Cross-reference tables (`.crt`, `SOURCE-TARGET.crt`): plain text, one rule
per line, **target code first**, then a source code or an object query;
more specific rules follow general ones. OOM ships ISOM2000→ISOM 2017-2,
ISOM2017→ISOM 2017-2, ISSOM→ISSprOM 2019, ISOM 2017-2↔ISSprOM 2019, ISOM
2017-2→ISSkiOM 2019 and OSM→* tables. The ISOM 2017-2→ISSprOM table has
164 rules (e.g. ISSprOM `203` ← ISOM `203.1`, `113.2` ← `114`); the
ISOM2000→2017-2 table shows how much renumbering a spec change brings
(`104` earth bank ← ISOM 2000 `106`, `203.1` ← `202`, `412` ← `413`, …).
This is the proven model for *code-based* symbol translation and the
format Oxygen should accept for user-supplied mappings.

### 3.3 Differences that matter for a common model

| Concern | OCAD | OMAP | Consequence for the IR |
|---|---|---|---|
| Units | 1/100 mm | 1/1000 mm | Use µm integers in the IR: exact for both (OCAD ×10). |
| Point symbol parts | 4 primitive kinds (line, area, circle, dot) | nested symbols (line/area/point) | IR glyph parts: `stroke`, `fill`, `ring`, `disc` — OMAP nested lines/areas reduce to `stroke`/`fill`, inner/outer radius to `disc`/`ring`. Purple Pen's `GlyphPartKind { Line, Area, Circle, FilledCircle }` is the same reduction. |
| Dash layout | per section, `mainLength/endLength/mainGap/secGap/endGap/minSym` | `dash_length/break_length/dashes_in_group/in_group_break_length/half_outer_dashes/show_at_least_one_symbol` | Both are "adaptive dashes between dash points" but the fitting rule differs. Purple Pen reconciles them in one `DashInfo` with a `SpacingMethod { OCAD, OpenMapperDashes, OpenMapperMidSymbols }`. The IR keeps a union struct and a `layout` tag so each file renders like its editor showed it. |
| Repeated glyphs | primary (spaced, `n` per spot), secondary (section centre), corner, start, end; `decrease` tapering | mid symbols with placement centre-of-dash / dash-group / gap, `mid_symbols_per_spot`, dash symbol at dash points, start/end | IR `glyphs[]` each with a `placement` enum: `start`, `end`, `corners`, `dashPoints`, `dashCentres`, `gapCentres`, `spaced` (+ distance, count per spot, spacing, min count, decrease). Purple Pen's `GlyphLocation` enumerates exactly this union and has shipped for 15 years against both formats. |
| Double lines | one struct (fill + left + right, dashed borders, `dblMode`) | `borders` left/right with shift and width, the main line is the fill | IR: main stroke + optional `borders {left, right}` each `{colour, width, shift, dash?}`; OCAD `dblMode 2` (filled, no separate borders) is a wide stroke. |
| Area pattern clipping | `structDrawingMode` (OCAD 12) | `no_clipping` 1/2/3 | Same three alternatives to clipping (completely / centre / partially inside) → one enum. |
| Hatch | one or two directions in one struct | one pattern per direction | IR `hatches[]`. |
| Composites | fill + hatch + structure + border in one symbol | combined symbol of parts | IR symbol = ordered list of **passes**, each in one colour. An OCAD area yields passes fill/hatch/pattern/border; an OMAP combined symbol yields its parts' passes. The renderer only ever sees passes. |
| Text size | 1/10 pt | µm, nominal | IR `fontSizeUm` + `fontFamily`; 704's "4.0 mm digit height, Arial" ⇒ font size 5.59 mm (Arial digit height ≈ 0.716 em) — OOM encodes 5588 µm. The library stores the spec's *digit height* and derives the em size per font. |
| Framing/halo | line symbol `frColor/frWidth` ("framing"), text framing modes | text framing only | IR `halo {colour, width}` on strokes and text; 704 white outline in ISSprOM uses it. |
| Minimum sizes | `minSym` only | `minimum_length`, `min_area`, minimum mid-symbol counts | Library-level metadata (not needed to draw); keep on the IR for validation tooling later. |

## 4. Prior art

### 4.1 `ocad2geojson` (current dependency)

`ocadToSvg` draws: solid and dashed lines (from `mainLength`/`mainGap`,
approximated with SVG `stroke-dasharray`, i.e. **not** section-fitted),
double lines (`dblMode` 1 and 2), area fill, hatch (`hatchMode` 1/2) and
structure patterns as SVG `<pattern>` (so pattern origin is the SVG
viewport, not the object or the map origin, and clipping is always "clip"),
text as `<text>` with pt→mm font size. Glyphs along lines are expanded at
*conversion* time by `transform-features.js` into separate point features
(primary symbols spaced per section ignoring `nPrimSym` spacing details,
corner, start and end symbols; **no secondary symbols, no decrease, no dash
points**). This is why today's tiles show fence tags and cliff tags but get
dash phase, pattern alignment and several ISOM line symbols subtly wrong
(`docs/map-tile-rendering.md`). The reader (`readOcad`) is complete enough
to be the OCAD *parser* behind the IR; the SVG renderer is not a model to
keep.

### 4.2 Purple Pen `MapModel`

Purple Pen renders OCAD 6–2018 and OMAP natively in C# and prints/PDFs the
result; its `SymDef.cs` is the most complete *unification* of the two
symbol models in open source:

- `LineSymDef` with `DashInfo` (dash/first/last lengths, gap, `minGaps`,
  secondary middle/end gaps, `halfEndDashLengthWhenClosed`, `spacingMethod`),
  `DoubleLineInfo` (fill/left/right colours and widths, each optionally
  dashed), `ShortenInfo` (shorten start/end, `pointyEnds`), and
  `GlyphInfo[]` with `GlyphLocation { Start, End, Corners,
  CornersIgnoreEnds, DashPoints, DashPointsIgnoreEnds, DashCenters,
  GapCenters, Spaced, SpacedOffset, SpacedDecrease }` plus `number`,
  `spacing`, `minimum`, `decreaseLimit`, `decreaseBothEnds`,
  `noScaleAtCorners`.
- `AreaSymDef` with `HatchInfo` (colour, width, spacing, offset, angle,
  `RotateMode { Always, ManualOnly, Never }`), `PatternInfo` (size, angle,
  offsets, `offsetRows`, glyph, `PatternFillMode { Clip, CompletelyInside,
  CenterInside, PartiallyInside }`, irregular variance), fill colour,
  `borderSymdef`.
- `Glyph` = parts of kind `Line | Area | Circle | FilledCircle`.
- `LineComboSymDef` for OMAP combined symbols.

This is the shape the IR in §6.2 takes. Purple Pen is also the reference
for *overprint on digital output*: its 3.5 release adds the per-layer
"lower purple" insertion described in §2.4 and defaults to it when the map's
colour table has a lower purple.

### 4.3 OpenOrienteering Mapper symbol sets and CRTs

Already covered in §3.2. Two further lessons: (a) OOM authored its
spec-conformant sets as **data in the same symbol model** its renderer
consumes — there is no separate "spec library" code path; (b) OOM keeps
spec-driven helper symbols (`509.0.1 Railway helper: inner black dashes`,
`101.1 slope line`, minimum-size variants) as sub-numbered entries, which is
the pattern mappers follow in OCAD too (§5).

### 4.4 Lessons from "library plus fallback" designs

OCAD's *Symbol Set Conversion* and *Update Symbol Set*, OOM's CRT-driven
*Replace symbol set*, and Purple Pen's spec-conformant course symbols drawn
over an arbitrary map all share one architecture: a reference library, a
mapping from the file's symbols to it, and a fallback to the file's own
definitions. Three things recur in their documentation and change logs:

- The mapping is **data the user can see and edit** (OCAD shows "a list of
  changes" after an update; OOM opens the replacement dialog and lets the
  user save the result as a CRT). A silent mapping is not accepted by
  mappers.
- Mappings are **per symbol set, not per map**: OOM ships one CRT per
  (source set, target set) pair and reuses it; OCAD keys its updates on the
  template symbol set the map was created from. Oxygen's corpus (§5) shows
  club maps share one symbol set across many event crops, so decisions
  should be reusable across documents of a club.
- The fallback path must be **as good as the library path**, or it is
  where rendering bugs hide: everything that is not matched is still the
  mapper's content. The design in §6 therefore keeps the canonical library
  in the same IR as the fallback, treats matcher output as a *proposal
  persisted in the document and editable by the user*, and puts the
  per-symbol purple layer and the reference-scale factors in library data
  rather than in renderer code.

## 5. Corpus evidence

Script: `measure-symbols.mjs` (local research dir; results `sym-*.json`).
It classifies each symbol in a map's table against the Rev 6 inventory of
the matching spec, counts objects per class, and compares the line width of
the most-used symbol in a few families with the spec to detect enlargement.

| Map (spec) | Symbols (hidden) | Exact spec code | Sub-numbered | Non-spec | Objects: exact / sub-numbered / non-spec | Colours (IOF-like names) |
|---|---:|---:|---:|---:|---|---:|
| Club-full (ISOM) | 268 (29) | 22 | 194 | 51 | 4.7 % / 94.4 % / 0.8 % | 81 (61) |
| Club-2026 (ISOM) | 240 (17) | 21 | 173 | 45 | 2.0 % / 97.3 % / 0.7 % | 67 (54) |
| Club-old (ISOM) | 224 (2) | 106 | 99 | 18 | 68.7 % / 30.6 % / 0.7 % | 51 (44) |
| Crop-A (ISOM) | 224 (1) | 106 | 103 | 13 | 60.6 % / 39.3 % / 0.1 % | 154 (132) |
| Crop-B (ISOM) | 226 (1) | 106 | 105 | 13 | 62.6 % / 36.8 % / 0.4 % | 122 (110) |
| Sprint (ISSprOM) | 196 (0) | 89 | 99 | 8 | 55.9 % / 44.1 % / 0.0 % | 42 (38) |

Apparent enlargement (width of most-used symbol ÷ spec width): every ISOM
map is at 1.0× for 101/102/103/201/304/505/506/516; the sprint map at 1.0×
for 101/102/103/201/506/515/516. Two outliers are instructive: Club-full's
most-used 503-family symbol is `503.4 "Gång- och cykelväg"` at 0.25 mm
(0.71× of 503 Road's 0.35 mm — it is a *footpath drawn under a road
number*), and the sprint map's 505 is 0.52 mm (1.49× of 0.35 mm — a local
"wide path" variant).

What this says about matching:

1. **Code alone is not enough.** On the two club maps ≥ 94 % of objects use
   sub-numbered symbols whose sub-number carries meaning the spec does not
   define (`202.2 Cliff without tags`, `210.2 Stony ground single dot`,
   `501.4 Paved area boundary`, `520.4 … (area)`); some base codes are
   outright wrong for the spec (`527 Byggnad` — a building drawn under the
   Fodder-rack number, 4 420 objects; `519 Tunnel, större`; `503.4`
   footpaths). A matcher that trusts the number would draw 4 420 buildings
   as fodder racks.
2. **Code is still the best first signal.** On the event crops and the
   older club map, 56–69 % of objects use exact spec codes and the
   sub-numbered rest are mostly spec variants (`202.1 without tags`,
   `103.2 form-line min size`, `501.100 step/edge`) whose base code is
   right. Family-based candidate generation (same base number, then same
   hundred-group) will contain the right answer almost always; geometry
   decides between variants.
3. **Non-spec symbols are mostly text and club conventions**: `8xx` place
   names (`802.2 Vägnamn arial`, `810.5 Gårdsnamn 6`, `821 Bynamn`), `1.x`
   club colour swatches (`SOFT-Vit/Blå/Gul`), `900.1 LAS nummer`. They are
   0–0.8 % of objects and must simply render from their source definition —
   there is nothing to match them to and no reason to.
4. **Hidden symbols** (2–29 per map) are mostly course-setting and
   technical symbols; today's "hide 601.x north lines" filter stays a
   symbol-number rule on the source table (02 §4).
5. **Enlargement detection works** from matched line widths: the median of
   the ratios over the matched line families gives the document's symbol
   scale factor (1.0 for every corpus map); the two outliers are exactly
   the kind of per-symbol mismatch that should lower a *symbol's* match
   confidence rather than the document's factor.
6. **Colour tables are IOF-shaped**: 85–90 % of colour names contain an IOF
   colour word (in English or Swedish), confirming that name-based
   alignment of source colours to the canonical palette will cover most
   colours and CMYK distance the rest.

## 6. The model

### 6.1 Overview

```
 OCAD .ocd ──readOcad──┐                       ┌───────────────────────────┐
                       ├─ normalise ─► Source symbol table (IR) ──┐        │
 OMAP .omap ─reader────┘   (06)        + source colour table      │        │
                                                                  ▼        │
                                         ┌──────────── matcher (06) ◄── Canonical library (IR)
                                         │                 │              ISOM2017-2 @1:15000
                                         │   SymbolMatch[] per source symbol   ISSprOM2019-2 @1:4000
                                         │   (canonicalId | null, confidence,  + canonical palette per
                                         │    method, reasons, reviewed)         colour-doc edition
                                         ▼
                            resolve(symbolIdx) → IR definition + colour ids
                                         │
                       colour alignment: source colours ∪ canonical palette → one ColourStack
                                         │
                                         ▼
                 Renderer (04/05): passes in ColourStack order; knows only the IR
```

Three decisions make this hang together:

- **One IR for everything.** The canonical library is *authored* in the
  same `RenderSymbol` IR that imported OCAD/OMAP symbols are *converted*
  into. The renderer has one input type; "matched" only changes which IR
  definition an object resolves to, and in which colour ids.
- **Matching is a document-level, reviewable mapping**, stored per source
  symbol (02 §4 layer 2), never a rewrite of the source table.
- **Colours are a single ordered stack per document** produced by aligning
  the source table with the canonical palette. Lower/upper purple and
  "what is above lower purple" become positions in that stack.

### 6.2 The `RenderSymbol` IR

Sketched as TypeScript; the Zod schema lives in `@oxygen/shared` and is the
contract between 03/04/05/06. Lengths are **µm at the document's reference
scale** (integers), angles in degrees (float), colours are `ColourRef`
(index into the document's colour stack; canonical entries use palette
ids that the alignment step resolves).

```ts
type ColourRef = number;                 // index into ColourStack

interface GlyphPart {                     // OCAD point-symbol element ≙ OMAP nested symbol ≙ PP GlyphPart
  kind: "stroke" | "fill" | "ring" | "disc";
  colour: ColourRef;
  widthUm?: number;                       // stroke width / ring width
  diameterUm?: number;                    // ring / disc
  cap?: "flat" | "round" | "square" | "pointed";
  join?: "bevel" | "miter" | "round";
  coords?: Coord[];                       // stroke / fill, with Bézier + hole flags; origin = anchor
}

interface Glyph { parts: GlyphPart[]; rotatable: boolean }  // rotatable = follows object angle

type GlyphPlacement =
  | { at: "start" } | { at: "end" }
  | { at: "corners"; ignoreEnds?: boolean }
  | { at: "dashPoints"; ignoreEnds?: boolean }
  | { at: "dashCentres" } | { at: "dashGroupCentres" } | { at: "gapCentres" }
  | { at: "spaced"; distanceUm: number; firstUm?: number; lastUm?: number;
      perSpot?: number; spotSpacingUm?: number; minCount?: number; minCountClosed?: number;
      decrease?: { to: number; bothEnds: boolean } };

interface DashPattern {
  layout: "ocad" | "omap";                // which fitting algorithm (see §6.9)
  dashUm: number; gapUm: number;
  endDashUm?: number;                     // OCAD endLength / OMAP half_outer_dashes
  secondaryGapUm?: number;                // OCAD secGap; OMAP dashes_in_group>1 + in_group_break_length
  dashesInGroup?: number;
  endGapUm?: number;                      // OCAD endGap
  minGaps?: number;                       // OCAD minSym; OMAP show_at_least_one_symbol ⇒ 0/1
}

interface StrokeSpec {
  colour: ColourRef; widthUm: number;
  cap: "flat" | "round" | "square" | "pointed"; join: "bevel" | "miter" | "round";
  dash?: DashPattern;
  shortenStartUm?: number; shortenEndUm?: number;   // OCAD distFromStart/ToEnd, OMAP start/end_offset
  halo?: { colour: ColourRef; widthUm: number };     // OCAD line framing
}

interface LineSymbol {
  type: "line";
  main?: StrokeSpec;                                  // may be absent (borders only, e.g. 502 outlines)
  borders?: { left?: BorderSpec; right?: BorderSpec; backgroundColour?: ColourRef };  // double line
  glyphs?: { glyph: Glyph; placement: GlyphPlacement; scaleAtCorners?: boolean }[];
}
interface BorderSpec { colour: ColourRef; widthUm: number; shiftUm: number; dash?: DashPattern }

interface AreaSymbol {
  type: "area";
  fill?: ColourRef;
  hatches?: { colour: ColourRef; widthUm: number; spacingUm: number; offsetUm: number; angleDeg: number; rotate: "always" | "manual" | "never" }[];
  patterns?: { glyph: Glyph; cellWidthUm: number; cellHeightUm: number; angleDeg: number;
               offsetXUm: number; offsetYUm: number; shiftedRows: boolean;
               clip: "clip" | "completelyInside" | "centreInside" | "partiallyInside";
               rotate: "always" | "manual" | "never";
               irregular?: { varX: number; varY: number; minDistUm: number } }[];
  border?: LineSymbol;                                 // OCAD borderSym / OMAP combined part
}

interface PointSymbol { type: "point"; glyph: Glyph; orientation: "north" | "object" }

interface TextSymbol {
  type: "text";
  fontFamily: string; fontSizeUm: number; weight: number; italic: boolean; underline?: boolean;
  colour: ColourRef; align: "left" | "centre" | "right" | "justify";
  lineSpacing: number; paragraphSpacingUm: number; charSpacing: number; wordSpacing?: number;
  halo?: { colour: ColourRef; widthUm: number };     // ISSprOM 704 white outline, OCAD frMode 2
  box?: { colour: ColourRef; marginUm: number };      // OCAD frMode 3
  lineBelow?: { colour: ColourRef; widthUm: number; distanceUm: number };
}

type RenderSymbol = (PointSymbol | LineSymbol | AreaSymbol | TextSymbol) & {
  id: string;                     // "src:505001" or "ISOM2017-2:505"
  code: string; name: string;     // display
  minimum?: { lengthUm?: number; areaUm2?: number };
};
```

Rendering reduces any `RenderSymbol` to **passes** — `(colour, primitive)`
pairs: a fill polygon, a hatch set, a pattern instance list, a stroke
polyline (after dash layout), a glyph instance list, a text run. The
renderer sorts passes by colour-stack position (04), which is how an
OCAD-style single area symbol and an OMAP-style combined symbol end up
identical on screen.

Coverage check against the sources: every OCAD field in §3.1 and every OMAP
field in §3.2 maps to an IR field (Appendix C), with four exceptions kept as
import warnings rather than IR features: OCAD text `pointSymOn` (a point
glyph attached to a text — not used by any spec symbol), OCAD `frMode 1`
text shadow (render as halo with offset dropped), OMAP `scale_dash_symbol`,
and OCAD 12 irregular patterns (`irregular` is in the IR but the renderer
may draw the regular grid in phase 1 — no ISOM/ISSprOM symbol requires an
irregular pattern; the spec's "dots randomly distributed" for 209–212 are
drawn by mappers as point objects or regular grids in practice, which is
what the corpus shows: `210.2 Stony ground single dot`, 3 794 objects in
Club-full, and one object using an irregular pattern in the whole corpus).

### 6.3 Colour model

```ts
interface ColourEntry {
  id: string;                 // "src:12" (source number) or "iof2024:brown100-line"
  name: string;
  cmyk: [number, number, number, number];   // 0..1
  spot?: { name?: string; knockout?: boolean };
  overprint?: boolean;        // OCAD "o" flag — hint for 05, never for screen
  purpleRole?: "lower" | "upper";
}
type ColourStack = ColourEntry[];   // index = draw order, 0 drawn first
```

The **canonical palette** is Appendix B as data, one palette per edition
(`iof2022`, `iof2024`), each entry tagged with the specs it applies to and
its purple role. The library's symbol definitions reference palette ids.

**Alignment** builds the document's stack from the source table plus the
palette entries actually used by matched symbols:

1. Start from the source table in source order (it is the mapper's
   intended knock-out order; it must win for unmatched symbols).
2. For each source colour, find the palette entry it *is*: by name
   (English/Swedish IOF colour vocabulary, percentage, "line"/"point"/
   "area" qualifiers), confirmed by CMYK distance; else by CMYK distance
   alone within a small tolerance; else none. Record the mapping.
3. For each palette entry used by a matched canonical symbol that no
   source colour mapped to, insert it at the position implied by the
   palette order relative to its already-placed neighbours.
4. Lower purple: if the source has a colour named/placed as lower purple,
   that is the lower purple; otherwise insert `purple-lower` directly below
   the first source colour that the palette classifies as "above lower
   purple" for the document's spec profile. Upper purple goes on top.
5. Validate: every colour referenced by a matched symbol resolves, and the
   relative order of the palette entries used is the palette's order; if
   the source order contradicts the palette for a matched symbol's colour
   (e.g. a club map with brown contours above black buildings), keep the
   source order and flag it in the import report.

This replaces the regex classification in `map-color-stack.ts` for matched
colours and reduces to it for unmatched ones. RGB for screen is derived
with the shared naive conversion (§2.3).

### 6.4 Canonical library

Scope for the first edition:

| Library id | Source | Reference scale | Entries (estimate) |
|---|---|---|---|
| `ISOM2017-2` (r6) | ISOM 2017-2 Rev 6 incl. §3.8 precise definitions, 7xx course symbols | 1:15 000 | 180–200 |
| `ISSprOM2019-2` (r6) | ISSprOM 2019-2 Rev 6 incl. §3.8, 7xx | 1:4 000 | 170–190 |
| `ISMTBOM2022`, `ISSkiOM2019` | later; the colour palette already covers them | 1:15 000 | — |

Entry schema (authored JSON, validated by Zod, one file per symbol family
under `packages/shared/src/symbol-library/<library>/`):

```jsonc
{
  "id": "ISOM2017-2:516",
  "code": "516", "variant": null,                 // variant: "a"… for drawable variants under one heading
  "name": { "en": "Fence", "sv": "Stängsel" },
  "specType": "L",
  "purpleRole": null,                             // "lower" | "upper" for 7xx
  "orientation": null,                            // point symbols: "north" | "object"
  "minimum": { "lengthUm": 1500 },                // graphical minimum dims, from the spec
  "footprintM": 22.5,                             // informational (spec states it)
  "aliases": [ { "library": "ISOM2000", "code": "524" } ],   // numbering in older specs
  "render": { "type": "line", "main": { "colour": "black100", "widthUm": 140, "cap": "flat", "join": "miter" },
              "glyphs": [ { "glyph": { "parts": [ { "kind": "stroke", "colour": "black100", "widthUm": 140,
                                                   "coords": [[0,0],[0,400]] } ], "rotatable": true },
                            "placement": { "at": "spaced", "distanceUm": 2000, "minCount": 1 } } ] },
  "fingerprint": { /* optional overrides, see §6.5 */ },
  "source": "ISOM 2017-2 Rev 6, symbol 516 and §3.8"
}
```

Rules for authoring:

- One entry per *drawable* variant; the heading's entry is the default
  drawing shown in the spec. Variants carry a `variant` letter and a
  description of when they apply (`302.b "dashed outline"`).
- Dimensions come from the spec drawings and §3.8 only. Where the spec
  leaves a detail to the drawing tool (dash fitting rule, pattern origin),
  pick the OCAD behaviour and document it in the entry's `notes`, because
  the majority of source maps were drawn in OCAD and users compare with
  OCAD output.
- Colours reference palette ids, never CMYK values.
- Course symbols 701–715 are entries like any other; the course editor's
  overlay (08) resolves `ISOM2017-2:703` etc. through the same code path,
  with the print-scale factor applied (§6.6). This retires the separate
  constants in `packages/shared/src/course-maps/schema.ts`
  (`defaultMapAppearance`) in favour of the library, with the per-event
  overrides kept as *overrides of* library dimensions.
- Tests: (a) schema validity; (b) every heading in Appendix A has at least
  one entry; (c) a hand-typed table of (code → key dimensions) per spec is
  asserted against the entries; (d) a golden render per entry at 10× into
  a contact sheet for visual review in PRs; (e) spot checks that
  OpenOrienteering Mapper's set agrees on dimensions for a sample (if the
  licence question in §10 is settled in favour).

### 6.5 Matching

Inputs per source symbol: its IR (normalised), its code and description,
the document's spec profile (ISOM/ISSprOM — chosen from scale and colour
table at import, overridable), the document's symbol scale factor (§6.6).

Stages, in order; the first stage that yields a confident result wins, all
stages record their reasons:

1. **Explicit mapping.** A user- or club-supplied CRT (OOM syntax, §3.2)
   or a previous reviewed decision for the same source symbol
   (`code + description + IR hash`) in another document of the same club.
   Confidence 1.0, method `explicit`.
2. **Exact code, geometry agrees.** Source code equals a library code or
   variant code (`505`, `105.1`, `501.1`); the geometry fingerprint of the
   source IR against the canonical IR (scaled by the document factor)
   scores ≥ *T_auto*. Method `code+geometry`.
3. **Family + geometry.** Candidates = all library entries with the same
   base number (then, if none, the same hundred group); best fingerprint
   score ≥ *T_auto* ⇒ auto; ≥ *T_suggest* ⇒ suggestion requiring review.
   Method `family+geometry`. This is the stage that turns `202.2 Cliff
   without tags` into `ISOM2017-2:202.b`.
4. **Geometry only.** All entries of the same IR type; best score ≥
   *T_strict* (higher than T_auto) ⇒ suggestion. Catches `527 Byggnad` →
   `521 Building` (filled black area, no border) and `503.4` → `505`.
   Never auto.
5. **Description only.** Name/description token match (en/sv vocabulary
   from the library names) when geometry is inconclusive ⇒ suggestion
   with low confidence. Never auto.
6. **Unmatched.** Rendered from source IR; shown in the review list with
   the reason (`no candidate`, `colour class mismatch`, `type mismatch`).

Fingerprint: computed *from the IR*, so it is source-neutral and the same
function serves authoring tests. Features and comparison:

| IR type | Features compared | Hard fails (score 0) |
|---|---|---|
| line | main width, main colour class (black/brown/blue/green/yellow/purple/white + %), dash presence and dash/gap lengths, border presence/widths/shift, glyph count, glyph placement kind and spacing, glyph bounding box, halo | type differs; colour class differs; dashed vs solid differs; borders present vs absent |
| area | fill colour class, hatch count/angle/spacing/width, pattern cell size/angle/glyph bbox, border presence | fill class differs; hatch vs pattern vs plain differs |
| point | glyph bounding box, part count by kind, dominant colour class, orientation | colour class differs |
| text | font size (±10 %), weight/italic, colour class | colour class differs |

Each continuous feature contributes a tolerance score (1 within tolerance,
decaying to 0 at 2× the tolerance); the fingerprint score is the product.
Tolerances start at ±0.02 mm for widths, ±0.1 mm for lengths/spacings,
±5° for angles, and are tuned on the corpus: the target is that stages 2–3
auto-match ≥ 95 % of objects on the event crops with zero false positives
on the known traps (`527 Byggnad`, `503.4`, `519 Tunnel`). Initial
thresholds *T_auto* 0.85, *T_suggest* 0.6, *T_strict* 0.95; these are
constants in one place and are reported in the import summary so tuning is
visible.

Output, persisted in the document (02 layer 2):

```ts
interface SymbolMatch {
  sourceIdx: number;
  canonicalId: string | null;          // "ISOM2017-2:202.b"
  method: "explicit" | "code+geometry" | "family+geometry" | "geometry" | "description" | "none";
  confidence: number;                  // 0..1
  reasons: string[];                   // human-readable, shown in review
  reviewed: boolean;                   // user confirmed or changed
  libraryVersion: string;              // which library edition produced it
}
```

Review UI contract (06): list grouped by state (auto-matched / suggested /
unmatched), each row showing the source icon rendered from source IR, the
candidate rendered from the library, object count, confidence and reasons;
actions accept / choose another candidate / keep source; bulk accept for
≥ T_auto; export decisions as a CRT for reuse. A re-match (new library
version) keeps reviewed rows and re-proposes the rest; it produces a new
document version per 02 §7.

What matching is allowed to change: **geometry and colour of the drawn
symbol** (the canonical definition), the colour's position in the stack
(via alignment), and the purple role. It never changes object coordinates,
the source table, hidden status, or text content. A matched symbol whose
canonical colour class differs from its source colour class is a hard
fail by construction, so matching cannot recolour a brown line black.

### 6.6 Scale and enlargement

- Library dimensions are at the library's reference scale (15 000 / 4 000).
- `documentFactor = (referenceScale / mapScale) × symbolScale`, where
  `symbolScale` is the detected enlargement of the source symbols relative
  to a map drawn at reference-scale sizes (§5: 1.0 for every corpus map; a
  1:10 000 map drawn "at 150 %" shows `symbolScale` 1.5 with
  `referenceScale / mapScale` = 1.5 … the two cancel and the drawn size is
  what the file says). Detection: median over matched line families of
  (source width ÷ canonical width), snapped to {1, 1.2, 1.33, 1.5, 2} when
  within 3 %; stored in the document header; overridable.
- Fingerprints compare at `documentFactor`; a symbol that only matches at a
  *different* factor is a per-symbol anomaly, reported as such.
- The course overlay (08) uses `printScale`: ISOM symbols are enlarged by
  `15000 / printScale` (150 % at 1:10 000, as the spec requires); ISSprOM by
  `4000 / printScale`. ISMTBOM/ISSkiOM have their own factor tables
  (OpenOrienteering Mapper's symbol-set README summarises them: ISMTBOM
  ×1.2 at 1:12 500, ×1.5 at 1:10 000 and below; ISSkiOM scales the symbol
  set and course symbols by different factors per scale) — encode as a
  per-library `scaleRules` table rather than a formula.

### 6.7 Purple layer and the colour stack

For a document with matched 7xx symbols or with Oxygen's own overlay, the
course symbols' colour is `purple-lower` or `purple-upper` from the
library entry (§2.4) and the alignment step (§6.3) places those two
colours. "What is above lower purple" is then simply the stack. The current
`colorProfile` (`auto|isom|issprom|isskiom|ismtbom`) survives as the
*spec profile* input to alignment and to the matcher's library choice, and
the current name-regex fallback remains for documents with no matches.

Ink-layer compositing (the raster workaround in `docs/map-color-stack.md`)
becomes unnecessary once the renderer draws passes in stack order — that is
04's job; the model just has to make the order unambiguous, which §6.3
does.

### 6.8 Fallback rendering and feature support

Unmatched symbols render from source IR with source colours. There is no
"degraded" path; the only difference from a matched symbol is which IR
definition is used. The renderer's phase-1 feature list is therefore the
union of what the canonical library uses and what the corpus uses:

| IR feature | Used by library | Used by corpus (`measure-symbols.mjs`) | Phase 1 |
|---|---|---|---|
| Solid strokes, caps/joins | yes | yes | required |
| Adaptive dashes (OCAD layout) incl. secondary gaps | 302 outline, 415, 416, 505–508, 707, 711 | yes | required |
| Adaptive dashes (OMAP layout) | — | OMAP imports only | required for 06 OMAP support, can follow |
| Glyphs spaced / corners / start / end | 201, 202, 509, 516–518, 528, 529, 532 | yes | required |
| Glyphs at dash points / secondary (section-centre) symbols | — | none in the corpus | implement with the dash engine, low priority |
| Decrease (taper) | none (no ISOM/ISSprOM symbol tapers) | none in the corpus | optional, warn |
| Borders (double line) | 502, 509, 512, 529 | yes | required |
| Area fill | yes | yes | required |
| Hatch (1 and 2 directions) | 520 (stripes variant), 709, 714 | yes | required |
| Point-grid patterns, shifted rows, clip modes | 113, 114, 208–213, 402–404, 407, 409, 412–414 | yes | required (clip modes "centre inside" at least) |
| Irregular patterns (OCAD 12) | none | Club-old: 5 symbols, 1 object | draw regular, warn |
| Point glyphs (stroke/fill/ring/disc) | all P symbols | yes | required |
| Text, alignment, spacing | 102, 603, 704, 8xx names | yes | required (formatted text boxes: 04 decides) |
| Text halo / box / line below | 704 (ISSprOM) | Club-full: 9 text symbols with framing, 611 objects (place names); Club-2026 19 objects | halo required, box/line-below optional |
| Line halo (framing) | — | Club-full: all 502 wide-road variants (2 400 objects), Club-old 502 | required (the club sets draw 502 as a double line *plus* a wider "Brown 50 % area feature" framing band in a lower colour position; dropping it visibly changes road edges) |

### 6.9 Semantics that must be pinned in the renderer spec (04)

The IR is only as good as the agreed meaning of each field. 04 must specify
and test, with fixtures per rule:

1. **OCAD dash fitting** per section between dash/corner points: how the
   dash count is chosen, how `endLength`, `mainGap`, `secGap`, `endGap`
   stretch, what `minSym` −1/0/n do, what happens on closed paths, and
   that section boundaries are reset by both corner points and dash
   points (flag bits 4 and 8 in 02 §3).
2. **OMAP dash fitting**: `dashes_in_group`, `half_outer_dashes`,
   `show_at_least_one_symbol`, closed-path behaviour.
3. **Glyph placement**: orientation along the tangent; `rotatable` glyphs
   vs north-up; `perSpot` spreading; `minCount`; corner glyph scaling;
   suppression at ends; "dashPoints ignore ends".
4. **Pattern origin and rotation**: pattern grid anchored at the map origin
   (OCAD) vs the object; per-object pattern angle (`ang` on area objects,
   02 §2.1); the three non-clipping modes.
5. **Hatch**: angle convention (counter-clockwise from +x), offset, and
   that both hatch directions share width/spacing in OCAD but not in OMAP.
6. **Borders**: shift measured from the main line's centre; dashed borders
   share the main dash phase (509 railway) unless given their own pattern.
7. **Holes and winding**: areas use the flag-16 hole convention; fill rule
   non-zero after orientation normalisation (02 §3).
8. **Text metrics**: digit height vs em size per font; baseline/anchor for
   OCAD alignment codes.
9. **Halos are passes in their own colour**, for text and lines alike: the
   ISSprOM 704 white outline is "Upper white for course overprint", one
   position below upper purple in the Rev 4 table, and the corpus's 502
   framing band is a brown-50 % colour far below the road's black edges.
   A halo must therefore be emitted as a stroke pass at *its* colour's
   stack position, never fused with the main pass.
10. **Minimum rendering sizes on screen** (04): hairline floor for strokes
    and glyphs when zoomed out, never applied in print.

## 7. Options considered

| | A. Render source symbols only (no canonical library) | B. Canonical library with separate fallback renderer | C. One IR; canonical library authored in the IR; matching selects the definition (recommended) |
|---|---|---|---|
| Faithfulness to the mapper's file | Highest | Depends on match quality; fallback path tends to lag | Same as A for unmatched; matched symbols become spec-exact (which users of club maps with drifted sizes may notice — review shows it) |
| Consistency across maps / events | None — every club's quirks shipped as-is | High for matched | High for matched, and unmatched are still drawn by the same code |
| Lower/upper purple, "above lower purple" | Keep today's colour-name heuristics forever | Data-driven for matched | Data-driven for matched; heuristics only for unmatched documents |
| Course overlay dimensions | Separate constants (today) | From library | From library, same code path as base map |
| Renderer complexity | Must implement every OCAD/OMAP feature anyway | Two renderers (library primitives + source primitives) or one with two input models | One renderer, one input model, one test suite |
| Authoring effort | None | 350–400 entries + a second primitive vocabulary | 350–400 entries in the IR; authoring tests reuse the renderer |
| OMAP support | Needs OMAP→renderer anyway | Needs OMAP→IR anyway | Needs OMAP→IR anyway |
| Risk | Visual bugs are per-club and never fixed centrally | Fallback path is where the bugs hide (seen in prior art) | Matcher false positives — mitigated by hard fails on colour class/type, thresholds, and review |

A is where Oxygen effectively is today (via SVG). B is the shape a product
drifts into when the library is built first and the fallback second. C
costs the same authoring as B and removes the second code path.

## 8. Effort

- IR + Zod schema + OCAD→IR normaliser on top of `readOcad`: small; the
  field mapping is mechanical (Appendix C).
- Canonical library authoring: ~180–200 entries per spec. Point symbols
  with §3.8 drawings are quick; the ~40 line symbols with glyphs and the
  ~35 area patterns need care. Estimate 4–6 days per spec with the contact
  sheet test as the review tool; ISSprOM second, reusing ISOM entries where
  identical (most 1xx–4xx point symbols differ only in size).
- Matcher + fingerprints + corpus tuning harness: medium; the harness is
  the `measure-symbols.mjs` logic promoted into a test against anonymised
  symbol tables (symbol tables contain no map geometry and can be
  committed as fixtures — to confirm with the clubs, since descriptions
  carry local names).
- Colour alignment: small; it generalises `map-color-stack.ts`.
- Review UI: 06.

## 9. Recommendation

1. **Adopt one `RenderSymbol` IR** (§6.2) in `@oxygen/shared` as the only
   symbol representation the renderer, the print path and the library know.
   Model it on the union of OCAD and OMAP fields with Purple Pen's
   `SymDef` as the reference for the unification (dash union with a
   `layout` tag, glyph placement enum, borders, pattern clip modes, glyph
   parts stroke/fill/ring/disc). Units µm, angles degrees, colours by
   stack index.
2. **Author the canonical library in that IR** from ISOM 2017-2 Rev 6 and
   ISSprOM 2019-2 Rev 6 (incl. §3.8 and the 7xx course symbols), one entry
   per drawable variant, qualified ids (`ISOM2017-2:202.b`), reference
   scale per library, `purpleRole` per entry, aliases to older numbering.
   No vendor symbol set is copied; the IOF is credited. ISMTBOM/ISSkiOM
   later.
3. **Palette as versioned data**: the Rev 4 (2024) colour-order table with
   per-spec applicability and purple roles as `iof2024`; keep `iof2022`
   for documents authored against it. One shared CMYK→RGB conversion.
4. **Alignment builds one colour stack per document** from the source
   table plus palette entries used by matched symbols; source order wins
   on conflict and is reported. Lower/upper purple are stack positions.
   This supersedes the colour-name classification for matched colours.
5. **Matching is staged, source-neutral and reviewable**: explicit CRT →
   exact code + geometry → family + geometry → geometry-only (suggest) →
   description (suggest) → unmatched. Fingerprints are computed from the
   IR; colour class and type mismatches are hard fails; thresholds are
   tuned on the corpus against the known traps and reported in the import
   summary. Results persist in the document as `SymbolMatch[]` with
   `reviewed` and `libraryVersion`; decisions are exportable as CRT.
6. **Unmatched symbols are first-class**: drawn from their source IR with
   source colours by the same renderer; 8xx text and club symbols are
   expected to stay unmatched.
7. **Scale**: library at reference scale; `documentFactor` detected from
   matched line widths and stored; course overlay enlarged by
   `referenceScale / printScale`; per-library `scaleRules` for the
   MTBO/Ski specs.
8. **Course overlay symbols come from the library** (`ISOM2017-2:701…715`,
   `ISSprOM2019-2:…`) so the editor and print draw them through the same
   path as the base map; today's `defaultMapAppearance` constants become
   overrides of library dimensions.
9. **Pin the rendering semantics** listed in §6.9 as the first deliverable
   of 04, with fixture files per rule, before any library authoring beyond
   a pilot family (5xx paths and fences, which exercise dashes, glyphs and
   borders together).
10. **Keep light map editing possible** (§1 scope note): new objects
    reference source symbols only; canonical symbols are materialised into
    the source table on first use via the IR → source-symbol conversion;
    the matcher's results double as the palette's labels. No implementation
    in this topic.

## 10. Open questions carried forward

- **OOM symbol sets as a test oracle.** Using the GPL-3.0 `.omap` sets to
  *verify* our dimensions in tests (not shipping them) is legally
  unproblematic in an AGPL project but the sets would then live in the
  repository or be fetched in CI. Decide: fetch in CI from a pinned
  upstream commit, or rely on the hand-typed spec table only.
- **Corpus symbol tables as fixtures.** Symbol tables (no geometry) of the
  club maps would make the matcher tunable in CI. They contain club-local
  descriptions; ask the clubs or anonymise descriptions.
- **Swedish names.** The library carries `name.sv`; the official Swedish
  translation of ISOM/ISSprOM (SOFT) is the source — confirm its licence
  for the names.
- **ISOM 2030.** The revision will renumber and re-dimension symbols. The
  versioned library id and `aliases` are designed for it; nothing else to
  do now.
- **Formatted text (`otp` 5) and fonts** remain with 04/05 (02 §10).
- **Decrease/taper, secondary symbols, irregular patterns**: measured as
  absent or negligible in the corpus (§6.8), so phase 1 may warn instead of
  draw. Re-check when the first OCAD 12+/2018 club maps with irregular
  patterns arrive; the measurement is in `measure-symbols.mjs`.
- **Per-club explicit mappings.** Where do club CRTs live — with the club
  library map (`club_map_files`) or as a club setting? 07.

---

## Appendix A — Symbol inventories (Rev 6)

Numbers and names as printed in the specifications; type is the spec's
P/L/A/T. Purple role for 7xx from §2.4.

### ISOM 2017-2 Revision 6 (113)

| Code | Name | Type |
|---|---|---|
| 101 | Contour | L |
| 102 | Index contour | L, T |
| 103 | Form line | L |
| 104 | Earth bank | L |
| 105.1 | Earth wall | L |
| 105.2 | Retaining earth wall | L |
| 106 | Ruined earth wall | L |
| 107 | Erosion gully | L |
| 108 | Small erosion gully | L |
| 109 | Small knoll | P |
| 110 | Small elongated knoll | P |
| 111 | Small depression | P |
| 112 | Pit | P |
| 113 | Broken ground | A |
| 114 | Very broken ground | A |
| 115 | Prominent landform feature | P |
| 201 | Impassable cliff | L |
| 202 | Cliff | L |
| 203.1 | Rocky pit or cave | P |
| 203.2 | Dangerous pit | P |
| 204 | Boulder | P |
| 205 | Large boulder | P |
| 206 | Gigantic boulder or rock pillar | A |
| 207 | Boulder cluster | P |
| 208 | Boulder field | A |
| 209 | Dense boulder field | A |
| 210 | Stony ground, slow running | A |
| 211 | Stony ground, walk | A |
| 212 | Stony ground, fight | A |
| 213 | Sandy ground | A |
| 214 | Bare rock | A |
| 215 | Trench | L |
| 301 | Uncrossable body of water | A |
| 302 | Shallow body of water | A |
| 303 | Waterhole | P |
| 304 | Crossable watercourse | L |
| 305 | Small crossable watercourse | L |
| 306 | Minor/seasonal water channel | L |
| 307 | Uncrossable marsh | A |
| 308 | Marsh | A |
| 309 | Narrow marsh | L |
| 310 | Indistinct marsh | A |
| 311 | Well, fountain or water tank | P |
| 312 | Spring | P |
| 313 | Prominent water feature | P |
| 401 | Open land | A |
| 402 | Open land with scattered trees | A |
| 403 | Rough open land | A |
| 404 | Rough open land with scattered trees | A |
| 405 | Forest | A |
| 406 | Vegetation: slow running | A |
| 407 | Vegetation: slow running, good visibility | A |
| 408 | Vegetation: walk | A |
| 409 | Vegetation: walk, good visibility | A |
| 410 | Vegetation: fight | A |
| 412 | Cultivated land | A |
| 413 | Orchard | A |
| 414 | Vineyard or similar | A |
| 415 | Distinct cultivation boundary | L |
| 416 | Distinct vegetation boundary | L |
| 417 | Prominent large tree | P |
| 418 | Prominent bush or tree | P |
| 419 | Prominent vegetation feature | P |
| 501 | Paved area | A |
| 502 | Wide road | L |
| 503 | Road | L |
| 504 | Vehicle track | L |
| 505 | Footpath | L |
| 506 | Small footpath | L |
| 507 | Less distinct small footpath | L |
| 508 | Narrow ride or linear trace through the terrain | L |
| 509 | Railway | L |
| 510 | Power line, cableway or skilift | L, P |
| 511 | Major power line | L, P |
| 512 | Bridge / tunnel | L, P |
| 513.1 | Wall | L |
| 513.2 | Retaining wall | L |
| 514 | Ruined wall | L |
| 515 | Impassable wall | L |
| 516 | Fence | L |
| 517 | Ruined fence | L |
| 518 | Impassable fence | L |
| 519 | Crossing point | P |
| 520 | Area that shall not be entered | A |
| 521 | Building | A |
| 522 | Canopy | A |
| 523 | Ruin | L |
| 524 | High tower | P |
| 525 | Small tower | P |
| 526 | Cairn | P |
| 527 | Fodder rack | P |
| 528 | Prominent line feature | L |
| 529 | Prominent uncrossable line feature | L |
| 530 | Prominent man-made feature – ring | P |
| 531 | Prominent man-made feature – x | P |
| 532 | Stairway | L |
| 601 | Magnetic north line | L |
| 602 | Registration mark | P |
| 603 | Spot height | P, T |
| 701 | Start | P (lower) |
| 702 | Map issue point | P (upper) |
| 703 | Control point | P (lower) |
| 704 | Control number | T (lower) |
| 705 | Course line | L (lower) |
| 706 | Finish | P (lower) |
| 707 | Marked route | L (upper) |
| 708 | Out-of-bounds boundary | L (lower) |
| 709 | Out-of-bounds area | A (upper) |
| 710 | Crossing point | L (lower) |
| 711 | Out-of-bounds route | L (upper) |
| 712 | First aid post | P (lower) |
| 713 | Refreshment point | P (lower) |
| 715 | Continuing point after map exchange | P (lower) |

### ISSprOM 2019-2 Revision 6 (104)

| Code | Name | Type |
|---|---|---|
| 101 | Contour | L |
| 102 | Index contour | L, T |
| 103 | Form line | L |
| 105.1 | Small earth wall | L |
| 105.2 | Retaining earth wall seen only from one side | L |
| 107 | Erosion gully | L |
| 108 | Small erosion gully | L |
| 109 | Small knoll | P |
| 110 | Small elongated knoll | P |
| 111 | Small depression | P |
| 112 | Pit or hole | P |
| 113 | Broken ground | A |
| 115 | Prominent landform feature | P |
| 201 | Uncrossable cliff | L |
| 202 | Passable rock face | L |
| 203 | Rocky pit or cave | P |
| 204 | Boulder | P |
| 205 | Large boulder | P |
| 206 | Gigantic boulder or rock pillar | A |
| 207 | Boulder cluster | P |
| 208 | Boulder field | A |
| 210 | Stony ground | A |
| 213 | Open sandy ground | A |
| 214 | Bare rock | A |
| 301 | Uncrossable body of water | A |
| 302 | Shallow body of water | A |
| 303 | Waterhole | P |
| 305 | Small crossable watercourse | L |
| 306 | Minor / seasonal watercourse | L |
| 307 | Uncrossable marsh | A |
| 308 | Marsh | A |
| 309 | Narrow marsh | L |
| 310 | Indistinct marsh | A |
| 311 | Small fountain or well | P |
| 312 | Spring | P |
| 313 | Prominent water feature | P |
| 401 | Open land | A |
| 402 | Open land with scattered trees | A |
| 403 | Rough open land | A |
| 404 | Rough open land with scattered trees | A |
| 405 | Forest | A |
| 406 | Vegetation: slow running | A |
| 407 | Vegetation: slow running, good visibility | A |
| 408 | Vegetation: walk | A |
| 409 | Vegetation: walk, good visibility | A |
| 410 | Vegetation: fight | A |
| 411 | Uncrossable vegetation | A |
| 412 | Cultivated land | A |
| 413 | Orchard | A |
| 414 | Vineyard or similar | A |
| 415 | Distinct cultivation boundary | L |
| 416 | Distinct vegetation boundary | L |
| 417 | Prominent large tree | P |
| 418 | Prominent bush or small tree | P |
| 419 | Prominent vegetation feature | P |
| 501 | Paved area | A |
| 501.1 | Step or edge of paved area | L |
| 501.2 | Step or edge of paved area at lower level | L |
| 501.3 | Paved area with scattered trees | A |
| 505 | Unpaved footpath or track | L |
| 506 | Small unpaved footpath or track | L |
| 507 | Less distinct small path | L |
| 508 | Narrow ride | L |
| 509.1 | Railway | L |
| 509.2 | Tramway | L |
| 510 | Power line, cableway or ski lift | L |
| 511 | Major power line | L |
| 512.1 | Bridge or tunnel entrance | L |
| 512.2 | Underpass or tunnel | L |
| 512.3 | Area runnable at lower level | A |
| 513.1 | Passable wall | L |
| 513.2 | Passable retaining wall | L |
| 515 | Uncrossable wall | L |
| 516 | Passable fence or railing | L |
| 518 | Uncrossable fence or railing | L |
| 519 | Crossing point (optional) | P |
| 520 | Area that shall not be entered | A |
| 521 | Building | A |
| 522 | Canopy | A |
| 522.1 | Pillar | P |
| 524 | High tower | P |
| 525 | Small tower | P |
| 526 | Cairn, memorial, sculpture, small monument or boundary stone | P |
| 527 | Fodder rack | P |
| 528 | Prominent line feature | L |
| 529 | Prominent uncrossable line feature | L |
| 530 | Prominent man-made feature – ring | P |
| 531 | Prominent man-made feature – x | P |
| 532 | Stairway | L |
| 533 | Area with obstacles | A |
| 601 | Magnetic north line | L |
| 701 | Start | P (lower) |
| 702 | Map issue point | P (upper) |
| 703 | Control point | P (lower) |
| 704 | Control number | T (upper; optional white outline) |
| 705 | Course line | L (lower) |
| 706 | Finish | P (lower) |
| 707 | Marked route | L (upper) |
| 708 | Out-of-bounds boundary | L (lower) |
| 709 | Out-of-bounds area | A (upper) |
| 710.1 | Crossing point | P (lower) |
| 710.2 | Crossing section | L (upper) |
| 714 | Temporary construction or closed area | A (upper) |
| 715 | Continuing point after map exchange | P (lower) |

## Appendix B — IOF colour order (Printing and Colour Definitions Rev 4, Sep 2024)

Draw order top to bottom (first row drawn last). ✓ = colour used by that
specification. CMYK in percent.

| # | Colour | C | M | Y | K | ISOM 2017-2 | ISSprOM 2019-2 | ISSkiOM 2019 | ISMTBOM 2022 |
|--:|---|--:|--:|--:|--:|:-:|:-:|:-:|:-:|
| 1 | Upper purple for course overprint | 35 | 85 | 0 | 0 | ✓ | ✓ | ✓ | ✓ |
| 2 | Upper white for course overprint | 0 | 0 | 0 | 0 | | ✓ | ✓ | ✓ |
| 3 | Purple 50 % area symbol | 18 | 43 | 0 | 0 | | ✓ | | ✓ |
| 4 | Green for Ski-O | 91 | 0 | 83 | 0 | | | ✓ | |
| 5 | Orange for Ski-O | 0 | 60 | 100 | 0 | | | ✓ | |
| 6 | White for railroad | 0 | 0 | 0 | 0 | ✓ | ✓ | | ✓ |
| 7 | Black 100 % | 0 | 0 | 0 | 100 | ✓ | ✓ | ✓ | ✓ |
| 8 | Blue 100 % point symbols | 100 | 0 | 0 | 0 | ✓ | | | |
| 9 | Brown 100 % point symbols | 25 | 75 | 100 | 0 | ✓ | | | |
| 10 | Green 100 % point symbols | 80 | 0 | 100 | 0 | ✓ | ✓ | | ✓ |
| 11 | Blue 100 % line symbols | 100 | 0 | 0 | 0 | ✓ | | ✓ | ✓ |
| 12 | Dark green for hedges in forest | 100 | 0 | 80 | 30 | ✓ | | | |
| 13 | Brown 100 % line symbols | 25 | 75 | 100 | 0 | ✓ | | | |
| 14 | **Lower purple for course overprint** | 35 | 85 | 0 | 0 | ✓ | ✓ | ✓ | ✓ |
| 15 | Dark green line symbols | 100 | 0 | 80 | 30 | | ✓ | | |
| 16 | Blue 100 % point and line symbols | 100 | 0 | 0 | 0 | | ✓ | | ✓ |
| 17 | Brown 100 % | 25 | 75 | 100 | 0 | | ✓ | ✓ | ✓ |
| 18 | White stripes for area passable at two levels | 0 | 0 | 0 | 0 | | ✓ | | |
| 19 | Brown 50 % for road infill | 10 | 35 | 50 | 0 | ✓ | ✓ | ✓ | ✓ |
| 20 | Brown 30 % for road infill | 6 | 23 | 33 | 0 | | ✓ | | |
| 21 | Black 100 % for road outline | 0 | 0 | 0 | 100 | ✓ | ✓ | ✓ | ✓ |
| 22 | Black 60 % for buildings | 0 | 0 | 0 | 60 | | | | ✓ |
| 23 | Black 50 % for large buildings | 0 | 0 | 0 | 50 | ✓ | ✓ | | |
| 24 | Black 20 % for canopy | 0 | 0 | 0 | 20 | ✓ | ✓ | | ✓ |
| 25 | Blue 100 % area symbols | 100 | 0 | 0 | 0 | ✓ | ✓ | ✓ | ✓ |
| 26 | Blue 70 % area symbols | 70 | 0 | 0 | 0 | ✓ | ✓ | | ✓ |
| 27 | Blue 50 % area symbols | 50 | 0 | 0 | 0 | ✓ | ✓ | ✓ | |
| 28 | Blue 30 % area symbols | 30 | 0 | 0 | 0 | | ✓ | | |
| 29 | White over green and brown | 0 | 0 | 0 | 0 | ✓ | ✓ | | |
| 30 | Brown 50 % for paved area | 10 | 35 | 50 | 0 | ✓ | ✓ | ✓ | ✓ |
| 31 | Brown 30 % for paved area | 6 | 23 | 33 | 0 | | ✓ | | |
| 32 | Olive green | 38 | 27 | 100 | 0 | ✓ | ✓ | ✓ | ✓ |
| 33 | Dark green area symbols | 100 | 0 | 80 | 30 | | ✓ | | |
| 34 | Green 100 % area symbols | 80 | 0 | 100 | 0 | ✓ | ✓ | | |
| 35 | Green 60 % area symbols | 48 | 0 | 60 | 0 | ✓ | ✓ | | |
| 36 | Green 30 % area symbols | 24 | 0 | 30 | 0 | ✓ | ✓ | ✓ | ✓ |
| 37 | Black 35 % area symbols | 0 | 0 | 0 | 35 | ✓ | ✓ | | |
| 38 | White over yellow | 0 | 0 | 0 | 0 | ✓ | ✓ | ✓ | ✓ |
| 39 | Black for cultivated land and sandy ground | 0 | 0 | 0 | 100 | ✓ | ✓ | | ✓ |
| 40 | Orange for MTBO | 0 | 60 | 100 | 0 | | | | ✓ |
| 41 | Yellow 100 % area symbols | 0 | 27 | 79 | 0 | ✓ | ✓ | | ✓ |
| 42 | Yellow 75 % area symbols | 0 | 20 | 59 | 0 | ✓ | | ✓ | |
| 43 | Yellow 50 % area symbols | 0 | 14 | 40 | 0 | ✓ | ✓ | ✓ | ✓ |

The 2022 edition's table has the same order with the older values listed
in §2.3 (brown 0/56/100/18, brown 50 % 0/28/50/9, brown 30 % 0/17/30/5,
green 76/0/91/0, green 60 % 46/0/55/0, green 30 % 24/0/27/0, black 30 %
instead of 35 %), without the Ski-O orange, and with "Yellow 100 % +
Green 50 %" as the name of the olive colour.

## Appendix C — Field mapping into the IR

| IR | OCAD | OMAP |
|---|---|---|
| `StrokeSpec.widthUm` | `lineWidth` ×10 | `line_width` |
| `StrokeSpec.cap/join` | `lineStyle` (0 bevel joins + flat caps, 1 round + round, 4 miter + flat; bit 2 pointed ends → `cap: "pointed"`) | `cap_style`, `join_style` |
| `DashPattern` (ocad) | `mainLength`, `mainGap`, `endLength`, `secGap`, `endGap`, `minSym` | — |
| `DashPattern` (omap) | — | `dashed`, `dash_length`, `break_length`, `dashes_in_group`, `in_group_break_length`, `half_outer_dashes`, `show_at_least_one_symbol` |
| `shortenStart/EndUm` | `distFromStart`, `distToEnd` | `start_offset`, `end_offset` |
| `halo` (line) | `frColor`, `frWidth`, `frStyle` | — |
| `glyphs[] spaced` | `primSymElements`, `primSymDist`, `nPrimSym`, `mainLength`/`endLength` section layout; `decrease` → `decrease` | `mid_symbol`, `mid_symbol_distance`, `mid_symbols_per_spot`, `minimum_mid_symbol_count(_when_closed)`, `segment_length`, `end_length` |
| `glyphs[] dashCentres / gapCentres / dashGroupCentres` | `secSymElements` (section centre) | `mid_symbol_placement` |
| `glyphs[] corners` | `cornerSymElements` | — (OMAP has no corner symbol; `dash_symbol` at dash points) |
| `glyphs[] dashPoints` | — | `dash_symbol`, `suppress_dash_symbol_at_ends` |
| `glyphs[] start / end` | `startSymElements`, `endSymElements` | `start_symbol`, `end_symbol` |
| `borders` | `doubleLine` (`dblMode`, `dblLeftColor/Width`, `dblRightColor/Width`, `dblFillColor`, `dblWidth`, `dblLength`/`dblGap`, `dblFlags`, `dblBackgroundColor`) | `borders` (`color`, `width`, `shift`, `dashed`, `dash_length`, `break_length`) + main line as fill |
| `AreaSymbol.fill` | `fillOn`, `fillColor` | `inner_color` |
| `hatches[]` | `hatchMode`, `hatchColor`, `hatchLineWidth`, `hatchDist`, `hatchAngle1`, `hatchAngle2` | `pattern type=1`: `color`, `line_width`, `line_spacing`, `line_offset`, `angle` |
| `patterns[]` | `structMode` (1 aligned, 2 shifted), `structWidth`, `structHeight`, `structAngle`, `structDrawingMode`, `structIrregular*`, `elements[]` | `pattern type=2`: `line_spacing`, `point_distance`, `line_offset`, `offset_along_line`, `angle`, `no_clipping`, nested point symbol |
| `AreaSymbol.border` | `borderOn`, `borderSym` | combined-symbol part |
| `PointSymbol.glyph.parts` | element `type` 1 line → `stroke`, 2 area → `fill`, 3 circle → `ring`, 4 dot → `disc`; `lineWidth`, `diameter`, `color`, `coords` | `inner_radius/inner_color` → `disc`, `outer_width/outer_color` → `ring`, nested line → `stroke`, nested area → `fill` |
| `PointSymbol.orientation` | symbol flag "oriented to north" vs rotatable (`useSymbolFlags`/object `ang`) | `rotatable` |
| `TextSymbol` | `fontName`, `fontSize` (pt/10 → µm ×35.28), `weight`, `italic`, `charSpace`, `wordSpace`, `alignment`, `lineSpace`, `paraSpace`, `lbOn/lbColor/lbWidth/lbDist`, `frMode/frStyle/frColor/frWidth` | `font family/size`, `bold`, `italic`, `underline`, `character_spacing`, `line_spacing`, `paragraph_spacing`, `framing*`, `line_below*` |
| `ColourEntry` | parameter string 9: number, name, CMYK, `o` overprint, spot separations; order = list position | `color priority`, `name`, `c/m/y/k`, `opacity`, `spotcolors` (+ `knockout`) |

Sources consulted: ISOM 2017-2 Rev 6 and ISSprOM 2019-2 Rev 6 (IOF Map
Commission, 2024); IOF Map Specifications — Printing and Colour
Definitions, Feb 2022 and Rev 4 Sep 2024; OpenOrienteering Mapper
`src/core/symbols/*.h`, `symbol sets/15000/ISOM 2017-2_15000.omap`,
`symbol sets/4000/ISSprOM 2019_4000.omap`, `symbol sets/*.crt`,
`doc/manual/pages/crt_files.md` (GPL-3.0, github.com/OpenOrienteering/mapper);
Purple Pen `src/MapModel/MapModel/SymDef.cs`, `Glyph.cs`
(github.com/petergolde/PurplePen) and its change summary; `ocad2geojson`
reader and `ocad-to-svg.js`/`transform-features.js`; Condes online help
"Overprint Effect or Upper/Lower Purple"; OCAD wiki "Course Setting
Printing" and "Symbol Set Overview".
