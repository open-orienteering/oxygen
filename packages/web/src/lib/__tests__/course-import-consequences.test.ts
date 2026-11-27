import { describe, expect, it } from "vitest";
import { classMappedTwice, consequenceLines, type ModeConsequences } from "../course-import-consequences";

const empty: ModeConsequences = {
  coursesAdded: [], coursesUpdated: [], coursesRestored: [], coursesRemoved: [], coursesSkippedForked: [],
  coursesFlattened: [], coursesLengthChanged: [], coursesKeepingLength: [], coursesLengthDerived: [],
  controlsAdded: 0, controlsUpdated: 0, controlsRestored: 0, controlsRemoved: [], controlsKeepingSettings: [],
  controlsMovedFar: [], runnersLosingVariant: 0, runnersOnRemovedCourse: 0, classesUnassigned: [],
};

describe("consequenceLines", () => {
  it("shows only non-zero lines, removals first", () => {
    const lines = consequenceLines({ ...empty, coursesAdded: ["N"], coursesRemoved: ["B", "C"], controlsAdded: 3 }, {});
    expect(lines.map((l) => [l.key, l.tone, l.count])).toEqual([
      ["coursesRemoved", "remove", 2],
      ["coursesAdded", "info", 1],
      ["controlsAdded", "info", 3],
    ]);
    expect(lines[0].names).toEqual(["B", "C"]);
  });

  it("does not count a class the mapping puts back on a course as unassigned", () => {
    const c = { ...empty, classesUnassigned: [{ seq: 1, name: "H21", courseName: "B" }, { seq: 2, name: "D21", courseName: "B" }] };
    const [line] = consequenceLines(c, { A: [1, 0] });
    expect(line).toEqual({ key: "classesUnassigned", tone: "remove", count: 1, names: ["D21 (B)"] });
  });

  it("counts restored rows as updated", () => {
    const lines = consequenceLines({ ...empty, coursesUpdated: ["A"], coursesRestored: ["R"], controlsUpdated: 1, controlsRestored: 2 }, {});
    expect(lines.map((l) => [l.key, l.count])).toEqual([["coursesUpdated", 2], ["controlsUpdated", 3]]);
  });
});

describe("classMappedTwice", () => {
  it("finds a class under two course names, ignoring skips and repeats on one course", () => {
    expect(classMappedTwice({ A: [1, 1, 0], B: [2, 0] })).toEqual([]);
    expect(classMappedTwice({ A: [1], B: [1, 2], C: [0] })).toEqual([{ seq: 1, courseNames: ["A", "B"] }]);
  });
});
