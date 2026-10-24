import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { render } from "@oxygen/shared";
import { CLOSE_INK_RATIO, rankRows, runParity, sanctionedFor, snapWindow, unexplainedPixels, type ParityReport, type ParityRow, type RgbaImage } from "../parity.js";
// @ts-expect-error — plain ESM fixture writer without types (scripts/lib).
import { buildParityOcad, PARITY_OCAD } from "../../../../../scripts/lib/ocad-fixture.mjs";

const testOcd = readFileSync(new URL("../../../../../e2e/test.ocd", import.meta.url));
const byCode = (r: ParityReport) => new Map(r.rows.map((x) => [x.code, x]));
const black = (img: RgbaImage) => {
  let n = 0;
  for (let o = 0; o < img.pixels.length; o += 4) if (img.pixels[o] < 80 && img.pixels[o + 1] < 80 && img.pixels[o + 2] < 80) n++;
  return n;
};

describe("corpus parity — e2e/test.ocd (docs/map-rendering.md §6.4)", () => {
  let report: ParityReport;
  let source: ParityReport;
  beforeAll(async () => {
    report = await runParity(testOcd, "test.ocd", { keepImages: true });
    source = await runParity(testOcd, "test.ocd", { canonical: false });
  }, 60_000);

  it("renders both sides on the same pixel grid as the window at the golden density", () => {
    const w = report.window;
    expect(report.pxPerMm).toBe(10);
    expect(report.size).toEqual({ width: (w.maxX - w.minX) * 10, height: (w.maxY - w.minY) * 10 });
    for (const r of report.rows.filter((x) => x.images)) {
      for (const img of [r.images!.old, r.images!.new, r.images!.diff]) expect([img.width, img.height]).toEqual([report.size.width, report.size.height]);
    }
  });

  it("isolates one symbol per row: the yellow area has no black ink on either side", () => {
    const area = byCode(report).get("403.0")!;
    expect(black(area.images!.old)).toBe(0);
    expect(black(area.images!.new)).toBe(0);
    expect(black(byCode(report).get("505.0")!.images!.old)).toBeGreaterThan(0);
  });

  it("finds the paths, areas, points and rings of the fixture in agreement — rings at the OCAD 9 diameter (B9)", () => {
    for (const code of ["505.0", "403.0", "521.0", "601.0", "701.0", "702.0", "706.0", "204.0"]) {
      const r = byCode(source).get(code)!;
      expect(r.verdict, code).toBe("close");
      expect(r.diff!.unexplained, code).toBe(0);
    }
  });

  it("marks the rectangle frame, which the legacy never draws, as a sanctioned divergence", () => {
    const frame = byCode(report).get("850.1")!;
    expect(frame.verdict).toBe("diverges");
    expect(frame.sanctioned).toContain("rectangle-symbols");
    expect(black(frame.images!.old)).toBe(0);
    expect(byCode(report).get("603.0")!.sanctioned).toEqual(["text-fonts"]);
  });

  it("reports the drawing source: canonical where matched, source definitions with canonical rendering off", () => {
    expect(report.canonical).toBe(true);
    expect(byCode(report).get("706.0")).toMatchObject({ state: "canonical", canonicalId: "ISOM2017-2:706" });
    expect(source.rows.every((r) => r.state !== "canonical")).toBe(true);
  });

  it("ranks the compared rows most divergent first", () => {
    const compared = report.rows.filter((r) => r.diff);
    expect(compared[0].code).toBe("850.1");
    for (let i = 1; i < compared.length; i++) expect(compared[i - 1].diff!.unexplainedRatio).toBeGreaterThanOrEqual(compared[i].diff!.unexplainedRatio);
    expect(report.rows.slice(compared.length).every((r) => !r.diff)).toBe(true);
  });

  it("restricts to the given codes and a window", async () => {
    const r = await runParity(testOcd, "test.ocd", { codes: ["505.0"], window: { minX: -10.4, minY: -10, maxX: 10, maxY: 10.2 } });
    expect(r.rows.map((x) => x.code)).toEqual(["505.0"]);
    expect(r.window).toEqual({ minX: -11, minY: -10, maxX: 10, maxY: 11 });
  });
});

describe("corpus parity — OCAD power line (510 corner symbol, B9)", () => {
  it("draws the poles at the corner points only, as the legacy does", async () => {
    const r = await runParity(buildParityOcad(), "parity.ocd", { canonical: false, keepImages: true, window: { minX: -25, minY: -15, maxX: 25, maxY: 5 } });
    const power = byCode(r).get("510.0")!;
    expect(power.verdict).toBe("close");
    expect(power.diff!.unexplained).toBe(0);
    // Pole ink 0.25 mm off the line (poles reach 0.37 mm, the line 0.07 mm) at the two corner points, none at the plain ends.
    const ink = (img: RgbaImage, xMm: number, yMm: number) => {
      const px = Math.floor((xMm - r.window.minX) * r.pxPerMm), py = Math.floor((r.window.maxY - yMm) * r.pxPerMm);
      return img.pixels[(py * img.width + px) * 4] < 128;
    };
    const tip = PARITY_OCAD.power.pole[1][1] / 100 - 0.12;
    for (const img of [power.images!.old, power.images!.new]) {
      expect(ink(img, -7, tip)).toBe(true);
      expect(ink(img, 6, tip)).toBe(true);
      expect(ink(img, -19.9, tip)).toBe(false);
      expect(ink(img, 19.9, tip)).toBe(false);
    }
  }, 60_000);
});

describe("parity helpers", () => {
  const img = (w: number, h: number, dark: (x: number, y: number) => boolean): RgbaImage => {
    const pixels = new Uint8Array(w * h * 4).fill(255);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (dark(x, y)) pixels.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
    return { width: w, height: h, pixels };
  };

  it("counts shape differences, not a one-pixel shift", () => {
    const line = img(20, 20, (x) => x === 8);
    expect(unexplainedPixels(line, line)).toBe(0);
    expect(unexplainedPixels(line, img(20, 20, (x) => x === 9))).toBe(0);
    expect(unexplainedPixels(line, img(20, 20, (x) => x === 12))).toBe(40);
    expect(unexplainedPixels(line, img(20, 20, (x, y) => x === 8 && y < 10))).toBe(9);
  });

  it("does not count a tone on the ink threshold that differs by less than the channel tolerance (C7)", () => {
    // Crop-A's 214.0: the same area at 206 and at 207 — deviation 49 is ink, 48 is not.
    const tone = (v: number): RgbaImage => ({ width: 4, height: 4, pixels: new Uint8Array(64).map((_, i) => (i % 4 === 3 ? 255 : v)) });
    expect(unexplainedPixels(tone(206), tone(207))).toBe(0);
    expect(unexplainedPixels(tone(180), tone(255))).toBe(16);
  });

  it("snaps the window outwards to whole mm", () => {
    expect(snapWindow({ minX: -1.2, minY: 0.5, maxX: 3.01, maxY: 4 })).toEqual({ minX: -2, minY: 0, maxX: 4, maxY: 4 });
  });

  it("tags sanctioned differences from the IR and the objects' flags", () => {
    const F = render.COORD_FLAG;
    const glyph = { rotatable: true, parts: [{ kind: "disc" as const, colour: 0, diameterUm: 200 }] };
    const sym = render.parseRenderSymbol({ type: "line", id: "x", code: "x", name: "x", main: { colour: 0, widthUm: 100 }, glyphs: [{ glyph, placement: { at: "spaced", distanceUm: 500 } }] });
    const curved: render.RenderObject = { symbolIdx: 0, path: { coords: new Int32Array([0, 0, 1, 1, 2, 2, 3, 3]), flags: new Uint8Array([0, F.bezierFirst, F.bezierSecond, 0]), closed: false } };
    expect(sanctionedFor(sym, [curved])).toEqual(["curve-glyphs", "glyph-spacing"]);
    const pole = render.parseRenderSymbol({ type: "line", id: "p", code: "p", name: "p", main: { colour: 0, widthUm: 140 }, glyphs: [{ glyph, placement: { at: "corners" } }] });
    const flaggedEnd: render.RenderObject = { symbolIdx: 0, path: { coords: new Int32Array([0, 0, 1000, 0, 2000, 0]), flags: new Uint8Array([0, F.corner, F.corner]), closed: false } };
    expect(sanctionedFor(pole, [flaggedEnd])).toEqual(["corner-angle", "corner-ends"]);
    expect(sanctionedFor(pole, [{ ...flaggedEnd, path: { ...flaggedEnd.path, flags: new Uint8Array([0, F.corner, 0]) } }])).toEqual(["corner-angle"]);
    const text = render.parseRenderSymbol({ type: "text", id: "t", code: "t", name: "t", fontFamily: "liberation-sans", fontSizeUm: 1000, colour: 0 });
    expect(sanctionedFor(text, [])).toEqual(["text-fonts"]);
  });

  it("orders compared rows by unexplained ratio, then the rest by code", () => {
    const row = (code: string, u?: number): ParityRow => ({
      code, name: "", kind: "line", objects: 1, state: "source", sanctioned: [],
      ...(u === undefined ? {} : { diff: { differing: 0, total: 1, ratio: 0, ink: 1, inkRatio: u, unexplained: u, unexplainedRatio: u } }),
    });
    expect([row("510.0"), row("201.4", 0.02), row("102.1", 0.5), row("101.1")].sort(rankRows).map((r) => r.code)).toEqual(["102.1", "201.4", "101.1", "510.0"]);
    expect(CLOSE_INK_RATIO).toBe(0.1);
  });
});
