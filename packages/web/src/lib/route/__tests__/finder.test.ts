/** The route search behind a worker (docs/course-elevation.md §7.8). */

import { describe, it, expect } from "vitest";
import { mapDocument, symbolLibrary } from "@oxygen/shared";
import { S, SYMBOLS } from "@oxygen/shared/src/terrain/graph/__tests__/synthetic.js";
import { createRouteFinder, createRouteWorkerState, type RouteWorkerLike, type RouteWorkerRequest, type RouteWorkerResponse } from "../finder";

const rect = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
/** A document with one uncrossable lake. */
const bytes = () => {
  const coords = rect(20, 10, 26, 30);
  return mapDocument.encodeMapDocument({
    header: {
      format: { version: 1, importer: "route-test" },
      source: { kind: "ocad", version: "2018", hash: "00".repeat(32), bytes: 1 },
      unitsPerMm: 100,
      mapScale: 15000,
      library: { id: "ISOM2017-2", version: symbolLibrary.SYMBOL_LIBRARY_VERSION },
      georeferencing: { crs: null, paperOrigin: { x: 0, y: 0 }, gridRotationDeg: 0 },
      colours: symbolLibrary.materialiseLibrary("ISOM2017-2").colours,
      symbols: SYMBOLS,
    },
    objects: [{ symbolIdx: S.water, type: mapDocument.OBJECT_TYPE.area, sourceIndex: 0, coords: coords.map((v) => v * 100), flags: new Array<number>(coords.length / 2).fill(0) }],
  });
};
const req = { from: { x: 10, y: 20 }, to: { x: 36, y: 20 }, groundMPerMm: 15 };

/** A worker that answers on the same thread, counting what it was sent. */
function fakeWorker(log: RouteWorkerRequest["type"][]): RouteWorkerLike {
  const handle = createRouteWorkerState();
  const w: RouteWorkerLike = {
    onmessage: null, onerror: null,
    postMessage(msg) {
      log.push(msg.type);
      const res = handle(msg);
      if (res) queueMicrotask(() => w.onmessage?.({ data: res } as MessageEvent<RouteWorkerResponse>));
    },
    terminate() { log.push("find" as never); },
  };
  return w;
}

describe("the route worker's state (docs/course-elevation.md §7.8)", () => {
  it("a search needs its document; with it the lake is run round", () => {
    const handle = createRouteWorkerState();
    expect(handle({ type: "find", id: 1, docKey: "d", fieldKey: null, req })).toMatchObject({ id: 1, ok: false });
    expect(handle({ type: "doc", key: "d", bytes: bytes(), patch: null })).toBeNull();
    const res = handle({ type: "find", id: 2, docKey: "d", fieldKey: null, req });
    expect(res).toMatchObject({ id: 2, ok: true });
    if (res?.ok) for (const r of res.result.routes) expect(r.lengthM).toBeGreaterThan(26 * 15);
    expect(handle({ type: "find", id: 3, docKey: "other", fieldKey: null, req })).toMatchObject({ ok: false });
    expect(handle({ type: "find", id: 4, docKey: "d", fieldKey: "f", req })).toMatchObject({ ok: false });
  });
});

describe("the finder (docs/course-elevation.md §7.8)", () => {
  it("sends the document once, and again when it changes", async () => {
    const log: RouteWorkerRequest["type"][] = [];
    const finder = createRouteFinder(() => fakeWorker(log));
    const doc = { key: "d:0", bytes: bytes(), patch: null };
    const first = await finder.find({ doc, field: null, req });
    expect(first.routes.length).toBeGreaterThanOrEqual(1);
    await finder.find({ doc, field: null, req });
    expect(log).toEqual(["doc", "find", "find"]);
    await finder.find({ doc: { ...doc, key: "d:1" }, field: null, req });
    expect(log).toEqual(["doc", "find", "find", "doc", "find"]);
  });

  it("dispose rejects a search in flight", async () => {
    const finder = createRouteFinder(() => ({ onmessage: null, onerror: null, postMessage() {}, terminate() {} }));
    const p = finder.find({ doc: { key: "d", bytes: bytes(), patch: null }, field: null, req });
    finder.dispose();
    await expect(p).rejects.toThrow(/cancelled/);
  });
});
