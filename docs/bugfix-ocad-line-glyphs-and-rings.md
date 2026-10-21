# Bug fix: power-line poles on every line end, rings one line width small

Found on 2026-10-21: the poles by the user reviewing Club-2026 (Nackareservatet)
on `/dev/map-gl-doc`; the rest by the B9 corpus parity tool
(`scripts/measure-parity.mjs`, `docs/map-rendering.md` §6.4). Fixed in the
render stage and in `format.importer` `ocad-9`.

## What happened

1. **A pole on every end of a power line.** OCAD's 510 power line draws its
   pole as the line's *corner symbol*. The importer mapped it to the IR's
   `corners` placement, and the stage placed `corners` glyphs at every
   corner-flagged vertex *and* at both ends of every open path unless
   `ignoreEnds` was set. Club-2026's 510.0 is 22 short objects: 30 corner
   points (the real poles) and 44 ends, so 44 extra poles. OCAD draws the
   corner symbol at corner points only, and so does Mapper with its dash
   symbol: an end gets one only when it carries the flag.
2. **Start and end symbols swapped.** The importer read `useSymbolFlags`
   bit 1 as "start symbol" and bit 2 as "end symbol". It is the other way
   round: Club-full's 518.1 sets 5 with only an end symbol defined. No map
   in the corpus was visibly affected (every other symbol sets both bits).
3. **Rings one line width small.** From OCAD 9 on, a circle element's
   `diameter` is measured along the line's centre; the IR's ring diameter
   is the outer one. The importer copied the value, so every OCAD ring
   (control circles, finish, rings in patterns) was drawn `lineWidth`
   smaller than in OCAD, Mapper and the legacy tiles. OCAD 8 and older do
   measure the outer edge.

## How it was fixed

- `packages/shared/src/render/placement.ts`: `corners` / `dashPoints` put a
  glyph on an open path's end only when the end is flagged, and never with
  `ignoreEnds` (Mapper's `suppress_dash_symbol_at_ends`). Spec:
  `docs/map-rendering.md` §4.5 (user decision 2026-10-21).
- `packages/shared/src/import/ocad-symbols.ts`: bit 1 → `end`, bit 2 →
  `start`; circle elements → `diameterUm = diameter + lineWidth` for OCAD
  9+ (the file version reaches the conversion through `ocadVersion`).
  Spec: `docs/map-import.md` §3.3, §5.
- `OCAD_IMPORTER_VERSION` → `ocad-9`: stored OCAD documents are stale for
  the re-match pass (`map-rematch`) and are rebuilt from their source.
- `e2e/test.ocd`: its 706 finish was ISOM 2000-sized (5 / 7 mm) and matched
  ISOM 2017's 706 only through the ring error; it is now 4.0 / 6.0 mm
  centre to centre, so its automatic match (and every test pinned on it)
  holds.

## Tests

`placement.test.ts` (flagged and unflagged ends, `ignoreEnds`),
`ocad-symbols.test.ts` (bit order, circle diameter by version),
`library-fixtures.test.ts` row 3 (an OCAD-shaped 510 with a plain start and
a flagged end), `parity.test.ts` (a 510 power line agrees with the legacy:
poles at the corner points only) and `import-ocad.test.ts` (702 at 6.35 mm).
