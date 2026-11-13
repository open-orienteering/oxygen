/** The structure ↔ columns mirror (docs/course-layer.md §6.2). */

import { describe, expect, it } from "vitest";
import { carryLegs, layerPropsOfStored, splitStructure, structureFromColumns, structureToWire, structureFromWire } from "../course-structure.js";

const KIND: Record<string, string> = { S1: "start", S2: "start", a: "control", b: "control", F1: "finish" };
const kindOf = (id: string) => KIND[id];
const items = (...ids: Array<string | { siteId: string; role?: "start" | "finish" | "control"; numberHidden?: boolean }>) =>
  ids.map((i) => (typeof i === "string" ? { siteId: i } : i));

describe("structureFromColumns", () => {
  const starts = [{ id: "S1", name: "Start 1" }, { id: "S2", name: "Start 2" }];

  it("names the start / finish the columns name explicitly, and the course_controls in between", () => {
    const s = structureFromColumns(
      { id: "c", orderMode: "ordered", startName: "Start 2", finishControlId: "F1", firstAsStart: false, lastAsFinish: false },
      [{ controlId: "a", numberHidden: false }, { controlId: "b", numberHidden: true }],
      starts,
    );
    expect(s).toEqual({ version: 1, id: "c", orderMode: "ordered", items: [{ siteId: "S2" }, { siteId: "a" }, { siteId: "b", numberHidden: true }, { siteId: "F1" }] });
  });

  it("leaves the event default implicit (startName empty or unmatched, no finish id)", () => {
    const s = structureFromColumns(
      { id: "c", orderMode: "free_order", startName: "Gone", finishControlId: null, firstAsStart: false, lastAsFinish: false },
      [{ controlId: "a", numberHidden: false }],
      starts,
    );
    expect(s.items).toEqual([{ siteId: "a" }]);
    expect(s.orderMode).toBe("free_order");
  });

  it("marks firstAsStart / lastAsFinish by role and round-trips through splitStructure", () => {
    const cols = { id: "c", orderMode: "ordered" as const, startName: "Start 1", finishControlId: "F1", firstAsStart: true, lastAsFinish: true };
    const s = structureFromColumns(cols, [{ controlId: "a", numberHidden: false }, { controlId: "b", numberHidden: false }], starts);
    expect(s.items).toEqual([{ siteId: "a", role: "start" }, { siteId: "b", role: "finish" }]);
    expect(splitStructure(s.items, kindOf)).toMatchObject({ start: null, finish: null, firstAsStart: true, lastAsFinish: true });
  });
});

describe("wire form (public control ids)", () => {
  const publicId = new Map([["S1", 1], ["a", 31], ["F1", 2]]);
  const uuid = new Map([...publicId].map(([k, v]) => [v, k]));

  it("maps site ids and label offsets both ways", () => {
    const stored = { version: 1 as const, id: "c", orderMode: "ordered" as const, items: [{ siteId: "S1" }, { siteId: "a", leg: { gaps: [{ from: 0.1, to: 0.2 }] } }, { siteId: "F1" }], labelOffsets: { a: { dx: 1, dy: 2 } } };
    const wire = structureToWire(stored, (id) => publicId.get(id)!);
    expect(wire.items.map((i) => ("siteId" in i ? i.siteId : null))).toEqual([1, 31, 2]);
    expect(wire.labelOffsets).toEqual({ "31": { dx: 1, dy: 2 } });
    expect(structureFromWire(wire, (id) => uuid.get(id)!)).toEqual(stored);
  });

  it("maps a leg's crossing point like a site, in alternatives too (F4)", () => {
    const ids = new Map([...publicId, ["P", 90]]);
    const back = new Map([...ids].map(([k, v]) => [v, k]));
    const stored = {
      version: 1 as const, id: "c", orderMode: "ordered" as const,
      items: [
        { siteId: "S1" },
        { siteId: "a", leg: { bends: [{ x: 1, y: 1 }], crossing: { controlId: "P", section: true } } },
        { kind: "variation" as const, id: "g", alternatives: [{ label: "A", items: [{ siteId: "a", leg: { crossing: { controlId: "P" } } }] }, { label: "B", items: [] }] },
        { siteId: "F1" },
      ],
    };
    const wire = structureToWire(stored, (id) => ids.get(id)!);
    const item = wire.items[1] as { leg: { crossing: { controlId: number } } };
    expect(item.leg.crossing).toEqual({ controlId: 90, section: true });
    const alt = (wire.items[2] as { alternatives: { items: { leg?: { crossing: { controlId: number } } }[] }[] }).alternatives[0].items[0];
    expect(alt.leg!.crossing.controlId).toBe(90);
    expect(structureFromWire(wire, (id) => back.get(id)!)).toEqual(stored);
  });
});

describe("layerPropsOfStored (the viewer's leg input, course-layer.md §5)", () => {
  const publicId = new Map([["S1", 1], ["a", 31], ["b", 32], ["F1", 2]]);
  const of = (items: unknown[]) => layerPropsOfStored({ version: 1, id: "c", orderMode: "ordered", items }, (id) => publicId.get(id));
  const corridor = { widthM: 60, edge: true, whiteMm: 3, whiteOpacity: 0.5 };

  it("carries each stored leg whole, keyed by the public ids of its ends", () => {
    const out = of([
      { siteId: "S1" },
      { siteId: "a", leg: { style: "marked_route", gaps: [{ from: 0.1, to: 0.2 }] } },
      { siteId: "b", leg: { bends: [{ x: 1, y: 2 }], corridor } },
      { siteId: "F1", numberHidden: true },
    ]);
    expect(out.legs).toEqual({
      "1>31": { style: "marked_route", gaps: [{ from: 0.1, to: 0.2 }] },
      "31>32": { bends: [{ x: 1, y: 2 }], corridor },
    });
    expect(out.hiddenNumbers).toEqual([2]);
    expect(out).not.toHaveProperty("legGaps");
  });

  it("carries the crossing as the site's public id (F4, §10.3), drops an unknown one, omits a leg left empty", () => {
    const out = of([
      { siteId: "S1" },
      { siteId: "a", leg: { crossing: { controlId: "P", section: true } } },
      { siteId: "b", leg: { style: "none", crossing: { controlId: "gone" } } },
      { siteId: "F1", leg: {} },
    ]);
    const withP = layerPropsOfStored(
      { version: 1, id: "c", orderMode: "ordered", items: [{ siteId: "S1" }, { siteId: "a", leg: { crossing: { controlId: "P", section: true } } }] },
      (id) => (id === "P" ? 90 : publicId.get(id)),
    );
    expect(withP.legs).toEqual({ "1>31": { crossing: { controlId: "90", section: true } } });
    expect(out.legs).toEqual({ "31>32": { style: "none" } });
  });

  it("has no legs for a NULL or invalid column", () => {
    expect(layerPropsOfStored(null, () => 1)).toEqual({ legs: {}, hiddenNumbers: [] });
    expect(layerPropsOfStored({ version: 9 }, () => 1)).toEqual({ legs: {}, hiddenNumbers: [] });
  });
});

describe("carryLegs", () => {
  const linear = (legs: Array<[string, object?]>) => ({
    version: 1 as const,
    id: "c",
    orderMode: "ordered" as const,
    items: legs.map(([siteId, leg]) => ({ siteId, ...(leg ? { leg } : {}) })),
  });

  it("carries a leg to an item that still follows the same site", () => {
    const prev = linear([["S1"], ["a", { gaps: [{ from: 0.2, to: 0.4 }] }], ["F1"]]);
    expect(carryLegs(prev, linear([["S1"], ["a"], ["F1"]])).items[1]).toEqual({ siteId: "a", leg: { gaps: [{ from: 0.2, to: 0.4 }] } });
    // A different predecessor is a different leg.
    expect(carryLegs(prev, linear([["S1"], ["b"], ["a"], ["F1"]])).items[2]).toEqual({ siteId: "a" });
  });

  it("keeps the rewritten item's own props over the carried ones (an import's bends / style, row F9)", () => {
    const prev = linear([["S1"], ["a", { gaps: [{ from: 0.2, to: 0.4 }], style: "marked_route", bends: [{ x: 1, y: 1 }] }]]);
    const next = linear([["S1"], ["a", { bends: [{ x: 5, y: 5 }] }]]);
    expect(carryLegs(prev, next).items[1]).toEqual({
      siteId: "a",
      leg: { gaps: [{ from: 0.2, to: 0.4 }], style: "marked_route", bends: [{ x: 5, y: 5 }] },
    });
  });
});
