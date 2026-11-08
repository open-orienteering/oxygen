/** Variants and their materialisation (course-layer.md §12; 08 §4.3 "Materialisation"). */

import { describe, expect, it } from "vitest";
import { courseStructureSchema, structureControlItems, type StoredCourseStructure } from "../structure.js";
import {
  MAX_VARIANTS,
  materialiseVariants,
  pruneSiteFromStructure,
  structureSiteIds,
  variantCount,
  variantKeyDuplicates,
  variantStructure,
} from "../variants.js";

type Item = StoredCourseStructure["items"][number];
const c = (siteId: string, extra: Record<string, unknown> = {}): Item => ({ siteId, ...extra }) as Item;
const group = (id: string, alts: string[][], extra: { loop?: boolean; labels?: string[] } = {}): Item => ({
  kind: "variation",
  id,
  alternatives: alts.map((ids, i) => ({
    label: extra.labels?.[i] ?? String.fromCharCode(65 + i),
    items: ids.map((siteId) => ({ siteId })),
  })),
  ...(extra.loop ? { loop: true } : {}),
});
const course = (items: Item[]): StoredCourseStructure => ({ version: 1, id: "root", orderMode: "ordered", items });
const ids = (items: readonly { siteId: string }[]) => items.map((i) => i.siteId).join(" ");

describe("materialiseVariants", () => {
  it("is empty for a course without groups (no children)", () => {
    expect(materialiseVariants(course([c("S"), c("31"), c("F")]))).toEqual([]);
    expect(variantCount(course([c("S"), c("F")]))).toBe(0);
  });

  it("is the cartesian product over groups in item order, keyed by the groups' letters", () => {
    const s = course([c("S"), c("31"), group("g1", [["32"], ["33"]]), c("34"), group("g2", [["35"], ["36"], ["37"]]), c("F")]);
    const vs = materialiseVariants(s);
    expect(vs.map((v) => v.key)).toEqual(["AA", "AB", "AC", "BA", "BB", "BC"]);
    expect(variantCount(s)).toBe(6);
    expect(ids(vs.find((v) => v.key === "BC")!.items)).toBe("S 31 33 34 37 F");
  });

  it("keeps each alternative's legs and flags (the leg into an alternative's first control leaves the anchor)", () => {
    const s = course([
      c("S"),
      c("31"),
      { kind: "variation", id: "g", alternatives: [
        { label: "A", items: [{ siteId: "32", leg: { style: "marked_route" }, numberHidden: true }] },
        { label: "B", items: [{ siteId: "33" }] },
      ] } as Item,
      c("34", { leg: { gaps: [{ from: 0.1, to: 0.2 }] } }),
      c("F"),
    ]);
    const a = materialiseVariants(s).find((v) => v.key === "A")!;
    expect(a.items[2]).toEqual({ siteId: "32", leg: { style: "marked_route" }, numberHidden: true });
    expect(a.items[3]).toEqual({ siteId: "34", leg: { gaps: [{ from: 0.1, to: 0.2 }] } });
  });

  it("a loop yields the permutations of its alternatives, the anchor repeated between them", () => {
    const s = course([c("S"), c("31"), group("b", [["32"], ["33"]], { loop: true }), c("31"), c("F")]);
    const vs = materialiseVariants(s);
    expect(vs.map((v) => v.key)).toEqual(["AB", "BA"]);
    expect(ids(vs[0].items)).toBe("S 31 32 31 33 31 F");
    expect(ids(vs[1].items)).toBe("S 31 33 31 32 31 F");
  });

  it("a loop with three alternatives yields six variants", () => {
    const s = course([c("S"), c("31"), group("b", [["32"], ["33"], ["34", "35"]], { loop: true }), c("31"), c("F")]);
    const vs = materialiseVariants(s);
    expect(vs.map((v) => v.key)).toEqual(["ABC", "ACB", "BAC", "BCA", "CAB", "CBA"]);
    expect(ids(vs.find((v) => v.key === "CAB")!.items)).toBe("S 31 34 35 31 32 31 33 31 F");
  });

  it("an empty alternative is a straight leg (answer 5); in a loop it adds no anchor visit", () => {
    const fork = materialiseVariants(course([c("S"), c("31"), group("g", [["32"], []]), c("34"), c("F")]));
    expect(fork.map((v) => [v.key, ids(v.items)])).toEqual([["A", "S 31 32 34 F"], ["B", "S 31 34 F"]]);
    const loop = materialiseVariants(course([c("S"), c("31"), group("b", [["32"], []], { loop: true }), c("31"), c("F")]));
    expect(loop.map((v) => [v.key, ids(v.items)])).toEqual([["AB", "S 31 32 31 F"], ["BA", "S 31 32 31 F"]]);
  });

  it("the anchor visit drops the anchor's role and leg but keeps a hidden number", () => {
    const s = course([c("31", { role: "start", numberHidden: true, leg: { style: "none" } }), group("b", [["32"], ["33"]], { loop: true }), c("31"), c("F")]);
    expect(materialiseVariants(s)[0].items[2]).toEqual({ siteId: "31", numberHidden: true });
  });

  it("keys are stable across an edit outside the groups", () => {
    const a = course([c("S"), c("31"), group("g", [["32"], ["33"]]), c("34"), c("F")]);
    const b = course([c("S"), c("30"), c("31"), group("g", [["32"], ["33"]]), c("34", { leg: { style: "none" } }), c("F")]);
    expect(materialiseVariants(a).map((v) => v.key)).toEqual(materialiseVariants(b).map((v) => v.key));
  });

  it("names multi-letter labels as stored and reports colliding keys", () => {
    const s = course([c("S"), c("31"), group("g1", [["32"], ["33"]], { labels: ["A", "AB"] }), c("34"), group("g2", [["35"], ["36"]], { labels: ["B", "C"] }), c("F")]);
    const keys = materialiseVariants(s).map((v) => v.key);
    expect(keys).toEqual(["AB", "AC", "ABB", "ABC"]);
    expect(variantKeyDuplicates(keys)).toEqual([]);
    const dup = course([c("S"), c("31"), group("g1", [["32"], ["33"]], { labels: ["A", "AB"] }), c("34"), group("g2", [["35"], ["36"]], { labels: ["B", "C"] }), c("37"), group("g3", [["38"], ["39"]], { labels: ["C", "BC"] }), c("F")]);
    expect(variantKeyDuplicates(materialiseVariants(dup).map((v) => v.key))).toEqual(["ABBC"]);
  });

  it("counts variants without building them (the cap's guard)", () => {
    const big = course([c("S"), c("31"), group("b", [["32"], ["33"], ["34"], ["35"], ["36"]], { loop: true }), c("31"), c("F")]);
    expect(variantCount(big)).toBe(120);
    expect(variantCount(big)).toBeGreaterThan(MAX_VARIANTS);
  });
});

describe("variantStructure", () => {
  const s = course([c("S"), c("31"), group("g", [["32"], ["33"]]), c("34"), group("b", [["35"], ["36"]], { loop: true }), c("34"), c("F")]);

  it("is the linear structure of one variant, equal to the product's row, parsed by the column schema", () => {
    for (const v of materialiseVariants(s)) {
      const linear = variantStructure(s, v.key)!;
      expect(linear.items).toEqual(v.items);
      expect(linear.items.some((i) => i.kind === "variation")).toBe(false);
      expect(courseStructureSchema.safeParse(linear).success).toBe(true);
      expect(structureControlItems(linear)).toEqual(v.items);
      expect(linear.orderMode).toBe("ordered");
    }
  });

  it("is null for an unknown key", () => {
    expect(variantStructure(s, "ZZ")).toBeNull();
  });
});

describe("structureSiteIds", () => {
  it("lists every site of every alternative once, in order", () => {
    const s = course([c("S"), c("31"), group("g", [["32"], ["33", "31"]]), c("34"), c("F")]);
    expect(structureSiteIds(s)).toEqual(["S", "31", "32", "33", "34", "F"]);
  });

  it("lists the crossing points the legs name (F4), after the items", () => {
    const s = course([c("S"), { siteId: "31", leg: { crossing: { controlId: "P" } } }, { kind: "variation", id: "g", alternatives: [{ label: "A", items: [{ siteId: "32", leg: { crossing: { controlId: "Q" } } }] }, { label: "B", items: [{ siteId: "33" }] }] }, c("34"), c("F")] as never);
    expect(structureSiteIds(s)).toEqual(["S", "31", "32", "33", "34", "F", "P", "Q"]);
  });
});

describe("pruneSiteFromStructure", () => {
  it("drops the site from every alternative and the top level, keeping the group", () => {
    const s = course([c("S"), c("31"), group("g", [["32", "35"], ["33", "35"]]), c("34"), c("F")]);
    const out = pruneSiteFromStructure(s, "35");
    expect(out.items[2]).toEqual(group("g", [["32"], ["33"]]));
    expect(ids(structureControlItems(out))).toBe("S 31 32 34 F");
  });

  it("keeps a group whose one alternative empties (answer 5) and dissolves one left with none", () => {
    const one = pruneSiteFromStructure(course([c("S"), c("31"), group("g", [["32"], ["33"]]), c("34"), c("F")]), "33");
    expect(one.items[2]).toEqual(group("g", [["32"], []]));
    const both = pruneSiteFromStructure(course([c("S"), c("31"), group("g", [["32"], ["32"]]), c("34"), c("F")]), "32");
    expect(both.items.map((i) => i.kind ?? "control")).toEqual(["control", "control", "control", "control"]);
  });

  it("dissolves a group left unanchored into its first alternative", () => {
    const s = pruneSiteFromStructure(course([c("31"), group("g", [["32"], ["33"]]), c("F")]), "31");
    expect(ids(s.items as { siteId: string }[])).toBe("32 F");
    expect(courseStructureSchema.safeParse(s).success).toBe(true);
  });

  it("dissolves the second of two groups left adjacent", () => {
    const s = pruneSiteFromStructure(course([c("S"), group("g1", [["32"], ["33"]]), c("34"), group("g2", [["35"], ["36"]]), c("F")]), "34");
    expect(s.items.map((i) => (i.kind === "variation" ? i.id : i.siteId))).toEqual(["S", "g1", "35", "F"]);
    expect(courseStructureSchema.safeParse(s).success).toBe(true);
  });

  it("strips a leg crossing naming the site and keeps the rest of the leg (F4)", () => {
    const s = course([c("S"), { siteId: "31", leg: { bends: [{ x: 1, y: 2 }], crossing: { controlId: "P" } } }, { siteId: "F", leg: { crossing: { controlId: "P" } } }] as never);
    const out = pruneSiteFromStructure(s, "P");
    expect(out.items[1]).toEqual({ siteId: "31", leg: { bends: [{ x: 1, y: 2 }] } });
    expect(out.items[2]).toEqual({ siteId: "F" });
  });

  it("drops the site's label offset", () => {
    const s = { ...course([c("S"), c("31"), c("F")]), labelOffsets: { "31": { dx: 1, dy: 2 }, S: { dx: 0, dy: 1 } } };
    expect(pruneSiteFromStructure(s, "31").labelOffsets).toEqual({ S: { dx: 0, dy: 1 } });
  });
});
