import { describe, it, expect } from "vitest";
import type { course } from "@oxygen/shared";
import { appendSite, controlSequence, insertSite, moveVisit, removeSite, removeVisit, setRole } from "../structure-edit";

type S = course.WireCourseStructure;
const KIND: Record<number, "start" | "finish" | "control"> = { 1: "start", 2: "start", 9: "finish", 8: "finish" };
const kindOf = (id: number) => KIND[id] ?? "control";
const st = (...ids: number[]): S => ({ version: 1, id: "c", orderMode: "ordered", items: ids.map((siteId) => ({ siteId })) });
const ids = (s: S) => s.items.map((i) => (i.kind === "variation" ? -1 : i.siteId));

describe("structure edits (docs/course-editor.md §4)", () => {
  it("the control sequence leaves out a leading start and a trailing finish", () => {
    expect(controlSequence(st(1, 31, 32, 9), kindOf)).toEqual([31, 32]);
    expect(controlSequence(st(31, 32), kindOf)).toEqual([31, 32]);
    expect(controlSequence(st(31, 32, 31), kindOf)).toEqual([31, 32, 31]);
  });

  it("insert and append work in sequence positions, keeping start and finish where they are", () => {
    expect(ids(insertSite(st(1, 31, 32, 9), 1, 40, kindOf))).toEqual([1, 31, 40, 32, 9]);
    expect(ids(insertSite(st(1, 31, 32, 9), 0, 40, kindOf))).toEqual([1, 40, 31, 32, 9]);
    expect(ids(appendSite(st(1, 31, 32, 9), 40, kindOf))).toEqual([1, 31, 32, 40, 9]);
    expect(ids(appendSite(st(), 40, kindOf))).toEqual([40]);
    expect(ids(insertSite(st(31), 99, 40, kindOf))).toEqual([31, 40]);
  });

  it("remove takes out every visit of a control, never the structure's start / finish slot by accident", () => {
    expect(ids(removeSite(st(1, 31, 32, 31, 9), 31))).toEqual([1, 32, 9]);
    expect(ids(removeSite(st(1, 31, 9), 77))).toEqual([1, 31, 9]);
  });

  it("removeVisit drops one visit by position", () => {
    expect(ids(removeVisit(st(1, 31, 32, 31, 9), 2, kindOf))).toEqual([1, 31, 32, 9]);
    expect(ids(removeVisit(st(1, 31, 9), 5, kindOf))).toEqual([1, 31, 9]);
  });

  it("move reorders within the control sequence", () => {
    expect(ids(moveVisit(st(1, 31, 32, 33, 9), 0, 2, kindOf))).toEqual([1, 32, 33, 31, 9]);
    expect(ids(moveVisit(st(1, 31, 32, 33, 9), 2, 0, kindOf))).toEqual([1, 33, 31, 32, 9]);
    expect(ids(moveVisit(st(31, 32), 0, 5, kindOf))).toEqual([32, 31]);
  });

  it("setRole replaces the explicit start or finish, or adds one", () => {
    expect(ids(setRole(st(1, 31, 9), "start", 2, kindOf))).toEqual([2, 31, 9]);
    expect(ids(setRole(st(31, 9), "start", 2, kindOf))).toEqual([2, 31, 9]);
    expect(ids(setRole(st(1, 31, 9), "finish", 8, kindOf))).toEqual([1, 31, 8]);
    expect(ids(setRole(st(1, 31), "finish", 8, kindOf))).toEqual([1, 31, 8]);
  });

  it("keeps everything else of the structure; a leg's props go when the leg into the item changed", () => {
    const s: S = { version: 1, id: "c", orderMode: "free_order", items: [{ siteId: 31, numberHidden: true }, { siteId: 32, leg: { gaps: [{ from: 0.2, to: 0.3 }] } }] };
    const out = insertSite(s, 1, 40, kindOf);
    expect(out.orderMode).toBe("free_order");
    expect(out.items[0]).toEqual({ siteId: 31, numberHidden: true });
    // 32's leg now comes from 40: the 31 → 32 gaps no longer describe it.
    expect(out.items[2]).toEqual({ siteId: 32 });
    expect(s.items).toHaveLength(2);
    // An edit elsewhere keeps the leg.
    const kept = appendSite(s, 40, kindOf);
    expect(kept.items[1]).toEqual({ siteId: 32, leg: { gaps: [{ from: 0.2, to: 0.3 }] } });
  });
});
