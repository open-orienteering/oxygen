import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { composeMapPageSvg } from "../course-maps/map-page-svg.js";
import {
  RsvgConverter,
  mergePdfPages,
} from "../course-maps/svg-to-pdf.js";
import { inflateUserSpacePatterns } from "../course-maps/map-source.js";
import { LruCache } from "../course-maps/lru-cache.js";

const document = {
  paper: "A4" as const,
  orientation: "portrait" as const,
  printScale: 7500,
  printMarginMm: 3,
  mapFrame: { x: 8, y: 8, width: 194, height: 281 },
  description: { visible: false, x: 150, y: 12, cellSizeMm: 6 },
  appearance: {
    purple: "#c026d3",
    circleRadiusMm: 2.5,
    lineWidthMm: 0.35,
    numberHeightMm: 3.5,
  },
  objects: [],
};

describe("map page SVG composition", () => {
  it("clips the base map and course to the frame in paper millimetres", () => {
    const svg = composeMapPageSvg({
      document,
      window: { minX: 0, minY: 0, width: 100, height: 100 },
      baseMap: {
        svg: inflateUserSpacePatterns(
          '<svg xmlns="http://www.w3.org/2000/svg" fill="transparent" viewBox="0 0 10000 10000"><defs><pattern id="marsh" patternUnits="userSpaceOnUse" width="10" height="30"><rect width="10" height="10" fill="#00b9f2"/></pattern></defs><path id="terrain" d="M0 0" style="fill: url(#marsh)"/></svg>',
        ),
        rootViewBox: { minX: 0, minY: 0, width: 10000, height: 10000 },
        ocadBounds: [0, 0, 10000, 10000],
      },
      controls: [
        { id: "31", code: "31", type: "control", x: 50, y: 50 },
      ],
      legs: [],
      descriptionRows: [],
      title: "Blue",
      textValues: {},
    });
    expect(svg).toContain('width="210mm" height="297mm"');
    expect(svg).toContain('clipPath id="map-frame-clip"');
    expect(svg).toContain('viewBox="0 0 10000 10000"');
    // The 100 mm square window renders at the frame's uniform scale
    // (194 / 100), centred in the frame by renderBaseMapWindow.
    expect(svg).toContain(
      'width="194" height="194" viewBox="0 0 10000 10000" fill="transparent"',
    );
    expect(svg).toContain('id="terrain"');
    expect(svg).toContain('data-map-layer="course-overlay"');
    expect(svg).toContain('data-pattern-tile="7-7"');
  });
});

describe("OCAD pattern compatibility", () => {
  it("inflates user-space pattern tiles with clipped copies", () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg"><defs>' +
      '<pattern id="marsh" patternUnits="userSpaceOnUse" patternTransform="rotate(15)" width="10" height="30">' +
      '<path d="M -5 5 H 15" stroke="#00b9f2"/>' +
      "</pattern></defs></svg>";

    const inflated = inflateUserSpacePatterns(source, 8);

    expect(inflated).toContain('patternTransform="rotate(15)"');
    expect(inflated).toContain('width="80"');
    expect(inflated).toContain('height="240"');
    expect(inflated.match(/data-pattern-tile=/g)).toHaveLength(64);
    expect(inflated).toContain('viewBox="0 0 10 30"');
    expect(inflated).toContain('overflow="hidden"');
  });

  it("leaves object-bounding-box patterns unchanged", () => {
    const source =
      '<svg xmlns="http://www.w3.org/2000/svg"><defs>' +
      '<pattern id="other" patternUnits="objectBoundingBox" width="0.5" height="0.5"/>' +
      "</defs></svg>";

    expect(inflateUserSpacePatterns(source, 8)).toContain('width="0.5"');
  });
});

describe("course-map render cache", () => {
  it("promotes hits and evicts the least recently used entry", () => {
    const cache = new LruCache<string>(2);
    cache.set("a", "A");
    cache.set("b", "B");
    expect(cache.get("a")).toBe("A");
    cache.set("c", "C");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(cache.get("c")).toBe("C");
  });

  it("also evicts entries when the byte budget is exceeded", () => {
    const cache = new LruCache<Buffer>(10, 5, (value) => value.byteLength);
    cache.set("a", Buffer.alloc(3));
    cache.set("b", Buffer.alloc(3));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toHaveLength(3);
  });
});

describe("SVG to PDF conversion", () => {
  it("pipes SVG to rsvg-convert with vector PDF output", async () => {
    const run = vi.fn(async () => Buffer.from("%PDF-test"));
    const converter = new RsvgConverter({ run });
    await expect(converter.convert("<svg/>")).resolves.toEqual(
      Buffer.from("%PDF-test"),
    );
    expect(run).toHaveBeenCalledWith(
      "rsvg-convert",
      ["--format=pdf"],
      Buffer.from("<svg/>"),
      30_000,
    );
  });

  it("merges one-page PDFs in order", async () => {
    const one = await PDFDocument.create();
    one.addPage([100, 200]);
    const two = await PDFDocument.create();
    two.addPage([300, 400]);
    const merged = await mergePdfPages([
      Buffer.from(await one.save()),
      Buffer.from(await two.save()),
    ]);
    const loaded = await PDFDocument.load(merged);
    expect(loaded.getPageCount()).toBe(2);
    expect(loaded.getPage(0).getSize()).toEqual({ width: 100, height: 200 });
    expect(loaded.getPage(1).getSize()).toEqual({ width: 300, height: 400 });
  });
});
