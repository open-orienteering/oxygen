import { describe, expect, it } from "vitest";
import { checksBadge, courseInfoRows, saveIndicator, statusRows, type StatusInput } from "../status";

/** A stand-in `t` that shows the key and its options, so the rows' wording is checked by key. */
const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key);

const course: StatusInput = { controls: 12, lengthM: 4321, climbM: 85, scale: 10000, sheetKey: null, snapping: false, checks: 2 };

describe("the course-info rows (docs/course-editor.md §2, §10: the phone's peek line shows them all)", () => {
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

describe("the climb row is one number (docs/course-elevation.md §4.4)", () => {
  const line = { state: "ready" as const, climbM: 135, descentM: 120, sharePct: 3.1, basis: "contours" as const, partial: false, approx: false, attribution: null, intervalConfirmed: true, assumedIntervalM: null };
  const ids = ["controls", "length", "climb", "scale", "checks"];

  it("a typed climb is the course's: the computed one is not shown", () => {
    const rows = statusRows({ ...course, climbManual: true, line }, t);
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(rows[2]).toEqual({ id: "climb", text: `statusClimb:{"m":85}`, data: { m: "85", source: "manual" } });
  });

  it("else the computed climb with its share of the length; the phone's line has the metres alone", () => {
    const rows = statusRows({ ...course, line }, t);
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(rows[2]).toEqual({ id: "climb", text: `statusClimbShare:{"m":"135","share":"3.1"}`, short: `statusClimb:{"m":"135"}`, data: { m: "135", source: "computed", state: "ready", share: "3.1", basis: "contours", partial: "false", approx: "false", "interval-confirmed": "true" } });
    expect(statusRows({ ...course, climbM: null, line }, t)[2]).toMatchObject({ data: { m: "135", source: "computed" } });
  });

  it("approximate values carry ≈ in the words, not in the data", () => {
    const rows = statusRows({ ...course, climbM: null, line: { ...line, approx: true, partial: true } }, t);
    expect(rows[2]).toMatchObject({ text: `statusClimbShare:{"m":"≈ 135","share":"3.1"}`, data: { m: "135", approx: "true", partial: "true" } });
  });

  it("an unconfirmed contour interval is an estimate: ≈ in the words, the attribute says why", () => {
    const rows = statusRows({ ...course, climbM: null, line: { ...line, approx: true, intervalConfirmed: false, assumedIntervalM: 5 } }, t);
    expect(rows[2]).toMatchObject({ text: `statusClimbShare:{"m":"≈ 135","share":"3.1"}`, data: { m: "135", source: "computed", "interval-confirmed": "false" } });
  });

  it("while the field loads or cannot be read: the stored climb, else one row of words left off the phone's line", () => {
    expect(statusRows({ ...course, line: { state: "loading" } }, t)[2]).toEqual({ id: "climb", text: `statusClimb:{"m":85}`, data: { m: "85", source: "stored", state: "loading" } });
    expect(statusRows({ ...course, climbM: null, line: { state: "loading" } }, t)[2]).toEqual({ id: "climb", text: "statusClimbLoading", short: "", data: { state: "loading" } });
    expect(statusRows({ ...course, climbM: 0, line: { state: "unavailable", kind: "offline" } }, t)[2]).toEqual({ id: "climb", text: "statusClimbUnavailable", short: "", data: { state: "unavailable", kind: "offline" } });
  });

  it("without a field: the stored climb, or no row", () => {
    expect(statusRows({ ...course, line: null }, t)[2]).toMatchObject({ id: "climb", data: { m: "85", source: "stored" } });
    expect(statusRows({ ...course, climbM: null, line: null }, t).map((r) => r.id)).toEqual(["controls", "length", "scale", "checks"]);
  });
});


describe("the desktop popover leaves the map scale to the map-info dialog (P6, docs/course-editor.md §2)", () => {
  it("a course: no scale row, the rest as the peek line's", () => {
    expect(courseInfoRows(course, t).map((r) => r.id)).toEqual(["controls", "length", "climb", "checks"]);
  });

  it("no course and no sheet: no rows (the popover says No course)", () => {
    expect(courseInfoRows({ ...course, controls: null, lengthM: null, climbM: null, checks: 0 }, t)).toEqual([]);
  });

  it("a shown sheet's key stays (docs/course-layout.md §6)", () => {
    expect(courseInfoRows({ ...course, sheetKey: "1:15000 A4 portrait" }, t).map((r) => r.id)).toEqual(["controls", "length", "climb", "sheet", "checks"]);
  });
});

describe("the top bar's save indicator (§3: an error or a conflict never hides)", () => {
  it("saved and saving are the dot alone; error and conflict always show their words", () => {
    expect(saveIndicator("saved")).toEqual({ tone: "ok", alwaysText: false, key: "statusSaved" });
    expect(saveIndicator("saving")).toEqual({ tone: "busy", alwaysText: false, key: "statusSaving" });
    expect(saveIndicator("error")).toEqual({ tone: "alert", alwaysText: true, key: "statusError" });
    expect(saveIndicator("conflict")).toEqual({ tone: "alert", alwaysText: true, key: "statusConflict" });
    // D9c: Field mode's writes wait on the device — words shown, never "Saved".
    expect(saveIndicator("queued")).toEqual({ tone: "wait", alwaysText: true, key: "statusQueued" });
  });
});
