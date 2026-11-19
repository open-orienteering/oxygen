import { describe, expect, it } from "vitest";
import { course, defaultMapAppearance, type CourseMapObject } from "@oxygen/shared";
import { cropChange, sizeChange } from "../../../lib/editor/style-fields";
import { FILL_MODES, geometryOf, rectOfStyleGeometry, transformPathOf, styleChangeOf, styleGeometryOf, styleShowOf, layoutRequestOf, nextSheetName, pathObject, templateWriteOf, placeObject, scopeObjects, sheetKeyOf, snapshotOf, withEditable, type EditorSheet } from "../layout/model";

const settings = { printMarginMm: 3, mapFrame: { x: 10, y: 10, width: 190, height: 277 }, description: { visible: false, x: 150, y: 12, cellSizeMm: 6 }, appearance: defaultMapAppearance };
const sheetText = { id: "s", kind: "text" as const, anchor: "page" as const, x: 20, y: 30, text: "{course}", fontSizeMm: 4, color: "#000000" };
const templateText = { id: "t", kind: "text" as const, anchor: "page" as const, x: 20, y: 280, text: "{event}", fontSizeMm: 3, color: "#000000" };

function sheet(scope: "sheet" | "template" = "sheet"): EditorSheet {
  const window = { minX: 30 - 142.5, minY: 10 - 207.75, width: 285, height: 415.5 };
  return {
    scope,
    sheet: scope === "sheet" ? { seq: 4, name: "A", kind: "course", courseSeq: 2, classSeq: null, version: "5", windowCenter: { x: 30, y: 10 }, overrides: { printScale: 10000, description: { visible: true, x: 140, y: 12, cellSizeMm: 6 } }, objects: [sheetText] } : null,
    template: { seq: 1, name: "A4", paper: "A4", orientation: "portrait", paperWidthMm: null, paperHeightMm: null, printScale: 7500, settings, objects: [templateText], autoKey: "A4-portrait-7500", isExtra: false, version: "3" },
    classView: null,
    variantKey: null,
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

  it("the sheet key names the print scale, paper and orientation (course-layout.md §5)", () => {
    expect(sheetKeyOf(snapshotOf(sheet()))).toBe("1:10000 A4 portrait");
    expect(sheetKeyOf({ printScale: 4000, paper: "custom", orientation: "landscape", paperWidthMm: 300.2, paperHeightMm: 200 })).toBe("1:4000 300×200 landscape");
  });

  it("template scope: the template's objects editable, nothing locked", () => {
    const s = sheet("template");
    const snap = snapshotOf(s);
    expect(snap.printScale).toBe(7500);
    expect(scopeObjects(s, snap)).toEqual({ editable: [templateText], locked: [] });
    expect(withEditable(s, snap, []).templateObjects).toEqual([]);
  });

  it("template scope: the name is part of the snapshot and of the template write (E-pages)", () => {
    const s = sheet("template");
    const snap = snapshotOf(s);
    expect(snap.templateName).toBe("A4");
    const write = templateWriteOf({ ...snap, templateName: "Sprint A4" });
    expect(write).toMatchObject({ name: "Sprint A4", paper: "A4", orientation: "portrait", printScale: 7500, objects: [templateText] });
    expect(write.settings.description).toEqual(snap.description);
    expect(write).not.toHaveProperty("paperWidthMm");
    expect(templateWriteOf({ ...snap, paper: "custom", paperWidthMm: 200, paperHeightMm: 300 })).toMatchObject({ paperWidthMm: 200, paperHeightMm: 300 });
  });

  it("geometry: A4 portrait, the printable margin, the window at the print scale", () => {
    const g = geometryOf(sheet(), snapshotOf(sheet()));
    expect(g.paper).toEqual({ widthMm: 210, heightMm: 297 });
    expect(g.printable).toEqual({ x: 3, y: 3, width: 204, height: 291 });
    expect(g.window.width).toBeCloseTo(190 / 1.5, 9);
    expect(g.window.minX + g.window.width / 2).toBeCloseTo(30, 9);
  });

  it("the layout request: both scopes' objects, the scale's text value, the block where the snapshot puts it", () => {
    const s = sheet();
    const snap = { ...snapshotOf(s), printScale: 5000, description: { visible: true, x: 100, y: 20, cellSizeMm: 7 } };
    const r = layoutRequestOf(s, snap, geometryOf(s, snap));
    expect(r.page.objects).toEqual([templateText, sheetText]);
    expect(r.page.textValues).toMatchObject({ course: "A", scale: "1:5000" });
    expect(r).not.toHaveProperty("overprintScale");
    expect(r.page.description).toMatchObject({ x: 100, y: 20, cellSizeMm: 7, title: "A" });
    expect(r.page.description!.rows).toHaveLength(1);
    expect(layoutRequestOf(s, { ...snap, description: { ...snap.description, visible: false } }, geometryOf(s, snap)).page.description).toBeNull();
    expect(r.appearance).toEqual({ circle: 1, line: 1, number: 1 });
  });

  it("a course sheet's part reaches the layer request (course-layer.md §11, F5); a template has none", () => {
    const s = sheet();
    const part = { ...s, sheet: { ...s.sheet!, sectionIndex: 1 } };
    expect(layoutRequestOf(part, snapshotOf(part), geometryOf(part, snapshotOf(part))).section).toBe(1);
    const tpl = sheet("template");
    expect(layoutRequestOf(tpl, snapshotOf(tpl), geometryOf(tpl, snapshotOf(tpl))).section).toBeUndefined();
  });

  it("the white-out-outside fill mode stays in the inspector although the O tool is gone (D14)", () => {
    expect(FILL_MODES).toContain("whiteoutInverted");
  });

  it("placement: each rail kind at the click, clamped to the printable area", () => {
    const printable = { x: 3, y: 3, width: 204, height: 291 };
    const header = placeObject("header", { x: 50, y: 20 }, printable)!;
    expect(header).toMatchObject({ kind: "text", anchor: "page", x: 50, y: 20, fontSizeMm: 6 });
    expect(placeObject("whiteout", { x: 50, y: 50 }, printable)).toMatchObject({ kind: "rectangle", fillMode: "whiteout" });
    expect(placeObject("whiteout", { x: 50, y: 50 }, printable)).not.toHaveProperty("stroke");
    expect(placeObject("image", { x: 1, y: 1 }, printable, 9)).toMatchObject({ kind: "image", graphicId: 9, x: 3, y: 3 });
    expect(placeObject("image", { x: 1, y: 1 }, printable)).toBeNull();
    expect(placeObject("line", { x: 50, y: 50 }, printable)).toMatchObject({ kind: "path", closed: false });
  });

  it("a drawn polygon (P, D16): a closed page path with the drawn points and createObjectAt's defaults", () => {
    const points = [{ x: 40, y: 60 }, { x: 90, y: 60, hOut: { x: 0, y: 5 } }, { x: 60, y: 110 }];
    const o = pathObject(points, { x: 3, y: 3, width: 204, height: 291 });
    expect(o).toMatchObject({ kind: "path", anchor: "page", closed: true, points, stroke: "#000000", strokeWidthMm: 0.35, fillMode: "none" });
    expect(o.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("nextSheetName (E-pages: Add a sheet)", () => {
  it("numbers after the course's sheets and skips taken names", () => {
    expect(nextSheetName("Blue", ["Blue"])).toBe("Blue 2");
    expect(nextSheetName("Blue", ["Blue", "Blue 2"])).toBe("Blue 3");
    expect(nextSheetName("Blue", ["Blue", "Blue 3"])).toBe("Blue 4");
    expect(nextSheetName("Blue", [])).toBe("Blue 2");
  });
});

describe("page objects' style fields (J8, docs/course-layout.md §3 \"Style fields\")", () => {
  const printable = { x: 3, y: 3, width: 204, height: 291 };
  const img = { id: "i", kind: "image" as const, anchor: "page" as const, graphicId: 1, x: 50, y: 50, width: 40, height: 20 };
  const rect = { id: "r", kind: "rectangle" as const, anchor: "page" as const, x: 10, y: 10, width: 20, height: 10, fillMode: "whiteout" as const };
  const text = { id: "t", kind: "text" as const, anchor: "page" as const, x: 10, y: 10, text: "A", fontSizeMm: 4, color: "#000000" };
  const line = { id: "l", kind: "line" as const, anchor: "page" as const, x1: 0, y1: 0, x2: 5, y2: 5, stroke: "#000000", strokeWidthMm: 0.3 };

  it("which fields each kind shows", () => {
    expect(styleShowOf(img)).toEqual({ blend: true, rotation: true, flip: true, size: true, crop: true, lock: true });
    expect(styleShowOf(rect)).toEqual({ blend: false, rotation: true, flip: false, size: true, crop: false, lock: false });
    expect(styleShowOf({ ...rect, fillMode: "solid" as const })).toMatchObject({ blend: true });
    expect(styleShowOf(text)).toMatchObject({ blend: true, rotation: true, size: false });
    expect(styleShowOf(line)).toMatchObject({ blend: true, rotation: false, size: false });
  });

  it("the y-down adapter round-trips a page box", () => {
    expect(styleGeometryOf(img)).toEqual([{ x: 50, y: -70 }, { x: 90, y: -50 }]);
    expect(rectOfStyleGeometry(styleGeometryOf(img)!)).toEqual({ x: 50, y: 50, width: 40, height: 20 });
    expect(styleGeometryOf(text)).toBeUndefined();
  });

  it("a commit is the whole next object: a removed key stays removed; a box applied and kept on the page", () => {
    const withOpacity = { ...img, opacity: 0.5 };
    const { opacity: _o, ...plain } = withOpacity;
    expect(styleChangeOf(withOpacity, { props: plain }, printable)).toEqual(img);
    expect(styleChangeOf(img, { geometry: [{ x: 60, y: -65 }, { x: 80, y: -55 }] }, printable)).toMatchObject({ x: 60, y: 55, width: 20, height: 10 });
    expect(styleChangeOf(img, { geometry: [{ x: -10, y: -65 }, { x: 10, y: -55 }] }, printable)).toMatchObject({ x: 3, width: 20 });
  });

  it("a rotation is kept on the page by the turned box; opacity alone moves nothing; a size is at most the printable area", () => {
    const edge = { ...img, x: 165, y: 5 };
    const turned = styleChangeOf(edge, { props: { ...edge, rotationDeg: 90 } }, printable) as typeof img;
    // 40 × 20 turned 90° is 20 wide, 40 tall about its centre (185, 15): pushed down to the top margin.
    expect(turned.y + turned.height / 2 - 20).toBeCloseTo(3, 6);
    expect(turned.x).toBe(165);
    const header = { ...text, x: 200, text: "A long header text" };
    expect(styleChangeOf(header, { props: { ...header, opacity: 0.5 } }, printable)).toMatchObject({ x: 200 });
    const big = styleChangeOf(img, { geometry: sizeChange(styleGeometryOf(img)!, "width", 1000, true) }, printable) as typeof img;
    expect(big.width).toBeCloseTo(204, 6);
    expect(big.height).toBeCloseTo(102, 6);
    expect(big.x).toBeCloseTo(3, 6);
    const wide = styleChangeOf({ ...rect, fillMode: "solid" as const }, { geometry: sizeChange(styleGeometryOf(rect)!, "width", 500, false) }, printable) as typeof rect;
    expect([wide.x, wide.width, wide.height]).toEqual([3, 204, 10]);
  });

  // The renderer's rule: the page box flipped to y-up (`flipPageObject`), turned by `course.imageCorners`, the source
  // (u, v) placed bilinearly in the crop; back to page mm y-down.
  const H = 297;
  function place(o: CourseMapObject & { kind: "image" }, u: number, v: number) {
    const crop = o.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    const [bl, br, tr, tl] = course.imageCorners({ x: o.x, y: H - o.y - o.height, width: o.width, height: o.height }, o);
    const s = (u - crop.x) / crop.width, t = (v - crop.y) / crop.height;
    const top = { x: tl.x + (tr.x - tl.x) * s, y: tl.y + (tr.y - tl.y) * s };
    const bot = { x: bl.x + (br.x - bl.x) * s, y: bl.y + (br.y - bl.y) * s };
    return { x: top.x + (bot.x - top.x) * t, y: H - (top.y + (bot.y - top.y) * t) };
  }
  for (const style of [{ rotationDeg: 30, flipH: true }, { rotationDeg: -70, flipV: true }, { rotationDeg: 90, flipH: true, flipV: true, crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.5 } }]) {
    it(`a crop through the adapter keeps a source pixel in place on the page: ${JSON.stringify(style)}`, () => {
      const o = { ...img, x: 80, y: 100, ...style } as CourseMapObject & { kind: "image" };
      const r = cropChange(styleGeometryOf(o)!, o, o.crop, { x: 0.25, y: 0.3, width: 0.4, height: 0.3 });
      const n = styleChangeOf(o, { props: { ...o, crop: r.crop }, geometry: r.geometry }, printable) as typeof o;
      const a = place(o, 0.4, 0.45), b = place(n, 0.4, 0.45);
      expect(b.x).toBeCloseTo(a.x, 6);
      expect(b.y).toBeCloseTo(a.y, 6);
    });
  }

  it("a crop on a page image in y-down page mm: left 25 % and top 50 % keep the visible pixels in place", () => {
    const left = cropChange(styleGeometryOf(img)!, {}, undefined, { x: 0.25, y: 0, width: 0.75, height: 1 });
    expect(rectOfStyleGeometry(left.geometry)).toEqual({ x: 60, y: 50, width: 30, height: 20 });
    const top = cropChange(styleGeometryOf(img)!, {}, undefined, { x: 0, y: 0.5, width: 1, height: 0.5 });
    expect(rectOfStyleGeometry(top.geometry)).toEqual({ x: 50, y: 60, width: 40, height: 10 });
  });
});

describe("a line's or path's turn and flip (J9, docs/course-layout.md §3 \"Rotate and flip a line or path\")", () => {
  const printable = { x: 3, y: 3, width: 204, height: 291 };
  const path = { id: "p", kind: "path" as const, anchor: "page" as const, closed: true, fillMode: "none" as const,
    points: [{ x: 50, y: 50, hOut: { x: 5, y: 0 } }, { x: 70, y: 50 }, { x: 70, y: 60 }, { x: 50, y: 60 }] };
  it("a quarter turn clockwise as seen on the page turns vertices and handles about the bounds' centre", () => {
    const r = transformPathOf(path, { kind: "rotate", deg: 90 }, printable) as typeof path;
    // Centre (60, 55); the top-left vertex goes to the top-right, its rightward handle points down the page.
    expect(r.points[0].x).toBeCloseTo(65, 6);
    expect(r.points[0].y).toBeCloseTo(45, 6);
    expect(r.points[0].hOut!.x).toBeCloseTo(0, 6);
    expect(r.points[0].hOut!.y).toBeCloseTo(5, 6);
    expect(r.closed).toBe(true);
  });
  it("a flip mirrors about the centre and keeps the bounds; the legacy line kind; kept on the page; boxes refused", () => {
    const f = transformPathOf(path, { kind: "flip", axis: "h" }, printable) as typeof path;
    expect(f.points.map((p) => p.x)).toEqual([70, 50, 50, 70]);
    expect(f.points[0].hOut).toEqual({ x: -5, y: 0 });
    const line = { id: "l", kind: "line" as const, anchor: "page" as const, x1: 10, y1: 10, x2: 30, y2: 20, stroke: "#000000", strokeWidthMm: 0.3 };
    expect(transformPathOf(line, { kind: "flip", axis: "v" }, printable)).toMatchObject({ x1: 10, y1: 20, x2: 30, y2: 10 });
    const edge = { ...line, x1: 4, y1: 10, x2: 44, y2: 10 };
    const turned = transformPathOf(edge, { kind: "rotate", deg: 90 }, printable) as typeof line;
    expect(Math.min(turned.y1, turned.y2)).toBeCloseTo(3, 6);
    const long = { ...line, x1: 100, y1: 20, x2: 100, y2: 270 };
    const across = transformPathOf(long, { kind: "rotate", deg: 90 }, printable) as typeof line;
    expect(Math.min(across.x1, across.x2)).toBeCloseTo(3, 6);
    expect(transformPathOf(path, { kind: "rotate", deg: 360 }, printable)).toBeNull();
    expect(transformPathOf({ id: "t", kind: "text", anchor: "page", x: 1, y: 1, text: "A", fontSizeMm: 4, color: "#000000" }, { kind: "rotate", deg: 90 }, printable)).toBeNull();
  });
});
