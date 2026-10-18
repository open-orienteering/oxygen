# Map symbols — the canonical IOF library

Normative chapter for 03 §6.3–6.4 (slice B). It covers the IOF colour
palette as data, the canonical symbol libraries `ISOM2017-2` and
`ISSprOM2019-2` authored in the `RenderSymbol` IR, the authoring rules,
how a library entry becomes a plain `RenderSymbol` against a document's
colour stack, and the tests that keep the library honest. The IR itself
(`render/symbol.ts`) and its drawing semantics are specified in
`docs/map-rendering.md` §4; the OCAD import that produces IR for *source*
symbols is in `docs/map-import.md` §3.3. Matching imported symbols to
library entries (03 §6.5–6.6) and aligning the colour stack (03 §6.3) are
§8–§9; their code lives in `packages/shared/src/import/`.

Everything lives in `packages/shared/src/symbol-library/` and is exported
as `symbolLibrary` from `@oxygen/shared`.

```
symbol-library/
├── palette.ts            IOF palette editions, per-spec stacks
├── schema.ts             entry/library Zod schemas, resolver, validateLibrary
├── authoring.ts          typed helpers used by the entry files
├── index.ts              registry: list/get/entriesForCode/materialiseLibrary
├── ISOM2017-2/           common.ts + landforms, rock, water, vegetation,
│                         manmade, technical, course, index
├── ISSprOM2019-2/        same layout
└── __tests__/            palette.test.ts, library.test.ts
```

## 1. Colour palette

`palette.ts` transcribes 03 Appendix B — the IOF *Printing and Colour
Definitions* table — as data. One row per print colour, in the table's
order (top of the stack first):

```ts
interface PaletteEntry {
  id: string;                 // stable across editions: "brown100-line", "purple-lower", …
  name: string;               // the IOF row name
  cmyk: [c, m, y, k];         // 0..1
  specs: SpecId[];            // which specs tick the row
  purpleRole?: "lower" | "upper";
}
```

Two editions exist. `iof2024` (43 rows) is Rev 4 of the IOF document and
is what both libraries declare as their `palette`. `iof2022` is the
previous edition for documents that must keep the older ink values: the
same ids minus `orange-skio`, the pre-2024 brown and green CMYK, black
area screen 30 % instead of 35 %. Ids are stable between editions so a
library entry never has to change when a document picks the other
edition.

| Function | Returns |
|---|---|
| `paletteFor(edition, spec)` | the rows ticked for `spec`, top first |
| `paletteStack(edition, spec)` | the same rows as a document `ColourStack`: **index 0 drawn first**, ids prefixed `<edition>:` (`iof2024:purple-lower`), CMYK and `purpleRole` carried |
| `paletteIndex(edition, spec)` | `Map<paletteId, stackIndex>` for the resolver |

The stack order *is* the 03 §2.4 layering: `purple-upper` is the last
index in every stack; `black100`, 100 % blue and brown line/point colours
sit above `purple-lower` in ISOM; ISSprOM puts `brown100` below
`purple-lower` and black above it; road fills, area screens and yellow
are below purple everywhere. Tests assert these positions, not the raw
row numbers.

## 2. Library and entry schema

A library (`symbolLibrarySchema`):

```ts
{
  id: "ISOM2017-2",
  spec: "ISOM2017-2" | "ISSprOM2019-2",
  revision: "Rev 6 (20 January 2024)",
  referenceScale: 15_000,
  palette: "iof2024",
  entries: LibraryEntry[]
}
```

An entry (`libraryEntrySchema`) — the 03 §6.4 shape with `render` in
*palette-id* form:

```ts
{
  id: "ISOM2017-2:302.b",          // <library>:<code>[.<variant>]
  code: "302",                     // /^\d{3}(\.\d{1,2})?$/ — the spec heading
  variant: "b" | null,             // null = the heading's own drawing
  name: { en: string; sv?: string },
  description?: string,            // when the variant applies
  specType: "P" | "L" | "A" | "T",
  purpleRole: "lower" | "upper" | null,   // required for 7xx, null otherwise
  orientation: "north" | "object" | null, // point symbols only
  minimum?: { lengthUm?, widthUm?, areaUm2? },   // graphical minima from the spec
  footprintM?: number,             // informational, at the reference scale
  aliases: { library: string; code: string }[],  // numbering in older specs
  render: LibraryRender,           // RenderSymbol minus id/code/name, colours as palette ids
  notes?: string,                  // deviations and tool-dependent choices
  source: string                   // citation, e.g. "ISOM 2017-2 Rev 6 (…), §3.8"
}
```

`LibraryRender` is `Colourised<RenderSymbolInput>`: the IR with every
`colour`, `fill` and `backgroundColour` typed as `string` instead of a
stack index. The type is enforced by the compiler at authoring time; the
schema accepts it as an opaque object and defers structural validation to
the resolver (§4), which parses the resolved form with
`parseRenderSymbol`.

Entries are **TypeScript object literals**, not the JSON files 03 §6.4
sketched. The IR is deep enough that a typed helper vocabulary
(`authoring.ts`: `stroke`, `ring`, `ringCC`, `disc`, `triangle`, `dashed`,
`doubleLine`, `spaced`, `pattern`, `hatch`, `line`, `area`, `point`, …)
reads closer to the spec's own wording than nested JSON, and `satisfies
LibraryEntryInput[]` plus `Colourised<>` catch a wrong colour kind or a
misplaced field before any test runs. Each library's `common.ts` maps
short names (`C.brownLine`, `C.purpleUpper`) to palette ids so the files
never spell a palette id twice.

## 3. Authoring rules

These are the 03 §6.4 rules as applied; the entry `notes` carry the
per-symbol decisions.

- **One entry per drawable variant.** The heading's entry (`variant:
  null`) is the drawing the spec shows; variants get a letter and a
  `description` of when they apply (`302.b` dashed outline for an
  indistinct shoreline, `508.b–e` the coloured bands of a footpath, `104.b`
  very high earth bank, `709.b/c` out-of-bounds with solid/dashed
  boundary). A heading entry must precede its variants in the file.
- **Dimensions come from the spec text and drawings only** (Rev 6 of both
  documents, §3.8 / §4.8 "precise definitions"). The OpenOrienteering
  Mapper symbol sets were used as a cross-check for shapes the spec only
  draws (713 cup, 710 crossing-point flares, 512.1 bridge ends), never
  copied — they are GPL and not in the repository. Where OOM and the Rev 6
  text differ (ISOM 104 top line 0.25 mm, ISSprOM 105.1 0.27 mm, 509.2
  0.08 mm black, 709 stripes 0.4 mm, 710.1 0.5 mm lines, 533 new) the text
  wins and the entry says so.
- **Units** are paper micrometres at the library's reference scale;
  glyph coordinates are y-up and x along the line direction, so tags and
  half-dots that the spec draws on the right-hand side are at **−y**.
  `ring` takes the *outer* diameter; `ringCC` the centre-to-centre
  diameter plus line width, which is how the course symbols are stated
  (703 ø 5.0 CC + 0.35 → outer 5 350).
- **Tool-dependent details follow OCAD** (03 §6.4): dash layout is
  `"ocad"` (sections start and end with a full dash, `DASH_NOTE`),
  irregular spec patterns ("random" boulder fields, 208/209 triangles,
  210–212 stony ground) are regular — optionally shifted — grids as
  03 §6.2 decided, pattern grids rotate with the object angle unless the
  spec says north-fixed.
- **Colours are palette ids, never CMYK.** `validateLibrary` rejects an
  id outside the spec's own tick marks, so an ISOM entry cannot use
  `brown100` (an ISSprOM-only row) by accident.
- **Course symbols are ordinary entries** with `purpleRole` per 03 §2.4:
  ISOM 704 lower / ISSprOM 704 upper, ISOM 710 lower / ISSprOM 710.1 lower
  + 710.2 upper, 702 / 707 / 709 / 711 / 714 upper, the rest lower. A
  lower-role entry never draws in `purple-upper` and vice versa (tested).
  Minima that drive the course editor (707 ≥ 4.5 mm, 709 ≥ 3 mm wide and
  9 mm², 714 ≥ 0.5 mm wide and 0.25 mm²) are on the entries.
- **Names** are the spec's English headings; Swedish names are deferred
  (the schema has `name.sv`, the first edition leaves it out rather than
  shipping a partial translation).
- **Aliases** (older numbering, ISOM 2000 / ISSprOM 2007 codes) are in
  the schema but not yet populated; the matcher (§8) finds renumbered
  symbols through the family and description stages instead, and the
  first edition ships aliases empty rather than partially.

### 3.1 Counts against the 03 estimate

| Library | Appendix A headings | Entries | 03 §6.4 estimate |
|---|---|---|---|
| `ISOM2017-2` | 113 | 152 | 180–200 |
| `ISSprOM2019-2` | 105 | 141 | 170–190 |

The estimate assumed more drawings per heading than the Rev 6 documents
actually show once the spec's own prose is followed (many "variants" are
object-level choices — dash points, corner flags, object angle — that the
IR handles without a separate entry). Coverage of every heading is
asserted, not estimated.

## 4. Resolving an entry

A document's colour stack is not the palette: it is the aligned union of
the source table and the palette rows the matched symbols use (03 §6.3).
A library entry therefore stays in palette-id form until it is placed
in a document, and `resolveEntry` does the substitution:

```ts
import { symbolLibrary } from "@oxygen/shared";

const { paletteIndex, resolveEntry, getLibraryEntry } = symbolLibrary;

const entry = getLibraryEntry("ISOM2017-2:703")!;
const sym = resolveEntry(entry, paletteIndex("iof2024", "ISOM2017-2"));
// sym: RenderSymbol with numeric colours, id "ISOM2017-2:703", code "703", name "Control point"
```

`resolveEntry(entry, index)` deep-walks `render`, replaces every
`colour` / `fill` / `backgroundColour` string through `index` (throwing
`UnknownPaletteIdError` on a miss), adds `id`, `code` and `name.en` and
returns `parseRenderSymbol(...)` — so the resolved symbol is exactly what
the OCAD importer produces for a source symbol and goes through the same
`symbolise` stage with no special case. `colourRefs(render)` lists the
palette ids an entry uses, which is what the colour-stack builder of 03
§6.3 needs to decide which palette rows a document must include.

`materialiseLibrary(id, edition?)` is the whole-library shortcut used by
tests and the coming contact sheet: `{ library, edition, colours:
paletteStack(...), symbols: entries.map(resolve) }`, i.e. a colour stack
plus `RenderSymbol[]` that `symbolise` accepts as-is.

Registry functions: `listSymbolLibraries()`, `getSymbolLibrary(id)`,
`getLibraryEntry("ISOM2017-2:302.b")`, `entriesForCode("ISOM2017-2",
"302")` (heading first, then variants). Libraries are parsed once and
cached.

## 5. Validation

`parseSymbolLibrary(input)` runs the Zod schema and then
`validateLibrary`, which returns `LibraryProblem[]` (`{ entryId, message
}`) for the mistakes the schema alone cannot see:

| Check | Message |
|---|---|
| `id` ≠ `<library>:<code>[.<variant>]` | `id should be …` |
| same id twice | `duplicate id` |
| palette id not ticked for the library's spec | `palette id "x" is not in <palette> for <spec>` |
| 7xx without `purpleRole` / non-7xx with one | `course symbols need a purpleRole` / `purpleRole is only for 7xx` |
| point without `orientation` / non-point with one | `point symbols need an orientation` / `orientation is only for point symbols` |
| `render` does not resolve to a valid `RenderSymbol` | the resolver's / Zod's message |

The registry throws if either shipped library has any problem, so a bad
entry fails every consumer at import time rather than at draw time.

## 6. Tests

`packages/shared/src/symbol-library/__tests__/` implements 03 §6.4 (a)–(c)
plus the purple-role and materialisation checks:

- **palette.test.ts** — 43 / 42 rows per edition in Appendix B order,
  the 2022 overrides (brown, green, black 30 %, olive name), per-spec tick
  counts (ISOM 29, ISSprOM 33), the §2.4 layering as stack-index
  inequalities, prefixed stack ids and CMYK → hex.
- **library.test.ts**
  - (a) both libraries parse, `validateLibrary` is empty, every entry cites
    `<spec> Rev 6`, heading entries precede variants; a deliberately broken
    copy produces each `validateLibrary` message.
  - (b) hand-typed Appendix A heading lists (113 ISOM, 105 ISSprOM) each
    have a heading entry, and no entry uses a code outside its list.
  - (c) hand-typed dimension tables per spec (≈ 70 ISOM and ≈ 60 ISSprOM
    assertions on widths, dash lengths, diameters, grid cells, spacing,
    border shifts, halo colours, minima), including every Rev 6 change
    that differs from the earlier revisions and from OOM.
  - (d) purple roles per 03 §2.4 for every 7xx entry; lower entries never
    use `purple-upper` and vice versa; ISOM-only (711–713) and
    ISSprOM-only (710.1/.2, 714) codes are not cross-listed.
  - (e) `materialiseLibrary` for both libraries: every colour index is
    inside the stack, every entry symbolised against a representative
    object (line with corner + dash point, 20 × 20 mm area at 30°, point at
    45°, text "31") emits at least one pass and no warnings; the 2022
    edition yields identical symbols with only CMYK changed; resolved
    symbols carry id/code/name.

The golden contact sheet (03 §6.4 (d), "optional" for this step) and the
OOM dimension spot check (e) are not implemented; see §10.

## 7. Deviations from 03 §6.4, recorded

| 03 said | Done | Why |
|---|---|---|
| Entries as authored JSON files | TypeScript literals via `authoring.ts` helpers | Compile-time colour-kind and field checks; the IR nests too deeply for readable JSON. The Zod schema still validates the result, so a JSON loader can be added without touching entries. |
| `fingerprint` overrides per entry | Not needed | Fingerprints are derived from the resolved IR (§8.1) and the matcher never needed a hand override on the corpus; add the field if one does. |
| `name.sv` alongside `name.en` | Optional, omitted | Ship a complete translation or none. |
| Appendix B palette as a "versioned table" | Two editions, ids stable, document picks edition | Same intent; the id stability rule is what keeps entries edition-free. |
| 180–200 / 170–190 entries | 152 / 141 | Counted against Rev 6; §3.1. |
| `defaultMapAppearance` in `course-maps/schema.ts` retired in favour of the library | Not yet | The course layer (slice C) is the consumer that switches; the constants stay until then. |

## 8. Matching source symbols to the library (03 §6.5–6.6)

Import stage 6 (`docs/map-import.md` §1). Code:
`packages/shared/src/import/{fingerprint,matcher,match-document}.ts`,
exported as `mapImport`. Everything is a pure function of the document
input and the library; the result is a `SymbolMatch` on every source
symbol (`header.symbols[i].match`, schema in `map-document/header.ts`)
and a `MatchingSummary` in the import report.

```ts
const { input, matching, colourStack, warnings } =
  mapImport.matchDocument(sourceInput, { library?, edition?, factor?, decisions? });
```

Library choice: `ISSprOM2019-2` for `mapScale ≤ 5000`, else `ISOM2017-2`
(`chooseLibrary`; the option overrides). Palette edition:
`detectPaletteEdition` on the colour table — whichever edition's values
the source's brown / green / black-screen colours sit nearer; ties and no
evidence → `iof2024`.

### 8.1 Fingerprints

`fingerprintOf(render, classOf)` reduces a `RenderSymbol` to the features
03 §6.5 compares, with colours replaced by their *class* (hue + percent
from `colour-class.ts`, §9.1) so a source brown and the palette brown
compare equal whatever their CMYK:

| IR type | Features |
|---|---|
| line | main stroke class + width, dashed (dash / gap lengths), borders (count, class, width, shift), double-line fill class + width, background halo, glyph presence and its stroke/disc/ring/fill counts, structural shape (`stroked`, `background`) |
| area | fill class, hatch (class, width, spacing, angle), pattern (class, cell, element kind + size), border |
| point | glyph parts by kind with class, width / diameter, extent box, rotational symmetry, `orientation` |
| text | class, font size, bold / italic, line spacing |

`compareFingerprints(src, canon, factor)` scales the canonical side by the
document factor (§8.3) and multiplies per-feature scores: 1 inside the
tolerance (`TOLERANCE`: 20 µm widths, 100 µm lengths, 5°, 10 % text /
box), falling linearly to 0 at twice it. Structural disagreements are
**hard fails** (score 0 with a reason): IR type, colour class of the main
stroke / fill, dashed vs solid, bordered vs not, stroked vs glyph-only.
Element counts are soft: `COUNT_PENALTY` (0.6) per missing or extra
element, so a single 6 mm ring is not a two-ring finish. Orientation is
ignored for rotationally symmetric glyphs (a boulder disc has no north).
`fingerprintHash` gives the stable `irHash` that club decisions key on.

### 8.2 Stages

`matchSymbol(source, ctx)` runs the 03 §6.5 ladder and stops at the first
stage that decides. Thresholds (`MATCH_THRESHOLDS`, reported in the
summary so tuning is visible): auto 0.85, suggest 0.6, strict 0.95.

| # | method | Candidates | Outcome |
|---|---|---|---|
| 1 | `explicit` | a `SymbolDecision` for (code, name?, irHash?) | `auto` + `reviewed` for an entry id; `unmatched` + `reviewed` for `canonicalId: null` (keep the source drawing). A decision naming an entry the library lacks falls through and warns `DECISION_UNKNOWN_ENTRY`. |
| 2 | `code+geometry` | entries with the source's exact spec code (`505.1` → `505.1`) | `auto` at ≥ 0.85 |
| 3 | `family+geometry` | same base number (`505.3` → every `505*`), else the hundred group | `auto` ≥ 0.85, `suggested` ≥ 0.6 |
| — | `variant` | family exists, source IR type differs from every family entry, name carries a template-variant hint (`VARIANT_NAME`: minimi, enskild, kontur, outline, single dot, …) | `unmatched`, drawn from source, counted separately — a minimum-size building point or a cliff outline line is not a mistake and not a review item |
| 4 | `geometry` | every entry of the IR type | `suggested` only, at ≥ 0.95 (never auto: a 0.14 mm brown line is a contour or a form line only by its code) |
| 5 | `description` | same type, not ruled out by a hard fail, ≥ 2 shared name tokens (Swedish → English lexicon `SV_EN`), or 1 token when the code matches or the geometry is partly compatible | `suggested` at 0.3 + 0.1 × tokens, capped 0.5 |
| 6 | `none` | — | `unmatched`, warns `SYMBOL_UNMATCHED` |

Every match carries `reasons[]` (the feature notes of the deciding
comparison, e.g. `glyph height 6000 vs 1200 µm (0.00)`), `confidence`,
`libraryVersion` (`<library>@<SYMBOL_LIBRARY_VERSION>`) and, for stages
2–4, `alternatives[]` (runner-ups for the review UI). Exact-code *lines*
that fit only at another `FACTOR_SNAP` factor are reported as
`scaleAnomalies` (`SYMBOL_SCALE_ANOMALY`) — an earth bank drawn at 1:10000
size in a 1:15000 table.

What is drawn: `auto` and reviewed matches resolve the library entry
against the aligned stack (§9) and are scaled by the document factor;
`suggested`, `unmatched` and `variant` keep their source IR
(`map-document/render-bridge.ts` `isAppliedMatch`, `canonical:false`
turns this off). Reviewing a suggestion is the pending review API
(`docs/map-import.md` §8); the data contract is already in the header.

### 8.3 Document factor (03 §6.6)

`detectDocumentFactor` — the enlargement the mapper drew at, relative to
the library's reference scale (ISOM 1:15000, ISSprOM 1:4000):

1. **lines** — for every solid source line whose exact code (else its
   family heading) is a solid line of the same hue, dashedness and
   borderedness, `source width ÷ canonical width`; median per family, then
   median over families, snapped to `FACTOR_SNAP` (0.5 … 2) within 3 %.
2. **codes** — no usable line family: try the scale's factor against ×1
   on every exact-code symbol of any type and keep the one more of them
   fit at ≥ 0.85 (a map "enlarged" to 1:7500 whose symbols still carry
   1:15000 dimensions).
3. **scale** — nothing with a spec code: `referenceScale / mapScale`.
4. **override** — `opts.factor`.

The result is `header.documentFactor` and `matching.factor
{factor, scaleFactor, symbolScale, method, samples, rawMedian}`.
`symbolScale = factor / scaleFactor` is 1 for a map drawn at the spec's
enlargement for its scale.

### 8.4 Corpus results

Measured on the local OCAD corpus (club maps, not committed — the script
and results live under `.local/research/oxygen-measurements/`), by objects
drawn: 77–84 % of forest-map objects and 83 % of sprint objects match
`auto`; adding `variant` (drawn correctly from source, nothing to review)
gives 84–93 %. No false-positive `auto` was found in review of every auto
match. The traps the stages were tuned on: a reused number (`527
Byggnad`) is `suggested` 521 by geometry, not auto; a `513.101 … utan
punkter` variant is `suggested`, not auto 513.1; a 6.0 mm control ring
numbered 702 is `suggested` 703 by description. The remaining non-auto
share is dominated by OCAD template conventions the library has no entry
for (minimum-size points, outline lines, single pattern dots); adding
those as library variants is the lever if the auto rate needs to rise.

## 9. Colour stack alignment (03 §6.3)

Import stage 7. Code: `packages/shared/src/import/{colour-class,colour-align}.ts`.
The source order is the mapper's knock-out order and wins for everything
they drew; alignment only *identifies*, *inserts* and *flags*.

### 9.1 Colour classes

`classifyCmyk` maps a CMYK quadruple onto an IOF hue (`black`, `white`,
`brown`, `blue`, `green`, `darkgreen`, `yellow`, `olive`, `purple`,
`orange`, `red`, `registration`) and a percent, with the hue rules written against Appendix B of both editions
(e.g. green needs `y ≥ 0.75 c`; red needs `k < 0.15` so a dark brown is
not red). `classifyColour` also reads the source *name* (Swedish and
English hue words and percents: "Brun 50% - Vägfyllning") and reports
`nameMismatch` when name and CMYK disagree. `paletteEntryFor` picks the
palette entry a classified colour stands for: name tokens first
(`väg`/road → `brown50-road`, `byggnad` → `black50-building`), then the
nearest percent, then the palette's default for the class; some entries
(`FULL_ONLY`) are never chosen for a screened colour.

### 9.2 Steps

`identifySourceColours` then `alignColourStack`:

1. **Classify** every source colour; unclassified ones that symbols use
   are listed in `colourStack.unclassified` and warn `COLOUR_UNCLASSIFIED`
   (a metro line colour on a sprint map stays as it is, drawn from source).
2. **Identify**: one source colour per palette id — the most used by
   objects, ties to the lowest. Full purples take their role from the
   name, else from position: above every black 100 % → `purple-upper`,
   else `purple-lower`.
3. **Alias**: a palette id that applied matches need but the source lacks,
   when the source has a colour of the same class → that colour stands for
   both (`black-road-outline` on a source with one black;
   `colourStack.aliased`). Purples are never aliased.
4. **Insert** the rest in palette order, each directly above its nearest
   lower palette neighbour already in the stack (else below the nearest
   upper one); `purple-upper` always on top, `purple-lower` directly below
   the first source colour the palette puts above it. Inserted entries have
   `id: "<edition>:<paletteId>"`, the palette CMYK and no `sourceNumber`
   (`colourStack.inserted`).
5. **Flag** palette ids whose relative order disagrees with the palette
   (longest increasing subsequence of palette ranks; everything outside it
   is a `COLOUR_ORDER_CONFLICT` with the pair it contradicts). The order
   is not changed.

Output: `header.colours` with `paletteIds[]` and `purpleRole` on every
entry that stands for a palette colour, and the source symbols' IR
remapped to the new indices (`remapRenderColours`). The render bridge
resolves canonical entries through `paletteIndexOfStack(header.colours)`.

## 10. Pending in this chapter

- Review API and UI for `suggested` matches (06 §5); the `decisions`
  input exists on `matchDocument` and nothing persists decisions yet.
- Library variants for the OCAD template conventions (§8.4) if the auto
  rate needs to rise.
- Contact sheet: a golden render per entry at 10× via the reference
  raster backend for visual review in PRs.
- `ISMTBOM2022` / `ISSkiOM2019` libraries (palette rows exist).
- Swedish names, once a full set is available.
- The OOM dimension spot check if 03 §10's licence question is settled in
  favour.
