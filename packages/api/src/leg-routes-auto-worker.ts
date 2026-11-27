/**
 * Worker-thread body for the automatic leg routes
 * (docs/course-elevation.md §7.5): decode the document, apply the
 * event's patch and classify its objects **once**, then answer one job
 * at a time with the shortest legal route. The host owns the rows; this
 * thread only computes.
 *
 *   workerData = { bytes, patch, groundMPerMm }
 *   → { type: "ready" }                      the document is prepared
 *   → { type: "error", message }             it could not be (the worker is of no use)
 *   ← { type: "search", id, job }
 *   → { type: "route", id, points }          interior vertices, or null without a way
 *   → { type: "failed", id, message }        this job only
 */

import { parentPort, workerData } from "node:worker_threads";
import { mapDocument } from "@oxygen/shared";
import { BLOCKED, boxedFeature, routeFeaturesOfDocument, shortestLegRoute, type RoutePoint } from "@oxygen/shared/src/route/index.js";
import type { AutoRouteInit, AutoRouteJob, AutoRouteResult, AutoRouteWorkerData, AutoRouteWorkerMessage, AutoRouteWorkerRequest } from "./leg-routes-auto.js";

/** The document prepared once: a function from a job to its route. */
export function prepareAutoRouteSearch(init: AutoRouteInit): (job: AutoRouteJob) => RoutePoint[] | null {
  const decoded = mapDocument.decodeMapDocument(init.bytes);
  const features = routeFeaturesOfDocument(mapDocument.applyPatch(decoded, init.patch ?? undefined).document);
  return (job) => shortestLegRoute(features, {
    from: job.from, to: job.to, ...(job.via ? { via: [job.via] } : {}), groundMPerMm: init.groundMPerMm,
    extra: job.obstacles.map((o) => boxedFeature(BLOCKED, o.kind, [o.coords])),
  });
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The searches themselves, apart from the thread plumbing (also the unit tests' oracle): one result per job, a job that throws failing alone. */
export function searchAutoRoutes(data: AutoRouteWorkerData): AutoRouteResult[] {
  const search = prepareAutoRouteSearch(data);
  return data.jobs.map((job): AutoRouteResult => {
    try {
      return { ok: true, points: search(job) };
    } catch (err) {
      return { ok: false, error: messageOf(err) };
    }
  });
}

const port = parentPort;
const init = workerData as Partial<AutoRouteInit> | null;
if (port && init?.bytes && !("jobs" in init)) {
  try {
    const search = prepareAutoRouteSearch(init as AutoRouteInit);
    port.on("message", (m: AutoRouteWorkerRequest) => {
      if (m.type !== "search") return;
      try {
        port.postMessage({ type: "route", id: m.id, points: search(m.job) } satisfies AutoRouteWorkerMessage);
      } catch (err: unknown) {
        port.postMessage({ type: "failed", id: m.id, message: messageOf(err) } satisfies AutoRouteWorkerMessage);
      }
    });
    port.postMessage({ type: "ready" } satisfies AutoRouteWorkerMessage);
  } catch (err: unknown) {
    port.postMessage({ type: "error", message: messageOf(err) } satisfies AutoRouteWorkerMessage);
  }
}
