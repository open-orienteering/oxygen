import { describe, expect, it } from "vitest";
import { mapDocument } from "@oxygen/shared";
import { attachKind, entryCentre, entryLabel, entryPickerKind, unresolvedRows } from "../modes/map/unresolved";

/** *Not carried over* (docs/course-editor.md §13 "Unresolved"; G11, G12b). */
const T = mapDocument.OBJECT_TYPE;
const FROM = "cd".repeat(32);
const ADD = "00000000-0000-7000-8000-000000000001";
const sym = { code: "101.0", name: "Contour", kind: "line" as const, canonicalId: null };
const entry = (op: mapDocument.PatchOp, reason: "target" | "symbol", extra: Partial<mapDocument.UnresolvedOp> = {}): mapDocument.UnresolvedOp => ({
  op, from: FROM, fromSource: "ef".repeat(32), unitsPerMm: 100, reason, ...extra,
});
const target = { type: T.line, symbol: sym, centreMm: [12.5, 40] as [number, number], sizeMm: [5, 0] as [number, number] };

describe("unresolved entries in Map mode", () => {
  it("attaches a target entry onto an object, a symbol entry and any add with a symbol", () => {
    expect(attachKind(entry({ op: "hide", sourceIndex: 3 }, "target"))).toBe("object");
    expect(attachKind(entry({ op: "resymbol", sourceIndex: 3, symbol: { doc: 1 } }, "target"))).toBe("object");
    expect(attachKind(entry({ op: "resymbol", sourceIndex: 3, symbol: { doc: 1 } }, "symbol"))).toBe("symbol");
    expect(attachKind(entry({ op: "add", id: ADD, type: T.point, symbol: { doc: 1 }, coords: [[0, 0]] }, "symbol"))).toBe("symbol");
  });

  it("opens the palette in the add's kind, or the resymbol's object's; none for an object entry", () => {
    expect(entryPickerKind(entry({ op: "add", id: ADD, type: T.area, symbol: { doc: 1 }, coords: [[0, 0], [1, 0], [1, 1]] }, "symbol"))).toBe("area");
    expect(entryPickerKind(entry({ op: "resymbol", sourceIndex: 3, symbol: { doc: 1 } }, "symbol", { target }))).toBe("line");
    expect(entryPickerKind(entry({ op: "resymbol", sourceIndex: 3, symbol: { doc: 1 } }, "symbol"))).toBeNull();
    expect(entryPickerKind(entry({ op: "hide", sourceIndex: 3 }, "target", { target }))).toBeNull();
  });

  it("centres on the target anchor, else on an add's own box in its unit", () => {
    expect(entryCentre(entry({ op: "hide", sourceIndex: 3 }, "target", { target }))).toEqual({ x: 12.5, y: 40 });
    expect(entryCentre(entry({ op: "add", id: ADD, type: T.line, symbol: { doc: 1 }, coords: [[1000, 2000], [3000, 6000, 1]] }, "symbol"))).toEqual({ x: 20, y: 40 });
    expect(entryCentre(entry({ op: "hide", sourceIndex: 3 }, "target"))).toBeNull();
  });

  it("names the symbol it was on; rows in key order", () => {
    expect(entryLabel(entry({ op: "hide", sourceIndex: 3 }, "target", { target }))).toBe("101.0 Contour");
    expect(entryLabel(entry({ op: "add", id: ADD, type: T.point, symbol: { patch: "ISOM2017-2:204" }, coords: [[0, 0]] }, "symbol"))).toBe("ISOM2017-2:204");
    const a = entry({ op: "hide", sourceIndex: 9 }, "target", { target });
    const b = entry({ op: "hide", sourceIndex: 2 }, "target");
    const [ka, kb] = [mapDocument.unresolvedKey(FROM, a.op), mapDocument.unresolvedKey(FROM, b.op)];
    const patch = mapDocument.mapPatchSchema.parse({ documentHash: "ab".repeat(32), unresolved: { [ka]: a, [kb]: b } });
    expect(unresolvedRows(patch).map((r) => [r.key, r.attach, r.centre])).toEqual([[kb, "object", null], [ka, "object", { x: 12.5, y: 40 }]]);
    expect(unresolvedRows(null)).toEqual([]);
  });
});
