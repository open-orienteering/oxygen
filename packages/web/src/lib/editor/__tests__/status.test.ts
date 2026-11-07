import { describe, expect, it } from "vitest";
import { checksBadge, saveIndicator, statusRows, type StatusInput } from "../status";

/** A stand-in `t` that shows the key and its options, so the rows' wording is checked by key. */
const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key);

const course: StatusInput = { controls: 12, lengthM: 4321, climbM: 85, scale: 10000, sheetKey: null, snapping: false, checks: 2 };

describe("the course-info popover's rows (docs/course-editor.md §2)", () => {
  it("a course: controls, length, climb, scale, checks — in that order, with numeric data", () => {
    const rows = statusRows(course, t);
    expect(rows.map((r) => r.id)).toEqual(["controls", "length", "climb", "scale", "checks"]);
    expect(rows[0]).toEqual({ id: "controls", text: `statusControls:{"count":12}`, data: { count: "12" } });
    expect(rows[1]).toMatchObject({ text: `statusLength:{"km":"4.3"}`, data: { m: "4321" } });
    expect(rows[2]).toMatchObject({ text: `statusClimb:{"m":85}`, data: { m: "85" } });
    expect(rows[3]).toMatchObject({ id: "scale", data: { scale: "10000" } });
    expect(rows[4]).toMatchObject({ text: `statusChecks:{"count":2}`, data: { count: "2" } });
  });

  it("no course: no controls, length or climb; the scale stays", () => {
    const rows = statusRows({ ...course, controls: null, lengthM: null, climbM: null, checks: 0 }, t);
    expect(rows.map((r) => r.id)).toEqual(["scale"]);
  });

  it("a shown sheet's key replaces the map scale (docs/course-layout.md §6)", () => {
    const rows = statusRows({ ...course, sheetKey: "1:15000 A4 portrait" }, t);
    expect(rows.map((r) => r.id)).toEqual(["controls", "length", "climb", "sheet", "checks"]);
    expect(rows.find((r) => r.id === "sheet")).toMatchObject({ text: "1:15000 A4 portrait", data: { key: "1:15000 A4 portrait" } });
  });

  it("snapping on adds its row; a zero climb and zero checks add none", () => {
    const rows = statusRows({ ...course, climbM: 0, checks: 0, snapping: true }, t);
    expect(rows.map((r) => r.id)).toEqual(["controls", "length", "scale", "snapping"]);
  });

  it("the button's badge is the check count, absent at zero (§8)", () => {
    expect(checksBadge(3)).toBe(3);
    expect(checksBadge(0)).toBeNull();
    expect(checksBadge(null)).toBeNull();
  });
});

describe("the top bar's save indicator (§3: an error or a conflict never hides)", () => {
  it("saved and saving are the dot alone; error and conflict always show their words", () => {
    expect(saveIndicator("saved")).toEqual({ tone: "ok", alwaysText: false, key: "statusSaved" });
    expect(saveIndicator("saving")).toEqual({ tone: "busy", alwaysText: false, key: "statusSaving" });
    expect(saveIndicator("error")).toEqual({ tone: "alert", alwaysText: true, key: "statusError" });
    expect(saveIndicator("conflict")).toEqual({ tone: "alert", alwaysText: true, key: "statusConflict" });
  });
});
