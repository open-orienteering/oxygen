/**
 * Stage 7's fallback (docs/map-symbols.md §9.3 "In the importer", row I5):
 * a map whose layered stack cannot be resolved is drawn in its own order
 * with `COLOUR_LAYERS_FAILED`, never a failed import; any other error of
 * the layers still throws.
 */

import { describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ fail: "none" as "none" | "layers" | "other" }));

vi.mock("../colour-layers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../colour-layers.js")>();
  return {
    ...actual,
    buildColourLayers: (input: Parameters<typeof actual.buildColourLayers>[0]) => {
      if (mode.fail === "layers") throw new actual.ColourLayersError("the order's constraints have a cycle");
      if (mode.fail === "other") throw new Error("symbol 3 references colour index 9 outside the 5-entry colour table");
      return actual.buildColourLayers(input);
    },
  };
});

const { matchDocument } = await import("../match-document.js");
const { input } = await import("./match-fixture.js");

describe("matchDocument — the layered stack cannot be built", () => {
  it("falls back to the source order with COLOUR_LAYERS_FAILED", () => {
    mode.fail = "layers";
    const r = matchDocument(input(), { colourOrder: "iof" });
    mode.fail = "none";
    expect(r.input.header.colourOrder).toEqual({ order: "source" });
    expect(r.colourStack.order).toBe("source");
    expect(r.colourStack.layers).toBeUndefined();
    expect(r.warnings.find((w) => w.code === "COLOUR_LAYERS_FAILED")).toMatchObject({ count: 1 });
    expect(r.input.header.colours).toEqual(matchDocument(input(), { colourOrder: "source" }).input.header.colours);
  });

  it("throws any other error", () => {
    mode.fail = "other";
    expect(() => matchDocument(input(), { colourOrder: "iof" })).toThrow(/outside the 5-entry colour table/);
    mode.fail = "none";
  });
});
