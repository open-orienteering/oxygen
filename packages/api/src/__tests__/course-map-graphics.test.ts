/** Graphic uploads (docs/course-maps.md, graphics): type, size and SVG safety. */
import { describe, expect, it } from "vitest";
import {
  validateGraphicUpload,
  MAX_GRAPHIC_BYTES,
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
