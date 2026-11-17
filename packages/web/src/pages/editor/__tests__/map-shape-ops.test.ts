import { describe, expect, it } from "vitest";
import { mapDocument, render } from "@oxygen/shared";
import { inverseChange, mapModelOf, objectInfo } from "../modes/map/model";
import { MAP_NODES_MAX } from "../modes/map/nodes";
import {
  balanceGaps, closeCoords, cutHoleChange, joinChange, joinCoords, lineShape, removeHoleChange, reverseChange, reverseCoords, snapEndsChange, splitChange,
  splitCoords,
} from "../modes/map/shape-ops";

type C = mapDocument.PatchCoord;
const T = mapDocument.OBJECT_TYPE;
const F = render.COORD_FLAG;
const HASH = "ab".repeat(32);
const ADD = "00000000-0000-7000-8000-000000000001";
const NEW = "00000000-0000-7000-8000-0000000000ff";
const colours = [{ id: "src:0", name: "Black", cmyk: [0, 0, 0, 1] as [number, number, number, number] }];

/**
 * 100 units per mm. Lines: 7 straight (3 nodes), 9 straight beside it (2 nodes, a different symbol), 13 with a broken
 * curve, 15 a closed loop (4 nodes + the repeat), 17 two parts; areas: 3 with a hole, 5 without.
 */
function pinned() {
  return mapDocument.decodeMapDocument(mapDocument.encodeMapDocument({
    header: {
      format: { version: 1, importer: "test-1" },
      source: { kind: "ocad", version: "2018.8.3", hash: "00".repeat(32), bytes: 1 },
      unitsPerMm: 100,
      mapScale: 15000,
      georeferencing: { crs: null, paperOrigin: null },
      colours,
      symbols: [
        { code: "403.0", name: "Area", kind: "area", render: { type: "area", id: "a", code: "403", name: "Area", fill: 0 } },
        { code: "505.0", name: "Path", kind: "line", render: { type: "line", id: "l", code: "505", name: "Path", main: { colour: 0, widthUm: 300 } } },
        { code: "506.0", name: "Track", kind: "line", render: { type: "line", id: "m", code: "506", name: "Track", main: { colour: 0, widthUm: 200 } } },
      ] as mapDocument.DocumentSymbolInput[],
    },
    objects: [
      { symbolIdx: 0, type: T.area, sourceIndex: 3, coords: [0, 0, 4000, 0, 4000, 4000, 0, 4000, 1000, 1000, 1500, 1000, 1500, 1500], flags: [0, 0, 0, 0, 16, 0, 0] },
      { symbolIdx: 0, type: T.area, sourceIndex: 5, coords: [5000, 0, 9000, 0, 9000, 4000], flags: [0, 0, 0] },
      { symbolIdx: 1, type: T.line, sourceIndex: 7, coords: [0, 2000, 2000, 2000, 4000, 2000], flags: [0, 0, 0] },
      { symbolIdx: 2, type: T.line, sourceIndex: 9, coords: [4030, 2000, 6000, 2000], flags: [0, 0] },
      { symbolIdx: 1, type: T.line, sourceIndex: 13, coords: [0, 0, 100, 100, 200, 0], flags: [0, 1, 0] },
      { symbolIdx: 1, type: T.line, sourceIndex: 15, coords: [0, 5000, 1000, 5000, 1000, 6000, 0, 6000, 0, 5000], flags: [0, 0, 0, 0, 0] },
      { symbolIdx: 1, type: T.line, sourceIndex: 17, coords: [0, 7000, 1000, 7000, 0, 8000, 1000, 8000], flags: [0, 0, 16, 0] },
    ],
  }));
}

const patchOf = (ops: mapDocument.PatchOp[]): mapDocument.MapPatch => mapDocument.mapPatchSchema.parse({
  documentHash: HASH, enabled: true, symbols: {}, ops: Object.fromEntries(ops.map((op) => [mapDocument.patchOpId(op), op])),
});
/** `change` applied to `patch` (as the server's `applyChange`, map-patches §3.2). */
function applied(patch: mapDocument.MapPatch | null, change: mapDocument.PatchChange): mapDocument.MapPatch {
  const ops = { ...(patch?.ops ?? {}) };
  for (const id of change.remove ?? []) delete ops[id];
  for (const op of change.put ?? []) ops[mapDocument.patchOpId(op)] = op;
  return mapDocument.mapPatchSchema.parse({ documentHash: HASH, enabled: true, symbols: patch?.symbols ?? {}, ops });
}
function changeOf(r: ReturnType<typeof reverseChange>): mapDocument.PatchChange {
  if (!r || !("change" in r)) throw new Error(`no change: ${JSON.stringify(r)}`);
  return r.change;
}
/** The change applies without an issue, and its inverse brings `before` back. */
function roundTrips(before: mapDocument.MapPatch | null, change: mapDocument.PatchChange) {
  const after = applied(before, change);
  expect(mapDocument.applyPatch(pinned(), after).issues).toEqual([]);
  const inverse = inverseChange(before, change)!;
  expect(applied(after, inverse).ops).toEqual(before?.ops ?? {});
}

const flagsOf = (c: C) => c[2] ?? 0;
const measure = (coords: readonly C[]) => new render.PathMeasure(render.makePath(coords.flatMap((c) => [c[0], c[1]]), coords.map(flagsOf)));
/** The gaps drawn on a path, as length intervals (the renderer's `gapIntervals`). */
const gaps = (coords: readonly C[]) => render.gapIntervals(measure(coords));
/** The length intervals a border bit suppresses (the symboliser's rule: an anchor's bit up to the next anchor). */
function sides(coords: readonly C[], bit: number): [number, number][] {
  const m = measure(coords);
  const out: [number, number][] = [];
  for (let i = 0; i < m.segments.length; i++) if (flagsOf(coords[m.segmentStartPoint[i]]) & bit) out.push([m.cumulative[i], m.cumulative[i + 1]]);
  return out;
}
const mirror = (iv: [number, number][], L: number) => iv.map(([a, b]): [number, number] => [L - b, L - a]).sort((x, y) => x[0] - y[0]);
const close = (a: [number, number][], b: [number, number][]) => {
  expect(a.length).toBe(b.length);
  a.forEach((x, k) => { expect(x[0]).toBeCloseTo(b[k][0], 6); expect(x[1]).toBeCloseTo(b[k][1], 6); });
};

/** A straight line with a gap pair (1→3), noLeft on segment 0→1, noRight on 2→3, a dash at 2 and a corner at 1. */
const FLAGGED: C[] = [[0, 0, F.noLeft], [100, 0, F.corner | F.gap], [200, 0, F.dash], [300, 0, F.gap | F.noRight], [400, 0]];
/** A curve: anchor, control, control, anchor, then a straight segment; noLeft on the curve, a control's own noRight. */
const CURVED: C[] = [[0, 0, F.noLeft], [0, 100, F.bezierFirst | F.noRight], [100, 100, F.bezierSecond], [100, 0], [200, 0]];

describe("Map mode's line operations: reverse (docs/course-editor.md §13 \"Line and area operations\")", () => {
  it("reverses the points; corner, dash and gap stay on their node, noLeft / noRight move to the segment's other end swapped", () => {
    const r = reverseCoords(FLAGGED);
    expect(r).toEqual([[400, 0, F.noLeft], [300, 0, F.gap], [200, 0, F.dash], [100, 0, F.corner | F.gap | F.noRight], [0, 0]]);
    const L = measure(FLAGGED).totalLength;
    close(gaps(r), mirror(gaps(FLAGGED), L));
    // Left of the reversed direction is right of the old one.
    close(sides(r, F.noRight), mirror(sides(FLAGGED, F.noLeft), L));
    close(sides(r, F.noLeft), mirror(sides(FLAGGED, F.noRight), L));
  });

  it("a curve's controls swap roles with their own bits; reversing twice is the identity", () => {
    const r = reverseCoords(CURVED);
    expect(r).toEqual([[200, 0], [100, 0, F.noRight], [100, 100, F.bezierFirst], [0, 100, F.bezierSecond | F.noLeft], [0, 0]]);
    expect(reverseCoords(r)).toEqual(CURVED);
    expect(reverseCoords(reverseCoords(FLAGGED))).toEqual(FLAGGED);
  });

  it("balances an unpaired gap first, so the drawing stays the same", () => {
    // Gaps at 1, 2 and 3: 1→2 is drawn, 3 opens one that never closes.
    const odd: C[] = [[0, 0], [100, 0, F.gap], [200, 0, F.gap], [300, 0, F.gap], [400, 0]];
    expect(gaps(odd)).toEqual([[100, 200]]);
    expect(balanceGaps(odd)[3]).toEqual([300, 0]);
    close(gaps(reverseCoords(odd)), mirror(gaps(odd), 400));
    // A flagged last point that closes nothing is dropped.
    const lastOnly: C[] = [[0, 0, F.gap], [100, 0, F.gap], [200, 0, F.gap]];
    expect(balanceGaps(lastOnly)).toEqual([[0, 0, F.gap], [100, 0, F.gap], [200, 0]]);
  });

  it("a loop keeps its start node; a two-part line reverses each part in its place", () => {
    const loop: C[] = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
    expect(reverseCoords(loop)).toEqual([[0, 0], [0, 100], [100, 100], [100, 0], [0, 0]]);
    const two: C[] = [[0, 0], [100, 0], [0, 100, F.hole], [100, 100]];
    expect(reverseCoords(two)).toEqual([[100, 0], [0, 0], [100, 100, F.hole], [0, 100]]);
  });

  it("is one modify (an added line's add rewritten) whose inverse puts back what was there", () => {
    const m = mapModelOf(HASH, pinned(), null);
    const change = changeOf(reverseChange(m, null, { source: 7 }));
    expect(change).toEqual({ put: [{ op: "modify", sourceIndex: 7, coords: [[4000, 2000], [2000, 2000], [0, 2000]] }] });
    roundTrips(null, change);
    const moved = patchOf([{ op: "modify", sourceIndex: 7, coords: [[0, 2100], [4000, 2100]], angle: 0 }]);
    const m2 = mapModelOf(HASH, pinned(), moved);
    roundTrips(moved, changeOf(reverseChange(m2, moved, { source: 7 })));
    const added = patchOf([{ op: "add", id: ADD, type: 2, symbol: { doc: 1 }, coords: [[0, 0], [500, 0]] }]);
    const m3 = mapModelOf(HASH, pinned(), added);
    expect(changeOf(reverseChange(m3, added, { added: ADD }))).toEqual({ put: [{ op: "add", id: ADD, type: 2, symbol: { doc: 1 }, coords: [[500, 0], [0, 0]] }] });
  });

  it("refuses an area, a point and a broken curve encoding", () => {
    const m = mapModelOf(HASH, pinned(), null);
    expect(reverseChange(m, null, { source: 3 })).toEqual({ reason: "kind" });
    expect(reverseChange(m, null, { source: 13 })).toEqual({ reason: "encoding" });
    expect(lineShape(m, { source: 99 })).toBeNull();
  });
});

describe("Map mode's line operations: split (§13 answer 4)", () => {
  it("cuts an open line at an interior node: the head from the start keeps the node, the tail starts on it", () => {
    expect(splitCoords(FLAGGED, 2, false)).toEqual({
      head: [[0, 0, F.noLeft], [100, 0, F.corner | F.gap], [200, 0, F.dash | F.gap]],
      tail: [[200, 0, F.dash | F.gap], [300, 0, F.gap | F.noRight], [400, 0]],
    });
    // The gap 1→3 is drawn in both parts where it was.
    const r = splitCoords(FLAGGED, 2, false) as { head: C[]; tail: C[] };
    expect([...gaps(r.head), ...gaps(r.tail).map(([a, b]) => [a + 200, b + 200])]).toEqual([[100, 200], [200, 300]]);
  });

  it("a curve's controls stay with their segment; an end node and out of range split nothing", () => {
    const r = splitCoords(CURVED, 1, false) as { head: C[]; tail: C[] };
    expect(r.head).toEqual(CURVED.slice(0, 4));
    expect(r.tail).toEqual([[100, 0], [200, 0]]);
    expect(splitCoords(CURVED, 0, false)).toBeNull();
    expect(splitCoords(CURVED, 2, false)).toBeNull();
    expect(splitCoords(CURVED, 7, false)).toBeNull();
  });

  it("a loop opens at the node as one object: its coordinates start and end there, the old start a node again", () => {
    const loop: C[] = [[0, 0, F.noLeft], [100, 0], [100, 100], [0, 100], [0, 0]];
    expect(splitCoords(loop, 2, true)).toEqual({ opened: [[100, 100], [0, 100], [0, 0, F.noLeft], [100, 0], [100, 100]] });
    expect(splitCoords(loop, 0, true)).toBeNull();
  });

  it("keeps the start part as the object and adds the rest with the effective symbol, one change", () => {
    const m = mapModelOf(HASH, pinned(), null);
    const change = changeOf(splitChange(m, null, { source: 7 }, 1, NEW));
    expect(change).toEqual({ put: [
      { op: "modify", sourceIndex: 7, coords: [[0, 2000], [2000, 2000]] },
      { op: "add", id: NEW, type: 2, symbol: { doc: 1 }, coords: [[2000, 2000], [4000, 2000]] },
    ] });
    roundTrips(null, change);
    // After a resymbol the tail has the object's symbol as it is drawn.
    const resym = patchOf([{ op: "resymbol", sourceIndex: 7, symbol: { doc: 2 } }]);
    const m2 = mapModelOf(HASH, pinned(), resym);
    expect(objectInfo(m2, { source: 7 }, "en")?.symbol).toEqual({ doc: 2 });
    const c2 = changeOf(splitChange(m2, resym, { source: 7 }, 1, NEW));
    expect(c2.put?.[1]).toMatchObject({ op: "add", symbol: { doc: 2 } });
    roundTrips(resym, c2);
  });

  it("an added line's add is rewritten; the loop's split is one modify", () => {
    const added = patchOf([{ op: "add", id: ADD, type: 2, symbol: { doc: 1 }, coords: [[0, 0], [500, 0], [1000, 0]] }]);
    const m = mapModelOf(HASH, pinned(), added);
    const change = changeOf(splitChange(m, added, { added: ADD }, 1, NEW));
    expect(change.put?.map((o) => (o.op === "add" ? [o.id, o.coords] : null))).toEqual([[ADD, [[0, 0], [500, 0]]], [NEW, [[500, 0], [1000, 0]]]]);
    roundTrips(added, change);
    const m0 = mapModelOf(HASH, pinned(), null);
    expect(changeOf(splitChange(m0, null, { source: 15 }, 1, NEW))).toEqual({ put: [
      { op: "modify", sourceIndex: 15, coords: [[1000, 5000], [1000, 6000], [0, 6000], [0, 5000], [1000, 5000]] },
    ] });
  });

  it("says why it does not apply: no node, an end node, a multi-part line, a broken encoding", () => {
    const m = mapModelOf(HASH, pinned(), null);
    expect(splitChange(m, null, { source: 7 }, null, NEW)).toEqual({ reason: "no-node" });
    expect(splitChange(m, null, { source: 7 }, 2, NEW)).toEqual({ reason: "end-node" });
    expect(splitChange(m, null, { source: 17 }, 1, NEW)).toEqual({ reason: "multi-part" });
    expect(splitChange(m, null, { source: 13 }, 1, NEW)).toEqual({ reason: "encoding" });
    expect(splitChange(m, null, { source: 3 }, 1, NEW)).toEqual({ reason: "kind" });
  });
});

describe("Map mode's line operations: join (§13 answers 1–3, 8)", () => {
  const a: C[] = [[0, 0], [1000, 0]];
  it("joins the nearest pair of ends, the survivor's direction kept and the other reversed where needed", () => {
    // a's end to b's start; b's end; a's start to b's end; b's start.
    expect(joinCoords(a, [[1000, 0], [1000, 500]], 100)).toEqual([[0, 0], [1000, 0], [1000, 500]]);
    expect(joinCoords(a, [[1000, 500], [1000, 0]], 100)).toEqual([[0, 0], [1000, 0], [1000, 500]]);
    expect(joinCoords(a, [[0, 500], [0, 0]], 100)).toEqual([[0, 500], [0, 0], [1000, 0]]);
    expect(joinCoords(a, [[0, 0], [0, 500]], 100)).toEqual([[0, 500], [0, 0], [1000, 0]]);
  });

  it("ends within 0.5 mm become one node at the survivor's end; farther apart a straight segment joins them", () => {
    expect(joinCoords(a, [[1050, 0], [2000, 0]], 100)).toEqual([[0, 0], [1000, 0], [2000, 0]]);
    expect(joinCoords(a, [[1051, 0], [2000, 0]], 100)).toEqual([[0, 0], [1000, 0], [1051, 0], [2000, 0]]);
    // At any distance.
    expect(joinCoords(a, [[9000, 0], [9500, 0]], 100)).toEqual([[0, 0], [1000, 0], [9000, 0], [9500, 0]]);
  });

  it("the merged node keeps the survivor's corner / dash and the next segment's border bits; a pair of gap toggles cancels", () => {
    const g: C[] = [[0, 0], [500, 0, F.gap], [1000, 0, F.gap | F.dash | F.noLeft]];
    const h: C[] = [[1000, 0, F.gap | F.noRight], [1500, 0, F.gap], [2000, 0]];
    const j = joinCoords(g, h, 100);
    expect(j).toEqual([[0, 0], [500, 0, F.gap], [1000, 0, F.dash | F.noRight], [1500, 0, F.gap], [2000, 0]]);
    expect(gaps(j)).toEqual([[500, 1500]]);
    // A bridge keeps both ends: the gap closes and opens again; the survivor's last border bits are cleared.
    const far = joinCoords(g, h.map((c): C => [c[0] + 1000, c[1], ...(c.length === 3 ? [c[2]] : [])] as C), 100);
    expect(far[2]).toEqual([1000, 0, F.gap | F.dash]);
    expect(gaps(far)).toEqual([[500, 1000], [2000, 2500]]);
  });

  it("a curve at the joined end keeps its controls", () => {
    const curve: C[] = [[0, 0], [0, 100, F.bezierFirst], [100, 100, F.bezierSecond], [1000, 0]];
    expect(joinCoords(curve, [[1000, 0], [2000, 0]], 100)).toEqual([...curve, [2000, 0]]);
  });

  it("closes a line picked on itself: the last point onto the first within 0.5 mm (4 nodes), else a segment back (3)", () => {
    expect(closeCoords([[0, 0], [100, 0], [100, 100], [0, 40]], 100)).toEqual([[0, 0], [100, 0], [100, 100], [0, 0]]);
    expect(closeCoords([[0, 0], [100, 0], [100, 100], [0, 100]], 100)).toEqual([[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]);
    expect(closeCoords([[0, 0], [100, 0], [0, 40]], 100)).toBeNull();
    expect(closeCoords([[0, 0], [100, 0]], 100)).toBeNull();
  });

  it("the survivor's modify and the picked document line's hide in one change; the inverse undoes both", () => {
    const m = mapModelOf(HASH, pinned(), null);
    const change = changeOf(joinChange(m, null, { source: 7 }, { source: 9 }));
    // 0.3 mm apart: merged; the different symbol is allowed, the survivor's kept.
    expect(change).toEqual({ put: [
      { op: "modify", sourceIndex: 7, coords: [[0, 2000], [2000, 2000], [4000, 2000], [6000, 2000]] },
      { op: "hide", sourceIndex: 9 },
    ] });
    roundTrips(null, change);
    // The two ops revert separately (answer 8): each is a row of its own.
    const after = applied(null, change);
    expect(Object.keys(after.ops).sort()).toEqual(["hide:9", "modify:7"]);
  });

  it("a picked added line's add is removed; an added survivor's add is rewritten", () => {
    const added = patchOf([{ op: "add", id: ADD, type: 2, symbol: { doc: 1 }, coords: [[6000, 2000], [7000, 2000]] }]);
    const m = mapModelOf(HASH, pinned(), added);
    const change = changeOf(joinChange(m, added, { source: 9 }, { added: ADD }));
    expect(change).toEqual({ put: [{ op: "modify", sourceIndex: 9, coords: [[4030, 2000], [6000, 2000], [7000, 2000]] }], remove: [`add:${ADD}`] });
    roundTrips(added, change);
    const back = changeOf(joinChange(m, added, { added: ADD }, { source: 9 }));
    expect(back.put?.[0]).toEqual({ op: "add", id: ADD, type: 2, symbol: { doc: 1 }, coords: [[4030, 2000], [6000, 2000], [7000, 2000]] });
    expect(back.put?.[1]).toEqual({ op: "hide", sourceIndex: 9 });
    roundTrips(added, back);
  });

  it("closes the selection picked on itself; refuses a loop, an area, a multi-part line and a result over the node cap", () => {
    const m = mapModelOf(HASH, pinned(), null);
    expect(changeOf(joinChange(m, null, { source: 7 }, { source: 7 })).put?.[0]).toMatchObject({ coords: [[0, 2000], [2000, 2000], [4000, 2000], [0, 2000]] });
    expect(joinChange(m, null, { source: 15 }, { source: 7 })).toEqual({ reason: "closed" });
    expect(joinChange(m, null, { source: 7 }, { source: 15 })).toEqual({ reason: "closed" });
    expect(joinChange(m, null, { source: 7 }, { source: 3 })).toEqual({ reason: "not-line" });
    expect(joinChange(m, null, { source: 7 }, { source: 17 })).toEqual({ reason: "multi-part" });
    expect(joinChange(m, null, { source: 9 }, { source: 13 })).toEqual({ reason: "encoding" });
    const long = Array.from({ length: MAP_NODES_MAX - 1 }, (_, k): C => [k * 10, 9000]);
    const big = patchOf([{ op: "add", id: ADD, type: 2, symbol: { doc: 1 }, coords: long }]);
    const m2 = mapModelOf(HASH, pinned(), big);
    expect(joinChange(m2, big, { added: ADD }, { source: 7 })).toEqual({ reason: "too-many" });
    // Counted on the result: 1999 + 2 merged at the shared end is exactly 2000, still joined.
    const merging = patchOf([{ op: "add", id: ADD, type: 2, symbol: { doc: 1 }, coords: [...Array.from({ length: MAP_NODES_MAX - 2 }, (_, k): C => [k * 10, 9000]), [6000, 2000]] }]);
    const m3 = mapModelOf(HASH, pinned(), merging);
    const joined = changeOf(joinChange(m3, merging, { added: ADD }, { source: 9 })).put?.[0];
    expect(joined && joined.op === "add" ? joined.coords.length : -1).toBe(MAP_NODES_MAX);
    // A line of two nodes picked on itself is too short to close.
    expect(joinChange(m, null, { source: 9 }, { source: 9 })).toEqual({ reason: "too-few" });
  });
});

describe("Map mode's area operations: holes (§13 answers 5–6)", () => {
  it("cut hole: the drawn ring appended, its first point flagged hole and repeated at the end; the rest byte-identical", () => {
    const m = mapModelOf(HASH, pinned(), null);
    const change = changeOf(cutHoleChange(m, null, { source: 5 }, [{ x: 70, y: 5 }, { x: 80, y: 5 }, { x: 80, y: 15 }]));
    expect(change).toEqual({ put: [{ op: "modify", sourceIndex: 5, coords: [[5000, 0], [9000, 0], [9000, 4000], [7000, 500, F.hole], [8000, 500], [8000, 1500], [7000, 500]] }] });
    roundTrips(null, change);
    // As drawn: a ring outside the outline is accepted (even-odd, answer 6).
    expect(cutHoleChange(m, null, { source: 5 }, [{ x: 0, y: 50 }, { x: 10, y: 50 }, { x: 10, y: 60 }])).toHaveProperty("change");
    expect(cutHoleChange(m, null, { source: 7 }, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])).toEqual({ reason: "kind" });
    expect(cutHoleChange(m, null, { source: 5 }, [{ x: 0, y: 0 }, { x: 1, y: 0 }])).toEqual({ reason: "too-few" });
    // A ring that takes an area within the node cap over it is refused.
    const outline = Array.from({ length: MAP_NODES_MAX - 1 }, (_, k): C => [Math.round(1000 * Math.cos(k / 300)), Math.round(1000 * Math.sin(k / 300))]);
    const big = patchOf([{ op: "add", id: ADD, type: 3, symbol: { doc: 0 }, coords: [...outline, outline[0]] }]);
    const m2 = mapModelOf(HASH, pinned(), big);
    expect(cutHoleChange(m2, big, { added: ADD }, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])).toEqual({ reason: "too-many" });
  });

  it("remove hole: the ring of the focused node dropped, the outline untouched; ring 0 or none is refused", () => {
    const m = mapModelOf(HASH, pinned(), null);
    const change = changeOf(removeHoleChange(m, null, { source: 3 }, 1));
    expect(change).toEqual({ put: [{ op: "modify", sourceIndex: 3, coords: [[0, 0], [4000, 0], [4000, 4000], [0, 4000]] }] });
    roundTrips(null, change);
    expect(removeHoleChange(m, null, { source: 3 }, 0)).toEqual({ reason: "no-hole-node" });
    expect(removeHoleChange(m, null, { source: 3 }, null)).toEqual({ reason: "no-hole-node" });
    expect(removeHoleChange(m, null, { source: 5 }, 1)).toEqual({ reason: "no-hole-node" });
  });

  it("a cut hole removed again is the area as it was; holes after it keep their flag", () => {
    const m = mapModelOf(HASH, pinned(), null);
    const cut = changeOf(cutHoleChange(m, null, { source: 3 }, [{ x: 30, y: 30 }, { x: 35, y: 30 }, { x: 35, y: 35 }]));
    const p = applied(null, cut);
    const m2 = mapModelOf(HASH, pinned(), p);
    const first = changeOf(removeHoleChange(m2, p, { source: 3 }, 1));
    const op = first.put?.[0];
    expect(op && op.op === "modify" ? op.coords.filter((c) => flagsOf(c) & F.hole).length : -1).toBe(1);
    const second = changeOf(removeHoleChange(m2, p, { source: 3 }, 2));
    expect(second.put?.[0]).toMatchObject({ coords: [[0, 0], [4000, 0], [4000, 4000], [0, 4000], [1000, 1000, F.hole], [1500, 1000], [1500, 1500]] });
  });
});

describe("Snap ends on an added line (§13 \"GPS tracks: junctions\"; row G28)", () => {
  const SKI = { patch: "ISSkiOM2019:801.1" } as const;
  const TRK = "00000000-0000-7000-8000-0000000000a1";
  const skiSymbol = {
    code: "801.1", name: "Very wide track", kind: "line", origin: "source", hidden: false,
    render: { type: "line", id: "ISSkiOM2019:801.1", code: "801.1", name: "Very wide track", main: { colour: 0, widthUm: 850 } },
  } as mapDocument.PatchSymbol;
  /** The selection `ADD` (801.1) of `coords`, and a track line `TRK` along y = 10 mm from x = 60 to 90 mm. */
  const withLine = (coords: C[]) => mapDocument.mapPatchSchema.parse({
    documentHash: HASH, enabled: true, symbols: { "ISSkiOM2019:801.1": skiSymbol },
    ops: {
      [`add:${ADD}`]: { op: "add", id: ADD, type: T.line, symbol: SKI, coords },
      [`add:${TRK}`]: { op: "add", id: TRK, type: T.line, symbol: SKI, coords: [[6000, 1000], [9000, 1000]] },
    },
  });

  it("moves an end 1 mm short onto the track line: the add rewritten as the only op, the track untouched; the inverse restores it", () => {
    const patch = withLine([[7000, 3000], [7000, 1100]]);
    const change = changeOf(snapEndsChange(mapModelOf(HASH, pinned(), patch), patch, { added: ADD }));
    expect(change.put).toEqual([{ op: "add", id: ADD, type: T.line, symbol: SKI, coords: [[7000, 3000], [7000, 1000]] }]);
    expect(change.remove).toBeUndefined();
    roundTrips(patch, change);
  });

  it("the line is never its own target; paths (the document's 505 / 506 lines) are none either", () => {
    // Its end is near only itself and the document's 505 path (y = 20 mm): nothing to snap to.
    const patch = withLine([[1000, 4000], [1000, 2100]]);
    expect(snapEndsChange(mapModelOf(HASH, pinned(), patch), patch, { added: ADD })).toEqual({ reason: "no-target" });
  });

  it("refuses a loop and a multi-part line; offers nothing on a document line", () => {
    const loop = withLine([[6500, 1100], [7500, 1100], [7500, 2000], [6500, 2000], [6500, 1100]]);
    expect(snapEndsChange(mapModelOf(HASH, pinned(), loop), loop, { added: ADD })).toEqual({ reason: "closed" });
    const multi = withLine([[7000, 3000], [7000, 1100], [8000, 3000, F.hole], [8000, 1100]]);
    expect(snapEndsChange(mapModelOf(HASH, pinned(), multi), multi, { added: ADD })).toEqual({ reason: "multi-part" });
    const patch = withLine([[7000, 3000], [7000, 1100]]);
    expect(snapEndsChange(mapModelOf(HASH, pinned(), patch), patch, { source: 7 })).toBeNull();
  });
});
