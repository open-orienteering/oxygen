/**
 * Document window raster (docs/course-print.md §10): ink boundary, the
 * pass filter, window object selection and the rendered window probed at
 * hand-computed paper coordinates of the e2e fixture (scripts/lib/ocad-fixture.mjs:
 * yellow 403 blob ≈ −74..76 × −48..46 mm, north lines at x = −66 + 12k mm
 * spanning y ±50 mm, building 48–58 × 39–46 mm).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { mapDocument, render, type MapWindow } from "@oxygen/shared";
import { importOcadToDocument } from "../../import/ocad.js";
import { filterPassStream, inkBoundary, objectsNear, prepareDocument, renderDocumentWindow } from "../window-raster.js";

const fixture = readFileSync(fileURLToPath(new URL("../../../../../e2e/test.ocd", import.meta.url)));

let doc: mapDocument.MapDocument;
let prepared: Awaited<ReturnType<typeof prepareDocument>>;

beforeAll(async () => {
  const imported = await importOcadToDocument(fixture, "test.ocd");
  doc = mapDocument.decodeMapDocument(imported.bytes);
  prepared = await prepareDocument("unit", () => imported.bytes);
});

async function decode(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, at: (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)) };
}

/** Pixel of a map-mm point in an unrotated window of `pxPerMm`. */
const px = (w: MapWindow, pxPerMm: number, mx: number, my: number): [number, number] => [
  Math.round((mx - w.minX) * pxPerMm),
  Math.round((w.minY + w.height - my) * pxPerMm),
];

describe("inkBoundary", () => {
  it("is the stack index carrying purple-lower, else the purpleRole fallback, else null", () => {
    const base = { paletteIds: [] } as unknown as mapDocument.DocumentColour;
    const mk = (extra: Partial<mapDocument.DocumentColour>) => ({ ...base, ...extra }) as mapDocument.DocumentColour;
    expect(inkBoundary([mk({}), mk({ paletteIds: ["x", "purple-lower"] }), mk({})])).toBe(1);
    expect(inkBoundary([mk({}), mk({ purpleRole: "lower" })])).toBe(1);
    expect(inkBoundary([mk({}), mk({})])).toBeNull();
  });

  it("finds the row in an imported document", () => {
    const b = inkBoundary(doc.header.colours);
    expect(b).not.toBeNull();
    expect(doc.header.colours[b as number].paletteIds).toContain("purple-lower");
  });
});

describe("filterPassStream", () => {
  it("keeps the columns of the kept passes aligned", () => {
    const { stream } = render.symbolise({ objects: prepared.input.objects, symbols: prepared.input.symbols, fonts: [] });
    const cut = filterPassStream(stream, (c) => c > 2);
    expect(cut.passes.every((p) => p.colour > 2)).toBe(true);
    expect(cut.objectIdx.length).toBe(cut.passes.length);
    expect(cut.symbolIdx.length).toBe(cut.passes.length);
    expect(cut.passes.length).toBeLessThan(stream.passes.length);
  });
});

describe("objectsNear", () => {
  it("selects by extent plus margin", () => {
    const all = prepared.input.objects;
    const far = objectsNear(all, { minX: 500, minY: 500, width: 10, height: 10 }, 20);
    expect(far).toHaveLength(0);
    const centre = objectsNear(all, { minX: -1, minY: -1, width: 2, height: 2 }, 0);
    expect(centre.length).toBeGreaterThan(0);
    expect(centre.length).toBeLessThan(all.length);
  });
});

describe("renderDocumentWindow", () => {
  const window: MapWindow = { minX: -20, minY: 0, width: 40, height: 20 };
  const pxPerMm = 10;

  it("full: white paper, yellow area, sized exactly", async () => {
    const img = await decode(await renderDocumentWindow(prepared, { window, widthPx: 400, heightPx: 200, layer: "full" }));
    expect([img.width, img.height]).toEqual([400, 200]);
    const [yx, yy] = px(window, pxPerMm, 0, 10);
    const [r, g, b, a] = img.at(yx, yy);
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(150);
    expect(b).toBeLessThan(120); // yellow, not white
  });

  it("ink: lower purple sits above the fixture's yellow, so yellow leaves the ink and black stays (bugfix-lower-purple-under-areas)", async () => {
    const img = await decode(await renderDocumentWindow(prepared, { window, widthPx: 400, heightPx: 200, layer: "ink" }));
    const [yx, yy] = px(window, pxPerMm, 0, 10);
    expect(img.at(yx, yy)[3]).toBe(0);
    // The building (black, 48–58 × 39–46 mm) is drawn above lower purple.
    const w2: MapWindow = { minX: 45, minY: 36, width: 16, height: 13 };
    const building = await decode(await renderDocumentWindow(prepared, { window: w2, widthPx: 160, heightPx: 130, layer: "ink" }));
    const [bx, by] = px(w2, pxPerMm, 53, 42.5);
    expect(building.at(bx, by)[3]).toBe(255);
    expect(building.at(bx, by).slice(0, 3).every((v) => v < 160)).toBe(true);
  });

  it("ink: colours at or below the boundary are absent", async () => {
    // Move purple-lower down to the yellow row: yellow (2) and everything under it leave the ink.
    const colours = doc.header.colours.map((c, i) => ({ ...c, paletteIds: i === 2 ? ["purple-lower"] : [] }));
    const raised = { ...prepared, colours };
    const img = await decode(await renderDocumentWindow(raised, { window, widthPx: 400, heightPx: 200, layer: "ink" }));
    const [yx, yy] = px(window, pxPerMm, 0, 10);
    expect(img.at(yx, yy)[3]).toBe(0);
    let opaque = 0;
    for (let y = 0; y < img.height; y += 5) for (let x = 0; x < img.width; x += 5) if (img.at(x, y)[3] > 0) opaque++;
    expect(opaque).toBeGreaterThan(0); // black map content above remains
  });

  it("ink: a stack without any lower purple gives an empty full-size layer", async () => {
    const colours = doc.header.colours.map((c) => ({ ...c, paletteIds: [] as string[], purpleRole: undefined }));
    const img = await decode(await renderDocumentWindow({ ...prepared, colours }, { window, widthPx: 400, heightPx: 200, layer: "ink", hash: "none" }));
    expect([img.width, img.height]).toEqual([400, 200]);
    for (let y = 0; y < img.height; y += 20) for (let x = 0; x < img.width; x += 20) expect(img.at(x, y)[3]).toBe(0);
  });

  it("rotation 90° puts the building at the page offset the clockwise turn predicts", async () => {
    // 20×20 mm at (58, 42.5): building spans x 48–58, y 39–46. Unrotated, its
    // centre (53, 42.5) is 5 mm left of the centre; clockwise 90° moves a left
    // point to the top: page offset (0, −5 mm).
    const w: MapWindow = { minX: 48, minY: 32.5, width: 20, height: 20, rotationDeg: 90 };
    const img = await decode(await renderDocumentWindow(prepared, { window: w, widthPx: 200, heightPx: 200, layer: "full" }));
    expect([img.width, img.height]).toEqual([200, 200]);
    const top = img.at(100, 50);
    const bottom = img.at(100, 150);
    expect(top[0] + top[1] + top[2]).toBeLessThan(120); // black building
    expect(bottom[0] + bottom[1] + bottom[2]).toBeGreaterThan(600); // paper
  });
});
