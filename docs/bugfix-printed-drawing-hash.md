# Bugfix: two prints a second apart hashed differently with the same drawing

Found 2026-11-17 on `vector-map-pipeline` at `98ff3506`. The test
`map-mode.spec.ts` › "Map mode drawing" › "Change symbol on a document line: a
resymbol, its own kind only, printed; Revert" (G9) failed in full local E2E
runs: once on `vector-map-pipeline`, twice in G26's runs and once in G27's. It
passed alone and on CI. The cause was in the test's PDF hash. The app was
correct: the patch, the revert and the print path all behaved as specified.

## What happened

The test hashes `maps.pdf?allControls=1` before the resymbol, after it, and
after *Revert*. The last hash must equal the first. Every failure was at that
step, with `Expected: "823bbf5c…"` and `Received: "8efa7348…"`.

Reproduced under CPU load (20 busy loops beside the test,
`--repeat-each=15`): 7 of 15 failed. Each print's bytes and the event's patch
(`mapPatch.get`) were logged at print time. The patch was right every time:
before the resymbol there was no row (version `0`), after *Revert* the ops were
`{}`, so `livePrintPatch` is `null` both times and the print draws the pinned
document unchanged. Yet two prints of that same state hashed to either
`823bbf5c` or `8efa7348`. This happened even for the two back-to-back "before"
prints whose equality the test also asserts.

## Why

The two PDFs, inflated, differ in two places only:

1. the `/CreationDate` and `/ModDate` strings in the compressed object stream
   (`/Type /ObjStm`) that holds the `Info` dictionary;
2. the cross-reference stream (`/Type /XRef`), a binary table of byte offsets.

`printedDrawing` hashed every inflated stream with the dates cut out of the
text. That covers the first difference but not the second. The object stream
deflates to one byte more or less, depending on the date's digits (549 against
548 bytes here), so every offset after it moves, and the xref stream inflates to
different bytes. Two prints made within the same second are identical. Two made
across a second boundary differ when the deflated length changes. Alone, the
test's prints are less than a second apart, so it nearly always passed. Under
load, the resymbol, its print and the revert take several seconds, so the
"after" print usually lands in a later second.

The writer's `deterministic` option (fixed dates) is for the composer's tests.
The route prints with the real date, as it should (course-print.md §3.2).

## Fix

`printedDrawing` hashes `pdfObjects` (`e2e/helpers/print-pdf.ts`, now
exported). That function is already the comparison of G16's device print
(`expectSamePdf`): every indirect object, parsed by pdf-lib, apart from the
`Info` dictionary and the xref and object-stream containers. The objects inside
an object stream are still compared one by one. So the hash covers the drawing
and every other object, but not the dates or the offsets.

On the 54 PDFs saved in the repro run, the old hash gave four values. The new
one gives two: one for every print without the resymbol and one for every print
with it.

## Verification

- The test under the same CPU load, `--repeat-each=20`: 20 of 20 passed
  (before the fix: 7 of 15 failed).
- One full `pnpm test:e2e` run: 4 shards, 459 passed, 2 skipped, none flaky;
  the preview stack, 1 passed.
