/**
 * The recorded DEM fixture (docs/map-terrain.md §7, Tests): a synthetic
 * Lantmäteriet `dtm-cog` tile and a synthetic GLO-30 tile, built in memory
 * from analytic surfaces (no real DEM bytes), served by a fake STAC and a
 * fake range server. No test opens a socket.
 *
 * The terrain helper's HILL (rings r = 5…20 mm around (30, 30) mm at
 * 1:15 000) placed with its paper origin at `LM_ORIGIN` sits on the
 * Lantmäteriet cone: ring r at `422.6 − r` metres, every ring on its own
 * level. `GLO_ORIGIN` lies 30 km east, outside the Lantmäteriet tile and
 * inside the GLO-30 one.
 */

import { mapGeo } from "@oxygen/shared";
import { glo30Provider, glo30TileName, lantmaterietProvider, type DemProvider } from "../../map-store/dem-providers.js";
import type { RangeFetch } from "../../map-store/dem-cog.js";
import { buildSyntheticCog, fakeRangeServer } from "./synthetic-cog.js";

export const LM_ORIGIN = { e: 674_000, n: 6_580_000 };
export const GLO_ORIGIN = { e: 704_000, n: 6_580_000 };
/** The hill's centre on the ground: paper (30, 30) mm at 15 m/mm. */
export const LM_CENTRE = { e: LM_ORIGIN.e + 450, n: LM_ORIGIN.n + 450 };
export const CONE_TOP = 422.6;
/** The Lantmäteriet surface: a cone through each ring of HILL at `CONE_TOP − r`. */
export const lmCone = (e: number, n: number): number => CONE_TOP - Math.hypot(e - LM_CENTRE.e, n - LM_CENTRE.n) / 15;
/** The GLO-30 surface: a plane rising 1 m per 100 m north (a surface model; its shape matters little here). */
export const gloPlane = (lng: number, lat: number): number => 300 + (lat - 59.3) * 1110;

export const LM_TILE_URL = "https://dl.lantmateriet.se/hojd/dtm-cog/test_67_40.tif";
export const STAC = "https://api.lantmateriet.se/stac-hojd/v1";
/** A test credential, never a real one. */
export const TEST_CREDENTIAL = "test-user:test-password";

const LM_BOX = { minX: LM_ORIGIN.e - 100, maxX: LM_ORIGIN.e + 1500, minY: LM_ORIGIN.n - 100, maxY: LM_ORIGIN.n + 1100 };

function wgs84Box(): mapGeo.Wgs84Bounds {
  const p = mapGeo.proj()("EPSG:3006", "EPSG:4326");
  const pts = [[LM_BOX.minX, LM_BOX.minY], [LM_BOX.maxX, LM_BOX.minY], [LM_BOX.minX, LM_BOX.maxY], [LM_BOX.maxX, LM_BOX.maxY]].map((c) => p.forward(c));
  return { west: Math.min(...pts.map((q) => q[0])), east: Math.max(...pts.map((q) => q[0])), south: Math.min(...pts.map((q) => q[1])), north: Math.max(...pts.map((q) => q[1])) };
}

let cached: { lm: Uint8Array; glo: Uint8Array; gloUrl: string; lmWgs84: mapGeo.Wgs84Bounds } | null = null;

/** The two tiles, built once per process. */
export function demTiles(): NonNullable<typeof cached> {
  if (cached) return cached;
  const lm = buildSyntheticCog({
    surface: lmCone, epsg: 3006, width: LM_BOX.maxX - LM_BOX.minX, height: LM_BOX.maxY - LM_BOX.minY, cellX: 1, cellY: 1,
    originX: LM_BOX.minX, originY: LM_BOX.maxY, tile: 256, overviews: 2, nodata: -9999,
  });
  const ll = mapGeo.proj()("EPSG:3006", "EPSG:4326").forward([GLO_ORIGIN.e + 450, GLO_ORIGIN.n + 450]);
  const lat0 = Math.floor(ll[1]), lng0 = Math.floor(ll[0]);
  const cy = 1 / 3600, cx = 1 / 2400;
  // a 0.08° × 0.06° piece of the 1° tile around the map, PixelIsPoint, no nodata: GLO-30's own profile
  const glo = buildSyntheticCog({
    surface: gloPlane, epsg: 4326, width: Math.round(0.08 / cx), height: Math.round(0.06 / cy), cellX: cx, cellY: cy,
    originX: ll[0] - 0.04, originY: ll[1] + 0.03, tile: 128, overviews: 1, pixelIsPoint: true,
  });
  const name = glo30TileName(lat0, lng0);
  cached = { lm, glo, gloUrl: `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`, lmWgs84: wgs84Box() };
  return cached;
}

export interface DemFixture {
  fetch: RangeFetch;
  requests: { url: string; range: string | null; authorization: string | null }[];
  /** STAC's answer: the tile's item where the search box meets it (`ok`), or a status. */
  mode: { stac: "ok" | number };
  providers: () => DemProvider[];
}

export function demFixture(): DemFixture {
  const t = demTiles();
  const tiles = fakeRangeServer({ [LM_TILE_URL]: t.lm, [t.gloUrl]: t.glo });
  const mode: DemFixture["mode"] = { stac: "ok" };
  const requests = tiles.requests;
  const fetch: RangeFetch = async (url, init) => {
    if (!url.startsWith(`${STAC}/search`)) return tiles.fetch(url, init);
    const auth = Object.entries(init.headers).find(([k]) => k.toLowerCase() === "authorization")?.[1] ?? null;
    requests.push({ url, range: null, authorization: auth });
    if (mode.stac !== "ok") return new Response(JSON.stringify({ code: mode.stac }), { status: mode.stac });
    const bbox = (new URL(url).searchParams.get("bbox") ?? "").split(",").map(Number);
    const [w, s, e, n] = bbox, b = t.lmWgs84;
    const hit = w <= b.east && e >= b.west && s <= b.north && n >= b.south;
    const features = hit ? [{ type: "Feature", id: "test_67_40", assets: { data: { href: LM_TILE_URL, type: "image/tiff; application=geotiff; profile=cloud-optimized", roles: ["data"] } } }] : [];
    return new Response(JSON.stringify({ type: "FeatureCollection", features, links: [] }), { status: 200, headers: { "content-type": "application/geo+json" } });
  };
  return {
    fetch,
    requests,
    mode,
    providers: () => [lantmaterietProvider({ fetch, credential: TEST_CREDENTIAL, stac: STAC }), glo30Provider({ fetch })],
  };
}
