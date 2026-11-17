import { describe, expect, it } from "vitest";
import { mapGeo } from "@oxygen/shared";
import type { CogWindow } from "../map-store/dem-cog.js";
import { boxInCrs, documentDemExtent, fetchDemMosaic, paperGrid, paperGridSampler, paperToCrs } from "../map-store/dem.js";
import { glo30Provider, lantmaterietProvider } from "../map-store/dem-providers.js";
import { buildSyntheticCog, fakeRangeServer } from "./helpers/synthetic-cog.js";

// An OCAD-unit map at 1:10 000 in SWEREF 99 TM, turned 2° with a grid scale factor
const FRAME: mapGeo.PaperFrame = {
  unitsPerMm: 100, mapScale: 10_000,
  georeferencing: { crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" }, paperOrigin: { x: 674_000, y: 6_580_000 }, gridRotationDeg: 2, gridScaleFactor: 0.9996 },
};
/** A summary whose bounds are ±30 mm around the origin, native units. */
const SUMMARY = { unitsPerMm: 100, bounds: { minX: -3000, minY: -2000, maxX: 3000, maxY: 2000 } };
const projected = (x: number, y: number) => mapGeo.paperToProjected(FRAME, x * 100, y * 100)!;
const sweref = (e: number, n: number) => 50 + 0.01 * (e - 674_000) + 0.02 * (n - 6_580_000);

/** A window over [x0, x0 + w·c] × [y0 − h·c, y0] in `epsg` holding `f` at the pixel centres. */
function windowOf(epsg: number, x0: number, y0: number, c: number, w: number, h: number, f: (x: number, y: number) => number): CogWindow {
  const data = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let q = 0; q < w; q++) data[r * w + q] = f(x0 + (q + 0.5) * c, y0 - (r + 0.5) * c);
  return { epsg, width: w, height: h, originX: x0, originY: y0, cellX: c, cellY: c, data };
}

describe("the extent (map-terrain.md §7.3)", () => {
  it("pads the document's bounds by the raster's 2 mm and 30 m of ground, and bounds it in WGS 84", () => {
    const e = documentDemExtent(FRAME, SUMMARY)!;
    expect(e.groundMPerMm).toBe(10);
    expect(e.paper).toEqual({ minX: -35, minY: -25, maxX: 35, maxY: 25 });
    for (const [x, y] of [[-35, -25], [35, 25], [0, 0], [-35, 25]]) {
      const ll = mapGeo.paperToWgs84({ ...FRAME }, x * 100, y * 100)!;
      expect(ll.lng).toBeGreaterThanOrEqual(e.wgs84.west - 1e-9);
      expect(ll.lng).toBeLessThanOrEqual(e.wgs84.east + 1e-9);
      expect(ll.lat).toBeGreaterThanOrEqual(e.wgs84.south - 1e-9);
      expect(ll.lat).toBeLessThanOrEqual(e.wgs84.north + 1e-9);
    }
  });

  it("is null without a CRS, a paper origin or usable bounds", () => {
    expect(documentDemExtent({ ...FRAME, georeferencing: { ...FRAME.georeferencing, crs: null } }, SUMMARY)).toBeNull();
    expect(documentDemExtent({ ...FRAME, georeferencing: { ...FRAME.georeferencing, paperOrigin: null } }, SUMMARY)).toBeNull();
    expect(documentDemExtent({ ...FRAME, georeferencing: { ...FRAME.georeferencing, crs: { authority: "EPSG", code: 99999, name: "?" } } }, SUMMARY)).toBeNull();
    expect(documentDemExtent(FRAME, { unitsPerMm: 100, bounds: null })).toBeNull();
    expect(documentDemExtent(FRAME, {})).toBeNull();
  });

  it("projects into the document's own CRS without proj4 and into another through it", () => {
    expect(paperToCrs(FRAME, 3006)!(12, -7)).toEqual(projected(12, -7));
    const ll = paperToCrs(FRAME, 4326)!(12, -7)!;
    const back = mapGeo.paperToWgs84(FRAME, 1200, -700)!;
    expect(ll[0]).toBeCloseTo(back.lng, 9);
    expect(ll[1]).toBeCloseTo(back.lat, 9);
    const box = boxInCrs(FRAME, { minX: -10, minY: -10, maxX: 10, maxY: 10 }, 3006)!;
    // turned 2°: the box grows by sin 2° of the other side
    expect(box.maxX - box.minX).toBeCloseTo(200 * 0.9996 * (Math.cos((2 * Math.PI) / 180) + Math.sin((2 * Math.PI) / 180)), 3);
  });
});

describe("the paper grid and its sampler (§7.3)", () => {
  const paper = { minX: -35, minY: -25, maxX: 35, maxY: 25 };

  it("reads a window in the document's CRS through rotation and grid scale exactly", () => {
    const b = boxInCrs(FRAME, paper, 3006)!;
    const w = windowOf(3006, Math.floor(b.minX) - 4, Math.ceil(b.maxY) + 4, 2, Math.ceil((b.maxX - b.minX) / 2) + 8, Math.ceil((b.maxY - b.minY) / 2) + 8, sweref);
    const g = paperGrid(FRAME, paper, [w], 2);
    expect(g.cellMm).toBeCloseTo(0.2, 9);
    const s = paperGridSampler(g);
    for (const [x, y] of [[0, 0], [-30.3, 20.1], [33.7, -24.2], [5.55, 5.55]]) expect(s(x, y)).toBeCloseTo(sweref(...projected(x, y)), 3);
    expect(s(40, 0)).toBeNaN();
  });

  it("reads a geographic window through the lattice within a few centimetres", () => {
    // the surface is 1 cm per metre of SWEREF easting, stored on a 1e-5° grid in WGS 84
    const toSweref = mapGeo.proj()("EPSG:4326", "EPSG:3006");
    const surface = (lng: number, lat: number) => 0.01 * (toSweref.forward([lng, lat])[0] - 674_000);
    const small = { minX: -30, minY: -30, maxX: 30, maxY: 30 }; // 600 m
    const b = boxInCrs(FRAME, small, 4326)!;
    const c = 1e-5;
    const w = windowOf(4326, b.minX - 2 * c, b.maxY + 2 * c, c, Math.ceil((b.maxX - b.minX) / c) + 4, Math.ceil((b.maxY - b.minY) / c) + 4, surface);
    const s = paperGridSampler(paperGrid(FRAME, small, [w], 1));
    let worst = 0;
    for (let x = -28; x <= 28; x += 3.7) for (let y = -28; y <= 28; y += 4.3) worst = Math.max(worst, Math.abs(s(x, y) - 0.01 * (projected(x, y)[0] - 674_000)));
    // 0.05 m of position is 0.0005 m of height here
    expect(worst).toBeLessThan(0.0006);
  });

  it("takes each point from whichever window holds it", () => {
    const b = boxInCrs(FRAME, paper, 3006)!;
    const mid = Math.round((b.minX + b.maxX) / 2);
    const top = Math.ceil(b.maxY) + 4, h = Math.ceil((b.maxY - b.minY) / 2) + 8;
    const west = windowOf(3006, Math.floor(b.minX) - 4, top, 2, Math.ceil((mid - b.minX) / 2) + 4, h, sweref);
    const east = windowOf(3006, mid, top, 2, Math.ceil((b.maxX - mid) / 2) + 4, h, sweref);
    const s = paperGridSampler(paperGrid(FRAME, paper, [west, east], 2));
    for (const x of [-30, -1, 0, 1, 30]) expect(s(x, 3)).toBeCloseTo(sweref(...projected(x, 3)), 2);
  });

  it("coarsens the grid to its cell budget", () => {
    const g = paperGrid(FRAME, paper, [], 2, { maxCells: 10_000 });
    expect(g.width * g.height).toBeLessThanOrEqual(10_000);
    expect(g.data.every(Number.isNaN)).toBe(true);
  });
});

describe("fetchDemMosaic (§7.2)", () => {
  const STAC = "https://api.lantmateriet.se/stac-hojd/v1";
  const extent = documentDemExtent(FRAME, SUMMARY)!;
  const b = boxInCrs(FRAME, extent.paper, 3006)!;
  const split = 2 * Math.round((b.minX + b.maxX) / 4);
  const even = (v: number, up: boolean) => 2 * (up ? Math.ceil(v / 2) : Math.floor(v / 2));
  // two 1 m tiles meeting at `split`, each with a 2 m overview
  const tile = (x0: number, x1: number) => buildSyntheticCog({ surface: sweref, epsg: 3006, width: x1 - x0, height: even(b.maxY - b.minY, true) + 40, cellX: 1, cellY: 1, originX: x0, originY: Math.ceil(b.maxY) + 20, tile: 128, overviews: 1, nodata: -9999 });
  const files = {
    "https://dl.lantmateriet.se/w.tif": tile(even(b.minX - 20, false), split),
    "https://dl.lantmateriet.se/e.tif": tile(split, even(b.maxX + 20, true)),
  };
  const stacFor = (features: unknown[]) => (init: { headers: Record<string, string> }) => {
    expect(init.headers.Authorization).toMatch(/^Basic /);
    return new Response(JSON.stringify({ features, links: [] }), { status: 200 });
  };
  const stacUrl = (box: mapGeo.Wgs84Bounds) => `${STAC}/search?${new URLSearchParams({ collections: "dtm-cog", bbox: [box.west, box.south, box.east, box.north].join(","), limit: "100" })}`;
  const asset = (href: string) => ({ assets: { data: { href, type: "image/tiff; application=geotiff; profile=cloud-optimized", roles: ["data"] } } });

  it("reads each tile's 2 m overview over the extent; the sampler is continuous across the seam", async () => {
    const server = fakeRangeServer({ ...files, [stacUrl(extent.wgs84)]: stacFor(Object.keys(files).map(asset)) });
    const m = await fetchDemMosaic(lantmaterietProvider({ fetch: server.fetch, credential: "u:p" }), FRAME, extent);
    if (m === "no-coverage") throw new Error("no coverage");
    expect(m).toMatchObject({ tiles: 2, tilesRead: 2 });
    expect(m.windows.every((w) => w.cellX === 2 && w.epsg === 3006)).toBe(true);
    expect(server.requests.filter((r) => r.url.endsWith(".tif")).every((r) => r.range !== null && r.authorization?.startsWith("Basic "))).toBe(true);
    const s = paperGridSampler(paperGrid(FRAME, extent.paper, m.windows, 2));
    for (let x = -30; x <= 30; x += 1.5) expect(s(x, 2)).toBeCloseTo(sweref(...projected(x, 2)), 2);
  });

  it("is no-coverage when no tile holds the extent", async () => {
    const empty = fakeRangeServer({ [stacUrl(extent.wgs84)]: stacFor([]) });
    expect(await fetchDemMosaic(lantmaterietProvider({ fetch: empty.fetch, credential: "u:p" }), FRAME, extent)).toBe("no-coverage");
  });

  it("skips GLO-30's missing (sea) tiles, and fails on a missing Lantmäteriet tile", async () => {
    expect(await fetchDemMosaic(glo30Provider({ fetch: fakeRangeServer({}).fetch }), FRAME, extent)).toBe("no-coverage");
    const lm = fakeRangeServer({ [stacUrl(extent.wgs84)]: stacFor([asset("https://dl.lantmateriet.se/gone.tif")]) });
    await expect(fetchDemMosaic(lantmaterietProvider({ fetch: lm.fetch, credential: "u:p" }), FRAME, extent)).rejects.toMatchObject({ reason: "http", status: 404 });
  });

  it("refuses a mosaic over its cell budget", async () => {
    const server = fakeRangeServer({ ...files, [stacUrl(extent.wgs84)]: stacFor(Object.keys(files).map(asset)) });
    await expect(fetchDemMosaic(lantmaterietProvider({ fetch: server.fetch, credential: "u:p" }), FRAME, extent, { maxCells: 1000 })).rejects.toMatchObject({ reason: "over-cap", cap: "window-cells" });
  });

  describe("over the window cap at its level: the next coarser overview (§7.0c answer 12)", () => {
    // the same two tiles with 2 m and 4 m overviews
    const tile4 = (x0: number, x1: number) => buildSyntheticCog({ surface: sweref, epsg: 3006, width: x1 - x0, height: even(b.maxY - b.minY, true) + 40, cellX: 1, cellY: 1, originX: x0, originY: Math.ceil(b.maxY) + 20, tile: 128, overviews: 2, nodata: -9999 });
    const files4 = { "https://dl.lantmateriet.se/w.tif": tile4(even(b.minX - 20, false), split), "https://dl.lantmateriet.se/e.tif": tile4(split, even(b.maxX + 20, true)) };
    const serve = () => fakeRangeServer({ ...files4, [stacUrl(extent.wgs84)]: stacFor(Object.keys(files4).map(asset)) });
    const cellsAt = async (resolutionM: number) => {
      const m = await fetchDemMosaic(lantmaterietProvider({ fetch: serve().fetch, credential: "u:p", resolutionM }), FRAME, extent);
      if (m === "no-coverage") throw new Error("no coverage");
      return m.windows.reduce((n, w) => n + w.width * w.height, 0);
    };

    it("reads 4 m when 2 m is over and 4 m fits: the same tiles, no request beyond the 4 m windows", async () => {
      const at2 = await cellsAt(2), at4Budget = Math.floor(at2 / 2);
      const server = serve();
      const m = await fetchDemMosaic(lantmaterietProvider({ fetch: server.fetch, credential: "u:p" }), FRAME, extent, { maxCells: at4Budget });
      if (m === "no-coverage") throw new Error("no coverage");
      expect(m).toMatchObject({ tiles: 2, tilesRead: 2, resolutionM: 4, stepped: true });
      expect(m.windows.every((w) => w.cellX === 4)).toBe(true);
      expect(m.windows.reduce((n, w) => n + w.width * w.height, 0)).toBeLessThanOrEqual(at4Budget);
      const tifs = server.requests.filter((r) => r.url.endsWith(".tif"));
      expect(new Set(tifs.map((r) => r.url))).toEqual(new Set(Object.keys(files4)));
      expect(tifs.every((r) => r.range !== null)).toBe(true);
      const s = paperGridSampler(paperGrid(FRAME, extent.paper, m.windows, 4));
      for (let x = -30; x <= 30; x += 3) expect(s(x, 2)).toBeCloseTo(sweref(...projected(x, 2)), 1);
    });

    it("reads its own level, not stepped, when it fits", async () => {
      const m = await fetchDemMosaic(lantmaterietProvider({ fetch: serve().fetch, credential: "u:p" }), FRAME, extent);
      expect(m).toMatchObject({ resolutionM: 2, stepped: false });
    });

    it("steps one level only: 2 m and 4 m both over is over-cap, naming the window cells", async () => {
      const at2 = await cellsAt(2);
      const server = serve();
      const err = await fetchDemMosaic(lantmaterietProvider({ fetch: server.fetch, credential: "u:p" }), FRAME, extent, { maxCells: Math.floor(at2 / 8) }).catch((e: unknown) => e);
      expect(err).toMatchObject({ reason: "over-cap", cap: "window-cells", message: expect.stringMatching(/2 m.*4 m/) });
      // the headers only: no window was read
      const tifs = server.requests.filter((r) => r.url.endsWith(".tif"));
      expect(tifs.length).toBe(2);
    });

    it("reads 2 m from the 1 m setting when 1 m is over", async () => {
      const at1 = await cellsAt(1);
      const m = await fetchDemMosaic(lantmaterietProvider({ fetch: serve().fetch, credential: "u:p", resolutionM: 1 }), FRAME, extent, { maxCells: Math.floor(at1 / 2) });
      if (m === "no-coverage") throw new Error("no coverage");
      expect(m).toMatchObject({ resolutionM: 2, stepped: true });
      expect(m.windows.every((w) => w.cellX === 2)).toBe(true);
    });

    it("does not step with the step off (the live check): over-cap at its own level", async () => {
      const at2 = await cellsAt(2);
      const server = serve();
      await expect(fetchDemMosaic(lantmaterietProvider({ fetch: server.fetch, credential: "u:p" }), FRAME, extent, { maxCells: Math.floor(at2 / 2), coarser: false })).rejects.toMatchObject({ reason: "over-cap", cap: "window-cells" });
      expect(server.requests.filter((r) => r.url.endsWith(".tif"))).toHaveLength(2); // the headers only
    });

    it("steps past a located tile that holds none of the extent, whatever its pyramid", async () => {
      // a tile 5 km east with only a 2 m overview: located, read for its header, no cells, no coarser level
      const far = buildSyntheticCog({ surface: sweref, epsg: 3006, width: 256, height: 256, cellX: 1, cellY: 1, originX: 680_000, originY: 6_581_000, tile: 128, overviews: 1, nodata: -9999 });
      const withFar = { ...files4, "https://dl.lantmateriet.se/far.tif": far };
      const at2 = await cellsAt(2);
      const server = fakeRangeServer({ ...withFar, [stacUrl(extent.wgs84)]: stacFor(Object.keys(withFar).map(asset)) });
      const m = await fetchDemMosaic(lantmaterietProvider({ fetch: server.fetch, credential: "u:p" }), FRAME, extent, { maxCells: Math.floor(at2 / 2) });
      if (m === "no-coverage") throw new Error("no coverage");
      expect(m).toMatchObject({ tiles: 3, tilesRead: 2, resolutionM: 4, stepped: true });
    });

    it("refuses tiles whose coarser overviews differ, rather than a mosaic of two resolutions", async () => {
      // the east tile with only a 2 m overview beside the west one's 4 m: west steps to 4 m, east cannot
      const mixed = { "https://dl.lantmateriet.se/w.tif": files4["https://dl.lantmateriet.se/w.tif"], "https://dl.lantmateriet.se/e.tif": files["https://dl.lantmateriet.se/e.tif"] };
      const at2 = await cellsAt(2);
      const server = fakeRangeServer({ ...mixed, [stacUrl(extent.wgs84)]: stacFor(Object.keys(mixed).map(asset)) });
      await expect(fetchDemMosaic(lantmaterietProvider({ fetch: server.fetch, credential: "u:p" }), FRAME, extent, { maxCells: Math.floor(at2 / 2) })).rejects.toMatchObject({ reason: "over-cap", cap: "window-cells" });
    });

    it("is over-cap when the tile has no coarser overview", async () => {
      const server = fakeRangeServer({ ...files, [stacUrl(extent.wgs84)]: stacFor(Object.keys(files).map(asset)) });
      // `files` carry a 2 m overview and nothing coarser
      const at2 = await fetchDemMosaic(lantmaterietProvider({ fetch: server.fetch, credential: "u:p" }), FRAME, extent);
      if (at2 === "no-coverage") throw new Error("no coverage");
      const cells = at2.windows.reduce((n, w) => n + w.width * w.height, 0);
      await expect(fetchDemMosaic(lantmaterietProvider({ fetch: server.fetch, credential: "u:p" }), FRAME, extent, { maxCells: cells - 1 })).rejects.toMatchObject({ reason: "over-cap", cap: "window-cells" });
    });
  });
});
