import { describe, expect, it } from "vitest";
import {
  courseMapSchema,
  courseMapObjectPageBounds,
  courseMapObjectSchema,
  clipLine,
  defaultMapFrame,
  expandMapText,
  getPaperDimensions,
  isWhiteoutObject,
  mapToPage,
  mapWindowForFrame,
  pageToMap,
  pointInWindow,
  validateCourseMap,
  subtractLegGaps,
  windowBoundingBox,
  windowRotationDeg,
  type CourseMapDocument,
  type CourseMapObject,
  type MapWindow,
} from "../course-maps/index.js";

const document: CourseMapDocument = {
  paper: "A4",
  orientation: "portrait",
  printScale: 7500,
  printMarginMm: 3,
  mapFrame: { x: 8, y: 8, width: 194, height: 281 },
  description: { visible: true, x: 150, y: 12, cellSizeMm: 6 },
  appearance: {
    purple: "#c026d3",
    circleRadiusMm: 2.5,
    lineWidthMm: 0.35,
    numberHeightMm: 3.5,
  },
  objects: [],
};

describe("course map schemas and geometry", () => {
  it("validates a complete document and rejects invalid dimensions", () => {
    expect(courseMapSchema.parse(document)).toEqual(document);
    expect(() =>
      courseMapSchema.parse({
        ...document,
        printScale: 0,
      }),
    ).toThrow();
  });

  it("parses whiteoutInverted and treats it as a white-out", () => {
    const inverted = courseMapObjectSchema.parse({
      id: "inv",
      kind: "path",
      anchor: "page",
      points: [
        { x: 10, y: 10 },
        { x: 50, y: 10 },
        { x: 30, y: 40 },
      ],
      fillMode: "whiteoutInverted",
      closed: true,
    });
    expect(inverted).toMatchObject({
      kind: "path",
      fillMode: "whiteoutInverted",
    });
    expect(isWhiteoutObject(inverted as CourseMapObject)).toBe(true);
  });

  it("normalizes legacy whiteout kinds into fillMode whiteout", () => {
    expect(
      courseMapObjectSchema.parse({
        id: "w",
        kind: "whiteoutRect",
        anchor: "page",
        x: 1,
        y: 2,
        width: 10,
        height: 5,
      }),
    ).toMatchObject({
      kind: "rectangle",
      fillMode: "whiteout",
      x: 1,
      y: 2,
      width: 10,
      height: 5,
    });
    expect(
      courseMapObjectSchema.parse({
        id: "p",
        kind: "whiteoutPolygon",
        anchor: "page",
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
        ],
      }),
    ).toMatchObject({
      kind: "path",
      fillMode: "whiteout",
      closed: true,
    });
  });

  it("parses paths with relative handles and defaults old payloads to open", () => {
    const parsed = courseMapObjectSchema.parse({
      id: "curve",
      kind: "path",
      anchor: "page",
      points: [
        { x: 1, y: 2, hOut: { x: 3, y: 4 } },
        { x: 10, y: 12, hIn: { x: -2, y: 1 } },
      ],
      stroke: "#123456",
      strokeWidthMm: 0.5,
    });
    expect(parsed).toMatchObject({ kind: "path", closed: false, fillMode: "none" });
    if (parsed.kind !== "path") throw new Error("Expected a path");
    expect(parsed.points[0]).toEqual({
      x: 1,
      y: 2,
      hOut: { x: 3, y: 4 },
    });
  });

  it("resolves paper dimensions and default margins", () => {
    expect(getPaperDimensions("A4", "portrait")).toEqual({
      width: 210,
      height: 297,
    });
    expect(getPaperDimensions("A3", "landscape")).toEqual({
      width: 420,
      height: 297,
    });
    expect(defaultMapFrame({ width: 210, height: 297 }, 8)).toEqual({
      x: 8,
      y: 8,
      width: 194,
      height: 281,
    });
  });

  it("keeps print scale separate from editor zoom", () => {
    const window = mapWindowForFrame(
      document.mapFrame,
      { x: 50, y: 40 },
      15_000,
      7_500,
    );
    expect(window).toEqual({
      minX: 1.5,
      minY: -30.25,
      width: 97,
      height: 140.5,
    });
    expect(mapToPage({ x: 50, y: 40 }, document.mapFrame, window)).toEqual({
      x: 105,
      y: 148.5,
    });
  });

  it("clips legs around controls and subtracts fractional gaps", () => {
    expect(
      clipLine(
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        [{ x: 10, y: 0 }],
        2,
      ),
    ).toEqual([
      { x1: 0, y1: 0, x2: 8, y2: 0 },
      { x1: 12, y1: 0, x2: 20, y2: 0 },
    ]);
    expect(
      subtractLegGaps(
        [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
        ],
        [{ from: 0.25, to: 0.75 }],
      ),
    ).toEqual([
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
      ],
      [
        { x: 15, y: 0 },
        { x: 20, y: 0 },
      ],
    ]);
  });

  it("parses the optional dash style and rejects unknown values", () => {
    const line = {
      id: "l",
      kind: "line",
      anchor: "page",
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      stroke: "#000000",
      strokeWidthMm: 0.35,
    };
    expect(courseMapObjectSchema.parse({ ...line, dash: "dashed" })).toMatchObject({
      dash: "dashed",
    });
    expect(courseMapObjectSchema.parse(line)).not.toHaveProperty("dash");
    expect(() =>
      courseMapObjectSchema.parse({ ...line, dash: "wavy" }),
    ).toThrow();
  });

  it("parses image objects through the schema", () => {
    const parsed = courseMapObjectSchema.parse({
      id: "img",
      kind: "image",
      anchor: "page",
      graphicId: 3,
      x: 12,
      y: 34,
      width: 20,
      height: 10,
    });
    expect(parsed).toMatchObject({ kind: "image", graphicId: 3 });
  });
});

describe("course map validation and placeholders", () => {
  it("expands known placeholders and preserves unknown ones", () => {
    expect(
      expandMapText("{event} / {course} {variant} {unknown}", {
        event: "Night",
        course: "Long",
        variant: "AC",
      }),
    ).toBe("Night / Long AC {unknown}");
  });

  it("reports controls and layout objects outside printable bounds", () => {
    const result = validateCourseMap({
      document: {
        ...document,
        description: { ...document.description, x: 200 },
        objects: [
          {
            id: "bad",
            kind: "rectangle",
            anchor: "page",
            x: 205,
            y: 10,
            width: 20,
            height: 10,
            stroke: "#000000",
            strokeWidthMm: 0.3,
            fillMode: "none",
          },
        ],
      },
      mapScale: 7500,
      window: { minX: 0, minY: 0, width: 100, height: 100 },
      variants: [
        {
          key: "",
          controls: [
            { id: "31", code: "31", x: 50, y: 50 },
            { id: "32", code: "32", x: 150, y: 50 },
          ],
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "control_outside_frame",
        "description_outside_page",
        "object_outside_page",
      ]),
    );
  });

  it("rejects objects inside the paper edge but outside the print margin", () => {
    const result = validateCourseMap({
      document: {
        ...document,
        objects: [
          {
            id: "margin",
            kind: "rectangle",
            anchor: "page",
            x: 1,
            y: 20,
            width: 20,
            height: 10,
            stroke: "#000000",
            strokeWidthMm: 0.3,
            fillMode: "none",
          },
        ],
      },
      mapScale: 7500,
      window: { minX: 0, minY: 0, width: 100, height: 100 },
      variants: [],
    });
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "object_outside_page",
        objectId: "margin",
      }),
    );
  });

  it("refuses a map-anchored object: F12 moved them into course objects (course-layer.md §3.6)", () => {
    const whiteout = { id: "terrain-whiteout", kind: "rectangle", x: -500, y: -500, width: 20, height: 10, fillMode: "whiteout" };
    expect(courseMapObjectSchema.safeParse({ ...whiteout, anchor: "map" }).success).toBe(false);
    expect(courseMapObjectSchema.safeParse({ ...whiteout, anchor: "page" }).success).toBe(true);
    // A legacy kind still normalises onto the page anchor.
    expect(courseMapObjectSchema.parse({ id: "w", anchor: "page", kind: "whiteoutRect", x: 0, y: 0, width: 1, height: 1 })).toMatchObject({ kind: "rectangle", fillMode: "whiteout" });
  });

  it("includes path vertices and handle control points in page bounds", () => {
    expect(
      courseMapObjectPageBounds(
        {
          id: "bounded",
          kind: "path",
          anchor: "page",
          points: [
            { x: 10, y: 10, hOut: { x: -5, y: 20 } },
            { x: 30, y: 20, hIn: { x: 15, y: -5 } },
          ],
          stroke: "#000000",
          strokeWidthMm: 0.3,
          fillMode: "none",
          closed: false,
        },
      ),
    ).toEqual({ x: 5, y: 10, width: 40, height: 20 });
  });

  it("accepts controls covered across several maps of a fork family", () => {
    const result = validateCourseMap({
      document,
      mapScale: 7500,
      windows: [
        { minX: 0, minY: 0, width: 100, height: 100 },
        { minX: 100, minY: 0, width: 100, height: 100 },
      ],
      variants: [
        {
          key: "A",
          controls: [
            { id: "31", code: "31", x: 50, y: 50 },
            { id: "32", code: "32", x: 150, y: 50 },
          ],
        },
      ],
    });
    expect(result).toEqual({ valid: true, issues: [] });
  });

  it("reports image objects outside the printable margin", () => {
    const result = validateCourseMap({
      document: {
        ...document,
        objects: [
          {
            id: "logo",
            kind: "image",
            anchor: "page",
            graphicId: 7,
            x: 195,
            y: 280,
            width: 30,
            height: 30,
          },
        ],
      },
      mapScale: 7500,
      variants: [],
    });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "object_outside_page", objectId: "logo" }),
    ]);
  });
});

describe("rotated map windows", () => {
  const frame = document.mapFrame;

  it("stores rotation only when meaningful and keeps the centre fixed", () => {
    const flat = mapWindowForFrame(frame, { x: 50, y: 40 }, 15_000, 7_500);
    expect(flat.rotationDeg).toBeUndefined();
    expect(windowRotationDeg({ ...flat, rotationDeg: 0.01 })).toBe(0);

    const rotated = mapWindowForFrame(frame, { x: 50, y: 40 }, 15_000, 7_500, -12);
    expect(windowRotationDeg(rotated)).toBe(-12);
    expect(mapToPage({ x: 50, y: 40 }, frame, rotated)).toEqual({
      x: 105,
      y: 148.5,
    });
  });

  it("round-trips page and map coordinates through a rotated window", () => {
    const window = mapWindowForFrame(frame, { x: 50, y: 40 }, 15_000, 7_500, -30);
    const page = mapToPage({ x: 63, y: 51 }, frame, window);
    const back = pageToMap(page, frame, window);
    expect(back.x).toBeCloseTo(63, 8);
    expect(back.y).toBeCloseTo(51, 8);
  });

  it("computes the axis-aligned bounding box of a rotated window", () => {
    const window: MapWindow = {
      minX: 0,
      minY: 0,
      width: 100,
      height: 40,
      rotationDeg: 90,
    };
    const bbox = windowBoundingBox(window);
    expect(bbox.width).toBeCloseTo(40, 6);
    expect(bbox.height).toBeCloseTo(100, 6);
    expect(bbox.minX).toBeCloseTo(30, 6);
    expect(bbox.minY).toBeCloseTo(-30, 6);
  });

  it("tests window containment in rotated space", () => {
    const window: MapWindow = {
      minX: 0,
      minY: 0,
      width: 100,
      height: 100,
      rotationDeg: 45,
    };
    // The rotated square still contains its centre…
    expect(pointInWindow({ x: 50, y: 50 }, window)).toBe(true);
    // …but no longer contains the unrotated corner.
    expect(pointInWindow({ x: 1, y: 1 }, window)).toBe(false);
  });
});
