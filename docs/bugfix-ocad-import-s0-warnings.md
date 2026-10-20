# Bug fix: OCAD import warnings the S0 corpus check could not trust

Found by the S0 corpus check (`scripts/measure-import.mjs`, `docs/map-import.md` §7)
on 2026-10-20. Fixed in `format.importer` `ocad-6`.

## What happened

Two OCAD warnings did not say what the spec says they say:

1. **Reader-dropped symbol types hid as `READER_WARNING`.** `ocad2geojson`
   does not parse rectangle (type 7) or line-text (type 6) symbols. It
   leaves them out of the symbol table and adds `Ignoring rectangle
   symbol 850001.` to its own warning list; an unknown type becomes an
   `Error("Unknown symbol type N")` in the same list. The normaliser
   only counted that list as `READER_WARNING` ("see the reader's warning
   list"), and the texts are not stored. `docs/map-import.md` §3.3
   promised `SYMBOL_TYPE_UNSUPPORTED` for these types, but that branch of
   `ocadSymbolToRender` was unreachable with the real reader. Three of
   the five corpus maps carry a rectangle symbol; on Club-full two
   objects use one and ended up as `MISSING_SYMBOL` stubs with no hint
   why. A check for unsupported primitives saw nothing.

2. **Double-line mode 65535 warned although the spec calls it off.**
   §3.3: "0 and 65535 off; anything else warns". `ocad-symbols.ts`
   drew nothing for 65535 (correct) but also warned
   `SYMBOL_FEATURE_DROPPED … double line mode 65535`, and the unit test
   asserted the warning. One corpus symbol (Club-full 511.9) has it.

## Fix

- `ocad-source.ts`: reader warnings that match `Ignoring (rectangle|line
  text) symbol N.` or `Unknown symbol type N` become
  `SYMBOL_TYPE_UNSUPPORTED` (`850.1: rectangle symbol dropped by the
  reader`, `symbol type 9 dropped by the reader`); only the rest count
  as `READER_WARNING`. Objects using the dropped symbol still get the
  `MISSING_SYMBOL` stub.
- `ocad-symbols.ts`: mode 65535 is off without a warning; any other mode
  outside 0–3 still warns.
- `OCAD_IMPORTER_VERSION` → `ocad-6` (the header's warnings changed, so
  the bytes and hashes of every OCAD document change). Stored `ocad-5`
  documents are stale by importer for dedup and `pnpm map:rematch`.

Neither change removes a construct from the count of what the document
cannot draw: the rectangle symbols are now *counted* as unsupported, and
mode 65535 was never a dropped feature.

## Tests

`ocad-source.test.ts` (reader warnings split into `SYMBOL_TYPE_UNSUPPORTED`
×3 and `READER_WARNING` ×1), `ocad-symbols.test.ts` (65535 silent, mode 4
warns), version strings in `import-omap.test.ts`,
`map-rematch-cli.test.ts` (`ocad-5` is now stale by importer) and the two
integration suites.
