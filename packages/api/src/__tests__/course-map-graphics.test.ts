/** Graphic uploads (docs/course-maps.md, graphics): type, size and SVG safety. */
import { describe, expect, it } from "vitest";
import type { PrintSheet } from "@oxygen/shared/print";
import {
  validateGraphicUpload,
  MAX_GRAPHIC_UPLOAD_BYTES,
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
      validateGraphicUpload(Buffer.alloc(MAX_GRAPHIC_UPLOAD_BYTES + 1)),
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

describe("SVG graphic safety (CRS-003: nothing is stripped, the raw and the decoded text are both checked)", () => {
  const svg = (inner: string, head = "") =>
    Buffer.from(`${head}<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">${inner}</svg>`);

  it("refuses markup that only works once comments, metadata or entities are read", () => {
    const cases: Array<[string, Buffer, string]> = [
      ["script inside <metadata>", svg(`<metadata><script>alert(1)</script></metadata>`), "script"],
      ["script in a comment", svg(`<!-- <script>alert(1)</script> -->`), "script"],
      ["a character reference for <", svg(`&#60;script>alert(1)&#60;/script>`), "script"],
      ["an entity that expands to markup", svg(`&x;`, `<!DOCTYPE svg [<!ENTITY x "&#60;script>alert(1)&#60;/script>">]>`), "entity"],
      ["an entity that references another", svg(`&x;`, `<!DOCTYPE svg [<!ENTITY x "&y;">]>`), "entity"],
      ["a parameter entity", svg(``, `<!DOCTYPE svg [<!ENTITY % p "x">]>`), "entity"],
      ["an external entity", svg(`&x;`, `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>`), "entity"],
      ["a namespaced script", svg(`<s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script>`), "script"],
      ["iframe", svg(`<iframe src="#a"/>`), "iframe"],
      ["foreignObject", svg(`<foreignObject><p/></foreignObject>`), "foreignObject"],
      ["a split javascript: scheme", svg(`<a xlink:href="java&#115;cript:alert(1)"><rect width="1" height="1"/></a>`), "javascript"],
      ["a tab inside javascript:", svg(`<a href="java&#9;script:alert(1)"/>`), "javascript"],
      ["a protocol-relative href", svg(`<image href="//host/x.png"/>`), "external references"],
      ["a path href", svg(`<image href="/etc/x.png"/>`), "external references"],
      ["an https xlink:href", svg(`<image xlink:href="https://host/x.png"/>`), "external references"],
      ["an svg data href", svg(`<image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/>`), "external references"],
      ["a url() to a host", svg(`<rect fill="url(http://host/x)" width="1" height="1"/>`), "external references"],
      ["a url() to a path", svg(`<rect style="fill:url('/x')" width="1" height="1"/>`), "external references"],
      ["@import", svg(`<style>@import "x.css";</style>`), "@import"],
      ["an event handler", svg(`<rect onload="x()" width="1" height="1"/>`), "event handler"],
    ];
    for (const [name, data, reason] of cases) {
      expect(() => validateGraphicUpload(data), name).toThrow(reason);
    }
  });

  it("accepts local references, embedded rasters and a plain-URL entity (Illustrator)", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(validateGraphicUpload(svg(`<defs><linearGradient id="a"/></defs><use xlink:href="#a"/><rect fill="url(#a)" width="1" height="1"/>`))).toBe("image/svg+xml");
    expect(validateGraphicUpload(svg(`<image href="${png}" width="1" height="1"/>`))).toBe("image/svg+xml");
    expect(validateGraphicUpload(svg(`<image xlink:href='data:image/jpeg;base64,/9j/4AAQ' width="1" height="1"/>`))).toBe("image/svg+xml");
    expect(validateGraphicUpload(svg(``, `<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [<!ENTITY ns_svg "http://www.w3.org/2000/svg">]>`))).toBe("image/svg+xml");
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
  // Regression: an image course object's graphic was not loaded (docs/bugfixes/course-object-image-print.md).
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
