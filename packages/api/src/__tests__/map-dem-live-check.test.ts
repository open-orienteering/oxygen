import { describe, expect, it } from "vitest";
import { liveVerdict, runLiveCheck } from "../map-store/dem-live-check.js";
import { LM_ORIGIN, STAC, TEST_CREDENTIAL, demFixture } from "./helpers/dem-fixture.js";
import { HILL, encodeTerrainDoc, sweref99 } from "./helpers/terrain-doc.js";

const hill = encodeTerrainDoc(HILL, "live-check", undefined, sweref99(LM_ORIGIN.e, LM_ORIGIN.n));

describe("the DEM live check (map-terrain.md §7.6), against the recorded fixture", () => {
  it("passes where ranges are served, the profile is read and the spread holds at 2 m", async () => {
    const fx = demFixture();
    const r = await runLiveCheck({ fetch: fx.fetch, credential: TEST_CREDENTIAL, document: hill, stac: STAC });
    expect(r.stac.items).toBe(1);
    expect(r.range).toMatchObject({ status: 206, error: null });
    expect(r.range.hops.every((h) => h.authorised && h.host.endsWith("lantmateriet.se"))).toBe(true);
    expect("error" in r.profile ? r.profile.error : r.profile.levels.map((l) => l.cellM)).toEqual([1, 2, 4]);
    if ("error" in r.spread) throw new Error(r.spread.error);
    expect(r.spread.at2m.acceptedOfCovered).toBeGreaterThan(0.95);
    expect(r.verdict).toEqual({ rangeServed: true, credentialContained: true, profileRead: true, has2m: true, spreadHolds: true, pass: true });
    expect(JSON.stringify(r)).not.toContain(TEST_CREDENTIAL);
  });

  it("fails without range support, and when the spread degrades at 2 m", async () => {
    const fx = demFixture();
    const ignoring: typeof fx.fetch = async (url, init) => (url.endsWith(".tif") ? new Response(new Uint8Array(8), { status: 200 }) : fx.fetch(url, init));
    const r = await runLiveCheck({ fetch: ignoring, credential: TEST_CREDENTIAL, document: hill, stac: STAC });
    expect(r.verdict).toMatchObject({ rangeServed: false, profileRead: false, pass: false });
    const base = { stac: { items: 1, assetHosts: [] }, range: { status: 206, contentRange: "bytes 0-1/2", hops: [], error: null }, profile: { epsg: 3006, pixelIsPoint: false, nodata: -9999, levels: [{ width: 2, height: 2, cellM: 2, compression: 8, predictor: 3 }] } };
    const spread = (a1: number, a2: number, iqr = 0.4) => ({ at1m: { coverage: 1, acceptedOfCovered: a1, halfIqrP50M: 0.4 }, at2m: { coverage: 1, acceptedOfCovered: a2, halfIqrP50M: iqr } });
    expect(liveVerdict({ ...base, spread: spread(0.95, 0.94) }, 5).pass).toBe(true);
    expect(liveVerdict({ ...base, spread: spread(0.95, 0.92) }, 5).spreadHolds).toBe(false);
    expect(liveVerdict({ ...base, spread: spread(0.95, 0.95, 1.6) }, 5).spreadHolds).toBe(false);
    expect(liveVerdict({ ...base, range: { ...base.range, hops: [{ host: "cdn.example.test", status: 206, authorised: true }] }, spread: spread(0.95, 0.95) }, 5).credentialContained).toBe(false);
  });
});
