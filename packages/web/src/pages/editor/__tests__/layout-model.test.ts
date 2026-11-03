import { describe, expect, it } from "vitest";
import { defaultMapAppearance } from "@oxygen/shared";
import { geometryOf, layoutRequestOf, placeObject, scopeObjects, snapshotOf, withEditable, type EditorSheet } from "../layout/model";

const settings = { printMarginMm: 3, mapFrame: { x: 10, y: 10, width: 190, height: 277 }, description: { visible: false, x: 150, y: 12, cellSizeMm: 6 }, appearance: defaultMapAppearance };
const sheetText = { id: "s", kind: "text" as const, anchor: "page" as const, x: 20, y: 30, text: "{course}", fontSizeMm: 4, color: "#000000" };
const templateText = { id: "t", kind: "text" as const, anchor: "page" as const, x: 20, y: 280, text: "{event}", fontSizeMm: 3, color: "#000000" };

function sheet(scope: "sheet" | "template" = "sheet"): EditorSheet {
  const window = { minX: 30 - 142.5, minY: 10 - 207.75, width: 285, height: 415.5 };
  return {
    scope,
    sheet: scope === "sheet" ? { seq: 4, name: "A", kind: "course", courseSeq: 2, windowCenter: { x: 30, y: 10 }, overrides: { printScale: 10000, description: { visible: true, x: 140, y: 12, cellSizeMm: 6 } }, objects: [sheetText] } : null,
    template: { seq: 1, name: "A4", paper: "A4", orientation: "portrait", paperWidthMm: null, paperHeightMm: null, printScale: 7500, settings, objects: [templateText] },
    courseSeq: 2,
    document: { description: scope === "sheet" ? { visible: true, x: 140, y: 12, cellSizeMm: 6 } : settings.description } as EditorSheet["document"],
    window,
    page: { textValues: { course: "A", scale: "1:10000" } } as EditorSheet["page"],
    block: { rows: [{ code: "31", kind: "control", sequence: 1 }], header: null, title: "A" },
    appearance: {}, overprintScale: 1.5, labelMode: "sequence", windows: [window], controls: [], descriptionRowCount: 1, descriptionHeaderRows: 1, mapScale: 15000,
  } as EditorSheet;
}

describe("Layout model (docs/course-layout.md §2)", () => {
  it("sheet scope: the sheet's print scale and block, its objects editable, the template's locked", () => {
    const s = sheet();
    const snap = snapshotOf(s);
    expect(snap.centre).toEqual({ x: 30, y: 10 });
    expect(snap.printScale).toBe(10000);
    expect(snap.description.visible).toBe(true);
    expect(scopeObjects(s, snap)).toEqual({ editable: [sheetText], locked: [templateText] });
    expect(withEditable(s, snap, []).sheetObjects).toEqual([]);
  });

  it("template scope: the template's objects editable, nothing locked", () => {
    const s = sheet("template");
    const snap = snapshotOf(s);
    expect(snap.printScale).toBe(7500);
    expect(scopeObjects(s, snap)).toEqual({ editable: [templateText], locked: [] });
    expect(withEditable(s, snap, []).templateObjects).toEqual([]);
  });

  it("geometry: A4 portrait, the printable margin, the window at the print scale", () => {
    const g = geometryOf(sheet(), snapshotOf(sheet()));
    expect(g.paper).toEqual({ widthMm: 210, heightMm: 297 });
    expect(g.printable).toEqual({ x: 3, y: 3, width: 204, height: 291 });
    expect(g.window.width).toBeCloseTo(190 / 1.5, 9);
    expect(g.window.minX + g.window.width / 2).toBeCloseTo(30, 9);
  });

  it("the layout request: both scopes' objects, the scale's text value and overprint, the block where the snapshot puts it", () => {
    const s = sheet();
    const snap = { ...snapshotOf(s), printScale: 5000, description: { visible: true, x: 100, y: 20, cellSizeMm: 7 } };
    const r = layoutRequestOf(s, snap, geometryOf(s, snap));
    expect(r.page.objects).toEqual([templateText, sheetText]);
    expect(r.page.textValues).toMatchObject({ course: "A", scale: "1:5000" });
    expect(r.overprintScale).toBeCloseTo(3, 9);
    expect(r.page.description).toMatchObject({ x: 100, y: 20, cellSizeMm: 7, title: "A" });
    expect(r.page.description!.rows).toHaveLength(1);
    expect(layoutRequestOf(s, { ...snap, description: { ...snap.description, visible: false } }, geometryOf(s, snap)).page.description).toBeNull();
    expect(r.appearance).toEqual({ circle: 1, line: 1, number: 1 });
  });

  it("placement: each rail kind at the click, clamped to the printable area", () => {
    const printable = { x: 3, y: 3, width: 204, height: 291 };
    const header = placeObject("header", { x: 50, y: 20 }, printable, "#a626ff")!;
    expect(header).toMatchObject({ kind: "text", anchor: "page", x: 50, y: 20, fontSizeMm: 6 });
    expect(placeObject("whiteout", { x: 50, y: 50 }, printable, "#a626ff")).toMatchObject({ kind: "rectangle", fillMode: "whiteout" });
    expect(placeObject("whiteout", { x: 50, y: 50 }, printable, "#a626ff")).not.toHaveProperty("stroke");
    expect(placeObject("whiteoutOutside", { x: 50, y: 50 }, printable, "#a626ff")).toMatchObject({ kind: "path", fillMode: "whiteoutInverted", closed: true });
    expect(placeObject("image", { x: 1, y: 1 }, printable, "#a626ff", 9)).toMatchObject({ kind: "image", graphicId: 9, x: 3, y: 3 });
    expect(placeObject("image", { x: 1, y: 1 }, printable, "#a626ff")).toBeNull();
    expect(placeObject("line", { x: 50, y: 50 }, printable, "#a626ff")).toMatchObject({ kind: "path", closed: false });
  });
});
