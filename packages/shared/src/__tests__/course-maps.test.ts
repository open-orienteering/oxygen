import { describe, expect, it } from "vitest";
import {
  courseMapSchema,
  courseMapObjectPageBounds,
  courseMapObjectSchema,
  clipLine,
  defaultMapFrame,
  expandMapText,
  getPaperDimensions,
  mapToPage,
  mapWindowForFrame,
  pageToMap,
  pathData,
  pointInWindow,
  renderCourseOverlaySvg,
  renderDescriptionBlockSvg,
  renderMapObjectsSvg,
  validateCourseMap,
  subtractLegGaps,
  drawBrokenCircle,
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
        anchor: "map",
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
});

describe("course map SVG generators", () => {
  it("shares leg clipping, fractional gaps and circle slits", () => {
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
    expect(
      drawBrokenCircle(10, 10, 2.5, [{ start: 0, end: 90 }]).match(/ A/g),
    ).toHaveLength(1);
  });

  it("renders true-size course symbols, numbers, finish and slit gaps", () => {
    const svg = renderCourseOverlaySvg({
      frame: document.mapFrame,
      window: { minX: 0, minY: 0, width: 100, height: 100 },
      appearance: document.appearance,
      controls: [
        { id: "s", code: "S", type: "start", x: 10, y: 10 },
        {
          id: "31",
          code: "31",
          type: "control",
          x: 40,
          y: 40,
          cuts: [{ start: 350, end: 10 }],
        },
        { id: "f", code: "F", type: "finish", x: 80, y: 80 },
      ],
      legs: [
        {
          points: [{ x: 10, y: 10 }, { x: 40, y: 40 }],
          gaps: [{ from: 0.4, to: 0.6 }],
        },
        { points: [{ x: 40, y: 40 }, { x: 80, y: 80 }] },
      ],
    });
    const { lower, upper } = svg;
    expect(lower).toContain('data-map-layer="course-overlay-lower"');
    expect(upper).toContain('data-map-layer="course-overlay-upper"');
    expect(lower).toContain('stroke-width="0.35"');
    expect(lower).toContain('data-control-code="31"');
    expect(lower).toContain("<path");
    expect(upper).toContain(">1</text>");
    expect(lower.match(/<circle/g)).toHaveLength(2);
    expect(lower).not.toContain("mix-blend-mode");
    expect(upper).not.toContain("mix-blend-mode");
    expect(lower).not.toContain("opacity=");
    // ISOM 704: Arial (Liberation Sans), non-bold — in the upper layer.
    expect(upper).not.toContain("font-weight");
    // font-size is scaled up from the digit height by the cap-height ratio.
    const labelFontSize =
      document.appearance.numberHeightMm / (1409 / 2048);
    expect(upper).toContain(`font-size="${labelFontSize}"`);
    // Always-on white halo keeps numbers readable over map ink.
    expect(upper).toContain('data-control-label="31"');
    expect(upper).toContain('stroke="#fff"');
    expect(upper).toContain(`stroke-width="${labelFontSize * 0.12}"`);
    expect(upper).toContain('paint-order="stroke fill"');
    expect(lower).toContain("<line");
    expect(lower).toContain('data-leg-gapped="true"');
    expect(lower).not.toContain("<polyline");
  });

  it("enlarges the overprint with the map (ISOM enlargement factor)", () => {
    const options = {
      frame: document.mapFrame,
      window: { minX: 0, minY: 0, width: 100, height: 100 },
      appearance: document.appearance,
      controls: [
        {
          id: "31",
          code: "31",
          type: "control" as const,
          x: 40,
          y: 40,
        },
        { id: "f", code: "F", type: "finish" as const, x: 80, y: 80 },
      ],
      legs: [],
    };
    // 1:15000 base map printed at 1:7500 doubles every overprint dimension.
    const enlarged = renderCourseOverlaySvg({ ...options, overprintScale: 2 });
    expect(enlarged.lower).toContain('stroke-width="0.7"');
    expect(enlarged.upper).toContain(
      `font-size="${(document.appearance.numberHeightMm * 2) / (1409 / 2048)}"`,
    );
    expect(enlarged.lower).toContain('r="6"'); // finish outer 3 mm -> 6 mm
    expect(enlarged.lower).toContain('r="4"'); // finish inner 2 mm -> 4 mm
    // Default factor 1 keeps ISOM base dimensions.
    const plain = renderCourseOverlaySvg(options);
    expect(plain.lower).toContain('stroke-width="0.35"');
    expect(plain.lower).toContain('r="3"');
  });

  it("renders descriptions with symbols and escaped text", () => {
    const svg = renderDescriptionBlockSvg({
      x: 10,
      y: 10,
      cellSizeMm: 6,
      title: "A & B",
      rows: [
        {
          sequence: 1,
          code: "31",
          description: { d: "2.004", s: "1,5" },
        },
      ],
      symbolResolver: (key) =>
        key === "2.4" ? '<circle cx="0" cy="0" r="40"/>' : null,
    });
    expect(svg).toContain("A &amp; B");
    expect(svg).toContain('viewBox="-100 -100 200 200"');
    expect(svg).toContain("1.5m");
    expect(svg).toContain(">31</text>");
  });

  it("renders page and map anchored objects in layer order", () => {
    const svg = renderMapObjectsSvg({
      objects: [
        {
          id: "w",
          kind: "rectangle",
          anchor: "map",
          x: 10,
          y: 10,
          width: 20,
          height: 10,
          fillMode: "whiteout",
        },
        {
          id: "t",
          kind: "text",
          anchor: "page",
          x: 5,
          y: 6,
          text: "{course} & {scale}",
          fontSizeMm: 4,
          color: "#000000",
          fontFamily: "serif",
        },
        {
          id: "r",
          kind: "rectangle",
          anchor: "page",
          x: 20,
          y: 20,
          width: 30,
          height: 10,
          stroke: "#112233",
          strokeWidthMm: 0.3,
          fill: "#abcdef",
          fillMode: "solid",
        },
      ],
      frame: document.mapFrame,
      window: { minX: 0, minY: 0, width: 100, height: 100 },
      textValues: { course: "Blue", scale: "1:7500" },
    });
    expect(svg.indexOf('data-object-id="w"')).toBeLessThan(
      svg.indexOf('data-object-id="t"'),
    );
    expect(svg).toContain("Blue &amp; 1:7500");
    expect(svg).toContain('font-family="Liberation Serif, Times New Roman, serif"');
    expect(svg).toContain('fill="#abcdef"');
    expect(svg).toContain('fill="#ffffff"');
  });

  it("renders straight and cubic paths plus whiteout and out-of-bounds fills", () => {
    expect(
      pathData([
        { x: 0, y: 0 },
        { x: 10, y: 5 },
      ]),
    ).toBe("M 0 0 L 10 5");

    const svg = renderMapObjectsSvg({
      objects: [
        {
          id: "curve",
          kind: "path",
          anchor: "page",
          points: [
            { x: 0, y: 0, hOut: { x: 2, y: 3 } },
            { x: 10, y: 5, hIn: { x: -4, y: 1 } },
          ],
          stroke: "#123456",
          strokeWidthMm: 0.4,
          fill: "#abcdef",
          fillMode: "solid",
          closed: false,
        },
        {
          id: "white",
          kind: "path",
          anchor: "page",
          points: [
            { x: 1, y: 1, hOut: { x: 1, y: 0 } },
            { x: 5, y: 1, hIn: { x: -1, y: 0 } },
            { x: 3, y: 5 },
          ],
          fillMode: "whiteout",
          closed: true,
        },
        {
          id: "oob",
          kind: "rectangle",
          anchor: "page",
          x: 40,
          y: 40,
          width: 20,
          height: 15,
          fillMode: "outOfBounds",
        },
      ],
      frame: document.mapFrame,
      window: { minX: 0, minY: 0, width: 100, height: 100 },
      overprintScale: 2,
      purple: "#a626ff",
    });
    expect(svg).toContain('d="M 0 0 C 2 3 6 6 10 5"');
    expect(svg).toContain('stroke="#123456"');
    expect(svg).toContain('fill="#abcdef"');
    expect(svg).toContain('data-object-id="white"');
    expect(svg).toContain('d="M 1 1 C 2 1 4 1 5 1 L 3 5 L 1 1 Z"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('id="oob-oob"');
    expect(svg).toContain('stroke-width="0.4"'); // 0.2 mm * overprintScale 2
    expect(svg).not.toContain("mix-blend-mode");
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

  it("allows map-anchored objects outside the printable area", () => {
    // They follow the terrain and are clipped to the map frame at print,
    // so a moved window pushing them off-page is fine by design.
    const result = validateCourseMap({
      document: {
        ...document,
        objects: [
          {
            id: "terrain-whiteout",
            kind: "rectangle",
            anchor: "map",
            x: -500,
            y: -500,
            width: 20,
            height: 10,
            fillMode: "whiteout",
          },
        ],
      },
      mapScale: 7500,
      window: { minX: 0, minY: 0, width: 100, height: 100 },
      variants: [],
    });
    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ code: "object_outside_page" }),
    );
  });

  it("includes path vertices and handle control points in page bounds", () => {
    expect(
      courseMapObjectPageBounds(
        {
          id: "bounded",
          kind: "path",
          anchor: "map",
          points: [
            { x: 10, y: 10, hOut: { x: -5, y: 20 } },
            { x: 30, y: 20, hIn: { x: 15, y: -5 } },
          ],
          stroke: "#000000",
          strokeWidthMm: 0.3,
          fillMode: "none",
          closed: false,
        },
        { x: 0, y: 0, width: 100, height: 100 },
        { minX: 0, minY: 0, width: 50, height: 50 },
      ),
    ).toEqual({ x: 10, y: 40, width: 80, height: 40 });
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

describe("image layout objects", () => {
  const window: MapWindow = { minX: 0, minY: 0, width: 97, height: 140.5 };

  it("embeds sanitized SVG graphics inline and PNGs by href", () => {
    const objects: CourseMapObject[] = [
      {
        id: "svg-logo",
        kind: "image",
        anchor: "page",
        graphicId: 1,
        x: 10,
        y: 10,
        width: 30,
        height: 20,
        crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
      },
      {
        id: "png-logo",
        kind: "image",
        anchor: "page",
        graphicId: 2,
        x: 50,
        y: 10,
        width: 30,
        height: 20,
      },
    ];
    const svg = renderMapObjectsSvg({
      objects,
      frame: document.mapFrame,
      window,
      resolveGraphic: (graphicId) =>
        graphicId === 1
          ? {
              kind: "svg",
              svg: "<circle cx='5' cy='5' r='4' fill='#123456'/>",
              viewBox: "0 0 10 10",
              rootAttrs: 'xmlns="http://www.w3.org/2000/svg"',
            }
          : { kind: "href", href: "data:image/png;base64,AAAA" },
    });
    expect(svg).toContain("<circle cx='5' cy='5' r='4'");
    expect(svg).toContain('viewBox="0.1 0.2 0.5 0.6"');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('href="data:image/png;base64,AAAA"');
  });

  it("skips image objects whose graphic cannot be resolved", () => {
    const svg = renderMapObjectsSvg({
      objects: [
        {
          id: "gone",
          kind: "image",
          anchor: "page",
          graphicId: 99,
          x: 10,
          y: 10,
          width: 30,
          height: 20,
        },
      ],
      frame: document.mapFrame,
      window,
      resolveGraphic: () => null,
    });
    expect(svg).not.toContain("image");
    expect(svg).not.toContain("gone");
  });

  it("parses image objects through the schema", () => {
    const parsed = courseMapObjectSchema.parse({
      id: "img",
      kind: "image",
      anchor: "map",
      graphicId: 3,
      x: 12,
      y: 34,
      width: 20,
      height: 10,
    });
    expect(parsed).toMatchObject({ kind: "image", graphicId: 3 });
  });
});
