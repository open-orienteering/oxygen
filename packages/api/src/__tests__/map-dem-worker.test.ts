import { describe, expect, it } from "vitest";
import { mapDocument, type mapGeo } from "@oxygen/shared";
import { decodeHeightField, isConfident, sampleHeight } from "@oxygen/shared/src/terrain/field/index.js";
import { deriveTerrain } from "@oxygen/shared/src/terrain/index.js";
import { documentDemExtent, fetchDemMosaic } from "../map-store/dem.js";
import { deriveDemInWorker } from "../map-store/dem-jobs.js";
import { deriveDemFields, type DemWorkerData } from "../map-store/dem-worker.js";
import type { DemProvider } from "../map-store/dem-providers.js";
import { CONE_TOP, GLO_ORIGIN, LM_ORIGIN, demFixture } from "./helpers/dem-fixture.js";
import { FLAT, HILL, encodeTerrainDoc, sweref99 } from "./helpers/terrain-doc.js";

async function workerData(bytes: Uint8Array, provider: DemProvider): Promise<DemWorkerData> {
  const { header } = mapDocument.readMapDocumentHeader(bytes);
  const frame: mapGeo.PaperFrame = { unitsPerMm: header.unitsPerMm, mapScale: header.mapScale, georeferencing: header.georeferencing };
  const extent = documentDemExtent(frame, header)!;
  const m = await fetchDemMosaic(provider, frame, extent);
  if (m === "no-coverage") throw new Error("no coverage");
  return { bytes, frame, paper: extent.paper, windows: m.windows, provider: provider.info };
}

describe("the DEM derive (map-terrain.md §7.4–7.5)", () => {
  const hill = encodeTerrainDoc(HILL, "dem-worker", undefined, sweref99(LM_ORIGIN.e, LM_ORIGIN.n));

  it("derives the ground field and the anchored field on the contours field's grid", async () => {
    const [lm] = demFixture().providers();
    const out = deriveDemFields(await workerData(hill, lm));
    if (out.type !== "done") throw new Error(out.type === "unavailable" ? out.reason : "?");
    const contours = deriveTerrain(mapDocument.decodeMapDocument(hill))!.field.header;
    for (const h of [out.ground.header, out.anchored.header]) {
      expect({ cellMm: h.cellMm, x0: h.x0, y0: h.y0, width: h.width, height: h.height }).toEqual({ cellMm: contours.cellMm, x0: contours.x0, y0: contours.y0, width: contours.width, height: contours.height });
      expect(h).toMatchObject({ datum: "absolute", provider: { id: "lantmateriet-2m", licence: "CC BY 4.0", attribution: "© Lantmäteriet", grade: "anchor" } });
    }
    expect(out.ground.header.source).toBe("ground.lantmateriet-2m");
    expect(out.anchored.header.source).toBe("contours.lantmateriet-2m");
    const ground = decodeHeightField(out.ground.bytes), anchored = decodeHeightField(out.anchored.bytes);
    for (const r of [7.5, 12.5, 17.5]) {
      expect(Math.abs(sampleHeight(ground, { x: 30 + r, y: 30 })! - (CONE_TOP - r))).toBeLessThan(0.15);
      expect(Math.abs(sampleHeight(anchored, { x: 30, y: 30 - r })! - (CONE_TOP - r))).toBeLessThan(0.5);
    }
    expect(isConfident(ground, 0)).toBe(true);
    expect(out.ground.dataShare).toBe(1);
    expect(out.anchored.report.anchor).toMatchObject({ source: "lantmateriet-2m", grade: "anchor" });
    expect(out.anchored.report.share.decided).toBeGreaterThan(0.99);
    expect(out.anchored.report.heights.share.dem).toBeGreaterThan(0.9);
  });

  it("runs in a worker thread to the same bytes", async () => {
    const [lm] = demFixture().providers();
    const inline = deriveDemFields(await workerData(hill, lm));
    const threaded = await deriveDemInWorker(await workerData(hill, lm));
    expect(threaded.type).toBe("done");
    if (threaded.type !== "done" || inline.type !== "done") return;
    expect(threaded.ground.bytes).toEqual(inline.ground.bytes);
    expect(threaded.anchored.bytes).toEqual(inline.anchored.bytes);
  }, 60_000);

  it("is misaligned when the contours sit off the model, and no-contours without contours", async () => {
    const [lm] = demFixture().providers();
    const off = encodeTerrainDoc(HILL, "dem-worker-off", undefined, sweref99(LM_ORIGIN.e + 225, LM_ORIGIN.n));
    expect(deriveDemFields(await workerData(off, lm))).toMatchObject({ type: "unavailable", reason: "misaligned" });
    const flat = encodeTerrainDoc(FLAT, "dem-worker-flat", undefined, sweref99(LM_ORIGIN.e, LM_ORIGIN.n));
    expect(deriveDemFields(await workerData(flat, lm))).toEqual({ type: "unavailable", reason: "no-contours" });
  });

  it("derives GLO-30 as a coarse model: absolute, no ground confidence, no misalignment gate", async () => {
    const [, glo] = demFixture().providers();
    const doc = encodeTerrainDoc(HILL, "dem-worker-glo", undefined, sweref99(GLO_ORIGIN.e, GLO_ORIGIN.n));
    const out = deriveDemFields(await workerData(doc, glo));
    if (out.type !== "done") throw new Error(out.type === "unavailable" ? out.reason : "?");
    expect(out.ground.header).toMatchObject({ source: "ground.glo30-30m", provider: { grade: "coarse", verticalDatum: "EGM2008" } });
    expect(isConfident(decodeHeightField(out.ground.bytes), 0)).toBe(false);
    expect(out.anchored.report.anchor.grade).toBe("coarse");
  });
});
