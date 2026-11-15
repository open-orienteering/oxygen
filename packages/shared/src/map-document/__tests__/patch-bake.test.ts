/**
 * Promote's bake (docs/map-patches.md §5; row G12a): the layer promote
 * stores, and the version patch applied to an import input before encoding.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { documentSymbolFingerprints, reviewRows } from "../../import/decisions.js";
import { matchDocument } from "../../import/match-document.js";
import { readOmap } from "../../import/omap-reader.js";
import { omapToDocumentInput } from "../../import/omap-source.js";
import { decodeMapDocument, encodeMapDocument, type MapDocument, type MapDocumentInput } from "../codec.js";
import { OBJECT_TYPE } from "../header.js";
import { materialiseSymbol } from "../materialise.js";
import { ADDED_SOURCE_INDEX, applyPatch, mapPatchSchema, type EffectiveDocument, type MapPatch, type PatchOp } from "../patch.js";
import {
  BAKED_SOURCE_INDEX_BASE,
  bakeVersionPatch,
  parseVersionPatch,
  sameVersionPatch,
  versionLayerOfPatch,
  versionPatchLayerSchema,
  versionPatchOpCount,
  versionPatchSchema,
  type VersionPatchLayer,
} from "../patch-bake.js";
import { symbolAnchor } from "../patch-resolve.js";
import { documentRenderInput } from "../render-bridge.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");

const raw = omapToDocumentInput(readOmap(readFileSync(resolve(ROOT, "e2e/test.xmap"), "utf8")), { fileName: "test.xmap", fileHash: "ab".repeat(32), fileBytes: 1 }).input;
const INPUT: MapDocumentInput = matchDocument(raw).input;
const encode = (i: MapDocumentInput) => encodeMapDocument(i);
const decode = (i: MapDocumentInput): MapDocument => decodeMapDocument(encode(i));
const DOC = decode(INPUT);
const HASH = "cd".repeat(32);

const ID_A = "019a7d2e-0000-7000-8000-00000000000a";
const ID_B = "019a7d2e-0000-7000-8000-00000000000b";
const ID_C = "019a7d2e-0000-7000-8000-00000000000c";

const firstOf = (type: number, minCoords = 1): number => {
  for (let i = 0; i < DOC.header.objects.count; i++) {
    const sym = DOC.header.symbols[DOC.attrs.symbolIdx[i]];
    if (DOC.attrs.type[i] === type && DOC.attrs.coordCount[i] >= minCoords && sym && !sym.hidden && sym.render) return i;
  }
  throw new Error(`no object of type ${type}`);
};
const iPoint = firstOf(OBJECT_TYPE.point);
const iLine = firstOf(OBJECT_TYPE.line, 2);
const iArea = firstOf(OBJECT_TYPE.area, 3);
const src = (i: number) => DOC.attrs.sourceIndex[i];
const coordsOf = (doc: MapDocument, i: number): [number, number, number][] => {
  const out: [number, number, number][] = [];
  for (let k = doc.coordStart[i]; k < doc.coordStart[i + 1]; k++) out.push([doc.coords[k * 2], doc.coords[k * 2 + 1], doc.flags[k]]);
  return out;
};
const symOfKind = (kind: string, not?: number): number => DOC.header.symbols.findIndex((s, i) => s.kind === kind && i !== not && s.render && !s.hidden && s.sourceIndex !== undefined);
const lineSym = symOfKind("line");
const otherArea = symOfKind("area", DOC.attrs.symbolIdx[iArea]);

/** A point entry of the ISOM library this document can draw. */
const POINT_KEY = ["ISOM2017-2:204", "ISOM2017-2:206", "ISOM2017-2:202", "ISOM2017-2:418"].find((k) => {
  const m = materialiseSymbol(DOC, k);
  return m.ok && m.symbol.kind === "point";
})!;
const pointSymbol = (() => {
  const m = materialiseSymbol(DOC, POINT_KEY);
  if (!m.ok) throw new Error("not materialisable");
  return m.symbol;
})();

const shifted = coordsOf(DOC, iLine).map(([x, y, f]) => [x + 5000, y - 3000, f] as [number, number, number]);
const ops: PatchOp[] = [
  { op: "hide", sourceIndex: src(iPoint) },
  { op: "modify", sourceIndex: src(iLine), coords: shifted },
  { op: "resymbol", sourceIndex: src(iArea), symbol: { doc: otherArea } },
  { op: "add", id: ID_A, type: OBJECT_TYPE.line, symbol: { doc: lineSym }, coords: [[1000, 1000], [9000, 4000], [15000, 1000, 1]] },
  { op: "add", id: ID_B, type: OBJECT_TYPE.point, symbol: { patch: POINT_KEY }, coords: [[20000, 20000]], angle: 300 },
  // Does not apply: no such object.
  { op: "hide", sourceIndex: 0x7ffffff0 },
];
const patchOf = (list: PatchOp[], extra: Partial<MapPatch> = {}): MapPatch =>
  mapPatchSchema.parse({
    documentHash: HASH,
    ops: Object.fromEntries(list.map((o) => [o.op === "add" ? `add:${o.id}` : `${o.op}:${o.sourceIndex}`, o])),
    symbols: { [POINT_KEY]: pointSymbol },
    ...extra,
  });
const PATCH = patchOf(ops);

describe("versionLayerOfPatch", () => {
  it("holds the ops that apply, with anchors and the patch symbol keys", () => {
    const r = versionLayerOfPatch(DOC, PATCH)!;
    expect(r.skipped).toEqual([{ opId: `hide:${0x7ffffff0}`, code: "target-missing" }]);
    expect(r.promoted).toEqual(Object.keys(PATCH.ops).filter((k) => k !== `hide:${0x7ffffff0}`).sort());
    expect(r.layer.unitsPerMm).toBe(1000);
    expect(r.layer.symbols).toEqual([POINT_KEY]);
    expect(r.layer.ops[`resymbol:${src(iArea)}`]).toEqual({ op: "resymbol", sourceIndex: src(iArea), symbol: { doc: symbolAnchor(DOC, otherArea) } });
    expect(r.layer.ops[`add:${ID_A}`]).toMatchObject({ symbol: { doc: symbolAnchor(DOC, lineSym) } });
    expect(r.layer.ops[`add:${ID_B}`]).toMatchObject({ symbol: { patch: POINT_KEY }, angle: 300 });
    expect(versionPatchLayerSchema.parse(r.layer)).toEqual(r.layer);
    expect(versionPatchOpCount([r.layer, r.layer])).toBe(10);
  });

  it("takes a disabled patch as enabled, ignores unresolved entries and is blind to record order", () => {
    const disabled = versionLayerOfPatch(DOC, { ...PATCH, enabled: false })!;
    const reversed = versionLayerOfPatch(DOC, patchOf([...ops].reverse()))!;
    const a = versionLayerOfPatch(DOC, PATCH)!;
    expect(disabled).toEqual(a);
    expect(JSON.stringify(reversed.layer)).toBe(JSON.stringify(a.layer));
  });

  it("is null for an empty patch and for one whose ops all fail", () => {
    expect(versionLayerOfPatch(DOC, patchOf([]))).toBeNull();
    expect(versionLayerOfPatch(DOC, patchOf([{ op: "hide", sourceIndex: 0x7ffffff0 }]))).toBeNull();
  });

  it("refuses a layer keyed by something other than its op id", () => {
    const layer = versionLayerOfPatch(DOC, PATCH)!.layer;
    expect(versionPatchLayerSchema.safeParse({ ...layer, ops: { "hide:1": { op: "hide", sourceIndex: 2 } } }).success).toBe(false);
    expect(versionPatchSchema.safeParse({}).success).toBe(false);
  });
});

/** Per object, what a reader draws: by sourceIndex for base objects, by add rank for added ones. */
function drawn(doc: EffectiveDocument): Map<number, unknown> {
  const r = documentRenderInput(doc);
  const out = new Map<number, unknown>();
  r.objects.forEach((o, k) => {
    const i = r.docIdx[k];
    const s = doc.attrs.sourceIndex[i];
    // applyPatch numbers its adds after the base objects in op-id order, as the bake does from BASE.
    const key = s === ADDED_SOURCE_INDEX ? BAKED_SOURCE_INDEX_BASE + (i - doc.patch!.baseCount) : s;
    out.set(key, { symbol: r.symbols[o.symbolIdx], coords: Array.from(o.path.coords), flags: Array.from(o.path.flags), angle: o.angleDeg ?? 0, text: o.text ?? null });
  });
  return out;
}

describe("bakeVersionPatch", () => {
  const layer = versionLayerOfPatch(DOC, PATCH)!.layer;

  it("draws what the event drew: the effective document minus the hidden objects", () => {
    const baked = bakeVersionPatch(INPUT, [layer]);
    expect(baked.issues).toEqual([]);
    expect(baked.stats).toEqual({ hidden: 1, modified: 1, resymbolled: 1, added: 2, symbols: 1 });
    const doc = decode(baked.input);
    expect(doc.header.objects.count).toBe(DOC.header.objects.count - 1 + 2);
    expect(Array.from(doc.attrs.sourceIndex)).not.toContain(src(iPoint));
    expect(Array.from(doc.attrs.sourceIndex).filter((s) => s >= BAKED_SOURCE_INDEX_BASE).sort()).toEqual([BAKED_SOURCE_INDEX_BASE, BAKED_SOURCE_INDEX_BASE + 1]);
    // The patch symbol is one table entry, without match or source position.
    const added = doc.header.symbols.at(-1)!;
    expect(doc.header.symbols.length).toBe(DOC.header.symbols.length + 1);
    expect(added).toMatchObject({ code: pointSymbol.code, kind: "point", render: pointSymbol.render });
    expect(added.match).toBeUndefined();
    expect(added.sourceIndex).toBeUndefined();
    // Not the source's: no review row, no decision fingerprint (map-symbols §8.5).
    const last = doc.header.symbols.length - 1;
    expect(documentSymbolFingerprints(doc.header)[last]).toBeNull();
    expect(documentSymbolFingerprints(doc.header).slice(0, last)).toEqual(documentSymbolFingerprints(DOC.header));
    expect(reviewRows(doc.header, []).map((r) => r.symbolIdx)).not.toContain(last);

    const event = applyPatch(DOC, PATCH).document;
    expect(drawn(doc)).toEqual(drawn(event));
  });

  it("is deterministic and blind to the layer's record order", () => {
    const reversed: VersionPatchLayer = { ...layer, ops: Object.fromEntries(Object.entries(layer.ops).reverse()) };
    const a = encode(bakeVersionPatch(INPUT, [layer]).input);
    expect(encode(bakeVersionPatch(INPUT, [layer]).input)).toEqual(a);
    expect(encode(bakeVersionPatch(INPUT, [reversed]).input)).toEqual(a);
  });

  it("returns the input itself without layers, so the bytes are today's import", () => {
    const r = bakeVersionPatch(INPUT, []);
    expect(r.input).toBe(INPUT);
    expect(encode(r.input)).toEqual(encode(INPUT));
  });

  it("does not mutate its input", () => {
    const before = JSON.stringify({ h: INPUT.header, o: INPUT.objects.map((o) => ({ ...o, coords: Array.from(o.coords), flags: Array.from(o.flags) })) });
    bakeVersionPatch(INPUT, [layer]);
    expect(JSON.stringify({ h: INPUT.header, o: INPUT.objects.map((o) => ({ ...o, coords: Array.from(o.coords), flags: Array.from(o.flags) })) })).toBe(before);
  });

  it("stacks layers: a later layer edits an earlier one's added object, and numbers never shift", () => {
    const v2 = decode(bakeVersionPatch(INPUT, [layer]).input);
    const iAdded = Array.from(v2.attrs.sourceIndex).indexOf(BAKED_SOURCE_INDEX_BASE);
    const iPt = Array.from(v2.attrs.sourceIndex).indexOf(BAKED_SOURCE_INDEX_BASE + 1);
    const baked = v2.header.symbols.length - 1;
    const second = versionLayerOfPatch(v2, mapPatchSchema.parse({
      documentHash: HASH,
      ops: {
        [`modify:${BAKED_SOURCE_INDEX_BASE}`]: { op: "modify", sourceIndex: BAKED_SOURCE_INDEX_BASE, coords: [[2000, 2000], [8000, 8000]] },
        [`hide:${BAKED_SOURCE_INDEX_BASE + 1}`]: { op: "hide", sourceIndex: BAKED_SOURCE_INDEX_BASE + 1 },
        [`add:${ID_C}`]: { op: "add", id: ID_C, type: OBJECT_TYPE.point, symbol: { doc: baked }, coords: [[3000, 3000]] },
      },
    }))!;
    expect(second.layer.ops[`add:${ID_C}`]).toMatchObject({ symbol: { doc: { code: pointSymbol.code, kind: "point" } } });
    expect(iAdded).toBeGreaterThanOrEqual(0);
    expect(iPt).toBeGreaterThanOrEqual(0);

    const v3 = bakeVersionPatch(INPUT, [layer, second.layer]);
    expect(v3.issues).toEqual([]);
    const doc = decode(v3.input);
    const at = (s: number) => Array.from(doc.attrs.sourceIndex).indexOf(s);
    expect(coordsOf(doc, at(BAKED_SOURCE_INDEX_BASE))).toEqual([[2000, 2000, 0], [8000, 8000, 0]]);
    expect(at(BAKED_SOURCE_INDEX_BASE + 1)).toBe(-1);
    // The third add is n = 2 and drawn with layer 1's patch symbol, found by its anchor.
    expect(doc.header.symbols[doc.attrs.symbolIdx[at(BAKED_SOURCE_INDEX_BASE + 2)]]).toMatchObject({ code: pointSymbol.code, render: pointSymbol.render });
    expect(doc.header.symbols.length).toBe(DOC.header.symbols.length + 1);

    // Layer 1's first add skipped (its symbol gone): the second add keeps BASE + 1, layer 2's add BASE + 2.
    const broken: VersionPatchLayer = { ...layer, ops: { ...layer.ops, [`add:${ID_A}`]: { ...layer.ops[`add:${ID_A}`], symbol: { doc: { code: "no-such", name: "x", kind: "line", canonicalId: null } } } as VersionPatchLayer["ops"][string] } };
    const r = bakeVersionPatch(INPUT, [broken, { unitsPerMm: 1000, ops: { [`add:${ID_C}`]: second.layer.ops[`add:${ID_C}`] }, symbols: [] }]);
    expect(r.issues).toEqual([{ layer: 0, opId: `add:${ID_A}`, code: "symbol-missing" }]);
    const d = decode(r.input);
    expect(Array.from(d.attrs.sourceIndex).filter((s) => s >= BAKED_SOURCE_INDEX_BASE).sort()).toEqual([BAKED_SOURCE_INDEX_BASE + 1, BAKED_SOURCE_INDEX_BASE + 2]);
  });

  it("skips an op that no longer applies, reports it and applies the rest", () => {
    const l: VersionPatchLayer = {
      unitsPerMm: 1000,
      symbols: ["ISOM2017-2:no-such-entry"],
      ops: {
        [`hide:${0x7ffffff0}`]: { op: "hide", sourceIndex: 0x7ffffff0 },
        [`hide:${src(iPoint)}`]: { op: "hide", sourceIndex: src(iPoint) },
        [`modify:${src(iLine)}`]: { op: "modify", sourceIndex: src(iLine), coords: [[1, 1]] },
        [`resymbol:${src(iArea)}`]: { op: "resymbol", sourceIndex: src(iArea), symbol: { doc: symbolAnchor(DOC, lineSym)! } },
        [`add:${ID_A}`]: { op: "add", id: ID_A, type: OBJECT_TYPE.point, symbol: { patch: "ISOM2017-2:no-such-entry" }, coords: [[1, 1]] },
      },
    };
    const r = bakeVersionPatch(INPUT, [l]);
    expect(r.issues).toEqual([
      { layer: 0, opId: `add:${ID_A}`, code: "symbol-missing" },
      { layer: 0, opId: `hide:${0x7ffffff0}`, code: "target-missing" },
      { layer: 0, opId: `modify:${src(iLine)}`, code: "geometry-invalid" },
      { layer: 0, opId: `resymbol:${src(iArea)}`, code: "kind-mismatch" },
    ]);
    expect(Array.from(decode(r.input).attrs.sourceIndex)).not.toContain(src(iPoint));
  });

  it("rescales a layer's coordinates to the input's unit", () => {
    const l: VersionPatchLayer = { unitsPerMm: 100, symbols: [], ops: { [`modify:${src(iLine)}`]: { op: "modify", sourceIndex: src(iLine), coords: [[10, 20], [30, 40, 1]] } } };
    const doc = decode(bakeVersionPatch(INPUT, [l]).input);
    expect(coordsOf(doc, Array.from(doc.attrs.sourceIndex).indexOf(src(iLine)))).toEqual([[100, 200, 0], [300, 400, 1]]);
  });
});

describe("version patch values", () => {
  it("parses stored JSON; null, garbage and [] are none, and compare equal", () => {
    expect(parseVersionPatch(null)).toEqual([]);
    expect(parseVersionPatch({ not: "a list" })).toEqual([]);
    expect(sameVersionPatch(null, [])).toBe(true);
    const layer = versionLayerOfPatch(DOC, PATCH)!.layer;
    const reordered = JSON.parse(JSON.stringify({ symbols: layer.symbols, ops: layer.ops, unitsPerMm: layer.unitsPerMm }));
    expect(sameVersionPatch([layer], [reordered])).toBe(true);
    expect(sameVersionPatch([layer], [])).toBe(false);
    expect(parseVersionPatch([layer])).toEqual([layer]);
    // Record order restored: JSONB stores object keys shortest first.
    const shuffled = { ...layer, ops: Object.fromEntries(Object.entries(layer.ops).reverse()) };
    expect(Object.keys(parseVersionPatch([shuffled])[0].ops)).toEqual(Object.keys(layer.ops));
  });
});
