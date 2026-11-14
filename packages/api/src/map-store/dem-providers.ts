/**
 * DEM providers (docs/map-terrain.md §7.1; SLICES answers 4, 5, 13, 16).
 *
 * Lantmäteriet's height STAC is the only anchor-grade provider: its
 * `dtm-cog` collection of 10 km cloud-optimised GeoTIFFs (SWEREF 99 TM,
 * RH 2000), read at the 2 m overview (answer 17), Basic auth with the
 * instance's one Geotorget account (answer 5). Copernicus GLO-30 is the
 * coarse fallback in its reduced role (answer 13): open COGs on AWS, one
 * per 1° cell, no account. Fetching is opt-in (§7.0 answer 4).
 *
 * The credential is sent only over https to Lantmäteriet's own hosts;
 * redirects are followed by hand, and one to any other host goes without
 * it. It appears in no log, error or row.
 */

import type { mapGeo } from "@oxygen/shared";
import type { HeightFieldProvider } from "@oxygen/shared/src/terrain/field/types.js";
import { DemFetchError, hostOf, type RangeFetch } from "./dem-cog.js";

export type DemProviderName = "lantmateriet" | "glo30";

export interface DemTile {
  url: string;
}

export interface DemProvider {
  name: DemProviderName;
  /** `HeightFieldProvider` for the header's block and the descriptor: id = name + resolution (`lantmateriet-2m`). */
  info: HeightFieldProvider;
  /** The CRS pixel size to read at (metres or degrees), for `chooseLevel`. */
  targetCell: number;
  /** A fetch that adds the provider's auth where it may go. */
  fetch: RangeFetch;
  /** A missing tile is sea / outside the model, not a failure (GLO-30). */
  missingTileIsNoData: boolean;
  /** The tiles covering a WGS 84 box; `no-coverage` when there are none. */
  locate(box: mapGeo.Wgs84Bounds): Promise<DemTile[] | "no-coverage">;
}

export const LANTMATERIET = {
  stac: "https://api.lantmateriet.se/stac-hojd/v1",
  collection: "dtm-cog",
  licence: "CC BY 4.0",
  attribution: "© Lantmäteriet",
  verticalDatum: "RH 2000",
  /** Default resolution read: the COG's 2 m overview (answer 17). */
  resolutionM: 2,
  /** STAC pages followed at most. */
  maxPages: 10,
} as const;

export const GLO30 = {
  base: "https://copernicus-dem-30m.s3.amazonaws.com",
  licence: "Copernicus DEM licence (free, with attribution)",
  attribution: "© DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA",
  verticalDatum: "EGM2008",
  resolutionM: 30,
} as const;

/** Tiles per document at most (a 10 km LM tile: a map over 16 of them is a region, not a map). */
export const DEM_MAX_TILES = 16;

/** Hosts the Lantmäteriet credential may be sent to: https, `lantmateriet.se` and its subdomains. */
export function isLantmaterietHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "lantmateriet.se" || u.hostname.endsWith(".lantmateriet.se"));
  } catch {
    return false;
  }
}

/**
 * A fetch that sends `Authorization` only to hosts `trusted` accepts,
 * follows up to five redirects by hand (dropping the header on a hop to
 * any other host) and never follows one to plain http.
 */
export function guardedFetch(base: RangeFetch, authorization: string | null, trusted: (url: string) => boolean): RangeFetch {
  return async (url, init) => {
    let at = url;
    for (let hop = 0; hop <= 5; hop++) {
      if (!at.startsWith("https://")) throw new DemFetchError("http", `refused a non-https DEM URL on ${hostOf(at)}`);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(init.headers)) if (k.toLowerCase() !== "authorization") headers[k] = v;
      if (authorization && trusted(at)) headers.Authorization = authorization;
      const res = await base(at, { ...init, headers, redirect: "manual" });
      if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
      const loc = res.headers.get("location");
      await res.body?.cancel();
      if (!loc) throw new DemFetchError("http", `${hostOf(at)} redirected without a location`, res.status);
      at = new URL(loc, at).toString();
    }
    throw new DemFetchError("http", `too many redirects from ${hostOf(url)}`);
  };
}

const basic = (credential: string): string => `Basic ${Buffer.from(credential, "utf8").toString("base64")}`;

interface StacItem {
  id?: unknown;
  assets?: Record<string, { href?: unknown; type?: unknown; roles?: unknown }>;
}

/** The COG asset of a STAC item: a cloud-optimised GeoTIFF by media type, else the `data` role's GeoTIFF. */
export function cogAsset(item: StacItem): string | null {
  const assets = Object.values(item.assets ?? {});
  const href = (a: { href?: unknown }) => (typeof a.href === "string" ? a.href : null);
  const type = (a: { type?: unknown }) => (typeof a.type === "string" ? a.type.toLowerCase() : "");
  const cog = assets.find((a) => type(a).includes("image/tiff") && type(a).includes("cloud-optimized"));
  if (cog && href(cog)) return href(cog);
  const data = assets.find((a) => Array.isArray(a.roles) && a.roles.includes("data") && (type(a).includes("tiff") || /\.tiff?$/i.test(href(a) ?? "")));
  return data ? href(data) : null;
}

export function lantmaterietProvider(opts: { fetch: RangeFetch; credential: string; resolutionM?: number; stac?: string }): DemProvider {
  const resolutionM = opts.resolutionM ?? LANTMATERIET.resolutionM;
  const fetch = guardedFetch(opts.fetch, basic(opts.credential), isLantmaterietHost);
  const stac = opts.stac ?? LANTMATERIET.stac;
  return {
    name: "lantmateriet",
    info: { id: `lantmateriet-${resolutionM}m`, resolutionM, grade: "anchor", licence: LANTMATERIET.licence, attribution: LANTMATERIET.attribution, verticalDatum: LANTMATERIET.verticalDatum },
    targetCell: resolutionM,
    fetch,
    missingTileIsNoData: false,
    async locate(box) {
      const q = new URLSearchParams({ collections: LANTMATERIET.collection, bbox: [box.west, box.south, box.east, box.north].join(","), limit: "100" });
      let next: string | null = `${stac}/search?${q}`;
      const tiles: DemTile[] = [];
      for (let page = 0; next && page < LANTMATERIET.maxPages; page++) {
        let res: Response;
        try {
          res = await fetch(next, { headers: { Accept: "application/geo+json, application/json" }, signal: AbortSignal.timeout(30_000) });
        } catch (err: unknown) {
          if (err instanceof DemFetchError) throw err;
          const name = err instanceof Error ? err.name : "";
          throw new DemFetchError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "http", `STAC search on ${hostOf(next)} failed`);
        }
        if (res.status === 401 || res.status === 403) throw new DemFetchError("auth", `Lantmäteriet refused the STAC search (${res.status})`, res.status);
        if (res.status !== 200) throw new DemFetchError("http", `Lantmäteriet's STAC answered ${res.status}`, res.status);
        let body: { features?: StacItem[]; links?: { rel?: unknown; href?: unknown; method?: unknown }[] };
        try {
          body = (await res.json()) as typeof body;
        } catch {
          throw new DemFetchError("format", "Lantmäteriet's STAC answered something other than JSON");
        }
        if (!Array.isArray(body.features)) throw new DemFetchError("format", "Lantmäteriet's STAC answer has no features");
        for (const f of body.features) {
          const href = cogAsset(f);
          if (href) tiles.push({ url: new URL(href, next).toString() });
        }
        const link = body.links?.find((l) => l.rel === "next" && typeof l.href === "string" && (l.method === undefined || l.method === "GET"));
        next = link ? new URL(link.href as string, next).toString() : null;
      }
      if (tiles.length === 0) return "no-coverage";
      if (tiles.length > DEM_MAX_TILES) throw new DemFetchError("over-cap", `the extent needs ${tiles.length} tiles, over the cap of ${DEM_MAX_TILES}`);
      return dedupe(tiles);
    },
  };
}

/** GLO-30's tile name for the 1° cell whose south-west corner is (lat, lng), e.g. `Copernicus_DSM_COG_10_N59_00_E018_00_DEM`. */
export function glo30TileName(lat: number, lng: number): string {
  const ns = lat < 0 ? "S" : "N", ew = lng < 0 ? "W" : "E";
  return `Copernicus_DSM_COG_10_${ns}${String(Math.abs(lat)).padStart(2, "0")}_00_${ew}${String(Math.abs(lng)).padStart(3, "0")}_00_DEM`;
}

export function glo30Provider(opts: { fetch: RangeFetch; base?: string }): DemProvider {
  const base = opts.base ?? GLO30.base;
  return {
    name: "glo30",
    info: { id: "glo30-30m", resolutionM: GLO30.resolutionM, grade: "coarse", licence: GLO30.licence, attribution: GLO30.attribution, verticalDatum: GLO30.verticalDatum },
    // the full resolution: 1″ of latitude (its overviews are coarser than 30 m)
    targetCell: 1 / 3600,
    fetch: guardedFetch(opts.fetch, null, () => false),
    missingTileIsNoData: true,
    async locate(box) {
      if (box.south < -90 || box.north > 90 || !(box.north >= box.south) || !(box.east >= box.west)) return "no-coverage";
      const tiles: DemTile[] = [];
      for (let lat = Math.floor(box.south); lat <= Math.floor(box.north) && lat < 90; lat++)
        for (let lng = Math.floor(box.west); lng <= Math.floor(box.east); lng++) {
          const name = glo30TileName(lat, ((lng + 180) % 360 + 360) % 360 - 180);
          tiles.push({ url: `${base}/${name}/${name}.tif` });
        }
      if (tiles.length > DEM_MAX_TILES) throw new DemFetchError("over-cap", `the extent needs ${tiles.length} tiles, over the cap of ${DEM_MAX_TILES}`);
      return tiles;
    },
  };
}

function dedupe(tiles: DemTile[]): DemTile[] {
  const seen = new Set<string>();
  return tiles.filter((t) => (seen.has(t.url) ? false : (seen.add(t.url), true)));
}

/**
 * The enabled providers in order, Lantmäteriet first (§7.0 answer 4):
 * `MAP_DEM_PROVIDERS` names them (comma list; empty = none);
 * Lantmäteriet needs `MAP_DEM_LANTMATERIET_AUTH` as `user:password`
 * (the Geotorget secret) and reads `MAP_DEM_LANTMATERIET_RESOLUTION_M`
 * (2, or 1 for the full model). Misconfiguration is warned once, never
 * thrown, and never prints the credential.
 */
export function demProvidersFromEnv(env: NodeJS.ProcessEnv, fetch: RangeFetch, warn: (msg: string) => void = (m) => console.warn(`[map-dem] ${m}`)): DemProvider[] {
  const names = (env.MAP_DEM_PROVIDERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const n of names) if (n !== "lantmateriet" && n !== "glo30") warn(`ignoring unknown DEM provider ${JSON.stringify(n)} in MAP_DEM_PROVIDERS`);
  const out: DemProvider[] = [];
  if (names.includes("lantmateriet")) {
    const cred = env.MAP_DEM_LANTMATERIET_AUTH ?? "";
    const res = env.MAP_DEM_LANTMATERIET_RESOLUTION_M;
    const resolutionM = res === "1" ? 1 : 2;
    if (res !== undefined && res !== "" && res !== "1" && res !== "2") warn(`MAP_DEM_LANTMATERIET_RESOLUTION_M must be 1 or 2; reading 2`);
    if (/^[^:]+:.+$/s.test(cred)) out.push(lantmaterietProvider({ fetch, credential: cred, resolutionM }));
    else warn(cred === "" ? "Lantmäteriet is named in MAP_DEM_PROVIDERS but MAP_DEM_LANTMATERIET_AUTH is not set; it is off" : "MAP_DEM_LANTMATERIET_AUTH is not of the form user:password; Lantmäteriet is off");
  }
  if (names.includes("glo30")) out.push(glo30Provider({ fetch }));
  return out;
}
