/**
 * The effective document on screen (docs/map-rendering.md §5.2 "Object identity", "Patch"; row G4):
 * range-table ids are the document's `objectIndex`, a patch hides through the range table and
 * re-prepares only the buckets whose content it changes.
 */

import { describe, it, expect } from "vitest";
import { mapDocument } from "@oxygen/shared";
import {
  COURSE_OBJECT_BASE, createMapGlWorker,
  type CourseReply, type LoadedReply, type LoadRequest, type PatchedReply, type PartReply, type WorkerReply,
} from "../worker";
import type { PreparedPart } from "../buckets";
import { documentBytes as courseDocumentBytes, fontBytes, latin, request } from "./course-fixture";

const T = mapDocument.OBJECT_TYPE;
const HASH = "ab".repeat(32);
const CELL_UM = 10_000;
const YELLOW = 0, BLACK = 1;

const lineSym = (code: string, widthUm = 300, hidden = false) => ({
  code, name: code, kind: "line" as const, hidden,
  render: { type: "line" as const, id: code, code, name: code, main: { colour: BLACK, widthUm } },
});
const discSym = (code: string, diameterUm: number) => ({
  code, name: code, kind: "point" as const,
  render: { type: "point" as const, id: code, code, name: code, glyph: { parts: [{ kind: "disc" as const, colour: BLACK, diameterUm }], rotatable: false }, orientation: "north" as const },
});

/**
 * 100 units per mm, 10 mm cells along y ∈ [0, 10] mm: source 0 a line of a hidden symbol, 1 a black
 * line in cell 0, 2 one in cell 1, 3 a yellow area in cell 2, 4 a boulder in cell 3, 5 an area in cell 4.
 */
function documentBytes(): ArrayBuffer {
  const u8 = mapDocument.encodeMapDocument({
    header: {
      format: { version: 1, importer: "test-1" },
      source: { kind: "ocad", version: "2018.8.3", hash: "00".repeat(32), bytes: 1 },
      unitsPerMm: 100,
      mapScale: 15000,
      georeferencing: { crs: null, paperOrigin: null },
      colours: [{ id: "src:0", name: "Yellow", cmyk: [0, 0.27, 0.79, 0] }, { id: "src:1", name: "Black", cmyk: [0, 0, 0, 1] }],
      symbols: [
        lineSym("506.0"),
        { code: "403.0", name: "Rough open land", kind: "area", render: { type: "area", id: "403", code: "403", name: "Rough open land", fill: YELLOW } },
        discSym("204.0", 520),
        lineSym("999.0", 300, true),
      ],
    },
    objects: [
      { symbolIdx: 3, type: T.line, sourceIndex: 0, coords: [100, 200, 900, 200], flags: [0, 0] },
      { symbolIdx: 0, type: T.line, sourceIndex: 1, coords: [500, 100, 500, 900], flags: [0, 0] },
      { symbolIdx: 0, type: T.line, sourceIndex: 2, coords: [1500, 100, 1500, 900], flags: [0, 0] },
      { symbolIdx: 1, type: T.area, sourceIndex: 3, coords: [2100, 100, 2900, 100, 2900, 900, 2100, 900], flags: [0, 0, 0, 0] },
      { symbolIdx: 2, type: T.point, sourceIndex: 4, coords: [3500, 500], flags: [0] },
      { symbolIdx: 1, type: T.area, sourceIndex: 5, coords: [4100, 100, 4900, 100, 4900, 900, 4100, 900], flags: [0, 0, 0, 0] },
    ],
  });
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/** `objectIndex` of each source object (the encoder orders objects its own way). */
const index = (() => {
  const doc = mapDocument.decodeMapDocument(new Uint8Array(documentBytes()));
  const out = new Map<number, number>();
  doc.attrs.sourceIndex.forEach((s, i) => out.set(s, i));
  return (source: number) => out.get(source)!;
})();
const N = 6;
/** Cell id of column `c` (one row). */
const cell = (c: number) => c;
const LARGE = 5;

const patchOf = (ops: mapDocument.PatchOp[], symbols: Record<string, mapDocument.PatchSymbol> = {}, enabled = true): mapDocument.MapPatch => ({
  documentHash: HASH, enabled, symbols, ops: Object.fromEntries(ops.map((o) => [mapDocument.patchOpId(o), o])),
});
const ADD1 = "00000000-0000-7000-8000-000000000001";
const ADD2 = "00000000-0000-7000-8000-000000000002";
const moveLine1 = (xMm: number): mapDocument.PatchOp => ({ op: "modify", sourceIndex: 1, coords: [[xMm * 100, 100], [xMm * 100, 900]] });

function harness() {
  const sent: { msg: WorkerReply; transfer: ArrayBuffer[] }[] = [];
  const tasks: (() => void)[] = [];
  const w = createMapGlWorker((msg, transfer) => sent.push({ msg, transfer }), (fn) => tasks.push(fn), 0);
  const drain = () => { while (tasks.length) tasks.shift()!(); };
  return { w, sent, drain };
}

const load = (patch?: mapDocument.MapPatch | null, over: Partial<LoadRequest> = {}): LoadRequest => ({
  type: "load",
  source: { kind: "document", bytes: documentBytes(), options: { unmatched: "proxy" }, ...(patch !== undefined ? { patch } : {}) },
  fonts: [],
  cellUm: CELL_UM,
  ...over,
});

function loaded(patch?: mapDocument.MapPatch | null) {
  const h = harness();
  h.w.handle(load(patch));
  return { ...h, reply: h.sent[0].msg as LoadedReply };
}

let generation = 0;
function patch(h: ReturnType<typeof harness>, p: mapDocument.MapPatch | null, detail: number[] = [0, 1, 2, 3, 4]): PatchedReply {
  const before = h.sent.length;
  h.w.handle({ type: "patch", generation: ++generation, patch: p, detail });
  const m = h.sent[before].msg;
  if (m.type !== "patched") throw new Error(`expected patched, got ${JSON.stringify(m)}`);
  expect(m.generation).toBe(generation);
  return m;
}

/** Range-table object ids of a part. */
function ids(p: PreparedPart | null | undefined): number[] {
  const s = new Set<number>();
  for (const k of [p?.fill, p?.hatch, p?.stroke, p?.glyph, p?.text]) for (const o of k?.ranges.object ?? []) s.add(o);
  for (const c of p?.clips ?? []) s.add(c.object);
  return [...s].sort((a, b) => a - b);
}

/** The detail part of a cell, prepared now. */
function detailOf(h: ReturnType<typeof harness>, id: number): PreparedPart | undefined {
  const before = h.sent.length;
  h.w.handle({ type: "prepare", ids: [id] });
  h.drain();
  return (h.sent.slice(before).find((s) => s.msg.type === "part") as { msg: PartReply } | undefined)?.msg.part;
}

/** The stroke's first vertex x, paper µm. */
const firstStrokeX = (p: PreparedPart | undefined, originX: number) => new Float32Array(p!.stroke!.verts)[0] + originX;
const strip = (p: PreparedPart) => ({ ...p, ms: 0 });

describe("object identity across the bridge (§5.2)", () => {
  it("range-table ids are the document's objectIndex, though the bridge drops an object of a hidden symbol", () => {
    const { reply, ...h } = loaded();
    expect(reply.summary.grid).toMatchObject({ minCol: 0, cols: 5, rows: 1 });
    expect(reply.summary.largeId).toBe(LARGE);
    expect(ids(reply.base.find((p) => p.bucket === cell(2)))).toEqual([index(3)]);
    expect(ids(reply.base.find((p) => p.bucket === cell(4)))).toEqual([index(5)]);
    expect(ids(detailOf(h, cell(0)))).toEqual([index(1)]);
    expect(ids(detailOf(h, cell(3)))).toEqual([index(4)]);
    // Nothing of the hidden symbol's object.
    expect(reply.summary.objects.drawn).toBe(5);
  });

  it("a load without a patch, with null and with a disabled patch report the identity state and the same parts", () => {
    const plain = loaded(undefined).reply;
    expect(plain.summary.patch).toEqual({ hidden: new Uint32Array(0), changed: 0, added: 0, issues: [] });
    for (const p of [null, patchOf([{ op: "hide", sourceIndex: 3 }], {}, false), patchOf([])]) {
      const r = loaded(p).reply;
      expect(r.base.map(strip)).toEqual(plain.base.map(strip));
      expect(r.summary.detailCells).toEqual(plain.summary.detailCells);
      expect(r.summary.patch!.hidden.length).toBe(0);
    }
  });
});

describe("a patch change (§5.2 \"Patch\")", () => {
  it("hide is ids only: nothing touched, no part", () => {
    const h = loaded();
    const r = patch(h, patchOf([{ op: "hide", sourceIndex: 2 }]));
    expect(Array.from(r.patch.hidden)).toEqual([index(2)]);
    expect(r.touched).toEqual([]);
    expect(r.base).toEqual([]);
    expect(r.detail).toEqual([]);
    expect(r.large).toBeUndefined();
  });

  it("modify within a cell re-prepares that cell only, the object under its own id at its new place", () => {
    const h = loaded();
    const ox = h.reply.summary.originX;
    expect(firstStrokeX(detailOf(h, cell(0)), ox)).toBeCloseTo(5000, 0);
    const r = patch(h, patchOf([moveLine1(7)]));
    expect(r.touched).toEqual([cell(0)]);
    expect(r.patch).toMatchObject({ changed: 1, added: 0, issues: [] });
    expect(r.base).toEqual([]); // a line has no base layer
    expect(r.detail.map((p) => p.bucket)).toEqual([cell(0)]);
    expect(ids(r.detail[0])).toEqual([index(1)]);
    expect(firstStrokeX(r.detail[0], ox)).toBeCloseTo(7000, 0);
    // The queue prepares the new content too.
    expect(firstStrokeX(detailOf(h, cell(0)), ox)).toBeCloseTo(7000, 0);
  });

  it("a move across cells touches both: the old cell loses its detail layer, the new one has both lines", () => {
    const h = loaded();
    const r = patch(h, patchOf([moveLine1(15.5)]));
    expect(r.touched).toEqual([cell(0), cell(1)]);
    expect(r.detailCells).not.toContain(cell(0));
    expect(r.detailCells).toContain(cell(1));
    expect(r.detail.map((p) => p.bucket)).toEqual([cell(1)]);
    expect(ids(r.detail[0])).toEqual([index(1), index(2)].sort((a, b) => a - b));
    expect(detailOf(h, cell(0))).toBeUndefined();
  });

  it("an added object is drawn under id N in the cell of its centre", () => {
    const h = loaded();
    const r = patch(h, patchOf([{ op: "add", id: ADD1, type: T.line, symbol: { doc: 0 }, coords: [[3200, 200], [3800, 200]] }]));
    expect(r.patch).toMatchObject({ changed: 0, added: 1 });
    expect(r.touched).toEqual([cell(3)]);
    expect(ids(r.detail[0])).toEqual([index(4), N].sort((a, b) => a - b));
  });

  it("an added object outside the load's grid, or larger than two cells, goes to the large bucket", () => {
    const h = loaded();
    expect(h.reply.large).toBeUndefined();
    const r = patch(h, patchOf([{ op: "add", id: ADD1, type: T.line, symbol: { doc: 0 }, coords: [[500, 5000], [900, 5000]] }]));
    expect(r.touched).toEqual([LARGE]);
    expect(r.large).toBeDefined();
    expect(ids(r.large)).toEqual([N]);
    expect(r.bytes.large).toBe(r.large!.gpuBytes);
    // Removing it empties the large bucket again.
    const back = patch(h, null);
    expect(back.touched).toEqual([LARGE]);
    expect(back.large).toBeNull();
  });

  it("resymbol to a patch symbol with a new glyph grows the atlas; earlier meshes keep their place", () => {
    const h = loaded();
    const meshes = h.reply.atlas.meshes;
    const big = discSym("ISOM2017-2:205", 1200);
    const r = patch(h, patchOf([{ op: "resymbol", sourceIndex: 4, symbol: { patch: "ISOM2017-2:205" } }], { "ISOM2017-2:205": { ...big, origin: "source", hidden: false } }));
    expect(r.touched).toEqual([cell(3)]);
    expect(r.atlas).toBeDefined();
    expect(r.atlas!.meshes.length).toBe(meshes.length + 1);
    expect(r.atlas!.meshes.slice(0, meshes.length)).toEqual(meshes);
    const radius = r.atlas!.meshes[meshes.length].radius;
    const inst = r.detail[0].glyph!.instances;
    expect(inst[7]).toBe(radius); // the instance's mesh radius: the new glyph's
    expect(ids(r.detail[0])).toEqual([index(4)]);
  });

  it("hide and modify on one object: hidden wins and nothing is re-prepared", () => {
    const h = loaded();
    const r = patch(h, patchOf([{ op: "hide", sourceIndex: 1 }, moveLine1(7)]));
    expect(Array.from(r.patch.hidden)).toEqual([index(1)]);
    expect(r.patch.changed).toBe(0);
    expect(r.touched).toEqual([]);
  });

  it("a second change elsewhere touches only its own cell; the toggle off restores the unpatched parts", () => {
    const h = loaded();
    const plain = h.reply;
    const plainArea = plain.base.find((p) => p.bucket === cell(2))!;
    const plainDetail0 = detailOf(h, cell(0))!;
    const area: mapDocument.PatchOp = { op: "modify", sourceIndex: 3, coords: [[2200, 200], [2800, 200], [2800, 800], [2200, 800]] };
    expect(patch(h, patchOf([moveLine1(7)])).touched).toEqual([cell(0)]);
    const second = patch(h, patchOf([moveLine1(7), area]));
    expect(second.touched).toEqual([cell(2)]);
    expect(second.base.map((p) => p.bucket)).toEqual([cell(2)]);
    expect(second.base[0].fill!.vertexCount).toBeGreaterThan(0);
    // Off: both cells back, deep-equal to the unpatched parts.
    const off = patch(h, patchOf([moveLine1(7), area], {}, false));
    expect(off.touched).toEqual([cell(0), cell(2)]);
    expect(Array.from(off.patch.hidden)).toEqual([]);
    expect(strip(off.base.find((p) => p.bucket === cell(2))!)).toEqual(strip(plainArea));
    expect(strip(off.detail.find((p) => p.bucket === cell(0))!)).toEqual(strip(plainDetail0));
    expect(off.bytes.base).toBe(plain.summary.bytes.base);
  });

  it("detail comes back only for the cells the engine holds", () => {
    const h = loaded();
    const r = patch(h, patchOf([moveLine1(7)]), []);
    expect(r.touched).toEqual([cell(0)]);
    expect(r.detail).toEqual([]);
    expect(r.detailCells).toContain(cell(0));
  });

  it("issues are reported, never thrown; the other ops apply", () => {
    const h = loaded();
    const r = patch(h, patchOf([{ op: "hide", sourceIndex: 99 }, { op: "resymbol", sourceIndex: 1, symbol: { doc: 1 } }, { op: "hide", sourceIndex: 2 }]));
    expect(r.patch.issues).toEqual([{ opId: "hide:99", code: "target-missing" }, { opId: "resymbol:1", code: "kind-mismatch" }]);
    expect(Array.from(r.patch.hidden)).toEqual([index(2)]);
  });

  it("every buffer is transferable; a patch with the load draws it from the first frame", () => {
    const h = loaded();
    h.w.handle({ type: "patch", generation: 1, patch: patchOf([moveLine1(15.5), { op: "hide", sourceIndex: 3 }]), detail: [1] });
    const { msg, transfer } = h.sent[h.sent.length - 1];
    const r = msg as PatchedReply;
    expect(transfer).toContain(r.patch.hidden.buffer);
    for (const p of r.detail) expect(transfer).toContain(p.stroke!.indices.buffer);
    expect(new Set(transfer).size).toBe(transfer.length);

    const withPatch = loaded(patchOf([moveLine1(15.5), { op: "hide", sourceIndex: 3 }])).reply;
    expect(Array.from(withPatch.summary.patch!.hidden)).toEqual([index(3)]);
    expect(withPatch.summary.detailCells).not.toContain(cell(0));
    expect(withPatch.summary.queued).toEqual([]);
  });

  it("a request before any load answers error with its generation", () => {
    const h = harness();
    h.w.handle({ type: "patch", generation: 41, patch: null, detail: [] });
    expect(h.sent[0].msg).toMatchObject({ type: "error", patch: 41 });
  });
});

describe("the course layer reads the effective document (§5.2 \"Patch\")", () => {
  const courseLoad = (patch?: mapDocument.MapPatch | null): LoadRequest => ({
    type: "load",
    source: { kind: "document", bytes: courseDocumentBytes(undefined, { boulder: { x: 40, y: 12 } }), options: { unmatched: "proxy" }, ...(patch !== undefined ? { patch } : {}) },
    fonts: [{ family: "liberation-sans", bytes: fontBytes("LiberationSans-Regular.ttf") }],
    textAtlas: [latin()],
    courseLayer: true,
  });
  const courseIndex = (() => {
    const doc = mapDocument.decodeMapDocument(new Uint8Array(courseDocumentBytes(undefined, { boulder: { x: 40, y: 12 } })));
    return (source: number) => Array.from(doc.attrs.sourceIndex).indexOf(source);
  })();
  const ask = (h: ReturnType<typeof harness>, req = request()) => {
    const before = h.sent.length;
    h.w.handle({ type: "course", generation: 1, input: req });
    return h.sent[before].msg as CourseReply;
  };

  it("cut features skip a hidden boulder", () => {
    const h = harness();
    h.w.handle(courseLoad());
    expect((h.sent[0].msg as LoadedReply).summary.courseLayer).toEqual({ supported: true, cutFeatures: 1 });
    const r = patch(h, patchOf([{ op: "hide", sourceIndex: 2 }]), []);
    expect(r.patch.cutFeatures).toBe(0);
    expect(patch(h, null, []).patch.cutFeatures).toBe(1);
  });

  it("course ids start at COURSE_OBJECT_BASE; filter regions act where a moved object is now, and on an added one", () => {
    const h = harness();
    h.w.handle(courseLoad());
    const course = ask(h);
    expect(Math.min(...ids(course.part))).toBeGreaterThanOrEqual(COURSE_OBJECT_BASE);
    // The black line (source 0) runs x = 25 mm, y 0..20 mm: move it to x = 70 mm and add one at x = 90 mm.
    patch(h, patchOf([
      { op: "modify", sourceIndex: 0, coords: [[7000, 0], [7000, 2000]] },
      { op: "add", id: ADD2, type: T.line, symbol: { doc: 0 }, coords: [[9000, 0], [9000, 2000]] },
    ]), []);
    const region = (x0: number, x1: number) => ({ rings: [[{ x: x0, y: 5 }, { x: x1, y: 5 }, { x: x1, y: 15 }, { x: x0, y: 15 }]], mode: "hide" as const, symbols: "all" as const });
    const at = (x0: number, x1: number) => Array.from(ask(h, request({ regions: [region(x0, x1)] })).filter!.hidden).sort((a, b) => a - b);
    expect(at(22, 28)).toEqual([]);
    expect(at(67, 73)).toEqual([courseIndex(0)]);
    expect(at(87, 93)).toEqual([3]); // the added object: N = 3 (two lines and the boulder)
  });
});
