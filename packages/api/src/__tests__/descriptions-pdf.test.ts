/**
 * `buildDescriptionsPdf` (docs/course-print.md §6.4) in process: one page
 * per turn of the event loop, so a long export never holds a card readout
 * for more than about a page (measured 2026-11-07: 200 pages in 3.5 s,
 * the loop's longest wait 32 ms, the save included).
 */

import { monitorEventLoopDelay } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { descriptionSheetBlock } from "@oxygen/shared/print";
import { buildDescriptionsPdf } from "../course-maps/descriptions-pdf.js";

describe("buildDescriptionsPdf", () => {
  it("yields between pages: 40 pages never block the event loop for more than a few pages' time", async () => {
    const blocks = [descriptionSheetBlock("H21", { controls: 12, count: 240 })];
    const request = { copies: "count" as const, cellSizeMm: 6, gapMm: 5 };
    await buildDescriptionsPdf({ blocks, request: { ...request, copies: 1 } }); // fonts loaded, code warm
    const delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
    const out = await buildDescriptionsPdf({ blocks, request });
    delay.disable();
    expect(out.pageCount).toBe(40);
    // Without the yield this is the whole build (~800 ms for 40 pages); with it about one page or the save.
    expect(delay.max / 1e6).toBeLessThan(250);
  }, 60_000);

  it("refuses more than 200 pages before drawing one", async () => {
    const blocks = [descriptionSheetBlock("H21", { controls: 12, count: 2000 })];
    await expect(buildDescriptionsPdf({ blocks, request: { copies: "count", cellSizeMm: 6, gapMm: 5 } })).rejects.toThrow(/limited to 200 pages \(this one would have 334\)/);
  });
});
