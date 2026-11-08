import { describe, expect, it } from "vitest";
import { allSetterSheets, nextSetterSheet, setterRowInputs, setterScopeOf, setterSheetsOf, type SetterSheetRow } from "../setter-maps";
import { fieldRows } from "../field";

const row = (seq: number, courseId: number | null, index: number | null, kind = "setter"): SetterSheetRow => ({
  seq, name: `S${seq}`, kind, courseId, sortOrder: 0, setter: index === null ? null : { index, controls: [] },
});

describe("setter maps in the editor (course-layout.md §8)", () => {
  it("the scope: the event in view All or without a course, else the course", () => {
    expect(setterScopeOf("all", { id: 3 })).toBeNull();
    expect(setterScopeOf("course", null)).toBeNull();
    expect(setterScopeOf("course", { id: 3 })).toBe(3);
    expect(setterScopeOf("class", { id: 3 })).toBe(3);
  });

  it("lists a scope's setter sheets by setter number; other kinds and scopes are left out", () => {
    const rows = [row(9, null, 2), row(4, null, 1), row(5, 3, 1), row(6, null, null, "all_controls"), row(7, 3, 1, "course")];
    expect(setterSheetsOf(rows, null).map((r) => r.seq)).toEqual([4, 9]);
    expect(setterSheetsOf(rows, 3).map((r) => r.seq)).toEqual([5]);
    expect(allSetterSheets(rows).map((r) => r.seq)).toEqual([4, 9, 5]);
  });

  it("the next setter wraps from the last to the first; none with one sheet", () => {
    const sheets = [row(4, null, 1), row(9, null, 2), row(11, null, 3)];
    expect(nextSetterSheet(sheets, 4)?.seq).toBe(9);
    expect(nextSetterSheet(sheets, 11)?.seq).toBe(4);
    expect(nextSetterSheet(sheets, 99)).toBeNull();
    expect(nextSetterSheet([row(4, null, 1)], 4)).toBeNull();
  });

  it("a setter's Field rows: the sheet's order, ends as such, other kinds as controls, unknown ones left out", () => {
    const info = new Map([
      [31, { code: "31", kind: "control", pt: { x: 0, y: 0.1 } }],
      [1, { code: "S", kind: "start", pt: { x: 0, y: 0 } }],
      [9001, { code: "", kind: "map_issue", pt: { x: 10, y: 0 } }],
    ]);
    const inputs = setterRowInputs([31, 9001, 77, 1], info);
    expect(inputs.map((r) => [r.id, r.kind])).toEqual([[31, "control"], [9001, "control"], [1, "start"]]);
    // Through the course list's rule: distance and bearing from the fix, the checked set.
    const rows = fieldRows(inputs, { x: 0, y: 0 }, 10000, new Set([9001]));
    expect(rows.map((r) => [r.distanceM, r.bearingDeg, r.checked])).toEqual([[1, 0, false], [100, 90, true], [0, 0, false]]);
  });
});
