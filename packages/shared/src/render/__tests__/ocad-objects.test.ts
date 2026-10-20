import { describe, it, expect } from "vitest";
import { COORD_FLAG } from "../pass-stream.js";
import { ocadFlags, ocadObjectsToRender, ocadSymbolCode, type OcadObjectLike } from "../ocad-objects.js";
import { PILOT, pilotSymbols } from "../__fixtures__/pilot-symbols.js";

const pt = (x: number, y: number, xFlags = 0, yFlags = 0) => ({ 0: x, 1: y, xFlags, yFlags });

describe("ocadFlags", () => {
  it("maps OCAD x/y flag bits onto COORD_FLAG bit for bit", () => {
    expect(ocadFlags(0x01, 0)).toBe(COORD_FLAG.bezierFirst);
    expect(ocadFlags(0x02, 0)).toBe(COORD_FLAG.bezierSecond);
    expect(ocadFlags(0x04, 0)).toBe(COORD_FLAG.noLeft);
    expect(ocadFlags(0x08, 0)).toBe(COORD_FLAG.gap);
    expect(ocadFlags(0, 0x01)).toBe(COORD_FLAG.corner);
    expect(ocadFlags(0, 0x02)).toBe(COORD_FLAG.hole);
    expect(ocadFlags(0, 0x04)).toBe(COORD_FLAG.noRight);
    expect(ocadFlags(0, 0x08)).toBe(COORD_FLAG.dash);
    expect(ocadFlags(0x0f, 0x0f)).toBe(255);
  });

  it("derives the symbol code from sym / 1000, dropping the variant", () => {
    expect(ocadSymbolCode(505000)).toBe("505");
    expect(ocadSymbolCode(505001)).toBe("505");
    expect(ocadSymbolCode(101000)).toBe("101");
  });
});

describe("ocadObjectsToRender", () => {
  const objects: OcadObjectLike[] = [
    // 505 footpath, a Bézier with a dash point
    { sym: 505001, otp: 2, coordinates: [pt(0, 0), pt(100, 100, 1), pt(200, 100, 2), pt(300, 0, 0, 8)] },
    // 403 area with a hole
    { sym: 403000, otp: 3, coordinates: [pt(0, 0), pt(1000, 0), pt(1000, 1000), pt(0, 1000), pt(250, 250, 0, 2), pt(750, 250), pt(750, 750), pt(250, 750)] },
    // 418 tree, rotated 45°
    { sym: 418000, otp: 1, ang: 450, coordinates: [pt(500, 500)] },
    // 704 text
    { sym: 704000, otp: 4, text: "31", coordinates: [pt(600, 600)] },
    // unknown code
    { sym: 521000, otp: 2, coordinates: [pt(0, 0), pt(10, 10)] },
    // unknown area
    { sym: 405000, otp: 3, coordinates: [pt(0, 0), pt(10, 0), pt(10, 10)] },
    // code matches but kind disagrees: an area object on the line symbol 505
    { sym: 505000, otp: 3, coordinates: [pt(0, 0), pt(10, 0), pt(10, 10)] },
    // empty geometry
    { sym: 101000, otp: 2, coordinates: [] },
  ];

  it("pilot mode keeps matched objects, converts units and flags, drops the rest", () => {
    const r = ocadObjectsToRender(objects, pilotSymbols);
    expect(r.symbols).toEqual(pilotSymbols);
    expect(r.objects).toHaveLength(4);
    expect(r.stats).toMatchObject({ total: 8, matched: 4, proxied: 0, dropped: 4, coordinates: 14 });
    expect(r.stats.unmatched).toEqual([
      { code: "521", count: 1 },
      { code: "405", count: 1 },
      { code: "505", count: 1 },
    ]);

    const path505 = r.objects[0];
    expect(path505.symbolIdx).toBe(PILOT.footpath505);
    expect(Array.from(path505.path.coords)).toEqual([0, 0, 1000, 1000, 2000, 1000, 3000, 0]);
    expect(Array.from(path505.path.flags)).toEqual([0, COORD_FLAG.bezierFirst, COORD_FLAG.bezierSecond, COORD_FLAG.dash]);
    expect(path505.path.closed).toBe(false);

    const area = r.objects[1];
    expect(area.symbolIdx).toBe(PILOT.roughOpen403);
    expect(area.path.closed).toBe(true);
    expect(area.path.flags[4]).toBe(COORD_FLAG.hole);

    expect(r.objects[2]).toMatchObject({ symbolIdx: PILOT.tree418, angleDeg: 45 });
    expect(r.objects[3]).toMatchObject({ symbolIdx: PILOT.controlNumber704, text: "31" });
  });

  it("envelope mode routes unmatched objects to proxy symbols by kind", () => {
    const r = ocadObjectsToRender(objects, pilotSymbols, { mode: "envelope", proxyColours: { line: 8, area: 1 } });
    expect(r.symbols.length).toBe(pilotSymbols.length + 4);
    expect(r.stats).toMatchObject({ matched: 4, proxied: 3, dropped: 1 });
    const proxyLine = r.objects.find((o) => r.symbols[o.symbolIdx].id === "proxy:line");
    const proxyArea = r.objects.filter((o) => r.symbols[o.symbolIdx].id === "proxy:area");
    expect(proxyLine).toBeDefined();
    expect(proxyArea).toHaveLength(2);
    const line = r.symbols.find((s) => s.id === "proxy:line");
    expect(line?.type === "line" && line.main?.colour).toBe(8);
  });

  it("text objects without text are dropped in both modes", () => {
    const r = ocadObjectsToRender([{ sym: 704000, otp: 4, coordinates: [pt(0, 0)] }], pilotSymbols, { mode: "envelope" });
    expect(r.objects).toEqual([]);
    expect(r.stats.dropped).toBe(1);
  });

  it("draws line text as text and rectangles as closed lines, as the document bridge does", () => {
    const r = ocadObjectsToRender(
      [
        { sym: 903000, otp: 6, text: "Along", coordinates: [pt(0, 0), pt(100, 50), pt(200, 0)] },
        { sym: 850001, otp: 7, coordinates: [pt(0, 0), pt(100, 0), pt(100, 50), pt(0, 50)] },
      ],
      pilotSymbols,
      { mode: "envelope" },
    );
    expect(r.stats).toMatchObject({ total: 2, proxied: 2, dropped: 0, coordinates: 7 });
    expect(r.symbols[r.objects[0].symbolIdx].id).toBe("proxy:text");
    expect(r.objects[0].text).toBe("Along");
    expect(r.symbols[r.objects[1].symbolIdx].id).toBe("proxy:line");
    expect(r.objects[1].path.closed).toBe(true);
  });
});
