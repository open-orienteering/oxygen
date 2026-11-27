/** Graphic uploads (docs/course-maps.md, graphics): type, size and SVG safety. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PrintSheet } from "@oxygen/shared/print";
import {
  validateGraphicUpload,
  MAX_GRAPHIC_UPLOAD_BYTES,
  parseRasterBox,
  sheetGraphicIds,
} from "../course-maps/graphics.js";
import { rasteriseSvgGraphic } from "../course-maps/pdf-page.js";
import { analyseSvg } from "../course-maps/svg-sanitize.js";

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

describe("SVG graphic safety (parser-based validation, docs/course-maps.md \"SVG validation\")", () => {
  const NS = `xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`;
  const svg = (inner: string, head = "") => Buffer.from(`${head}<svg ${NS} viewBox="0 0 10 10">${inner}</svg>`);
  const ent = (decls: string) => `<!DOCTYPE svg [${decls}]>`;
  const rect = `<rect width="1" height="1"/>`;

  it("refuses what the old pattern checks missed, and what a parser reads differently", () => {
    const cases: Array<[string, Buffer, string | RegExp]> = [
      // Comment / CDATA quote desync hiding a local-file image.
      ["an image after a comment holding a quote", svg(`<g><!-- " --><image href="/etc/hostname" width="1" height="1"/></g>`), "external references"],
      ["an image after CDATA holding a quote", svg(`<style><![CDATA[ a{content:"} ]]></style><image href="/etc/hostname" width="1" height="1"/>`), "external references"],
      ["an image after a CDATA holding a comment opener", svg(`<style><![CDATA[ <!-- ]]></style><image href="/etc/hostname"/><!-- -->`), "external references"],
      // Entities.
      ["a duplicate entity (last wins)", svg(`<image href="&u;"/>`, ent(`<!ENTITY u "#a"><!ENTITY u "http://host/x.png">`)), "custom entities"],
      ["a duplicate entity (first wins)", svg(`<image href="&u;"/>`, ent(`<!ENTITY u "http://host/x.png"><!ENTITY u "#a">`)), "custom entities"],
      ["a non-ASCII entity name", svg(`<image href="&é;"/>`, ent(`<!ENTITY é "http://host/x.png">`)), "custom entities"],
      ["an entity in text", svg(`<text>&x;</text>`, ent(`<!ENTITY x "a">`)), "custom entities"],
      ["an undeclared entity", svg(`<text>&nope;</text>`), "custom entities"],
      ["an entity expanding to markup", svg(`&x;`, ent(`<!ENTITY x "&#60;script>alert(1)&#60;/script>">`)), /custom entities|malformed/],
      ["an entity in xmlns that is undeclared", Buffer.from(`<svg xmlns="&nope;" viewBox="0 0 1 1"/>`), "custom entities"],
      // DOCTYPE shapes.
      ["a parameter entity", svg(``, ent(`<!ENTITY % p "x">`)), "DOCTYPE"],
      ["an external entity", svg(``, ent(`<!ENTITY x SYSTEM "file:///etc/passwd">`)), "DOCTYPE"],
      ["a public entity", svg(``, ent(`<!ENTITY x PUBLIC "a" "file:///etc/passwd">`)), "DOCTYPE"],
      ["an ATTLIST", svg(``, ent(`<!ATTLIST svg x CDATA "1">`)), "DOCTYPE"],
      ["an ELEMENT declaration", svg(``, ent(`<!ELEMENT svg ANY>`)), "DOCTYPE"],
      ["a NOTATION", svg(``, ent(`<!NOTATION n SYSTEM "x">`)), "DOCTYPE"],
      ["a comment-wrapped declaration after a decoy ]>", svg(``, ent(`<!-- ]> --><!ATTLIST svg x CDATA "1">`)), "DOCTYPE"],
      ["two DOCTYPEs", svg(``, `<!DOCTYPE svg><!DOCTYPE svg>`), "DOCTYPE"],
      // Prolog.
      ["a UTF-16 encoding declaration", Buffer.from(`<?xml version="1.0" encoding="UTF-16"?><svg ${NS} viewBox="0 0 1 1"/>`), "encoding"],
      ["a Latin-1 encoding declaration", Buffer.from(`<?xml version="1.0" encoding="ISO-8859-1"?><svg ${NS} viewBox="0 0 1 1"/>`), "encoding"],
      ["a control character", svg(`<text>a\u0001b</text>`), "control characters"],
      ["a NUL", svg(`<text>a\u0000b</text>`), "control characters"],
      ["a stylesheet instruction", svg(``, `<?xml-stylesheet href="#s" type="text/xsl"?>`), "processing instructions"],
      ["a processing instruction in the body", svg(`<?foo bar?>`), "processing instructions"],
      ["a second XML declaration", svg(``, `<?xml version="1.0"?><?xml version="1.0"?>`), "processing instructions"],
      ["ill-formed markup", Buffer.from(`<svg ${NS} viewBox="0 0 1 1"><g></svg>`), "malformed"],
      ["a bare ampersand", svg(`<text>a & b</text>`), "malformed"],
      // Elements.
      ["a script", svg(`<script>alert(1)</script>`), "script"],
      ["a script inside metadata", svg(`<metadata><script>alert(1)</script></metadata>`), "script"],
      ["a prefixed script", svg(`<s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script>`), "script"],
      ["a script spelled in character data of a comment-free tag", svg(`<SCRIPT>alert(1)</SCRIPT>`), "SCRIPT"],
      ["iframe", svg(`<iframe src="#a"/>`), "iframe"],
      ["foreignObject", svg(`<foreignObject><p/></foreignObject>`), "foreignObject"],
      ["a handler element", svg(`<handler/>`), "handler"],
      ["a listener element", svg(`<listener/>`), "listener"],
      ["an xsl element", svg(`<xsl:stylesheet xmlns:xsl="urn:x"/>`), "XSLT"],
      ["the XSLT namespace", svg(`<g xmlns:q="http://www.w3.org/1999/XSL/Transform"/>`), "XSLT"],
      ["a non-svg root", Buffer.from(`<p>not svg</p>`), "root element"],
      // Attributes.
      ["an event handler", svg(`<rect onload="x()" width="1" height="1"/>`), "event handler"],
      ["an upper-case event handler", svg(`<rect ONCLICK="x()" width="1" height="1"/>`), "event handler"],
      ["a prefixed event handler", svg(`<rect x:onclick="x()" xmlns:x="urn:x"/>`), "event handler"],
      ["a javascript: href", svg(`<a href="javascript:alert(1)"/>`), "external references"],
      ["a split javascript: scheme", svg(`<a xlink:href="java&#115;cript:alert(1)"/>`), "external references"],
      ["a protocol-relative href", svg(`<image href="//host/x.png"/>`), "external references"],
      ["a path href", svg(`<image href="/etc/x.png"/>`), "external references"],
      ["a relative href", svg(`<image href="x.png"/>`), "external references"],
      ["an https xlink:href", svg(`<image xlink:href="https://host/x.png"/>`), "external references"],
      ["a src attribute", svg(`<image src="x.png"/>`), "external references"],
      ["an svg data href", svg(`<image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/>`), "external references"],
      // Animations that set a link.
      ["<set> on href", svg(`<image href="#a"><set attributeName="href" to="http://host/x.png"/></image>`), "animations"],
      ["<animate> on xlink:href", svg(`<image href="#a"><animate attributeName="xlink:href" values="#a;http://host/x.png" dur="1s"/></image>`), "animations"],
      ["<set> on an event handler", svg(`<rect><set attributeName="onclick" to="x()"/></rect>`), "animations"],
      ["<animate> values to a URL", svg(`<rect><animate attributeName="fill" values="red;http://host/x" dur="1s"/></rect>`), "external references"],
      ["<animate> from a path", svg(`<rect><animate attributeName="fill" from="/etc/x" to="red" dur="1s"/></rect>`), "external references"],
      // CSS.
      ["a url() to a host", svg(`<rect fill="url(http://host/x)" width="1" height="1"/>`), "external references"],
      ["a url() to a path", svg(`<rect style="fill:url('/x')" width="1" height="1"/>`), "external references"],
      ["a CSS escape in a style attribute", svg(`<rect style="fill:\\75rl(http://host/x)" width="1" height="1"/>`), "external references"],
      ["a CSS escape in a presentation attribute", svg(`<rect fill="\\75rl(http://host/x)" width="1" height="1"/>`), "external references"],
      ["a CSS escape in a style element", svg(`<style>.a{fill:\\75rl(http://host/x)}</style>`), "external references"],
      ["a CSS escape spelling @import", svg(`<style>@\\69mport "x.css";</style>`), "@import"],
      ["a closing tag with a space", svg(`<style>.a{fill:url(http://host/x)}</style ><rect/>`), "external references"],
      ["a prefixed style element", svg(`<s:style xmlns:s="http://www.w3.org/2000/svg">.a{fill:url(http://host/x)}</s:style>`), "external references"],
      ["a url() hidden after an escaped comment opener", svg(`<style>.a{content:\\/* ; fill:url(http://host/x)} /* */</style>`), "external references"],
      ["an unterminated url(", svg(`<style>.a{fill:url(http://host/x}</style>`), "external references"],
      ["@import", svg(`<style>@import "x.css";</style>`), "@import"],
      ["@import inside CDATA", svg(`<style><![CDATA[@import "x.css";]]></style>`), "@import"],
      ["image-set()", svg(`<style>.a{background:image-set("x.png" 1x)}</style>`), "image-set"],
      ["expression()", svg(`<rect style="width:expression(alert(1))"/>`), "expression"],
      ["javascript: in CSS", svg(`<style>.a{background:url(javascript:alert(1))}</style>`), "javascript"],
      ["a url() whose entity-free value is an svg data URL", svg(`<rect style="fill:url(data:image/svg+xml;base64,AAAA)"/>`), "external references"],
    ];
    for (const [name, data, reason] of cases) {
      expect(() => validateGraphicUpload(data), name).toThrow(reason);
    }
  });

  it("accepts local references, embedded rasters and fonts, and the exporters' documents", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(validateGraphicUpload(svg(`<defs><linearGradient id="a"/></defs><use xlink:href="#a"/><rect fill="url(#a)" width="1" height="1"/>`))).toBe("image/svg+xml");
    expect(validateGraphicUpload(svg(`<image href="${png}" width="1" height="1"/>`))).toBe("image/svg+xml");
    expect(validateGraphicUpload(svg(`<image xlink:href='data:image/jpeg;charset=x;base64,/9j/4AAQ' width="1" height="1"/>`))).toBe("image/svg+xml");
    expect(validateGraphicUpload(svg(`<use href= "#a"/><use xlink:href ='#a'/>`))).toBe("image/svg+xml");
    expect(validateGraphicUpload(svg(`<rect fill="url(&quot;#c&quot;)" width="1" height="1"/>`))).toBe("image/svg+xml");
    expect(validateGraphicUpload(svg(`<style>@font-face{font-family:F;src:url(data:font/woff2;base64,d09GMg==)}@font-face{font-family:G;src:url(data:application/font-woff;base64,d09GRg==)}@font-face{font-family:H;src:url('data:application/x-font-ttf;base64,AAEAAA==')}@font-face{font-family:I;src:url(data:application/octet-stream;charset=binary;base64,T1RUTw==)}</style>`))).toBe("image/svg+xml");
    expect(validateGraphicUpload(svg(`<style><![CDATA[@font-face{font-family:I;src:url(data:font/otf;base64,T1RUTw==)}]]></style>`))).toBe("image/svg+xml");
    expect(validateGraphicUpload(svg(`<text>the src=x note, url(http://host/x) and javascript: are text</text>`))).toBe("image/svg+xml");
    expect(validateGraphicUpload(svg(`<text style="font-family:'Foo\\ Bar'">x</text><text style='font-family:"Foo\\ Bar"'>y</text>`))).toBe("image/svg+xml");
    expect(validateGraphicUpload(svg(`<style>.a{fill:#c00}</style><rect style="fill:#c00" width="1" height="1"/>`))).toBe("image/svg+xml");
    expect(validateGraphicUpload(svg(`<rect><animate attributeName="fill" values="red;#00f" dur="1s"/></rect>`))).toBe("image/svg+xml");
    // A comment, even one holding markup, is dropped, not read.
    expect(validateGraphicUpload(svg(`<!-- <script>alert(1)</script> -->${rect}`))).toBe("image/svg+xml");
    // Illustrator: namespace entities in xmlns values, a PUBLIC doctype, a CDATA style.
    const illustrator = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 27 -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
  <!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">
  <!ENTITY ns_ai "http://ns.adobe.com/AdobeIllustrator/10.0/">
  <!ENTITY ns_svg "http://www.w3.org/2000/svg">
  <!ENTITY ns_xlink "http://www.w3.org/1999/xlink">
]>
<svg version="1.1" xmlns:x="&ns_extend;" xmlns:i="&ns_ai;" xmlns="&ns_svg;" xmlns:xlink="&ns_xlink;" viewBox="0 0 100 50" i:viewOrigin="0 0">
<style type="text/css"><![CDATA[ .st0{fill:#FF0000;} ]]></style>
<rect class="st0" width="100" height="50"/></svg>`);
    const out = analyseSvg(illustrator);
    expect(out.canonical).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(out.canonical).not.toContain("&ns_");
    expect(out.canonical).not.toContain("DOCTYPE");
    // Inkscape: RDF metadata and foreign namespaces; OCAD-style plain document.
    expect(validateGraphicUpload(Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cc="http://creativecommons.org/ns#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:svg="http://www.w3.org/2000/svg" xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 20 20" inkscape:version="1.2">
<sodipodi:namedview id="nv" inkscape:zoom="1"/>
<metadata id="m"><rdf:RDF><cc:Work rdf:about=""><dc:format>image/svg+xml</dc:format></cc:Work></rdf:RDF></metadata>
<g inkscape:label="Layer 1"><circle cx="10" cy="10" r="8"/></g></svg>`))).toBe("image/svg+xml");
  });

  it("what is rendered is the re-serialised tree: a stored graphic that no longer validates renders as nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "svg-local-"));
    try {
      const file = join(dir, "secret.png");
      const sharp = (await import("sharp")).default;
      writeFileSync(file, await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer());
      const payload = Buffer.from(`<svg ${NS} viewBox="0 0 8 8"><g><!-- " --><image href="${file}" width="8" height="8"/></g></svg>`);
      expect(() => validateGraphicUpload(payload)).toThrow("external references");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const png = await rasteriseSvgGraphic(payload, 8, 8);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
      const raw = await sharp(png).ensureAlpha().raw().toBuffer();
      expect(raw.every((v) => v === 0)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the canonical text keeps what draws and drops what was only markup", () => {
    const out = analyseSvg(svg(`<!-- note --><text x="1" y="2">a &amp; b &lt; <![CDATA[c < d]]></text>`));
    expect(out.canonical).toBe(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><text x="1" y="2">a &amp; b &lt; c &lt; d</text></svg>`);
    expect(out.viewBox).toBe("0 0 10 10");
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
