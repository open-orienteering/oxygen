/**
 * The description block (docs/course-print.md §6.2): pictograms
 * converted from `iof-symbols.ts`, the block's geometry as the legacy
 * SVG block draws it.
 */

import { describe, expect, it } from "vitest";
import { IOF_SYMBOLS } from "../../course-maps/iof-symbols.js";
import { buildDescriptionSheet } from "../../course-maps/description-rows.js";
import { pathBounds } from "../../render/path.js";
import type { LineSymbol, PointSymbol, TextSymbol } from "../../render/symbol.js";
import { descriptionBlock, iofSymbolGlyph } from "../description.js";

describe("iofSymbolGlyph", () => {
  it("converts every pictogram key", () => {
    for (const key of Object.keys(IOF_SYMBOLS)) {
      const g = iofSymbolGlyph(key);
      expect(g, key).not.toBeNull();
      for (const p of g!.parts) {
        if (p.kind === "stroke" || p.kind === "fill") expect(p.geometry!.coords.length, key).toBeGreaterThanOrEqual(4);
        expect(p.geometry?.coords.every(Number.isFinite) ?? true, key).toBe(true);
      }
    }
  });

  it("2.4 boulder is one filled triangle, y flipped, 100 µm per unit", () => {
    const g = iofSymbolGlyph("2.4")!;
    expect(g.parts).toHaveLength(1);
    expect(g.parts[0].kind).toBe("fill");
    expect(g.parts[0].geometry!.coords).toEqual([0, 5000, 5773, -5000, -5773, -5000]);
  });

  it("1.10 is one disc; 0.3 two strokes and a disc", () => {
    expect(iofSymbolGlyph("1.10")!.parts).toEqual([{ kind: "disc", colour: 0, diameterUm: 6000, cx: 0, cy: -0 }]);
    const kinds = iofSymbolGlyph("0.3")!.parts.map((p) => p.kind);
    expect(kinds).toEqual(["stroke", "stroke", "disc"]);
    expect(iofSymbolGlyph("0.3")!.parts[0]).toMatchObject({ widthUm: 1250, cap: "flat", join: "miter" });
  });

  it("Béziers keep their control-point flags", () => {
    const flags = iofSymbolGlyph("1.1")!.parts[0].geometry!.flags!;
    expect(flags).toEqual([0, 1, 2, 0]);
  });

  it("unknown keys are null", () => {
    expect(iofSymbolGlyph("99.9")).toBeNull();
  });
});

describe("descriptionBlock", () => {
  const sheet = buildDescriptionSheet({
    eventName: "Test",
    classNames: ["H21"],
    courseName: "A",
    lengthM: 4200,
    climbM: 85,
    controls: [
      { id: 1, code: "31", description: { d: "2.004" } },
      { id: 2, code: "32", description: { c: "0.003", d: "1.010", s: "2,5" } },
      { id: 3, code: "33" },
    ],
    finishLengthM: 150,
  });
  const colours = new Map([["#ffffff", 7], ["#000000", 8]]);
  const H = 297;
  const block = descriptionBlock({ x: 150, y: 12, cellSizeMm: 6, rows: sheet.rows, header: sheet.header, title: "A" }, H, (hex) => colours.get(hex)!);

  it("is 8 cells wide and header + rows tall, white under a 0.35 mm border, at the template's position", () => {
    const paper = block.objects[0];
    expect(block.symbols[paper.symbolIdx]).toMatchObject({ type: "area", fill: 7 });
    const b = pathBounds(paper.path);
    expect(b).toEqual({ minX: 150000, maxX: 198000, maxY: (H - 12) * 1000, minY: (H - 12 - 6 * (3 + sheet.rows.length)) * 1000 });
    expect((block.symbols[block.objects[1].symbolIdx] as LineSymbol).main).toMatchObject({ colour: 8, widthUm: 350 });
  });

  it("rules: thick under the header rows and per hasThickRuleBelow, thin elsewhere", () => {
    const widths = block.objects.filter((o) => block.symbols[o.symbolIdx].type === "line").map((o) => (block.symbols[o.symbolIdx] as LineSymbol).main!.widthUm);
    expect(widths.filter((w) => w === 350).length).toBeGreaterThan(5);
    expect(widths.filter((w) => w === 150).length).toBeGreaterThan(5);
  });

  it("header text is bold at 0.42 / 0.4 × cell; the F dimension is text at 0.34 × cell", () => {
    const texts = block.objects.filter((o) => o.text !== undefined).map((o) => ({ text: o.text!, sym: block.symbols[o.symbolIdx] as TextSymbol }));
    expect(texts.find((t) => t.text === "Test")!.sym).toMatchObject({ fontSizeUm: 2520, weight: 700, align: "centre", colour: 8 });
    expect(texts.find((t) => t.text === "H21")!.sym.fontSizeUm).toBe(2400);
    expect(texts.find((t) => t.text === "2.5")!.sym).toMatchObject({ fontSizeUm: 2040, weight: 400 });
    expect(texts.find((t) => t.text === "31")!.sym.fontSizeUm).toBe(2580);
  });

  it("pictograms are point symbols scaled to 0.8 × cell, centred in their cells, one symbol per key", () => {
    const points = block.objects.filter((o) => block.symbols[o.symbolIdx].type === "point");
    const ids = points.map((o) => block.symbols[o.symbolIdx].id);
    expect(ids).toContain("iof:start");
    expect(ids).toContain("iof:2.4");
    expect(ids).toContain("iof:0.3");
    expect(new Set(ids).size).toBe(block.symbols.filter((s) => s.type === "point").length);
    const boulder = points.find((o) => block.symbols[o.symbolIdx].id === "iof:2.4")!;
    // Row 1 (after 3 header rows and the start row), column D.
    expect(Array.from(boulder.path.coords)).toEqual([150000 + 3.5 * 6000, (H - 12 - 4.5 * 6000 / 1000) * 1000]);
    const sym = block.symbols[boulder.symbolIdx] as PointSymbol;
    // 2 × 57.73 units wide at 0.8 × 6 mm per 200 units.
    expect(sym.glyph.parts[0].geometry!.coords[2]).toBe(Math.round(5773 * 0.24));
    expect(sym.glyph.parts[0].colour).toBe(8);
  });
});
