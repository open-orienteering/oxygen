/**
 * The course import's plan (course-layer.md §6.4 "Import semantics",
 * review package 17, decision D3): refusals, matching and the per-mode
 * consequence list, without a database.
 */
import { describe, expect, it } from "vitest";
import {
  classMappingConflict,
  classPreselection,
  fileBlockers,
  heldCodeBlockers,
  planCourseImport,
  type ImportState,
  type StateControl,
  type StateCourse,
} from "../course-import-plan.js";
import type { ParsedControl, ParsedCourse } from "../iof-course-parser.js";

const ctl = (id: string, type: ParsedControl["type"] = "Control", x = 0, y = 0): ParsedControl => ({ id, type, lat: 0, lng: 0, mapX: x, mapY: y });
const crs = (name: string, codes: string[], extra: Partial<ParsedCourse> = {}): ParsedCourse => ({
  name,
  length: 0,
  climb: 0,
  controls: [
    { controlId: "S1", type: "Start", legLength: 0 },
    ...codes.map((c) => ({ controlId: c, type: "Control" as const, legLength: 0 })),
    { controlId: "F1", type: "Finish", legLength: 0 },
  ],
  ...extra,
});
let n = 0;
const row = (extra: Partial<StateControl>): StateControl => ({
  id: `c${++n}`, seq: n, name: "", codes: "", kind: "control", status: "ok", removed: false, xpos: 0, ypos: 0, ...extra,
});
const course = (extra: Partial<StateCourse>): StateCourse => ({
  id: `k${++n}`, name: "", removed: false, lengthM: 0, forked: false, variantIds: [], ...extra,
});
const state = (s: Partial<ImportState>): ImportState => ({ controls: [], courses: [], classes: [], runnersByCourse: new Map(), ...s });

describe("fileBlockers", () => {
  it("refuses a file with no courses and no controls in both modes", () => {
    expect(fileBlockers({ controls: [], courses: [] }, { replaceAll: false })).toEqual([{ code: "no_courses", ids: [] }]);
    expect(fileBlockers({ controls: [], courses: [] }, { replaceAll: true })).toEqual([{ code: "no_courses", ids: [] }]);
  });

  it("refuses controls without courses under Replace all only", () => {
    const parsed = { controls: [ctl("31")], courses: [] };
    expect(fileBlockers(parsed, { replaceAll: true }).map((b) => b.code)).toEqual(["no_courses"]);
    expect(fileBlockers(parsed, { replaceAll: false })).toEqual([]);
  });

  it("names duplicate controls, starts, crossing points and courses", () => {
    const parsed = {
      controls: [ctl("31"), ctl(" 31"), ctl("S1", "Start"), ctl("STA1", "Start"), ctl("P1", "CrossingPoint"), ctl("p1", "CrossingPoint")],
      courses: [crs("A", ["31"]), crs("a", ["31"])],
    };
    expect(fileBlockers(parsed, { replaceAll: false })).toEqual([
      { code: "duplicate_control", ids: ["31", " 31"] },
      { code: "duplicate_start_finish", ids: ["S1", "STA1"] },
      { code: "duplicate_crossing", ids: ["P1", "p1"] },
      { code: "duplicate_course", ids: ["A", "a"] },
    ]);
  });
});

describe("heldCodeBlockers", () => {
  it("refuses a file control whose code a live start holds (F32)", () => {
    const s = state({ controls: [row({ name: "Start 1", kind: "start", status: "start", codes: "3" })] });
    expect(heldCodeBlockers({ controls: [ctl("3"), ctl("31")] }, s)).toEqual([{ code: "held_code", ids: ["3"], holders: ["Start 1"] }]);
  });
});

describe("classMappingConflict", () => {
  it("finds a class under two course names, ignoring skips", () => {
    expect(classMappingConflict({ A: [1, 0], B: [2, 0] })).toBeNull();
    expect(classMappingConflict({ A: [1], B: [1] })).toEqual({ classSeq: 1, courseNames: ["A", "B"] });
    expect(classMappingConflict(undefined)).toBeNull();
  });
});

describe("planCourseImport: controls", () => {
  it("matches by code, a live row before a removed one (CRS-021)", () => {
    const removed = row({ codes: "31", removed: true });
    const live = row({ codes: "31" });
    const plan = planCourseImport({ controls: [ctl("31")], courses: [], mapScale: 10000 }, state({ controls: [live, removed] }), { replaceAll: false, comparePositions: false });
    expect(plan.controlMatch.get("31")).toBe(live);
    expect(plan.consequences.controlsUpdated).toBe(1);
  });

  it("never matches a control code to a start's unit code or a crossing point's name", () => {
    const start = row({ name: "Start 1", kind: "start", status: "start", codes: "3" });
    const crossing = row({ name: "31", kind: "crossing_point" });
    const s = state({ controls: [start, crossing] });
    const plan = planCourseImport({ controls: [ctl("3"), ctl("31"), ctl("STA1", "Start")], courses: [], mapScale: 10000 }, s, { replaceAll: false, comparePositions: false });
    expect(plan.controlMatch.get("3")).toBeUndefined();
    expect(plan.controlMatch.get("31")).toBeUndefined();
    expect(plan.controlMatch.get("STA1")).toBe(start);
  });

  it("lists matched controls that keep a non-OK status or extra codes", () => {
    const s = state({ controls: [row({ codes: "31;131", status: "bad" }), row({ codes: "32" })] });
    const plan = planCourseImport({ controls: [ctl("31"), ctl("32")], courses: [], mapScale: 10000 }, s, { replaceAll: false, comparePositions: false });
    expect(plan.consequences.controlsKeepingSettings).toEqual([{ code: "31", status: "bad", codes: "31;131" }]);
  });

  it("warns, without refusing, when a control moves more than 50 m", () => {
    const s = state({ controls: [row({ codes: "31", xpos: 10, ypos: 10 }), row({ codes: "32", xpos: 10, ypos: 10 })] });
    // 1:10 000: 10 mm on paper is 100 m.
    const parsed = { controls: [ctl("31", "Control", 20, 10), ctl("32", "Control", 12, 10)], courses: [], mapScale: 10000 };
    expect(planCourseImport(parsed, s, { replaceAll: false, comparePositions: true }).consequences.controlsMovedFar).toEqual([{ code: "31", metres: 100 }]);
    expect(planCourseImport(parsed, s, { replaceAll: false, comparePositions: false }).consequences.controlsMovedFar).toEqual([]);
  });
});

describe("planCourseImport: modes", () => {
  const a = course({ name: "A", lengthM: 4000 });
  const b = course({ name: "B" });
  const forked = course({ name: "F", forked: true, variantIds: ["v1", "v2"] });
  const c31 = row({ codes: "31" });
  const c99 = row({ codes: "99" });
  const s = state({
    controls: [c31, c99],
    courses: [a, b, forked],
    classes: [
      { id: "cl1", seq: 1, name: "H21", courseId: a.id },
      { id: "cl2", seq: 2, name: "D21", courseId: b.id },
    ],
    runnersByCourse: new Map([["v1", 3], [b.id, 2]]),
  });
  const parsed = { controls: [ctl("31"), ctl("S1", "Start"), ctl("F1", "Finish")], courses: [crs("A", ["31"]), crs("F", ["31"]), crs("N", ["31"])], mapScale: 10000 };

  it("Merge keeps what the file does not carry and skips a local fork", () => {
    const plan = planCourseImport(parsed, s, { replaceAll: false, comparePositions: false });
    expect(plan.removeCourseIds).toEqual([]);
    expect(plan.removeControlIds).toEqual([]);
    expect(plan.unassignClassIds).toEqual([]);
    expect([...plan.skippedCourseNames]).toEqual(["F"]);
    expect(plan.consequences.coursesSkippedForked).toEqual(["F"]);
    expect(plan.consequences.coursesUpdated).toEqual(["A"]);
    expect(plan.consequences.coursesAdded).toEqual(["N"]);
    expect(plan.consequences.runnersLosingVariant).toBe(0);
  });

  it("Replace all removes the rest, flattens the fork and unassigns only classes on removed courses", () => {
    const plan = planCourseImport(parsed, s, { replaceAll: true, comparePositions: false });
    expect(plan.removeCourseIds).toEqual([b.id]);
    expect(plan.removeControlIds).toEqual([c99.id]);
    expect(plan.unassignClassIds).toEqual(["cl2"]);
    expect(plan.consequences.coursesRemoved).toEqual(["B"]);
    expect(plan.consequences.controlsRemoved).toEqual(["99"]);
    expect(plan.consequences.coursesFlattened).toEqual([{ name: "F", variants: 2, runners: 3 }]);
    expect(plan.consequences.runnersLosingVariant).toBe(3);
    expect(plan.consequences.runnersOnRemovedCourse).toBe(2);
    expect(plan.consequences.classesUnassigned).toEqual([{ seq: 2, name: "D21", courseName: "B" }]);
  });

  it("Merge skips a file variant of a local forked root (an Oxygen export's family)", () => {
    const p = { ...parsed, courses: [crs("F AB", ["31"], { family: "F" })] };
    expect([...planCourseImport(p, s, { replaceAll: false, comparePositions: false }).skippedCourseNames]).toEqual(["F AB"]);
    expect(planCourseImport(p, s, { replaceAll: true, comparePositions: false }).consequences.coursesAdded).toEqual(["F AB"]);
  });

  it("reports the length rule: kept when the file states none, derived for a new course, changed when it differs", () => {
    const keep = planCourseImport(parsed, s, { replaceAll: false, comparePositions: false }).consequences;
    expect(keep.coursesKeepingLength).toEqual(["A"]);
    expect(keep.coursesLengthDerived).toEqual(["N"]);
    const p = { ...parsed, courses: [crs("A", ["31"], { length: 4500 })] };
    expect(planCourseImport(p, s, { replaceAll: false, comparePositions: false }).consequences.coursesLengthChanged).toEqual([{ name: "A", fromM: 4000, toM: 4500 }]);
  });
});

describe("classPreselection", () => {
  it("never pre-selects a substring match", () => {
    const { preselect } = classPreselection(
      [
        { courseName: "D1", className: "D1", dbClassSeq: 10, matchType: "substring" },
        { courseName: "H21", className: "H21", dbClassSeq: 2, matchType: "exact" },
      ],
      () => undefined,
    );
    expect(preselect).toEqual([false, true]);
  });

  it("leaves a class on several courses unassigned, with the fork-variant message for one family", () => {
    const rows = [
      { courseName: "A AB", className: "H21", dbClassSeq: 1, matchType: "exact" },
      { courseName: "A BA", className: "H21", dbClassSeq: 1, matchType: "exact" },
      { courseName: "B", className: "D21", dbClassSeq: 2, matchType: "exact" },
      { courseName: "C", className: "D21", dbClassSeq: 2, matchType: "exact" },
    ];
    const family = new Map([["A AB", "A"], ["A BA", "A"], ["B", "B"], ["C", "C"]]);
    const { preselect, warnings } = classPreselection(rows, (n) => family.get(n));
    expect(preselect).toEqual([false, false, false, false]);
    expect(warnings).toEqual([
      { code: "class_on_fork_variants", className: "H21", courseNames: ["A AB", "A BA"] },
      { code: "class_on_several_courses", className: "D21", courseNames: ["B", "C"] },
    ]);
  });
});
