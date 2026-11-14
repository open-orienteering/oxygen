/**
 * The hit-test over the effective document (docs/map-rendering.md §5.5 "Document objects"; row G5):
 * a `hit` request answers the objects under a paper point, topmost first, by the symbolised shape,
 * from both sources of the effective document — the pinned stream less what the patch changes or
 * hides, and the patch's own stream.
 */

import { describe, it, expect } from "vitest";
import { mapDocument } from "@oxygen/shared";
import { createMapGlWorker, type HitReply, type LoadedReply, type LoadRequest, type WorkerReply } from "../worker";
import { ADD1, CELL_UM, documentBytes, index, moveLine1, N, patchOf, T } from "./patch-fixture";

function harness() {
  const sent: WorkerReply[] = [];
  const w = createMapGlWorker((msg) => sent.push(msg), () => undefined, 0);
  return { w, sent };
}

const load = (patch?: mapDocument.MapPatch | null): LoadRequest => ({
  type: "load",
  source: { kind: "document", bytes: documentBytes(), options: { unmatched: "proxy" }, ...(patch !== undefined ? { patch } : {}) },
  fonts: [],
  cellUm: CELL_UM,
});

function loaded(patch?: mapDocument.MapPatch | null) {
  const h = harness();
  h.w.handle(load(patch));
  expect(h.sent[0].type).toBe("loaded");
  return { ...h, summary: (h.sent[0] as LoadedReply).summary };
}

let id = 0;
/** Hits at (x, y) mm. */
function hit(h: ReturnType<typeof harness>, xMm: number, yMm: number, toleranceUm = 0): HitReply["hits"] {
  const before = h.sent.length;
  const mine = ++id;
  h.w.handle({ type: "hit", id: mine, x: xMm * 1000, y: yMm * 1000, toleranceUm });
  const m = h.sent[before];
  if (m.type !== "hit") throw new Error(`expected hit, got ${JSON.stringify(m)}`);
  expect(m.id).toBe(mine);
  return m.hits;
}

let gen = 0;
const patch = (h: ReturnType<typeof harness>, p: mapDocument.MapPatch | null) => {
  h.w.handle({ type: "patch", generation: ++gen, patch: p, detail: [] });
  expect(h.sent[h.sent.length - 1].type).toBe("patched");
};

const refs = (hits: HitReply["hits"]) => hits.map((x) => x.ref);

describe("hit over the document (§5.5 'Document objects')", () => {
  it("answers the object under the point with its index, ref, symbol, type and colour", () => {
    const h = loaded();
    const [line] = hit(h, 5, 5);
    expect(line).toMatchObject({ objectIndex: index(1), ref: { source: 1 }, symbol: { doc: 0 }, type: T.line, colour: 1, distanceUm: 0 });
    expect(hit(h, 25, 5)).toMatchObject([{ objectIndex: index(3), ref: { source: 3 }, symbol: { doc: 1 }, type: T.area, colour: 0 }]);
    expect(hit(h, 35, 5)).toMatchObject([{ ref: { source: 4 }, type: T.point }]);
    // Paper between the objects; the line's reach is half its 300 µm width plus the tolerance.
    expect(hit(h, 7, 5)).toEqual([]);
    expect(hit(h, 5.2, 5)).toEqual([]);
    expect(refs(hit(h, 5.2, 5, 60))).toEqual([{ source: 1 }]);
  });

  it("an object of a hidden symbol is not drawn and not hit", () => {
    const h = loaded();
    // Source 0 runs along y = 2 mm from x = 1 to 9 mm, crossing line 1 at x = 5.
    expect(hit(h, 3, 2)).toEqual([]);
  });

  it("orders hits topmost first across the pinned stream and the patch's", () => {
    // An added black line across the yellow area of cell 2: black (colour 1) over yellow (colour 0).
    const h = loaded(patchOf([{ op: "add", id: ADD1, type: T.line, symbol: { doc: 0 }, coords: [[2200, 500], [2800, 500]] }]));
    const hits = hit(h, 25, 5);
    expect(refs(hits)).toEqual([{ added: ADD1 }, { source: 3 }]);
    expect(hits[0]).toMatchObject({ objectIndex: N, type: T.line, symbol: { doc: 0 } });
  });

  it("a hidden object is never hit; a moved one only where the patch draws it", () => {
    const h = loaded();
    patch(h, patchOf([{ op: "hide", sourceIndex: 3 }, moveLine1(7)]));
    expect(hit(h, 25, 5)).toEqual([]);
    expect(hit(h, 5, 5)).toEqual([]);
    expect(hit(h, 7, 5)).toMatchObject([{ objectIndex: index(1), ref: { source: 1 } }]);
    // The toggle off: the pinned document again.
    patch(h, null);
    expect(refs(hit(h, 5, 5))).toEqual([{ source: 1 }]);
    expect(refs(hit(h, 25, 5))).toEqual([{ source: 3 }]);
  });

  it("finds an object centred in a neighbour cell and one in the large bucket", () => {
    const h = loaded(patchOf([
      // Centred at x = 13.5 mm (cell 1), reaching back to x = 8 mm in cell 0.
      { op: "add", id: ADD1, type: T.line, symbol: { doc: 0 }, coords: [[800, 300], [1900, 300]] },
      // Centred outside the load's grid (y = 50 mm): the large bucket.
      { op: "add", id: "00000000-0000-7000-8000-000000000003", type: T.line, symbol: { doc: 0 }, coords: [[1000, 5000], [2000, 5000]] },
    ]));
    expect(refs(hit(h, 8.5, 3))).toEqual([{ added: ADD1 }]);
    expect(refs(hit(h, 15, 50))).toEqual([{ added: "00000000-0000-7000-8000-000000000003" }]);
  });

  it("a request before the load answers error with its id", () => {
    const h = harness();
    h.w.handle({ type: "hit", id: 41, x: 0, y: 0, toleranceUm: 0 });
    expect(h.sent[0]).toMatchObject({ type: "error", hit: 41 });
  });
});
