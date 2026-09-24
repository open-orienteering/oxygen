import { describe, expect, it } from "vitest";
import {
  applyIofColorStack,
  filterNorthLineObjects,
  inkToColor,
  isAboveLowerPurple,
  resolveColorProfile,
  type StackColor,
  type StackOcadFile,
  type StackSymbol,
} from "../map-color-stack.js";

function color(
  number: number,
  cmyk: [number, number, number, number],
  renderOrder: number,
  name = `c${number}`,
): StackColor {
  return { number, cmyk, renderOrder, name };
}

function file(
  colors: StackColor[],
  symbols: StackSymbol[],
): StackOcadFile {
  // Sparse array indexed by colour number, matching ocad2geojson.
  const sparse: Array<StackColor | undefined> = [];
  for (const c of colors) sparse[c.number] = c;
  return { colors: sparse, symbols };
}

describe("isAboveLowerPurple", () => {
  it("puts black 100% used by lines above (all profiles)", () => {
    const usage = { line: true, point: false, area: false, text: false };
    expect(isAboveLowerPurple(color(1, [0, 0, 0, 100], 0), usage, "isom")).toBe(true);
    expect(isAboveLowerPurple(color(1, [0, 0, 0, 100], 0), usage, "issprom")).toBe(true);
  });

  it("keeps area-only black (big buildings) below", () => {
    expect(
      isAboveLowerPurple(color(1, [0, 0, 0, 100], 0), {
        line: false,
        point: false,
        area: true,
        text: false,
      }),
    ).toBe(false);
  });

  it("puts brown 100% lines above only in ISOM", () => {
    const usage = { line: true, point: false, area: false, text: false };
    expect(isAboveLowerPurple(color(5, [0, 56, 100, 18], 0), usage, "isom")).toBe(true);
    expect(isAboveLowerPurple(color(5, [25, 75, 100, 0], 0), usage, "isom")).toBe(true);
    expect(isAboveLowerPurple(color(5, [25, 75, 100, 0], 0), usage, "issprom")).toBe(false);
    expect(isAboveLowerPurple(color(5, [25, 75, 100, 0], 0), usage, "ismtbom")).toBe(false);
  });

  it("puts blue 100% line above in ISOM/SkiO/MTBO but not ISSprOM", () => {
    const usage = { line: true, point: false, area: false, text: false };
    expect(isAboveLowerPurple(color(3, [100, 0, 0, 0], 0), usage, "isom")).toBe(true);
    expect(isAboveLowerPurple(color(3, [100, 0, 0, 0], 0), usage, "isskiom")).toBe(true);
    expect(isAboveLowerPurple(color(3, [100, 0, 0, 0], 0), usage, "ismtbom")).toBe(true);
    expect(isAboveLowerPurple(color(3, [100, 0, 0, 0], 0), usage, "issprom")).toBe(false);
  });

  it("puts white line/point above but area knockouts below", () => {
    expect(
      isAboveLowerPurple(color(9, [0, 0, 0, 0], 0), {
        line: true,
        point: false,
        area: false,
        text: false,
      }),
    ).toBe(true);
    expect(
      isAboveLowerPurple(color(9, [0, 0, 0, 0], 0), {
        line: false,
        point: false,
        area: true,
        text: false,
      }),
    ).toBe(false);
  });

  it("puts green 100% only when used exclusively by points (ISOM)", () => {
    expect(
      isAboveLowerPurple(color(7, [76, 0, 91, 0], 0), {
        line: false,
        point: true,
        area: false,
        text: false,
      }, "isom"),
    ).toBe(true);
    expect(
      isAboveLowerPurple(color(7, [76, 0, 91, 0], 0), {
        line: false,
        point: false,
        area: true,
        text: false,
      }, "isom"),
    ).toBe(false);
  });

  it("puts Ski-O green line above in isskiom", () => {
    const usage = { line: true, point: false, area: false, text: false };
    expect(isAboveLowerPurple(color(8, [91, 0, 83, 0], 0), usage, "isskiom")).toBe(true);
    expect(isAboveLowerPurple(color(8, [91, 0, 83, 0], 0), usage, "isom")).toBe(false);
  });

  it("puts purple 50% area above in ISSprOM and ISMTBOM", () => {
    const usage = { line: false, point: false, area: true, text: false };
    expect(isAboveLowerPurple(color(20, [18, 43, 0, 0], 0), usage, "issprom")).toBe(true);
    expect(isAboveLowerPurple(color(20, [18, 43, 0, 0], 0), usage, "ismtbom")).toBe(true);
    expect(isAboveLowerPurple(color(20, [18, 43, 0, 0], 0), usage, "isom")).toBe(false);
  });

  it("keeps course purple below regardless of usage", () => {
    expect(
      isAboveLowerPurple(color(0, [35, 85, 0, 0], 0), {
        line: true,
        point: true,
        area: false,
        text: false,
      }),
    ).toBe(false);
  });

  it("keeps yellow and vegetation below", () => {
    const none = { line: false, point: false, area: true, text: false };
    expect(isAboveLowerPurple(color(2, [0, 27, 79, 0], 0), none)).toBe(false);
    expect(isAboveLowerPurple(color(8, [46, 0, 55, 0], 0), none)).toBe(false);
  });
});

describe("resolveColorProfile", () => {
  it("returns explicit profiles unchanged", () => {
    expect(resolveColorProfile("isom", 4000)).toEqual({
      resolvedProfile: "isom",
      resolvedBy: "explicit",
    });
  });

  it("picks ISSprOM for sprint scales and ISOM otherwise", () => {
    expect(resolveColorProfile("auto", 4000)).toEqual({
      resolvedProfile: "issprom",
      resolvedBy: "scale",
    });
    expect(resolveColorProfile("auto", 5000)).toEqual({
      resolvedProfile: "issprom",
      resolvedBy: "scale",
    });
    expect(resolveColorProfile("auto", 15000)).toEqual({
      resolvedProfile: "isom",
      resolvedBy: "scale",
    });
    expect(resolveColorProfile("auto", null)).toEqual({
      resolvedProfile: "isom",
      resolvedBy: "default",
    });
  });
});

describe("applyIofColorStack", () => {
  it("rewrites renderOrder so ink colours sit at 0..boundary-1", () => {
    // Deliberately wrong file order: yellow first, then black, then blue.
    const colors = [
      color(2, [0, 27, 79, 0], 0, "Yellow"),
      color(1, [0, 0, 0, 100], 1, "Black"),
      color(3, [100, 0, 0, 0], 2, "Blue"),
      color(5, [0, 56, 100, 18], 3, "Brown"),
    ];
    const symbols: StackSymbol[] = [
      { type: 2, lineColor: 1 },
      { type: 2, lineColor: 3 },
      { type: 2, lineColor: 5 },
      { type: 3, fillColor: 2 },
    ];
    const result = applyIofColorStack(file(colors, symbols), { profile: "isom" });
    expect(result.above).toEqual([1, 3, 5]);
    expect(result.below).toEqual([2]);
    expect(result.boundary).toBe(3);
    expect(inkToColor(result)).toBe(2);
    expect(result.resolvedProfile).toBe("isom");
    expect(result.resolvedBy).toBe("explicit");
    // Relative order of above colours preserved from the file.
    expect(colors.find((c) => c.number === 1)!.renderOrder).toBe(0);
    expect(colors.find((c) => c.number === 3)!.renderOrder).toBe(1);
    expect(colors.find((c) => c.number === 5)!.renderOrder).toBe(2);
    expect(colors.find((c) => c.number === 2)!.renderOrder).toBe(3);
  });

  it("keeps brown and blue below in ISSprOM", () => {
    const colors = [
      color(1, [0, 0, 0, 100], 0, "Black"),
      color(3, [100, 0, 0, 0], 1, "Blue"),
      color(5, [25, 75, 100, 0], 2, "Brown"),
      color(2, [0, 27, 79, 0], 3, "Yellow"),
    ];
    const symbols: StackSymbol[] = [
      { type: 2, lineColor: 1 },
      { type: 2, lineColor: 3 },
      { type: 2, lineColor: 5 },
      { type: 3, fillColor: 2 },
    ];
    const result = applyIofColorStack(file(colors, symbols), { profile: "issprom" });
    expect(result.above).toEqual([1]);
    expect(result.below).toEqual([3, 5, 2]);
    expect(result.resolvedProfile).toBe("issprom");
  });

  it("auto-picks ISSprOM from sprint scale", () => {
    const colors = [
      color(1, [0, 0, 0, 100], 0, "Black"),
      color(5, [25, 75, 100, 0], 1, "Brown"),
    ];
    const symbols: StackSymbol[] = [
      { type: 2, lineColor: 1 },
      { type: 2, lineColor: 5 },
    ];
    const result = applyIofColorStack(file(colors, symbols), {
      profile: "auto",
      scale: 4000,
    });
    expect(result.resolvedBy).toBe("scale");
    expect(result.resolvedProfile).toBe("issprom");
    expect(result.above).toEqual([1]);
    expect(result.below).toEqual([5]);
  });

  it("auto uses the file's Lower purple colour as the boundary", () => {
    // File already has Lower purple between black/blue and yellow.
    const colors = [
      color(1, [0, 0, 0, 100], 0, "Black"),
      color(3, [100, 0, 0, 0], 1, "Blue"),
      color(0, [35, 85, 0, 0], 2, "Lower purple for course overprint"),
      color(2, [0, 27, 79, 0], 3, "Yellow"),
      color(5, [0, 56, 100, 18], 4, "Brown 50%"), // wrongly below in file — kept
    ];
    const symbols: StackSymbol[] = [
      { type: 2, lineColor: 1 },
      { type: 2, lineColor: 3 },
      { type: 3, fillColor: 2 },
      { type: 3, fillColor: 5 },
    ];
    const result = applyIofColorStack(file(colors, symbols), { profile: "auto" });
    expect(result.resolvedBy).toBe("file-colour");
    expect(result.above).toEqual([1, 3]);
    expect(result.below).toEqual([0, 2, 5]);
    expect(result.boundary).toBe(2);
  });

  it("recognises Swedish Undre lila as the lower-purple marker", () => {
    const colors = [
      color(1, [0, 0, 0, 100], 0, "Svart"),
      color(0, [35, 85, 0, 0], 1, "Undre lila för banpåtryck"),
      color(2, [0, 27, 79, 0], 2, "Gul"),
    ];
    const symbols: StackSymbol[] = [
      { type: 2, lineColor: 1 },
      { type: 3, fillColor: 2 },
    ];
    const result = applyIofColorStack(file(colors, symbols), { profile: "auto" });
    expect(result.resolvedBy).toBe("file-colour");
    expect(result.above).toEqual([1]);
    expect(result.below).toEqual([0, 2]);
  });

  it("applies force-above / force-below overrides", () => {
    const colors = [
      color(1, [0, 0, 0, 100], 0, "Black"),
      color(5, [0, 56, 100, 18], 1, "Brown"),
      color(2, [0, 27, 79, 0], 2, "Yellow"),
    ];
    const symbols: StackSymbol[] = [
      { type: 2, lineColor: 1 },
      { type: 2, lineColor: 5 },
      { type: 3, fillColor: 2 },
    ];
    const result = applyIofColorStack(file(colors, symbols), {
      profile: "isom",
      overrides: { below: [5], above: [2] },
    });
    expect(result.above).toEqual([1, 2]);
    expect(result.below).toEqual([5]);
  });

  it("keeps area-only black below while line black goes above", () => {
    const colors = [
      color(10, [0, 0, 0, 100], 0, "Black line"),
      color(11, [0, 0, 0, 60], 1, "Black 60% buildings"),
      color(12, [0, 0, 0, 100], 2, "Black area buildings"),
    ];
    const symbols: StackSymbol[] = [
      { type: 2, lineColor: 10 },
      { type: 3, fillColor: 11 },
      { type: 3, fillColor: 12 },
    ];
    const result = applyIofColorStack(file(colors, symbols));
    expect(result.above).toEqual([10]);
    expect(result.below).toEqual([11, 12]);
  });

  it("handles the E2E fixture colour table", () => {
    // scripts/lib/ocad-fixture.mjs DEFAULT_COLORS:
    // Purple n0, Black n1 (path+boulder+building), Yellow n2, Blue n3 (north).
    const colors = [
      color(0, [35, 85, 0, 0], 0, "Purple"),
      color(1, [0, 0, 0, 100], 1, "Black"),
      color(2, [0, 27, 79, 0], 2, "Yellow"),
      color(3, [100, 0, 0, 0], 3, "Blue"),
    ];
    const symbols: StackSymbol[] = [
      { type: 2, lineColor: 1 }, // path
      { type: 1, elements: [{ color: 1 }] }, // boulder
      { type: 3, fillColor: 1 }, // building (also uses black)
      { type: 3, fillColor: 2 }, // yellow open land
      { type: 2, lineColor: 3 }, // magnetic north
      { type: 1, elements: [{ color: 0 }] }, // course control
    ];
    const result = applyIofColorStack(file(colors, symbols));
    expect(result.above).toEqual([1, 3]);
    expect(result.below).toEqual([0, 2]);
    expect(result.boundary).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it("returns boundary 0 and a warning when nothing is above", () => {
    const colors = [color(2, [0, 27, 79, 0], 0, "Yellow")];
    const symbols: StackSymbol[] = [{ type: 3, fillColor: 2 }];
    const result = applyIofColorStack(file(colors, symbols));
    expect(result.boundary).toBe(0);
    expect(result.above).toEqual([]);
    expect(result.below).toEqual([2]);
    expect(inkToColor(result)).toBeNull();
    expect(result.warnings[0]).toMatch(/no black\/brown\/blue/i);
  });

  it("reads double-line and framing colours as line usage", () => {
    const colors = [
      color(1, [0, 0, 0, 100], 0, "Black"),
      color(4, [0, 0, 0, 100], 1, "Frame black"),
    ];
    const symbols: StackSymbol[] = [
      {
        type: 2,
        lineColor: 1,
        frColor: 4,
        doubleLine: {
          dblLeftColor: 1,
          dblRightColor: 1,
          dblFillColor: 1,
        },
      },
    ];
    const result = applyIofColorStack(file(colors, symbols));
    expect(result.above).toEqual([1, 4]);
  });

  it("leaves a standards-compliant order unchanged in relative above/below", () => {
    const colors = [
      color(1, [0, 0, 0, 100], 0, "Black"),
      color(3, [100, 0, 0, 0], 1, "Blue"),
      color(5, [0, 56, 100, 18], 2, "Brown"),
      color(6, [76, 0, 91, 0], 3, "Green"),
      color(2, [0, 27, 79, 0], 4, "Yellow"),
    ];
    const symbols: StackSymbol[] = [
      { type: 2, lineColor: 1 },
      { type: 2, lineColor: 3 },
      { type: 2, lineColor: 5 },
      { type: 3, fillColor: 6 },
      { type: 3, fillColor: 2 },
    ];
    const result = applyIofColorStack(file(colors, symbols));
    expect(result.above).toEqual([1, 3, 5]);
    expect(result.below).toEqual([6, 2]);
    expect(result.boundary).toBe(3);
  });
});

describe("filterNorthLineObjects", () => {
  it("drops ISOM 601.x symbols and keeps everything else", () => {
    const objects = [
      { sym: 601001 },
      { sym: 601002 },
      { sym: 109001 },
      { sym: 301000 },
      { sym: undefined },
    ];
    expect(filterNorthLineObjects(objects)?.map((o) => o.sym)).toEqual([
      109001,
      301000,
      undefined,
    ]);
  });

  it("returns undefined for undefined input", () => {
    expect(filterNorthLineObjects(undefined)).toBeUndefined();
  });
});
