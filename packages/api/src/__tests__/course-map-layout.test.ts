import { describe, expect, it } from "vitest";
import { resolveMapLayout } from "../course-maps/resolve-layout.js";
import {
  graphicToResolved,
  validateGraphicUpload,
  MAX_GRAPHIC_BYTES,
} from "../course-maps/graphics.js";

const template = {
  paper: "A4",
  orientation: "portrait",
  paperWidthMm: null,
  paperHeightMm: null,
  printScale: 7500,
  settings: {
    printMarginMm: 3,
    mapFrame: { x: 8, y: 8, width: 194, height: 281 },
    description: { visible: true, x: 150, y: 12, cellSizeMm: 6 },
    appearance: {
      purple: "#c026d3",
      circleRadiusMm: 2.5,
      lineWidthMm: 0.35,
      numberHeightMm: 3.5,
    },
  },
  objects: [],
};

const controls = [
  {
    id: "c1",
    seq: 1,
    codes: "31",
    xpos: 10,
    ypos: 20,
    description: { column_d: "boulder" },
  },
  {
    id: "c2",
    seq: 2,
    codes: "45;145",
    xpos: 30,
    ypos: 40,
    description: { column_d: "path" },
  },
];

describe("resolveMapLayout description rows", () => {
  it("builds sequenced rows with control descriptions for course maps", () => {
    const layout = resolveMapLayout({
      kind: "course",
      template,
      course: {
        name: "H40",
        lengthM: 3200,
        climbM: 40,
        controls,
      },
      mapScale: 15_000,
    });
    expect(layout.descriptionRows).toEqual([
      { sequence: 1, code: "31", description: { column_d: "boulder" } },
      { sequence: 2, code: "45", description: { column_d: "path" } },
    ]);
    expect(layout.textValues.controls).toBe("2");
  });

  it("builds unsequenced numerically sorted rows for all-controls maps", () => {
    const layout = resolveMapLayout({
      kind: "all_controls",
      template,
      allControls: [
        {
          id: "start",
          seq: 20,
          codes: "",
          status: "start",
          xpos: -5,
          ypos: -5,
          description: null,
        },
        { id: "b", seq: 2, codes: "100", xpos: 5, ypos: 5, description: null },
        { id: "a", seq: 1, codes: "31", xpos: 1, ypos: 1, description: null },
        {
          id: "finish",
          seq: 24,
          codes: "",
          status: "finish",
          xpos: 10,
          ypos: 10,
          description: null,
        },
        // Zero-position controls have no map placement and are skipped.
        { id: "z", seq: 3, codes: "99", xpos: 0, ypos: 0, description: null },
      ],
    });
    expect(layout.descriptionRows.map((row) => row.code)).toEqual([
      "31",
      "100",
    ]);
    expect(layout.descriptionRows[0]).not.toHaveProperty("sequence");
    expect(layout.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "start", code: "20", type: "start" }),
        expect.objectContaining({ id: "finish", code: "24", type: "finish" }),
      ]),
    );
    expect(layout.textValues.controls).toBe("2");
  });
});

describe("resolveMapLayout orientation", () => {
  it("counter-rotates the window by the in-paper meridian tilt", () => {
    const layout = resolveMapLayout({
      kind: "course",
      template,
      course: { name: "H40", lengthM: 0, climbM: 0, controls },
      mapScale: 15_000,
      meridianTiltDeg: 3.3,
    });
    // Print renders raw paper space, so only the drawing's own tilt is
    // compensated — NOT north_offset, whose true-north component applies
    // only to the tile pipeline's mercator-warped rasters.
    expect(layout.window.rotationDeg).toBe(-3.3);
    // ISOM overprint enlargement follows the print enlargement.
    expect(layout.overprintScale).toBeCloseTo(
      15_000 / layout.document.printScale,
      10,
    );
  });

  it("omits rotation for negligible or missing tilts", () => {
    for (const meridianTiltDeg of [null, 0, 0.04]) {
      const layout = resolveMapLayout({
        kind: "course",
        template,
        course: { name: "H40", lengthM: 0, climbM: 0, controls },
        mapScale: 15_000,
        meridianTiltDeg,
      });
      expect(layout.window.rotationDeg).toBeUndefined();
    }
  });
});

describe("graphic upload validation", () => {
  it("detects PNG by magic bytes and rejects empty or oversized files", () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.alloc(16),
    ]);
    expect(validateGraphicUpload(png)).toBe("image/png");
    expect(() => validateGraphicUpload(Buffer.alloc(0))).toThrow("empty");
    expect(() =>
      validateGraphicUpload(Buffer.alloc(MAX_GRAPHIC_BYTES + 1)),
    ).toThrow("limited");
  });

  it("accepts self-contained SVG and rejects active or external content", () => {
    const good = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>`,
    );
    expect(validateGraphicUpload(good)).toBe("image/svg+xml");

    const cases: Array<[string, string]> = [
      [
        `<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>`,
        "script",
      ],
      [
        `<svg viewBox="0 0 1 1"><rect onclick="x()" width="1" height="1"/></svg>`,
        "event handler",
      ],
      [
        `<svg viewBox="0 0 1 1"><image href="https://evil.example/x.png"/></svg>`,
        "external references",
      ],
      [`<svg><rect width="1" height="1"/></svg>`, "viewBox"],
      [`<p>not svg</p>`, "root element"],
    ];
    for (const [svg, reason] of cases) {
      expect(() => validateGraphicUpload(Buffer.from(svg))).toThrow(reason);
    }
  });

  it("strips Inkscape metadata and carries xmlns attrs for PDF embedding", () => {
    const inkscape = Buffer.from(`<?xml version="1.0"?>
<!DOCTYPE svg>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 20 20">
  <metadata><rdf:RDF><rdf:Description/></rdf:RDF></metadata>
  <!-- club mark -->
  <circle cx="10" cy="10" r="8" fill="#336699"/>
</svg>`);
    expect(validateGraphicUpload(inkscape)).toBe("image/svg+xml");
    const resolved = graphicToResolved("image/svg+xml", inkscape);
    expect(resolved).toMatchObject({ kind: "svg", viewBox: "0 0 20 20" });
    if (resolved?.kind !== "svg") throw new Error("expected svg");
    expect(resolved.svg).toContain("<circle");
    expect(resolved.svg).not.toContain("rdf:RDF");
    expect(resolved.svg).not.toContain("metadata");
    expect(resolved.rootAttrs).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(resolved.rootAttrs).toContain("xmlns:rdf=");
    expect(resolved.rootAttrs).toContain("xmlns:xlink=");
  });

  it("derives a viewBox from width and height when missing", () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12"><rect width="24" height="12"/></svg>`,
    );
    expect(validateGraphicUpload(svg)).toBe("image/svg+xml");
    expect(graphicToResolved("image/svg+xml", svg)).toEqual({
      kind: "svg",
      svg: `<rect width="24" height="12"/>`,
      viewBox: "0 0 24 12",
      rootAttrs: 'xmlns="http://www.w3.org/2000/svg"',
    });
  });

  it("resolves PNG to a data URI and unknown mimes to null", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]);
    expect(graphicToResolved("image/png", png)).toEqual({
      kind: "href",
      href: `data:image/png;base64,${png.toString("base64")}`,
    });
    expect(graphicToResolved("image/gif", png)).toBeNull();
    expect(graphicToResolved("image/svg+xml", Buffer.from("broken"))).toBeNull();
  });
});
