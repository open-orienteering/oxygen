import { describe, it, expect } from "vitest";
import type { course } from "@oxygen/shared";
import { alternativeEndAt, courseViewOrders, displaySequence, explicitStructure, insertIndexForLeg, legForInsert, partHeadings, variationBlocks, type SiteRow } from "../sequence";

const site = (id: number, status: number, x = id, y = id, code = String(id)): SiteRow => ({ id, code, status, mapX: x, mapY: y });
// Two starts (1 the default: lowest id), one finish.
const SITES = [site(1, 4), site(2, 4), site(9, 5), site(31, 0), site(32, 0), site(33, 0, 0, 0)];
const st = (...ids: number[]): course.WireCourseStructure => ({ version: 1, id: "c", orderMode: "ordered", items: ids.map((siteId) => ({ siteId })) });

describe("display sequence and explicit structure (docs/course-editor.md §4)", () => {
  it("completes an implicit start / finish with the event default", () => {
    const rows = displaySequence(st(31, 32), SITES);
    expect(rows.map((r) => [r.kind, r.id, r.seqIndex])).toEqual([["start", 1, -1], ["control", 31, 0], ["control", 32, 1], ["finish", 9, -1]]);
  });

  it("an explicit start wins over the default", () => {
    expect(displaySequence(st(2, 31, 9), SITES).map((r) => r.id)).toEqual([2, 31, 9]);
  });

  it("unpositioned sites have no point", () => {
    expect(displaySequence(st(33), SITES).find((r) => r.id === 33)?.pt).toBeNull();
  });

  it("the first save makes start and finish explicit, once", () => {
    const s = explicitStructure(st(31, 32), SITES);
    expect(s.items.map((i) => (i.kind === "variation" ? 0 : i.siteId))).toEqual([1, 31, 32, 9]);
    expect(explicitStructure(s, SITES)).toEqual(s);
  });

  it("maps a leg to the insert position, skipping unpositioned rows", () => {
    const rows = displaySequence(st(31, 33, 32), SITES);
    // Positioned: S, 31, 32, F → leg 0 S→31, leg 1 31→32, leg 2 32→F.
    expect(insertIndexForLeg(rows, 0)).toBe(0);
    expect(insertIndexForLeg(rows, 1)).toBe(2);
    expect(insertIndexForLeg(rows, 2)).toBe(3);
  });

  it("maps an insert position back to the leg's item and its ends (§6.7)", () => {
    const rows = displaySequence(st(31, 33, 32), SITES);
    // rows: S(0) 31(1) 33(2, unpositioned) 32(3) F(4).
    for (let leg = 0; leg < 3; leg++) {
      const hit = legForInsert(rows, insertIndexForLeg(rows, leg));
      expect(hit && [hit.from.id, hit.to.id]).toEqual([[1, 31], [31, 32], [32, 9]][leg]);
    }
    expect(legForInsert(rows, 0)?.itemIndex).toBe(1);
    expect(legForInsert(rows, 2)?.itemIndex).toBe(3);
    expect(legForInsert(rows, 3)?.itemIndex).toBe(4);
    // A leg into the unpositioned control has no point to run to.
    expect(legForInsert(rows, 1)).toBeNull();
  });
});

describe("variation groups (docs/course-editor.md §12, F7)", () => {
  type Item = course.WireCourseStructure["items"][number];
  const g = (id: string, alts: number[][], loop = false): Item => ({
    kind: "variation", id, alternatives: alts.map((l, i) => ({ label: String.fromCharCode(65 + i), items: l.map((siteId) => ({ siteId })) })), ...(loop ? { loop: true } : {}),
  });
  const mk = (...items: (number | Item)[]): course.WireCourseStructure => ({ version: 1, id: "c", orderMode: "ordered", items: items.map((i) => (typeof i === "number" ? { siteId: i } : i)) });
  const sites = [...SITES, site(41, 0, 50, 50), site(42, 0, 60, 60)];
  // Implicit start and finish: paths index the explicit structure (S prepended).
  const s = mk(31, g("v1", [[41], []]), 32);

  it("rows carry their path in the explicit structure and their group", () => {
    const rows = displaySequence(s, sites);
    expect(rows.map((r) => [r.id, r.seqIndex])).toEqual([[1, -1], [31, 0], [41, 1], [32, 2], [9, -1]]);
    expect(rows[2].path).toEqual({ itemIndex: 2, alt: { label: "A", index: 0 } });
    expect(rows[2].group).toEqual({ id: "v1", label: "A", loop: false });
    expect(rows[3].path).toEqual({ itemIndex: 3 });
    expect(displaySequence(s, sites, { v1: ["B"] }).map((r) => r.id)).toEqual([1, 31, 32, 9]);
  });

  it("a loop's anchor visit is a row of the group without an alternative", () => {
    const rows = displaySequence(mk(31, g("b", [[41], [42]], true), 31), sites);
    expect(rows.map((r) => r.id)).toEqual([1, 31, 41, 31, 42, 31, 9]);
    expect(rows[3].path).toEqual({ itemIndex: 2, anchorVisit: true });
    expect(rows[3].group).toEqual({ id: "b", label: null, loop: true });
  });

  it("the leg into a group row names its path", () => {
    const rows = displaySequence(s, sites);
    expect(legForInsert(rows, 1)?.path).toEqual({ itemIndex: 2, alt: { label: "A", index: 0 } });
  });

  it("Course view's orders: the active alternative, a loop with it first", () => {
    const loop = mk(31, g("v1", [[41], []]), 32, g("b", [[41], [42]], true), 32);
    expect(courseViewOrders(loop, { v1: "B", b: "B" })).toEqual({ v1: ["B"], b: ["B", "A"] });
    expect(courseViewOrders(loop, { v1: "Z" })).toEqual({ v1: ["A"], b: ["A", "B"] });
  });

  it("blocks sit after the anchor's row; an alternative's end position", () => {
    const rows = displaySequence(s, sites, { v1: ["B"] });
    expect(variationBlocks(s, sites, rows, { v1: ["B"] })).toEqual([
      { id: "v1", itemIndex: 2, labels: ["A", "B"], loop: false, active: "B", counts: { A: 1, B: 0 }, afterRow: 1 },
    ]);
    expect(alternativeEndAt(rows, 2, "B")).toBe(1);
    expect(alternativeEndAt(displaySequence(s, sites), 2, "A")).toBe(2);
  });
});

describe("part headings (docs/course-editor.md §6.9)", () => {
  const sites = [...SITES, { ...site(40, 0), kind: "map_exchange" }];

  it("marks the exchange row; part 1 before the first row, part 2 after the exchange", () => {
    const rows = displaySequence(st(31, 40, 32), sites);
    expect(rows.map((r) => !!r.exchange)).toEqual([false, false, true, false, false]);
    expect([...partHeadings(rows)]).toEqual([[0, 1], [3, 2]]);
  });

  it("is empty without an exchange", () => {
    expect(partHeadings(displaySequence(st(31, 32), SITES)).size).toBe(0);
  });
});
