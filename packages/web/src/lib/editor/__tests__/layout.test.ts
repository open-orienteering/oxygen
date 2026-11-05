import { describe, expect, it } from "vitest";
import type { CourseMapObject } from "@oxygen/shared";
import {
  alignedCentre, descriptionRect, gridSnap, handleAt, layoutObjectAt, nativePoints, objectHandles, pageBounds, pageDelta, pagePerView, pagePoints, pathFromView,
  sheetShapes, sheetWindow, toPage, toView, windowCentre, type SheetGeometry,
} from "../layout";

// A4 portrait, frame 10 mm in; a 1:15 000 map printed at 1:10 000 (1.5 page mm per paper mm), centred on (100, 50).
const frame = { x: 10, y: 10, width: 190, height: 277 };
const geometry = (rotationDeg = 0): SheetGeometry => ({
  paper: { widthMm: 210, heightMm: 297 },
  printable: { x: 3, y: 3, width: 204, height: 291 },
  frame,
  window: sheetWindow(frame, { x: 100, y: 50 }, 15000, 10000, rotationDeg),
});

describe("page view maths (docs/course-layout.md §1)", () => {
  it("the window: the frame at the print scale, centred, rotation kept", () => {
    const g = geometry(12);
    expect(g.window.width).toBeCloseTo(190 / 1.5, 9);
    expect(g.window.height).toBeCloseTo(277 / 1.5, 9);
    expect(windowCentre(g.window)).toEqual({ x: 100, y: 50 });
    expect(g.window.rotationDeg).toBe(12);
    expect(pagePerView(g)).toBeCloseTo(1.5, 9);
  });

  for (const rot of [0, 15]) {
    it(`page ↔ view round-trips; the frame centre is the window centre (rotation ${rot}°)`, () => {
      const g = geometry(rot);
      const centre = toView({ x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }, g);
      expect(centre.x).toBeCloseTo(100, 9);
      expect(centre.y).toBeCloseTo(50, 9);
      for (const p of [{ x: 0, y: 0 }, { x: 105, y: 20 }, { x: 210, y: 297 }]) {
        const back = toPage(toView(p, g), g);
        expect(back.x).toBeCloseTo(p.x, 9);
        expect(back.y).toBeCloseTo(p.y, 9);
      }
    });
  }

  it("page y grows down, paper y up; a page millimetre is 1 / 1.5 paper mm", () => {
    const g = geometry();
    const a = toView({ x: 105, y: 100 }, g), b = toView({ x: 105, y: 115 }, g);
    expect(b.y - a.y).toBeCloseTo(-10, 9);
    expect(b.x - a.x).toBeCloseTo(0, 9);
  });

  it("sheet shapes: grey surround, paper, printable dashed, frame (selected solid)", () => {
    const shapes = sheetShapes(geometry(), false);
    const ids = shapes.flatMap((s) => ("testId" in s && s.testId ? [s.testId] : []));
    expect(ids).toEqual(["editor-layout-paper", "editor-layout-printable", "editor-layout-frame"]);
    expect(shapes.filter((s) => s.kind === "line" && s.fill)).toHaveLength(4);
    const frameShape = shapes.find((s) => "testId" in s && s.testId === "editor-layout-frame")!;
    expect(frameShape.kind === "line" && frameShape.dashed).toBe(true);
    const selected = sheetShapes(geometry(), true).find((s) => "testId" in s && s.testId === "editor-layout-frame")!;
    expect(selected.kind === "line" && selected.dashed).toBeFalsy();
  });

  it("the page's bounds in paper mm: the fit of F", () => {
    const b = pageBounds(geometry());
    expect(b.maxX - b.minX).toBeCloseTo(210 / 1.5, 9);
    expect(b.maxY - b.minY).toBeCloseTo(297 / 1.5, 9);
  });
});

describe("layout objects on the page", () => {
  const text: CourseMapObject = { id: "t", kind: "text", anchor: "page", x: 20, y: 30, text: "Hello", fontSizeMm: 4, color: "#000000" };
  const rect: CourseMapObject = { id: "r", kind: "rectangle", anchor: "page", x: 50, y: 50, width: 30, height: 20, fillMode: "none" };
  const line: CourseMapObject = { id: "l", kind: "line", anchor: "page", x1: 100, y1: 100, x2: 150, y2: 100, stroke: "#000000", strokeWidthMm: 0.35 };
  const covering: CourseMapObject = { id: "c", kind: "rectangle", anchor: "page", x: 55, y: 55, width: 10, height: 10, fillMode: "whiteout" };
  const objects = [text, rect, line, covering];
  const g = geometry();

  it("hit: by bounds, lines by distance, topmost wins", () => {
    expect(layoutObjectAt({ x: 22, y: 28 }, objects, g, 1)).toBe(0);
    expect(layoutObjectAt({ x: 75, y: 65 }, objects, g, 1)).toBe(1);
    expect(layoutObjectAt({ x: 60, y: 60 }, objects, g, 1)).toBe(3);
    expect(layoutObjectAt({ x: 120, y: 100.8 }, objects, g, 1)).toBe(2);
    expect(layoutObjectAt({ x: 120, y: 103 }, objects, g, 1)).toBe(-1);
  });

  it("a map-anchored object is hit where the window puts it", () => {
    const at = toView({ x: 120, y: 200 }, g);
    const mapText: CourseMapObject = { id: "m", kind: "text", anchor: "map", x: at.x, y: at.y, text: "N", fontSizeMm: 5, color: "#000000" };
    expect(layoutObjectAt({ x: 121, y: 198 }, [mapText], g, 0.5)).toBe(0);
  });

  it("closed paths hit by their outline only, never inside (D16, as the course editor's areas)", () => {
    const square: CourseMapObject = { id: "s", kind: "path", anchor: "page", points: [{ x: 100, y: 150 }, { x: 140, y: 150 }, { x: 140, y: 190 }, { x: 100, y: 190 }], closed: true, fillMode: "whiteout" };
    expect(layoutObjectAt({ x: 120, y: 150.5 }, [square], g, 1)).toBe(0);
    // The closing edge (last → first).
    expect(layoutObjectAt({ x: 100.6, y: 170 }, [square], g, 1)).toBe(0);
    expect(layoutObjectAt({ x: 120, y: 170 }, [square], g, 1)).toBe(-1);
    // Under it, an object stays reachable through its inside.
    expect(layoutObjectAt({ x: 120, y: 170 }, [{ ...rect, x: 110, y: 160 }, square], g, 1)).toBe(0);
  });

  it("a curved path is hit along its curve, not its chord", () => {
    // One edge bulging up by 0.75 × 20 = 15 mm (both handles 20 mm up).
    const bulge: CourseMapObject = {
      id: "b", kind: "path", anchor: "page", closed: true, fillMode: "none",
      points: [{ x: 100, y: 150, hOut: { x: 0, y: -20 } }, { x: 140, y: 150, hIn: { x: 0, y: -20 } }, { x: 140, y: 190 }, { x: 100, y: 190 }],
    };
    expect(layoutObjectAt({ x: 120, y: 135 }, [bulge], g, 1)).toBe(0);
    expect(layoutObjectAt({ x: 120, y: 150 }, [bulge], g, 1)).toBe(-1);
    const open: CourseMapObject = { ...bulge, id: "o", closed: false };
    expect(layoutObjectAt({ x: 120, y: 135 }, [open], g, 1)).toBe(0);
    // Open: no closing edge.
    expect(layoutObjectAt({ x: 100, y: 170 }, [open], g, 1)).toBe(-1);
  });

  it("page points of a map-anchored path: vertices through the window, handles as offsets; native back", () => {
    const r = geometry(20);
    const v = toView({ x: 60, y: 80 }, r), w = toView({ x: 70, y: 80 }, r);
    const mapPath: CourseMapObject = { id: "m", kind: "path", anchor: "map", closed: false, fillMode: "none", points: [{ ...v, hOut: { x: w.x - v.x, y: w.y - v.y } }, toView({ x: 90, y: 90 }, r)] };
    const pts = pagePoints(mapPath, r);
    expect(pts[0].x).toBeCloseTo(60, 9);
    expect(pts[0].y).toBeCloseTo(80, 9);
    expect(pts[0].hOut!.x).toBeCloseTo(10, 9);
    expect(pts[0].hOut!.y).toBeCloseTo(0, 9);
    const back = nativePoints(mapPath, pts, r);
    expect(back[0].hOut!.x).toBeCloseTo(w.x - v.x, 9);
    expect(back[1].x).toBeCloseTo(mapPath.points[1].x, 9);
    const pagePath: CourseMapObject = { ...mapPath, anchor: "page", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] };
    expect(pagePoints(pagePath, r)).toEqual(pagePath.points);
    expect(nativePoints(pagePath, pts, r)).toEqual(pts);
  });

  it("pathFromView: drawn vertices to page mm, handles mapped affinely (y flipped, rotated), vertices clamped", () => {
    const r = geometry(15);
    const a = toView({ x: 50, y: 60 }, r), tip = toView({ x: 50, y: 70 }, r);
    const outside = toView({ x: 250, y: 60 }, r);
    const pts = pathFromView([{ ...a, hOut: { x: tip.x - a.x, y: tip.y - a.y }, hIn: { x: a.x - tip.x, y: a.y - tip.y } }, outside, toView({ x: 80, y: 100 }, r)], r, r.printable);
    expect(pts[0].x).toBeCloseTo(50, 9);
    expect(pts[0].y).toBeCloseTo(60, 9);
    // 10 page mm down the page, whatever the view's rotation and y-up.
    expect(pts[0].hOut!.x).toBeCloseTo(0, 9);
    expect(pts[0].hOut!.y).toBeCloseTo(10, 9);
    expect(pts[0].hIn!.y).toBeCloseTo(-10, 9);
    expect(pts[1].x).toBeCloseTo(207, 9);
    expect(pts[1].y).toBeCloseTo(60, 9);
    expect(pts[2].hIn).toBeUndefined();
  });

  it("handles: corners, line ends, none for a path (its vertices are the geometry gestures'); the nearest within tolerance", () => {
    expect(objectHandles(rect, g).map((h) => h.handle)).toEqual(["nw", "ne", "sw", "se"]);
    expect(objectHandles(line, g).map((h) => h.handle)).toEqual(["start", "end"]);
    const path: CourseMapObject = { id: "p", kind: "path", anchor: "page", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true, fillMode: "none" };
    expect(objectHandles(path, g)).toEqual([]);
    expect(handleAt({ x: 80.5, y: 70.4 }, objectHandles(rect, g), 1)).toBe("se");
    expect(handleAt({ x: 65, y: 60 }, objectHandles(rect, g), 1)).toBeNull();
  });

  it("the description block's rectangle: 8 cells wide, rows + header rows high", () => {
    expect(descriptionRect({ visible: true, x: 140, y: 12, cellSizeMm: 6 }, 5, 3)).toEqual({ x: 140, y: 12, width: 48, height: 48 });
  });
});

describe("align map and drags (docs/course-layout.md §4)", () => {
  it("the window centre follows the drag in paper mm, rotated or not", () => {
    expect(alignedCentre({ x: 100, y: 50 }, { x: 10, y: 10 }, { x: 13, y: 6 })).toEqual({ x: 103, y: 46 });
  });

  it("a drag's page offset: paper mm × the scale ratio, y flipped", () => {
    const d = pageDelta({ x: 100, y: 50 }, { x: 102, y: 49 }, geometry());
    expect(d.x).toBeCloseTo(3, 9);
    expect(d.y).toBeCloseTo(1.5, 9);
  });

  it("grid snapping to 1 mm when on", () => {
    expect(gridSnap({ x: 10.4, y: 7.6 }, true)).toEqual({ x: 10, y: 8 });
    expect(gridSnap({ x: 10.4, y: 7.6 }, false)).toEqual({ x: 10.4, y: 7.6 });
  });
});
