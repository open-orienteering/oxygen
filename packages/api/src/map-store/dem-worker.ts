/**
 * Worker-thread body for one DEM derive (docs/map-terrain.md §7.5,
 * docs/map-storage.md §4.7): the paper grid from the fetched windows, the
 * anchored contour field (`deriveAnchoredTerrain`) and the ground field on
 * its grid, both encoded. The host fetched the windows and owns the rows.
 *
 *   → { type: "done", ground, anchored }
 *   → { type: "unavailable", reason }   no-contours | no-coverage | misaligned
 *   → { type: "error", message }
 */

import { parentPort, workerData } from "node:worker_threads";
import { mapDocument, type mapGeo } from "@oxygen/shared";
import { deriveAnchoredTerrain } from "@oxygen/shared/src/terrain/index.js";
import { buildGroundField, encodeHeightField, HEIGHT_NO_DATA, type HeightFieldHeader, type HeightFieldProvider } from "@oxygen/shared/src/terrain/field/index.js";
import type { TerrainReport } from "@oxygen/shared/src/terrain/solve/types.js";
import type { AnchorReport, AnchoredHeights } from "@oxygen/shared/src/terrain/anchor/types.js";
import type { CogWindow } from "./dem-cog.js";
import { paperGrid, paperGridSampler, type PaperBox } from "./dem.js";

/** An anchor-grade DEM accepting less of the contour length it covers than this is misaligned (§7.0 answer 2). */
export const DEM_MISALIGNED_BELOW = 0.5;

export interface DemWorkerData {
  /** The encoded map document. */
  bytes: Uint8Array;
  frame: mapGeo.PaperFrame;
  paper: PaperBox;
  windows: CogWindow[];
  provider: HeightFieldProvider;
}

/** The anchored row's report: §3's at the top level (the 3D gate reads `share.decided`), §6's beside it. */
export type AnchoredReport = TerrainReport & { anchor: AnchorReport; heights: AnchoredHeights["report"] };

export type DemUnavailable = "no-contours" | "no-coverage" | "misaligned";

export type DemWorkerMessage =
  | {
      type: "done";
      ground: { bytes: Uint8Array; header: HeightFieldHeader; dataShare: number };
      anchored: { bytes: Uint8Array; header: HeightFieldHeader; report: AnchoredReport };
    }
  | { type: "unavailable"; reason: DemUnavailable; acceptedOfCovered?: number }
  | { type: "error"; message: string };

export type DemDerived = Exclude<DemWorkerMessage, { type: "error" }>;

/** The derive itself, apart from the thread plumbing (also the tests' in-process deriver). */
export function deriveDemFields(data: DemWorkerData): DemDerived {
  const doc = mapDocument.decodeMapDocument(data.bytes);
  const grid = paperGrid(data.frame, data.paper, data.windows, data.provider.resolutionM);
  const sample = paperGridSampler(grid);
  const t = deriveAnchoredTerrain(doc, { sample, grade: data.provider.grade, demCellM: data.provider.resolutionM, providerId: data.provider.id, provider: data.provider });
  if (!t) return { type: "unavailable", reason: "no-contours" };
  if (t.anchor.coverage === 0) return { type: "unavailable", reason: "no-coverage" };
  if (data.provider.grade === "anchor" && t.acceptedOfCovered < DEM_MISALIGNED_BELOW) return { type: "unavailable", reason: "misaligned", acceptedOfCovered: t.acceptedOfCovered };
  const ground = buildGroundField(sample, { grid: t.field.header, source: `ground.${data.provider.id}`, provider: data.provider });
  let withData = 0;
  for (const v of ground.z) if (v !== HEIGHT_NO_DATA) withData++;
  return {
    type: "done",
    ground: { bytes: encodeHeightField(ground), header: ground.header, dataShare: withData / ground.z.length },
    anchored: { bytes: encodeHeightField(t.field), header: t.field.header, report: { ...t.report, anchor: t.anchor, heights: t.heights } },
  };
}

const port = parentPort;
if (port && (workerData as Partial<DemWorkerData> | null)?.windows) {
  try {
    const m = deriveDemFields(workerData as DemWorkerData);
    if (m.type === "done") port.postMessage(m, [m.ground.bytes.buffer as ArrayBuffer, m.anchored.bytes.buffer as ArrayBuffer]);
    else port.postMessage(m);
  } catch (err: unknown) {
    port.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) } satisfies DemWorkerMessage);
  }
}
