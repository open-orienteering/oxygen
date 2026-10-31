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
import { nyKartaTest, toColours, ungdomsserien } from "./club-colour-tables.js";

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

  it("an inserted purple copies the map's own purple of the other role; palette CMYK only when it has none (C9)", () => {
    const onlyUpper = sprintStack.filter((x) => !/Undre violett/.test(x.name)).map((x) => (x.sourceNumber === 25 ? { ...x, cmyk: [0.1, 0.9, 0.1, 0] as [number, number, number, number] } : x));
    const r = align(onlyUpper, []);
    expect(r.inserted).toEqual(["purple-lower"]);
    expect(r.colours[r.index.get("purple-lower")!]).toMatchObject({ id: "iof2024:purple-lower", cmyk: [0.1, 0.9, 0.1, 0] });
    expect(r.colours[r.index.get("purple-lower")!].sourceNumber).toBeUndefined();
    const onlyLower = sprintStack.filter((x) => !/Övre violett/.test(x.name)).map((x) => (x.sourceNumber === 23 ? { ...x, cmyk: [0.1, 0.9, 0.1, 0] as [number, number, number, number] } : x));
    const r2 = align(onlyLower, []);
    expect(r2.colours[r2.index.get("purple-upper")!].cmyk).toEqual([0.1, 0.9, 0.1, 0]);
    const none = align(sprintStack.filter((x) => !/violett/i.test(x.name)), []);
    expect(none.colours[none.index.get("purple-lower")!].cmyk).toEqual(none.colours[none.index.get("purple-upper")!].cmyk);
    expect(none.colours[none.index.get("purple-upper")!].cmyk[0]).toBeCloseTo(0.35, 2);
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
    // Lower purple goes above the yellow; the black drawn under it is reported, not moved.
    expect(r.conflicts).toContainEqual({ colour: "black100", reason: 'source places "Svart" below purple-lower; the palette has the reverse order' });
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

  describe("lower purple: above every area colour, below the 100 % line and point colours (bugfix-lower-purple-under-areas)", () => {
    const lowerOf = (r: ReturnType<typeof align>) => r.index.get("purple-lower")!;
    /** New positions of the source colours with these numbers. */
    const at = (r: ReturnType<typeof align>, ...numbers: number[]) => numbers.map((n) => r.colours.findIndex((x) => x.sourceNumber === n));

    it("Ny_karta_test: inserted directly above the highest area colour, not under the dark-green area colour at the bottom of the area block", () => {
      const colours = toColours(nyKartaTest);
      const infos = identifySourceColours(colours, "ISOM2017-2", "iof2024");
      const darkGreen = colours.findIndex((x) => x.name === "Green 100% + 50% Black Area Feature");
      expect(infos[darkGreen].paletteId).toBeUndefined();
      const r = align(colours, [], "ISOM2017-2");
      const lower = lowerOf(r);
      expect(r.inserted).toContain("purple-lower");
      // Above the highest area colour and the road infill the mapper drew over it; below the first line colour.
      expect(r.colours.slice(lower - 2, lower + 2).map((x) => x.name)).toEqual(["Black 20% - Area Feature", "Brun gc-vägar nära hus", "Lower purple for course overprint", "Brown 100% - Line Feature"]);
      expect(r.remap[darkGreen]).toBeLessThan(lower);
      // Brown / blue line, green / brown / blue point, railway white, black 100 %, the map's upper purple.
      for (const pos of at(r, 18, 16, 15, 14, 13, 9, 5, 2)) expect(pos).toBeGreaterThan(lower);
      // Two stray colours above the line block stay where the mapper put them and are reported.
      expect(r.areasAboveLowerPurple.map((a) => a.name)).toEqual(["Vit mask för text och kontrollb", "Gul (över platta)"]);
      // The inserted purple is still the map's own course purple (C9).
      expect(r.colours[lower].cmyk).toEqual(r.colours[r.index.get("purple-upper")!].cmyk);
    });

    it("Ungdomsserien: above the last copy's area block; the dark-green line colour left below is a conflict, not the anchor", () => {
      const colours = toColours(ungdomsserien);
      const r = align(colours, [], "ISOM2017-2");
      const lower = lowerOf(r);
      expect(r.colours[lower - 1]).toMatchObject({ name: "Blå 100% - Ytobjekt", sourceNumber: 19 });
      expect(r.colours[lower + 1]).toMatchObject({ name: "Brun 100% - Linjeobjekt", sourceNumber: 18 });
      // The last copy's brown / blue line, green / brown / blue point, black 100 % and upper purple.
      for (const pos of at(r, 18, 17, 8, 7, 6, 5, 3)) expect(pos).toBeGreaterThan(lower);
      expect(r.conflicts).toContainEqual({ colour: "darkgreen-hedge", reason: 'source places "Grön 100% + 50% Svart - Linjeobjekt" below purple-lower; the palette has the reverse order' });
      // Every copy's yellows and greens are below it.
      for (const [i, x] of colours.entries()) if (/^(Gul|Grön) \d+% - Ytobjekt$/.test(x.name)) expect(r.remap[i], x.name).toBeLessThan(lower);
    });

    it("one stray area colour on top does not drag lower purple over the line colours", () => {
      const stack = [c(1, "Gul", [0, 27, 79, 0]), c(2, "Grön 60%", [48, 0, 60, 0]), c(3, "Brun 100% - Linjeobjekt", [25, 75, 100, 0]), c(4, "Svart", [0, 0, 0, 100]), c(5, "Övre violett", [35, 85, 0, 0]), c(6, "Gul över platta", [0, 27, 79, 0])];
      const r = align(stack, [], "ISOM2017-2");
      expect(r.colours[lowerOf(r) - 1].sourceNumber).toBe(2);
      expect(r.areasAboveLowerPurple).toEqual([{ name: "Gul över platta", sourceNumber: 6, paletteId: "yellow100" }]);
      expect(r.conflicts.filter((x) => /purple-lower/.test(x.reason))).toEqual([]);
    });

    it("a colour whose name says area is an area colour even when its ink is not an IOF colour", () => {
      const stack = [c(1, "Gul", [0, 27, 79, 0]), c(2, "Brun 100% - Linjeobjekt", [25, 75, 100, 0]), c(3, "Svart", [0, 0, 0, 100]), c(4, "Naturreservat - Area Feature", [90, 32, 0, 0])];
      const r = align(stack, [], "ISOM2017-2");
      expect(r.areasAboveLowerPurple).toEqual([{ name: "Naturreservat - Area Feature", sourceNumber: 4 }]);
      expect(r.colours[lowerOf(r) - 1].sourceNumber).toBe(1);
    });

    it("colours no object uses neither steer the anchor nor raise warnings", () => {
      const stack = [c(1, "Gul", [0, 27, 79, 0]), c(2, "Svart", [0, 0, 0, 100]), c(3, "Gul (oanvänd)", [0, 27, 79, 0]), c(4, "Brun 100% - Linjeobjekt", [25, 75, 100, 0])];
      const r = align(stack, [], "ISOM2017-2", [10, 10, 0, 10]);
      expect(r.colours[lowerOf(r) - 1].sourceNumber).toBe(1);
      expect(r.areasAboveLowerPurple).toEqual([]);
      const all = align(stack, [], "ISOM2017-2");
      expect(all.areasAboveLowerPurple).toEqual([]);
      expect(all.colours[lowerOf(all) - 1].sourceNumber).toBe(3);
    });

    it("without area colours: directly below the first colour the palette puts above lower purple", () => {
      const r = align([c(1, "Brun 50% - Vägfyllning", [10, 35, 50, 0]), c(2, "Svart", [0, 0, 0, 100])], [], "ISOM2017-2");
      expect(r.colours[lowerOf(r) + 1].sourceNumber).toBe(2);
      expect(r.colours[lowerOf(r) - 1].sourceNumber).toBe(1);
    });

    it("a map's own lower purple keeps its place; what it hides and what sits on the wrong side are reported", () => {
      // Vinterserien's shape: the named lower purple drawn above the named upper one, an area on top of the lower.
      const stack = [c(1, "Gul", [0, 27, 79, 0]), c(2, "Svart", [0, 0, 0, 100]), c(3, "Övre violett för banpåtryck", [35, 85, 0, 0]), c(4, "Undre violett för banpåtryck", [35, 85, 0, 0]), c(5, "Grön 30% - Ytobjekt", [24, 0, 30, 0])];
      const r = align(stack, [], "ISOM2017-2");
      expect(r.inserted).toEqual([]);
      expect(r.colours.map((x) => x.sourceNumber)).toEqual([1, 2, 3, 4, 5]);
      expect(r.conflicts.map((x) => x.colour)).toEqual(expect.arrayContaining(["black100", "purple-upper"]));
      expect(r.areasAboveLowerPurple).toEqual([{ name: "Grön 30% - Ytobjekt", sourceNumber: 5, paletteId: "green30-area" }]);
    });
  });
});
