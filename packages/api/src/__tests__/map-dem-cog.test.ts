import { describe, expect, it } from "vitest";
import { chooseLevel, coarserLevel, cogWindowCells, DemFetchError, readCogInfo, readCogWindow, sampleWindow, type CogSource } from "../map-store/dem-cog.js";
import { buildSyntheticCog, fakeRangeServer, type SyntheticCogOptions } from "./helpers/synthetic-cog.js";

const URL_ = "https://tiles.example.test/a.tif";
// A plane in SWEREF 99 TM: 100 m at the corner, rising 0.01 per metre east and 0.02 north
const plane = (x: number, y: number) => 100 + 0.01 * (x - 650_000) + 0.02 * (y - 6_570_000);
const base: SyntheticCogOptions = { surface: plane, epsg: 3006, width: 200, height: 160, cellX: 1, cellY: 1, originX: 650_000, originY: 6_570_160, tile: 32, overviews: 2, nodata: -9999 };
const source = (bytes: Uint8Array, opts?: { ignoreRange?: boolean }) => {
  const server = fakeRangeServer({ [URL_]: bytes }, opts);
  const src: CogSource = { fetch: server.fetch, url: URL_ };
  return { server, src };
};

describe("readCogInfo (map-terrain.md §7.2)", () => {
  it("reads the georeference and the pyramid", async () => {
    const { src } = source(buildSyntheticCog(base));
    const info = await readCogInfo(src);
    expect(info).toMatchObject({ epsg: 3006, pixelIsPoint: false, nodata: -9999, originX: 650_000, originY: 6_570_160 });
    expect(info.levels.map((l) => [l.width, l.height, l.cellX])).toEqual([[200, 160, 1], [100, 80, 2], [50, 40, 4]]);
    expect(info.levels[0]).toMatchObject({ compression: 8, predictor: 3, tileWidth: 32 });
  });

  it("moves a PixelIsPoint tiepoint to the area corner, and reads a geographic CRS without nodata", async () => {
    const { src } = source(buildSyntheticCog({ ...base, epsg: 4326, cellX: 1 / 2400, cellY: 1 / 3600, originX: 18, originY: 60, pixelIsPoint: true, nodata: undefined, surface: () => 5 }));
    const info = await readCogInfo(src);
    expect(info.epsg).toBe(4326);
    expect(info.pixelIsPoint).toBe(true);
    expect(info.nodata).toBeNull();
    expect(info.originX).toBeCloseTo(18 - 0.5 / 2400, 12);
    expect(info.originY).toBeCloseTo(60 + 0.5 / 3600, 12);
  });

  it("chooses the coarsest level at or below the target cell", async () => {
    const info = await readCogInfo(source(buildSyntheticCog(base)).src);
    expect(chooseLevel(info, 2)).toBe(1);
    expect(chooseLevel(info, 3)).toBe(1);
    expect(chooseLevel(info, 4)).toBe(2);
    expect(chooseLevel(info, 0.5)).toBe(0);
  });

  it("steps to the next coarser overview, and has none past the coarsest (§7.0c answer 12)", async () => {
    const info = await readCogInfo(source(buildSyntheticCog(base)).src);
    expect(coarserLevel(info, 0)).toBe(1); // 1 m → 2 m
    expect(coarserLevel(info, 1)).toBe(2); // 2 m → 4 m
    expect(coarserLevel(info, 2)).toBeNull();
  });

  it("fails as format on what it does not read", async () => {
    const tiff = buildSyntheticCog(base);
    const big = tiff.slice();
    big[2] = 43;
    await expect(readCogInfo(source(big).src)).rejects.toMatchObject({ reason: "format", message: /BigTIFF/ });
    const mm = tiff.slice();
    mm[0] = mm[1] = 0x4d;
    await expect(readCogInfo(source(mm).src)).rejects.toMatchObject({ reason: "format" });
    await expect(readCogInfo(source(new Uint8Array(4)).src)).rejects.toBeInstanceOf(DemFetchError);
  });

  it("refuses a server that ignores Range, and maps 401/403 to auth", async () => {
    await expect(readCogInfo(source(buildSyntheticCog(base), { ignoreRange: true }).src)).rejects.toMatchObject({ reason: "http", message: /range/ });
    for (const status of [401, 403]) {
      const server = fakeRangeServer({ [URL_]: () => new Response("no", { status }) });
      await expect(readCogInfo({ fetch: server.fetch, url: URL_ })).rejects.toMatchObject({ reason: "auth", status });
    }
    const down = fakeRangeServer({ [URL_]: () => new Response("busy", { status: 503 }) });
    await expect(readCogInfo({ fetch: down.fetch, url: URL_ })).rejects.toMatchObject({ reason: "http", status: 503 });
  });
});

describe("readCogWindow (map-terrain.md §7.2)", () => {
  it("reads the 2 m overview of a window by range, only the tiles it needs", async () => {
    const { src, server } = source(buildSyntheticCog(base));
    const info = await readCogInfo(src);
    const headerRequests = server.requests.length;
    const w = (await readCogWindow(src, info, { level: 1, minX: 650_020, minY: 6_570_030, maxX: 650_090, maxY: 6_570_070, maxCells: 1e6 }))!;
    expect(w).toMatchObject({ epsg: 3006, cellX: 2, cellY: 2, originX: 650_020, originY: 6_570_070, width: 35, height: 20 });
    for (const [x, y] of [[650_021, 6_570_069], [650_055.5, 6_570_050.2], [650_088, 6_570_032]]) expect(sampleWindow(w, x, y)).toBeCloseTo(plane(x, y), 3);
    const tileRequests = server.requests.slice(headerRequests);
    expect(tileRequests.every((r) => r.range?.startsWith("bytes="))).toBe(true);
    // the window spans 2 × 2 of the overview's 4 × 3 tiles: one run per tile row
    expect(tileRequests.length).toBe(2);
  });

  it("reads every level, uncompressed and without predictor too", async () => {
    for (const variant of [{ compression: 1 as const, predictor: 1 as const }, { compression: 8 as const, predictor: 1 as const }, { compression: 1 as const, predictor: 3 as const }]) {
      const { src } = source(buildSyntheticCog({ ...base, ...variant }));
      const info = await readCogInfo(src);
      for (const level of [0, 1, 2]) {
        const w = (await readCogWindow(src, info, { level, minX: 650_000, minY: 6_570_000, maxX: 650_200, maxY: 6_570_160, maxCells: 1e6 }))!;
        expect(sampleWindow(w, 650_100, 6_570_080)).toBeCloseTo(plane(650_100, 6_570_080), 3);
      }
    }
  });

  it("turns nodata into NaN", async () => {
    const holey = (x: number, y: number) => (x < 650_100 ? NaN : plane(x, y));
    const { src } = source(buildSyntheticCog({ ...base, surface: holey }));
    const info = await readCogInfo(src);
    const w = (await readCogWindow(src, info, { level: 0, minX: 650_000, minY: 6_570_000, maxX: 650_200, maxY: 6_570_160, maxCells: 1e6 }))!;
    expect(sampleWindow(w, 650_050.5, 6_570_080.5)).toBeNaN();
    expect(sampleWindow(w, 650_150.5, 6_570_080.5)).toBeCloseTo(plane(650_150.5, 6_570_080.5), 3);
  });

  it("is null for a box beside the raster and over-cap for a window too large", async () => {
    const { src } = source(buildSyntheticCog(base));
    const info = await readCogInfo(src);
    expect(await readCogWindow(src, info, { level: 0, minX: 640_000, minY: 6_560_000, maxX: 640_100, maxY: 6_560_100, maxCells: 1e6 })).toBeNull();
    await expect(readCogWindow(src, info, { level: 0, minX: 650_000, minY: 6_570_000, maxX: 650_200, maxY: 6_570_160, maxCells: 1000 })).rejects.toMatchObject({ reason: "over-cap" });
  });

  it("sizes a window without reading it, as readCogWindow cuts it; over-cap names the window-cells cap", async () => {
    const { src, server } = source(buildSyntheticCog(base));
    const info = await readCogInfo(src);
    const before = server.requests.length;
    const box = { minX: 650_000, minY: 6_570_000, maxX: 650_200, maxY: 6_570_160 };
    expect(cogWindowCells(info, { level: 0, ...box })).toBe(200 * 160);
    expect(cogWindowCells(info, { level: 1, ...box })).toBe(100 * 80);
    expect(cogWindowCells(info, { level: 1, minX: 640_000, minY: 6_560_000, maxX: 640_100, maxY: 6_560_100 })).toBe(0);
    expect(server.requests.length).toBe(before);
    await expect(readCogWindow(src, info, { level: 0, ...box, maxCells: 1000 })).rejects.toMatchObject({ reason: "over-cap", cap: "window-cells" });
  });

  it("fails as format on a cut-short tile", async () => {
    const tiff = buildSyntheticCog(base);
    const info = await readCogInfo(source(tiff).src);
    const last = info.levels[0];
    const cut = tiff.slice(0, last.offsets[0] + 10);
    const { src } = source(cut);
    await expect(readCogWindow(src, info, { level: 0, minX: 650_000, minY: 6_570_128, maxX: 650_010, maxY: 6_570_160, maxCells: 1e6 })).rejects.toMatchObject({ reason: "format" });
  });
});
