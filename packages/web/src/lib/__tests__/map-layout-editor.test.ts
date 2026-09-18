import { describe, expect, it } from "vitest";
import {
  constrainMapObject,
  createImageObjectAt,
  createObjectAt,
  displayedPreviewPlacement,
  editorPreviewDpi,
  initialEditorViewport,
  panEditorViewport,
  pinchEditorViewport,
  parseClampedNumberDraft,
  insertPolygonVertex,
  removePolygonVertex,
  resizeMapObject,
  translateMapObject,
  updatePolygonHandle,
  zoomEditorViewport,
} from "../map-layout-editor";

const frame = { x: 3, y: 3, width: 204, height: 291 };
const window = { minX: 0, minY: 0, width: 204, height: 291 };
const printable = { x: 3, y: 3, width: 204, height: 291 };

describe("map layout editor geometry", () => {
  it("resizes a rectangle from its south-east handle", () => {
    const resized = resizeMapObject(
      {
        id: "rect",
        kind: "rectangle",
        anchor: "page",
        x: 10,
        y: 10,
        width: 20,
        height: 10,
        stroke: "#000000",
        strokeWidthMm: 0.3,
        fillMode: "none",
      },
      "se",
      5,
      7,
      frame,
      window,
    );
    expect(resized).toMatchObject({ x: 10, y: 10, width: 25, height: 17 });
  });

  it("keeps dragged objects inside the printable margin", () => {
    const constrained = constrainMapObject(
      {
        id: "rect",
        kind: "rectangle",
        anchor: "page",
        x: -5,
        y: 290,
        width: 20,
        height: 20,
        fillMode: "whiteout",
      },
      printable,
      frame,
      window,
    );
    expect(constrained).toMatchObject({ x: 3, y: 274 });
  });

  it("creates objects at the clicked point and keeps their bounds printable", () => {
    expect(createObjectAt("text", { x: 50, y: 60 }, printable)).toMatchObject({
      kind: "text",
      x: 50,
      y: 60,
    });
    expect(
      createObjectAt("rectangle", { x: 1, y: 1 }, printable),
    ).toMatchObject({
      kind: "rectangle",
      x: printable.x,
      y: printable.y,
    });
    const path = createObjectAt("line", { x: 206, y: 60 }, printable);
    expect(path.kind).toBe("path");
    if (path.kind === "path") {
      expect(path.points[1].x).toBe(printable.x + printable.width);
    }
  });

  it("translates and resizes path vertices without changing handles", () => {
    const path = {
      id: "path",
      kind: "path" as const,
      anchor: "page" as const,
      points: [
        { x: 10, y: 20, hOut: { x: 4, y: -2 } },
        { x: 30, y: 40, hIn: { x: -3, y: 1 } },
      ],
      stroke: "#000000",
      strokeWidthMm: 0.3,
      fillMode: "none" as const,
      closed: false,
    };
    const translated = translateMapObject(path, 5, -4, frame, window);
    expect(translated).toMatchObject({
      points: [
        { x: 15, y: 16, hOut: { x: 4, y: -2 } },
        { x: 35, y: 36, hIn: { x: -3, y: 1 } },
      ],
    });
    expect(
      resizeMapObject(path, "vertex-1", 2, 3, frame, window),
    ).toMatchObject({
      points: [
        { x: 10, y: 20, hOut: { x: 4, y: -2 } },
        { x: 32, y: 43, hIn: { x: -3, y: 1 } },
      ],
    });
  });

  it("inserts and removes vertices while enforcing object minimums", () => {
    const path = {
      id: "path",
      kind: "path" as const,
      anchor: "page" as const,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      stroke: "#000000",
      strokeWidthMm: 0.3,
      fillMode: "none" as const,
      closed: false,
    };
    const insertedPath = insertPolygonVertex(path, 0);
    expect(insertedPath.points).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(removePolygonVertex(insertedPath, 1).points).toHaveLength(2);
    expect(removePolygonVertex(path, 0)).toBe(path);

    const polygon = {
      id: "polygon",
      kind: "path" as const,
      anchor: "page" as const,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      fillMode: "whiteout" as const,
      closed: true,
    };
    expect(insertPolygonVertex(polygon, 2).points[3]).toEqual({ x: 5, y: 5 });
    expect(removePolygonVertex(polygon, 1)).toBe(polygon);
  });

  it("splits curved edges and updates relative handles", () => {
    const path = {
      id: "curve",
      kind: "path" as const,
      anchor: "page" as const,
      points: [
        { x: 0, y: 0, hOut: { x: 0, y: 10 } },
        { x: 10, y: 0, hIn: { x: 0, y: 10 } },
      ],
      stroke: "#000000",
      strokeWidthMm: 0.3,
      fillMode: "none" as const,
      closed: false,
    };
    const inserted = insertPolygonVertex(path, 0);
    expect(inserted.points[1]).toEqual({
      x: 5,
      y: 7.5,
      hIn: { x: -2.5, y: 0 },
      hOut: { x: 2.5, y: 0 },
    });
    expect(
      updatePolygonHandle(inserted, 1, "hOut", { x: 4, y: 2 }).points[1],
    ).toMatchObject({ hOut: { x: 4, y: 2 } });
  });

  it("zooms the editor viewport without changing print data", () => {
    const paper = { width: 210, height: 297 };
    const initial = initialEditorViewport(paper);
    const zoomed = zoomEditorViewport(
      initial,
      paper,
      { x: 105, y: 148.5 },
      2,
    );
    expect(zoomed).toEqual({
      x: 52.5,
      y: 74.25,
      width: 105,
      height: 148.5,
      zoom: 2,
    });
  });

  it("pans a zoomed viewport while keeping it on the paper", () => {
    const paper = { width: 210, height: 297 };
    const viewport = {
      x: 50,
      y: 70,
      width: 105,
      height: 148.5,
      zoom: 2,
    };
    expect(panEditorViewport(viewport, paper, -200, -200)).toMatchObject({
      x: 105,
      y: 148.5,
    });
    expect(panEditorViewport(viewport, paper, 200, 200)).toMatchObject({
      x: 0,
      y: 0,
    });
  });

  it("combines midpoint movement and pinch zoom from one stable base", () => {
    const paper = { width: 210, height: 297 };
    const base = initialEditorViewport(paper);
    expect(
      pinchEditorViewport(
        base,
        paper,
        { x: 105, y: 148.5 },
        { x: 105, y: 148.5 },
        { x: 115, y: 158.5 },
        2,
      ),
    ).toEqual({
      x: 47.5,
      y: 69.25,
      width: 105,
      height: 148.5,
      zoom: 2,
    });
  });

  it("chooses a stable high-resolution preview within the pixel limit", () => {
    expect(editorPreviewDpi(frame)).toBe(300);
    const a3 = { x: 0, y: 0, width: 420, height: 297 };
    const dpi = editorPreviewDpi(a3);
    expect(dpi).toBe(247);
    expect((a3.width / 25.4) * dpi).toBeLessThanOrEqual(4096);
  });

  it("caps editor zoom at eight times", () => {
    const paper = { width: 210, height: 297 };
    expect(
      zoomEditorViewport(
        initialEditorViewport(paper),
        paper,
        { x: 105, y: 148.5 },
        20,
      ).zoom,
    ).toBe(8);
  });

  it("parses clearable number drafts on commit", () => {
    expect(parseClampedNumberDraft("", 7500, 1000, 100000)).toBe(7500);
    expect(parseClampedNumberDraft("8000", 7500, 1000, 100000)).toBe(8000);
    expect(parseClampedNumberDraft("oops", 7500, 1000, 100000)).toBe(7500);
  });

  it("places image objects at the click point clamped to the printable area", () => {
    const centered = createImageObjectAt(4, { x: 100, y: 150 }, printable);
    expect(centered).toMatchObject({
      kind: "image",
      anchor: "page",
      graphicId: 4,
      x: 85,
      y: 135,
      width: 30,
      height: 30,
    });
    const clamped = createImageObjectAt(4, { x: 0, y: 0 }, printable);
    expect(clamped).toMatchObject({ x: 3, y: 3 });
  });

  it("keeps the displayed raster aligned with the current window during drag", () => {
    const displayed = { center: { x: 102, y: 145.5 }, printScale: 7500 };
    // Same window: the raster fills the frame exactly.
    const same = displayedPreviewPlacement(
      displayed,
      7500,
      frame,
      { minX: 0, minY: 0, width: 204, height: 291 },
    );
    expect(same).toEqual(frame);
    // Window panned 10 mm east: the raster shifts west on the page.
    const panned = displayedPreviewPlacement(
      displayed,
      7500,
      frame,
      { minX: 10, minY: 0, width: 204, height: 291 },
    );
    expect(panned.x).toBeCloseTo(frame.x - 10, 6);
    expect(panned.y).toBeCloseTo(frame.y, 6);
    expect(panned.width).toBeCloseTo(frame.width, 6);
  });

  it("clamps resize so a dragged edge cannot grow out the opposite side", () => {
    const resized = resizeMapObject(
      {
        id: "rect",
        kind: "rectangle",
        anchor: "page",
        x: 10,
        y: 10,
        width: 20,
        height: 10,
        stroke: "#000000",
        strokeWidthMm: 0.3,
        fillMode: "none",
      },
      "se",
      500,
      500,
      frame,
      window,
      { printable },
    );
    expect(resized).toMatchObject({
      x: 10,
      y: 10,
      width: printable.x + printable.width - 10,
      height: printable.y + printable.height - 10,
    });
  });

  it("resizes images freely by default, proportionally and crops on modifiers", () => {
    const image = {
      id: "logo",
      kind: "image" as const,
      anchor: "page" as const,
      graphicId: 1,
      x: 20,
      y: 20,
      width: 40,
      height: 20,
    };
    // Default (no modifier) is a free resize: width changes, height stays.
    const free = resizeMapObject(image, "se", 20, 0, frame, window, {
      printable,
    });
    expect(free).toMatchObject({ width: 60, height: 20 });
    const proportional = resizeMapObject(
      image,
      "se",
      20,
      0,
      frame,
      window,
      { printable, imageMode: "proportional" },
    );
    expect(proportional).toMatchObject({
      width: 60,
      height: 30,
    });
    const cropped = resizeMapObject(
      image,
      "se",
      -10,
      0,
      frame,
      window,
      { printable, imageMode: "crop" },
    );
    expect(cropped).toMatchObject({
      kind: "image",
      width: 30,
      crop: expect.objectContaining({
        width: expect.any(Number),
      }),
    });
    if (cropped.kind !== "image" || !cropped.crop) throw new Error("crop");
    expect(cropped.crop.width).toBeLessThan(1);
  });
});
