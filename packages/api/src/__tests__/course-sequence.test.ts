/**
 * The one sequence rule every reader of a course uses (docs/course-layer.md
 * §6.2 "Readers"): the stored structure, else the columns; an absent start /
 * finish completed by the event's lowest-seq start / finish; a soft-deleted
 * site drops out (the caller passes live sites only).
 */

import { describe, expect, it } from "vitest";
import { courseSequenceOf, type SequenceSite } from "../course-structure.js";

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
