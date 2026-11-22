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
import { currentCostModel, findLegRoutes, legPolylineCost, routeFeaturesOfDocument, type BoxedRouteFeature, type LegRouteRequest, type CostModel, type LegRouteResult, type RoutePoint } from "@oxygen/shared/src/route/index.js";

export type RouteWorkerRequest =
  /** The map document (and the event's patch on it) under `key`. */
  | { type: "doc"; key: string; bytes: ArrayBuffer | Uint8Array; patch: mapDocument.MapPatch | null }
  /** The height field under `key`. */
  | { type: "field"; key: string; field: HeightField }
  | { type: "find"; id: number; docKey: string; fieldKey: string | null; req: LegRouteRequest }
  /** What each leg costs along its polyline (§7.8 "Pace"). */
  | { type: "costs"; id: number; docKey: string; fieldKey: string | null; req: LegCostsRequest };

/** The course's legs along the polylines they are read along. */
export interface LegCostsRequest {
  legs: { points: RoutePoint[] }[];
  groundMPerMm: number;
  extra?: readonly BoxedRouteFeature[];
}

export type RouteWorkerResponse =
  | { id: number; ok: true; result: LegRouteResult }
  | { id: number; ok: true; costs: number[] }
  | { id: number; ok: false; error: string };

/** The worker's side: one document and one field held, a search answered. */
export function createRouteWorkerState(): (msg: RouteWorkerRequest) => RouteWorkerResponse | null {
  let doc: { key: string; features: BoxedRouteFeature[]; model: CostModel } | null = null;
  let field: { key: string; heightAt: (p: RoutePoint) => number | null } | null = null;
  return (msg) => {
    if (msg.type === "doc") {
      const decoded = mapDocument.decodeMapDocument(msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes));
      // The model of the map's family (§7.9): sprint and forest maps are run differently.
      doc = { key: msg.key, features: routeFeaturesOfDocument(mapDocument.applyPatch(decoded, msg.patch ?? undefined).document), model: currentCostModel(decoded.header) };
      return null;
    }
    if (msg.type === "field") {
      field = { key: msg.key, heightAt: fieldSampler(msg.field).heightAt };
      return null;
    }
    try {
      if (!doc || doc.key !== msg.docKey) throw new Error("The map is not loaded in the route search");
      if (msg.fieldKey !== null && field?.key !== msg.fieldKey) throw new Error("The heights are not loaded in the route search");
      const heightAt = msg.fieldKey !== null ? field!.heightAt : null;
      if (msg.type === "costs") {
        const { legs, groundMPerMm, extra } = msg.req;
        return { id: msg.id, ok: true, costs: legs.map((leg) => legPolylineCost(doc!.features, heightAt, { points: leg.points, groundMPerMm, extra }, doc!.model)) };
      }
      return { id: msg.id, ok: true, result: findLegRoutes(doc.features, heightAt, msg.req, doc.model) };
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
  /** Each leg's cost along its polyline, in the map's model's flat-forest metres. */
  costs(input: Omit<RouteSearchInput, "req"> & { req: LegCostsRequest }): Promise<number[]>;
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
  const pending = new Map<number, { resolve: (r: RouteWorkerResponse & { ok: true }) => void; reject: (e: Error) => void }>();
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
      if (e.data.ok) p.resolve(e.data);
      else p.reject(new Error(e.data.error));
    };
    w.onerror = () => {
      failAll(new Error("The route search failed"));
      if (worker === w) drop();
    };
    return (worker = w);
  };
  /** Sends what the worker lacks, then the request; a message that cannot be cloned throws here, not in the worker, and fails the search like any other. */
  const ask = (doc: RouteSearchInput["doc"], field: RouteSearchInput["field"], make: (id: number) => RouteWorkerRequest): Promise<RouteWorkerResponse & { ok: true }> => {
    const w = get();
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
        w.postMessage(make(id));
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };
  return {
    async find({ doc, field, req }) {
      const res = await ask(doc, field, (id) => ({ type: "find", id, docKey: doc.key, fieldKey: field?.key ?? null, req }));
      if (!("result" in res)) throw new Error("The route search answered something else");
      return res.result;
    },
    async costs({ doc, field, req }) {
      const res = await ask(doc, field, (id) => ({ type: "costs", id, docKey: doc.key, fieldKey: field?.key ?? null, req }));
      if (!("costs" in res)) throw new Error("The route search answered something else");
      return res.costs;
    },
    dispose() {
      failAll(new Error("The route search was cancelled"));
      drop();
    },
  };
}
