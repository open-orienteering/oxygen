/**
 * The live check (docs/map-terrain.md §7.6; SLICES answer 17): before the
 * 2 m overview is trusted, confirm against Lantmäteriet's real service that
 * range requests are served (through any redirect, with the credential
 * reaching only Lantmäteriet's hosts), that the `dtm-cog` tiles have the
 * profile `dem-cog.ts` reads, and that the anchor's spread holds at 2 m
 * against 1 m on a real map. Run by the operator with their own credential
 * (`pnpm --filter @oxygen/api dem:live-check`); tests run it against the
 * recorded fixture. Reports aggregates only — no height leaves the process.
 */

import { mapDocument, type mapGeo } from "@oxygen/shared";
import { anchorLevels } from "@oxygen/shared/src/terrain/anchor/index.js";
import { buildContourGraph } from "@oxygen/shared/src/terrain/graph/index.js";
import { contourIntervalM } from "@oxygen/shared/src/terrain/index.js";
import { DemFetchError, hostOf, readCogInfo, type RangeFetch } from "./dem-cog.js";
import { isLantmaterietHost, lantmaterietProvider } from "./dem-providers.js";
import { documentDemExtent, fetchDemMosaic, paperGrid, paperGridSampler } from "./dem.js";

export const LIVE_CHECK_RULES = {
  /** Accepted share of covered contour length may drop by at most this from 1 m to 2 m. */
  maxAcceptedDrop: 0.02,
  /** The along-contour half-IQR median at 2 m, in intervals (§6.4's acceptance bound). */
  maxHalfIqrP50: 0.3,
} as const;

export interface LiveSpread {
  coverage: number;
  /** Accepted over covered contour length. */
  acceptedOfCovered: number;
  halfIqrP50M: number;
}

export interface LiveCheckReport {
  stac: { items: number; assetHosts: string[] };
  range: { status: number | null; contentRange: string | null; hops: { host: string; status: number; authorised: boolean }[]; error: string | null };
  profile: { epsg: number; pixelIsPoint: boolean; nodata: number | null; levels: { width: number; height: number; cellM: number; compression: number; predictor: number }[] } | { error: string };
  spread: { at1m: LiveSpread; at2m: LiveSpread } | { error: string };
  verdict: { rangeServed: boolean; credentialContained: boolean; profileRead: boolean; has2m: boolean; spreadHolds: boolean; pass: boolean };
}

/** The pass rule (§7.6). */
export function liveVerdict(r: Omit<LiveCheckReport, "verdict">, intervalM: number): LiveCheckReport["verdict"] {
  const rangeServed = r.range.status === 206 && r.range.contentRange !== null;
  const credentialContained = r.range.hops.every((h) => !h.authorised || isLantmaterietHost(`https://${h.host}/`));
  const profileRead = !("error" in r.profile);
  const has2m = profileRead && (r.profile as Exclude<LiveCheckReport["profile"], { error: string }>).levels.some((l) => Math.abs(l.cellM - 2) < 1e-6);
  const s = "error" in r.spread ? null : r.spread;
  const spreadHolds = s !== null && s.at2m.acceptedOfCovered >= s.at1m.acceptedOfCovered - LIVE_CHECK_RULES.maxAcceptedDrop && s.at2m.halfIqrP50M <= LIVE_CHECK_RULES.maxHalfIqrP50 * intervalM;
  return { rangeServed, credentialContained, profileRead, has2m, spreadHolds, pass: rangeServed && credentialContained && profileRead && has2m && spreadHolds };
}

export interface LiveCheckInput {
  fetch: RangeFetch;
  /** `user:password`; never printed. */
  credential: string;
  /** An encoded map document with contours, georeferenced inside Lantmäteriet's coverage. */
  document: Uint8Array;
  stac?: string;
}

export async function runLiveCheck(input: LiveCheckInput): Promise<LiveCheckReport> {
  const doc = mapDocument.decodeMapDocument(input.document);
  const { header } = mapDocument.readMapDocumentHeader(input.document);
  const frame: mapGeo.PaperFrame = { unitsPerMm: header.unitsPerMm, mapScale: header.mapScale, georeferencing: header.georeferencing };
  const extent = documentDemExtent(frame, header);
  if (!extent) throw new Error("the map is not georeferenced in a CRS proj4 knows");
  const intervalM = contourIntervalM(header);

  // every hop, its status and whether it carried the credential
  const hops: LiveCheckReport["range"]["hops"] = [];
  const recording: RangeFetch = async (url, init) => {
    const res = await input.fetch(url, init);
    hops.push({ host: hostOf(url), status: res.status, authorised: Object.keys(init.headers).some((k) => k.toLowerCase() === "authorization") });
    return res;
  };
  const at = (resolutionM: number) => lantmaterietProvider({ fetch: recording, credential: input.credential, resolutionM, stac: input.stac });
  const lm2 = at(2);

  const tiles = await lm2.locate(extent.wgs84);
  const list = tiles === "no-coverage" ? [] : tiles;
  const stac = { items: list.length, assetHosts: [...new Set(list.map((t) => hostOf(t.url)))] };
  const range: LiveCheckReport["range"] = { status: null, contentRange: null, hops: [], error: null };
  let profile: LiveCheckReport["profile"] = { error: "no tile covers the map" };
  if (list[0]) {
    hops.length = 0;
    try {
      const res = await lm2.fetch(list[0].url, { headers: { Range: "bytes=0-1023" }, signal: AbortSignal.timeout(30_000) });
      range.status = res.status;
      range.contentRange = res.headers.get("content-range");
      await res.body?.cancel();
    } catch (err: unknown) {
      range.error = err instanceof Error ? err.message : String(err);
    }
    range.hops = [...hops];
    try {
      const info = await readCogInfo({ fetch: lm2.fetch, url: list[0].url });
      profile = { epsg: info.epsg, pixelIsPoint: info.pixelIsPoint, nodata: info.nodata, levels: info.levels.map((l) => ({ width: l.width, height: l.height, cellM: l.cellX, compression: l.compression, predictor: l.predictor })) };
    } catch (err: unknown) {
      profile = { error: err instanceof DemFetchError ? `${err.reason}: ${err.message}` : String(err) };
    }
  }

  let spread: LiveCheckReport["spread"] = { error: "no tile covers the map" };
  const graph = buildContourGraph(doc);
  if (!graph) spread = { error: "the map has no contours" };
  else if (list.length > 0 && !("error" in profile)) {
    try {
      const measure = async (resolutionM: number): Promise<LiveSpread> => {
        const p = at(resolutionM);
        const m = await fetchDemMosaic(p, frame, extent);
        if (m === "no-coverage") throw new Error("no coverage");
        const sample = paperGridSampler(paperGrid(frame, extent.paper, m.windows, resolutionM));
        const a = anchorLevels(graph, sample, { intervalM, source: p.info.id, grade: "anchor", demCellM: resolutionM });
        return { coverage: a.report.coverage, acceptedOfCovered: a.report.coverage > 0 ? a.report.share.accepted / a.report.coverage : 0, halfIqrP50M: a.report.alongContour.halfIqrP50 };
      };
      spread = { at1m: await measure(1), at2m: await measure(2) };
    } catch (err: unknown) {
      spread = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  const report = { stac, range, profile, spread };
  return { ...report, verdict: liveVerdict(report, intervalM) };
}
