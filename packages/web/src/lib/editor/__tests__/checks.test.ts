import { describe, it, expect } from "vitest";
import { course, type ControlInfo } from "@oxygen/shared";
import { checkMarkers, checkSitesOf, checkStructureOf, legsLengthM, locateTarget, mergeChecks, type EditorCheck } from "../checks";
import { explicitStructure, type SiteRow } from "../sequence";

const coord = (id: number, x: number, y: number, status = 0): SiteRow => ({ id, code: String(id), status, mapX: x, mapY: y });
const row = (id: number, over: Partial<ControlInfo> = {}) => ({ id, codes: String(id), kind: "control" as const, description: { d: "1.001" }, ...over });

describe("the editor's checks input (docs/course-editor.md §8)", () => {
  it("sites: public ids as strings, punch codes, kind and description from the control list", () => {
    const sites = checkSitesOf([coord(31, 10, 0), coord(1, 0, 0, 4)], [row(31, { codes: "31;131" }), row(1, { codes: "", kind: "start", description: null })]);
    expect(sites).toEqual([
      { id: "31", code: "31", codes: [31, 131], kind: "control", x: 10, y: 0, description: { d: "1.001" } },
      { id: "1", code: "1", codes: [], kind: "start", x: 0, y: 0, description: null },
    ]);
  });

  it("structure: the explicit wire structure in the layer's form, hidden numbers kept", () => {
    const sites = [coord(1, 5, 5, 4), coord(31, 10, 0), coord(9, 20, 20, 5)];
    const wire: course.WireCourseStructure = { version: 1, id: "x", orderMode: "ordered", items: [{ siteId: 31, numberHidden: true }] };
    expect(checkStructureOf(7, explicitStructure(wire, sites))).toEqual({
      version: 1, id: "7", orderMode: "ordered", items: [{ siteId: "1" }, { siteId: "31", numberHidden: true }, { siteId: "9" }],
    });
  });

  it("runs the shared checks: two controls 20 m apart at 1:10 000", () => {
    const sites = checkSitesOf([coord(31, 10, 0), coord(32, 12, 0)], [row(31), row(32, { description: { d: "1.002" } })]);
    const found = course.courseChecks({ structure: null, sites, document: null, sheets: null, mapScale: 10000 });
    expect(found.map((c) => [c.code, c.siteIds])).toEqual([["CONTROL_TOO_CLOSE", ["31", "32"]]]);
  });
});

describe("merge, markers, length, locate", () => {
  const close: EditorCheck = { code: "CONTROL_TOO_CLOSE", siteIds: ["31", "32"], at: { x: 11, y: 0 } };
  const leg: EditorCheck = { code: "LEG_CROSSES_OOB", siteIds: ["31", "32"], leg: { from: "31", to: "32", index: 1 }, at: { x: 11.5, y: 0 } };
  const sites = new Map([["31", { x: 10, y: 0 }], ["32", { x: 12, y: 0 }], ["40", { x: 0, y: 0 }]]);

  it("adds the server's DESCRIPTION_STALE only, in the code table's order", () => {
    const merged = mergeChecks([close, leg], [
      { code: "CONTROL_TOO_CLOSE", siteIds: [31, 32], at: { x: 11, y: 0 } },
      { code: "DESCRIPTION_STALE", siteIds: [32], at: { x: 12, y: 0 }, params: { code: "32" } },
    ]);
    expect(merged.map((c) => c.code)).toEqual(["CONTROL_TOO_CLOSE", "DESCRIPTION_STALE", "LEG_CROSSES_OOB"]);
    expect(merged[1]).toEqual({ code: "DESCRIPTION_STALE", siteIds: ["32"], at: { x: 12, y: 0 }, params: { code: "32" }, server: true });
  });

  it("markers: a ring per positioned site of a site check, a cross at a leg check's point", () => {
    const m = checkMarkers([close, leg, { code: "NUMBER_UNPLACED", siteIds: ["40"], at: { x: 0, y: 0 } }], sites, 2);
    const testIds = m.filter((s) => "testId" in s && s.testId === "editor-check-marker");
    expect(testIds).toHaveLength(3);
    expect(m[0]).toMatchObject({ kind: "circle", x: 10, y: 0, rMm: 3, data: { code: "CONTROL_TOO_CLOSE", site: "31" } });
    expect(m[2]).toMatchObject({ kind: "line", data: { code: "LEG_CROSSES_OOB", x: "11.5", y: "0" } });
    expect(m).toHaveLength(4);
  });

  it("length from the layer's leg polylines", () => {
    const derivation: course.CourseDerivation = {
      sites: [],
      courses: [{ id: "A", orderMode: "ordered", sequence: [], legs: [
        { from: "1", to: "31", points: [{ x: 0, y: 0 }, { x: 3, y: 4 }], gaps: [], pieces: [] },
        { from: "31", to: "32", points: [{ x: 3, y: 4 }, { x: 3, y: 5 }, { x: 4, y: 5 }], gaps: [], pieces: [] },
      ] }],
    };
    expect(legsLengthM(derivation, 10000)).toBeCloseTo(70, 9);
    expect(legsLengthM(null, 10000)).toBeNull();
    expect(legsLengthM(derivation, null)).toBeNull();
  });

  it("locate: the first site (a leg's start) and the check's point, else the site's", () => {
    expect(locateTarget(close, sites)).toEqual({ selectId: 31, centre: { x: 11, y: 0 } });
    expect(locateTarget(leg, sites)).toEqual({ selectId: 31, centre: { x: 11.5, y: 0 } });
    expect(locateTarget({ code: "CODE_DUPLICATE", siteIds: ["40"], at: { x: 0, y: 0 } }, sites)).toEqual({ selectId: 40, centre: null });
  });
});
