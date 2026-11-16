/**
 * A GPS track converted into a map object (docs/map-gps-tracks.md §6; docs/course-editor.md §13 "GPS tracks:
 * convert"; row G26): the track → `add` op (units, symbol, determinism), the change with its symbol's first use, the
 * marks, the controls' ranges and per-device memory, and the picker's order.
 */

import { describe, expect, it } from "vitest";
import { gpsTrack, mapDocument } from "@oxygen/shared";
import {
  DEFAULT_CONVERT, SMOOTH_DEFAULT_M, SMOOTH_MAX_M, TOL_DEFAULT_MM, TOL_MAX_MM, TOL_MIN_MM, clampSettings, conversionChange, convertLine, convertOp,
  convertPalette, lineOp, lineVertices, mintAddIds, nodeCount, nodeSummary, parseStoredConvert, planConversion, rememberedOf, resolveRemembered,
} from "../modes/map/tracks/convert";
import { drawOp } from "../modes/map/draw";
import { newAddId, symbolPut } from "../modes/map/symbols";
import { HASH, patchOf, pinnedDoc } from "./map-fixture";

const OTHER = "cd".repeat(32);

/** The E2E fixture's "E2E inside" (e2e/fixtures/gps-tracks.json): an L, 1:7500. */
const L_MM: [number, number][] = [[-15, 10], [-15, 0], [-15, -10.001], [0, -9.999], [15, -10.001]];
const line = (mm: [number, number][], metresPerMm = 7.5): gpsTrack.ProjectedTrack => ({
  x: Float64Array.from(mm.map((p) => p[0])), y: Float64Array.from(mm.map((p) => p[1])), metresPerMm,
});
const ID = "0190a000-0000-7000-8000-0000000000c1";
const LINE_SYMBOL = { doc: 1 } as const;

/** A seeded noisy wave along +x, 1 m between fixes at 1:10 000 (0.1 mm), ±30 m of wave, cross-track noise ±2 m. */
function noisy(n: number, seed = 7): gpsTrack.ProjectedTrack {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  return line(Array.from({ length: n }, (_, i) => [i * 0.1, 3 * Math.sin(i / 150) + rnd() * 0.2] as [number, number]), 10);
}

describe("track → add op (§6)", () => {
  it("the fixture L at 100 units per mm without smoothing: its three corners, rounded, in order", () => {
    const op = convertOp(ID, line(L_MM), { windowM: 0, toleranceMm: 0.1 }, LINE_SYMBOL, 100)!;
    expect(op).toEqual({ op: "add", id: ID, type: 2, symbol: LINE_SYMBOL, coords: [[-1500, 1000], [-1500, -1000], [1500, -1000]] });
    // No flags, no angle: corner nodes, as `L` writes them.
    expect(op.coords.every((c) => c.length === 2 && c.every(Number.isInteger))).toBe(true);
    expect("angle" in op).toBe(false);
  });

  it("at 1000 units per mm (Mapper) the same line in finer units", () => {
    const op = convertOp(ID, line(L_MM), { windowM: 0, toleranceMm: 0.1 }, LINE_SYMBOL, 1000)!;
    expect(op.coords).toEqual([[-15000, 10000], [-15000, -10001], [15000, -10001]]);
  });

  it("is the op `L` writes for the same vertices (drawOp)", () => {
    const simplified = convertLine(line(L_MM), DEFAULT_CONVERT);
    const verts = Array.from(simplified.x, (x, i) => ({ x, y: simplified.y[i] }));
    expect(lineOp(ID, simplified, LINE_SYMBOL, 100)).toEqual(drawOp(ID, "line", LINE_SYMBOL, 100, { vertices: verts }));
  });

  it("smoothing pins the ends: the op's first and last coordinates are the track's ends, rounded", () => {
    for (const windowM of [4, 10, 30]) {
      const op = convertOp(ID, line(L_MM), { windowM, toleranceMm: 0.1 }, LINE_SYMBOL, 100)!;
      expect(op.coords[0]).toEqual([-1500, 1000]);
      expect(op.coords.at(-1)).toEqual([1500, -1000]);
      // The corner is cut (smoothing), so it takes more than the three corners.
      expect(op.coords.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("smoothing and simplification reduce a noisy track's nodes; a larger tolerance fewer still", () => {
    const n = noisy(2000);
    const raw = nodeCount(convertLine(n, { windowM: 0, toleranceMm: TOL_MIN_MM }), 100);
    const def = nodeCount(convertLine(n, DEFAULT_CONVERT), 100);
    const coarse = nodeCount(convertLine(n, { windowM: SMOOTH_MAX_M, toleranceMm: TOL_MAX_MM }), 100);
    expect(def).toBeLessThan(raw);
    expect(coarse).toBeLessThan(def);
    expect(coarse).toBeGreaterThanOrEqual(2);
  });

  it("is deterministic: the same input twice gives the same JSON, and the input is not mutated", () => {
    const n = noisy(500);
    const copy = { x: Float64Array.from(n.x), y: Float64Array.from(n.y) };
    const a = JSON.stringify(convertOp(ID, n, DEFAULT_CONVERT, LINE_SYMBOL, 100));
    const b = JSON.stringify(convertOp(ID, n, DEFAULT_CONVERT, LINE_SYMBOL, 100));
    expect(a).toBe(b);
    expect(Array.from(n.x)).toEqual(Array.from(copy.x));
    expect(Array.from(n.y)).toEqual(Array.from(copy.y));
  });

  it("vertices rounding to the same unit are one; a track left with one coordinate is no op", () => {
    const tiny = line([[0, 0], [0.001, 0.001], [0.004, 0], [0.002, 0.002]]);
    expect(lineVertices(tiny, 100)).toEqual([{ x: 0, y: 0 }]);
    expect(convertOp(ID, tiny, { windowM: 0, toleranceMm: TOL_MIN_MM }, LINE_SYMBOL, 100)).toBeNull();
    expect(nodeCount(tiny, 100)).toBe(0);
    expect(lineVertices(line([[0, 0], [0.004, 0], [0.006, 0]]), 100)).toEqual([{ x: 0, y: 0 }, { x: 0.006, y: 0 }]);
  });

  it("points outside the map are converted like the others (§3.2)", () => {
    const op = convertOp(ID, line([[36, 20], [66, 20], [96, 20], [126, 20]]), { windowM: 0, toleranceMm: 0.1 }, LINE_SYMBOL, 100)!;
    expect(op.coords).toEqual([[3600, 2000], [12600, 2000]]);
  });
});

describe("a conversion: ops, marks, the change", () => {
  const simplified = convertLine(line(L_MM), { windowM: 0, toleranceMm: 0.1 });
  const ids = new Map([["t1", "0190a000-0000-7000-8000-000000000001"], ["t2", "0190a000-0000-7000-8000-000000000002"], ["t3", "0190a000-0000-7000-8000-000000000003"]]);

  it("one add per track in order, marks `add:<id>`, the previous marks for the undo, node counts; a degenerate track skipped", () => {
    const plan = planConversion([
      { id: "t1", convertedOp: null, simplified },
      { id: "t2", convertedOp: null, simplified: line([[0, 0], [0.001, 0]]) },
      { id: "t3", convertedOp: "add:0190a000-0000-7000-8000-0000000000ff", simplified },
    ], ids, LINE_SYMBOL, 100);
    expect(plan.ops.map((o) => o.id)).toEqual([ids.get("t1"), ids.get("t3")]);
    expect(plan.marks).toEqual([{ id: "t1", opId: `add:${ids.get("t1")}` }, { id: "t3", opId: `add:${ids.get("t3")}` }]);
    expect(plan.before).toEqual([{ id: "t1", opId: null }, { id: "t3", opId: "add:0190a000-0000-7000-8000-0000000000ff" }]);
    expect(plan.nodes).toEqual([{ id: "t1", count: 3 }, { id: "t3", count: 3 }]);
    expect(plan.skipped).toEqual(["t2"]);
  });

  it("an average's still-listed sources are marked with its op; the undo restores each one's mark before (§5.2, G27)", () => {
    const earlier = "add:0190a000-0000-7000-8000-0000000000ff";
    const plan = planConversion([
      { id: "t1", convertedOp: null, simplified, sources: [{ id: "p", convertedOp: null }, { id: "q", convertedOp: earlier }] },
    ], ids, LINE_SYMBOL, 100);
    const op = `add:${ids.get("t1")}`;
    expect(plan.ops).toHaveLength(1);
    expect(plan.marks).toEqual([{ id: "t1", opId: op }, { id: "p", opId: op }, { id: "q", opId: op }]);
    expect(plan.before).toEqual([{ id: "t1", opId: null }, { id: "p", opId: null }, { id: "q", opId: earlier }]);
    expect(plan.nodes).toEqual([{ id: "t1", count: 3 }]);
  });

  it("no id twice in one markConverted: a track converted in the batch keeps its own op; a source of two averages the later's", () => {
    const plan = planConversion([
      { id: "t1", convertedOp: null, simplified, sources: [{ id: "t3", convertedOp: null }, { id: "p", convertedOp: null }] },
      { id: "t3", convertedOp: null, simplified, sources: [{ id: "p", convertedOp: null }] },
    ], ids, LINE_SYMBOL, 100);
    const op1 = `add:${ids.get("t1")}`, op3 = `add:${ids.get("t3")}`;
    expect(plan.marks).toEqual([{ id: "t1", opId: op1 }, { id: "t3", opId: op3 }, { id: "p", opId: op3 }]);
    expect(plan.before).toEqual([{ id: "t1", opId: null }, { id: "t3", opId: null }, { id: "p", opId: null }]);
    // A skipped average marks no source.
    const skipped = planConversion([{ id: "t2", convertedOp: null, simplified: line([[0, 0], [0.001, 0]]), sources: [{ id: "p", convertedOp: null }] }], ids, LINE_SYMBOL, 100);
    expect(skipped.marks).toEqual([]);
    expect(skipped.before).toEqual([]);
  });

  it("the change puts the symbol on first use only, and applies over the document without an issue", () => {
    const pinned = pinnedDoc();
    // A library line the fixture's stack can draw (black): a ski track symbol follows the same rule on a map with green.
    const lineEntry = mapDocument.mapPalette(pinned, null)
      .flatMap((g) => g.headings.flatMap((h) => h.entries))
      .find((e) => e.kind === "line" && e.source === "library" && e.enabled)!;
    expect(lineEntry, "a materialisable library line on the fixture").toBeDefined();
    const put = symbolPut(pinned, null, lineEntry.ref);
    if (!put.ok) throw new Error("expected materialisable");
    const plan = planConversion([{ id: "t1", convertedOp: null, simplified }, { id: "t3", convertedOp: null, simplified }], ids, put.ref, 100);
    const change = conversionChange(put, plan.ops);
    expect(change.put).toHaveLength(2);
    expect(Object.keys(change.putSymbols ?? {})).toEqual([(put.ref as { patch: string }).patch]);
    const patch = patchOf(change.put!, change.putSymbols);
    const applied = mapDocument.applyPatch(pinned, patch);
    expect(applied.issues).toEqual([]);
    expect(applied.document.header.objects.count).toBe(pinned.header.objects.count + 2);
    // Once the patch holds the symbol, the next conversion puts none.
    const again = symbolPut(pinned, { ...patch, documentHash: HASH }, put.ref);
    if (!again.ok) throw new Error("expected ok");
    expect(conversionChange(again, plan.ops).putSymbols).toBeUndefined();
  });

  it("the node count: total, largest, and the warning only above 2000 nodes on one track (§6 answer 2)", () => {
    expect(nodeSummary([], 2000)).toEqual({ total: 0, largest: 0, over: false });
    expect(nodeSummary([{ count: 2000 }, { count: 1500 }], 2000)).toEqual({ total: 3500, largest: 2000, over: false });
    expect(nodeSummary([{ count: 3 }, { count: 2001 }], 2000)).toEqual({ total: 2004, largest: 2001, over: true });
  });

  it("add ids ascend in the tracks' order", () => {
    const m = mintAddIds(["a", "b", "c"], (now) => newAddId(now), 1_768_642_200_000);
    const v = [...m.values()];
    expect([...m.keys()]).toEqual(["a", "b", "c"]);
    expect([...v].sort()).toEqual(v);
    expect(new Set(v).size).toBe(3);
  });
});

describe("controls and per-device memory (§6 answer 3)", () => {
  it("defaults: smoothing 10 m, simplification 0.1 mm, no symbol the first time", () => {
    expect(parseStoredConvert(null)).toEqual({ windowM: SMOOTH_DEFAULT_M, toleranceMm: TOL_DEFAULT_MM, symbol: null });
    expect(parseStoredConvert("not json")).toEqual({ windowM: 10, toleranceMm: 0.1, symbol: null });
    expect(parseStoredConvert("[1,2]")).toEqual({ windowM: 10, toleranceMm: 0.1, symbol: null });
  });

  it("clamps to 0–30 m (whole metres) and 0.02–0.5 mm (0.01 mm)", () => {
    expect(clampSettings({ windowM: -5, toleranceMm: 0.001 })).toEqual({ windowM: 0, toleranceMm: 0.02 });
    expect(clampSettings({ windowM: 99, toleranceMm: 9 })).toEqual({ windowM: 30, toleranceMm: 0.5 });
    expect(clampSettings({ windowM: 12.4, toleranceMm: 0.234 })).toEqual({ windowM: 12, toleranceMm: 0.23 });
    expect(clampSettings({ windowM: Number.NaN })).toEqual(DEFAULT_CONVERT);
    const symbol = { key: "patch:ISSkiOM2019:801.1", documentHash: HASH, entry: "ISSkiOM2019:801.1" };
    expect(parseStoredConvert(JSON.stringify({ windowM: 0, toleranceMm: 0.3, symbol }))).toEqual({ windowM: 0, toleranceMm: 0.3, symbol });
    expect(parseStoredConvert(JSON.stringify({ symbol: { key: "doc:2", documentHash: HASH } })).symbol).toEqual({ key: "doc:2", documentHash: HASH, entry: null });
    expect(parseStoredConvert(JSON.stringify({ windowM: "x", symbol: { key: 3 } }))).toEqual({ ...DEFAULT_CONVERT, symbol: null });
  });

  const item = (over: Partial<mapDocument.PaletteItem>): mapDocument.PaletteItem => ({
    kind: "line", source: "library", ref: { patch: "ISSkiOM2019:801.1" }, canonicalId: "ISSkiOM2019:801.1", code: "801.1", name: "Track", objects: 0, enabled: true, ...over,
  });
  const group = (id: mapDocument.PaletteGroupId, library: mapDocument.PaletteGroup["library"], headings: [string, mapDocument.PaletteItem[]][]): mapDocument.PaletteGroup => ({
    id, library, headings: headings.map(([code, entries]) => ({ code, name: { en: code }, entries, search: code })),
  });

  it("a library entry is remembered by its id and found on any map, also as a matched document symbol", () => {
    const lib = item({});
    const s = rememberedOf(lib, HASH);
    expect(s).toEqual({ key: "patch:ISSkiOM2019:801.1", documentHash: HASH, entry: "ISSkiOM2019:801.1" });
    const other = [group("ISSkiOM2019", "ISSkiOM2019", [["801", [item({ source: "document", ref: { doc: 4 } })]]])];
    expect(resolveRemembered(other, s, OTHER)?.ref).toEqual({ doc: 4 });
    // Disabled (the map lacks the colour) or absent: nothing is chosen.
    expect(resolveRemembered([group("ISSkiOM2019", "ISSkiOM2019", [["801", [item({ enabled: false })]]])], s, OTHER)).toBeNull();
    expect(resolveRemembered([], s, OTHER)).toBeNull();
  });

  it("on its own document the very item picked comes back, not a sibling matched to the same entry", () => {
    const busy = item({ source: "document", ref: { doc: 1 }, objects: 40 });
    const picked = item({ source: "document", ref: { doc: 5 }, objects: 2 });
    const groups = [group("ISSkiOM2019", "ISSkiOM2019", [["801", [busy, picked]]])];
    const s = rememberedOf(picked, HASH);
    expect(resolveRemembered(groups, s, HASH)).toBe(picked);
    // Elsewhere the entry's first item.
    expect(resolveRemembered(groups, s, OTHER)).toBe(busy);
  });

  it("an unmatched document symbol is remembered only on its own document; a point or area is never resolved", () => {
    const own = item({ source: "document", ref: { doc: 2 }, canonicalId: null, code: "899" });
    const s = rememberedOf(own, HASH);
    expect(s).toEqual({ key: "doc:2", documentHash: HASH, entry: null });
    const groups = [group("other", null, [["899", [own]]])];
    expect(resolveRemembered(groups, s, HASH)).toBe(own);
    expect(resolveRemembered(groups, s, OTHER)).toBeNull();
    const area = item({ kind: "area", source: "document", ref: { doc: 2 }, canonicalId: null });
    expect(resolveRemembered([group("other", null, [["899", [area]]])], s, HASH)).toBeNull();
    expect(resolveRemembered(groups, null, HASH)).toBeNull();
  });

  it("the picker: the ski-O group first, its track headings (801–813) before its others; the rest in order", () => {
    const groups = [
      group("library", "ISOM2017-2", [["505", [item({ code: "505" })]]]),
      group("ISSkiOM2019", "ISSkiOM2019", [["301", [item({ code: "301.1" })]], ["801", [item({})]], ["813", [item({ code: "813.1" })]]]),
      group("other", null, [["999", [item({ code: "999" })]]]),
    ];
    const out = convertPalette(groups);
    expect(out.map((g) => g.id)).toEqual(["ISSkiOM2019", "library", "other"]);
    expect(out[0].headings.map((h) => h.code)).toEqual(["801", "813", "301"]);
    // A ski-O map: its own library group is the ski group.
    const ski = convertPalette([group("other", null, []), group("library", "ISSkiOM2019", [["310", []], ["802", []]])]);
    expect(ski.map((g) => g.id)).toEqual(["library", "other"]);
    expect(ski[0].headings.map((h) => h.code)).toEqual(["802", "310"]);
    // Not mutated.
    expect(groups[1].headings.map((h) => h.code)).toEqual(["301", "801", "813"]);
  });
});
