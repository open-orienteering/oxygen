# Map symbols — the canonical IOF library

Normative chapter for 03 §6.3–6.4 (slice B). It covers the IOF colour
palette as data, the canonical symbol libraries `ISOM2017-2` and
`ISSprOM2019-2` authored in the `RenderSymbol` IR — plus `ISSkiOM2019`,
an overlay library of the ski-O symbols (§12) — the authoring rules,
how a library entry becomes a plain `RenderSymbol` against a document's
colour stack, and the tests that keep the library honest. The IR itself
(`render/symbol.ts`) and its drawing semantics are specified in
`docs/map-rendering.md` §4; the OCAD import that produces IR for *source*
symbols is in `docs/map-import.md` §3.3. Matching imported symbols to
library entries (03 §6.5–6.6) and aligning the colour stack (03 §6.3) are
§8–§9; their code lives in `packages/shared/src/import/`. Placing a
library entry in a document for Map mode (materialisation) and the
palette Map mode draws from are §11; their code is
`packages/shared/src/map-document/materialise.ts`.

Everything lives in `packages/shared/src/symbol-library/` and is exported
as `symbolLibrary` from `@oxygen/shared`.

```
symbol-library/
├── palette.ts            IOF palette editions, per-spec stacks
├── schema.ts             entry/library Zod schemas, resolver, validateLibrary
├── authoring.ts          typed helpers used by the entry files
├── index.ts              registry: list/get/entriesForCode/materialiseLibrary
├── ISOM2017-2/           common.ts + landforms, rock, water, vegetation,
│                         manmade, technical, course, names, index
├── ISSprOM2019-2/        same layout
├── ISSkiOM2019/          common.ts + water, tracks, names, index (overlay, §12)
└── __tests__/            palette.test.ts, library.test.ts, names.test.ts
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

Two editions exist. `iof2024` (44 rows) is Rev 4 of the IOF document
plus Oxygen's `white-skio` row, and is what every library declares as its
`palette`. `iof2022` is the
previous edition for documents that must keep the older ink values: the
same ids minus `orange-skio`, the pre-2024 brown and green CMYK, black
area screen 30 % instead of 35 %. Two cells depart from the IOF table,
both for ISSkiOM 2019 (§12.3): the `white-skio` row ("White under Ski-O
tracks", directly below `purple-lower`, ISSkiOM only) and the ISSkiOM
tick on `green100-area`. Ids are stable between editions so a
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

Stage 7 ranks a document's colours against `alignmentPalette(edition,
spec)` (`import/colour-align.ts`): the spec's rows plus every row an
overlay library's entries use (§12.3), in the table's order; a row the
edition lacks (`orange-skio` in `iof2022`) is the 2024 row and an
inserted one carries the id `iof2024:orange-skio`.

## 2. Library and entry schema

A library (`symbolLibrarySchema`):

```ts
{
  id: "ISOM2017-2",
  spec: "ISOM2017-2" | "ISSprOM2019-2" | "ISSkiOM2019" | "ISMTBOM2022",
  revision: "Rev 6 (20 January 2024)",
  referenceScale: 15_000,
  palette: "iof2024",
  kind: "base" | "overlay",        // default "base"; ISSkiOM2019 is the overlay (§12)
  scaleRules?: Record<group, { mapScale, factor }[]>,  // the spec's own enlargement table (§12.2)
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
  name: { en: string; sv?: string },   // sv: SOFT heading verbatim (§3)
  description?: string,            // when the variant applies
  specType: "P" | "L" | "A" | "T",
  purpleRole: "lower" | "upper" | null,   // required for 7xx, null otherwise
  orientation: "north" | "object" | null, // point symbols only
  minimum?: { lengthUm?, widthUm?, areaUm2? },   // graphical minima from the spec
  footprintM?: number,             // informational, at the reference scale
  aliases: { library: string; code: string }[],  // older-spec codes, headings only; library ∈ ALIAS_LIBRARIES (§3, checked in §5)
  render: LibraryRender,           // RenderSymbol minus id/code/name, colours as palette ids
  notes?: string,                  // deviations and tool-dependent choices
  source: string,                  // citation, e.g. "ISOM 2017-2 Rev 6 (…), §3.8"
  scaleGroup?: string              // its scaleRules row set; required exactly when the library has scaleRules
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
  documents, §3.8 / §4.8 "precise definitions"; ISSkiOM 2019 Revision 4,
  §3.3, for the overlay — §12). The OpenOrienteering
  Mapper symbol sets were used as a cross-check for shapes the spec only
  draws (713 cup, 710 crossing-point flares, 512.1 bridge ends), never
  copied — they are GPL and not in the repository. Where OOM and the Rev 6
  text differ (ISOM 104 top line 0.25 mm, ISSprOM 105.1 0.27 mm, 509.2
  0.08 mm black, 709 stripes 0.4 mm, 710.1 0.5 mm lines, 533 new) the text
  wins and the entry says so.
- **Units** are paper micrometres at the library's reference scale;
  glyph coordinates are y-up and x along the line direction, so tags and
  half-dots that the spec draws on the right-hand side are at **−y**.
  A **point** symbol's angle 0 is north (`orientation: "object"` turns it
  with the object's angle), so a directional point glyph that the spec
  draws pointing down at angle 0 points to **+y**: the 101.b / 103.b
  slope lines run from the contour to +y, as OCAD's sets (element
  0,0 → 0,40) and Mapper's ISOM set (0,0 → 0,−470, y-down) draw them,
  which puts them downhill on imported maps (B10; the first edition drew
  them to −y by analogy with line tags). A point symbol the spec says
  "is orientated to north" is `orientation: "north"` (ISOM and ISSprOM
  111 small depression, 112 pit, 115 landform feature).
  `ring` takes the *outer* diameter; `ringCC` the centre-to-centre
  diameter plus line width, which is how the course symbols are stated
  (703 ø 5.0 CC + 0.35 → outer 5 350).
- **Tool-dependent details follow OCAD** (03 §6.4): dash layout is
  `"ocad"` (sections start and end with a full dash, `DASH_NOTE`),
  irregular spec patterns ("random" boulder fields, 208/209 triangles,
  210–212 stony ground) are regular — optionally shifted — grids as
  03 §6.2 decided, pattern grids rotate with the object angle unless the
  spec says north-fixed. Line constructions follow the OCAD sets where
  the spec draws only the result: the **509 / 509.1 railway** is white
  dashes 1.0 / 1.5 mm, 0.25 mm wide, over a black 0.45 mm band (OCAD's
  double-line fill; IOF's white-for-railway sorts *above* black, so a
  black dashed main under a white band cannot draw it), and its ends are
  black by shortening the white main 1.5 mm at each open end — the spec's
  "two black dashes" wins over OCAD's sets, which end on a white dash.
  Pylons on **510 / 511 / 511.b** are `corners` (§4.5 rule in
  `map-rendering.md`: flagged vertices, ends only when flagged): OCAD
  corner symbols and Mapper dash symbols both arrive as corner flags
  (`map-import.md` §3.3, §4.2), and no importer produces dash-point
  positions for them. The 510 bar reaches 0.3 mm beyond the line's edge
  on each side (±0.37 mm), the reading 511 already used for "0.3 (OM)".
  Pointed ends that the spec dimensions taper over `main.taper` (107
  erosion gully, 0.75 mm at each end).
- **Colour order is Appendix B's, even where it hides a band.** ISOM
  508.b's yellow 100 % band sorts under the 406–410 greens, so the ride's
  yellow band shows in white forest and over 403 / 404 but not inside
  green. OCAD's ISOM 2017-2 set ("Narrow Ride" yellow below the greens)
  and the legacy tiles draw it the same; only Mapper's set adds a yellow
  above green. User decision 2026-10-22 (B10): kept and documented, no
  Oxygen-only palette row; ids are stable, so one can be added in a
  later release if a club needs it.
- **Colours are palette ids, never CMYK.** `validateLibrary` rejects an
  id outside the spec's own tick marks, so an ISOM entry cannot use
  `brown100` (an ISSprOM-only row) by accident.
- **Course symbols are ordinary entries** with `purpleRole` per 03 §2.4,
  except ISOM 704 (below): ISOM 704 upper like ISSprOM 704 (library
  `2026.10.4`, user decision 2026-10-24: legibility, and what Mapper and
  Purple Pen draw — a deliberate deviation from ISOM 2017-2, which lists it
  lower; 701, 703, 706 stay lower), ISOM 710 lower / ISSprOM 710.1 lower
  + 710.2 upper, 702 / 707 / 709 / 711 / 714 upper, the rest lower. A
  lower-role entry never draws in `purple-upper` and vice versa (tested).
  Minima that drive the course editor (707 ≥ 4.5 mm, 709 ≥ 3 mm wide and
  9 mm², 714 ≥ 0.5 mm wide and 0.25 mm²) are on the entries.
- **Names** are the spec's English headings. `name.sv` is the heading of
  the Swedish Orienteering Federation's (SOFT) translation, **verbatim**
  (user decision 2026-10-20): *ISOM 2017-2 Internationella Kartnormen,
  svensk översättning, revision 6* (1 March 2024) and *ISSprOM 2019-2
  Internationella Sprintnormen, svensk översättning, revision 5* (1 October
  2022; no Swedish Rev 6 exists). Both are © Svenska Orienteringsförbundet,
  CC BY-ND 4.0; the licence allows verbatim reproduction in part with
  attribution, so headings are never reworded, and the attribution is the
  `SV_SOURCE` constant in each library's `common.ts` (exported as
  `symbolLibraryNameSources`, printed on the contact sheet) plus this
  paragraph. An ISSprOM heading takes the rev 5 Swedish name only where
  rev 5 has the same symbol under the same code — the one exception is
  `105.1`, rev 5's `105 Liten jordvall`, the same symbol before Rev 6
  renumbered it; a heading the translation lacks has no `sv` and is listed
  in §3.2 — absence is the mark, nothing is invented. SOFT has no
  ISSkiOM translation, so the overlay has no Swedish names and its
  `SV_SOURCE` is `null` (§12.4). The names live in a
  per-library table (`<library>/names.ts`, keyed by the entry id after the
  library prefix) that `withNamesAndAliases` (`authoring.ts`) attaches to
  the entries, so names and drawings are edited independently; the helper
  throws on a key no entry owns.
  A **variant** entry's `sv` is the heading's Swedish name followed by
  `", "` and a qualifier translated by Oxygen from the variant's English
  name (`302.b` "Grund vattenyta, streckad kontur"): everything after the
  heading's own text is Oxygen's wording, never SOFT's.
- **Aliases** are the symbol's code in an older spec, `{ library:
  "ISOM2000", code }`, on heading entries only (old specs numbered
  headings). The pairs are transcribed as facts from OpenOrienteering
  Mapper's `ISOM2000-ISOM_2017-2.crt` (© Kai Pastor, GPL-3; user decision
  2026-10-20), read through Mapper's own ISOM 2017-2 code → name table
  (its `101.1`, `208.1`, … are Mapper sub-symbols, not spec codes), and
  checked against the IOF's *ISOM 2017 – What has changed from ISOM 2000?*
  (in ČSOS's Czech translation, which names the old and new numbers). A
  pair is kept when the 2017-2 heading is the old symbol's **plain
  successor**: rules whose old side is a Mapper sub-symbol, whose new side
  is a Mapper sub-symbol other than the heading's own drawing (slope line,
  contour value, cliff top line, …), and every old symbol the IOF document
  says was removed, absorbed into another heading or replaced by a
  different one (ISOM 2000 104, 105, 202, 302, 304, 314, 411, 501, 502,
  510–514, 527, 531, 532, 710) carry no alias. ISOM 2017's `105` and `513`
  are `105.1` and `513.1` in 2017-2. An old code aliases at most one
  heading; a heading may carry several (`203.1` ← 204 rocky pit and 205
  cave, which the IOF document merged). The table is `ISOM2000` in
  `ISOM2017-2/names.ts`, attached like the names. `ISSOM2007` (the 2007 sprint spec, which was ISSOM, not ISSprOM)
  is an accepted alias library but has no source table yet, so the
  `ISSprOM2019-2` entries carry none. Aliases are data for the review UI
  and future renumbering (ISOM 2030); the matcher does not read them
  (§8.2) because no map in the corpus uses ISOM 2000 numbering to tune or
  check that against.

### 3.1 Counts against the 03 estimate

| Library | Appendix A headings | Entries | 03 §6.4 estimate |
|---|---|---|---|
| `ISOM2017-2` | 113 | 152 | 180–200 |
| `ISSprOM2019-2` | 105 | 141 | 170–190 |
| `ISSkiOM2019` (overlay) | 16 of ISSkiOM's (§12.1) | 16 | — (03 §2.1: not inventoried) |

Names and aliases (B7):

| Library | Entries with `name.sv` | Headings without | Aliases |
|---|---|---|---|
| `ISOM2017-2` | 152 / 152 | — | 97 `ISOM2000` codes on 96 headings |
| `ISSprOM2019-2` | 138 / 141 | `105.2`, `533`, `715` | none (no ISSOM 2007 table) |
| `ISSkiOM2019` | 0 / 16 | all (no SOFT translation, §12.4) | none |

The estimate assumed more drawings per heading than the Rev 6 documents
actually show once the spec's own prose is followed (many "variants" are
object-level choices — dash points, corner flags, object angle — that the
IR handles without a separate entry). Coverage of every heading is
asserted, not estimated.

### 3.2 Unsourced names and omitted aliases

Swedish names absent because SOFT's ISSprOM translation (revision 5)
predates the Rev 6 symbol: `ISSprOM2019-2:105.2` *Retaining earth wall
seen only from one side*, `533` *Area with obstacles*, `715` *Continuing
point after map exchange*. They get `sv` when SOFT publishes a Rev 6
translation; borrowing the ISOM heading for 715 was considered and not
done, because the rule is one source per library.

`ISSkiOM2019` has no Swedish names at all: SOFT has published no
ISSkiOM translation (§12.4). They get `sv` if one appears.

ISOM 2017-2 headings without an ISOM 2000 alias (17): the symbols with
no ISOM 2000 predecessor in Mapper's table (`105.2`, `114`, `203.2`,
`206`, `209`, `211`, `212`, `215`, `513.2`, `522`, `532`, `702`, `715`);
`302`, which has no rule (Mapper maps ISOM 2000 302 *pond* to 301, and
the IOF document says the pond was absorbed into 302 rather than
continued, so neither heading takes it); `313`, whose Mapper rule (ISOM
2000 314) the IOF document contradicts — 314 became the 311 square; and
`113` / `603`, whose rules map only Mapper sub-symbols (117.1 / 117.2
single dots, 603.0 / 603.1 dot and text).

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

The course layer resolves the 7xx entries the same way, against the
document's aligned stack completed with upper white, and scales them by
the document factor (`docs/course-layer.md` §1, §3.1).

Registry functions: `listSymbolLibraries()`, `getSymbolLibrary(id)`,
`getLibraryEntry("ISOM2017-2:302.b")`, `entriesForCode("ISOM2017-2",
"302")` (heading first, then variants), `isOverlayLibrary(id)` and
`libraryFactor(id, mapScale, code?)` (§12.2). Libraries are parsed once
and cached. `SymbolLibraryId` names all three; the library preview route
(`map-storage.md` §4.5) serves the overlay's swatches like the others'.

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
| alias library outside `ALIAS_LIBRARIES` (`ISOM2000`, `ISSOM2007`) | `alias library "x" is not one of ISOM2000, ISSOM2007` |
| the same alias twice on one entry | `duplicate alias ISOM2000 303` |
| an alias on a variant entry | `aliases are for heading entries only` |
| a variant's `sv` not `<heading sv>, <qualifier>` / heading without `sv` | `variant name should start with "<heading sv>, "` / `variant has a Swedish name but its heading has none` |
| point without `orientation` / non-point with one | `point symbols need an orientation` / `orientation is only for point symbols` |
| a 7xx entry in an overlay library | `an overlay library has no course symbols` |
| a `scaleRules` row set listing one scale twice / without factor 1 at the reference scale | `scale group "g" lists 1:s twice` / `scale group "g" needs factor 1 at the reference scale 1:s` |
| an entry without `scaleGroup` on a library with `scaleRules`, or naming a set it lacks / `scaleGroup` on a library without | `entries need a scaleGroup when the library has scaleRules` / `scale group "g" is not in the library's scaleRules` / `scaleGroup needs scaleRules on the library` |
| `render` does not resolve to a valid `RenderSymbol` | the resolver's / Zod's message |

The registry throws if any shipped library has any problem, so a bad
entry fails every consumer at import time rather than at draw time.

## 6. Tests

`packages/shared/src/symbol-library/__tests__/` implements 03 §6.4 (a)–(c)
plus the purple-role and materialisation checks:

- **palette.test.ts** — 44 / 43 rows per edition in Appendix B order
  plus `white-skio`, the 2022 overrides (brown, green, black 30 %, olive
  name), per-spec tick counts (ISOM 29, ISSprOM 33, ISSkiOM 20 / 19 in
  2022, listed in order), the §2.4 layering as stack-index inequalities
  (and the ISSkiOM order of §12.3), prefixed stack ids and CMYK → hex.
- **library.test.ts**
  - (a) all three libraries parse, `validateLibrary` is empty, every entry
    cites its edition (`<spec> Rev 6`, `ISSkiOM 2019 Revision 4`), heading
    entries precede variants; deliberately broken copies produce each
    `validateLibrary` message, the overlay and scale-rule ones included.
  - (b) hand-typed Appendix A heading lists (113 ISOM, 105 ISSprOM) and
    the 16 ISSkiOM overlay headings typed from the ISSkiOM text each have a
    heading entry, and no entry uses a code outside its list.
  - (c) hand-typed dimension tables per spec (≈ 70 ISOM and ≈ 60 ISSprOM
    assertions on widths, dash lengths, diameters, grid cells, spacing,
    border shifts, halo colours, minima), including every Rev 6 change
    that differs from the earlier revisions and from OOM, and the B10
    drawing corrections: slope-line ticks to +y, 107's taper, ISOM 111
    north, 509 / 509.1 white-over-black with black ends, 510 / 511 /
    511.b pylons at corners with 510's ±0.37 mm bar; and a table for every
    ISSkiOM entry (§12.1: widths, dashes, dots, the white mask, the
    compulsory edges, 813's bands, 808's cross-hatch, the water / marsh
    variants).
  - **the overlay (§12)** — `isOverlayLibrary`, no base heading code and
    no 7xx, `chooseLibrary` never returns it, the exact palette ids it
    uses, no names or aliases, the 2022 edition rejected; **`libraryFactor`**
    — base libraries `referenceScale / mapScale`, ISSkiOM §3.2's table typed
    by hand per scale group, nearest-by-ratio for unlisted scales, the tie
    rule, and the throws.
  - (d) purple roles per 03 §2.4 for every 7xx entry; lower entries never
    use `purple-upper` and vice versa; ISOM-only (711–713) and
    ISSprOM-only (710.1/.2, 714) codes are not cross-listed; the overlay
    has none.
  - (e) `materialiseLibrary` for every library: every colour index is
    inside the stack, every entry symbolised against a representative
    object (line with corner + dash point, 20 × 20 mm area at 30°, point at
    45°, text "31") emits at least one pass and no warnings; the 2022
    edition yields identical symbols with only CMYK changed; resolved
    symbols carry id/code/name; 107 in both editions symbolises to a
    pointed stroke pass carrying its 0.75 mm taper (the contact sheet
    cannot show it: the reference raster draws `pointed` as butt).
- **The ISSkiOM overlay on any document (G21)** — `import/__tests__/matcher.test.ts`
  "overlay candidates": `entryFactor` (own library, tracks ×1 and other
  ×1.5 at 1:10 000, symbol scale, ISSprOM), every track drawn to spec is
  `auto` to its entry with the document library's `libraryVersion`, the
  same line at the document factor is not, ×1.33 at 1:7 500, an `821`
  never joins the overlay family, 301.1 / 301.2 / 310.1 at stage 2 and
  Mapper's ISOM 301 numbered `301.1` stays ISOM's, every ISOM and ISSprOM
  entry outside the overlay's codes matches deep-equal with and without
  the overlay, a 2022 document matches 803.2, a decision naming an
  overlay entry; `colour-class.test.ts` `skiPaletteIdFor` (names in
  English and Swedish, other hues, trail words, the inks by position,
  OCAD's orange); `colour-align.test.ts` "ISSkiOM's rows in every stack"
  (identified not inserted, all four once with their positions and CMYK,
  no new conflict, never aliased, Mapper's railway-white order, a copy
  of upper purple at the bottom, inserted rows out of step 5b, both specs
  and editions with the 2024 orange, every track entry resolves on four
  tables incl. Ny_karta_test and Ungdomsserien); `match-document.test.ts`
  "on a ski map" (a 1:10 000 map's 801.1 `auto`, the mapper's colours
  identified, drawn by the bridge at 850 µm with `canonicalMissing` 0);
  `api/…/import-ocad.test.ts` (the fixture's inserted list and the three
  top rows); integration `map-import-jobs.test.ts` (the stored document's
  stack, `ocad-17`, `@2026.11.1`); `map-rematch-cli.test.ts` (a pre-G21
  document is stale); `scripts/__tests__/measure-import.test.mjs` (the
  `ski-o` line).
- **Course purples placed by rule (C15)** — `import/__tests__/colour-align.test.ts`
  "course purples placed by rule" on Nackareservatet 2023's colour table
  (`club-colour-tables.ts`: names, CMYK, order and usage only): lower
  purple inserted between "Brun gc-vägar nära hus" and "Brown 100% - Line
  Feature" with only the stray text mask above it, the top "Violett"
  reused as upper purple, the other five source purples displaced in
  source order (`position` ×4, `duplicate` ×1) with their CMYK and no
  palette ids or role, one row per purple id, no purple conflict, one
  ink, the ski rows against the placed rows; a sprint and a forest table
  whose purples are right keep `ocad-17`'s stack row for row; the ski
  rows against an inserted lower purple with a displaced upper copy
  between it and the top; an inserted pair takes the map's most used
  purple ink; Vinterserien's shape re-expected (§9.2 step 5a);
  `match-document.test.ts` (a displaced purple in `colourStack`, the
  mapper's purple line still drawn in it); `report.test.ts`
  (`purplesDisplaced` optional, roles checked);
  `scripts/__tests__/measure-import.test.mjs` (the `purple` line with
  `upper at … (source)`); `api/…/import-ocad.test.ts` unchanged on
  `e2e/test.ocd`.
- **`import/__tests__/fingerprint.test.ts`** — C9: cap / join classes (bevel = miter, square = flat), round vs flat same width and colour = 0.903 and above `auto`, each field once, `null` without a main stroke, 201.b vs a flat 0.35 stroke; `matcher.test.ts` — a source round no-tag 201 takes 201.b at 1.0, a flat one scores ≤ 0.91 and never auto-matches the tagged 201. Also — OCAD's railway (white
  dashes over a black band) and OCAD's power line (corner symbol) score
  `auto` against 509 / 510; `render/__tests__/library-fixtures.test.ts`
  rows 3 and 6 (`map-rendering.md` §6.1) hold the pylon and railway
  passes; its "colour-order equivalence" block pins §8.1's inversion
  rule (Mapper's black dashes over white score `auto` against 509; a
  coloured band, other-class rails and a solid stroke still hard-fail);
  `api/src/__tests__/import-omap.test.ts` states that Mapper's railway
  is `auto` against `ISOM2017-2:509` (A15).

- **names.test.ts** — every heading has `name.sv` except the §3.2 list
  (all 16 ISSkiOM headings, whose `sv` source is `null`);
  hand-typed spot tables of SOFT headings (23) and of ISOM 2000 pairs the
  IOF change document states (18), typed from the sources, not from
  `names.ts`; every variant name is `<heading sv>, <qualifier>`; aliases
  only `ISOM2000`, only on headings, no old code on two headings, none for
  the IOF document's removed / absorbed symbols; each new `validateLibrary`
  message on a broken copy; `withNamesAndAliases` rejects an unowned key
  and an alias on a variant.
- **(d) contact sheet** — `e2e/__golden__/library/<libraryId>/<entry>.png`,
  one per entry (`302.b.png` for `ISOM2017-2:302.b`), is the entry's
  swatch exactly as the library preview route serves it
  (`docs/map-storage.md` §4.5; the swatch scene of
  `docs/map-rendering.md` §5.1.1 at 10 px/mm, points ×3, against the
  library's own palette stack, no supersampling), and
  `e2e/__golden__/library/<libraryId>.md` is a generated index (swatch,
  entry, type, English, Swedish, aliases, plus the name sources). Both are
  written only by `pnpm --filter @oxygen/api golden:render` (which also
  removes PNGs no entry owns) and reviewed as image diffs in the PR.
  `packages/api/src/render/__tests__/library-golden.test.ts` fails on a
  missing or extra PNG, on any committed PNG whose pixels differ from a
  fresh render (channel tolerance 1, the `golden-files.test.ts` rule —
  pixels, not bytes, so a libvips upgrade does not churn the files), and
  on a stale index; a determinism check renders one entry of each IR type
  twice and requires identical bytes. A change to an entry *or* to the
  symbolisation stage therefore fails here until the sheet is regenerated
  — whichever branch merges second regenerates it. The ISSkiOM sheet is
  `e2e/__golden__/library/ISSkiOM2019/` (16 PNGs) and its index; the
  determinism check includes 813.2 and 804.2.

- **`map-document/__tests__/materialise.test.ts`** (§11) — every entry
  of all three libraries on six fixtures (the small match fixture, the
  same ×1.5, an ISSprOM document, the small one with the ski rows
  appended, `e2e/test.xmap`, `puit-de-laven.omap`) either materialises
  (a `patchSymbolSchema` parse fixed point, no `match` or `sourceIndex`,
  every colour index inside the stack) or reports exactly `colourRefs`
  minus the stack's ids; an unknown id is a result; an own-library entry
  equals `canonicalRender` of a document symbol auto-matched to it; same
  input, same JSON, also from a second decode of the same map; the stack
  untouched; ISSkiOM 801.1 missing `green-skio` / `white-skio` on a plain
  stack, materialised with the ski rows, 801.2 still missing
  `orange-skio` without it; the factor table (1:10 000 at 1.5 and at 1 —
  symbolScale ⅔ —, 1:7 500, 1:5 000, the other base library both ways, a
  never-matched header); a materialised symbol put in a patch and used by
  an `add` applies without issue and is drawn from its own render. The
  "without the ski rows" cases strip the overlay ids from the rows
  alignment inserted (a document stored before G21).
  `mapPalette`: group order and presence (ski group with the stack, with a
  ski patch symbol), headings in code order with the library heading's
  names, variants under their heading, document items by match or source
  base, unused ones kept, hidden / graphic / text / proxy-drawn left out,
  the mapper's own 7xx kept and the library's 7xx and text entries left
  out, covered entries not repeated, the other base library not offered,
  disabled items with `missing`, patch items (library, overlay and a
  non-library key), every enabled ref applying as an `add` of its kind,
  the order inside a heading (applied match, objects, index; patch items
  by key between document and library items), `compareSymbolCodes`, an
  effective document refused, determinism, the sprint palette.

The OOM dimension spot check (e) is not implemented; see §10.

## 7. Deviations from 03 §6.4, recorded

| 03 said | Done | Why |
|---|---|---|
| Entries as authored JSON files | TypeScript literals via `authoring.ts` helpers | Compile-time colour-kind and field checks; the IR nests too deeply for readable JSON. The Zod schema still validates the result, so a JSON loader can be added without touching entries. |
| `fingerprint` overrides per entry | Not needed | Fingerprints are derived from the resolved IR (§8.1) and the matcher never needed a hand override on the corpus; add the field if one does. |
| `name.sv` alongside `name.en` | SOFT headings verbatim, variants as heading + Oxygen qualifier, 3 ISSprOM headings without (§3, §3.2) | The licence (CC BY-ND 4.0) allows verbatim headings only; no Swedish ISSprOM Rev 6 exists. Supersedes the first edition's "complete translation or none". |
| "a golden render per entry at 10× into a contact sheet" | One PNG per entry plus a generated Markdown index, 10 px/mm, the served swatch (§6 (d)) | Per-file images show in a PR exactly which entries changed (293 files, 0.5 MB); equality with the review UI's swatch matters more than the 4× oracle the GL goldens need, and no backend is compared against these. |
| `aliases` as given | `ISOM2000` only, plain successors only (§3) | Mapper's CRT is the only table; the IOF change document rules out the merges. No ISSOM 2007 table exists on disk. |
| Appendix B palette as a "versioned table" | Two editions, ids stable, document picks edition | Same intent; the id stability rule is what keeps entries edition-free. |
| 180–200 / 170–190 entries | 152 / 141 | Counted against Rev 6; §3.1. |
| One library per specification, every heading covered (03 §6.4); ISSkiOM "not inventoried" (03 §2.1) | `ISSkiOM2019` is an **overlay** of 16 ski headings — §3.3.1's tracks and §3.3.2's water / marsh variants — offered beside a document's own library (§12; slice G answer 9, user scope 2026-11-13) | A ski-O map's base symbols are ISOM 2017-2's; the ski symbols are what a mapper adds, also to a summer map. ISSkiOM's base-symbol deviations and course symbols wait (§10). |
| ISSkiOM "scales the symbol set and course symbols by different factors — encode as `scaleRules`" (03 §6.6) | `scaleRules` per row set (`track`, `other`) with `scaleGroup` per entry; `libraryFactor(id, mapScale, code?)` (§12.2) | ISSkiOM §3.2 has two symbol columns, and the overlay holds entries of both; its course symbols' sizes are fixed at every scale (Rev 4). |
| Appendix B as the palette | Plus a `white-skio` row and an ISSkiOM tick on `green100-area` (§12.3; user decisions 2026-11-13) | ISSkiOM's own colour lines name a white under lower purple and green 100 %, which its column of the IOF table lacks. |
| Railway "black, white" drawn as stated: black dashes, white between, rails | 509 / 509.1 are white 0.25 dashes 1.0 / 1.5 over a black 0.45 band, the white shortened 1.5 mm at each end (§3; B10) | Appendix B sorts white-for-railway above black, so the first edition's black dashes under a white band drew all white inside. The OCAD construction is the only one the palette allows; the black ends follow the spec ("two black dashes"), not OCAD's sets (white end dash). Consequence: OCAD railways built to the spec's widths now match (Sprint's 509.100, white 0.26 in black 0.45: `auto`); club-2026's / club-full's 509.1 (white 0.21 in black 0.35 — the set reads "0.35" as the outer width) stays unmatched, now on width instead of colour; Crop-A / Crop-B's grey 509.0 stays unmatched; Mapper's railway (black dashes over white, Mapper's own colour order) hard-failed on main colour for the 2026.10.3 release alone (`e2e/test.xmap`: `auto` 5 → 4 symbols); the fingerprint now reads both constructions as one (§8.1, A15) and it is `auto` again. |
| Glyph placement per 03 Appendix C (Mapper dash symbol → `dashPoints`) | 510 / 511 / 511.b pylons at `corners` (B10) | Both importers deliver pylons as corner flags (`map-import.md` §3.3, §4.2); no importer produces dash-point positions for them, so canonically drawn power lines had no poles and the fingerprint missed on placement. |
| Directional point glyphs: no convention stated (03 §6.2) | Angle 0 = north, slope ticks to +y (§3; B10) | OCAD and Mapper both draw the 101.b / 103.b tick to +y; the first edition used the line-tag convention (−y) and every auto-matched slope line pointed uphill (52–66 % shape difference, `map-rendering.md` §6.4). |
| 510 "0.3 (OM)" bars | ±0.37 mm, 0.3 beyond each edge of the 0.14 line (B10) | The reading ISOM 511 already used; Mapper's ISOM set and both corpus OCAD sets draw ±0.37 (−0.38 … +0.33). Was ±0.3. ISSprOM 511 (unchanged) measures its 0.3 from the line centre (±1.12 at ±0.82), as OCAD's ISSprOM set does — Sprint's 511 matches it at 1.00; the spec drawing does not settle which. |
| 508.b yellow band as drawn (visible in forest) | Appendix B order: hidden under 406–410 green (§3; user decision 2026-10-22) | No yellow row above green exists in Appendix B; OCAD's set and the legacy tiles agree. |
| Cliff baselines flat / miter (the spec drawing) | ISOM 201.b, 202, 202.b and ISSprOM 202 (no-tag baselines) round joins and ends; tagged 201 stays miter / flat (library `2026.10.4`; user decision 2026-10-24) | OCAD's own ISOM 2017-2 / ISSprOM sets draw them round (`lineStyle 1`) and Swedish OCAD maps use the round baseline plus separate tag objects. Mapper's sets draw flat; cap/join as a fingerprint class is SLICES C9. |
| ISOM 704 control numbers lower purple (03 §2.4) | Upper purple, as ISSprOM 704 (library `2026.10.4`; user decision 2026-10-24) | Legibility: numbers sit above the black and brown map ink instead of under it, as Mapper and Purple Pen draw them. Start, circles and finish stay lower per spec. |
| `defaultMapAppearance` in `course-maps/schema.ts` retired in favour of the library | Retired for the vector path (C0): the course layer draws the 7xx entries × document factor × the template's appearance as multipliers (`docs/course-layer.md` §3.1); the constant stays as the legacy overlay's sizes and the multipliers' denominator (`appearanceFromTemplate`). The vector viewer reads the library's sizes from the course layer (C4, `map-rendering.md` §5.4 "Overlay"); `web/lib/course-map-types.ts` keeps it as a new template's stored appearance, which is multiplier 1 — the spec sizes — on the vector path | The legacy SVG overlay and stored templates still read it; deleted with them (§10). |

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

Beside the document's library every overlay library's entries are
candidates (`ISSkiOM2019`, §12; "Overlay candidates" in §8.2):
`matchContext(libraryId, edition, factor, classOf, decisions?, mapScale?)`
adds them when it is given the map scale, which `matchDocument` and
`reviewRows` always pass.

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
| line | main stroke class + width, cap / join class of the main stroke, dashed (dash / gap lengths), borders (count, class, width, shift), double-line fill class + width, background halo, glyph presence and its stroke/disc/ring/fill counts, structural shape (`stroked`, `background`) |
| area | fill class, hatch (class, width, spacing, angle), pattern (class, cell, element kind + size), border |
| point | glyph parts by kind with class, width / diameter, extent box, rotational symmetry, `orientation` |
| text | class, font size (from the digit height when given), bold / italic — no line spacing, no alignment, no tab stops and no frame or shadow, so a Mapper alignment variant shares its parent's fingerprint (`docs/map-import.md` §4.4) and none of the layout fields a canonically drawn text keeps from its source (`docs/map-document-format.md` §8) is evidence for or against a match |

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

**Colour-order equivalence (A15, `ocad-12` / `omap-6`).** One construction
is normalised, because 03 §6.5 compares colour classes and the same
picture can be painted in two orders: *ink dashes over a white band
between ink rails* (Mapper's railway: main stroke black 0.35 dashed 1.5 /
1.0, borders black, `backgroundColour` white) is fingerprinted as *white
dashes over an ink band* (the library's 509 / 509.1, OCAD's double-line
fill): main colour = the white band, main width = the band between the
rails (`2 × shift − rail width`), dash and gap swapped, no borders,
`background` set. It applies only when the main stroke is dashed and
inked, the borders share its colour class, `backgroundColour` is white
and the symbol has no glyphs (`invertedBand`). The white band counts as
structure only here; there is no general colour reordering, so a coloured
band, rails of another class or a solid stroke over white still
hard-fail on main colour / dashed (user decision 2026-10-22). Mapper's
511-coded power line is unchanged: it gains only a `suggested` 510.

**Line cap / join (C9, `ocad-14` / `omap-8`).** A stroked line's
fingerprint carries the main stroke's `cap` and `join` as a *round-vs-sharp
class*: cap `round` / `pointed` / `flat` (`square` = `flat`), join `round` /
`sharp` (`bevel` = `miter`: OCAD's default `lineStyle 0` is flat/bevel and
template sets state flat/miter for the same stroke, so neither is an
explicit choice). Glyph-only and border-only lines carry `null` and are
not compared (nor is A15's normalised railway band, `null`). **Decision (implementer's, recorded for coordinator confirmation): a soft tie-break, not a hard fail** — each of
cap and join that differs multiplies the score by `CAP_JOIN_PENALTY`
(0.95; both: 0.903). The class still lets a source's explicit round-vs-flat
choice select the matching library variant (the round no-tag 201.b / 202
against the flat tagged 201; source `lineStyle 1` scores 1.0 against the
round entry and 0.903 against a flat one), but a hard fail would make a
round-ended source with no round variant in the library fall from `auto`
to `unmatched` when only the end shape differs — a drawing choice, not a
different symbol — whereas 03 §6.5's hard fails are for *what* is drawn.
The penalty is deliberately below the 0.95 stage-4 strictness: stage 4
(geometry-only suggestions) divides it out (`Comparison.capJoin`), so cap
and join never withhold a geometry suggestion, and they are not part of
the document-factor measurement. Corpus effect: no `auto` became
`suggested`; the 0.903 lines are the source's explicit
flat/miter against a round library entry (201.14, 512, tagged 104).
`irHash` changes for every stroked line, so club decisions keyed by
`irHash` for lines are stale and re-match (§8.5).

### 8.2 Stages

`matchSymbol(source, ctx)` runs the 03 §6.5 ladder and stops at the first
stage that decides. Thresholds (`MATCH_THRESHOLDS`, reported in the
summary so tuning is visible): auto 0.85, suggest 0.6, strict 0.95.

| # | method | Candidates | Outcome |
|---|---|---|---|
| 1 | `explicit` | a `SymbolDecision` for (code, name?, irHash?) | `auto` + `reviewed` for an entry id (of the document's library or an overlay's, §8.5); `unmatched` + `reviewed` for `canonicalId: null` (keep the source drawing). A decision naming an entry the library lacks falls through and warns `DECISION_UNKNOWN_ENTRY`. |
| 2 | `code+geometry` | entries with the source's exact spec code (`505.1` → `505.1`) | `auto` at ≥ 0.85 |
| 3 | `family+geometry` | same base number (`505.3` → every `505*`), else the hundred group | `auto` ≥ 0.85, `suggested` ≥ 0.6 |
| — | `variant` | family exists, source IR type differs from every family entry, name carries a template-variant hint (`VARIANT_NAME`: minimi, enskild, kontur, outline, single dot, …) | `unmatched`, drawn from source, counted separately — a minimum-size building point or a cliff outline line is not a mistake and not a review item |
| 4 | `geometry` | every entry of the IR type | `suggested` only, at ≥ 0.95 (never auto: a 0.14 mm brown line is a contour or a form line only by its code) |
| 5 | `description` | same type, not ruled out by a hard fail, ≥ 2 shared name tokens, or 1 token when the code matches or the geometry is partly compatible. Source tokens go through the Swedish → English lexicon `SV_EN`; an entry's tokens are the union of its `name.en` and `name.sv` tokens (the latter through the same lexicon), so a Swedish source word the lexicon lacks still meets the SOFT heading | `suggested` at 0.3 + 0.1 × tokens, capped 0.5 |
| 6 | `none` | — | `unmatched`, warns `SYMBOL_UNMATCHED` |

**Overlay candidates** (G21; slice G answers 8, 9). The overlay's entries
(§12) join the ladder on every document, with these limits:

- **Exact code, for every source.** Stage 2 scores the overlay entries
  of the source's exact code beside the document library's, so a source
  `301.1`, `301.2` or `310.1` meets ISSkiOM's water and marsh entries on
  any map. Geometry separates them from the base symbols those numbers
  also name (Mapper numbers ISOM 301 as `301.1`: blue 100 % with a black
  edge, a hard fail against ISSkiOM's blue 50 %).
- **Family, geometry and description only for an 8xx source.** Stages
  3–5 add the overlay entries when the source's hundred group is 8.
  There is no hundred-group fallback into the overlay: an 8xx code
  without an ISSkiOM heading (`821`, `850.1` — club texts and frames in
  the corpus) meets the overlay only in stages 4–5, never as a family,
  so it never becomes a `variant`.
- **Scored at the entry's own factor.** An overlay candidate is compared
  at `entryFactor(doc, entryId)` = `libraryFactor(overlay, mapScale,
  code) × symbolScale`, with `symbolScale = documentFactor /
  libraryFactor(document library, mapScale)` unrounded (§12.2): a 0.85 mm
  green line on a 1:10 000 ISOM map (document factor 1.5) is 801.1 at ×1,
  and the same line at 1.275 mm is not. The factor shows in the reasons
  (`ISSkiOM2019:802.1 0.97 at ×1.333`).
- **The document's library first.** On an equal score the document's own
  entry ranks before an overlay entry, then ids.
- **Never the document factor.** Overlay entries take no part in
  `detectDocumentFactor` or in the scale-anomaly check; their widths
  follow their own table.
- **Fingerprinted on the overlay's palette in 2024**, whatever the
  document's edition (the 2022 ISSkiOM stack has no `orange-skio`; the
  rows the overlay uses classify the same in both editions).

`match.libraryVersion`, `matching.library` and the decision rows stay
keyed by the document's library: an overlay entry is something a
document of that library draws, not a second library.

Every match carries `reasons[]` (the feature notes of the deciding
comparison, e.g. `glyph height 6000 vs 1200 µm (0.00)`), `confidence`,
`libraryVersion` (`<library>@<SYMBOL_LIBRARY_VERSION>`) and, for stages
2–4, `alternatives[]` (runner-ups for the review UI). Exact-code *lines*
that fit only at another `FACTOR_SNAP` factor are reported as
`scaleAnomalies` (`SYMBOL_SCALE_ANOMALY`) — an earth bank drawn at 1:10000
size in a 1:15000 table.

What is drawn: `auto` and reviewed matches resolve the library entry
against the aligned stack (§9) and are scaled by the document factor —
an overlay entry by its `entryFactor` (§12.2; `canonicalRender` in
`map-document/render-bridge.ts`), the factor it was scored at;
`suggested`, `unmatched` and `variant` keep their source IR
(`map-document/render-bridge.ts` `isAppliedMatch`, `canonical:false`
turns this off). Reviewing a suggestion is `mapImport.review` /
`decide` / `finalise` (`docs/map-import.md` §2.2); decisions persist as
club rows (§8.5) and come back through row 1.

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
These shares predate library `2026.10.3` (B10), which moved 2–4 more
symbols per map to `auto` (ISOM 111, 510, ISSprOM 509.1, 510,
511; counts in `map-rendering.md` §6.4 and the decision log); not
re-measured by objects.

**Swedish entry names in stage 5 (B7, `ocad-8` / `omap-3`, library
`2026.10.2`).** Re-measured on all five corpus maps against the same code
with `name.sv` left out (`b7-description-sv.txt` in the same
`.local/research/oxygen-measurements/` directory):
`auto` objects and symbols are unchanged on every map, as they must be —
stage 5 only ever suggests. Description suggestions rise from 22 / 22 /
19 / 19 / 20 symbols to 25 / 25 / 28 / 28 / 27 (Club-full, Club-2026,
Crop-A, Crop-B, Sprint), and 3–9 symbols per map move from `none` to a
suggestion; suggested objects +0.0 to +0.6 percentage points. Every new
suggestion was reviewed: all name the right heading or a better variant
(`203.7 Passerbar brant` → 202, `502.1 Bred väg >7m` → 502, `711.1
Förbjuden väg` → 711 instead of 503, `709.1 / 709.3` → `709.c` / `709.b`,
`104.5 Mycket hög skärning` → `104.b`) except two weak one-word
suggestions kept as review items: `503.12 Gc-väg i radhusområden` → 711
*Förbjuden väg* (the shared word is *väg*) and Sprint `511.1 Större
kraftledning (fyrkantiga stolpar)` → 511 instead of `511.b` (a name tie
broken by id; 0 objects). Two traps the Swedish headings exposed are
handled by the tokeniser: Swedish function words (`eller`, `som`, `en`,
`till`, …) are stopwords — `en` is also *juniper* in club symbol names,
accepted because stage 5 only suggests and the corpus has no such case — and the word after a negator (`utan`, `icke`,
`ej`, `inte`, `without`, `non`, `not`, `no`) is dropped, so `Stig eller
spår utan belagd yta` does not share *paved* with `Belagd gångbana`.

**ISSkiOM overlay (G21, `ocad-17` / `omap-10`, library `2026.11.1`).**
Measured on all five corpus maps with `scripts/measure-import.mjs`
against the code before G21: symbol and object outcomes, the method
histogram and the document factor are identical on every map (no corpus
map has a ski symbol; its 8xx codes are club texts and frames, which
the no-fallback rule keeps out of the overlay family). The colour stack
grows by the three ISSkiOM rows on every map — every map has its own
green 100 % area colour — lower purple moves up one index (the track mask
below it), and the areas above lower purple, the order conflicts and the
warning histogram are unchanged. Two placement rules came from this run
(§9.2 step 4): the track inks are placed searching up from lower purple
(Club-full keeps a copy of its upper purple at the bottom of the table,
which put them under the whole map), and inserted overlay rows take no
part in step 5b (an inserted row tipped the longest increasing
subsequence and `e2e/test.ocd` reported a different pair).

### 8.5 Club decisions (06 §5.3)

A reviewed outcome outlives the document it was made on: next year's
edition of the same club map has the same symbols. Decisions are rows of
`club_symbol_decisions` (`docs/map-storage.md` §2), written only by
`mapImport.decide` (`docs/map-import.md` §2.2) and read by stage 6 as the
`explicit` stage (§8.2 row 1). The matcher never writes them.

**Fingerprint.** `"<source kind>:<code>:<irHash>"` — `ocad:527:1a2b3c4d`
— with the normalised spec code and `irHash = fingerprintHash(fingerprintOf(render, classOf))`
(§8.1). The IR type is part of the fingerprint the hash covers; the
symbol *name* is not, so a rename keeps its decision and the same code
drawn the same way is the same symbol. The string stays readable so a
CRT export can carry it in a comment (A7). `documentSymbolFingerprints(header)`
computes it from a stored document: colour classes are per colour
(`classifyColour`), so the aligned stack of the header gives the same
classes as the source stack the matcher saw, and the remapped render the
same hash (unit-tested equal). `null` for non-source symbols and for
symbols without a render.

**Library versions.** A row's `library_version` is the full
`<library>@<SYMBOL_LIBRARY_VERSION>` the decision was made against
(`ISOM2017-2@2026.10.1`), as 07 §4.3 records it. A decision is a
statement about a library *entry*, which survives a library release, so
stage 6 reads every row of the chosen library id whatever its release
(`library_version` starting with `<library>@`), and per fingerprint the
newest `decided_at` wins (ties: the later release string). A re-match
after a library bump therefore keeps reviewed rows and re-proposes the
rest (03 §6.5). An entry the new release dropped falls through with
`DECISION_UNKNOWN_ENTRY` (§8.2). `decide` writes the row under the
current release; `reset` deletes the fingerprint's rows for that library
id under every release. Rows of the other library (an ISSprOM decision on
an ISOM map) are ignored: `SymbolDecision.libraryId`, filtered by
`matchDocument` after `chooseLibrary`.

**Overlay entries** (G21; decided overnight on the user's standing
instruction, 2026-11-13, for review). A decision may name an overlay
library's entry (`ISSkiOM2019:801.1`): `isDocumentEntryId(libraryId,
id)` — an entry of the document's library or of an overlay library — is
what `decide` accepts, what a CRT rule may target (§8.6) and what
`documentFollowsDecisions` counts as applying. The row is stored under
the document library's `<library>@<release>` like any other, so no
schema changes; an ISSkiOM decision on an ISOM map does not apply to the
same symbol on a sprint map.

**Scope.** The instance belongs to one club (`docs/system/club-library.md`), so
the table has no event or series column: a decision made while reviewing
an event map applies to the club map of the same symbols and vice versa.
Rows of another source kind never apply (`omap:` rows to an OCAD file).

**Does a stored document follow the decisions?**
`documentFollowsDecisions(header, decisions)` — for every source symbol
with a fingerprint, the decision that would apply (an entry the library
or an overlay has, or `null`) equals what the header records (`method: "explicit"` with
that `canonicalId`, or no explicit match when no decision applies). The
dedup short-cut and the re-match pass (`docs/map-storage.md` §6.1, §6.9)
use it, so a document is reused only if re-importing it now would give
the same bytes.

**Review rows (06 §5.1).** `reviewRows(header, objectsPerSymbol, {edition})`
gives one row per *source* symbol (graphic and missing-symbol entries are
not review items):

```ts
interface ReviewRow {
  symbolIdx: number; code: string; name: string;
  type: "point" | "line" | "area" | "text" | "rectangle" | "unknown";  // the source kind
  objects: number;                       // from the attrs section (objectsPerSymbol)
  match: SymbolMatch | null;             // what the document draws; null before the matcher
  candidates: { canonicalId; confidence; reasons[] }[];   // ≤ 3, best first
  colourClass: string;                   // formatClass of the main stroke / fill / glyph colour
  flags: ("hidden" | "unused" | "club-symbol" | "text")[];
  fingerprint: string | null;            // the decision key; null without a render
}
```

`candidates` is the matcher's *own* proposal for the symbol, recomputed
without decisions from the stored render against the stored factor and
edition (`report.matching.edition`, else `detectPaletteEdition`): the
proposal's entry with its reasons, then its `alternatives` re-scored by
`compareFingerprints` for their reasons. A reviewed row therefore shows
the decision as `match` and what `reset` would return to as
`candidates[0]`. Reasons are not stored in the header for alternatives,
so they are recomputed here; overlay candidates (§8.2) are re-scored at
their own factor. `club-symbol` means no entry of the library or an
overlay shares the code's base number (a metro line `900`, a club's own
`821`; ISSkiOM's `801.1` is not one);
`unused` is zero objects; `text` the source kind. A pre-matcher header
(no `library`) has rows with `match: null` and no candidates.

Tests: `packages/shared/src/import/__tests__/decisions.test.ts`
(fingerprint equality between source and stored stack, name
independence, newest-wins and tie rules, library and kind filtering,
`documentFollowsDecisions` matrix incl. a dangling entry and an overlay
entry (G21), `documentLibraryId` never an overlay, review rows on
the stage 6–7 fixture with flags and candidates (an ISSkiOM heading is
not a `club-symbol`), attrs-only object counts); the API side in
`docs/map-storage.md` §10 (`map-symbol-decisions.test.ts` accepts an
overlay entry under the document library's release).

### 8.6 CRT export / import (06 §5.1, §5.3; 03 §3.2)

Club decisions travel to OpenOrienteering Mapper and back as a
cross-reference table. Code: `packages/shared/src/import/crt.ts`
(`parseCrt`, `formatCrt`, `resolveCrt`, exported as `mapImport`); the
procedures are `mapImport.exportCrt` / `importCrt`
(`docs/map-import.md` §2.2).

**Mapper's syntax**, as its reader has it (`SymbolRuleSet::loadCrt` in
`src/core/objects/symbol_rule_set.cpp`, `doc/manual/pages/crt_files.md`):
one rule per line, the first whitespace-delimited token the **target**
symbol number (the replacement set's), the rest of the line, trimmed, the
**source** — a symbol number compared as an exact string with
`getNumberAsString()`, or an object query. A line whose first token
starts with `#` is a comment; there are no trailing comments (a `#` after
the target is part of the source). Empty lines are ignored. A target the
replacement set lacks leaves the rule unassigned, not an error; of two
rules for one source the later wins; a source no rule names keeps its
symbol. Mapper writes the target padded to ten columns (`writeCrt`), and
numbers an OCAD symbol `101000` as `101.0` — which is how our OCAD reader
writes the code too.

**What Oxygen writes** (`formatCrt`), LF line ends, UTF-8, symbols in
`symbolIdx` order:

```
# oxygen-crt library=ISOM2017-2@2026.10.1 source=ocad document=<64 hex>
# OpenOrienteering Mapper cross-reference table: <target> <source> per rule. …
# fp ocad:702:d5d4a092 decision 702.0 Control point
703       702.0
# fp ocad:403:c694d305 decision 403.0 Rough open land
# keep 403.0
# fp ocad:601:f360c772 auto 601.0 Magnetic north line
601.b     601.0
```

- **Target column** = the canonical entry id without the `<library>:`
  prefix (`703`, `105.1`, `601.b`); the library is the header line's.
  Heading entries are Mapper symbol numbers of its ISOM 2017-2 /
  ISSprOM 2019 sets; **variants are not** (Mapper numbers them
  differently: our `104.b` "Earth bank, top line" is its `104.2`), so
  Mapper leaves a variant rule unassigned. That is a documented limit,
  chosen by the user 2026-10-19 over emitting the heading code (lossy: it
  would come back as the heading's drawing) or a hand-typed variant table
  (03 §10's licence question). Oxygen round-trips variants exactly.
- **Source column** = `header.symbols[i].code` verbatim (`702.0` OCAD,
  `509.0.1` OMAP) — what Mapper shows for the same file.
- **`# fp <fingerprint> <decision|auto> <code> <name>`** precedes every
  entry: the §8.5 fingerprint, then whether the line is a club decision or
  an automatic match, then code and name for the reader. Its own line,
  because a trailing comment would be read as part of the source.
- **`# keep <source>`** is a `canonical_id NULL` decision (keep the source
  drawing). Mapper has no rule for "no replacement", so it is a comment
  directive Mapper ignores — which is what Mapper does to a source no
  rule names.
- **Contents** (user decision 2026-10-19): by default the club's
  **decisions** only — every source symbol with a fingerprint and a
  decision of the document's library, read as stage 6 reads them (every
  release of `<library>@`, newest `decided_at` wins; `decisionsFromRows`).
  A decision naming an entry the library has dropped is still written; the
  import reports it. `includeMatches: true` also writes the document's
  **automatic** matches (`state: "auto"`, method not `explicit`) as rules
  marked `auto`, so Mapper gets the whole table. `suggested`, `unmatched`
  and `variant` symbols without a decision are never written.

**What Oxygen reads** (`parseCrt`, then `resolveCrt` against the
document): every Mapper CRT, with or without Oxygen's comments. A BOM is
stripped; CRLF and tabs are accepted. The `# oxygen-crt` header is
informative; `# fp` binds to the next rule or keep (plain comments in
between do not unbind it, a malformed `# fp` does); `# keep` without a
source is a bad line. Skip messages quote at most 120 characters of the
offending text.

- **Library**: decisions are recorded under the *document's* library
  (`header.library.id`, else `chooseLibrary(mapScale)`) at the current
  release, exactly as `decide` (§8.5). A header naming another library id
  warns `CRT_LIBRARY_MISMATCH` and the rules are still tried; a release
  difference is not a mismatch (a decision is about an entry).
- **Target**: the bare form (`703`, `601.b`) or a full id
  (`ISOM2017-2:703`); it must be an entry of the document's library.
- **Source → symbols**: the `# fp` fingerprint when it names a source
  symbol of this document; else — or when it names none
  (`CRT_FINGERPRINT_MISMATCH`, the symbol was redrawn since export) — every
  source symbol whose `normaliseCode` equals the rule's (`702` ≡ `702.0`).
  A `# fp` whose code is not the rule's source is not used either (the
  line was edited) and warns the same way.
  Two symbols with one code both take a code-only rule, each under its own
  fingerprint. Of two lines for one symbol the later wins (Mapper's rule
  and `decide`'s).
- **Unchanged** (user decision 2026-10-19): a rule whose target is what
  the document already draws *automatically* for that symbol (`state:
  "auto"`, method not `explicit`, same `canonicalId`) is counted in
  `unchanged` and **not** recorded. A whole table carried to Mapper and
  back therefore records only the lines that were edited, and the
  untouched auto matches stay the matcher's, re-proposed after a library
  or matcher change (03 §6.5). A rule restating an `explicit` match is
  recorded again (a fresh `decided_at`); a `# keep` is always recorded
  (it turns a suggestion into a reviewed decision).
- **Partial, never silent**: what applies is recorded through
  `decideOnDocument` — the same path as `decide`, the only writer of
  `club_symbol_decisions` — as one decision list, so one import job; every
  line that does not apply is in `skipped[]` (line, code, detail) and
  counted in `warnings` (the import report's `{code, message, count}`
  shape):

| Code | Line |
|---|---|
| `CRT_LINE_INVALID` | a rule with no source, a `# keep` with none |
| `CRT_QUERY_UNSUPPORTED` | a Mapper object query as source (whitespace, `=`, quotes, parentheses) |
| `CRT_SOURCE_UNKNOWN` | no source symbol of the document has that code |
| `CRT_SOURCE_NOT_REVIEWABLE` | the symbols of that code have no render, hence no fingerprint |
| `CRT_TARGET_UNKNOWN` | the target is not an entry of the document's library or of an overlay library (`ISSkiOM2019:801.1` is a valid target on any map, §8.5) |
| `CRT_FINGERPRINT_MISMATCH` | the `# fp` names no symbol here; applied by code (also counted as applied). A line skipped for another reason reports that code alone |
| `CRT_LIBRARY_MISMATCH` | the header names another library id; once per file |

A CRT is additive: there is no `reset` line (a decision is removed with
`decide`'s `reset`). Nothing applicable → no row written and no job.

Tests: `packages/shared/src/import/__tests__/crt.test.ts` (Mapper's
grammar incl. its shipped `ISOM2000-ISOM 2017-2.crt` lines, every
warning code, `702` ≡ `702.0`, duplicate-code fan-out, fingerprint
precedence and mismatch, later-wins, unchanged, the header, `# keep`,
`includeMatches`, byte-stable output, the round trip
`resolveCrt(parseCrt(formatCrt(…)))` and an overlay target — G21); the API side in
`docs/map-storage.md` §10.

### 8.7 Review UI (06 §5.1)

The screen a club or a course setter reviews a stored document on, built
on the review round of `docs/map-import.md` §2.2 (`review`, `decide`,
`status`, `finalise`, `exportCrt` / `importCrt`) and the A5 swatch routes
(`docs/map-storage.md` §4.5). Code: `packages/web/src/pages/MapReviewPage.tsx`,
pure helpers in `packages/web/src/lib/map-review.ts`, strings in the
`mapReview` namespace (en + sv).

**Routes.** One component, two mounts, keyed by the document hash so a
reviewed document that is not pinned anywhere yet survives a reload (it is
readable through the own-job clause only, §4.2 of map-storage):

| Route | Target | Edit controls |
|---|---|---|
| `/settings/map-review/:documentHash?clubMap=<series uuid>` | the club map series | signed in (or auth off), as the club library's other mutations |
| `/:nameId/map-review/:documentHash` (inside the event shell, `courses.view`) | the event's map | `courses.edit` |

`settings` is a reserved slug, so the club route sends no event header;
the event route sends `x-competition-id` and appends `?event=<nameId>` to
every *document* swatch URL (`map-import.md` §2.2); library swatches are
used as given. Without edit rights the page is read-only (rows,
candidates, reasons, CRT download). A club URL without `?clubMap=` has
no target: it shows the review but neither *in use* nor **Use this
version**.

**Entry points.** Review is *expected* for club maps and *optional* for
event maps (06 §5.1):

- Settings → Maps card: **Review symbols** whenever the series has a
  version, plus an amber **N symbols to review** chip while the version's
  document has `suggested` matches. The count is `clubMap.list[].review`
  `{suggested, reviewed}`, read from the document's import report
  (`report.matching.symbols`) — the one field B6 adds to the API.
- The course editor's map-info dialog (the top bar's map icon,
  `editor-map-info` → `editor-map-info-review`; P6 moved it there from
  `MapPanel`'s map-info footer, [course-editor.md](course-editor.md) §2):
  **Review symbols** when `course.mapMetadata().documentHash` is set.
  Never on the kiosk or the dashboard map: `MapPanel` itself carries no
  review link.

**Header.** Map name, library `id · release`, and where the document
stands: *in use* (it is the club version's / the event's pinned
document), *not used yet* with **Use this version** (`finalise`), and
*not up to date* when `review.current` is false (the current library,
importer or club decisions would import the source differently). One
terrain line from `review.terrain` (`docs/map-storage.md` §4.7): the
share of contour length with a decided uphill side and whether it reaches
the 80 % the 3D view needs (floored, so 79.6 % never reads as 80), or
*no contours*, *too large for this server*, *not derived yet*. Summary
chips count rows by outcome.

**Rows.** One per `ReviewRow`, ordered by `objects` (most used first,
then code, numeric-aware); rows flagged `unused` sit in one collapsed
group below, opened with a count toggle. A filter shows only rows still
`suggested` (plus rows with a pending decision). Each row: the file's own
swatch (`previewUrl`, reference raster), code, name, kind, object count,
colour class, flags (`hidden`, `club-symbol`, `text`), the outcome, and
what the document draws now (library entry name, from the shared library
in the bundle, Swedish when the entry has it). Outcomes as the reviewer
reads `match`:

| Outcome | `match` |
|---|---|
| To review | `state: "suggested"` |
| Accepted | `method: "explicit"`, `canonicalId` set (a club decision) |
| Kept as drawn | `method: "explicit"`, `canonicalId: null` (a club decision) |
| Automatic | `state: "auto"` |
| Map variant | `method: "variant"` (kept as source by design) |
| Not matched | any other `unmatched` |
| Not matched yet | `match: null` (pre-matcher document) |

Beside the swatch, the ≤ 3 `candidates`, best first, each with its
library swatch, entry name, confidence, its `reasons` under **Why?**, and
a mark on the one the document draws now.

**Decisions.** Per row: **Use this** on a candidate (`accept`; a
candidate may be an ISSkiOM overlay entry, §8.2), **Other
library symbol…** (`accept` of any entry of the document's library — the
API takes any entry, an overlay's included; a row with no close candidate needs it), **Keep as
drawn** (`unmatch`) and, on a row with a club decision, **Back to
suggestion** (`reset`). Decisions are collected locally, one per row (a
later choice replaces an earlier one; a choice that restates the row's
existing decision clears it), shown on the row with **Undo**, and sent
together from a bottom bar (**Apply N decisions** / **Discard**) as one
`decide`, in `symbolIdx` order. The bar says that decisions are
club-wide (§8.5 "Scope"). Accepting the candidate a `suggested` row
already draws is a decision: it makes the row reviewed.

**Job.** `decide` returns the job as `status` would. Done within the hold
→ the page moves to `job.documentHash` (same route, same query);
`queued` / `running` → a progress strip (stage and percent of the
`map-storage.md` §6.1 ladder) while `mapImport.status` is polled every
second; `failed` → the error. Edit controls stay but are disabled while a job
runs. Nothing is pinned until **Use this version**.

**Finalise.** `finalise` with `{kind: "club", clubMapId}` or
`{kind: "event"}`; afterwards the page re-reads `clubMap.list` /
`course.mapMetadata`, so the card thumbnail and *in use* follow the new
`document_hash` (`map-storage.md` §6.4: an in-place update of the club
version; events that copied the map keep their own pin). Finalising the
document already in use is not offered.

**CRT.** **Download CRT** fetches `exportCrt` (optionally
`includeMatches`) and saves `crt` under the API's `fileName`
(`<stem>-<library>.crt`). **Upload CRT…** (edit rights; ≤ 1 MiB, checked
in the browser before sending) always runs `importCrt {dryRun: true}`
first and shows what would be recorded (row code → entry, or kept as
drawn), how many lines restate the current automatic match, every skipped
line with its `CRT_*` code and detail, and the warnings; **Record
decisions** sends the same text without `dryRun` and follows the job as
`decide`'s. A file with nothing applicable offers no confirm.

**Colour layers** (row I6; §9.3 answers 1–3, "Per map (row I6)"). A
panel between the header and the CRT panel, from `review.colour`
(`docs/map-import.md` §2.2), component
`packages/web/src/components/map-review/ColourLayersPanel.tsx`, helpers
`packages/web/src/lib/map-review-colours.ts`. The review query passes the
club route's `clubMap` (the event route's map comes from the header), so
the panel knows the map's setting. In order:

- **The switch**: *Draw the map in* **the IOF order** / **the map's own
  order**, the map's setting pressed (else the document's order). Pressing
  the other calls `mapImport.setColourOrder` with the page's target and
  follows the job as `decide`'s: the page moves to the document in that
  order, *not used yet*, and **Use this version** pins it. The pressed
  order stays pressable while the document on the page is drawn in the
  other one (it builds the document in the setting). Disabled without
  edit rights, while a job runs, and on a club URL without `?clubMap=`
  (no map to remember it for: a note says so). A line says when the map's
  setting and the document's order differ, and when the IOF layers could
  not be built (`COLOUR_LAYERS_FAILED`).
- **Before and after**: the map in the IOF order and in its own order, side
  by side, the document's own marked *this version* — the `colour-order`
  previews (`docs/map-storage.md` §4.5) of the reviewed document, scoped
  with `?event=` on the event route. A picture whose other order is still
  importing answers 503; the image retries every 5 s (36 times).
- **Layers, top first** (the API lists draw order, bottom first; a colour
  table reads top first): per row a swatch of its ink, the map's colour
  name with its number (*added* for an inserted row), its IOF layer by
  the palette's name — a row with no role by its place (*No IOF layer
  (areas)*, *No IOF layer*, *Layout (graphic objects)*), so a colour split
  only by place (`roles: [null, null]`, carried from I3) reads by place —
  the objects drawn in it and flags: *split* (the colour draws on several
  rows; a zero-object `identified` row does not count, carried from I5),
  *deviation kept* / *deviation dropped* (the row's role is in one and
  something is drawn in it), *map's order* (`sourceOrdered`), *no IOF
  layer*, *under its own symbol's part* (`ownOrder`), *above the course
  purple*, *draws nothing* (`objects: 0`, `symbols > 0`: a library-drawn
  symbol's own reference, carried from I5). In the map's own order there
  are no layers: a note says so.
- **Deviations** (with the layers only): *N deviations, M kept*, then
  every one, the most objects first: *Kept* / *Dropped*, "*upper* over
  *lower*" by the palette's names, why (*by default*, *changed for this
  map*, *needed by a kept deviation*, *cannot be kept*), its default and
  the objects on each side. With edit rights and a target (row I7, §9.3
  "Overrides (row I7)") each row has *Keep* / *Drop* — the map's choice
  pressed, its override else the default; pressing the choice the map
  already has does nothing, so that button is disabled — and, on a row the
  map overrides, *Reset to default* and a note *kept / dropped for this
  map*. "Overridden" is read from the map's setting, not from the
  document's report: an override that changes no bytes (keeping a pair the
  palette already keeps by implication) leaves the report's *needed by a
  kept deviation*, and the row still shows the override. Each click is one
  `mapImport.setDeviation` and one rebuild, followed as the switch is; there
  is no reset-all and no batching. Disabled as the switch is: without edit
  rights, without a target, while a job runs.

**Compare (row I8a).** Asked by the user on 2026-11-18 during the I-gate
review: the before / after pictures are fixed crops of one window and hard
to compare. A **Compare** button in the before / after block opens a
read-only full-viewport view owned by the review page; nothing is pinned
or rebuilt from it. Its state is in the page's query —
`?compare=use|order&mode=side|swipe` (`side` is not written) — and Escape
or **Close** removes it. Two pairs: **`use`** — the document in use (the
pin) against the reviewed one, offered when a pin exists — and
**`order`** — the reviewed document's IOF order against the map's own
order, always offered. The view opens on `use` when the pin differs from
the reviewed document, else on `order`. The panes are labelled *In use* /
*This version* and *IOF order* / *The map's own order*; a pair of one
hash is drawn with a "same version" note. The reviewed document and the
pin load through `loadMapDocument(hash, { eventId })` (`map-storage.md`
§4.2 unchanged); the other order's hash comes from
`GET …/colour-order/:order.json` (`map-storage.md` §4.5 "The other
order's document"), its URL the picture's with `.json` for `.png` (so a
`source` document's IOF side carries the map's overrides as its picture
does, and `?event=` on the event route), asked again every 5 s while it
answers 503. **Side by side**: two panes (stacked on a view taller than it
is wide) over one paper camera — wheel, drag and pinch in either move
both (`map-viewport.ts`'s `zoomAt` / `panBy`); the view opens fitted to the
union of the two documents' bounds (`fitMm`, 4 % padding), **Fit** fits
again. **Swipe**: one pane, both documents stacked, the first drawn left
of a draggable divider (from the middle) and the second right of it;
**Flip** or Space shows whole the document the divider hides more (the
second from the middle), and the next flip the other. Each side is
its own `VectorMapLayer` on the `club` budget, without a course or a
patch; the layer and `map-gl/` are unchanged. Code:
`packages/web/src/lib/map-compare.ts` (pairs, the query, the divider and
flip, layout, fit, gestures), `components/map-review/CompareView.tsx`.
Test ids: `colour-compare`, `compare-view` (`data-pair`, `data-mode`),
`compare-pane` (`data-side` `a` / `b` / `swipe`, `data-document-hash`,
`data-view` the camera, `data-divider`, `data-showing` `a` / `b` /
`split`), `compare-layer-a` / `-b`, `compare-divider`, `compare-pair-*`,
`compare-mode-*`, `compare-flip`, `compare-fit`, `compare-same`,
`compare-close`. The diff view and *next difference* are row I8b (below).
Tests: `packages/web/src/lib/__tests__/map-compare.test.ts` (pairs per
panel state, the default pair, the `.png` → `.json` URL, the query, the
divider and flip, layout, the fit, the gestures on the one camera);
`integration/map-colour-order-document.test.ts` (`map-storage.md` §10);
`e2e/map-review.spec.ts` — after the paved-over-building keep the view
opens on `use` with both canvases ready on the two hashes, a drag in one
pane moves both by the drag, the swipe divider drags, a flip and Space
alternate the documents, Escape closes; on the event route it opens on
`order`, its second side the map's own order's document.

**Compare — diff (row I8b).** `mode=diff` is a third mode: one pane, the
first document's layer beneath (drawn, not shown: it is read) and the
second's drawn, under a 2D overlay of the pixels that differ — unchanged
pixels veiled white at 75 %, changed ones opaque red. A pixel has changed
when its largest RGB channel difference exceeds 16 (the harness's and the
golden tier's tolerance, `map-rendering.md` §6.2, §6.5); frames of
different sizes compare nothing and the overlay shows `failed`. The
overlay is read through both layers' frame readers (`map-rendering.md`
§5.4 "Frame reader") at the pane's device pixels, the ratio capped at 2,
once the camera has been still 150 ms, and hidden while it moves. Both
documents are read even when they are one version (two contexts: nothing
should differ). ***Previous* / *Next difference*** step over regions from
a whole-map scan made once per pair, on the first entry into diff, and
kept across modes: both documents read over the union of their bounds in
1024 px tiles at 6 px/mm, lowered until the map takes at most 64 tiles
(the best of every split into c columns and ⌊64 / c⌋ rows), **without the
screen-only skips** (glyphs under 2 px, text under 4 px em, hatch tints:
at 6 px/mm they would hide a difference confined to small symbols or text;
user 2026-11-18); changed pixels binned into 5 mm cells from the bounds'
top-left corner; 8-connected cells a region; regions ordered by most
changed pixels, ties topmost then leftmost. A tile waits until the camera
has been still 150 ms (any change of it: a gesture, **Fit**, a step, a
resize), so the scan yields to panning; while a read runs the layer's own
frames wait, and two animation frames pass between tiles so the layers
draw the frame they skipped. A superseded overlay read (the camera moved
again) is dropped before it draws. A step fits the region with one cell of
margin, at most 16 CSS px/mm, and wraps — the first *Next* to region 1,
the first *Previous* to the last. The status reads "n of N", "Finding
differences… x of y" while scanning, and "No differences" with both
buttons disabled at N = 0; a scan stopped part way (a mode switch, a
reader that goes) is dropped and starts over when both readers are back; a
failed one says so, with *Try again*, and an overlay that cannot be drawn
says so in the pane. The first document's canvas is hidden, its loading,
import and failure messages are not. The engine has no diff
pass: the comparison is CPU, over two WebGL contexts. On
`e2e/colour-layers.ocd` both E2E scans, with the rest of the I7 test,
finish within 8 s; a club map's tile time is still to be measured at the
I-gate. Code: `lib/map-compare-diff.ts`, `CompareView.tsx`'s
`DiffPane` / `useDiffScan`. Test ids: `compare-mode-diff`,
`compare-diff-overlay` (`data-state` `hidden` / `computing` / `ready` /
`failed`, `data-changed`), `compare-diff-status` (`data-scan` `waiting` /
`scanning` / `done` / `failed`, `data-regions`, `data-region`),
`compare-diff-prev`, `compare-diff-next`, `compare-diff-none`,
`compare-diff-retry`, `compare-diff-failed`; the overlay's `data-for-view`
is the camera it was computed for. Tests:
`packages/web/src/lib/__tests__/map-compare-diff.test.ts` (the mask at and
above the tolerance, size mismatch, overlay pixels, the scan resolution
and its tile cap, the tile grid, cells → regions → order, the step's
viewport and its cap, wrap), `map-compare.test.ts` (`mode=diff`),
`map-gl/__tests__/readback.test.ts`; `e2e/map-review.spec.ts` — after the
paved-over-building keep the diff on `use` has changed pixels and a
region, and *Next* moves onto it with changed pixels there; after the
no-op keep (one hash) nothing changed, no regions, both steps disabled.

Role and palette names are the IOF palette's English names in both
languages: there is no Swedish palette (decided overnight on the user's
standing instruction, 2026-11-17, for review). Strings under
`mapReview.colours.*`; `outdated` now names the colour order too. Test
ids: `review-colours` (`data-order`, `data-setting`),
`colour-order-iof` / `-source` (`aria-pressed`), `colour-picture-iof` /
`-source` (`data-loaded`), `colour-layer-row` (`data-row`, `data-role`,
`data-place`, `data-flags`), `colour-layers-none`,
`colour-deviation` (`data-key`, `data-kept`, `data-default`,
`data-why`, row I7: `data-choice`, `data-overridden`), its
`colour-deviation-keep` / `-drop` (`aria-pressed`), `-reset` and
`-overridden`, `colour-deviations-summary`, `colour-setting-differs`.

Tests: `packages/web/src/lib/__tests__/map-review.test.ts` (outcomes,
row order and the unused group, the pending batch — later wins,
restatements dropped, reset only on decided rows, symbol order — swatch
URL scoping, job progress); `packages/api/src/__tests__/club-map-library.test.ts`
and the `club-maps` integration suite (the card's review counts);
`e2e/map-review.spec.ts` (club map: card count, route, usage order,
swatches load, keep 850.1 as drawn, apply, finalise moves the card
thumbnail, CRT download carries `# keep 850.1`, CRT upload previews and
records `703 702.0`, resetting both rows returns the matcher's own
document hash; event map: entry from the course editor, swatches scoped
with `?event=`, nothing to finalise on the matcher's output; row I6, on
`e2e/colour-layers.ocd`: the panel's 13 layers top first with the split
brown 50 % on two rows, 9 deviations with 3 kept — road and paved area
over the contour by default, the building over the contour implied — both
pictures loaded and different, the switch to the map's own order (a new
document, not used yet, no layers) and back (the original document, in
use)); `packages/web/src/lib/__tests__/map-review-colours.test.ts` (top
first, a layer named by role or place, flags, the switch's state, the
picture's retry URL, the summary).

## 9. Colour stack alignment (03 §6.3)

Import stage 7. Code: `packages/shared/src/import/{colour-class,colour-align,colour-roles,colour-layers,match-document}.ts`.
Since `ocad-19` / `omap-12` (row I5) stage 7 builds the stack in one of
two orders (`matchDocument`'s `colourOrder`, recorded in
`header.colourOrder`): **`iof`, the default** — the IOF colour layers of
§9.3, where each colour *use* takes its palette place — or **`source`**,
§9.2 as it stood until I5: the mapper's knock-out order wins for
everything they drew, and alignment only *identifies*, *inserts* and
*flags*. §9.1 is shared by both. The per-map switch between them is row
I6's (the user's answer 1; §9.3 "Per map (row I6)"): every import follows
its map's setting, `iof` when the map has none.

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

A name that states the symbol kind rules out entries of the other kind
(`nameKind`, whole tokens; C14, 2026-10-31): `area`, `yta`, `ytor`,
`ytobjekt`, `ytsymbol`, `fill`, `screen` (and plurals) never map to a line or point
entry (`-line`, `-point`, `-pointline`, `-hedge`, `black100`, `brown100`,
`black-road-outline`, `white-railway`), and `line`, `linje`,
`linjeobjekt`, `linjesymbol`, `point`, `punkt`, `punktobjekt`,
`punktsymbol` (and plurals) never to an
area entry (`AREA_PALETTE_IDS`: the `-area` entries, the yellows, olive,
the green and black screens, buildings, canopy, cultivated-land black,
the white-overs, `brown*-paved`, `white-two-level`). Road infill
(`brown*-road`) is neither, and "Vägfyllning" is one token, not "fill".
When no entry of the class is left, the colour has no palette id: ISOM's
only dark green is the hedge line colour, so "Green 100% + 50% Black Area
Feature" is classified dark green but stands for no palette entry, while
"Grön 100% + 50% Svart - Linjeobjekt" is `darkgreen-hedge`.

**ISSkiOM's own rows** (G21, §12.3) are identified before the spec's
entries, on any map (`skiPaletteIdFor`, `SKI_PALETTE_IDS`): a name with a
ski-orienteering token — `ski`, `skio` ("Ski-O"), `skid…` (`skidspår`,
`skidorientering`), `längdspår…` — and the row's hue is `green-skio`
(green), `orange-skio` (orange) or `white-skio` (white), wherever the
colour sits; a green must also be at least 70 % and nearer 91/0/83/0
than the edition's green 100 % rows ("Grön 100% skidområde" at green
100 % ink is 808's raster green, "Green 50% Ski-O" no track ink). Without such a name, a colour drawn above every black 100 %
is the Ski-O orange within CMYK distance 0.08 of 0/60/100/0, or the
Ski-O green within 0.08 of 91/0/83/0 and nearer to it than to the
edition's green 100 % rows (`via: "position"`); OCAD's template "Orange"
0/50/100/0 is 0.10 away and stays no palette entry. The mask is
identified by name only. A ski green is green 83 %, the same class as
green 100 % under the 20-point tolerance, which is why it is decided
first: otherwise it would be the area green. "Motionsspår" and
"Cykelspår" are not ski words.

### 9.2 Steps

`identifySourceColours` then `alignColourStack`:

1. **Classify** every source colour; unclassified ones that symbols use
   are listed in `colourStack.unclassified` and warn `COLOUR_UNCLASSIFIED`
   (a metro line colour on a sprint map stays as it is, drawn from source).
2. **Identify**: one source colour per palette id — the most used by
   objects, ties to the lowest; ISSkiOM's rows first (§9.1). Full purples take their role from the
   name, else from position: above every black 100 % → `purple-upper`,
   else `purple-lower`. A purple identified this way is only a
   *candidate* for that role: which row carries the course purple is
   decided by position in step 4 (C15), not here.
3. **Alias**: a palette id that applied matches need but the source lacks,
   when the source has a colour of the same class → that colour stands for
   both (`black-road-outline` on a source with one black;
   `colourStack.aliased`). Purples are never aliased, and neither are
   ISSkiOM's own rows, in either direction: a ski green or mask never
   stands for green 100 % or a white, nor they for it.
4. **Insert** the rest in palette order, each directly above its nearest
   lower palette neighbour already in the stack (else below the nearest
   upper one); `purple-upper` always on top. Inserted entries have
   `id: "<edition>:<paletteId>"`, the palette CMYK and no `sourceNumber`
   (`colourStack.inserted`).

   **`purple-lower` goes above the area colours as a group** (C14, user
   decision 2026-10-31; 03 §2.4, Appendix B: lower purple is below only the
   100 % line and point colours and above every area screen). Each
   colour in the stack is on a *side*: *above* when its palette id ranks
   above `purple-lower` (black 100 %, 100 % line / point colours, dark-green
   hedges, railway white, the upper purples); *area* when its palette id
   is an area entry (§9.1) or, with no palette id, its name says area —
   whether or not its ink is classified ("Grön Naturreservat - Area
   Feature" in a non-IOF green is still an area); *below* for any other
   palette id the palette ranks under lower purple (road infill and
   outline, ISSprOM's brown 100 %); other colours without a palette id
   take no side. Duplicates count by the entry they were identified as
   (step 2), not only the one chosen to stand for it. Only colours that
   objects use count (`usage` > 0; a caller that passes no `usage` counts
   every colour) — a stray or repeated table entry does not steer the
   purple. The purple goes into the gap with the fewest
   misplaced colours (areas above it plus *above* colours below it), ties
   to the fewest areas above, then to the fewest *below* colours above,
   then to the lowest gap: directly above the highest area colour it keeps
   below (and any road infill drawn on it). Without any area colour it goes directly below the first *above*
   colour, else on top. The source order is never changed; what stays on
   the wrong side is step 5's.

   **Course purples are placed by rule** (C15, user decision 2026-11-14).
   A map file holds no course, so where a source purple sits says nothing
   about where the course belongs; Testkarta (Nackareservatet 2023,
   Club-full in the corpus) keeps its only lower-purple candidate,
   "Violett", under 28 used area colours, and step 2 had taken the upper
   candidate at index 0. On every import:
   - the **lower-purple position** is always the gap above, computed over
     the source stack with every purple candidate (step 2, either role)
     taking no side;
   - the **upper-purple position** is always above every used colour;
   - a source candidate of that role is **reused** only when it already
     stands at the ruled position — lower: its own gap scores the same
     (misplaced, areas above, *below* colours above) as the ruled gap;
     upper: no used colour other than a purple candidate stands above
     it. Several qualify → the most used, ties to the lowest for lower and
     to the highest for upper. An unused candidate may be reused: the test
     is its position;
   - otherwise a row is **inserted** at the ruled position (lower: the
     ruled gap; upper: on top), with `purpleRole` and the map's purple
     CMYK (C9 below);
   - a candidate takes no side in any of this, whatever its name says (a
     "Violett - Ytobjekt" is not an area colour);
   - lower purple is never placed above a reused upper purple (on a table
     with no used colour that steers it, it goes directly below it);
   - every other candidate is **displaced**: it keeps its index, `id`,
     `sourceNumber`, name and CMYK as an ordinary source colour — no
     `purpleRole`, no `paletteIds` — so the map objects drawn in it are
     drawn as before, and the source order still never changes. Each is
     listed in `colourStack.purplesDisplaced` as `{ name, sourceNumber,
     role, why }`, in source order: `why` is `"position"` when it does
     not stand at the ruled place, `"duplicate"` when it does but another
     candidate was reused.

   Exactly one row carries `purple-lower` and one `purple-upper`. A table
   whose purples already stand right keeps them (a sprint table with
   "Undre violett" directly above its brown 100 % and "Övre violett" on
   top), and its stack is the one `ocad-17` built.
   On Club-full the lower purple is inserted between the area block
   (with the road infill on it) and "Brown 100% - Line Feature", the top
   "Violett" is reused as upper purple, and the other five candidates
   stay where the mapper put them. Before C15 a candidate *was* the
   course purple wherever it stood (03 §6.3 step 4; the deviation is in
   `decisions/slice-c.md`).

   Before C14 the anchor was "directly below the first source colour the
   palette puts above lower purple". OCAD-made maps keep the mapper's
   dark-green colour at the bottom of the area block and §9.1 read it as
   the hedge line colour, so one colour put lower purple under every area
   (`docs/bugfixes/lower-purple-under-areas.md`). A literal "directly above
   the highest area colour" fails the other way: Ny_karta_test keeps a
   yellow ("Gul (över platta)") at the top of its table, above its own
   upper purple, so the gap count decides instead. **Exception (C9, user decision 2026-10-24):**
   an inserted `purple-upper` / `purple-lower` takes the CMYK of the map's
   own purple of the other role when it has one (the course overprint is
   one ink: Ny_karta_test's `src:2` "Upper Purple for Course Overprint"
   10/90/10/0 gives the inserted lower purple 10/90/10/0, not 35/85/0/0);
   the palette CMYK only when the map has no purple at all. Since C15 an
   inserted purple takes the CMYK of the reused purple of the other role,
   else of the most used purple candidate of either role (ties to the
   highest index) — the same ink for both when both are inserted. Purples
   are still never aliased.

   **The overlay's rows** (G21; slice G answer 8 as widened, §12.3) come
   after both purples, so nothing placed so far moves: every stack
   carries `OVERLAY_STACK_IDS` — `green100-area`, `white-skio`,
   `orange-skio`, `green-skio` — once, whether or not a match needs them.
   Every rule below is measured from the *placed* purple rows (C15): a
   displaced candidate neither anchors nor stops them. Where the source
   lacks one:
   - `green100-area` aliases or is inserted as above (steps 3–4), but
     never above lower purple (a stray area colour on top of a table does
     not take it there);
   - `white-skio` goes **directly below lower purple** — the ISSkiOM
     text's "white (under lower purple)", which the user chose over the
     301.1 drawing (2026-11-13, §12.3);
   - `orange-skio`, then `green-skio`, go directly below the first colour
     *above lower purple* that the palette ranks above them (the upper
     overprint colours: `purple-upper`, `white-upper`, `purple50`), else
     on top — so orange sits directly under green, both above black and
     every 100 % line colour, both under upper purple. The search starts
     at lower purple because some tables keep a copy of their upper purple
     at the bottom (Club-full); a nearest-neighbour rule would put the
     tracks under black on a Mapper-ordered table that keeps railway
     white below black.
5. **Flag**, never reorder. (a) Against lower purple, every used colour
   with a side: an *above* colour below it or a *below* colour above it is
   a `COLOUR_ORDER_CONFLICT` naming the colour (`blue100-line: source
   places "Blå" below purple-lower; …`); an *area* colour above it is
   `COLOUR_AREA_ABOVE_LOWER_PURPLE` — it hides the course overprint —
   listed in `colourStack.areasAboveLowerPurple` (name, source number,
   palette id). Both are measured against the placed lower purple, so
   they remain only where no gap is clean; a displaced candidate takes no
   side and raises neither. Before C15, Vinterserien's named lower purple
   drawn above its upper purple kept its place and reported the upper
   purple and every 100 % line colour under it; now both candidates are
   displaced and the course purples placed by rule.
   (b) The other palette ids whose relative order disagrees with the
   palette (longest increasing subsequence of palette ranks, lower purple
   left to (a); everything outside it is a `COLOUR_ORDER_CONFLICT` with the
   pair it contradicts). The overlay's rows inserted above take no part,
   whether or not an applied match needs them: they are placed by rule,
   not drawn by the mapper, and must not tip which source colours are
   reported (a source's own ski colours do take part). A `green100-area`
   inserted in step 4 because a match needs it takes part as before.

   `scripts/measure-import.mjs` prints per map where lower and upper
   purple sit and whether each is the `source` candidate or `inserted`
   (with the displaced candidates' names), the area colours above lower
   purple and the conflict count (`purple` line), and
   where each overlay row comes from (`ski-o` line: `inserted`, `aliased`
   or `source "<name>"`, with its index). The
   map review page has no colour-stack panel; the report's
   `colourStack` (`mapImport.review` → `stack.alignment`) carries the
   lists.

Output: `header.colours` with `paletteIds[]` and `purpleRole` on every
entry that stands for a palette colour (a displaced purple has neither),
and the source symbols' IR
remapped to the new indices (`remapRenderColours`). The render bridge
resolves canonical entries through `paletteIndexOfStack(header.colours)`.

### 9.3 Canonical layers (slice I): decided with the user (2026-11-17)

**The importer's default since row I5** (`ocad-19` / `omap-12`); §9.2
above is the `source` order of answer 1. This section records what slice
I (`SLICES.md` rows I1–I7) builds and the user's answers to its three
questions; each row writes its own part out here. Built: the roles (row
I2, "Roles" below), the layered stack built from them (row I3, "Layers"),
its exceptions (row I4: "Own order", "Deviations", "Source order") and
the importer drawing on it (row I5, "In the importer"); the colour-order
harness draws every map in both orders and classifies every change
("Measured"), and the per-map switch with the review page's colour panel
(row I6, "Per map (row I6)" below, §8.7 "Colour layers"). Still to come:
per-map deviation overrides in the panel (I7).

**The aim.** A document is drawn on the IOF colour order (§1, 03
Appendix B) instead of the mapper's table, so the course layer and the
library's symbols never depend on a source table being well ordered.
§9.2's "the source order wins, alignment only identifies, inserts and
flags" becomes the *source* order of answer 1; the default is the *IOF*
order below.

**Why not a permutation of the table.** The 2026-11-14 experiment
(`SLICES.md` "Slice I") drew ten maps in both orders: on 8 of 10 one
source colour serves several IOF rows (brown 50 % as paved area and road
infill, one black as buildings and cultivated-land dots), so no single
place for it is right. The unit that takes a place is therefore not the
colour but the **use**: one colour reference of one symbol.

**Decided in the split** (the planner, 2026-11-17):

- **Roles.** Every colour reference of every symbol's source `render`
  gets a *role*: a palette id of the alignment palette (§1), or none.
  In order: the library entry the symbol is matched to — applied or only
  suggested — when it uses exactly one palette id of the source colour's
  class; else a rule on the colour's class and percent, the symbol's
  kind and the part that draws (area fill, pattern, border, a line's
  infill or outline, point, text); else no role.
- **Layers.** `header.colours` holds one row per (source colour, role)
  that objects use (as built, I3: that any symbol references, "Layers"
  below), in the palette's order; two source colours of one
  role keep their source order. A source colour that serves several
  roles becomes several rows with the same CMYK and `sourceNumber`. A
  row a match needs and no source colour gives takes the CMYK of a
  source colour of its class, else the palette's (today's alias and
  insert, §9.2 steps 3–4). Index = draw order is unchanged, so the
  renderers, the course layer (`paletteIndexOfStack`) and
  materialisation (§11) need no change; each symbol's `render` is
  re-indexed per reference.
- **Purples and the overlay.** Lower and upper purple and the overlay's
  rows (§9.2, §12.3) stand at their palette places. A source purple that
  map objects draw in is an ordinary colour with or without a role; C15's
  reuse rule applies to the *source* order only.
- **Source order kept as the rule** for what the palette cannot place:
  whites that are no palette white (masks), the colours of graphic
  objects' synthesised symbols (`origin: "graphic"`, `map-import.md`
  §3.2: logos, frame bars) and colours with no role. Each is placed
  relative to the layers its source position stood between; the exact
  rule is row I4's, fixed against the corpus diff ("Source order"
  below).
- **A deviation** is a pair of used roles whose source order contradicts
  the palette's. Kept = the pair is drawn in the source order; dropped =
  in the palette's. Which row moves, and how far, is row I4's, fixed
  against the corpus, under one constraint: a kept deviation never puts
  an area or infill colour above lower purple (the course stays on top
  of it). Every deviation is reported, kept or dropped ("Deviations"
  below).
- **Identity.** The importer versions bump; the release re-matches every
  pin. A symbol's fingerprint (§8.5) is unchanged: split rows keep their
  colour's class.
- **Acceptance** is the two-order raster diff over the corpus
  (`scripts/measure-colour-order.mjs`, row I1) with every remaining
  difference classified, as B9 and C7 did for theirs. The tool, its
  classes and the ten-map baseline (0.62 % of pixels change under a plain
  permutation, 2.1 % of them unattributed) are in `map-rendering.md`
  §6.5.

**The user's answers.**

1. **On for every map, with a switch back per map.** Every map is drawn
   in the IOF order from the release's re-match on. The review page has
   a per-map switch to the map's own order (§9.2 as it stands, C15's
   purples included), remembered for the map across re-matches. The
   switch is also the rollback.
2. **Roads over contours is kept by default; every deviation is listed;
   the defaults can be overridden.** Where the map's own table draws
   road infill and paved-area brown over the contour brown (6 of the 10
   maps), that deviation is kept without anyone asking (since `ocad-20`
   also roads and paved areas over the blue line symbols, "Deviations"
   below). Every other deviation is dropped by default. All of them are listed, kept and
   dropped. Each can be switched the other way per map in the colour
   panel (row I7). The user asked for the overrides "if it is not a lot
   of extra work", and at least the list: the list is row I6's, the
   overrides are a row of their own after it, so the slice can ship
   without them.
3. **A read-only colour-layers panel on the review page**: the layers in
   draw order with the map's colour, the role, the object count and
   flags (split, kept or dropped deviation, source-ordered, no role), a
   before / after picture of the map in both orders, and answer 1's
   switch. Answer 2's overrides make the deviation rows editable (I7).

#### Roles (row I2)

Built in `packages/shared/src/import/colour-roles.ts`, pure. I3 builds
the layers from it; since I5 stage 7 calls it in the `iof` order.

**Uses.** `colourUses(render)` lists every colour reference of a
symbol's `render` (the keys `colour`, `fill`, `backgroundColour`) as a
use `{ colour, path, part }`, in the IR's key order. A colour referenced
twice is two uses. The path is the reference's keys and array indices
from the symbol's root (`renderColourPaths` in `render/transform.ts`,
printed `borders.left.colour`, `glyph.parts[2].colour`).
`mapRenderColourRefs` re-indexes per reference, for I3. The part comes
from the symbol's `render.type` and the path:

| Type | Path | Part |
|---|---|---|
| area | `fill` | `area-fill` |
| area | `hatches[n].colour` | `area-hatch` |
| area | `patterns[n].glyph.parts[m].colour` | `area-pattern` |
| area | anything under `border` | `area-border` |
| line | `main.colour` | `line-main` |
| line | `main.halo.colour` | `line-halo` |
| line | `borders.backgroundColour` | `line-infill` |
| line | `borders.left` / `right` / `extraPairs[n].*` colour | `line-outline` |
| line | `glyphs[n].glyph.parts[m].colour` | `line-glyph` |
| point | `glyph.parts[n].colour` | `point-glyph` |
| text | `colour`, `halo`, `shadow`, `frame` | `text`, `text-halo`, `text-shadow`, `text-frame` |

The kind is `render.type`. `DocumentSymbol.kind` is not used, because
`rectangle` and `unknown` mean nothing to the rules.

**A role** is an id of `alignmentPalette(edition, spec)` (§1), or none.
`roleOfUse(use, infos, symbol, palette)` takes the use, the source
colours' `identifySourceColours` infos indexed by colour (a rule reads
the classes of the symbol's other colours), the symbol's `render` and
`match`, and a `RolePalette` built once per document
(`rolePalette(spec, edition)`: the spec's own rows and the class of
every alignment row). `colourRoles(symbol, infos, palette)` gives every
use with its role and `via` (`match`, `rule` or none). In order:

1. **The hint.** The library entry of `match.canonicalId`, in any match
   state (`auto`, `suggested`, or an `unmatched` match that names an
   entry, as H1's terrain classes read it, `map-terrain.md` §1.1). It
   applies when the entry uses exactly one alignment-palette id whose
   class is `sameClass` (§9.1, 20-point tolerance) with the source
   colour's class. That id is the role. No canonical id, an unknown
   entry, a class the entry lacks, or two ids of the class (ISSkiOM
   808's `green-skio` and `green100-area`) → no hint. Overlay entries
   hint like any other (`ISSkiOM2019:801.1` → `green-skio`,
   `white-skio`). `alternatives[]` are not hints.
2. **ISSkiOM's track colours.** A colour that §9.1 identified as
   `green-skio` or `orange-skio` takes that role for every use. The mask
   white `white-skio` does not: whites take a role from the hint only.
   `colourRoles` reports this step as `via: "rule"`, on any spec.
   (Q2, decided overnight on the user's standing instruction, 2026-11-17, for review.)
3. **The rule table.** By the colour's class (hue and percent), the
   symbol's kind and the part. "Area part" is `area-fill`, `area-hatch`
   or `area-pattern`; "line part" is any `line-*`. Where a cell lists
   several rows, the rule keeps the spec's own rows of the colour's class
   and takes the nearest percent, ties to the earlier row. A spec without
   a table (ISSkiOM, ISMTBOM as a document's spec) has no rule.

   | Class | Use | ISOM 2017-2 | ISSprOM 2019-2 |
   |---|---|---|---|
   | black 100 % | line outline over a brown-screen infill (`borders.backgroundColour`); halo under a brown-screen main; area border round a brown-screen fill | `black-road-outline` | `black-road-outline` |
   | black 100 % | area pattern of discs only, on an area whose fill is yellow (Q1, decided overnight, for review) | `black-cultivated` | `black-cultivated` |
   | black 100 % | any other | `black100` | `black100` |
   | black screen | any | nearest of `black50-building`, `black-area-screen`, `black20-canopy` | the same |
   | brown 100 % | point glyph | `brown100-point` | `brown100` |
   | brown 100 % | any other (text and area borders included) | `brown100-line` | `brown100` |
   | brown screen | line part | `brown50-road` | nearest of `brown50-road`, `brown30-road` |
   | brown screen | any other | `brown50-paved` | nearest of `brown50-paved`, `brown30-paved` |
   | blue 100 % | area part | `blue100-area` | `blue100-area` |
   | blue 100 % | point glyph | `blue100-point` | `blue100-pointline` |
   | blue 100 % | any other (area border, line, text) | `blue100-line` | `blue100-pointline` |
   | blue screen | any | nearest of `blue70-area`, `blue50-area` | nearest of `blue70-area`, `blue50-area`, `blue30-area` |
   | green | area part | nearest of `green100-area`, `green60-area`, `green30-area` | the same |
   | green | any other | nearest of `green100-point`, `green60-area`, `green30-area` | the same |
   | dark green | area part | none (ISOM's only dark green is the hedge line, §9.1) | `darkgreen-area` |
   | dark green | any other | `darkgreen-hedge` | `darkgreen-line` |
   | yellow | any | nearest of `yellow100`, `yellow75`, `yellow50` | nearest of `yellow100`, `yellow50` |
   | olive | any | `olive` | `olive` |
   | white, purple (50 % included), orange, red, registration, unclassified | any | none | none |

   Screens go by percent whatever the part: the palette has no line or
   point screens, and a green 30 % halo is 508.d's runnability band. A
   class no listed row is within tolerance of (a yellow 75 % on a sprint
   map, a black 75–84 %) gets none. The rule does not read the colour's
   name or §9.1's `paletteId` (the ski rows aside). Splitting a colour by
   the part it draws is the point of roles, and the name is per colour.
   Cultivated-land dots need the yellow fill, because the library draws
   stony ground (208–212) as black 100 % dots, and `black-cultivated`
   ranks under the greens: an unmatched stony ground would vanish.
4. **Else no role.** I4 places such uses by the source order.

**Checked against the library.** Every entry of both libraries,
resolved on its own palette stack and classified from CMYK alone. With
no match, the rule gives 203 of 249 ISOM uses and 183 of 226 ISSprOM
uses the entry's own row, on both editions. The others are whites and
purples (hint only) and six named uses: ISOM 101.b and 103.b ticks
(point glyphs in `brown100-line`; the rule says `brown100-point`),
ISSprOM 501.1 and 501.2 (`black-road-outline` as a main line), 520.b
(`black-road-outline` round an olive fill) and 532 (brown 30 % paved as
a line). With each entry as its own hint, every use gets its own row.

**A symbol drawn inside out** (Q3, decided overnight on the user's
standing instruction, 2026-11-17, for review; settled by row I4). In
layers, a symbol's parts draw in role order, not in the IR's order. An
under-part whose role ranks above its over-part hides it: a black 100 %
halo under a blue or yellow main, or a dark infill under a lighter main.
I2 rules only the road case: an outline or halo round a brown-screen
infill takes `black-road-outline`, which ranks under the infill. The
general case is not a role: row I4 keeps every source-drawn symbol's
parts in their source order ("Own order" below). The harness found it on
eight of the ten maps, on roads drawn as a brown-screen *main* as wide as
the black side borders' centres with the borders over it, whose borders
a hint makes `black-road-outline`.

| Test (`packages/shared/src/…`) | Covers |
|---|---|
| `render/__tests__/transform.test.ts` | `renderColourPaths` (every reference with its own path; one colour three times is three entries; area, line, text paths), `mapRenderColourRefs` (per-reference re-index; the identity; agrees with `remapRenderColours`) |
| `import/__tests__/colour-roles.test.ts` | `colourUses` parts for every type; the rule table for both specs (one brown 50 % as paved area and road infill; one black as building outline, road outline, cultivated dots, stony-ground dots and a tick; a black outline over an infill that is no brown screen; screens by percent; a class out of every candidate's tolerance (yellow 75 % on a sprint map, black 80 %); a tie to the earlier row; ISSprOM's rows); whites and purples without a hint; the ski colours; rule roles within the spec's own palette on both editions; the hint in each match state, beating the rule, two parts with two roles, a class the entry lacks, whites and purples, an overlay entry, a two-id entry, `orange-skio` on iof2022; the library as oracle |

#### Layers (row I3)

Built in `packages/shared/src/import/colour-layers.ts`, pure. Since row
I5 stage 7 builds the default stack with it ("In the importer" below),
and the colour-order harness reads the importer's own (`map-rendering.md`
§6.5). Row I4's
exceptions are written out after this section ("Own order",
"Deviations", "Source order"); what this section says of the order is
the base they start from.

```ts
symbolColourUses(symbols, objectsPerSymbol, infos, rolePalette(spec, edition))
  → (LayerSymbolUses | null)[]        // per document symbol; null: no render
buildColourLayers({ colours, infos, uses, needed, spec, edition, deviations? })
  → { colours, reindex: { symbols, colours }, report }
```

**Input.** `colours` is the source table in source order, as the reader
gives it (before §9.2); `infos` its `identifySourceColours`; `uses` per
document symbol the uses of its source `render` with their roles
(`colourRoles`, every reference in `renderColourPaths` order), its
object count (hidden symbols counted, as stage 7's `usage`), its
`render.type`, its `origin` and `library` — the symbol is drawn from its
library entry (`isAppliedMatch`: automatic, or confirmed by review), so
its own references draw nothing; `needed` the palette ids applied
matches draw with (stage 7's `needed`); `deviations` (I4) the per-map
overrides, keep or drop by deviation key.

**Rows.**

- One row per (source colour, role) that a symbol references — **zero-object
  symbols included** (decided overnight on the user's standing
  instruction, 2026-11-17, for review): Map mode draws with any document
  symbol (§11.2) and a patch never changes the stack, so a symbol's place
  must not depend on whether the map has objects of it yet. A row's
  object count is reported; it decides nothing but which row carries a
  palette id.
- A use with **no role** is keyed by the kind of its symbol instead of
  a role: `area` when its symbol's `render.type` is area, else `other`. A
  no-role colour used by an area and a line is two rows. Since I4 both
  are placed by the source order; the key only keeps I3's ids.
- The uses of a **graphic object's** symbol (`origin: "graphic"`) are
  one row per colour, whatever their roles (I4, "Source order").
- A part of a source-drawn symbol that its own order moves is a row of
  its own (I4, "Own order").
- A **source colour no symbol references** is kept once: with the palette
  id §9.1 identified it as (course purples excepted: a candidate stands
  for no id), else with no role, by the source order (I3: placed as an
  area when its name says so, `nameKind`, else as `other`; the key and
  id still follow the name).

**Order** (bottom first), by the alignment palette
(`alignmentPalette(edition, spec)`, §9.2; the overlay's rows included):
a row with a role at its role's place; rows of one role in source order,
an inserted row above them (the course purples over a source purple a
hint gave that role). Row I4 then moves what "Own order" and
"Deviations" say and places the rest by "Source order". (I3 placed a
use with no role by kind: an area directly under `white-skio`, anything
else directly under upper purple. I4 replaced that.)

So purple-upper is always the top row and the overlay's rows stand at
their palette places on every stack: `white-skio` directly under lower
purple and `orange-skio` directly under `green-skio` wherever nothing of
the map is drawn in them (I4 keeps them there after its moves, and no
source-ordered row goes between), both ski inks above black 100 % and
under upper purple. On ISOM the contour brown is above lower purple;
on ISSprOM, whose palette ranks `brown100` under it, below — unless a
kept deviation sinks it ("Deviations").

**Palette ids.** Each id is on exactly one row (`paletteIds: [id]`), a
row at the id's palette place (never a source-ordered or moved row):
the row of the colour §9.2 gives the id — step 2, the colour §9.1
identified as it, the most used, ties to the lowest index; for a needed
id with none, step 3's alias, the most used identified colour of its
class (purples and ISSkiOM's rows never aliased, in either direction).
A library symbol therefore draws in the ink it has on the source order.
When that colour has no row of the role, a needed id gets one (origin
`alias`, a split of the colour: same name, CMYK, `sourceNumber`; listed
in `aliased` only for step 3). An id with no such colour is carried by
its row with the most objects, ties to the lowest source index; a needed
one with no row at all is *inserted* with the palette's CMYK. (I3 took
the row with the most objects first; I4 changed it so that library
symbols keep their colour; decided overnight on the user's standing instruction, 2026-11-17, for review.)
**Every id §9.1 identifies is carried, as on the source order** (row I5;
decided overnight on the user's standing instruction, 2026-11-17, for
review): until I5 only ids in use and needed ids had a carrier, so the
layers lost ids the source order has — `white-over-green-brown` on
`e2e/test.ocd`, `blue100-line` on `e2e/test.xmap` (a blue identified as
the line blue that draws only areas), `blue50-area` and `white-railway`
on three club maps — and with them every library entry Map mode could
materialise there (ISOM 302, 509, 304–306 among them) and every patch
symbol a re-match would re-resolve (G11). An identified id whose colour
has no placeable row of that role gets a zero-object row of the colour
at the id's palette place (origin `identified`). It never takes the
colour's plain id and `reindex.colours` never points at it, so the
colour's other rows keep their ids and its proxies their row; the
source-order gap does not count it. It draws nothing a map draws, so the harness numbers are
unchanged (2–3 such rows on five of the ten maps). The other rows of the
role carry no `paletteIds`; their role is in the report. `purpleRole`
is on the row carrying a purple id. Canonical entries therefore resolve
exactly as before (`paletteIndexOfStack`), and `courseColourStack`
accepts the stack.

**The course purples** are always inserted rows (`<edition>:purple-lower`,
`<edition>:purple-upper`) at their palette places; C15's reuse of a
source candidate applies to the *source* order only. Both take the ink of
the map's most used course-purple candidate (§9.2 step 2, either role),
ties to the highest index (C9, C15), else the palette's. A source purple
is an ordinary colour: a hint may give it a role (an out-of-bounds area
drawn in it, `purple-upper`), and then its row stands under the inserted
row of that role; with none it is a no-role row. An inserted `purple50`
(ISSprOM, `purpleRole: "upper"`) takes the same ink as the course purples
(row I5, carried from I3, which left it with the palette's; decided
overnight on the user's standing instruction, 2026-11-17, for review):
§9.2 step 4 gives every inserted row with a purple role the map's purple,
so a library symbol drawn in it has one ink in both orders. Full
strength, as §9.2: a 50 % screen of the map's ink would be truer, and
would be changed in both orders at once.

**Ids.** A source colour's lowest row keeps the colour's id (`src:<n>`);
its other rows are `src:<n>/<paletteId>`, a no-role row
`src:<n>/none:area` or `src:<n>/none:other` (a palette id has no colon),
and since I4 a graphic row `src:<n>/graphic`, a moved part's row
`src:<n>/<paletteId | none:<place>>/under<k>` (numbered per colour and
suffix bottom first), a second row of a palette id in a colour whose own
row of that id went to the source order (a mask)
`src:<n>/<paletteId>/alias`, and since I5 an identified id's row
`src:<n>/<paletteId>` (or `…/alias`), never the colour's plain id.
Split and alias rows copy the colour's name, CMYK, `sourceNumber`, spot
and overprint, so print sees one ink. Inserted rows are
`<edition>:<paletteId>` with the palette's name, as today
(`map-document-format.md` §2.1 lists every form).

**Output.** `colours` is the stack, index = draw order.
`reindex.symbols[i]` gives symbol i's row per colour reference, in
`renderColourPaths` order, for `reindexRenderColours(render, rows)`
(`render/transform.ts`); `null` for a symbol without a render.
`reindex.colours[c]` is source colour c's lowest row (for a caller that
maps colours, not references: the render bridge's proxies).
`report` — for I4, I5 and I6's panel:

- `rows[]`: `{ row, source, role, place, origin, objects, symbols,
  graphicObjects, sourceOrdered, ownOrder }`, `origin` one of `use`,
  `alias`, `insert`, `unreferenced`, `identified` (I5); `objects` what
  is drawn in the row — the objects of source-drawn symbols referencing
  it, and on a row carrying a palette id those of library-drawn symbols
  whose entry draws with it (I5; until I5 a library-drawn symbol counted
  on its own references' rows, which draw nothing); `symbols` the
  symbols referencing it; `graphicObjects` the objects of
  `origin: "graphic"` symbols among `objects`; `sourceOrdered` the reason
  a row stands by the source order (`no-role`, `graphic`, `mask`) or
  `null`; `ownOrder` a moved part's row (I4);
- `split[]`: source colours on several rows, `{ source, sourceNumber,
  roles }` bottom first;
- `sourceOrdered[]` (I4): `{ row, source, sourceNumber, reason, role,
  objects, aboveLowerPurple }` bottom first;
- `noRole[]`: `{ row, source, sourceNumber, place, objects }` (uses with
  no role; graphic rows are in `sourceOrdered` only);
- `deviations[]` (I4): `{ upper, lower, kept, byDefault, objects: {
  upper, lower }, impliedBy?, blockedBy? }`, the most objects first
  ("Deviations");
- `inserted` (ids), `aliased` (`{ paletteId, viaPaletteId, sourceNumber }`,
  the shape of `colourStack.aliased`), `purpleInk` (the source colour the
  course purples take their ink from, or `null`).

A symbol's fingerprint (§8.5) is unchanged: split rows keep the colour's
name and CMYK, so `documentClassOf` gives every reference the class it
had. The function is deterministic and does not change its input.

#### Own order (row I4)

**A source-drawn symbol's parts keep their source order relative to each
other** (Q3 above, the general case). The parts are the symbol's colour
references; a part *over* another is one whose source colour stands
higher in the table. Two references to one source colour have no order
between them (the source draws them in one row).

*Pass 1*, before the order: per symbol, top-down over its source
colours, a part with a role whose place (the role's palette rank, or a
place pass 1 already gave a part over it) is not under every role part
over it goes to a row of its own **just under the lowest of them**: the
same colour and role, ranked under every row of that place
(`ownOrder: true`, id `…/under<k>`, never carrying a palette id). On
the eight maps the harness found it, that is the road drawn as a brown
50 % main as wide as the black side borders' centres with the borders
over it: the main's `brown50-road` goes just under the borders'
`black-road-outline`, and the road looks as the mapper drew it. A row
moved this way takes part in "Deviations" like any other.

*Pass 2*, after "Source order": the same walk over the final stack, for
parts with no role and anything the deviations moved; a part above a
part over it goes to a row of its own **directly under that part's
row**.

Moving the under-part down, never the over-part up, keeps every row's
side of lower purple or lowers it: no area or infill goes above lower
purple by this rule. Not moved: symbols drawn from their library entry
(`library`: their parts are the library's, in palette order) and the
parts of a graphic object's symbol (one row per colour, placed by the
source order as a whole). In a table that draws its black under its
brown, a paved area's black edge and dots stay under its brown, as the
source draws them.

#### Deviations (row I4)

**A deviation** is a pair of roles (`upper`, `lower`) with rows that
something is drawn in — objects of source-drawn symbols referencing the
row, or library-drawn objects on the row that carries a palette id
**their library entry draws with** (row I5, carried from I4's review;
decided overnight on the user's standing instruction, 2026-11-17, for
review: until I5 the carriers of their source references' roles, which
differ when the entry uses two ids of one class — a library road whose
source symbol has no black reference made no outline row "used", and a
kept road-over-contour deviation did not hold for it; the report's row
counts and the deviation counts use the same rule) — where the source draws a row of `upper` over a
row of `lower` (a higher source colour) while the palette ranks `lower`
above `upper` and the base order (the palette's, with pass 1's moves)
puts it under too. Its `objects` are the objects drawn in the rows of
each side that so contradict. A pair from one source colour is none, and
so is a pair of one role (rows of one role keep the source order), a
pair whose order pass 1 set (the source's, against the palette) and a
pair where the source agrees with the palette but pass 1's move does not
(a moved part against another colour's row of its over-part's role).
Every deviation is reported, kept or dropped, the most objects first.
Generalises §9.2 step 5(b).

**Kept or dropped.** `KEPT_BY_DEFAULT` (the user's answer 2: roads over
contours) — `brown50-road`, `brown30-road`, `brown50-paved`,
`brown30-paved` and `black-road-outline` over `brown100-line`
(ISOM) or `brown100` (ISSprOM). The road outline is in the list because
the road is its infill and its outline: with the infill alone the
contours would cut every road edge the source draws over them (decided
overnight on the user's standing instruction, 2026-11-17, for review;
the row named the browns only). Since `ocad-20` / `omap-13` the list
also keeps **roads over water** (the user, 2026-11-20, after comparing
his maps in both orders: the only road difference left was a road the
source draws over a stream): `brown50-road`, `brown30-road` and
`black-road-outline` — the same uppers as over the contours, the
paved-area browns included — over `blue100-line` (ISOM) or
`blue100-pointline` (ISSprOM, where the blue points share the row). The
paved browns are in the list because a paved area's black edge takes the
`black-road-outline` role: without them a bordered paved area would be
half over a stream, its edge over and its fill under. The stream sinks to
just under the road and stays over the lakes it is drawn over. **On ISOM
that puts the whole blue line row of that source colour under lower
purple** (streams, ditches, narrow marsh, blue north lines), as a kept
road-over-contour deviation does the contours: the course's circles and
legs are drawn over them on such maps (put to the user, 2026-11-20).
Lakes and other blue areas already stand under the road in the palette.
`ROLE_RULES` has no ISSkiOM table, so on an ISSkiOM-spec map the pair
arises only where a match gives the roles. Every other deviation is
dropped by default.

**Stones under open land** (the user, 2026-11-20: on an older club map
stones come through the open areas in the IOF order) is such a dropped
deviation as far as the mechanism tells (the map file is not in the
cloud; presumed until the pair is seen in the map's panel), and is drawn
as the palette says, on purpose: the source table draws the open-land
yellow over the black (`yellow100>black100`,
or `yellow50` / `yellow75` for rough and semi-open land),
so in the map's own order the yellow covers stones the file still holds
under open land; in the IOF order every black point and line stands
over the yellow, as ISOM draws them. The deviation is listed in the
review page's Colour layers panel with its object counts, and **Keep**
there draws that map in its own order for the pair — and for what that
pair drags along: every black of that colour under the yellow and so
under lower purple, and the yellow over the greens and lakes the source
draws it over (implied keeps). If no such pair is listed, the cover is
another one: a second black or grey (a screened black takes the nearest
black screen role, so the pair is `yellow…>black50-building` or similar),
a white mask or roleless colour the source-order gap placed (no
deviation, nothing to keep; shown under source-ordered rows), or a
library-drawn boulder drawn on the `black100` carrier row. It is not kept by
default, because the same pair on another table would hide paths
and fences under fields (§9.3 "Measured": the yellow the
Club-full and Nacka tables draw over cultivated dots and the black
screen). `deviations: Record<"upper>lower", "keep" | "drop">` overrides
the default per pair (the mechanism; I7 is the UI); `byDefault` is true
when no override decided it.

**The order.** Between rows that something is drawn in, from different
source colours, the relation is fixed: a dropped deviation's rows in the
base order (the palette's), every other pair — a kept deviation's, and
every pair that is no deviation — in the source's order. The stack is the
order closest to the base that keeps every relation: bottom-up, the
next row is the one whose lowest base place among itself and everything
that must stand over it is lowest. So the lower side of a kept
deviation **sinks to just under the upper rows the source draws over
it**, carrying what must stand under it, and nothing rises: no area or
infill row ever goes above lower purple by a deviation, and a row is
never sunk under a row it is drawn over in both orders — the contour
brown stays over the lakes and buildings it was drawn over. On ISOM a
kept road-over-contour deviation puts the contour brown under lower
purple, between the road rows the source has under and over it; rows
nothing is drawn in keep their palette places.

**Keeps that cannot all hold** are a cycle among those relations; since
only a dropped deviation goes against the source, it always runs
through one. Broken one at a time, deterministically: a deviation in the
cycle that is dropped *by default* is kept instead — **implied**
(`impliedBy`: the kept deviations in the cycle), since keeping it costs
only the palette's order on rows the source already orders that way;
with none, the kept deviation with the fewest objects (ties by key)
among those in the cycle and those its implied deviations were implied
by is dropped — **blocked** (`blockedBy`: the other roles of the cycle;
`kept: false`) — and the keeps are resolved again from the start, so
nothing stays implied by a deviation that no longer holds. A deviation
an override dropped is implied only where nothing kept is left to block
(then `impliedBy` names the kept deviations of the cycle, possibly none:
the order a symbol's own parts or the agreed pairs force) (decided
overnight on the user's standing instruction, 2026-11-17, for review).
On Club-full a contour colour with two objects at the bottom of the
table, under the paved brown, implies most of its implied deviations.

#### Source order (row I4)

**What the palette cannot place stands where the source order puts
it**: rows of uses with no role (`no-role`), a graphic object's colour
(`graphic`, one row per colour: logos, frame bars) and **mask whites**
(`mask`): a white role row, drawn by a source-drawn symbol, whose source
colour the table draws over a used row the base order puts above it — a
white drawn over something is there to hide it (the ski-O map's white
under its course overprint, by hint `white-over-green-brown`, over its
black, contours and ski green). `white-skio` is never a mask (§12.3).
Such a row carries no palette id; a needed id whose colour's row became
a mask gets a second row at the palette place.

**The gap.** After the deviations, each such row goes into the gap of
the palette-placed rows that fits the source best: the fewest placed
rows on the wrong side — under it but over it in the source, or over it
but under it in the source — counted by what is drawn in them, then by
rows (rows of its own colour and inserted rows do not count), ties to
the lowest gap; never above the inserted upper purple, and never between
`white-skio` and lower purple or between `orange-skio` and `green-skio`.
Several in one gap stand in source order; rows measured against the
same placed rows this way never cross each other's source order. The
gap is an approximation: where no gap fits every placed row, the
harness shows the rest as `mask`, `no-role` or `layout`.

The source order may put such a row above lower purple (the ski-O map's
mask, Club-full's purple area drawn over its black):
`sourceOrdered[].aboveLowerPurple` says so, for I5's warning and I6's
panel (decided overnight on the user's standing instruction, 2026-11-17,
for review: pure source order, flagged, rather than capping no-role
areas under lower purple, which would sink the mask). This replaces
I3's placement by kind and settles the carried-over `white-upper`: an
inserted `white-upper` has no source position, and a roleless row the
source has on top goes to the lowest gap that fits, under it.

#### In the importer (row I5)

Stage 7 (`matchDocument`, `packages/shared/src/import/match-document.ts`)
takes `colourOrder: "iof" | "source"` (`DEFAULT_COLOUR_ORDER`, `iof`) and
`deviations` (keep or drop by key, the I7 mechanism; ignored in `source`).
Importer bump `ocad-19` / `omap-12` (and `ocad-20` / `omap-13`, roads
over water kept by default, "Deviations" above): every pin is re-matched at the
release (`map:rematch`, `docs/map-import.md` §5). Since row I6 the import
worker passes the map's colour setting ("Per map (row I6)" below); until
it, every stored `ocad-19` / `omap-12` document was `iof` at the defaults.

- **`iof`**: `symbolColourUses` over the matched symbols (their match
  steers the roles, an applied one makes them `library`), then
  `buildColourLayers` with stage 7's `needed` (the entries of `auto`
  matches; an accepted review decision is `auto`), then every symbol's
  `render` re-indexed per reference (`reindexRenderColours`). Objects,
  matching and every symbol's fingerprint are as in the `source` order.
- **`source`**: §9.2 exactly as it stood (`alignColourStack`,
  `remapRenderColours`).
- **The header** records the outcome: `colourOrder: { order, kept? }`,
  `kept` the deviation keys drawn in the map's order, sorted
  (`map-document-format.md` §2). A setting that changes nothing — an
  override equal to the default — gives the same bytes (the deviation warnings'
  messages are fixed per code and do not say why a deviation is kept;
  the report's `layers.deviations[].byDefault` / `impliedBy` do); the
  setting itself stays in the store (I6).
- **The report's `colourStack`** keeps its fields in both orders
  (`source`, `inserted`, `aliased`, `unclassified`; `conflicts`,
  `areasAboveLowerPurple` and `purplesDisplaced` are `[]` in `iof`, where
  nothing is reused or flagged by §9.2's step 5) and adds `order` and, in
  `iof`, `layers` — the layered stack's report less `inserted` and
  `aliased`: `rows`, `split`, `sourceOrdered`, `noRole`, `deviations`,
  `purpleInk` (`mapImport.review` → `stack.alignment`, for I6's panel).
- **Warnings** (`docs/map-import.md` §3.7, class `outcome`). Both orders:
  `COLOUR_UNCLASSIFIED`. `source` only: `COLOUR_ORDER_CONFLICT`,
  `COLOUR_AREA_ABOVE_LOWER_PURPLE` (§9.2 step 5). `iof` only, one count
  per entry, the deviation codes each with one fixed message (the entries are in
  `colourStack.layers`): `COLOUR_DEVIATION_KEPT` (kept by default,
  override or implication), `COLOUR_DEVIATION_DROPPED`,
  `COLOUR_DEVIATION_BLOCKED` (wanted kept, could not hold:
  `blockedBy`), `COLOUR_NO_ROLE` (a roleless row that draws objects),
  `COLOUR_SOURCE_ORDERED_ABOVE_LOWER_PURPLE` (a source-ordered row above
  lower purple that draws objects and may hide the course: a mask, a
  graphic object's colour, a roleless area — a roleless line colour there
  is where line colours go and is not warned). Decided overnight on the
  user's standing instruction (2026-11-17), for review.
- **Never a failed import**: a map whose layers cannot be resolved
  (`ColourLayersError`: an order whose constraints have a cycle) is built
  in the `source` order with `COLOUR_LAYERS_FAILED` and
  `colourOrder.order: "source"`; any other error (a reference outside the
  table) still throws. Not seen on the ten maps (decided overnight, for
  review).
- **Proxies** (objects whose symbol has no IR) draw by ink in the render
  bridge's default (`render.stackProxyColours`, `map-document-format.md`
  §8): row 0, the old default, is another colour on the layers — 173
  objects of the Nacka map would have printed magenta instead of grey.
  The viewer already drew them so; print and thumbnails now do too, in
  both orders (decided overnight, for review).

**The consumers do not change**, each tested on an `iof` document
against the same file in the `source` order: the render bridge (every
applied match drawn, `canonicalMissing` 0, the same inks per symbol);
`courseColourStack` (upper white directly under upper purple, lower
purple over every area row); `materialiseSymbol` / `mapPalette` (every
entry materialisable on the `source` order is on the layers, in the same
inks); a patch re-resolved across a pin that moves onto the layers (G11:
every op kept, its patch symbols materialised again; also through
`runRematch` from a stored `ocad-18` pin); print (every pass in the ink
it has in the `source` order, one ink for a split colour); the GL worker
(the course-completed stack and the course part on a layered document);
the editor's hit test (a building drawn over its paved area is picked,
in its ink). The `measure-parity` (B9) and `measure-print` (C7) tools
the row names were retired with the legacy renderers in E4a
(`map-rendering.md` §6.4, `course-print.md` §11); the colour-order
harness through the importer, `measure-import` twice and the print and
consumer tests above stand in for them (a deviation, decision log).

**Acceptance on the corpus** (ten maps, `map-rendering.md` §6.5 "I5"):
the harness now imports each map twice through the importer — `source`
and `iof` — instead of building the layers itself. **64 014 pixels change,
0 unclassified**: per map and per class exactly I4's numbers
(deviation-dropped 60 613, mask 3 180, no-role 132, residue 88, layout
1), so the importer builds the stack the harness built at I4, and the
rows I5 adds (identified ids, 2–3 on five maps) draw nothing. Roads over
contours are kept on the eight maps whose tables draw them so, none
blocked; implied keeps 1–14. `measure-import` over the ten maps: 0
import errors, every document identical in a second process (10 / 10),
no `COLOUR_LAYERS_FAILED`, stage 6–7 in 18–72 ms per map; the eight
unsupported-primitive warnings it reports come from the normaliser
(stages 3–4) and are the same in either order. **The verdict stands:
the layered stack is fit to be the importer's default.**

| Test | Covers |
|---|---|
| `packages/shared/src/import/__tests__/colour-layers.test.ts` (I5) | every identified id carried, on a zero-object `identified` row of its colour; every palette id of the `source` order present (the badly ordered table, Club-full's); a library-drawn symbol's objects on the rows carrying its entry's ids, its outline carrier a used row in the deviations; an inserted purple 50 % in the course purples' ink, the palette's without a map purple |
| `packages/shared/src/import/__tests__/match-document.test.ts` (I5) | the §9.2 cases pinned to `source`; in `iof`: the stack is `buildColourLayers`' for the source table, every reference re-indexed onto its own colour, `header.colourOrder` with the kept keys, the report's `order` / `layers`, matching and fingerprints unchanged, every `source` palette id carried, the warnings (deviations, no role, never step 5), an override kept and recorded, overrides ignored in `source`, codec round trip with the same inks per symbol, determinism |
| `packages/shared/src/import/__tests__/match-document-fallback.test.ts` | `ColourLayersError` → the `source` order with `COLOUR_LAYERS_FAILED`; another error throws |
| `packages/shared/src/import/__tests__/colour-order-consumers.test.ts` | `courseColourStack`, materialisation of every library entry, a G11 re-resolve onto the layers, print's inks |
| `packages/shared/src/import/__tests__/report.test.ts`, `map-document/__tests__/codec.test.ts`, `render-bridge.test.ts` | the report's `order` / `layers` and the new codes; `header.colourOrder` round trip; proxies by ink |
| `packages/api/src/__tests__/import-ocad.test.ts`, `render/__tests__/colour-order-diff.test.ts` | the two OCAD fixtures on the layers (`e2e/colour-layers.ocd`: split brown, building over paved, street over contour, the black path over lower purple); the importer's candidate equal to I4's harness-built one on `e2e/test.ocd` |
| `packages/api/src/__tests__/integration/{map-import-jobs,map-review,map-rematch}.test.ts` | the stored header's order and the report's layers; `review`'s `stack.alignment`; an `ocad-18` source-order pin re-matched onto the layers with its patch kept and its symbol re-materialised |
| `packages/web/src/lib/editor/__tests__/symbol-pick.test.ts`, `map-gl/__tests__/worker-course.test.ts` | hit test and GL worker on a layered document |
| `e2e/map-vector-layer.spec.ts` "on the IOF colour layers" | on `e2e/colour-layers.ocd`: a building over its paved area, the street over the contour, a leg over the open land and under the black path |

#### Per map (row I6)

**The setting.** A map's colour setting is `{ order, deviations }`:
`order` `iof` (the default) or `source` (answer 1's switch back), and
`deviations` the per-deviation overrides by key (`"upper>lower"` →
`keep` | `drop`), holding only choices that differ from the default
(`KEPT_BY_DEFAULT`), keys sorted — so equal settings are equal bytes, a
reset is removing a key, and an override equal to the default never
reaches stage 7. The overrides are kept while the order is `source` and
apply again on the way back. Code: `packages/api/src/map-store/colour-settings.ts`.

**Where it is stored** (decided overnight on the user's standing
instruction, 2026-11-17, for review; `docs/map-storage.md` §2): one
table, `map_colour_settings`, one row per **club map series** — kept
across its versions, so a promote or any later version is built in the
series' order — or per **event and source file** — an event's own upload,
kept across a re-upload of the same file; another file starts at the
defaults. No row = the defaults. The event's row cascades with its source
row, which the storage GC may remove once no pin, version, document or job
refers to it (`docs/map-storage.md` §8.1): an event that moved to another
file and comes back to this one after that starts at the defaults again. A table rather than columns: a column on
`map_files` would travel in the venue snapshot and the per-event dump,
where an older box image would refuse the unknown field, and one on
`club_maps` alone would split the setting over two homes. `course.useClubMap`
copies the series' row to (event, the version's source), as it copies
the rotation correction and the corrections — and removes the event's row
for that source when the series has none, so the copy is exactly the
series'; after that the two are independent (copy-on-use).

**Read by every import.** `startImportJob` resolves the setting of the
job's target — a club map's series' (a promote's too, which targets both),
else the event's for the source — and snapshots it on the job row
(`map_import_jobs.colour`), so a re-claimed job builds the same document;
the worker passes it as `{ colourOrder, deviations }` into
`importMapToDocument(…, { match })` (carried from I5). A job without a
target is given one by its caller: `decide` and the CRT import the
reviewed document's own (read from its report:
`colourSettingsOfReport`), `setColourOrder` the new setting, the picture
route the other order. Dedup reuses a stored document only when it
follows that setting (`documentFollowsColour`): its report says it was
built so (`reportFollowsColour`: the same order, and in `iof` the same
overrides among the deviations it lists; a document that fell back to
`source` from `iof` is what `iof` gives), or — row I7 — an import in that
setting gave it (§9.3 "Overrides (row I7)"); the setting stays in the
store and the header records the outcome (I5).

**The switch** is `mapImport.setColourOrder { documentHash, order, target }`
with `finalise`'s target and `decide`'s permission (`docs/map-import.md`
§2.2): it writes the order on the target's row and rebuilds as `decide`
does — a job without a target, the document stored and pinned nowhere
until **Use this version**. Flipping back finds the original document by
dedup. The setting is written at once, so a pin whose document is in
another setting is stale for the re-match (reason `colour`,
`docs/map-storage.md` §6.9) — for club versions and, the setting being
the event's own, for event pins too — and `review.current` is false for it
(decided overnight on the user's standing instruction, 2026-11-17, for
review: the alternative, writing the setting only at **Use this
version**, would leave a flipped-but-unused switch remembered nowhere).
The write and the rebuild are one function (`changeColourSettings`,
`map-store/review.ts`) taking the change as a callback: row I7's
`setDeviation` only adds a mutation and the panel's controls.

**The picture** is drawn from stored documents by the reference raster
over a capped window (`docs/map-storage.md` §4.5): the document's own
order from it, the other order from the document the switch would give,
imported on the first request when no such document exists yet — the
picture is exactly what the switch gives (decided overnight, for review;
the alternative of re-stacking the stored document in memory would be a
second derivation of stage 7). Its other order uses the club decisions
as of that first request, as the switch would then; the PNG is stored
once, so a later decision does not redraw it (the document is then *not
up to date* anyway). A failed import of the other order is answered 502
and not started again for 10 minutes per instance; a running one for the
same source, corrections and setting (a switch just pressed) is waited
for, not doubled.

**Not in I6**: the deviation overrides' controls (row I7, below); the
setting in the per-event dump and the checkout snapshot
(`docs/map-storage.md` §9); a club-wide default list.

| Test | Covers |
|---|---|
| `packages/api/src/__tests__/map-colour-settings.test.ts` | parse (malformed → defaults), normalise, stage 7's options, the setting read from a report (`iof`, `source`, overrides, the fallback, pre-layers), `reportFollowsColour`; the panel's payload on both fixtures (13 layers, the split flag on the two brown 50 % rows and not on `test.ocd`'s identified white, `draws-nothing`, 9 deviations with defaults and why, none in `source`) |
| `packages/api/src/__tests__/integration/map-colour-settings.test.ts` | `docs/map-storage.md` §10 |
| `e2e/map-review.spec.ts` (I6 test), `packages/web/src/lib/__tests__/map-review-colours.test.ts` | §8.7 |

#### Overrides (row I7)

Answer 2 asked for the overridden defaults to be changeable "if it is not
a lot of extra work"; row I7 makes the panel's deviation rows editable.

**The mutation** is `mapImport.setDeviation { documentHash, key, choice,
target }` (`docs/map-import.md` §2.2), with `setColourOrder`'s target,
permission and errors: `choice` is `keep` or `drop` — a deviation the
reviewed document lists, else `BAD_REQUEST` — or `default`, which removes
the key whatever the document lists (a reset). It is `changeColourSettings`
with the one choice changed (`withDeviationChoice`): the setting is
normalised, so a choice equal to the default is no override, and the
source is imported again in the new setting as the switch does — a job
without a target, pinned nowhere until **Use this version**; a reset of
every override finds the original document by dedup. A document in the
map's own order lists no deviations and shows no rows, so overrides are
edited in the IOF order; they are kept while the order is `source` and
apply again on the way back (§9.3 "Per map (row I6)").

**An override that changes no bytes** (carried from I6). Keeping a pair
the palette already keeps by implication — on the fixture
`black50-building>brown100-line`, implied by `brown50-paved>brown100-line`
— gives the same `header.colourOrder.kept` and the same document hash.
The document's report is written once, by its first import (the store
skips a duplicate hash), so it still says *by default*; judged by the
report alone, the pin was stale for `colour` on every re-match, dedup
never hit and `review.current` stayed false. The user chose (2026-11-18)
to record what gave a document: every finished import job writes the
setting it was asked for to `map_document_colour_settings` (one row per
document and normalised setting, `docs/map-storage.md` §2), and a document
follows a setting when its report says so **or** a recorded setting
matches — both sides compared on what can change the document: in
`source` no overrides, in `iof` the overrides of deviations the document
lists (`documentFollowsColour`, `map-store/colour-settings.ts`). It is
read by dedup (`currentDocumentFor`), the re-match (§6.9) and
`review.current`. A symbol decision or a CRT import on the review page
imports in the map's setting (`decide` and `importCrt` take the review's
`clubMapId`, else the current event, as `review` does) when the reviewed
document follows it, else in the document's own setting read from its
report — so a decision on a map holding a no-op override gives a document
recorded under that override, current and not re-matched. Two changes of
one map's setting at once do not lose one: `changeColourSettings` reads,
changes and writes under a lock on the target. Judging by the outcome (`kept`) alone was rejected: with
two or more implied keeps, or a version first built under a no-op override
and then reset, it stays stale; carrying the overrides in the header
(different settings, different bytes) was rejected as reversing I5's
"same bytes" rule. The table is cache-like: a lost row costs one
re-import, which writes it again; a side table, not a column on
`map_documents`, for the reason I6 gave for `map_colour_settings` (the
venue snapshot carries `map_documents` and an older image refuses an
unknown field).

**The picture follows the overrides** (carried from I6). A `source`
document lists no deviations, so its IOF picture — the document the switch
back gives — was drawn at the defaults. The review now builds that URL
with the map's overrides as `?deviations=upper>lower:keep,…` (normalised,
keys sorted; only on a `source` document's IOF picture); the route imports
the other order with them and stores the PNG under a key of its own
(`iof-<digest>`, `docs/map-storage.md` §4.5), so a picture is never reused
across different overrides; only overrides of deviations the IOF document
lists count, so the stored keys stay bounded whatever a reader asks for. An `iof` document's pictures need no query:
its own order is drawn from it, and the map's own order ignores overrides.

**Not in I7**: a club-wide default list; batching several overrides into
one rebuild.

| Test | Covers |
|---|---|
| `packages/api/src/__tests__/map-colour-settings.test.ts` (I7 blocks) | the no-op override gives the same hash and is followed only through a recorded setting; the comparison on listed keys and in `source`; the setting key; `withDeviationChoice` (keep, drop, reset, a choice equal to the default, kept in `source`); `reportDeviationKeys`; the payload's `choice` / `overridden` (a no-op override shown overridden while `why` is `implied`); the picture URL's `deviations` query only on a `source` document's IOF picture; the query parsed and the picture key |
| `packages/api/src/__tests__/integration/map-deviation-overrides.test.ts` | the recorded rows (written per job, checks, cascade); the no-op override: same document, `review.current`, no re-match item, dedup; keep a dropped one and drop a kept one (new documents, not pinned, the review's rows); resets back to the original by dedup; kept through `source` and back; bad key, unknown deviation, unknown target, signed out; an event's own upload (`courses.edit`, the re-match, a no-op on the event); a `source` document's IOF picture with the overrides under its own key and ETag, drawn from the override document |
| `packages/web/src/lib/__tests__/map-review-colours.test.ts` | the row's controls: pressed choice, the pressed button disabled, reset only when overridden, all disabled without edit rights, while busy, without a target |
| `e2e/map-review.spec.ts` (I7 tests) | club route: keep the paved-over-building pair (new hash, `data-why="override"`, the IOF picture differs), drop the road pair, reset each back to the original document in use, a no-op keep of the implied pair (same hash, overridden, still in use, not outdated); event route: the panel, both pictures scoped with `?event=` and loaded, an override and its reset, the switch and back with the event target |

#### Measured (rows I3 and I4)

Measured at the I4 defaults; the `ocad-20` default (roads over water)
has not been run on the ten corpus maps.

**At I4** (`map-rendering.md` §6.5 "I4", the tables per map and the
reading): over the ten maps **64 014 pixels change** against the source
order (I3: 710 573; 0.043 % of all pixels, 0.22 % of ink), and **every
one is classified — the gate holds, 0 unclassified**:

| Class | Pixels | Share | What it is |
|---|---|---|---|
| deviation-dropped | 60 613 | 94.7 % | a deviation the report lists, drawn in the palette's order: yellow areas the table draws over cultivated dots, the black screen or a lake (Club-full, the Nacka map); the ski green over contours and black (ski-O map, §12.3); a second blue under the contours (puit-de-laven); contours and green points (the club maps) |
| mask | 3 180 | 5.0 % | Club-full and the Nacka map: a white at the bottom of the table that the source draws over a one-object lake; the source-order gap puts it under |
| no-role | 132 | 0.2 % | roleless rows (a purple area, a red line) where the gap fits not every layer |
| layout | 1 | 0.0 % | a graphic object's colour (Club-full) |
| residue | 88 | 0.14 % | isolated pixels no paint image names even at 3× (a sub-pixel feature, a tile's edge); capped per map in the classification file |
| deviation-kept, multi-role, unclassified | 0 | — | |

Per map, I3 → I4: Sprint 19 759 → 1 044, Club-full 224 660 → 17 684,
Club-2026 79 516 → 821, Crop-A 4 142 → 416, Crop-B 1 977 → 214,
Mörtsjön 27 009 → 75, Erstavik crop 25 707 → 1 677, puit-de-laven
2 293 → 2 288, ski-O map 90 544 → 12 826, Nacka exercise map
234 966 → 26 969. Roads over contours are kept by default on the eight
maps whose tables draw them so (none blocked); implied
keeps run from 1 (Crop-A, Crop-B) to 14 (Club-full). With the road
outlines fixed and every remaining difference a listed deviation, a
mask, a roleless colour or a capped residue, **the layered stack is fit
to be the importer's default** (row I5).

**At I3** on the ten maps by the harness (`map-rendering.md` §6.5,
"I3", the table per map): 710 573 pixels change against the source
order (0.472 % of all pixels; the permutation, I1: 932 429). The
multi-role class is gone — Sprint's buildings and canopy buried under
the paved brown 10 103 → 63 px — and what remains is named: road infill
and paved brown under the contours and other dropped deviations, the
ski-O map's mask white, uses with no role (I4), and on eight of the ten
maps chiefly the **road outlines**: roads drawn inside out (Q3 above), a
brown 50 % main as wide as the side borders' centres under black
borders, whose `brown50-road` ranks above the borders'
`black-road-outline` and covers half of each border (Mörtsjön, with no
multi-role colour, rises 3 398 → 27 009 px by it). Row I4 fixes that
case against the harness; until then (at I3) the layered stack was not fit to be
the importer's default.

| Test (`packages/shared/src/…`) | Covers |
|---|---|
| `import/__tests__/colour-layers.test.ts` | a badly ordered ISOM table: the whole stack bottom first (the paved area's and the building's black edge and dots kept under their fills, own order); one brown 50 % split into paved area and road infill (same ink and number, ids `src:n` and `src:n/<id>`); one black as road outline and, moved under fills, dots and edges (ids `…/under<k>`, unique); the road outline over the paved brown and under the infill, buildings over the paved brown; every source-drawn symbol's parts in source order; each palette id on one row, every needed, purple and overlay id present; an alias (source ink, a row of its own) and an insert (palette ink); unreferenced colours (identified, and by name); a zero-object symbol's row; no-role rows, the graphic row and unused roleless colours by the source order (between the contour brown and the blue; `sourceOrdered` with `aboveLowerPurple`); both course purples inserted in the map's ink, the source purple an ordinary row at the bottom; the overlay's places; `courseColourStack`; the per-reference re-index, every reference on a row of its own colour, `reindex.colours`; `documentSymbolFingerprints` unchanged; two colours of one role (source order; the carrier by use, ties to the lowest); a hinted source purple under the course row, the ink by use and by index, the palette's without a purple; both specs' order (the contour brown either side of lower purple; every row in palette order); a ski green as `green-skio`, never aliased; a no-role colour drawn by an area and a line (two rows, `src:n` and `src:n/none:other`); the alias by use, ties to the lowest index; an inserted `purple50` in the palette's ink; spot and overprint on split rows; an inserted row the edition lacks named `iof2024:`; determinism; input unchanged; bad references and infos. I4: an OCAD road drawn inside out (brown main under black borders, suggested match) — the main on a row of its own just under the outline, no palette id; the same road drawn from the library at the palette places, carrying the ids; its infill under the table's black a dropped deviation with the library road's objects; Club-full's table (`club-colour-tables.ts`): every deviation listed with object counts, most first; streets (infill and outline) over the contours kept by default — the contour brown under the road, over the lakes and paved areas it was drawn over, under lower purple, the infill under lower purple; both dropped by override (the contour brown over the road and lower purple); a lake over the contours dropped by default and kept by override (under lower purple); keeps that cannot all hold: a default-dropped pair implied (`impliedBy`), blocked by an explicit drop (`blockedBy`), deterministic; a mask white (hint `white-over-green-brown`) over the black by the source order, no palette id, `aboveLowerPurple`; a white the source has at its palette place stays there; a graphic frame bar's black on a row of its own at its source place; an inserted `white-upper` over a roleless colour the table has on top (ISSprOM); the carrier is §9.2's colour (most used), not the row with the most objects; a moved part against another colour's outline the source draws under it (kept under it, no pair of one role a deviation); pass 2 (a roleless part the gap put over its symbol's black, moved directly under it); nothing left implied by a deviation that is then blocked. `ocad-20`: roads (infill and outline) over a stream kept by default — the stream under the road, over the lake, under lower purple; both dropped by override; a bordered paved area whole over a stream; a contour over road over stream, nothing blocked; ISSprOM's `blue100-pointline`; stones (black 100 %) the table draws under the open-land yellow drawn over it by default and under it by a keep override |
| `render/__tests__/transform.test.ts` | `reindexRenderColours` (one row per reference, the identity, a count mismatch throws) |

## 10. Pending in this chapter

- **Canonical layers (§9.3)**: the importer draws on them by default
  since I5, with the per-map switch and the colour panel since I6 and the
  per-map deviation overrides since I7. Not in the slice: batching several
  overrides into one rebuild; a club-wide default
  for which deviations are kept; an inserted purple 50 % as a 50 % screen
  of the map's purple (both orders use it at full strength).
- Mapper object queries as CRT sources (§8.6 `CRT_QUERY_UNSUPPORTED`)
  and a variant table to Mapper's sub-numbers, if a club needs either.
- Library variants for the OCAD template conventions (§8.4) if the auto
  rate needs to rise.
- The `ISMTBOM2022` library (palette rows exist).
- ISSkiOM overlay entries in the review page's **Other library symbol…**
  picker (§8.7; it lists the document's library, while candidates and
  the API already take overlay entries, §8.2, §8.5).
- The rest of ISSkiOM 2019 (§12.1 "Left out"): its deviations to ISOM
  base symbols (75 % open land, vegetation as 406, contours 0.11 mm, the
  "other symbols" factors applied to the base library on a ski map) and
  its course-planning symbols with their fixed sizes; Swedish ISSkiOM
  names if SOFT publishes a translation (§12.4).
- Swedish names for `ISSprOM2019-2:105.2`, `533`, `715` when SOFT
  publishes a Rev 6 translation of ISSprOM (§3.2).
- `ISSOM2007` aliases for `ISSprOM2019-2` once an ISSOM 2007 → ISSprOM
  table is available (§3); the matcher reading aliases (a stage-3
  candidate set) once a corpus map uses ISOM 2000 numbering to tune it on.
- The OOM dimension spot check if 03 §10's licence question is settled in
  favour.
- `defaultMapAppearance` deleted with the legacy course overlay (slice
  E); until then it is the legacy sizes and the denominator of the
  course layer's appearance multipliers (§7).
- Mapper's 511-coded power line (suggested 510 only) is not normalised
  (A15 scoped to the railway); revisit if a Mapper corpus map shows it.

## 11. Materialisation and the palette (Map mode)

Map mode (`course-editor.md` §13) draws new objects and re-symbols old
ones with symbols the document's table may not have. A library entry
placed in a document for that purpose is **materialised**: its colours
resolved through the document's aligned stack and its dimensions scaled
to the document, giving a `patchSymbolSchema` entry the event's patch
stores under the entry's full id (`map-patches.md` §1.3). The **palette**
is what Map mode offers to draw with. Both live in
`packages/shared/src/map-document/materialise.ts` and are exported from
`mapDocument`; both are pure, read only the document's header and
object table, and never change the colour stack (slice G, "Decided in
this split": a patch never changes the colour stack).

### 11.1 `materialiseSymbol`

```ts
materialiseSymbol(doc: Pick<MapDocument, "header">, canonicalId: string): MaterialiseResult

type MaterialiseResult =
  | { ok: true; key: string; symbol: PatchSymbol; factor: number }
  | { ok: false; reason: "unknown-entry" }
  | { ok: false; reason: "missing-colours"; missing: string[] };
```

- `canonicalId` is a full entry id of **any** registered library
  (`ISOM2017-2:206`, `ISSprOM2019-2:529`, `ISSkiOM2019:803.2`). An id
  `getLibraryEntry` does not know is `unknown-entry` — a result, never a
  throw.
- **Materialisable** means every palette id of `colourRefs(entry.render)`
  (§4) is in the stack's palette index (`paletteIndexOfStack`, the index
  the render bridge resolves canonical matches through, §9). Otherwise the
  result is `missing-colours` with the absent ids, sorted. There is no
  same-class substitution: an entry whose `blue100-area` the stack lacks
  is not drawn in the stack's blue line colour. The stack is never
  extended: G21's importer inserts the overlay's rows (`green100-area`,
  `white-skio`, `orange-skio`, `green-skio`) into every aligned stack
  (§9.2, §12.3), so on a document imported at `ocad-17` / `omap-10` or
  later every ISSkiOM entry resolves; a document stored before that lacks
  them until the release's re-match, and its ski entries report the
  missing rows.
- **The factor** the entry is scaled by:
  - an entry of the **document's library** (`header.library.id`):
    `header.documentFactor` — the same number `canonicalRender` uses, so
    a materialised symbol draws exactly as a document symbol auto-matched
    to the same entry (`map-document-format.md` §8);
  - an entry of **another library** (the `ISSkiOM2019` overlay; a base
    library that is not the document's): `libraryFactor(library,
    mapScale, entry.code) × symbolScale` (§12.2), the entry's code picking
    ISSkiOM's track or other scale column. **`symbolScale` is derived**,
    not stored: `documentFactor ÷ libraryFactor(documentLibrary,
    mapScale)`, unrounded — 1 for a map drawn at its spec's enlargement for
    its scale (§8.3). The header stores only `documentFactor`; the import
    report's `matching.factor.symbolScale` is the same quotient rounded to
    three decimals, so the two can differ in the fourth;
  - a header with `library: null` (never matched) or naming a library
    that is not a registered base library: `symbolScale` 1, so every
    entry, of whichever library, takes `libraryFactor(library, mapScale,
    entry.code)`.

  `materialiseFactor(header, entry)` is this rule on its own (exported
  for G9 and the tests). For a matched header it is G21's
  `entryFactor(doc, entryId)` (`import/matcher.ts`, §12.2), the one
  formula the matcher, the render bridge and materialisation share;
  `entryFactor` gives an entry of the other base library its own factor ×
  symbolScale too (no matcher or render-bridge caller passes one).
- **The symbol**: `code` = the entry's code, `name` = its English name,
  `kind` = the render's type, `origin: "source"`, `hidden: false`, no
  `match`, no `sourceIndex`, and `render` = `resolveEntry(entry, index)`
  scaled by the factor (`render.id` is the full entry id). `key` is
  `canonicalId`. It is the `patchSymbolSchema` parse of that value, so
  the client's put and the server's parsed copy serialise identically.
- **Deterministic**: the result is a function of the entry, the stack's
  palette ids, `library`, `documentFactor` and `mapScale`; the same input
  gives the same JSON, which is what makes two clients materialising the
  same key on first use put the same state (`map-patches.md` §1.3).
- Every entry materialises, text and 7xx included; what Map mode offers
  is the palette's choice (§11.2).

`canonicalEntryRender(entry, index, factor)` is the one
resolve-and-scale step, shared with `canonicalRender`; it throws
`UnknownPaletteIdError` on a missing colour.

### 11.2 `mapPalette`

```ts
mapPalette(doc: MapDocument, patch?: MapPatch | null): PaletteGroup[]   // doc: the pinned document

interface PaletteGroup {
  id: "library" | "ISSkiOM2019" | "other";
  library: SymbolLibraryId | null;   // the document's library, the overlay, null for "other"
  headings: PaletteHeading[];
}
interface PaletteHeading {
  code: string;                       // "302", "801.1", or a source base code ("850")
  name: { en: string; sv?: string };
  entries: PaletteItem[];             // at least one
  search: string;                     // lowercased: code, names, every entry's code and names
}
interface PaletteItem {
  kind: "point" | "line" | "area";
  source: "document" | "patch" | "library";
  ref: PatchSymbolRef;                // { doc: index } | { patch: full entry id }
  canonicalId: string | null;         // the entry it is drawn as (the swatch); null = the document symbol's own drawing
  code: string;
  name: string;                       // source name, or the entry's English name
  nameSv?: string;
  objects: number;                    // objects using it in the document; 0 for patch and library items
  enabled: boolean;
  missing?: string[];                 // palette ids, when not enabled
}
```

The document's source table presented through its matches, plus the
entries it can materialise (03 §1, 08 §4.7), grouped as the course
editor's symbol list (P3, `course-editor.md` §7 "filter region").
`doc` is the **pinned** document the patch is keyed onto; an effective
document (`applyPatch`'s output, whose table already has the patch's
symbols appended) throws, as `applyPatch` does on one.

- **Document items**: every source symbol that can be drawn — its own
  `render`, or an applied match to a known entry — of kind point, line or
  area, used by objects or not. Not listed: hidden symbols, `missing`
  and `graphic` ones, text, rectangle and unknown kinds (an `add` is a
  point, line or area, `map-patches.md` §1.2), and symbols drawn by proxy.
  `ref: { doc: index }`; `canonicalId` is the applied match's entry, else
  null.
- **Patch items**: every point, line or area symbol of `patch.symbols`,
  referenced by an op or not, `ref: { patch: key }`, always enabled (it was materialisable
  when it was put).
- **Library items**: the point, line and area entries of the document's
  library (`documentLibraryId`) except the **course symbols (7xx)** —
  course overprint is the course layer's (08 §4.5); the mapper's own
  7xx source symbols stay listed as document items (user 2026-11-13) —
  and, when the stack's palette index has `green-skio`, every entry of
  `ISSkiOM2019`. `ref: { patch: entryId }`, which Map mode fills by
  `materialiseSymbol` on first use (row G9). An entry that is not
  materialisable is listed **disabled** with its `missing` palette ids
  (slice G, "Decided in this split"). An entry already covered — the
  applied match of a document item, or a key of `patch.symbols` — is not
  repeated. The other base library is not offered (an ISSprOM entry on an
  ISOM map); `materialiseSymbol` accepts it all the same.
- **Headings**: a document item's heading is its applied match's entry
  code, else its source code's base (`505.1` → `505`); a patch or library
  item's is its entry's code. The heading's name is the library heading
  entry's (variant `null`) whenever the heading is one of the library's,
  matched or not — P3 names an unmatched heading after its source
  symbol; here the heading also holds the library's own entries — else
  the first item's name.
- **Groups**: `library` (headings of the document's library), then
  `ISSkiOM2019` (items of the overlay: its entries, document symbols
  matched to it, patch symbols keyed by it), then `other` (headings outside
  both — club codes, symbols of another library). An empty group is left
  out, so the overlay group is absent on a stack without `green-skio`
  (a document stored before G21) unless the document or the patch already
  has ski symbols; on every document imported since G21 it is present.
- **Order**: headings by code (`compareSymbolCodes`: numerically where
  both are numeric, numeric before non-numeric, else by string); within a heading, document
  items (applied match first, then more objects first, then index), then
  patch items (by key), then library items (heading entry before its
  variants, library order).
- Every enabled item's `ref`, put with its materialised symbol where it
  is a library item, passes `applyPatch`'s symbol and kind checks for an
  `add` of its `kind` (`map-patches.md` §2.3).

The palette carries no materialised symbols and no swatches: G9's picker
(`course-editor.md` §13 "Symbol picker") draws a swatch from
`canonicalId` (the library preview route, `map-storage.md` §4.5) or the
document symbol's own route, and calls `materialiseSymbol` when an item
is used (`modes/map/symbols.ts` `symbolPut`), in the web, over the
model's pinned copy of the document.

## 12. ISSkiOM 2019: an overlay library

`ISSkiOM2019` is the third registered library (G20; slice G answer 9).
It is **not** a third base library: a ski-O map's base symbols stay
ISOM 2017-2's (or ISSprOM's), and `ISSkiOM2019` holds only what ski
orienteering adds — the track symbols in every width and state, the
two ski-only roads, the prepared area, and the ski versions of three water
and marsh symbols. Its entries are offered and matched on **any**
document beside the document's own library (G8, G21); a document's
`header.library` is never the overlay, and `chooseLibrary` never returns
it. The guards that read a stored header's library —
`documentLibraryId`, `documentFollowsDecisions`, `courseDocumentContext`
— go through `isDocumentLibraryId` (registered and not an overlay), so a
header naming `ISSkiOM2019` is treated as having no library and falls
back to the scale's. Matching (§8.2 "Overlay candidates"), the factor an
overlay entry is drawn at (§12.2, `entryFactor`) and the colour rows
every stack carries (§12.3) landed with G21.

Source: *ISSkiOM 2019, International Specification for Ski Orienteering
Maps, Revision 4* (IOF Map Commission, September 2026, valid from
1 November 2026), fetched from the IOF's mapping page (orienteering.sport)
on 2026-11-13 and kept under `.local/research/iof-specs/` with the other
spec texts (never committed). Dimensions are the text's and its
drawings' only (§3), in µm at the text's reference scale **1:15 000**.

### 12.1 What is in it

The user's scope (2026-11-13): §3.3.1's thirteen track symbols plus
§3.3.2's three water / marsh variants. Sixteen headings, one entry each
(no variants):

| Entry | Heading | Type | Scale group | Drawing (µm at 1:15 000) | Palette ids |
|---|---|---|---|---|---|
| `801.1` | Very wide track > 3.0 m | L | track | green 850 | `green-skio`, `white-skio` |
| `801.2` | Very wide track > 3.0 m, compulsory to stay on | L | track | orange 610 inside black 120 edges (850 overall) | `orange-skio`, `black100`, `white-skio` |
| `802.1` | Wide track 1.5 - 3.0 m | L | track | green 600 | `green-skio`, `white-skio` |
| `802.2` | Wide track 1.5 - 3.0 m, compulsory to stay on | L | track | orange 360 inside black 120 edges (600) | `orange-skio`, `black100`, `white-skio` |
| `803.1` | Track 0.8 - 1.2 m | L | track | green 500, dashes 3 000 / gaps 500 | `green-skio`, `white-skio` |
| `803.2` | Track 0.8 - 1.2 m, compulsory to stay on | L | track | orange 260 inside black 120 edges (500), dashed 3 000 / 500 together | `orange-skio`, `black100`, `white-skio` |
| `804.1` | Track, slow 0.8 - 1.0 m | L | track | green dots ø 700 every 1 300 (CC) | `green-skio`, `white-skio` |
| `804.2` | Track, slow 0.8 - 1.0 m, compulsory to stay on | L | track | black dots ø 700 with orange ø 460 inside, every 1 300 (CC) | `orange-skio`, `black100`, `white-skio` |
| `805` | Road covered with snow | L | track | black 700 | `black100` |
| `807` | Unploughed road | L | track | two black 120 lines 140 apart (380 overall), dashed 3 000 / 500 | `black100` |
| `808` | Prepared area | A | track | green 100 % cross-hatch: lines 200 wide, 800 (CC), ±45°; Ski-O green outline 130 | `green100-area`, `green-skio` |
| `813.1` | Public snow mobile route | L | track | green 810: 120 edges, a 570 core dashed 1 500 green / 1 000 white | `green-skio`, `white-skio` |
| `813.2` | Public snow mobile route, compulsory to stay on | L | track | black 120, orange 120, a 330 core dashed 1 500 orange / 1 000 white, orange 120, black 120 (810 overall) | `orange-skio`, `black100`, `white-skio` |
| `301.1` | Crossable body of water | A | other | blue 50 % with a 100 blue bank line (as ISOM 302) | `blue50-area`, `blue100-line` |
| `301.2` | Body of water that shall not be crossed | A | other | blue 100 % with a 300 black bank line | `blue100-area`, `black100` |
| `310.1` | Marsh (in ski orienteering map) | A | other | ISOM 2017-2 310's dashes (900 × 100, gap 250, rows 300 (CC), alternate rows shifted) in blue 50 %, orientated to north — the text's "same symbol as 310"; the ISSkiOM drawing is unlabelled and visibly finer | `blue50-area` |

Readings of the text, each in the entry's `notes`:

- **The white mask** — "a white mask (0.15 mm on each side) is used
  under all green and orange track symbols" — is the main stroke's
  `halo` in `white-skio`, 150 µm beyond the symbol's overall width on each
  side, `continuous` under dashed tracks (the drawings outline the whole
  dashed line), and a white disc ø 1 000 under each dot of 804.1 / 804.2
  (the drawings ring each dot). 805, 807 and 808 are black or area
  symbols and have none.
- **"Compulsory to stay on"** (§2.5, Rev 4: "black outline 0.12 mm
  (inside)"): the orange core is `main`, the black edges are `borders`
  120 wide whose outer edge is the symbol's overall width, so 801.2,
  802.2 and 803.2 are exactly as wide as their green states. Dashed
  borders share the main line's dash phase (`map-rendering.md` §4.4).
- **813.1 / 813.2's white dashes** are where the core's dashes leave a
  gap and the mask shows through: no white row sits above Ski-O green,
  and the colour line names only the white under lower purple.
- **813 is 0.81 mm overall in both states.** 813.1's "0.12 / < 0.57 /
  0.12" labels its green edges and its core, as 801.2's "0.12 / < 0.61 /
  0.12" does (measured: both 813 drawings are the same width, at the
  scale on which 801.2 measures 0.85). 813.2 labels five bands — 0.12,
  0.12, 0.33, 0.12, 0.12 — Rev 4's black edges inside and the white core
  "reduced to 0.33 mm" from 0.57, so like every compulsory state it keeps
  its green state's overall width.
- **Junctions** ("drawn solid", "the beginning of a slow track is drawn
  with a short line") are the mapper's drawing, not the symbol's;
  OCAD's dash fitting (`DASH_NOTE`) starts and ends every dashed section
  with a full dash.

Left out, waiting (§10): ISSkiOM's deviations to ISOM base symbols
(§3.1: open land at 75 %, all vegetation as 406, 416's dotted line only,
contours 0.11 mm; §3.3.2's 515 *Impassable wall (barrier)*, which is
ISOM 2017-2's 515 drawn as specified there), and its course-planning
symbols (§3.3.3: 701–707, 709, 715, 716, 717, 719, 720.1, 720.2 and 841
*One-way compulsory*), whose sizes are fixed at every scale — the course
layer's job.

### 12.2 Scale: `scaleRules` and `libraryFactor`

ISSkiOM §3.2 enlarges the track symbols and the other symbols by
different factors (03 §6.6, "a per-library table rather than a
formula"):

| Map scale | Track symbols | Other symbols |
|---|---|---|
| 1:15 000 | 1 | 1 |
| 1:12 500 | 1 | 1.2 |
| 1:10 000 | 1 | 1.5 |
| 1:7 500 | 1.33 | 1.5 |
| 1:5 000 | 1.5 | 1.5 |

The library carries the table as `scaleRules: { track: [...], other:
[...] }` (`{ mapScale, factor }` rows, the factors as printed — 1.33, not
4/3) and every entry names its row set in `scaleGroup` (§2). The
registry exports

```ts
libraryFactor(libraryId: SymbolLibraryId, mapScale: number, code?: string): number
```

the enlargement of the library's dimensions on a map at `1:mapScale`,
unrounded:

- a library without `scaleRules` (ISOM 2017-2, ISSprOM 2019-2):
  `referenceScale / mapScale` — the same number `course/context.ts`
  computes today (`ISOM2017-2` at 1:10 000 → 1.5, `ISSprOM2019-2` at
  1:3 000 → 1.333…); `code` is ignored;
- a library with `scaleRules`: the row set of the entry with heading
  `code` (`"803.2"`, `"301.1"`); `code` may be omitted only when the
  library has one row set; an unknown code throws;
- a scale the table does not list takes the row whose scale is nearest
  by ratio (|ln(mapScale / row)|), a tie to the larger denominator — so
  1:4 000 takes the 1:5 000 row and 1:20 000 the 1:15 000 row;
- a non-finite or non-positive scale throws.

G8 multiplies it by the document's `symbolScale` when it materialises an
entry of another library than the document's (§11.1: `symbolScale` is
derived as `documentFactor ÷ libraryFactor(documentLibrary, mapScale)`).
The matcher and the render bridge do the same through `entryFactor(doc,
entryId)` (`import/matcher.ts`), which `materialiseFactor` calls:
`libraryFactor(library, mapScale, code) × documentFactor /
libraryFactor(document library, mapScale)`, unrounded, for an entry of
any other library, and the document factor for an entry of the
document's own library.

### 12.3 Colours

ISSkiOM's colour line names two colours the IOF colour table's ISSkiOM
column does not tick (user decisions 2026-11-13):

- **`white-skio`** "White under Ski-O tracks" — a palette row Oxygen
  adds, directly below `purple-lower` in both editions, ticked for
  ISSkiOM only. The text says "white (under lower purple)"; the table's
  ISSkiOM whites are upper white (above the tracks) and white over
  yellow (below every map colour but yellow). In the ISSkiOM stack the
  mask therefore hides brown, the road and area colours, and is itself
  under black, blue lines, the tracks and both purples. ISSkiOM's 301.1
  drawing shows a track's mask cutting the blue bank line as well; no
  position satisfies both that and "under lower purple" (blue lines sort
  above lower purple), so the text's colour line wins — **the user chose
  the IOF colour table over the 301.1 drawing** (2026-11-13, before G21
  inserted the row into every stack): on every map the mask is directly
  below lower purple, over the area and road colours and under every
  line, black and the tracks. A source that keeps its own used mask
  higher — directly under the track green, as the 301.1 drawing has it —
  keeps its order and gets a `COLOUR_ORDER_CONFLICT` against lower purple
  (§9.2 step 5: flag, never reorder).
- **`green100-area` is ticked for ISSkiOM** — 808's raster is "green
  100 %" since the 2023 erratum; the row already exists in every ISOM and
  ISSprOM stack.

The ISSkiOM stack is 20 rows in `iof2024` (the table's 18 plus these
two) and 19 in `iof2022`, which has no `orange-skio` — the five
compulsory states do not resolve against a 2022 ISSkiOM stack.

**Answer 8 widened** (user 2026-11-13): G21's importer inserts every
palette row the overlay uses — `green-skio`, `orange-skio`, `white-skio`
and, for 808, `green100-area` — where a document's stack lacks it, at its
palette position, so every track state can be drawn on any map; the
patch still never changes a stack. A 2022-edition document receives
`orange-skio` with its 2024 CMYK.

Implemented in G21 (§9.1, §9.2 step 4): a source's own Ski-O colours
are identified (name, else ink above black) and never aliased; where a
stack lacks one, `green100-area` goes in by steps 3–4 (never above
lower purple), `white-skio` directly below lower purple, `orange-skio`
and `green-skio` directly below the upper overprint colours above lower
purple (orange under green). "At its palette position" is read as these
rules rather than the nearest-neighbour rule of step 4, which on real
tables put the tracks under black (Mapper keeps railway white below
black) or under the whole map (a copy of upper purple at the bottom) —
decided overnight on the user's standing instruction, 2026-11-13, for
review. Every ISSkiOM track entry resolves against every aligned stack.

### 12.4 Names

No Swedish ISSkiOM text from SOFT was found (2026-11-13: SOFT's ski-O
pages describe the track model in prose and publish ISOM and ISSprOM
translations only), so every entry's `name.sv` is absent and
`symbolLibraryNameSources.ISSkiOM2019.sv` is `null` (answer 11; §3.2).
No aliases: there is no older-spec table.
