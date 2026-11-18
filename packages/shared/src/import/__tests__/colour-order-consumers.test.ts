/**
 * The readers of `header.colours` on a document whose stack is the IOF
 * colour layers (docs/map-symbols.md §9.3 "In the importer", row I5):
 * none changes, each is checked here against the same file in the source
 * order — the course layer's stack, materialisation, a patch re-resolved
 * across a pin that moves onto the layers (G11), and print's inks.
 */

import { describe, expect, it } from "vitest";
import { courseColourStack } from "../../course/colour-stack.js";
import { decodeMapDocument, encodeMapDocument, mapDocumentHash, type MapDocument } from "../../map-document/codec.js";
import { OBJECT_TYPE } from "../../map-document/header.js";
import { materialiseSymbol } from "../../map-document/materialise.js";
import { applyPatch, mapPatchSchema, mergePatch, patchOpId, type MapPatch, type PatchOp } from "../../map-document/patch.js";
import { resolvePatch } from "../../map-document/patch-resolve.js";
import { prepareDocument, resetPreparedDocuments } from "../../print/prepared-document.js";
import { stackColour } from "../../print/colour.js";
import { symbolise } from "../../render/symbolise.js";
import { renderColourRefs } from "../../render/transform.js";
import { listSymbolLibraries } from "../../symbol-library/index.js";
import { paletteIndexOfStack } from "../colour-align.js";
import { matchDocument } from "../match-document.js";
import { input } from "./match-fixture.js";

const doc = (order: "iof" | "source"): MapDocument => decodeMapDocument(encodeMapDocument(matchDocument(input(), { colourOrder: order }).input));
const source = doc("source");
const iof = doc("iof");

describe("the course layer's stack on the IOF layers", () => {
  it("accepts the stack: upper white directly under upper purple, lower purple over every area row", () => {
    const stack = courseColourStack(iof.header.colours);
    const upper = stack.index.get("purple-upper")!;
    expect(stack.index.get("white-upper")).toBe(upper - 1);
    expect(upper).toBe(stack.colours.length - 1);
    const lower = stack.index.get("purple-lower")!;
    for (const id of ["yellow100", "brown50-paved", "brown50-road"]) {
      const at = paletteIndexOfStack(stack.colours).get(id);
      if (at !== undefined) expect(at, id).toBeLessThan(lower);
    }
  });
});

describe("materialisation on the IOF layers", () => {
  it("can draw every library entry it can draw on the source order", () => {
    let checked = 0;
    for (const library of listSymbolLibraries()) {
      for (const entry of library.entries) {
        if (!materialiseSymbol(source, entry.id).ok) continue;
        expect(materialiseSymbol(iof, entry.id), entry.id).toMatchObject({ ok: true });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("draws a materialised symbol in the same inks in both orders", () => {
    for (const id of ["ISOM2017-2:206", "ISOM2017-2:502", "ISOM2017-2:401"]) {
      const a = materialiseSymbol(source, id), b = materialiseSymbol(iof, id);
      if (!a.ok || !b.ok) throw new Error(id);
      const inks = (d: MapDocument, s: typeof a.symbol) => renderColourRefs(s.render!).map((c) => d.header.colours[c].cmyk.join(","));
      expect(inks(iof, b.symbol), id).toEqual(inks(source, a.symbol));
    }
  });
});

describe("a patch re-resolved across a pin that moves onto the layers (G11)", () => {
  const BOULDER = 2, MINBUILDING = 4;
  const ADD = "019a7d2e-0000-7000-8000-0000000000bb";
  const hashOf = (d: MapDocument) => mapDocumentHash(encodeMapDocument(matchDocument(input(), { colourOrder: d === iof ? "iof" : "source" }).input));

  it("keeps every op and materialises its patch symbols again on the new stack", async () => {
    const [fromHash, toHash] = await Promise.all([hashOf(source), hashOf(iof)]);
    const sym = materialiseSymbol(source, "ISOM2017-2:204");
    if (!sym.ok) throw new Error("fixture");
    const ops: PatchOp[] = [
      { op: "hide", sourceIndex: 0 },
      { op: "modify", sourceIndex: 1, coords: [[0, 110], [1000, 110]] },
      { op: "resymbol", sourceIndex: 3, symbol: { doc: MINBUILDING } },
      { op: "add", id: ADD, type: OBJECT_TYPE.point, symbol: { patch: sym.key }, coords: [[100, 100]] },
      { op: "add", id: "019a7d2e-0000-7000-8000-0000000000bc", type: OBJECT_TYPE.point, symbol: { doc: BOULDER }, coords: [[200, 200]] },
    ];
    const p: MapPatch = mergePatch(mapPatchSchema.parse({ documentHash: fromHash, ops: Object.fromEntries(ops.map((op) => [patchOpId(op), op])), symbols: { [sym.key]: sym.symbol } }), {});
    const r = resolvePatch(source, iof, p, { toHash });
    expect(r).toMatchObject({ resolved: ops.length, unresolved: 0 });
    expect(r.patch.unresolved).toBeUndefined();
    const again = materialiseSymbol(iof, sym.key);
    if (!again.ok) throw new Error("not materialisable on the layers");
    expect(r.patch.symbols).toEqual({ [sym.key]: again.symbol });
    // Its colours are rows carrying the entry's palette ids on the layers.
    for (const c of renderColourRefs(again.symbol.render!)) expect(iof.header.colours[c].paletteIds?.length, String(c)).toBeGreaterThan(0);
    const eff = applyPatch(iof, { ...r.patch, enabled: true });
    expect(eff.issues).toEqual([]);
  });
});

describe("print on the IOF layers", () => {
  it("prints every pass in the ink it has in the source order: a split colour is one ink", async () => {
    resetPreparedDocuments();
    const inks = async (d: MapDocument, hash: string) => {
      const p = await prepareDocument(hash, () => encodeMapDocument(matchDocument(input(), { colourOrder: d === iof ? "iof" : "source" }).input));
      const { stream } = symbolise({ objects: p.input.objects, symbols: p.input.symbols, fonts: [] });
      return stream.passes.map((x, i) => `${stream.objectIdx[i]}:${x.kind}:${JSON.stringify(stackColour(p.colours[x.colour], "cmyk"))}`).sort();
    };
    expect(await inks(iof, "i".repeat(64))).toEqual(await inks(source, "s".repeat(64)));
    // The layers split a colour into rows; print gives every row of it one ink.
    const rep = matchDocument(input(), { colourOrder: "iof" }).colourStack.layers!;
    for (const s of rep.split) {
      const rows = rep.rows.filter((r) => r.source === s.source).map((r) => JSON.stringify(stackColour(iof.header.colours[r.row], "cmyk")));
      expect(new Set(rows).size).toBe(1);
    }
    resetPreparedDocuments();
  });
});
