/**
 * The one sequence rule every reader of a course uses (docs/course-layer.md
 * §6.2 "Readers"): the stored structure, else the columns; an absent start /
 * finish completed by the event's lowest-seq start / finish; a soft-deleted
 * site drops out (the caller passes live sites only). Also the column split
 * (`splitStructure`, §6.2) and the derived crossing rows (`crossingRowsOf`,
 * F4) — pure, so they moved from the API with the print pipeline (G13).
 */

import { describe, expect, it } from "vitest";
import { courseSequenceOf, crossingRowsOf, splitStructure, type SequenceSite } from "../sequence.js";

const site = (id: string, kind: string, name = ""): SequenceSite => ({ id, kind, status: kind === "control" ? "ok" : kind, name });
const S1 = site("00000000-0000-4000-8000-0000000000a1", "start", "Start 1");
const S2 = site("00000000-0000-4000-8000-0000000000a2", "start", "Start 2");
const A = site("00000000-0000-4000-8000-000000000031", "control");
const B = site("00000000-0000-4000-8000-000000000032", "control");
const F1 = site("00000000-0000-4000-8000-0000000000f1", "finish", "Mål 1");
const F2 = site("00000000-0000-4000-8000-0000000000f2", "finish", "Mål 2");
const live = [S1, S2, A, B, F1, F2];
const byId = (id: string) => live.find((s) => s.id === id);
const sites = { site: byId, starts: [S1, S2], finishes: [F1, F2] };

const columns = { startName: "", finishControlId: null as string | null, firstAsStart: false, lastAsFinish: false };
const stored = (...items: Array<{ siteId: string; role?: "start" | "finish" }>) => ({ version: 1, id: "c", orderMode: "ordered", items });

describe("courseSequenceOf", () => {
  it("columns, nothing explicit: the event's first start and first finish around course_controls", () => {
    const s = courseSequenceOf({ ...columns, structure: null }, [A.id, B.id], sites);
    expect([s.start?.id, s.middle, s.finish?.id]).toEqual([S1.id, [A.id, B.id], F1.id]);
    expect(s.fromStructure).toBe(false);
  });

  it("columns: start by start_name, finish by a live finish_control_id; an unmatched name or id falls back", () => {
    const s = courseSequenceOf({ ...columns, structure: null, startName: "Start 2", finishControlId: F2.id }, [A.id], sites);
    expect([s.start?.id, s.finish?.id]).toEqual([S2.id, F2.id]);
    const gone = courseSequenceOf({ ...columns, structure: null, startName: "Start 9", finishControlId: "00000000-0000-4000-8000-0000000000ff" }, [A.id], sites);
    expect([gone.start?.id, gone.finish?.id]).toEqual([S1.id, F1.id]);
  });

  it("columns: first_as_start / last_as_finish leave the ends out", () => {
    const s = courseSequenceOf({ ...columns, structure: null, firstAsStart: true, lastAsFinish: true }, [A.id, B.id], sites);
    expect([s.start, s.middle, s.finish]).toEqual([null, [A.id, B.id], null]);
    expect([s.firstAsStart, s.lastAsFinish]).toEqual([true, true]);
  });

  it("stored structure: explicit start and finish sites, the items between", () => {
    const s = courseSequenceOf({ ...columns, structure: stored({ siteId: S2.id }, { siteId: A.id }, { siteId: F2.id }) }, [B.id], sites);
    expect([s.start?.id, s.middle, s.finish?.id, s.fromStructure]).toEqual([S2.id, [A.id], F2.id, true]);
  });

  it("stored structure without ends: the defaults; the columns are not read", () => {
    const s = courseSequenceOf({ ...columns, startName: "Start 2", structure: stored({ siteId: A.id }, { siteId: B.id }) }, [], sites);
    expect([s.start?.id, s.middle, s.finish?.id]).toEqual([S1.id, [A.id, B.id], F1.id]);
  });

  it("stored structure: a control in the start / finish role is first_as_start / last_as_finish", () => {
    const s = courseSequenceOf({ ...columns, structure: stored({ siteId: A.id, role: "start" }, { siteId: B.id, role: "finish" }) }, [], sites);
    expect([s.start, s.middle, s.finish, s.firstAsStart, s.lastAsFinish]).toEqual([null, [A.id, B.id], null, true, true]);
  });

  it("stored structure: a soft-deleted explicit start falls back to the default (the caller passes live sites)", () => {
    const deleted = "00000000-0000-4000-8000-0000000000d1";
    const s = courseSequenceOf({ ...columns, structure: stored({ siteId: deleted }, { siteId: A.id }) }, [], sites);
    // The deleted site is neither a start nor a live item: it stays in `middle` for the caller to drop.
    expect(s.start?.id).toBe(S1.id);
    expect(s.middle).toEqual([deleted, A.id]);
  });

  it("an invalid stored structure reads as the columns", () => {
    const s = courseSequenceOf({ ...columns, structure: { nope: true }, startName: "Start 2" }, [B.id], sites);
    expect([s.start?.id, s.middle, s.fromStructure]).toEqual([S2.id, [B.id], false]);
  });

  it("no starts or finishes in the event: no ends", () => {
    const s = courseSequenceOf({ ...columns, structure: null }, [A.id], { site: byId, starts: [], finishes: [] });
    expect([s.start, s.finish]).toEqual([null, null]);
  });
});

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
