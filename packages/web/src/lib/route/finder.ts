/**
 * The route search behind a worker (docs/course-elevation.md §7.8): the
 * search takes up to a few seconds on a long leg, so it runs off the
 * main thread. The worker keeps the document's classified features and
 * the height field between searches; `createRouteFinder` sends each
 * once and again when it changes.
 */

import { mapDocument } from "@oxygen/shared";
import type { HeightField } from "@oxygen/shared/src/terrain/field/types.js";
import { fieldSampler } from "@oxygen/shared/src/terrain/profile/index.js";
import { DEFAULT_COST_MODEL, findLegRoutes, routeFeaturesOfDocument, type BoxedRouteFeature, type LegRouteRequest, type LegRouteResult, type RoutePoint } from "@oxygen/shared/src/route/index.js";

export type RouteWorkerRequest =
  /** The map document (and the event's patch on it) under `key`. */
  | { type: "doc"; key: string; bytes: ArrayBuffer | Uint8Array; patch: mapDocument.MapPatch | null }
  /** The height field under `key`. */
  | { type: "field"; key: string; field: HeightField }
  | { type: "find"; id: number; docKey: string; fieldKey: string | null; req: LegRouteRequest };

export type RouteWorkerResponse = { id: number; ok: true; result: LegRouteResult } | { id: number; ok: false; error: string };

/** The worker's side: one document and one field held, a search answered. */
export function createRouteWorkerState(): (msg: RouteWorkerRequest) => RouteWorkerResponse | null {
  let doc: { key: string; features: BoxedRouteFeature[] } | null = null;
  let field: { key: string; heightAt: (p: RoutePoint) => number | null } | null = null;
  return (msg) => {
    if (msg.type === "doc") {
      const decoded = mapDocument.decodeMapDocument(msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes));
      doc = { key: msg.key, features: routeFeaturesOfDocument(mapDocument.applyPatch(decoded, msg.patch ?? undefined).document) };
      return null;
    }
    if (msg.type === "field") {
      field = { key: msg.key, heightAt: fieldSampler(msg.field).heightAt };
      return null;
    }
    try {
      if (!doc || doc.key !== msg.docKey) throw new Error("The map is not loaded in the route search");
      if (msg.fieldKey !== null && field?.key !== msg.fieldKey) throw new Error("The heights are not loaded in the route search");
      return { id: msg.id, ok: true, result: findLegRoutes(doc.features, msg.fieldKey !== null ? field!.heightAt : null, msg.req, DEFAULT_COST_MODEL) };
    } catch (err) {
      return { id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

export interface RouteWorkerLike {
  postMessage(msg: RouteWorkerRequest): void;
  onmessage: ((e: MessageEvent<RouteWorkerResponse>) => void) | null;
  onerror: ((e: ErrorEvent | Event) => void) | null;
  terminate(): void;
}

export interface RouteSearchInput {
  doc: { key: string; bytes: ArrayBuffer | Uint8Array; patch: mapDocument.MapPatch | null };
  /** The height field, or null to search without slopes. */
  field: { key: string; field: HeightField } | null;
  req: LegRouteRequest;
}

export interface RouteFinder {
  find(input: RouteSearchInput): Promise<LegRouteResult>;
  /** Terminates the worker; a search in flight rejects. */
  dispose(): void;
}

export const createRouteWorker = (): RouteWorkerLike =>
  new Worker(new URL("./route-worker-entry.ts", import.meta.url), { type: "module" }) as unknown as RouteWorkerLike;

export function createRouteFinder(createWorker: () => RouteWorkerLike = createRouteWorker): RouteFinder {
  let worker: RouteWorkerLike | null = null;
  let sentDoc: string | null = null;
  let sentField: string | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: LegRouteResult) => void; reject: (e: Error) => void }>();
  const failAll = (e: Error) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  const drop = () => {
    worker?.terminate();
    worker = null;
    sentDoc = null;
    sentField = null;
  };
  const get = (): RouteWorkerLike => {
    if (worker) return worker;
    const w = createWorker();
    w.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
    w.onerror = () => {
      failAll(new Error("The route search failed"));
      if (worker === w) drop();
    };
    return (worker = w);
  };
  return {
    find({ doc, field, req }) {
      const w = get();
      // A message that cannot be cloned throws here, not in the worker: the search fails like any other.
      try {
      if (sentDoc !== doc.key) {
        w.postMessage({ type: "doc", key: doc.key, bytes: doc.bytes, patch: doc.patch });
        sentDoc = doc.key;
      }
      if (field && sentField !== field.key) {
        w.postMessage({ type: "field", key: field.key, field: field.field });
        sentField = field.key;
      }
      } catch (err) {
        drop();
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          w.postMessage({ type: "find", id, docKey: doc.key, fieldKey: field?.key ?? null, req });
        } catch (err) {
          pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    dispose() {
      failAll(new Error("The route search was cancelled"));
      drop();
    },
  };
}
