import { describe, expect, it } from "vitest";
import { cogAsset, demProvidersFromEnv, glo30Provider, glo30TileName, guardedFetch, isLantmaterietHost, lantmaterietProvider } from "../map-store/dem-providers.js";
import { fakeRangeServer } from "./helpers/synthetic-cog.js";

const CRED = "club-user:not-a-real-secret";
const STAC = "https://api.lantmateriet.se/stac-hojd/v1";
const BOX = { west: 18.0, south: 59.3, east: 18.1, north: 59.35 };
const item = (id: string, href: string) => ({
  type: "Feature", id, assets: {
    thumbnail: { href: `https://api.lantmateriet.se/x/${id}.png`, type: "image/png", roles: ["thumbnail"] },
    data: { href, type: "image/tiff; application=geotiff; profile=cloud-optimized", roles: ["data"] },
  },
});
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/geo+json" } });

describe("Lantmäteriet's STAC (map-terrain.md §7.1)", () => {
  it("searches dtm-cog by the WGS 84 box with Basic auth, follows next links and picks the COG asset", async () => {
    const q = `collections=dtm-cog&bbox=18%2C59.3%2C18.1%2C59.35&limit=100`;
    const server = fakeRangeServer({
      [`${STAC}/search?${q}`]: json({ type: "FeatureCollection", features: [item("a", "https://dl.lantmateriet.se/hojd/a.tif")], links: [{ rel: "next", href: `${STAC}/search?page=2` }] }),
      [`${STAC}/search?page=2`]: json({ type: "FeatureCollection", features: [item("b", "https://dl.lantmateriet.se/hojd/b.tif"), item("a", "https://dl.lantmateriet.se/hojd/a.tif")], links: [] }),
    });
    const p = lantmaterietProvider({ fetch: server.fetch, credential: CRED });
    expect(p.info).toEqual({ id: "lantmateriet-2m", resolutionM: 2, grade: "anchor", licence: "CC BY 4.0", attribution: "© Lantmäteriet", verticalDatum: "RH 2000" });
    expect(await p.locate(BOX)).toEqual([{ url: "https://dl.lantmateriet.se/hojd/a.tif" }, { url: "https://dl.lantmateriet.se/hojd/b.tif" }]);
    expect(server.requests.map((r) => r.authorization)).toEqual([`Basic ${Buffer.from(CRED).toString("base64")}`, `Basic ${Buffer.from(CRED).toString("base64")}`]);
  });

  it("is no-coverage with no items, and maps refusals and failures", async () => {
    const empty = fakeRangeServer({ [`${STAC}/search?collections=dtm-cog&bbox=18%2C59.3%2C18.1%2C59.35&limit=100`]: json({ features: [] }) });
    expect(await lantmaterietProvider({ fetch: empty.fetch, credential: CRED }).locate(BOX)).toBe("no-coverage");
    for (const [status, reason] of [[401, "auth"], [403, "auth"], [429, "http"], [502, "http"]] as const) {
      const s = fakeRangeServer({ [`${STAC}/search?collections=dtm-cog&bbox=18%2C59.3%2C18.1%2C59.35&limit=100`]: json({}, status) });
      const err = await lantmaterietProvider({ fetch: s.fetch, credential: CRED }).locate(BOX).catch((e: unknown) => e);
      expect(err).toMatchObject({ reason, status });
      expect(String((err as Error).message)).not.toContain("not-a-real-secret");
    }
    const bad = fakeRangeServer({ [`${STAC}/search?collections=dtm-cog&bbox=18%2C59.3%2C18.1%2C59.35&limit=100`]: () => new Response("<html>", { status: 200 }) });
    await expect(lantmaterietProvider({ fetch: bad.fetch, credential: CRED }).locate(BOX)).rejects.toMatchObject({ reason: "format" });
  });

  it("reads the 1 m model when told to", () => {
    const p = lantmaterietProvider({ fetch: fakeRangeServer({}).fetch, credential: CRED, resolutionM: 1 });
    expect(p.info.id).toBe("lantmateriet-1m");
    expect(p.targetCell).toBe(1);
  });

  it("finds the COG asset by media type, or the data role's GeoTIFF", () => {
    expect(cogAsset({ assets: { a: { href: "x.png", type: "image/png" }, b: { href: "y.tif", type: "image/tiff; application=geotiff; profile=cloud-optimized" } } })).toBe("y.tif");
    expect(cogAsset({ assets: { d: { href: "z.tif", roles: ["data"] } } })).toBe("z.tif");
    expect(cogAsset({ assets: { t: { href: "t.png", roles: ["thumbnail"] } } })).toBeNull();
    expect(cogAsset({})).toBeNull();
  });
});

describe("the credential's reach (§7.1, answer 5)", () => {
  it("is sent only over https to Lantmäteriet's hosts", () => {
    expect(isLantmaterietHost("https://api.lantmateriet.se/stac-hojd/v1")).toBe(true);
    expect(isLantmaterietHost("https://lantmateriet.se/a")).toBe(true);
    expect(isLantmaterietHost("http://api.lantmateriet.se/a")).toBe(false);
    expect(isLantmaterietHost("https://lantmateriet.se.evil.example/a")).toBe(false);
    expect(isLantmaterietHost("https://evillantmateriet.se/a")).toBe(false);
    expect(isLantmaterietHost("nonsense")).toBe(false);
  });

  it("follows redirects by hand: kept on Lantmäteriet's hosts, dropped elsewhere, refused to http", async () => {
    const server = fakeRangeServer({
      "https://dl.lantmateriet.se/a.tif": () => new Response(null, { status: 302, headers: { location: "https://files.lantmateriet.se/a.tif" } }),
      "https://files.lantmateriet.se/a.tif": () => new Response(null, { status: 307, headers: { location: "https://signed.example-cdn.test/a.tif?sig=1" } }),
      "https://signed.example-cdn.test/a.tif?sig=1": () => new Response("ok", { status: 206 }),
      "https://dl.lantmateriet.se/b.tif": () => new Response(null, { status: 302, headers: { location: "http://plain.example.test/b.tif" } }),
    });
    const f = guardedFetch(server.fetch, "Basic xyz", isLantmaterietHost);
    expect((await f("https://dl.lantmateriet.se/a.tif", { headers: { Range: "bytes=0-1", Authorization: "Basic smuggled" } })).status).toBe(206);
    expect(server.requests.map((r) => [new URL(r.url).host, r.authorization, r.range])).toEqual([
      ["dl.lantmateriet.se", "Basic xyz", "bytes=0-1"],
      ["files.lantmateriet.se", "Basic xyz", "bytes=0-1"],
      ["signed.example-cdn.test", null, "bytes=0-1"],
    ]);
    await expect(f("https://dl.lantmateriet.se/b.tif", { headers: {} })).rejects.toMatchObject({ reason: "http", message: /non-https/ });
  });
});

describe("Copernicus GLO-30 (§7.1, answer 13)", () => {
  it("names tiles by their south-west corner in every quadrant", () => {
    expect(glo30TileName(59, 18)).toBe("Copernicus_DSM_COG_10_N59_00_E018_00_DEM");
    expect(glo30TileName(43, 3)).toBe("Copernicus_DSM_COG_10_N43_00_E003_00_DEM");
    expect(glo30TileName(-1, -71)).toBe("Copernicus_DSM_COG_10_S01_00_W071_00_DEM");
  });

  it("covers the box with 1° tiles, coarse grade, no credential anywhere", async () => {
    const server = fakeRangeServer({});
    const p = glo30Provider({ fetch: server.fetch });
    expect(p.info).toMatchObject({ id: "glo30-30m", grade: "coarse", resolutionM: 30, verticalDatum: "EGM2008" });
    expect(p.missingTileIsNoData).toBe(true);
    expect(await p.locate({ west: 17.9, south: 59.9, east: 18.2, north: 60.1 })).toEqual([
      "N59_00_E017", "N59_00_E018", "N60_00_E017", "N60_00_E018",
    ].map((c) => ({ url: `https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_${c}_00_DEM/Copernicus_DSM_COG_10_${c}_00_DEM.tif` })));
    await p.fetch("https://copernicus-dem-30m.s3.amazonaws.com/x.tif", { headers: { Authorization: "Basic leak" } });
    expect(server.requests[0].authorization).toBeNull();
  });

  it("refuses an extent over the tile cap", async () => {
    await expect(glo30Provider({ fetch: fakeRangeServer({}).fetch }).locate({ west: 10, south: 50, east: 15, north: 54 })).rejects.toMatchObject({ reason: "over-cap" });
  });
});

describe("demProvidersFromEnv (§7.0 answer 4)", () => {
  const f = fakeRangeServer({}).fetch;
  it("is off unless MAP_DEM_PROVIDERS names providers, and keeps Lantmäteriet first", () => {
    expect(demProvidersFromEnv({}, f)).toEqual([]);
    expect(demProvidersFromEnv({ MAP_DEM_PROVIDERS: "" }, f)).toEqual([]);
    expect(demProvidersFromEnv({ MAP_DEM_PROVIDERS: "glo30,lantmateriet", MAP_DEM_LANTMATERIET_AUTH: CRED }, f).map((p) => p.info.id)).toEqual(["lantmateriet-2m", "glo30-30m"]);
    expect(demProvidersFromEnv({ MAP_DEM_PROVIDERS: "lantmateriet", MAP_DEM_LANTMATERIET_AUTH: CRED, MAP_DEM_LANTMATERIET_RESOLUTION_M: "1" }, f).map((p) => p.info.id)).toEqual(["lantmateriet-1m"]);
  });

  it("trims the newline a secret typed at the prompt ends in", async () => {
    const server = fakeRangeServer({ [`${STAC}/search?collections=dtm-cog&bbox=18%2C59.3%2C18.1%2C59.35&limit=100`]: json({ features: [] }) });
    const [lm] = demProvidersFromEnv({ MAP_DEM_PROVIDERS: "lantmateriet", MAP_DEM_LANTMATERIET_AUTH: `${CRED}\n` }, server.fetch);
    await lm.locate(BOX);
    expect(server.requests[0].authorization).toBe(`Basic ${Buffer.from(CRED).toString("base64")}`);
  });

  it("leaves Lantmäteriet off without a credential of the right form, and never prints it", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(demProvidersFromEnv({ MAP_DEM_PROVIDERS: "lantmateriet,glo30" }, f, warn).map((p) => p.name)).toEqual(["glo30"]);
    expect(demProvidersFromEnv({ MAP_DEM_PROVIDERS: "lantmateriet", MAP_DEM_LANTMATERIET_AUTH: "no-colon-secret" }, f, warn)).toEqual([]);
    expect(demProvidersFromEnv({ MAP_DEM_PROVIDERS: "srtm" }, f, warn)).toEqual([]);
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).not.toContain("no-colon-secret");
  });
});
