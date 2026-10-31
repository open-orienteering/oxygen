# Bugfix: course circles and legs drawn under area fills on `vector` events

## What happened

User report 2026-10-31: on events switched to `vector`, the course
overprint's circles and lines drew **under** open ground, marsh, water and
forest. Up to 90 % of a control circle vanished under yellow.

The spec was right and is unchanged: ISOM 2017-2 / IOF 2024 (03 §2.4,
Appendix B; `docs/map-symbols.md` §1) put *lower purple* below only the
100 % line and point colours (black 100 %, brown and blue 100 % line and
point, green 100 % point, dark-green hedges, railway white) and above
every area screen. Lower-purple course symbols (start, circles, legs,
finish) draw at `purple-lower`'s place in the document's colour stack.

The defect was in colour alignment
(`packages/shared/src/import/colour-align.ts`, `map-symbols.md` §9.2) for
maps without a lower purple of their own, which is most OCAD maps:

1. **Anchor.** The inserted `purple-lower` went "directly below the first
   source colour the palette puts above lower purple". OCAD-made maps keep
   the mapper's dark-green colour ("Green 100% + 50% Black") at the
   *bottom* of the area block, so that single colour dragged the purple
   under every area.
2. **Class.** That dark green was read as `darkgreen-hedge` — a line colour
   ranked above lower purple — even when its name says "Area Feature". In
   ISOM the palette's only dark-green row is the hedge row, so the name
   rule for `darkgreen-area` had no candidate to win: `paletteEntryFor`
   filtered candidates by spec first and the hedge was the default.

Evidence (`header.colours` of the dev documents, index 0 drawn first):

| Document | Colours | `purple-lower` | What sat above it |
|---|---|---|---|
| Ny_karta_test (corpus `club-2026.ocd`) | 68 | 17, under 18 "Green 100% + 50% Black Area Feature" [`darkgreen-hedge`] | 19 "Blue 100% - Area Feature", 21 "Brown 50% - Area Feature", 23–27 yellows, 30–39 greens / blues, 45 "Black 20% - Area Feature"; the 100 % line / point colours at 47–60, the map's own `purple-upper` at 63 |
| Ungdomsserien (corpus `crop-b.ocd`) | 123 | 26, under 27 "Grön 100% + 50% Svart - Linjeobjekt" [`darkgreen-hedge`] | 38 area colours (the table is in the file three times over) |
| `e2e/test.ocd` | 6 | 1 | Blue, Yellow |

## The fix

Decided by the user 2026-10-31 (decision log, SLICES C14):

- **Anchor on the group, not one colour** (`lowerPurpleAnchor` in
  `colour-align.ts`, §9.2 step 4). Every colour takes a side relative to
  lower purple: *above* (palette rank above `purple-lower`), *area*
  (`AREA_PALETTE_IDS`, or no palette id and a name that says area),
  *below* (other palette ids under lower purple: road infill / outline).
  Only colours that objects use count. The purple goes into the gap with
  the fewest misplaced colours, then the fewest areas above, then the
  fewest other below-colours above, then the lowest gap. A plain
  "directly above the highest area colour" was not enough: Ny_karta_test
  keeps a yellow ("Gul (över platta)") at the top of its table, above
  its own upper purple, which would have put lower purple on top of
  everything.
- **Report, never follow** (§9.2 step 5a): an *above* colour left below
  lower purple, or a *below* colour above it, is `COLOUR_ORDER_CONFLICT`;
  an area colour above it is the new `COLOUR_AREA_ABOVE_LOWER_PURPLE`
  (`colourStack.areasAboveLowerPurple`). A map's own lower purple keeps
  its place and gets the same checks (Vinterserien, `crop-a.ocd`, has its
  named lower purple above its upper one: the upper purple and the 100 %
  line / point colours under it are reported).
- **Class** (`nameKind` in `colour-class.ts`, §9.1): a name saying area
  (`area`, `yta`, `ytobjekt`, `fill`, `screen`, …) never maps to a line or
  point entry, and one saying line or point (`linjeobjekt`, `punktobjekt`,
  `line`, `point`, …) never to an area entry. Whole tokens: "Vägfyllning"
  is not "fill". With no entry left the colour has no palette id.
- Purples are still never aliased; an inserted purple still copies the
  map's other purple's CMYK (C9).

Importer `ocad-15` → `ocad-16`, `omap-8` → `omap-9`. Stored documents are
stale by importer version; the coordinator re-matches dev, and production
after the `v0.4.1` release (`backfill.sh --rematch`).

The map review page has no colour-stack panel, so the new warning shows in
the import report (`warnings`, `colourStack`) and through
`mapImport.review`'s `stack.alignment`, not as a separate UI element.

## After

`node scripts/measure-import.mjs e2e/test.ocd e2e/test.xmap .local/corpus`
(the new `purple` line):

| Map | `purple-lower` | Areas above | Conflicts |
|---|---|---|---|
| `test.ocd` | 3 of 6, inserted (above Yellow) | 0 | 2 (its Blue line colour sits under Yellow) |
| `test.xmap` | 3 of 8, inserted | 0 | 4 |
| `club-2026.ocd` (Ny_karta_test) | 46 of 68, inserted (above "Black 20% - Area Feature" and a road infill) | 1 ("Vit mask för text och kontrollb", a white text mask near the top) | 16 |
| `crop-b.ocd` (Ungdomsserien) | 101 of 123, inserted (above the last copy's "Blå 100% - Ytobjekt") | 1 ("Svart 20% - Ytobjekt" among the line colours) | 13 |
| `crop-a.ocd` (Vinterserien) | 139 of 154, the map's own | 0 | 18 |
| `sprint.ocd` | 29 of 42, the map's own | 1 ("Vit över brun, grön och gul") | 3 |
| `club-full.ocd` | 25 of 81, the map's own | 28 | 24 |

Club-full keeps an unnamed "Violett" at index 25 that §9.2 step 2 reads as
lower purple by position (it is below the top black), with the named
upper purples at 0, 2 and 23. Its 28 area colours above that purple are
now warned, not fixed: a map's own purple keeps its order.

The WebGL / PDF golden scenes (`course-*`, `page-*`) re-render
byte-identical: they draw on canonical palette stacks, not on imported
documents.

## Tests

- `packages/shared/src/import/__tests__/colour-class.test.ts`: `nameKind`;
  the area / line rule in `paletteEntryFor` (ISOM dark green "Area
  Feature" → none, "Linjeobjekt" → hedge; SPR → `darkgreen-area` /
  `-line`; "Black 100% - Area Feature" → `black-cultivated`;
  "Vägfyllning" still road).
- `packages/shared/src/import/__tests__/colour-align.test.ts` "lower
  purple": the two club tables (`club-colour-tables.ts` — names, CMYK and
  order only, nothing else from the maps); a stray area on top; unused
  colours; no area colours; a map's own misplaced purples.
- `packages/shared/src/import/__tests__/match-document.test.ts`: the
  warning and summary through `matchDocument`.
- `packages/api/src/__tests__/import-ocad.test.ts`,
  `packages/api/src/render/__tests__/window-raster.test.ts`: the fixture
  document's stack (lower purple above Yellow; the ink layer no longer
  carries the yellow).
- `scripts/__tests__/measure-import.test.mjs`: the `purple` line.
- `e2e/map-vector-layer.spec.ts` "the course layer draws lower purple over
  the map's yellow area": a leg across the fixture's yellow is purple.
  Fails on `ocad-15` (the leg samples as yellow).
