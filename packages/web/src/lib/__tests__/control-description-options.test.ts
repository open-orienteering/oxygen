import { describe, expect, it } from "vitest";
import {
  C_OPTIONS,
  D_GROUPS,
  E_OPTIONS,
  F_OPTIONS,
  G_DIRECTIONAL,
  G_OPTIONS,
  G_PLAIN,
  H_OPTIONS,
  OPTIONS_BY_FIELD,
  ocadToIof,
} from "../control-description-options";
import { IOF_SYMBOLS, descriptionCells } from "../../iof-symbols";
import { IOF_SYMBOL_META, iofSymbolName } from "../../iof-symbol-meta";

/** Sheet column that a description field renders into. */
const RENDER_COLUMN = {
  c: "C",
  d: "D",
  e: "E",
  f: "F",
  g: "G",
  h: "H",
} as const;

describe("control description options", () => {
  it("covers the full IOF symbol sets per column", () => {
    expect(C_OPTIONS).toHaveLength(11);
    expect(D_GROUPS.flatMap((g) => g.options)).toHaveLength(73);
    expect(E_OPTIONS.length).toBeGreaterThanOrEqual(11);
    expect(F_OPTIONS).toHaveLength(3);
    expect(G_OPTIONS).toHaveLength(8 * 8 + 6);
    expect(H_OPTIONS.length).toBeGreaterThanOrEqual(3);
  });

  it("groups column D by IOF family 1..6", () => {
    expect(D_GROUPS.map((g) => g.group)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(D_GROUPS.map((g) => g.options.length)).toEqual([16, 10, 11, 10, 24, 2]);
  });

  it("lists 8 directions for each directional G base", () => {
    expect(G_DIRECTIONAL.map((g) => g.iofBase)).toEqual([
      "11.1", "11.2", "11.3", "11.4", "11.5", "11.6", "11.8", "11.14",
    ]);
    for (const g of G_DIRECTIONAL) {
      expect(g.byDirection.map((o) => o.iof)).toEqual(
        ["N", "NE", "E", "SE", "S", "SW", "W", "NW"].map((d) => `${g.iofBase}${d}`),
      );
    }
    expect(G_PLAIN.map((o) => o.iof)).toEqual([
      "11.9", "11.10", "11.11", "11.12", "11.13", "11.15",
    ]);
  });

  it("has no duplicate IOF or OCAD codes within a column", () => {
    for (const options of Object.values(OPTIONS_BY_FIELD)) {
      expect(new Set(options.map((o) => o.iof)).size).toBe(options.length);
      expect(new Set(options.map((o) => o.ocad)).size).toBe(options.length);
    }
  });

  it("round-trips every option's OCAD code to its IOF symbol via descriptionCells", () => {
    for (const [field, options] of Object.entries(OPTIONS_BY_FIELD)) {
      const column = RENDER_COLUMN[field as keyof typeof RENDER_COLUMN];
      for (const opt of options) {
        expect(IOF_SYMBOLS[opt.iof], `${field} ${opt.iof} has an SVG`).toBeTruthy();
        const cells = descriptionCells({ [field]: opt.ocad }, "black");
        const cell = cells[column];
        expect(cell, `${field} ${opt.ocad} → ${opt.iof}`).toEqual({
          kind: "svg",
          key: opt.iof,
          svg: IOF_SYMBOLS[opt.iof],
        });
      }
    }
  });

  it("puts dimensions in column F (not E) and appearance in E", () => {
    const sized = descriptionCells({ d: "2.004", s: "1,5" }, "black");
    expect(sized.E).toBeNull();
    expect(sized.F).toEqual({ kind: "text", text: "1.5" });

    const appearance = descriptionCells({ d: "2.004", e: "8.001" }, "black");
    expect(appearance.E?.kind).toBe("svg");
    expect(appearance.E && appearance.E.kind === "svg" && appearance.E.key).toBe("8.1");

    // Combination wins over dimensions in F.
    const crossing = descriptionCells(
      { d: "5.002", e: "5.001", f: "10.001", s: "2" },
      "black",
    );
    expect(crossing.F?.kind).toBe("svg");
    expect(crossing.F && crossing.F.kind === "svg" && crossing.F.key).toBe("10.1");
  });

  it("resolves stored OCAD codes back to IOF keys, including imported encodings", () => {
    expect(ocadToIof("c", "0.201")).toBe("0.1N");
    expect(ocadToIof("d", "2.004")).toBe("2.4");
    expect(ocadToIof("e", "8.001")).toBe("8.1");
    expect(ocadToIof("f", "10.001")).toBe("10.1");
    expect(ocadToIof("g", "11.101")).toBe("11.1N");
    expect(ocadToIof("h", "12.001")).toBe("12.1");
    expect(ocadToIof("c", "0.3")).toBe("0.3");
    expect(ocadToIof("d", "2.4")).toBe("2.4");
    expect(ocadToIof("g", "11.143")).toBe("11.14E");
    expect(ocadToIof("d", "99.999")).toBeNull();
    expect(ocadToIof("g", "")).toBeNull();
  });

  it("has English and Swedish names for every pickable symbol", () => {
    for (const options of Object.values(OPTIONS_BY_FIELD)) {
      for (const opt of options) {
        const meta = IOF_SYMBOL_META[opt.iof];
        expect(meta, `meta for ${opt.iof}`).toBeTruthy();
        expect(meta.en.length).toBeGreaterThan(0);
        expect(meta.sv.length).toBeGreaterThan(0);
      }
    }
    expect(iofSymbolName("2.4", "en")).toBe("Boulder");
    expect(iofSymbolName("2.4", "sv")).toBe("Sten");
    expect(iofSymbolName("8.1", "en")).toBe("Low");
    expect(iofSymbolName("12.1", "sv")).toBe("Sjukvård");
    expect(iofSymbolName("2.4", "de")).toBe("Boulder");
    expect(iofSymbolName("nope", "en")).toBe("nope");
  });
});
