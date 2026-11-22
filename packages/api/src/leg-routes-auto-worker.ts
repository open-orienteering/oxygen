/**
 * Worker-thread body for a batch of automatic leg routes
 * (docs/course-elevation.md §7.5): decode the document, apply the
 * event's patch, classify its objects once, then the shortest legal
 * route of each job. The host owns the rows; this thread only computes.
 *
 *   → { type: "done", routes }    one per job: interior vertices, or null without a way
 *   → { type: "error", message }
 */

import { parentPort, workerData } from "node:worker_threads";
import { mapDocument } from "@oxygen/shared";
import { BLOCKED, boxedFeature, routeFeaturesOfDocument, shortestLegRoute, type RoutePoint } from "@oxygen/shared/src/route/index.js";
import type { AutoRouteWorkerData, AutoRouteWorkerMessage } from "./leg-routes-auto.js";

/** The searches themselves, apart from the thread plumbing (also the unit tests' oracle). */
export function searchAutoRoutes(data: AutoRouteWorkerData): (RoutePoint[] | null)[] {
  const decoded = mapDocument.decodeMapDocument(data.bytes);
  const features = routeFeaturesOfDocument(mapDocument.applyPatch(decoded, data.patch ?? undefined).document);
  return data.jobs.map((job) => shortestLegRoute(features, {
    from: job.from, to: job.to, ...(job.via ? { via: [job.via] } : {}), groundMPerMm: data.groundMPerMm,
    extra: job.obstacles.map((o) => boxedFeature(BLOCKED, o.kind, [o.coords])),
  }));
}

const port = parentPort;
if (port && (workerData as Partial<AutoRouteWorkerData> | null)?.jobs) {
  try {
    port.postMessage({ type: "done", routes: searchAutoRoutes(workerData as AutoRouteWorkerData) } satisfies AutoRouteWorkerMessage);
  } catch (err: unknown) {
    port.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) } satisfies AutoRouteWorkerMessage);
  }
}
