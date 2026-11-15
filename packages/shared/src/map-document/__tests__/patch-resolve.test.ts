/**
 * Re-resolution of a patch when the pin moves (docs/map-patches.md §4; row G11):
 * the same source by `sourceIndex`, another edition by position and symbol
 * within 0.5 mm, nothing found → unresolved; retry; patch symbols; attach.
 */

import { describe, expect, it } from "vitest";
import { input } from "../../import/__tests__/match-fixture.js";
import { matchDocument } from "../../import/match-document.js";
import { decodeMapDocument, encodeMapDocument, type MapDocument, type MapDocumentInput, type MapObjectInput } from "../codec.js";
import { OBJECT_TYPE } from "../header.js";
import { materialiseSymbol } from "../materialise.js";
import { applyPatch, mapPatchSchema, mergePatch, patchOpId, unresolvedKey, type MapPatch, type PatchOp } from "../patch.js";
import { attachUnresolved, resolvePatch, sameSymbol, symbolAnchor, targetAnchor } from "../patch-resolve.js";

const matched = matchDocument(input()).input;
/** The matched fixture's table with source positions: 0 contour 101, 1 road 502, 2 boulder 204, 3 building 527, 4 min. building 521.3 (point), … */
const SYMBOLS = matched.header.symbols.map((s, i) => ({ ...s, sourceIndex: i }));
const CONTOUR = 0, BOULDER = 2, BUILDING = 3, MINBUILDING = 4;

const HASH_A = "a1".repeat(32);
const HASH_A2 = "a2".repeat(32);
const HASH_B = "b1".repeat(32);
const HASH_C = "c1".repeat(32);
const SOURCE_A = "5a".repeat(32);
const SOURCE_B = "5b".repeat(32);

const line = (sourceIndex: number, coords: number[], symbolIdx = CONTOUR): MapObjectInput =>
  ({ symbolIdx, type: OBJECT_TYPE.line, sourceIndex, coords, flags: new Array(coords.length / 2).fill(0) });
const point = (sourceIndex: number, x: number, y: number, symbolIdx = BOULDER): MapObjectInput =>
  ({ symbolIdx, type: OBJECT_TYPE.point, sourceIndex, coords: [x, y], flags: [0] });
const square = (sourceIndex: number, x: number, y: number, side: number): MapObjectInput =>
  ({ symbolIdx: BUILDING, type: OBJECT_TYPE.area, sourceIndex, coords: [x, y, x + side, y, x + side, y + side, x, y + side], flags: [0, 0, 0, 0] });

const make = (source: string, unitsPerMm: number, objects: MapObjectInput[], symbols = SYMBOLS): MapDocument =>
  decodeMapDocument(encodeMapDocument({ header: { ...matched.header, source: { ...matched.header.source, hash: source }, unitsPerMm, symbols }, objects } as MapDocumentInput));

/** Edition A, 100 units/mm: two contours, two boulders, a building. */
const A = make(SOURCE_A, 100, [
  line(100, [0, 0, 1000, 0]),
  line(101, [0, 1000, 1000, 1000]),
  point(102, 500, 500),
  point(103, 2000, 2000),
  square(104, 3000, 3000, 400),
]);

/** A re-import of A's file: objects in another order, 103 dropped, the symbol table reversed (source positions kept). */
const reversed = [...SYMBOLS].reverse();
const at = (i: number) => SYMBOLS.length - 1 - i;
const A2 = make(SOURCE_A, 100, [
  square(104, 3000, 3000, 400),
  { ...point(102, 500, 500), symbolIdx: at(BOULDER) },
  { ...line(101, [0, 1000, 1000, 1000]), symbolIdx: at(CONTOUR) },
  { ...line(100, [0, 0, 1000, 0]), symbolIdx: at(CONTOUR) },
].map((o) => (o.symbolIdx === BUILDING && o.type === OBJECT_TYPE.area ? { ...o, symbolIdx: at(BUILDING) } : o)), reversed);

/**
 * Edition B, a Mapper file (1000 units/mm) of the same map: contour 100 is 0.3 mm north (found), contour 101
 * 0.7 mm (not), boulder 102 has two candidates (the nearer wins), boulder 103's place holds another symbol,
 * the building is the same.
 */
const B = make(SOURCE_B, 1000, [
  line(7, [0, 300, 10000, 300]),
  line(8, [0, 10700, 10000, 10700]),
  point(9, 5200, 5000),
  point(10, 5100, 5100),
  point(11, 20000, 20000, MINBUILDING),
  square(12, 30000, 30000, 4000),
]);

/** Nothing of A: another source, objects far away. */
const C = make(SOURCE_B, 100, [line(1, [50000, 50000, 60000, 50000]), point(2, 70000, 70000)]);

const ADD_ID = "019a7d2e-0000-7000-8000-0000000000aa";
const patchOn = (hash: string, ops: PatchOp[], extra: Partial<MapPatch> = {}): MapPatch =>
  mergePatch(mapPatchSchema.parse({ documentHash: hash, ops: Object.fromEntries(ops.map((op) => [patchOpId(op), op])), ...extra }), {});

const indexOfSource = (doc: MapDocument, s: number): number => Array.from(doc.attrs.sourceIndex).indexOf(s);

describe("resolvePatch: identity", () => {
  it("returns the patch itself when the hash is its own", () => {
    const p = patchOn(HASH_A, [{ op: "hide", sourceIndex: 100 }]);
    expect(resolvePatch(A, A, p, { toHash: HASH_A }).patch).toBe(p);
  });
});

describe("resolvePatch: the same source (a re-import, a re-match)", () => {
  it("keeps every op whose sourceIndex exists, exactly; the symbol re-keyed by its source position", () => {
    const p = patchOn(HASH_A, [
      { op: "hide", sourceIndex: 100 },
      { op: "modify", sourceIndex: 101, coords: [[0, 1100], [1000, 1100, 1]], angle: 30 },
      { op: "resymbol", sourceIndex: 102, symbol: { doc: MINBUILDING } },
      { op: "add", id: ADD_ID, type: OBJECT_TYPE.point, symbol: { doc: BOULDER }, coords: [[10, 20]] },
    ], { enabled: false });
    const r = resolvePatch(A, A2, p, { toHash: HASH_A2 });
    expect(r.patch.documentHash).toBe(HASH_A2);
    expect(r.patch.enabled).toBe(false);
    expect(r.patch.ops).toEqual({
      [`add:${ADD_ID}`]: { op: "add", id: ADD_ID, type: OBJECT_TYPE.point, symbol: { doc: at(BOULDER) }, coords: [[10, 20]] },
      "hide:100": { op: "hide", sourceIndex: 100 },
      "modify:101": { op: "modify", sourceIndex: 101, coords: [[0, 1100], [1000, 1100, 1]], angle: 30 },
      "resymbol:102": { op: "resymbol", sourceIndex: 102, symbol: { doc: at(MINBUILDING) } },
    });
    expect(r.patch.unresolved).toBeUndefined();
    expect(r).toMatchObject({ resolved: 4, unresolved: 0 });
    // The re-keyed patch applies to A2 as the original to A: the same objects hidden and resymbolled.
    const eff = applyPatch(A2, { ...r.patch, enabled: true });
    expect(eff.issues).toEqual([]);
    expect(eff.document.hidden![indexOfSource(A2, 100)]).toBe(1);
    expect(A2.header.symbols[eff.document.attrs.symbolIdx[indexOfSource(A2, 102)]].code).toBe("521.3");
  });

  it("flags an op whose sourceIndex is gone, with the anchors of its old object", () => {
    const p = patchOn(HASH_A, [{ op: "hide", sourceIndex: 103 }]);
    const r = resolvePatch(A, A2, p, { toHash: HASH_A2 });
    expect(r.patch.ops).toEqual({});
    const key = unresolvedKey(HASH_A, { op: "hide", sourceIndex: 103 });
    expect(r.patch.unresolved).toEqual({
      [key]: {
        op: { op: "hide", sourceIndex: 103 }, from: HASH_A, fromSource: SOURCE_A, unitsPerMm: 100, reason: "target",
        target: { type: OBJECT_TYPE.point, symbol: symbolAnchor(A, BOULDER), centreMm: [20, 20], sizeMm: [0, 0] },
      },
    });
    expect(r).toMatchObject({ resolved: 0, unresolved: 1 });
    expect(mapPatchSchema.parse(r.patch)).toEqual(r.patch);
  });
});

describe("resolvePatch: another edition (by position and symbol, 0.5 mm)", () => {
  const p = patchOn(HASH_A, [
    { op: "hide", sourceIndex: 100 },
    { op: "hide", sourceIndex: 101 },
    { op: "modify", sourceIndex: 102, coords: [[600, 500]] },
    { op: "hide", sourceIndex: 103 },
    { op: "resymbol", sourceIndex: 104, symbol: { doc: CONTOUR } },
    { op: "add", id: ADD_ID, type: OBJECT_TYPE.line, symbol: { doc: CONTOUR }, coords: [[1, 2], [3, 4, 2]] },
  ]);
  const r = resolvePatch(A, B, p, { toHash: HASH_B });

  it("re-keys within the tolerance onto the nearest object of the same type and symbol, coordinates rescaled ×10", () => {
    expect(r.patch.ops).toEqual({
      [`add:${ADD_ID}`]: { op: "add", id: ADD_ID, type: OBJECT_TYPE.line, symbol: { doc: CONTOUR }, coords: [[10, 20], [30, 40, 2]] },
      "hide:7": { op: "hide", sourceIndex: 7 },
      "modify:10": { op: "modify", sourceIndex: 10, coords: [[6000, 5000]] },
      "resymbol:12": { op: "resymbol", sourceIndex: 12, symbol: { doc: CONTOUR } },
    });
  });

  it("flags what is outside the tolerance or has another symbol there", () => {
    expect(Object.keys(r.patch.unresolved!)).toEqual([unresolvedKey(HASH_A, { op: "hide", sourceIndex: 101 }), unresolvedKey(HASH_A, { op: "hide", sourceIndex: 103 })]);
    expect(Object.values(r.patch.unresolved!).map((e) => e.reason)).toEqual(["target", "target"]);
    expect(r).toMatchObject({ resolved: 4, unresolved: 2 });
  });

  it("breaks a tie by the lowest sourceIndex, and a second op on one object stays unresolved", () => {
    const tie = make(SOURCE_B, 100, [point(21, 520, 500), point(20, 480, 500)]);
    const two = patchOn(HASH_A, [{ op: "hide", sourceIndex: 102 }, { op: "modify", sourceIndex: 102, coords: [[1, 1]] }, { op: "hide", sourceIndex: 103 }]);
    const t = resolvePatch(A, tie, two, { toHash: HASH_C });
    expect(Object.keys(t.patch.ops)).toEqual(["hide:20", "modify:20"]);
    const crowd = make(SOURCE_B, 100, [point(30, 500, 500)]);
    const both = resolvePatch(make(SOURCE_A, 100, [point(102, 500, 500), point(103, 510, 500)]), crowd, patchOn(HASH_A, [{ op: "hide", sourceIndex: 102 }, { op: "hide", sourceIndex: 103 }]), { toHash: HASH_C });
    expect(Object.keys(both.patch.ops)).toEqual(["hide:30"]);
    expect(Object.values(both.patch.unresolved!).map((e) => [e.op, e.reason])).toEqual([[{ op: "hide", sourceIndex: 103 }, "target"]]);
  });

  it("needs the box's size to agree too, not only its centre", () => {
    const bigger = make(SOURCE_B, 100, [square(40, 2800, 2800, 800)]);
    const s = resolvePatch(A, bigger, patchOn(HASH_A, [{ op: "hide", sourceIndex: 104 }]), { toHash: HASH_C });
    expect(s.patch.ops).toEqual({});
  });
});

describe("resolvePatch: nothing found", () => {
  it("keeps every op unresolved, drawn nowhere, and an add whose symbol is gone with reason symbol", () => {
    const noContour = make(SOURCE_B, 100, [point(1, 0, 0)], SYMBOLS.filter((_, i) => i !== CONTOUR));
    const p = patchOn(HASH_A, [
      { op: "hide", sourceIndex: 100 },
      { op: "add", id: ADD_ID, type: OBJECT_TYPE.line, symbol: { doc: CONTOUR }, coords: [[1, 2], [3, 4]] },
    ]);
    const r = resolvePatch(A, noContour, p, { toHash: HASH_C });
    expect(r.patch.ops).toEqual({});
    expect(Object.values(r.patch.unresolved!).map((e) => [patchOpId(e.op), e.reason])).toEqual([["hide:100", "target"], [`add:${ADD_ID}`, "symbol"]].sort());
    expect(applyPatch(noContour, r.patch).document).toBe(noContour);
    const far = resolvePatch(A, C, patchOn(HASH_A, [{ op: "hide", sourceIndex: 100 }, { op: "hide", sourceIndex: 104 }]), { toHash: HASH_C });
    expect(far).toMatchObject({ resolved: 0, unresolved: 2 });
  });
});

describe("resolvePatch: retry, symbols, determinism", () => {
  it("retries unresolved entries at every re-key: a pin back on the first edition gets the corrections back", () => {
    const p = patchOn(HASH_A, [{ op: "hide", sourceIndex: 100 }, { op: "hide", sourceIndex: 101 }]);
    const onB = resolvePatch(A, B, p, { toHash: HASH_B }).patch;
    expect(Object.keys(onB.ops)).toEqual(["hide:7"]);
    // Still unresolved on C: kept exactly as it was.
    const onC = resolvePatch(B, C, onB, { toHash: HASH_C }).patch;
    expect(onC.unresolved![unresolvedKey(HASH_A, { op: "hide", sourceIndex: 101 })]).toEqual(onB.unresolved![unresolvedKey(HASH_A, { op: "hide", sourceIndex: 101 })]);
    // Back on A: hide:7 by position (another edition), the A entry by sourceIndex (its own source).
    const back = resolvePatch(B, A, onB, { toHash: HASH_A }).patch;
    expect(Object.keys(back.ops)).toEqual(["hide:100", "hide:101"]);
    expect(back.unresolved).toBeUndefined();
  });

  it("materialises patch symbols again for the new document; one it cannot take is dropped and its ops flagged", () => {
    const sym = materialiseSymbol(A, "ISOM2017-2:206");
    if (!sym.ok) throw new Error("fixture");
    const p = patchOn(HASH_A, [{ op: "add", id: ADD_ID, type: OBJECT_TYPE.point, symbol: { patch: sym.key }, coords: [[100, 100]] }], { symbols: { [sym.key]: sym.symbol } });
    const onB = resolvePatch(A, B, p, { toHash: HASH_B }).patch;
    expect(onB.symbols).toEqual({ [sym.key]: (materialiseSymbol(B, sym.key) as { symbol: unknown }).symbol });
    expect(onB.ops[`add:${ADD_ID}`]).toMatchObject({ symbol: { patch: sym.key }, coords: [[1000, 1000]] });
    // A stack without the IOF palette (no aligned colours): not materialisable.
    const bare = make(SOURCE_B, 100, [point(1, 0, 0)]);
    const stripped = { ...bare, header: { ...bare.header, colours: bare.header.colours.map((c) => ({ ...c, paletteIds: undefined })) } } as MapDocument;
    const r = resolvePatch(A, stripped, p, { toHash: HASH_C });
    expect(r.patch.symbols).toEqual({});
    expect(Object.values(r.patch.unresolved!).map((e) => e.reason)).toEqual(["symbol"]);
  });

  it("keeps the live op when it and a pending entry of the same origin fail onto one key", () => {
    const live: PatchOp = { op: "modify", sourceIndex: 103, coords: [[2100, 2000]] };
    const older: PatchOp = { op: "modify", sourceIndex: 103, coords: [[1900, 2000]] };
    const key = unresolvedKey(HASH_A, live);
    const pending = { op: older, from: HASH_A, fromSource: SOURCE_A, unitsPerMm: 100, reason: "target" as const };
    const p = patchOn(HASH_A, [live], { unresolved: { [key]: pending } });
    const r = resolvePatch(A, C, p, { toHash: HASH_C });
    expect(Object.keys(r.patch.unresolved!)).toEqual([key]);
    expect(r.patch.unresolved![key].op).toEqual(live);
  });

  it("is deterministic and leaves its inputs untouched", () => {
    const ops: PatchOp[] = [{ op: "hide", sourceIndex: 104 }, { op: "hide", sourceIndex: 100 }, { op: "hide", sourceIndex: 103 }];
    const p1 = mapPatchSchema.parse({ documentHash: HASH_A, ops: Object.fromEntries(ops.map((o) => [patchOpId(o), o])) });
    const p2 = mapPatchSchema.parse({ documentHash: HASH_A, ops: Object.fromEntries([...ops].reverse().map((o) => [patchOpId(o), o])) });
    const copy = structuredClone(p1);
    const r1 = resolvePatch(A, B, p1, { toHash: HASH_B });
    expect(JSON.stringify(r1)).toBe(JSON.stringify(resolvePatch(A, B, p2, { toHash: HASH_B })));
    expect(p1).toEqual(copy);
  });

  it("anchors and the same-symbol rule", () => {
    expect(targetAnchor(A, indexOfSource(A, 104))).toEqual({ type: OBJECT_TYPE.area, symbol: symbolAnchor(A, BUILDING), centreMm: [32, 32], sizeMm: [4, 4] });
    const boulder = symbolAnchor(A, BOULDER)!;
    expect(boulder).toMatchObject({ code: "204.0", kind: "point", canonicalId: "ISOM2017-2:204", sourceIndex: BOULDER });
    // Both matched: the canonical id decides, not the code.
    expect(sameSymbol(boulder, { ...boulder, code: "204.1" })).toBe(true);
    expect(sameSymbol(boulder, { ...boulder, canonicalId: "ISOM2017-2:206" })).toBe(false);
    // One unmatched: the source code decides.
    expect(sameSymbol(boulder, { ...boulder, canonicalId: null })).toBe(true);
    expect(sameSymbol(boulder, { ...boulder, canonicalId: null, code: "205.0" })).toBe(false);
    expect(sameSymbol(boulder, { ...boulder, kind: "line" })).toBe(false);
  });
});

describe("attachUnresolved", () => {
  const p = patchOn(HASH_A, [
    { op: "hide", sourceIndex: 101 },
    { op: "modify", sourceIndex: 103, coords: [[2100, 2000]] },
    { op: "add", id: ADD_ID, type: OBJECT_TYPE.point, symbol: { doc: MINBUILDING }, coords: [[1, 1]] },
  ]);
  const noMin = make(SOURCE_B, 1000, [line(8, [0, 10700, 10000, 10700]), point(11, 21000, 20000), square(12, 30000, 30000, 4000)], SYMBOLS.filter((_, i) => i !== MINBUILDING));
  const onB = resolvePatch(A, noMin, p, { toHash: HASH_B }).patch;
  const key = (op: PatchOp) => unresolvedKey(HASH_A, op);

  it("puts a hide onto the chosen object and drops the entry", () => {
    const r = attachUnresolved(onB, key({ op: "hide", sourceIndex: 101 }), noMin, 8);
    expect(r).toEqual({ ok: true, change: { put: [{ op: "hide", sourceIndex: 8 }], removeUnresolved: [key({ op: "hide", sourceIndex: 101 })] } });
    if (!r.ok) return;
    const next = mergePatch(onB, r.change);
    expect(next.ops["hide:8"]).toBeDefined();
    expect(Object.keys(next.unresolved!)).not.toContain(key({ op: "hide", sourceIndex: 101 }));
  });

  it("keeps a modify's shape where it was drawn (rescaled), onto an object of its type only", () => {
    const k = key({ op: "modify", sourceIndex: 103, coords: [[2100, 2000]] });
    expect(attachUnresolved(onB, k, noMin, 11)).toEqual({ ok: true, change: { put: [{ op: "modify", sourceIndex: 11, coords: [[21000, 20000]] }], removeUnresolved: [k] } });
    expect(attachUnresolved(onB, k, noMin, 8)).toEqual({ ok: false, reason: "type-mismatch" });
  });

  it("refuses a missing entry, a missing object and a drop-only entry", () => {
    expect(attachUnresolved(onB, "nope", noMin, 8)).toEqual({ ok: false, reason: "no-entry" });
    expect(attachUnresolved(onB, key({ op: "hide", sourceIndex: 101 }), noMin, 999)).toEqual({ ok: false, reason: "no-object" });
    const add = Object.keys(onB.unresolved!).find((k) => k.endsWith(`add:${ADD_ID}`))!;
    expect(onB.unresolved![add].reason).toBe("symbol");
    expect(attachUnresolved(onB, add, noMin, 11)).toEqual({ ok: false, reason: "drop-only" });
  });
});
