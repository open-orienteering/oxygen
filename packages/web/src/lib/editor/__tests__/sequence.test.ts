import { describe, it, expect } from "vitest";
import type { course } from "@oxygen/shared";
import { displaySequence, explicitStructure, insertIndexForLeg, type SiteRow } from "../sequence";

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
});
