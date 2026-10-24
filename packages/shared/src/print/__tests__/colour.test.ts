import { describe, expect, it } from "vitest";
import { cmykToHex } from "../../render/symbol.js";
import { colourOperator, pageColour, rgbToCmykNaive, stackColour } from "../colour.js";

const purple = { id: "iof:purple", name: "Purple", cmyk: [0.35, 0.85, 0, 0] as [number, number, number, number] };

describe("stackColour", () => {
  it("cmyk mode takes the stack's CMYK unchanged", () => {
    expect(stackColour(purple, "cmyk")).toEqual({ space: "cmyk", c: 0.35, m: 0.85, y: 0, k: 0 });
  });

  it("rgb mode takes the shared naive sRGB (the screen's hex)", () => {
    const hex = cmykToHex(purple.cmyk);
    const c = stackColour(purple, "rgb");
    expect(c.space).toBe("rgb");
    if (c.space !== "rgb") return;
    const back = "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    expect(back).toBe(hex);
  });
});

describe("rgbToCmykNaive", () => {
  it("special-cases black and white as single-plate", () => {
    expect(rgbToCmykNaive("#000000")).toEqual([0, 0, 0, 1]);
    expect(rgbToCmykNaive("#ffffff")).toEqual([0, 0, 0, 0]);
  });

  it("is the inverse of the naive conversion (round-trips through cmykToHex)", () => {
    for (const hex of ["#c800c8", "#ffba35", "#3cb54a", "#d15c00", "#00a3e0", "#808080", "#123456"]) {
      expect(cmykToHex(rgbToCmykNaive(hex))).toBe(hex);
    }
  });

  it("puts grey on the K plate alone", () => {
    const [c, m, y, k] = rgbToCmykNaive("#808080");
    expect([c, m, y]).toEqual([0, 0, 0]);
    expect(k).toBeCloseTo(1 - 128 / 255, 6);
  });

  it("accepts short hex", () => {
    expect(rgbToCmykNaive("#fff")).toEqual([0, 0, 0, 0]);
  });
});

describe("pageColour", () => {
  it("cmyk mode converts an RGB page colour, rgb mode keeps it", () => {
    expect(pageColour("#000000", "cmyk")).toEqual({ space: "cmyk", c: 0, m: 0, y: 0, k: 1 });
    expect(pageColour("#ff0000", "rgb")).toEqual({ space: "rgb", r: 1, g: 0, b: 0 });
  });
});

describe("colourOperator", () => {
  it("emits k/K in cmyk and rg/RG in rgb", () => {
    const c = stackColour(purple, "cmyk");
    expect(colourOperator(c, "fill")).toBe("0.35 0.85 0 0 k");
    expect(colourOperator(c, "stroke")).toBe("0.35 0.85 0 0 K");
    expect(colourOperator({ space: "rgb", r: 1, g: 0.5, b: 0 }, "fill")).toBe("1 0.5 0 rg");
    expect(colourOperator({ space: "rgb", r: 1, g: 0.5, b: 0 }, "stroke")).toBe("1 0.5 0 RG");
  });

  it("writes at most four decimals and clamps to 0..1", () => {
    expect(colourOperator({ space: "cmyk", c: 0.123456, m: 1.2, y: -0.1, k: 0 }, "fill")).toBe("0.1235 1 0 0 k");
  });
});
