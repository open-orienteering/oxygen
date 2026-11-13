/**
 * Course-map rows → sheets (docs/course-print.md §4.6, §5; course-layout.md
 * §6, §8): the class, variant and all-variations rows, the shared window of
 * a root's pages, a setter sheet's group, and `sheetForMapRow` as
 * `resolveSheet` over `sheetInputForMapRow`. The integration tests
 * (`setter-maps`, `variant-pages`, `course-crossings`) cover the rows as the
 * database gives them; these pin the pure rules.
 */

import { describe, expect, it } from "vitest";
import { defaultMapAppearance } from "../course-maps/schema.js";
import { resolveSheet } from "../course-maps/resolve-sheet.js";
import {
  type MapRowContext,
  type PrintMapRow,
  allVariationsRow,
  allVariationsSuffix,
  rowForClass,
  rowForVariant,
  setterControlIds,
  sharedWindowCentre,
  sheetForMapRow,
  sheetInputForMapRow,
} from "../course-maps/sheet-rows.js";

const template = (printScale: number) => ({
  paper: "A4",
  orientation: "portrait",
  paperWidthMm: null,
  paperHeightMm: null,
  printScale,
  settings: { printMarginMm: 3, mapFrame: { x: 8, y: 8, width: 194, height: 281 }, description: { visible: true, x: 150, y: 12, cellSizeMm: 6 }, appearance: defaultMapAppearance },
  objects: [],
});

const S = { id: "S1", seq: 1, codes: "", name: "Start 1", status: "start", kind: "start", xpos: -30, ypos: 0 };
const F = { id: "F1", seq: 2, codes: "", name: "Mål 1", status: "finish", kind: "finish", xpos: 30, ypos: 0 };
const A = { id: "A", seq: 3, codes: "31", name: "", status: "ok", kind: "control", xpos: -10, ypos: 10 };
const B = { id: "B", seq: 4, codes: "32", name: "", status: "ok", kind: "control", xpos: 10, ypos: -10 };
const C = { id: "C", seq: 5, codes: "33", name: "", status: "ok", kind: "control", xpos: 40, ypos: 40 };

const ctx: MapRowContext = {
  event: { name: "Test", date: new Date("2026-10-24T00:00:00Z") },
  allControls: [S, F, A, B, C],
  mapInfo: { scale: 10000, meridianTiltDeg: 0 },
};

const courseOf = (structure: unknown = null) => ({
  id: "course-1",
  name: "Blue",
  lengthM: 2300,
  climbM: 45,
  orderMode: "ordered" as const,
  structure,
  startName: "Start 1",
  finishControlId: "F1",
  firstAsStart: false,
  lastAsFinish: false,
  descriptionInstructions: null,
  classes: [{ name: "H21" }, { name: "D21" }],
  courseControls: [{ control: A }, { control: B }],
});

const row = (over: Partial<PrintMapRow> = {}): PrintMapRow => ({
  name: "Blue map",
  kind: "course",
  overrides: {},
  objects: [],
  windowCenter: null,
  template: template(10000),
  course: courseOf(),
  ...over,
});

/** A root with one group: S → (A | B) → F. */
const grouped = {
  version: 1,
  id: "course-1",
  orderMode: "ordered",
  items: [
    { siteId: "S1" },
    { kind: "variation", id: "g", alternatives: [{ label: "A", items: [{ siteId: "A" }] }, { label: "B", items: [{ siteId: "B" }] }] },
    { siteId: "F1" },
  ],
};

describe("rowForClass (course-layout.md §6)", () => {
  it("a course sheet printed for a class takes the class's template and scale; the header names that class only", () => {
    const own = template(7500);
    const out = rowForClass(row({ overrides: { printScale: 15000 } }), { name: "D21", printScale: 5000, sheetTemplate: own }, false);
    expect(out.template).toBe(own);
    expect(out.overrides).toEqual({ printScale: 5000 });
    expect(out.course?.classes).toEqual([{ name: "D21" }]);
  });

  it("a class template without a class scale drops the sheet's scale override; a class sheet keeps its own", () => {
    const own = template(7500);
    expect(rowForClass(row({ overrides: { printScale: 15000 } }), { name: "D21", printScale: null, sheetTemplate: own }, false).overrides).toEqual({});
    const classSheet = rowForClass(row({ overrides: { printScale: 15000 } }), { name: "D21", printScale: 5000, sheetTemplate: own }, true);
    expect(classSheet.overrides).toEqual({ printScale: 15000 });
    expect(classSheet.template).toEqual(template(10000));
  });
});

describe("rowForVariant and allVariationsRow (course-print.md §4.6)", () => {
  it("draws the child's course but keeps the root's id and classes", () => {
    const child = { ...courseOf(), name: "Blue AB", lengthM: 2500, variantKey: "AB", courseControls: [{ control: B }] };
    const out = rowForVariant(row({ course: courseOf(grouped) }), child);
    expect(out.variantKey).toBe("AB");
    expect(out.rootStructure).toEqual(grouped);
    expect(out.course).toMatchObject({ id: "course-1", name: "Blue AB", lengthM: 2500, classes: [{ name: "H21" }, { name: "D21" }] });
  });

  it("names the all-variations page by its keys, cut after five", () => {
    expect(allVariationsSuffix(["AB", "BA"])).toBe("AB/BA");
    expect(allVariationsSuffix(["A", "B", "C", "D", "E", "F"])).toBe("A/B/C/D/E/…");
    expect(allVariationsRow(row(), ["AB", "BA"]).course?.name).toBe("Blue AB/BA");
  });
});

describe("sharedWindowCentre (course-print.md §4.6)", () => {
  it("is null without groups", () => {
    expect(sharedWindowCentre(null, { start: S, finish: F }, ctx.allControls)).toBeNull();
  });

  it("centres a root's pages on every alternative and the ends", () => {
    expect(sharedWindowCentre(grouped, { start: S, finish: F }, ctx.allControls)).toEqual({ x: 0, y: 0 });
  });
});

describe("sheetInputForMapRow / sheetForMapRow", () => {
  it("resolves the course's ends by the sequence rule and is resolveSheet over the input", () => {
    const input = sheetInputForMapRow(row(), ctx);
    expect(input.course?.start?.id).toBe("S1");
    expect(input.course?.finish?.id).toBe("F1");
    expect(input.course?.controls.map((c) => c.id)).toEqual(["A", "B"]);
    expect(sheetForMapRow(row(), ctx)).toEqual(resolveSheet(input).sheet);
  });

  it("a setter sheet lists its group's sites only, with no course", () => {
    expect(setterControlIds({ setter: 1, controlIds: ["A", "C"] })).toEqual(new Set(["A", "C"]));
    expect(setterControlIds("nonsense")).toEqual(new Set());
    const input = sheetInputForMapRow(row({ kind: "setter", props: { setter: 1, controlIds: ["A", "C"] }, course: null }), ctx);
    expect(input.course).toBeNull();
    expect(input.allControls?.map((c) => c.id)).toEqual(["A", "C"]);
  });

  it("refuses a row without a template", () => {
    expect(() => sheetInputForMapRow(row({ template: null }), ctx)).toThrow(/no template/);
  });
});
