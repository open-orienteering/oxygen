/**
 * Description sheets (docs/course-print.md §6.4): the tiling of the map
 * page's description block on A4 and the writer's document — page count,
 * labels, colour mode, shared pictogram forms, deterministic bytes.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream, type PDFObject } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { liberation } from "../../render/__tests__/fonts.js";
import type { ColourMode } from "../colour.js";
import { descriptionSheetBlock, descriptionSheetScene } from "../__fixtures__/description-sheets.js";
import {
  DescriptionTooTallError,
  type DescriptionSheetBlock,
  type DescriptionSheetOptions,
  composeDescriptionPage,
  countDescriptionPages,
  descriptionGrid,
  tileDescriptionSheets,
  writeDescriptionPage,
} from "../description-sheet.js";
import { PdfWriter } from "../writer.js";

const fontsDir = fileURLToPath(new URL("../../../fonts/", import.meta.url));
const faces = [
  { family: "liberation-sans" as const, data: new Uint8Array(readFileSync(fontsDir + "LiberationSans-Regular.ttf")) },
  { family: "liberation-sans" as const, data: new Uint8Array(readFileSync(fontsDir + "LiberationSans-Bold.ttf")) },
];
const fonts = () => [liberation().sans, liberation().narrow];

/** 12 controls: start + 12 + finish = 14 rows, + 3 header rows = 17 cells high. */
const tall = (label: string, count = 1): DescriptionSheetBlock => descriptionSheetBlock(label, { controls: 12, count });
const opts = (cell: number, copies: DescriptionSheetOptions["copies"] = "fill"): DescriptionSheetOptions => ({ cellSizeMm: cell, gapMm: 5, copies });

async function build(blocks: DescriptionSheetBlock[], options: DescriptionSheetOptions, mode: ColourMode = "cmyk"): Promise<Uint8Array> {
  const w = await PdfWriter.create({ faces, deterministic: true, info: { title: "Test descriptions" } });
  for (const page of tileDescriptionSheets(blocks, options)) writeDescriptionPage(w, composeDescriptionPage(page, fonts()), { mode });
  return w.save();
}

const lookup = <T extends PDFObject>(doc: PDFDocument, o: PDFObject | undefined): T => (o instanceof PDFRef ? doc.context.lookup(o) : o) as T;
function content(doc: PDFDocument, i: number): string {
  const c = doc.getPage(i).node.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map((r) => lookup<PDFRawStream>(doc, r)) : [c as unknown as PDFRawStream];
  return streams.map((s) => new TextDecoder().decode(decodePDFRawStream(s).decode())).join("\n");
}

describe("descriptionGrid / tileDescriptionSheets", () => {
  it.each([
    [5, 4, 3],
    [6, 3, 2],
    [7, 3, 2],
  ])("a 14-row block at %i mm: %i × %i per A4 page (10 mm margin, 5 mm gap)", (cell, columns, rows) => {
    const block = tall("H21");
    expect(descriptionGrid({ widthMm: 8 * cell, heightMm: 17 * cell }, { gapMm: 5 })).toEqual({ columns, rows, perPage: columns * rows });
    const pages = tileDescriptionSheets([block], opts(cell));
    expect(pages).toHaveLength(1);
    expect(pages[0].blocks).toHaveLength(columns * rows);
  });

  it.each([
    [6, 0, 3, 2],
    [5, 20, 3, 2],
    [5, 0, 4, 3],
    [7, 30, 2, 2],
  ])("the gap counts between blocks only: %i mm cells, %i mm gap → %i × %i", (cell, gap, columns, rows) => {
    expect(descriptionGrid({ widthMm: 8 * cell, heightMm: 17 * cell }, { gapMm: gap })).toEqual({ columns, rows, perPage: columns * rows });
    const [page] = tileDescriptionSheets([tall("H21")], { cellSizeMm: cell, gapMm: gap, copies: "fill" });
    expect(page.blocks[1].x - page.blocks[0].x).toBe(8 * cell + gap);
  });

  it("places blocks row-major from the top-left inside the margin, never past it", () => {
    const [page] = tileDescriptionSheets([tall("H21")], opts(6));
    expect(page.blocks.map((b) => [b.x, b.y])).toEqual([
      [10, 10], [63, 10], [116, 10],
      [10, 117], [63, 117], [116, 117],
    ]);
    for (const b of page.blocks) {
      expect(b.x + 48).toBeLessThanOrEqual(200);
      expect(b.y + 102).toBeLessThanOrEqual(287);
      expect(b.cellSizeMm).toBe(6);
    }
  });

  it("count: the class's runners + vacancies, at least one", () => {
    expect(tileDescriptionSheets([tall("H21", 5)], opts(6, "count")).flatMap((p) => p.blocks)).toHaveLength(5);
    expect(tileDescriptionSheets([tall("H21", 0)], opts(6, "count")).flatMap((p) => p.blocks)).toHaveLength(1);
  });

  it("a number: that many copies; fill: one sheet's worth", () => {
    expect(tileDescriptionSheets([tall("H21", 40)], opts(7, 3)).flatMap((p) => p.blocks)).toHaveLength(3);
    expect(tileDescriptionSheets([tall("H21", 40)], opts(5, "fill")).flatMap((p) => p.blocks)).toHaveLength(12);
  });

  it("13 copies at 5 mm run onto a second page of the same class", () => {
    const pages = tileDescriptionSheets([tall("H21", 13)], opts(5, "count"));
    expect(pages.map((p) => [p.label, p.blocks.length])).toEqual([["H21", 12], ["H21", 1]]);
    expect(countDescriptionPages([tall("H21", 13)], opts(5, "count"))).toBe(2);
  });

  it("classes keep the order asked and never share a page", () => {
    const pages = tileDescriptionSheets([tall("D21", 2), tall("H21", 3), tall("H35", 1)], opts(6, "count"));
    expect(pages.map((p) => [p.label, p.blocks.length])).toEqual([["D21", 2], ["H21", 3], ["H35", 1]]);
    expect(countDescriptionPages([tall("D21", 2), tall("H21", 3), tall("H35", 1)], opts(6, "count"))).toBe(3);
  });

  it("a block taller than the page throws DESCRIPTION_TOO_TALL", () => {
    const huge = descriptionSheetBlock("H21", { controls: 40 });
    expect(() => tileDescriptionSheets([huge], opts(7))).toThrow(DescriptionTooTallError);
    expect(() => countDescriptionPages([huge], opts(7))).toThrow(/DESCRIPTION_TOO_TALL.*H21.*7 mm/);
    // The same block fits at 5 mm cells (45 cells = 225 mm).
    expect(tileDescriptionSheets([huge], opts(5))).toHaveLength(1);
  });
});

describe("writeDescriptionPage", () => {
  it("one A4 page per tiled page, labelled by its class, one outline item each", async () => {
    const doc = await PDFDocument.load(await build([tall("D21", 2), tall("H21", 7)], opts(6, "count")));
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(0).getMediaBox()).toMatchObject({ width: expect.closeTo(595.276, 2), height: expect.closeTo(841.89, 2) });
    const nums = doc.catalog.lookup(PDFName.of("PageLabels"), PDFDict).lookup(PDFName.of("Nums"), PDFArray).asArray();
    const prefix = (i: number) => (nums[2 * i + 1] as PDFDict).get(PDFName.of("P"))!.toString();
    const hex = (s: string) => `<FEFF${Array.from(s, (c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")).join("")}>`;
    expect([prefix(0), prefix(1), prefix(2)]).toEqual([hex("D21"), hex("H21"), hex("H21")]);
    expect(doc.catalog.lookup(PDFName.of("Outlines"), PDFDict).lookup(PDFName.of("Count"), PDFNumber).asNumber()).toBe(3);
  });

  it("sheet white first, then the blocks under µm → pt; cmyk writes no rg, rgb no k", async () => {
    const cmyk = content(await PDFDocument.load(await build([tall("H21")], opts(6))), 0);
    expect(cmyk.indexOf("0 0 0 0 k 0 0 595.276 841.89 re f")).toBe(0);
    expect(cmyk).toMatch(/0\.0\d+ 0 0 0\.0\d+ 0 0 cm/);
    expect(cmyk).not.toMatch(/ (rg|RG)\b/);
    expect(cmyk).toMatch(/\/F\d+ [\d.]+ Tf/);
    const rgb = content(await PDFDocument.load(await build([tall("H21")], opts(6), "rgb")), 0);
    expect(rgb).not.toMatch(/ (k|K)\b/);
  });

  it("pictogram forms are shared: the XObject set does not grow with the pages", async () => {
    const xobjects = async (copies: number) => {
      const doc = await PDFDocument.load(await build([tall("H21", copies)], opts(7, "count")));
      const names = new Set<string>();
      for (let i = 0; i < doc.getPageCount(); i++) {
        const xo = doc.getPage(i).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
        for (const [, v] of xo.entries()) names.add(String(v));
      }
      return { pages: doc.getPageCount(), forms: names.size };
    };
    const one = await xobjects(1);
    const three = await xobjects(16);
    expect(one.pages).toBe(1);
    expect(three.pages).toBe(3);
    expect(three.forms).toBe(one.forms);
  });

  it("deterministic: equal input gives equal bytes", async () => {
    const { blocks, options } = descriptionSheetScene();
    const a = await build(blocks, options);
    const b = await build(blocks, options);
    expect(a.length).toBeGreaterThan(0);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
