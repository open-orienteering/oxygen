import { describe, expect, it } from "vitest";
import { CourseStackError, courseColourStack, hexToCmyk, withObjectColours } from "../colour-stack.js";
import { paletteStack } from "../../symbol-library/palette.js";
import type { DocumentColour } from "../../map-document/header.js";
import { cmykToHex } from "../../render/symbol.js";

/** A library palette as an aligned document stack (every row stands for its palette id). */
const aligned = (spec: "ISOM2017-2" | "ISSprOM2019-2"): DocumentColour[] =>
  paletteStack("iof2024", spec).map((c) => ({ ...c, paletteIds: [c.id.slice(c.id.indexOf(":") + 1)] }));

describe("courseColourStack (course-layer.md §1)", () => {
  it("inserts upper white directly below upper purple when the stack lacks it (every ISOM document)", () => {
    const doc = aligned("ISOM2017-2");
    const upper = doc.findIndex((c) => c.paletteIds?.includes("purple-upper"));
    const out = courseColourStack(doc);
    expect(out.colours).toHaveLength(doc.length + 1);
    expect(out.index.get("white-upper")).toBe(upper);
    expect(out.index.get("purple-upper")).toBe(upper + 1);
    expect(out.colours[upper]).toMatchObject({ id: "iof2024:white-upper", cmyk: [0, 0, 0, 0], paletteIds: ["white-upper"] });
    // Remap shifts only indices at or above the insertion point.
    expect(out.remap).not.toBeNull();
    out.remap!.forEach((n, i) => expect(n).toBe(i < upper ? i : i + 1));
    // Lower purple keeps its place under black.
    expect(out.index.get("purple-lower")!).toBeLessThan(out.index.get("black100")!);
  });

  it("leaves a stack that already has upper white unchanged (ISSprOM palette)", () => {
    const doc = aligned("ISSprOM2019-2");
    const out = courseColourStack(doc);
    expect(out.remap).toBeNull();
    expect(out.colours).toEqual(doc);
    expect(out.index.get("white-upper")).toBe(out.index.get("purple-upper")! - 1);
  });

  it("inserts below upper purple even when a source colour sits above it", () => {
    const doc: DocumentColour[] = [
      { id: "src:0", name: "Yellow", cmyk: [0, 0.27, 0.79, 0], paletteIds: ["yellow100"] },
      { id: "src:1", name: "Lower purple", cmyk: [0.35, 0.85, 0, 0], paletteIds: ["purple-lower"], purpleRole: "lower" },
      { id: "src:2", name: "Black", cmyk: [0, 0, 0, 1], paletteIds: ["black100"] },
      { id: "src:3", name: "Upper purple", cmyk: [0.35, 0.85, 0, 0], paletteIds: ["purple-upper"], purpleRole: "upper" },
      { id: "src:4", name: "Frame", cmyk: [0, 0, 0, 1] },
    ];
    const out = courseColourStack(doc);
    expect(out.colours.map((c) => c.id)).toEqual(["src:0", "src:1", "src:2", "iof2024:white-upper", "src:3", "src:4"]);
    expect(out.remap).toEqual([0, 1, 2, 4, 5]);
  });

  it("refuses a stack without both purples (not aligned)", () => {
    const doc = aligned("ISOM2017-2").filter((c) => !c.paletteIds?.includes("purple-upper"));
    expect(() => courseColourStack(doc)).toThrow(CourseStackError);
  });
});

describe("layout-object colours", () => {
  it("hexToCmyk inverts the naive screen conversion", () => {
    for (const hex of ["#000000", "#ffffff", "#a626ff", "#1f6fb2", "#ff0000"]) expect(cmykToHex(hexToCmyk(hex))).toBe(hex);
    expect(hexToCmyk("#000000")).toEqual([0, 0, 0, 1]);
  });

  it("appends one row per distinct colour on top of the stack, in first-use order", () => {
    const base = courseColourStack(aligned("ISOM2017-2"));
    const n = base.colours.length;
    const out = withObjectColours(base.colours, ["#ff0000", "#000000", "#FF0000"]);
    expect(out.colours).toHaveLength(n + 2);
    expect(out.indexOf("#ff0000")).toBe(n);
    expect(out.indexOf("#000000")).toBe(n + 1);
    expect(out.colours[n]).toMatchObject({ id: "course-object:#ff0000", cmyk: [0, 1, 1, 0] });
  });
});
