import { describe, expect, it } from "vitest";
import { cmykToHex } from "../../render/symbol.js";
import { iof2022Palette, iof2024Palette, paletteFor, paletteIndex, paletteStack } from "../palette.js";

describe("IOF colour palette (03 Appendix B)", () => {
  it("2024 edition has the 43 rows of Printing and Colour Definitions Rev 4, top first", () => {
    expect(iof2024Palette).toHaveLength(43);
    expect(iof2024Palette[0].id).toBe("purple-upper");
    expect(iof2024Palette[13].id).toBe("purple-lower");
    expect(iof2024Palette[42].id).toBe("yellow50");
    expect(new Set(iof2024Palette.map((e) => e.id)).size).toBe(43);
  });

  it("2022 edition: same ids minus Ski-O orange, pre-2024 brown/green values, black 30 % screen", () => {
    expect(iof2022Palette).toHaveLength(42);
    expect(iof2022Palette.find((e) => e.id === "orange-skio")).toBeUndefined();
    const by = (id: string) => iof2022Palette.find((e) => e.id === id)!;
    expect(by("brown100-line").cmyk).toEqual([0, 0.56, 1, 0.18]);
    expect(by("brown50-road").cmyk).toEqual([0, 0.28, 0.5, 0.09]);
    expect(by("green100-area").cmyk).toEqual([0.76, 0, 0.91, 0]);
    expect(by("black-area-screen").cmyk).toEqual([0, 0, 0, 0.3]);
    expect(by("olive").name).toBe("Yellow 100 % + Green 50 %");
    // Unchanged rows keep the 2024 values.
    expect(by("purple-upper").cmyk).toEqual([0.35, 0.85, 0, 0]);
    expect(by("yellow100").cmyk).toEqual([0, 0.27, 0.79, 0]);
  });

  it("per-spec applicability matches the table's tick marks", () => {
    expect(paletteFor("iof2024", "ISOM2017-2")).toHaveLength(29);
    expect(paletteFor("iof2024", "ISSprOM2019-2")).toHaveLength(33);
    const isom = paletteFor("iof2024", "ISOM2017-2").map((e) => e.id);
    expect(isom).toContain("brown100-line");
    expect(isom).not.toContain("brown100");
    expect(isom).not.toContain("purple50");
    const spr = paletteFor("iof2024", "ISSprOM2019-2").map((e) => e.id);
    expect(spr).toContain("brown100");
    expect(spr).toContain("white-upper");
    expect(spr).not.toContain("brown100-line");
  });

  it("stack order encodes the upper/lower purple split of 03 §2.4", () => {
    const isom = paletteIndex("iof2024", "ISOM2017-2");
    const spr = paletteIndex("iof2024", "ISSprOM2019-2");
    // Upper purple is drawn last in both.
    expect(isom.get("purple-upper")).toBe(paletteStack("iof2024", "ISOM2017-2").length - 1);
    expect(spr.get("purple-upper")).toBe(paletteStack("iof2024", "ISSprOM2019-2").length - 1);
    // Black 100 % knocks lower purple out in both.
    expect(isom.get("black100")!).toBeGreaterThan(isom.get("purple-lower")!);
    expect(spr.get("black100")!).toBeGreaterThan(spr.get("purple-lower")!);
    // Brown lines sit above lower purple in ISOM but below it in ISSprOM.
    expect(isom.get("brown100-line")!).toBeGreaterThan(isom.get("purple-lower")!);
    expect(spr.get("brown100")!).toBeLessThan(spr.get("purple-lower")!);
    // Road outline black is below lower purple everywhere.
    expect(isom.get("black-road-outline")!).toBeLessThan(isom.get("purple-lower")!);
  });

  it("stack entries carry prefixed ids, CMYK and purple roles", () => {
    const stack = paletteStack("iof2024", "ISOM2017-2");
    expect(stack[0]).toMatchObject({ id: "iof2024:yellow50", cmyk: [0, 0.14, 0.4, 0] });
    const lower = stack.find((c) => c.id === "iof2024:purple-lower")!;
    expect(lower.purpleRole).toBe("lower");
    expect(stack.at(-1)).toMatchObject({ id: "iof2024:purple-upper", purpleRole: "upper" });
    expect(cmykToHex(lower.cmyk)).toBe("#a626ff");
  });
});
