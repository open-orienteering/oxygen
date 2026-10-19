# Bug fix: OCAD ScalePar `d` stored as a declination

**Where:** vector map pipeline, OCAD normaliser (`packages/shared/src/import/ocad-source.ts`), importer `ocad-1` … `ocad-4`. Not released; legacy raster path unaffected.

## What happened

Research topic 02 §5 mapped OCAD ScalePar (string 1039) `d` to the
document's `georeferencing.declinationDeg`, and the normaliser followed
it. In OCAD, `d` is the real-world grid distance in metres (the paper
grid `g` in mm × the scale): the corpus has `d1000.00` on 1:15 000 maps
and `d120` on a 1:4 000 sprint, and the e2e fixture writes `d500`. So every OCAD
document claimed a "declination" of 1000°, 120° or 500°. Nothing read
the field yet, so no output was wrong, but the S0 corpus check and slice
C's north handling would have trusted it.

At the same time the normaliser ignored ScalePar `e` (OCAD 2018's EPSG
code), and an unresolvable grid id gave `crs: null` silently, where the
OMAP path warns `CRS_UNRESOLVED`. The e2e fixture declared grid id 1000,
which is no OCAD id; the legacy path only worked through its
coordinate-range inference, and the document had no CRS at all.

## Fix (A11, 2026-10-19)

- `d` is no longer carried; `declinationDeg` is OMAP-only
  (`docs/map-document-format.md` §2.3, `docs/map-import.md` §3.5).
- `e` is read as the EPSG code when the grid id does not resolve.
- An unresolvable real-world grid warns `CRS_UNRESOLVED`.
- `format.importer` → `ocad-5`, so stored `ocad-4` documents are no
  longer dedup targets and the next import replaces them.
- `e2e/test.ocd` is regenerated with grid id 13002 (SWEREF99 TM).

Tests: `packages/shared/src/import/__tests__/ocad-source.test.ts`
(georeferencing cases), `packages/api/src/__tests__/import-ocad.test.ts`
(fixture resolves EPSG:3006, no `declinationDeg`). Decision log:
`docs/research/vector-map-pipeline/README.md`, 2026-10-19 A11.
