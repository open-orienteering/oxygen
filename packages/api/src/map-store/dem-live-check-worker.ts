/**
 * Worker-thread body for *Test connection* (docs/map-terrain.md §7.8):
 * §7.6's live check off the API's main thread — it builds the contour
 * graph and holds up to ~250 MB of windows at 1 m. Requests go through
 * the stack's base fetch (`MAP_DEM_OFFLINE` holds here too).
 *
 *   → { type: "done", report }
 *   → { type: "error", message }
 */

import { parentPort, workerData } from "node:worker_threads";
import { runLiveCheck, type LiveCheckReport } from "./dem-live-check.js";
import { demBaseFetch } from "./dem-providers.js";

export interface LiveCheckWorkerData {
  /** `user:password`; in memory only. */
  credential: string;
  document: Uint8Array;
}

export type LiveCheckWorkerMessage = { type: "done"; report: LiveCheckReport } | { type: "error"; message: string };

const port = parentPort;
const data = workerData as Partial<LiveCheckWorkerData> | null;
if (port && typeof data?.credential === "string" && data.document) {
  runLiveCheck({ fetch: demBaseFetch(process.env), credential: data.credential, document: data.document })
    .then((report) => port.postMessage({ type: "done", report } satisfies LiveCheckWorkerMessage))
    .catch((err: unknown) => port.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) } satisfies LiveCheckWorkerMessage));
}
