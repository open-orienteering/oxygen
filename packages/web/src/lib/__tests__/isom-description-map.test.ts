import { describe, it, expect } from "vitest";
import {
  ISOM_DESCRIPTION_MAP,
  isomDescriptionFor,
  isomNumber,
} from "@oxygen/shared";
import { ocadToIof } from "../control-description-options";
import { IOF_SYMBOL_META } from "../../iof-symbol-meta";
import { getDescriptionSymbols } from "../../iof-symbols";

/**
 * The autodetect table lives in `shared` (the API does the spatial
 * search), but only the web package can check that its OCAD codes render:
 * the symbol library and the OCAD→IOF converters are here. A typo like
 * "2.04" instead of "2.004" would otherwise silently produce empty cells
 * in the description sheet.
 */
describe("ISOM → IOF description map", () => {
  const entries = Object.entries(ISOM_DESCRIPTION_MAP);

  it("covers the main ISOM groups", () => {
    expect(entries.length).toBeGreaterThan(50);
    for (const group of [100, 200, 300, 400, 500]) {
      const inGroup = entries.filter(
        ([isom]) => Number(isom) >= group && Number(isom) < group + 100,
      );
      expect(inGroup.length).toBeGreaterThan(0);
    }
  });

  it("maps every entry to a known IOF column-D symbol", () => {
    for (const [isom, entry] of entries) {
      const iof = ocadToIof("d", entry.d);
      expect(iof, `ISOM ${isom} → OCAD ${entry.d}`).not.toBeNull();
      const meta = IOF_SYMBOL_META[iof!];
      expect(meta, `ISOM ${isom} → IOF ${iof}`).toBeDefined();
      expect(meta.kind).toBe("D");
      expect(meta.en.length).toBeGreaterThan(0);
      expect(meta.sv.length).toBeGreaterThan(0);
    }
  });

  it("renders a column-D cell for every entry", () => {
    for (const [isom, entry] of entries) {
      const symbols = getDescriptionSymbols({ d: entry.d }, "#000");
      expect(symbols.colD, `ISOM ${isom} → OCAD ${entry.d}`).toBeTruthy();
    }
  });

  it("only offers side-of suggestions for features with a centre", () => {
    for (const [isom, entry] of entries) {
      if (!entry.g) continue;
      expect(
        entry.kind === "point" || entry.kind === "area" || entry.kind === "line",
        `ISOM ${isom}`,
      ).toBe(true);
    }
    // Long linear features (paths, fences, walls) must not get one: "N
    // side of the path" is meaningless without a reference point.
    for (const isom of [503, 505, 516, 513, 510]) {
      expect(ISOM_DESCRIPTION_MAP[isom].g).toBeUndefined();
    }
  });

  it("resolves the side-of codes the autodetect emits", () => {
    // `sideOfCode` in the API builds "11.101".."11.108" from a bearing.
    // Those codes only mean something if they render as column-G symbols.
    const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    for (let i = 0; i < directions.length; i++) {
      const iof = ocadToIof("g", `11.${100 + i + 1}`);
      expect(iof, `11.${100 + i + 1}`).toBe(`11.1${directions[i]}`);
      expect(IOF_SYMBOL_META[iof!].kind).toBe("G");
      expect(getDescriptionSymbols({ g: `11.${100 + i + 1}` }, "#000").colG).toBeTruthy();
    }
  });

  it("keys off the ISOM number inside an OCAD symbol number", () => {
    expect(isomNumber(204000)).toBe(204);
    expect(isomNumber(105001)).toBe(105);
    expect(isomDescriptionFor(204000)?.d).toBe("2.004");
    expect(isomDescriptionFor(505000)?.d).toBe("5.002");
    // Course overprint and contours carry no description.
    expect(isomDescriptionFor(703000)).toBeNull();
    expect(isomDescriptionFor(101000)).toBeNull();
  });
});
