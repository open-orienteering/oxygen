/**
 * `resolveSheet` (docs/course-print.md §5): the resolved layout as the
 * composer's page input — paper, frame, window, the course layer's
 * structure and sites, authored geometry only for `ocd` courses, label
 * offsets, extras, all-controls, the description block.
 */

import { describe, expect, it } from "vitest";
import { defaultMapAppearance } from "@oxygen/shared";
import { resolveSheet, type ResolveSheetInput } from "../course-maps/resolve-sheet.js";

const template = {
  paper: "A4",
  orientation: "portrait",
  paperWidthMm: null,
  paperHeightMm: null,
  printScale: 10000,
  settings: {
    printMarginMm: 3,
    mapFrame: { x: 8, y: 8, width: 194, height: 281 },
    description: { visible: true, x: 150, y: 12, cellSizeMm: 6 },
    appearance: { ...defaultMapAppearance, circleRadiusMm: defaultMapAppearance.circleRadiusMm * 1.2 },
  },
  objects: [{ id: "t", anchor: "page", kind: "text", x: 10, y: 280, text: "{course}", fontSizeMm: 4, color: "#000000" }],
};

const geometry = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", geometry: { type: "Point", coordinates: [-30, 0] }, properties: { id: "S1", code: "S", symbolType: "start" } },
    { type: "Feature", geometry: { type: "Point", coordinates: [-20, 0] }, properties: { id: "c31", code: "31", symbolType: "control", cuts: [{ start: 10, end: 40 }] } },
    { type: "Feature", geometry: { type: "Point", coordinates: [30, 0] }, properties: { id: "F1", code: "F", symbolType: "finish" } },
    { type: "Feature", geometry: { type: "LineString", coordinates: [[-30, 0], [-20, 0]] }, properties: { symbolType: "leg", gaps: [{ from: 0.4, to: 0.6 }] } },
    { type: "Feature", geometry: { type: "LineString", coordinates: [[-20, 0], [0, 5], [20, 0]] }, properties: { symbolType: "leg", preclipped: true } },
    { type: "Feature", geometry: { type: "LineString", coordinates: [[20, 0], [30, 0]] }, properties: { symbolType: "leg" } },
    { type: "Feature", geometry: { type: "LineString", coordinates: [[20, 0], [25, -8]] }, properties: { symbolType: "marked_route" } },
  ],
};

const controls = [
  { id: "c31", codes: "31", xpos: -20, ypos: 0, description: { d: "2.004" }, labelOffset: { dx: 0, dy: 6 } },
  { id: "c32", codes: "32", xpos: 20, ypos: 0 },
];

const base = (over: Partial<ResolveSheetInput> = {}): ResolveSheetInput => ({
  kind: "course",
  template,
  course: { name: "Blue", lengthM: 2300, climbM: 45, geometry, classes: [{ name: "H21" }], controls },
  mapScale: 15000,
  meridianTiltDeg: 2,
  event: { name: "Test", date: new Date("2026-10-24T00:00:00Z") },
  mapName: "Blue map",
  ...over,
});

describe("resolveSheet", () => {
  it("paper, frame and window from the layout; the window rotation is −tilt", () => {
    const { sheet, layout } = resolveSheet(base());
    expect(sheet.paper).toEqual({ widthMm: 210, heightMm: 297 });
    expect(sheet.frame).toEqual(template.settings.mapFrame);
    expect(sheet.window).toEqual(layout.window);
    expect(sheet.window.rotationDeg).toBe(-2);
    expect(sheet.course.viewOptions).toEqual({ allControls: false, labelMode: "sequence", overprintScale: 1.5 });
    expect(sheet.course.appearance.circle).toBeCloseTo(1.2, 9);
    expect(sheet.label).toBe("Blue");
    expect(sheet.textValues.course).toBe("Blue");
    expect(sheet.objects).toHaveLength(1);
  });

  it("structure: start → controls → finish with roles, sites unique, label offsets from the stored positions", () => {
    const { sheet } = resolveSheet(base());
    const s = sheet.course.structure;
    if (!s || Array.isArray(s)) throw new Error("one structure");
    const one = s as Exclude<typeof s, readonly unknown[]>;
    expect(one.items.map((i) => [i.siteId, i.role])).toEqual([["S1", "start"], ["c31", "control"], ["c32", "control"], ["F1", "finish"]]);
    expect(sheet.course.sites.map((x) => x.id)).toEqual(["S1", "c31", "c32", "F1"]);
    expect(one.labelOffsets).toEqual({ c31: { dx: 0, dy: 6 } });
    expect(one.extras).toEqual([{ kind: "marked_route", points: [{ x: 20, y: 0 }, { x: 25, y: -8 }] }]);
  });

  it("editor courses: no authored geometry — the course layer derives legs and cuts", () => {
    const one = resolveSheet(base({ geometrySource: "editor" })).sheet.course.structure as { items: { leg?: unknown; circleGaps?: unknown }[] };
    expect(one.items.every((i) => i.leg === undefined && i.circleGaps === undefined)).toBe(true);
  });

  it("ocd courses keep the file's legs, gaps, pre-clipped pieces and circle gaps", () => {
    const one = resolveSheet(base({ geometrySource: "ocd" })).sheet.course.structure as { items: { leg?: unknown; circleGaps?: unknown }[] };
    expect(one.items[0].leg).toBeUndefined();
    expect(one.items[1]).toMatchObject({ circleGaps: [{ start: 10, end: 40 }], leg: { path: [{ x: -30, y: 0 }, { x: -20, y: 0 }], gaps: [{ from: 0.4, to: 0.6 }] } });
    expect(one.items[2].leg).toEqual({ pieces: [[{ x: -20, y: 0 }, { x: 0, y: 5 }, { x: 20, y: 0 }]] });
    expect(one.items[3].leg).toEqual({ path: [{ x: 20, y: 0 }, { x: 30, y: 0 }] });
  });

  it("description block from the template position with the IOF header; hidden → null", () => {
    const { sheet } = resolveSheet(base());
    expect(sheet.description).toMatchObject({ x: 150, y: 12, cellSizeMm: 6, title: "Blue", header: { eventName: "Test", courseName: "Blue" } });
    expect(sheet.description!.rows.map((r) => r.kind ?? "control")).toEqual(["start", "control", "control", "finish"]);
    const hidden = resolveSheet(base({ template: { ...template, settings: { ...template.settings, description: { ...template.settings.description, visible: false } } } }));
    expect(hidden.sheet.description).toBeNull();
  });

  it("all-controls: no structure, every placed control a site, code labels", () => {
    const { sheet } = resolveSheet(
      base({
        kind: "all_controls",
        course: null,
        allControls: [
          { id: "a", codes: "41", xpos: 1, ypos: 2 },
          { id: "b", codes: "42", xpos: 3, ypos: 4 },
          { id: "z", codes: "43", xpos: 0, ypos: 0 },
          { id: "s", codes: "", status: "start", xpos: 5, ypos: 5 },
        ],
      }),
    );
    expect(sheet.course.structure).toBeNull();
    expect(sheet.course.viewOptions).toMatchObject({ allControls: true, labelMode: "code" });
    expect(sheet.course.sites.map((s) => [s.id, s.kind])).toEqual([["s", "start"], ["a", "control"], ["b", "control"]]);
    expect(sheet.label).toBe("Blue map");
  });

  it("free order: ordered flag carried, no legs", () => {
    const { sheet } = resolveSheet(base({ course: { ...base().course!, orderMode: "free_order" } }));
    expect((sheet.course.structure as { orderMode: string }).orderMode).toBe("free_order");
    expect(sheet.course.viewOptions.labelMode).toBe("code");
  });
});
