/** The structure ↔ columns mirror (docs/course-layer.md §6.2). */

import { describe, expect, it } from "vitest";
import { crossingRowsOf, exchangeRowsOf, layerPropsOfStored, splitStructure, structureFromColumns, structureToWire, structureFromWire } from "../course-structure.js";

const KIND: Record<string, string> = { S1: "start", S2: "start", a: "control", b: "control", F1: "finish" };
const kindOf = (id: string) => KIND[id];
const items = (...ids: Array<string | { siteId: string; role?: "start" | "finish" | "control"; numberHidden?: boolean }>) =>
  ids.map((i) => (typeof i === "string" ? { siteId: i } : i));

describe("splitStructure", () => {
  it("takes a leading start site and a trailing finish site out of the sequence", () => {
    expect(splitStructure(items("S1", "a", "b", "F1"), kindOf)).toEqual({
      start: "S1",
      finish: "F1",
      middle: items("a", "b"),
      firstAsStart: false,
      lastAsFinish: false,
    });
  });

  it("leaves the start / finish implicit when the structure names none (the reader completes the default)", () => {
    expect(splitStructure(items("a", "b"), kindOf)).toEqual({ start: null, finish: null, middle: items("a", "b"), firstAsStart: false, lastAsFinish: false });
  });

  it("reads a control with role start / finish as firstAsStart / lastAsFinish", () => {
    const s = splitStructure(items({ siteId: "a", role: "start" }, "b", { siteId: "a", role: "finish" }), kindOf);
    expect(s).toMatchObject({ start: null, finish: null, firstAsStart: true, lastAsFinish: true });
    expect(s.middle.map((i) => i.siteId)).toEqual(["a", "b", "a"]);
  });

  it("keeps a start site that is not first in the sequence (as course_controls may today)", () => {
    expect(splitStructure(items("a", "S2", "b"), kindOf).middle.map((i) => i.siteId)).toEqual(["a", "S2", "b"]);
  });

  it("handles a structure of only a start", () => {
    expect(splitStructure(items("S1"), kindOf)).toEqual({ start: "S1", finish: null, middle: [], firstAsStart: false, lastAsFinish: false });
  });
});

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

describe("crossingRowsOf (the derived 13.3 / 13.4 rows, F4)", () => {
  const publicId = new Map([["S1", 1], ["a", 31], ["b", 32], ["F1", 2]]);
  const of = (items: unknown[]) =>
    crossingRowsOf({ version: 1, id: "c", orderMode: "ordered", items }, (id) => publicId.get(id), (id) => KIND[id] === "start");

  it("anchors each leg's row after the item it leaves, null after the start", () => {
    expect(
      of([
        { siteId: "S1" },
        { siteId: "a", leg: { crossing: { controlId: "P" } } },
        { siteId: "b", leg: { crossing: { controlId: "P", section: true } } },
        { siteId: "F1" },
      ]),
    ).toEqual([{ afterControlId: null, section: false }, { afterControlId: 31, section: true }]);
  });

  it("is empty for a NULL column or a course without crossings", () => {
    expect(crossingRowsOf(null, () => 1)).toEqual([]);
    expect(of([{ siteId: "S1" }, { siteId: "a" }])).toEqual([]);
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

describe("exchangeRowsOf (the derived 13.5 rows, F5)", () => {
  const publicId = new Map([["S1", 1], ["a", 31], ["x", 40], ["b", 32], ["F1", 2]]);
  const of = (items: unknown[]) => exchangeRowsOf({ version: 1, id: "c", orderMode: "ordered", items }, (id) => publicId.get(id), (id) => id === "x");

  it("names each exchange item by its public id, in course order", () => {
    expect(of([{ siteId: "S1" }, { siteId: "a" }, { siteId: "x" }, { siteId: "b" }, { siteId: "F1" }])).toEqual([{ afterControlId: 40 }]);
  });

  it("is empty for a NULL column or a course without an exchange", () => {
    expect(exchangeRowsOf(null, () => 1, () => true)).toEqual([]);
    expect(of([{ siteId: "S1" }, { siteId: "a" }])).toEqual([]);
  });
});
