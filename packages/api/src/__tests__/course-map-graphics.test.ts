/** Graphic uploads (docs/course-maps.md, graphics): type, size and SVG safety. */
import { describe, expect, it } from "vitest";
import type { PrintSheet } from "@oxygen/shared/print";
import {
  validateGraphicUpload,
  MAX_GRAPHIC_BYTES,
  parseRasterBox,
  sheetGraphicIds,
} from "../course-maps/graphics.js";

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

  it("accepts an Inkscape SVG with metadata and foreign namespaces", () => {
    const inkscape = Buffer.from(`<?xml version="1.0"?>
<!DOCTYPE svg>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 20 20">
  <metadata><rdf:RDF><rdf:Description/></rdf:RDF></metadata>
  <!-- club mark -->
  <circle cx="10" cy="10" r="8" fill="#336699"/>
</svg>`);
    expect(validateGraphicUpload(inkscape)).toBe("image/svg+xml");
  });

  it("accepts an SVG with width and height but no viewBox", () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12"><rect width="24" height="12"/></svg>`,
    );
    expect(validateGraphicUpload(svg)).toBe("image/svg+xml");
  });
});

describe("print.png's box (docs/course-print.md §8.5)", () => {
  it("takes integers 1–4096 for both sides, else the 400 message", () => {
    expect(parseRasterBox("473", "236")).toEqual([473, 236]);
    expect(parseRasterBox("1", "4096")).toEqual([1, 4096]);
    for (const [w, h] of [[undefined, undefined], ["10", undefined], ["0", "10"], ["4097", "10"], ["1.5", "2"], ["-3", "2"], ["ten", "2"], ["", "2"], ["1e3", "2"]] as const) {
      expect(parseRasterBox(w, h)).toBe("w and h must be integers 1–4096 for an SVG graphic");
    }
  });
});

describe("the graphics a print needs (docs/course-print.md §8.5)", () => {
  // Regression: an image course object's graphic was not loaded (docs/bugfix-course-object-image-print.md).
  it("collects page objects' and image course objects' graphics, once each, ascending", () => {
    const sheet = (objects: unknown[], courseObjects?: unknown[]) =>
      ({ objects, course: courseObjects ? { objects: courseObjects } : {} }) as unknown as PrintSheet;
    const sheets = [
      sheet([{ kind: "image", graphicId: 9 }, { kind: "text" }], [{ kind: "image", props: { graphicId: 4 } }, { kind: "whiteout", props: {} }]),
      sheet([{ kind: "image", graphicId: 4 }]),
      sheet([], [{ kind: "image", props: { graphicId: 12, crop: { x: 0, y: 0, width: 1, height: 1 } } }]),
    ];
    expect(sheetGraphicIds(sheets)).toEqual([4, 9, 12]);
    expect(sheetGraphicIds([sheet([])])).toEqual([]);
  });
});
