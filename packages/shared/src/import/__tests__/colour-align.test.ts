/**
 * Colour-stack alignment (03 §6.3): source colours are identified as IOF
 * palette entries, duplicates alias, missing entries that canonical
 * symbols need are inserted at their palette position, purple is always
 * present in both roles, and order conflicts are reported — never fixed
 * silently.
 */

import { describe, expect, it } from "vitest";
import type { DocumentColour } from "../../map-document/header.js";
import { alignColourStack, identifySourceColours, paletteIndexOfStack } from "../colour-align.js";

const c = (sourceNumber: number, name: string, cmyk: [number, number, number, number]): DocumentColour => ({ id: `src:${sourceNumber}`, name, cmyk: cmyk.map((v) => v / 100) as [number, number, number, number], sourceNumber });

/** A sprint-style table, bottom (index 0) to top, the way OCAD template sets order it. */
const sprintStack: DocumentColour[] = [
  c(10, "Gul", [0, 27, 79, 0]),
  c(11, "Vit över gul", [0, 0, 0, 0]),
  c(12, "Grön 30%", [24, 0, 30, 0]),
  c(13, "Grön 60%", [48, 0, 60, 0]),
  c(14, "Grön", [80, 0, 100, 0]),
  c(15, "Mörkgrön för opasserbar vegetation", [100, 0, 80, 30]),
  c(16, "Brun 30% för vägfyllning", [6, 23, 33, 0]),
  c(17, "Brun 50% för belagd yta", [10, 35, 50, 0]),
  c(18, "Brun 50% för vägfyllning", [10, 35, 50, 0]),
  c(19, "Svart 50% för byggnader", [0, 0, 0, 50]),
  c(20, "Blå 50%", [50, 0, 0, 0]),
  c(21, "Blå", [100, 0, 0, 0]),
  c(22, "Brun", [25, 75, 100, 0]),
  c(23, "Undre violett för banpåtryck", [35, 85, 0, 0]),
  c(24, "Svart", [0, 0, 0, 100]),
  c(25, "Övre violett för banpåtryck", [35, 85, 0, 0]),
];

describe("identifySourceColours", () => {
  it("maps each colour to a palette id by name qualifier, class or position", () => {
    const infos = identifySourceColours(sprintStack, "ISSprOM2019-2", "iof2024");
    const by = (n: number) => infos.find((i) => sprintStack[i.index].sourceNumber === n)!;
    expect(by(16)).toMatchObject({ paletteId: "brown30-road", via: "name" });
    expect(by(17)).toMatchObject({ paletteId: "brown50-paved", via: "name" });
    expect(by(18)).toMatchObject({ paletteId: "brown50-road", via: "name" });
    expect(by(19)).toMatchObject({ paletteId: "black50-building", via: "name" });
    expect(by(15)).toMatchObject({ paletteId: "darkgreen-area", via: "name" });
    expect(by(23)).toMatchObject({ paletteId: "purple-lower", via: "name" });
    expect(by(25)).toMatchObject({ paletteId: "purple-upper", via: "name" });
    expect(by(24)).toMatchObject({ paletteId: "black100", via: "class" });
    expect(by(10)).toMatchObject({ paletteId: "yellow100" });
  });

  it("decides unnamed purples by position relative to the topmost black", () => {
    const stack = [c(1, "Gul", [0, 27, 79, 0]), c(2, "Violett", [35, 85, 0, 0]), c(3, "Svart", [0, 0, 0, 100]), c(4, "Violett", [35, 85, 0, 0])];
    const infos = identifySourceColours(stack, "ISOM2017-2", "iof2024");
    expect(infos[1]).toMatchObject({ paletteId: "purple-lower", via: "position" });
    expect(infos[3]).toMatchObject({ paletteId: "purple-upper", via: "position" });
  });

  it("leaves non-IOF colours without a palette id", () => {
    const infos = identifySourceColours([c(1, "T-bana", [90, 32, 0, 0])], "ISOM2017-2", "iof2024");
    expect(infos[0].class).toBeNull();
    expect(infos[0].paletteId).toBeUndefined();
  });
});

describe("alignColourStack", () => {
  const align = (colours: DocumentColour[], needed: string[], spec: "ISOM2017-2" | "ISSprOM2019-2" = "ISSprOM2019-2", usage?: number[]) => {
    const infos = identifySourceColours(colours, spec, "iof2024");
    return alignColourStack({ colours, infos, spec, edition: "iof2024", needed: new Set(needed), usage });
  };

  it("keeps every source colour, tags palette ids, and inserts nothing when the source has what is needed", () => {
    const r = align(sprintStack, ["black100", "brown50-road", "yellow100", "purple-lower"]);
    expect(r.colours.filter((x) => x.sourceNumber !== undefined)).toHaveLength(sprintStack.length);
    expect(r.inserted).toEqual([]);
    expect(r.index.get("brown50-road")).toBe(r.remap[sprintStack.findIndex((x) => x.sourceNumber === 18)]);
    expect(r.colours[r.index.get("purple-lower")!]).toMatchObject({ sourceNumber: 23, purpleRole: "lower", paletteIds: ["purple-lower"] });
    expect(r.colours[r.index.get("purple-upper")!]).toMatchObject({ sourceNumber: 25, purpleRole: "upper" });
    // The remap is a permutation of the source indices onto the new stack.
    expect([...r.remap].sort((a, b) => a - b)).toEqual(sprintStack.map((_, i) => i).filter((i) => r.remap.includes(i)));
  });

  it("aliases a needed palette id onto a same-class source colour instead of inserting a duplicate", () => {
    // The source has one black 50 %; canonical 521 asks for black50-building and some other symbol for black-area-screen (black 35 %: different class) …
    const r = align(sprintStack, ["black50-building", "blue70-area"]);
    // … blue70-area is within the 20-point tolerance of the source "Blå 50%", so it aliases rather than inserting.
    expect(r.aliased).toContainEqual({ paletteId: "blue70-area", viaPaletteId: "blue50-area", sourceNumber: 20 });
    expect(r.inserted).not.toContain("blue70-area");
    expect(r.colours[r.index.get("blue70-area")!].paletteIds).toEqual(expect.arrayContaining(["blue50-area", "blue70-area"]));
  });

  it("inserts a needed palette entry at its palette position when nothing can stand for it", () => {
    const r = align(sprintStack, ["black20-canopy"]);
    expect(r.inserted).toEqual(["black20-canopy"]);
    const at = r.index.get("black20-canopy")!;
    expect(r.colours[at]).toMatchObject({ id: "iof2024:black20-canopy", paletteIds: ["black20-canopy"] });
    expect(r.colours[at].sourceNumber).toBeUndefined();
    // In the palette the canopy grey sits directly above the blue area screens; it is slotted
    // next to the nearest placed neighbour by palette rank, whatever the source did elsewhere.
    expect(at).toBe(r.index.get("blue50-area")! + 1);
    expect(at).toBeLessThan(r.index.get("blue100-pointline")!);
  });

  it("always provides both purples: inserted at the right places when the source has none", () => {
    const noPurple = sprintStack.filter((x) => !/violett/i.test(x.name));
    const r = align(noPurple, []);
    expect(r.inserted).toEqual(expect.arrayContaining(["purple-lower", "purple-upper"]));
    const lower = r.index.get("purple-lower")!, upper = r.index.get("purple-upper")!, black = r.index.get("black100")!;
    expect(upper).toBe(r.colours.length - 1);
    expect(lower).toBeLessThan(black); // lower purple goes directly below black 100 % (03 §2.4)
    expect(r.colours[lower]).toMatchObject({ purpleRole: "lower" });
    expect(r.colours[upper]).toMatchObject({ purpleRole: "upper" });
  });

  it("prefers the most used duplicate as the palette representative", () => {
    const dup = [c(1, "Gul", [0, 27, 79, 0]), c(2, "Gul", [0, 27, 79, 0]), c(3, "Svart", [0, 0, 0, 100])];
    const r = align(dup, ["yellow100"], "ISOM2017-2", [3, 40, 10]);
    expect(r.colours[r.index.get("yellow100")!].sourceNumber).toBe(2);
    expect(r.colours.filter((x) => x.sourceNumber !== undefined)).toHaveLength(3);
  });

  it("reports source orderings that contradict the palette instead of reordering", () => {
    const upsideDown = [c(1, "Svart", [0, 0, 0, 100]), c(2, "Gul", [0, 27, 79, 0]), c(3, "Brun", [25, 75, 100, 0])];
    const r = align(upsideDown, [], "ISOM2017-2");
    expect(r.conflicts.length).toBeGreaterThan(0);
    expect(r.conflicts.map((x) => x.colour)).toContain("yellow100");
    // Source order is kept: black still drawn first.
    expect(r.colours[r.remap[0]].sourceNumber).toBe(1);
    expect(r.colours[r.remap[1]].sourceNumber).toBe(2);
  });

  it("paletteIndexOfStack rebuilds the lookup the renderer needs from a stored stack", () => {
    const r = align(sprintStack, ["black20-canopy"]);
    const index = paletteIndexOfStack(r.colours);
    expect(index.get("black20-canopy")).toBe(r.index.get("black20-canopy"));
    expect(index.get("purple-lower")).toBe(r.index.get("purple-lower"));
    expect(index.size).toBe(r.index.size);
  });
});
