# Course and print correctness: follow-ups

Left open by [course-print-correctness.md](course-print-correctness.md) (fix package 22).

- **Print warnings reach nobody.** `IMAGE_MISSING`, `SVG_RASTER`, `NO_FONT` and `PATCH_ISSUE` go to the log (`routes.ts`) and the device's console (`print/client.ts`); show them to the user (a header on the PDF response, or a toast).
- **`graphics.delete` checks use in one event only** (`routers/graphics.ts`); a club graphic placed in other events can be deleted and then fails their prints (CRS-010 turns that into an error). Check across events.
- **All-variations numbers and the editor's predicate count placed controls only** (`allVariationNumbers` in `resolve-sheet.ts`, `variation-view.ts` via `EditorPage.tsx`), so they still disagree with CRS-024's numbers for a course with an unplaced control. Left out because `EditorPage.tsx` is edited by the open course-elevation PR (#254).
- **Server `course.checks` does not report `NUMBER_UNPLACED`**, only the client checks do.
- **Stale members of a setter group**: a control removed from a course scope stays in the group's `controlIds`; only missing ones are reported.
- **`maps=` seqs of setter sheets are not blocked** when controls are unassigned; only `?setter=1` is.
- **Runners on a plain per-runner course in a forked class** count as unassigned on description sheets and are dealt over the variants.
- **`maps.pdf` `runnersOf` counts withdrawn runners** (`routes.ts`), unlike the description sheets.
- **The rest of WEB-70** (payment, trends) in the web client review.
- **Open one `.ppen` export in real Purple Pen** (EVT-07): the XML is now well-formed and validated in tests; a manual check against the application is still to do.
- **The remaining D5 items not in this package:** CRS-035, CRS-068, CRS-083, CRS-067, CRS-061.
