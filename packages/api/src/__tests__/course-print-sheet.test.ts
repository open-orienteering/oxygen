/**
 * `resolveSheet` (docs/course-print.md §5): the resolved layout as the
 * composer's page input — paper, frame, window, the course layer's
 * structure and sites, the authored leg gaps of the stored structure and
 * the controls' circle gaps, label offsets, all-controls, the description block.
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
  });

  const U31 = "00000000-0000-4000-8000-000000000031";
  const U32 = "00000000-0000-4000-8000-000000000032";
  const uuidControls = [{ ...controls[0], id: U31, circleGaps: [{ start: 10, end: 40 }] }, { ...controls[1], id: U32 }];
  const stored = (items: unknown[]) => ({ version: 1, id: "00000000-0000-4000-8000-0000000000c1", orderMode: "ordered", items });

  it("no stored structure: no authored legs or gaps — the course layer derives them (whatever geometry_source was)", () => {
    const one = resolveSheet(base()).sheet.course.structure as { items: { leg?: unknown }[] };
    expect(one.items.every((i) => i.leg === undefined)).toBe(true);
  });

  it("the stored structure's leg gaps land on the item the leg runs into, aligned past the geometry's start and finish", () => {
    const gaps = [{ from: 0.4, to: 0.6 }];
    const input = base({
      course: { ...base().course!, controls: uuidControls },
      structure: stored([{ siteId: U31 }, { siteId: U32, leg: { gaps } }]),
    });
    const one = resolveSheet(input).sheet.course.structure as { items: { siteId: string; leg?: unknown }[] };
    expect(one.items.map((i) => [i.siteId, i.leg])).toEqual([["S1", undefined], [U31, undefined], [U32, { gaps }], ["F1", undefined]]);
    // An invalid column is ignored.
    const bad = resolveSheet({ ...input, structure: { nope: true } }).sheet.course.structure as { items: { leg?: unknown }[] };
    expect(bad.items.every((i) => i.leg === undefined)).toBe(true);
  });

  it("a structure whose first site is not in the layout (an explicit start the geometry names S1) aligns on the first shared site", () => {
    const gaps = [{ from: 0.2, to: 0.3 }];
    const input = base({
      course: { ...base().course!, controls: uuidControls },
      structure: stored([{ siteId: "00000000-0000-4000-8000-0000000000aa" }, { siteId: U31 }, { siteId: U32, leg: { gaps } }]),
    });
    const one = resolveSheet(input).sheet.course.structure as { items: { siteId: string; leg?: unknown }[] };
    expect(one.items.find((i) => i.siteId === U32)!.leg).toEqual({ gaps });
  });

  it("sites carry the controls' circle gaps", () => {
    const { sheet } = resolveSheet(base({ course: { ...base().course!, controls: uuidControls } }));
    expect(sheet.course.sites.find((x) => x.id === U31)!.circleGaps).toEqual([{ start: 10, end: 40 }]);
    expect(sheet.course.sites.find((x) => x.id === U32)!.circleGaps).toBeUndefined();
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
