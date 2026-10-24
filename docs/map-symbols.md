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
│                         manmade, technical, course, names, index
├── ISSprOM2019-2/        same layout
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
- **Course symbols are ordinary entries** with `purpleRole` per 03 §2.4:
  ISOM 704 lower / ISSprOM 704 upper, ISOM 710 lower / ISSprOM 710.1 lower
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
  in §3.2 — absence is the mark, nothing is invented. The names live in a
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

Names and aliases (B7):

| Library | Entries with `name.sv` | Headings without | Aliases |
|---|---|---|---|
| `ISOM2017-2` | 152 / 152 | — | 97 `ISOM2000` codes on 96 headings |
| `ISSprOM2019-2` | 138 / 141 | `105.2`, `533`, `715` | none (no ISSOM 2007 table) |

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
| alias library outside `ALIAS_LIBRARIES` (`ISOM2000`, `ISSOM2007`) | `alias library "x" is not one of ISOM2000, ISSOM2007` |
| the same alias twice on one entry | `duplicate alias ISOM2000 303` |
| an alias on a variant entry | `aliases are for heading entries only` |
| a variant's `sv` not `<heading sv>, <qualifier>` / heading without `sv` | `variant name should start with "<heading sv>, "` / `variant has a Swedish name but its heading has none` |
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
    that differs from the earlier revisions and from OOM, and the B10
    drawing corrections: slope-line ticks to +y, 107's taper, ISOM 111
    north, 509 / 509.1 white-over-black with black ends, 510 / 511 /
    511.b pylons at corners with 510's ±0.37 mm bar.
  - (d) purple roles per 03 §2.4 for every 7xx entry; lower entries never
    use `purple-upper` and vice versa; ISOM-only (711–713) and
    ISSprOM-only (710.1/.2, 714) codes are not cross-listed.
  - (e) `materialiseLibrary` for both libraries: every colour index is
    inside the stack, every entry symbolised against a representative
    object (line with corner + dash point, 20 × 20 mm area at 30°, point at
    45°, text "31") emits at least one pass and no warnings; the 2022
    edition yields identical symbols with only CMYK changed; resolved
    symbols carry id/code/name; 107 in both editions symbolises to a
    pointed stroke pass carrying its 0.75 mm taper (the contact sheet
    cannot show it: the reference raster draws `pointed` as butt).
- **`import/__tests__/fingerprint.test.ts`** — OCAD's railway (white
  dashes over a black band) and OCAD's power line (corner symbol) score
  `auto` against 509 / 510; `render/__tests__/library-fixtures.test.ts`
  rows 3 and 6 (`map-rendering.md` §6.1) hold the pylon and railway
  passes; its "colour-order equivalence" block pins §8.1's inversion
  rule (Mapper's black dashes over white score `auto` against 509; a
  coloured band, other-class rails and a solid stroke still hard-fail);
  `api/src/__tests__/import-omap.test.ts` states that Mapper's railway
  is `auto` against `ISOM2017-2:509` (A15).

- **names.test.ts** — every heading has `name.sv` except the §3.2 list;
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
  — whichever branch merges second regenerates it.

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
| Railway "black, white" drawn as stated: black dashes, white between, rails | 509 / 509.1 are white 0.25 dashes 1.0 / 1.5 over a black 0.45 band, the white shortened 1.5 mm at each end (§3; B10) | Appendix B sorts white-for-railway above black, so the first edition's black dashes under a white band drew all white inside. The OCAD construction is the only one the palette allows; the black ends follow the spec ("two black dashes"), not OCAD's sets (white end dash). Consequence: OCAD railways built to the spec's widths now match (Sprint's 509.100, white 0.26 in black 0.45: `auto`); club-2026's / club-full's 509.1 (white 0.21 in black 0.35 — the set reads "0.35" as the outer width) stays unmatched, now on width instead of colour; Crop-A / Crop-B's grey 509.0 stays unmatched; Mapper's railway (black dashes over white, Mapper's own colour order) hard-failed on main colour for the 2026.10.3 release alone (`e2e/test.xmap`: `auto` 5 → 4 symbols); the fingerprint now reads both constructions as one (§8.1, A15) and it is `auto` again. |
| Glyph placement per 03 Appendix C (Mapper dash symbol → `dashPoints`) | 510 / 511 / 511.b pylons at `corners` (B10) | Both importers deliver pylons as corner flags (`map-import.md` §3.3, §4.2); no importer produces dash-point positions for them, so canonically drawn power lines had no poles and the fingerprint missed on placement. |
| Directional point glyphs: no convention stated (03 §6.2) | Angle 0 = north, slope ticks to +y (§3; B10) | OCAD and Mapper both draw the 101.b / 103.b tick to +y; the first edition used the line-tag convention (−y) and every auto-matched slope line pointed uphill (52–66 % shape difference, `map-rendering.md` §6.4). |
| 510 "0.3 (OM)" bars | ±0.37 mm, 0.3 beyond each edge of the 0.14 line (B10) | The reading ISOM 511 already used; Mapper's ISOM set and both corpus OCAD sets draw ±0.37 (−0.38 … +0.33). Was ±0.3. ISSprOM 511 (unchanged) measures its 0.3 from the line centre (±1.12 at ±0.82), as OCAD's ISSprOM set does — Sprint's 511 matches it at 1.00; the spec drawing does not settle which. |
| 508.b yellow band as drawn (visible in forest) | Appendix B order: hidden under 406–410 green (§3; user decision 2026-10-22) | No yellow row above green exists in Appendix B; OCAD's set and the legacy tiles agree. |
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
| 5 | `description` | same type, not ruled out by a hard fail, ≥ 2 shared name tokens, or 1 token when the code matches or the geometry is partly compatible. Source tokens go through the Swedish → English lexicon `SV_EN`; an entry's tokens are the union of its `name.en` and `name.sv` tokens (the latter through the same lexicon), so a Swedish source word the lexicon lacks still meets the SOFT heading | `suggested` at 0.3 + 0.1 × tokens, capped 0.5 |
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

**Scope.** The instance belongs to one club (`docs/club-library.md`), so
the table has no event or series column: a decision made while reviewing
an event map applies to the club map of the same symbols and vice versa.
Rows of another source kind never apply (`omap:` rows to an OCAD file).

**Does a stored document follow the decisions?**
`documentFollowsDecisions(header, decisions)` — for every source symbol
with a fingerprint, the decision that would apply (an entry the library
has, or `null`) equals what the header records (`method: "explicit"` with
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
so they are recomputed here. `club-symbol` means no library entry shares
the code's base number (a metro line `900`, a club's own `8xx`);
`unused` is zero objects; `text` the source kind. A pre-matcher header
(no `library`) has rows with `match: null` and no candidates.

Tests: `packages/shared/src/import/__tests__/decisions.test.ts`
(fingerprint equality between source and stored stack, name
independence, newest-wins and tie rules, library and kind filtering,
`documentFollowsDecisions` matrix incl. a dangling entry, review rows on
the stage 6–7 fixture with flags and candidates, attrs-only object
counts); the API side in `docs/map-storage.md` §10.

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
| `CRT_TARGET_UNKNOWN` | the target is not an entry of the document's library |
| `CRT_FINGERPRINT_MISMATCH` | the `# fp` names no symbol here; applied by code (also counted as applied). A line skipped for another reason reports that code alone |
| `CRT_LIBRARY_MISMATCH` | the header names another library id; once per file |

A CRT is additive: there is no `reset` line (a decision is removed with
`decide`'s `reset`). Nothing applicable → no row written and no job.

Tests: `packages/shared/src/import/__tests__/crt.test.ts` (Mapper's
grammar incl. its shipped `ISOM2000-ISOM 2017-2.crt` lines, every
warning code, `702` ≡ `702.0`, duplicate-code fan-out, fingerprint
precedence and mismatch, later-wins, unchanged, the header, `# keep`,
`includeMatches`, byte-stable output and the round trip
`resolveCrt(parseCrt(formatCrt(…)))`); the API side in
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
- The course editor's map info row (`MapPanel` with `showMapInfo`):
  **Review symbols** when `course.mapMetadata().documentHash` is set.
  Never on the kiosk or the dashboard map, which mount `MapPanel` without
  that row.

**Header.** Map name, library `id · release`, and where the document
stands: *in use* (it is the club version's / the event's pinned
document), *not used yet* with **Use this version** (`finalise`), and
*not up to date* when `review.current` is false (the current library,
importer or club decisions would import the source differently). Summary
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

**Decisions.** Per row: **Use this** on a candidate (`accept`), **Other
library symbol…** (`accept` of any entry of the document's library — the
API takes any entry; a row with no close candidate needs it), **Keep as
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
with `?event=`, nothing to finalise on the matcher's output).

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

- Mapper object queries as CRT sources (§8.6 `CRT_QUERY_UNSUPPORTED`)
  and a variant table to Mapper's sub-numbers, if a club needs either.
- Library variants for the OCAD template conventions (§8.4) if the auto
  rate needs to rise.
- `ISMTBOM2022` / `ISSkiOM2019` libraries (palette rows exist).
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
