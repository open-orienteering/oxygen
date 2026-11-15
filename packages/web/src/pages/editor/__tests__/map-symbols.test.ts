/**
 * Map mode's symbols (docs/course-editor.md §13 "Drawing", "Symbol picker"; map-patches.md §1.3): a library symbol
 * materialised on first use and put with the op that references it, change symbol, rotation, and the add op.
 */

import { describe, expect, it } from "vitest";
import { mapDocument, render } from "@oxygen/shared";
import { inverseChange, mapModelOf, objectInfo } from "../modes/map/model";
import {
  addChange, addOp, angleChange, angleOfDrag, isOrientable, isOrientableRef, kindOfType, newAddId, refOfSymbolKey, resymbolChange, symbolKey, symbolPut, tenthsOf,
} from "../modes/map/symbols";
import { HASH, patchOf, pinnedDoc } from "./map-fixture";

const T = mapDocument.OBJECT_TYPE;
const ADD = "0190a000-0000-7000-8000-000000000001";
const BOULDER = "ISOM2017-2:204";
const KNOLL = "ISOM2017-2:110";

describe("symbolPut: materialise on first use (§13 \"Drawing\")", () => {
  const pinned = pinnedDoc();

  it("a document symbol is { doc } with nothing to put", () => {
    expect(symbolPut(pinned, null, { doc: 1 })).toEqual({ ok: true, ref: { doc: 1 } });
    expect(symbolPut(pinned, null, { doc: 9 })).toEqual({ ok: false, reason: "unknown-symbol" });
  });

  it("a library entry is { patch: key } with its materialised symbol put, the same JSON as materialiseSymbol's", () => {
    const r = symbolPut(pinned, null, { patch: BOULDER });
    const m = mapDocument.materialiseSymbol(pinned, BOULDER);
    if (!r.ok || !m.ok) throw new Error("expected materialisable");
    expect(r.ref).toEqual({ patch: BOULDER });
    expect(JSON.stringify(r.putSymbols)).toBe(JSON.stringify({ [BOULDER]: m.symbol }));
  });

  it("a key already in the patch is not put again", () => {
    const m = mapDocument.materialiseSymbol(pinned, BOULDER);
    if (!m.ok) throw new Error("expected materialisable");
    expect(symbolPut(pinned, patchOf([], { [BOULDER]: m.symbol }), { patch: BOULDER })).toEqual({ ok: true, ref: { patch: BOULDER } });
  });

  it("missing colours and an unknown entry are refused, with the missing palette ids", () => {
    expect(symbolPut(pinned, null, { patch: "ISOM2017-2:312" })).toEqual({ ok: false, reason: "missing-colours", missing: ["blue100-point"] });
    expect(symbolPut(pinned, null, { patch: "ISOM2017-2:999" })).toEqual({ ok: false, reason: "unknown-entry" });
  });

  it("symbol keys round-trip doc:<i> and patch:<key>", () => {
    expect(symbolKey({ doc: 3 })).toBe("doc:3");
    expect(symbolKey({ patch: BOULDER })).toBe(`patch:${BOULDER}`);
    expect(refOfSymbolKey("doc:3")).toEqual({ doc: 3 });
    expect(refOfSymbolKey(`patch:${BOULDER}`)).toEqual({ patch: BOULDER });
    expect(refOfSymbolKey("nope")).toBeNull();
  });
});

describe("the add op (§13 \"Drawing\")", () => {
  it("a point with angle only when not 0; a library symbol's first use puts it in the same change", () => {
    const pinned = pinnedDoc();
    const put = symbolPut(pinned, null, { patch: BOULDER });
    if (!put.ok) throw new Error("expected ok");
    const op = addOp(ADD, T.point, put.ref, [[1200, 800]], 0);
    expect(op).toEqual({ op: "add", id: ADD, type: 1, symbol: { patch: BOULDER }, coords: [[1200, 800]] });
    expect(addOp(ADD, T.point, put.ref, [[1200, 800]], 900).angle).toBe(900);
    const change = addChange(put, op);
    expect(change.put).toEqual([op]);
    expect(Object.keys(change.putSymbols ?? {})).toEqual([BOULDER]);
    // The change parses and applies: the added boulder is drawn with the patch symbol.
    const patch = mapDocument.mergePatch(patchOf([]), mapDocument.patchChangeSchema.parse(change));
    const { document: doc, issues } = mapDocument.applyPatch(pinned, patch);
    expect(issues).toEqual([]);
    expect(doc.header.symbols[doc.attrs.symbolIdx[4]].code).toBe("204");
    // Undo removes the add only: the symbol stays (map-patches §1.5).
    expect(inverseChange(null, change)).toEqual({ remove: [`add:${ADD}`] });
  });

  it("newAddId is a lowercase UUIDv7 the schema takes, ordered by time", () => {
    const a = newAddId(1_700_000_000_000), b = newAddId(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(() => mapDocument.patchChangeSchema.parse({ put: [addOp(a, T.point, { doc: 2 }, [[0, 0]])] })).not.toThrow();
  });

  it("kinds of object types; the drag's angle in 0.1°, counter-clockwise from +x, normalised", () => {
    expect([T.point, T.line, T.area, T.text].map(kindOfType)).toEqual(["point", "line", "area", null]);
    expect(angleOfDrag(1, 0)).toBe(0);
    expect(angleOfDrag(0, 1)).toBe(900);
    expect(angleOfDrag(-1, 0)).toBe(1800);
    expect(angleOfDrag(0, -1)).toBe(2700);
    expect(angleOfDrag(1, -0.0001)).toBe(0);
  });

  it("the symbol's x axis turns along the drag: the symbolised knoll's glyph maps its +x onto the drag's direction", () => {
    const pinned = pinnedDoc();
    for (const [dx, dy] of [[0, 1], [-1, 1], [1, -2]]) {
      const patch = mapDocument.mergePatch(patchOf([]), { put: [addOp(ADD, T.point, { doc: 3 }, [[1000, 1000]], angleOfDrag(dx, dy))] });
      const { document: doc } = mapDocument.applyPatch(pinned, patch);
      const input = mapDocument.documentRenderInput(doc, { only: [4] });
      const { stream } = render.symbolise({ objects: input.objects, symbols: input.symbols, fonts: [] });
      const glyph = stream.passes.find((p) => p.kind === "glyph");
      if (glyph?.kind !== "glyph") throw new Error("no glyph pass");
      // Instance = [x, y, cos, sin, scale]; glyph-local (1, 0) lands on (cos, sin) (reference-svg's matrix).
      const len = Math.hypot(dx, dy);
      expect(glyph.instances[2]).toBeCloseTo(dx / len, 2);
      expect(glyph.instances[3]).toBeCloseTo(dy / len, 2);
    }
  });
});

describe("change symbol and rotation (§13 \"Ops\")", () => {
  const pinned = pinnedDoc();

  it("orientable: a point render with orientation object and a rotatable glyph; a library or patch key by its render", () => {
    const m = mapModelOf(HASH, pinned, null);
    expect(isOrientable(m.doc.header.symbols[3])).toBe(true);
    expect(isOrientable(m.doc.header.symbols[2])).toBe(false);
    expect(isOrientable(m.doc.header.symbols[1])).toBe(false);
    expect(isOrientableRef(pinned, null, { doc: 3 })).toBe(true);
    expect(isOrientableRef(pinned, null, { patch: KNOLL })).toBe(true);
    expect(isOrientableRef(pinned, null, { patch: BOULDER })).toBe(false);
    const put = symbolPut(pinned, null, { patch: KNOLL });
    if (!put.ok) throw new Error("expected ok");
    expect(isOrientableRef(pinned, patchOf([], put.putSymbols), { patch: KNOLL })).toBe(true);
  });

  it("the rotation field's degrees: comma or point, normalised, 0.1° steps; not a number is null", () => {
    expect(tenthsOf("45")).toBe(450);
    expect(tenthsOf(" 12,34 ")).toBe(123);
    expect(tenthsOf("-90")).toBe(2700);
    expect(tenthsOf("360")).toBe(0);
    expect(tenthsOf("")).toBeNull();
    expect(tenthsOf("abc")).toBeNull();
  });

  it("a document object is resymbolled; back to its own symbol drops the resymbol; the same symbol writes nothing", () => {
    const m0 = mapModelOf(HASH, pinned, null);
    const toKnoll = resymbolChange(m0, null, { source: 11 }, { ok: true, ref: { doc: 3 } });
    expect(toKnoll).toEqual({ put: [{ op: "resymbol", sourceIndex: 11, symbol: { doc: 3 } }] });
    const p1 = patchOf(toKnoll!.put!);
    const m1 = mapModelOf(HASH, pinned, p1);
    expect(resymbolChange(m1, p1, { source: 11 }, { ok: true, ref: { doc: 3 } })).toBeNull();
    expect(resymbolChange(m1, p1, { source: 11 }, { ok: true, ref: { doc: 2 } })).toEqual({ remove: ["resymbol:11"] });
    expect(resymbolChange(m0, null, { source: 11 }, { ok: true, ref: { doc: 2 } })).toBeNull();
    // A library symbol goes with its putSymbols.
    const put = symbolPut(pinned, null, { patch: KNOLL });
    if (!put.ok) throw new Error("expected ok");
    const lib = resymbolChange(m0, null, { source: 11 }, put)!;
    expect(lib.put).toEqual([{ op: "resymbol", sourceIndex: 11, symbol: { patch: KNOLL } }]);
    expect(Object.keys(lib.putSymbols ?? {})).toEqual([KNOLL]);
    expect(inverseChange(null, lib)).toEqual({ remove: ["resymbol:11"] });
  });

  it("an added object's add is rewritten with the symbol", () => {
    const add = addOp(ADD, T.point, { doc: 2 }, [[500, 500]]);
    const p = patchOf([add]);
    const m = mapModelOf(HASH, pinned, p);
    expect(resymbolChange(m, p, { added: ADD }, { ok: true, ref: { doc: 3 } })).toEqual({ put: [{ ...add, symbol: { doc: 3 } }] });
    expect(resymbolChange(m, p, { added: ADD }, { ok: true, ref: { doc: 2 } })).toBeNull();
  });

  it("rotation: a document point's modify carries its coordinates and the angle; back to its own drops it", () => {
    const m0 = mapModelOf(HASH, pinned, null);
    const turn = angleChange(m0, null, { source: 12 }, 900);
    expect(turn).toEqual({ put: [{ op: "modify", sourceIndex: 12, coords: [[3000, 1000]], angle: 900 }] });
    expect(angleChange(m0, null, { source: 12 }, 450)).toBeNull();
    const p1 = patchOf(turn!.put!);
    const m1 = mapModelOf(HASH, pinned, p1);
    expect(m1.doc.attrs.angle[3]).toBe(900);
    expect(angleChange(m1, p1, { source: 12 }, 450)).toEqual({ remove: ["modify:12"] });
    // A moved point keeps its move.
    const moved = patchOf([{ op: "modify", sourceIndex: 12, coords: [[3100, 1000]] }]);
    const m2 = mapModelOf(HASH, pinned, moved);
    expect(angleChange(m2, moved, { source: 12 }, 450)).toBeNull();
    expect(angleChange(m2, moved, { source: 12 }, 0)).toEqual({ put: [{ op: "modify", sourceIndex: 12, coords: [[3100, 1000]], angle: 0 }] });
  });

  it("rotation of an added point rewrites its add, 0 omitted", () => {
    const add = addOp(ADD, T.point, { doc: 3 }, [[500, 500]], 300);
    const p = patchOf([add]);
    const m = mapModelOf(HASH, pinned, p);
    const { angle: _a, ...plain } = add;
    expect(angleChange(m, p, { added: ADD }, 0)).toEqual({ put: [plain] });
    expect(angleChange(m, p, { added: ADD }, 300)).toBeNull();
  });
});

describe("objectInfo of a drawn object (§13 \"Inspector\")", () => {
  it("a patch symbol names its key, draws the library preview of that entry, and the angle is attrs.angle", () => {
    const pinned = pinnedDoc();
    const put = symbolPut(pinned, null, { patch: KNOLL });
    if (!put.ok) throw new Error("expected ok");
    const patch = mapDocument.mergePatch(patchOf([]), mapDocument.patchChangeSchema.parse(addChange(put, addOp(ADD, T.point, put.ref, [[500, 500]], 300))));
    const m = mapModelOf(HASH, pinned, patch);
    const info = objectInfo(m, { added: ADD }, "en")!;
    expect(info.symbol).toEqual({ patch: KNOLL });
    expect(info.swatch).toEqual({ kind: "library", canonicalId: KNOLL });
    expect(info.code).toBe("110");
    expect(info.angle).toBe(300);
    expect(isOrientable(m.doc.header.symbols[info.symbolIdx])).toBe(true);
    const doc = objectInfo(m, { source: 12 }, "en")!;
    expect(doc.symbol).toEqual({ doc: 3 });
    expect(doc.angle).toBe(450);
    expect(doc.swatch).toEqual({ kind: "document", idx: 3 });
  });
});
