import { describe, expect, it, vi } from "vitest";
import { mapDocument } from "@oxygen/shared";
import { HANDLE_PX, MAP_HIT_PX, mapNodesBinding, withTrackLayer, type MapNodeRing, type MapNodesContext } from "../tools/bindings";
import { mapModelOf } from "../modes/map/model";
import { MAP_NODES_MAX, nodeSnapIndex, nodesOf, nodesOp, ringRule, withRing } from "../modes/map/nodes";
import type { ToolPointer, ToolShape } from "../../../components/MapViewer";
import type { MapObjectRef } from "../../../map-gl/worker";

const T = mapDocument.OBJECT_TYPE;
const HASH = "ab".repeat(32);
const ADD = "00000000-0000-7000-8000-000000000001";
const colours = [{ id: "src:0", name: "Black", cmyk: [0, 0, 0, 1] as [number, number, number, number] }];

/**
 * 100 units per mm: an area with a hole (source 3), a straight line (7), a curved line with a dash flag (9), a point
 * (11), a line with a broken curve (13), a line beside the straight one (15).
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
        { code: "418.0", name: "Tree", kind: "point", render: { type: "point", id: "p", code: "418", name: "Tree", glyph: { parts: [{ kind: "disc", colour: 0, diameterUm: 500 }], rotatable: false }, orientation: "north" } },
      ] as mapDocument.DocumentSymbolInput[],
    },
    objects: [
      { symbolIdx: 0, type: T.area, sourceIndex: 3, coords: [0, 0, 4000, 0, 4000, 4000, 0, 4000, 1000, 1000, 1500, 1000, 1500, 1500], flags: [0, 0, 0, 0, 16, 0, 0] },
      { symbolIdx: 1, type: T.line, sourceIndex: 7, coords: [0, 2000, 2000, 2000, 4000, 2000], flags: [0, 0, 0] },
      { symbolIdx: 1, type: T.line, sourceIndex: 9, coords: [0, 3000, 0, 3500, 1000, 3500, 1000, 3000], flags: [8, 1, 2, 0] },
      { symbolIdx: 2, type: T.point, sourceIndex: 11, coords: [500, 500], flags: [0] },
      { symbolIdx: 1, type: T.line, sourceIndex: 13, coords: [0, 0, 100, 100, 200, 0], flags: [0, 1, 0] },
      { symbolIdx: 1, type: T.line, sourceIndex: 15, coords: [0, 2030, 4000, 2030], flags: [0, 0] },
    ],
  }));
}

const patchOf = (ops: mapDocument.PatchOp[]): mapDocument.MapPatch => mapDocument.mapPatchSchema.parse({
  documentHash: HASH, enabled: true, symbols: {}, ops: Object.fromEntries(ops.map((op) => [mapDocument.patchOpId(op), op])),
});
const ON = { canEdit: true, correctionsOn: true };
const pathOf = (m: ReturnType<typeof mapModelOf>, ref: MapObjectRef) => {
  const r = nodesOf(m, ref, ON);
  if (!r || !("path" in r)) throw new Error("no nodes");
  return r.path;
};

describe("Map mode's nodes model (docs/course-editor.md §13 \"Nodes\")", () => {
  it("a line's and an area's rings in paper mm, the hole a ring of its own; the curve's controls as handles", () => {
    const m = mapModelOf(HASH, pinned(), null);
    const area = pathOf(m, { source: 3 });
    expect(area.area).toBe(true);
    expect(area.rings.map((r) => [r.closed, r.vertices.length])).toEqual([[true, 4], [true, 3]]);
    const curve = pathOf(m, { source: 9 });
    expect(curve.rings[0].vertices).toEqual([{ x: 0, y: 30, flags: 8, hOut: { x: 0, y: 5 } }, { x: 10, y: 30, hIn: { x: 0, y: 5 } }]);
  });

  it("why there are no nodes: a point, a hidden object, a broken curve, no courses.edit, corrections off, too many", () => {
    const m = mapModelOf(HASH, pinned(), null);
    expect(nodesOf(m, { source: 11 }, ON)).toEqual({ reason: "kind" });
    expect(nodesOf(m, { source: 13 }, ON)).toEqual({ reason: "encoding" });
    expect(nodesOf(m, { source: 7 }, { canEdit: false, correctionsOn: true })).toEqual({ reason: "read-only" });
    expect(nodesOf(m, { source: 7 }, { canEdit: true, correctionsOn: false })).toEqual({ reason: "disabled" });
    expect(nodesOf(mapModelOf(HASH, pinned(), patchOf([{ op: "hide", sourceIndex: 7 }])), { source: 7 }, ON)).toEqual({ reason: "hidden" });
    const many = Array.from({ length: MAP_NODES_MAX + 1 }, (_, k): mapDocument.PatchCoord => [k, 0]);
    expect(nodesOf(m, { source: 7 }, { ...ON, coords: many })).toEqual({ reason: "too-many" });
    expect(nodesOf(m, { source: 7 }, { ...ON, coords: many.slice(0, MAP_NODES_MAX) })).toHaveProperty("path");
    expect(nodesOf(m, { source: 99 }, ON)).toBeNull();
  });

  it("the draft's coordinates win, so the handles follow a drag", () => {
    const m = mapModelOf(HASH, pinned(), null);
    const r = nodesOf(m, { source: 7 }, { ...ON, coords: [[0, 0], [100, 0]] });
    expect(r && "path" in r && r.path.rings[0].vertices).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  });

  it("a node edit is one modify of every ring, the hole flag on the hole's first point, an existing angle kept", () => {
    const p = patchOf([{ op: "modify", sourceIndex: 3, coords: [[0, 0], [4000, 0], [4000, 4000], [0, 4000], [1000, 1000, 16], [1500, 1000], [1500, 1500]], angle: 90 }]);
    const m = mapModelOf(HASH, pinned(), p);
    const path = pathOf(m, { source: 3 });
    const moved = withRing(path, 1, path.rings[1].vertices.map((v, i) => (i === 0 ? { ...v, x: 11 } : v)));
    expect(nodesOp(m, p, moved)).toEqual({
      op: "modify", sourceIndex: 3, angle: 90,
      coords: [[0, 0], [4000, 0], [4000, 4000], [0, 4000], [1100, 1000, 16], [1500, 1000], [1500, 1500]],
    });
    // Nothing changed (a drag that rounds away): no op.
    expect(nodesOp(m, p, withRing(path, 0, path.rings[0].vertices.map((v) => ({ ...v, x: v.x + 0.001 }))))).toBeNull();
  });

  it("an added object's node edit rewrites its add", () => {
    const add: mapDocument.PatchOp = { op: "add", id: ADD, type: 2, symbol: { doc: 1 }, coords: [[100, 100], [200, 100]] };
    const p = patchOf([add]);
    const m = mapModelOf(HASH, pinned(), p);
    const path = pathOf(m, { added: ADD });
    expect(nodesOp(m, p, withRing(path, 0, [path.rings[0].vertices[0], { x: 3, y: 1 }]))).toEqual({ ...add, coords: [[100, 100], [300, 100]] });
  });

  it("a ring allows down to 2 nodes open, 3 closed", () => {
    expect(ringRule({ closed: false })).toMatchObject({ min: 2, curves: true, closed: false, max: Infinity });
    expect(ringRule({ closed: true })).toMatchObject({ min: 3, closed: true });
  });

  it("node snapping leaves the edited object out: its own vertices are no candidates, a neighbour's are", () => {
    const m = mapModelOf(HASH, pinned(), null);
    const index = nodeSnapIndex(m, { source: 7 })!;
    // Line 7's middle vertex (20, 20) is gone; line 15's end (40, 20.3) is near (40, 20).
    expect(index.nearest({ x: 20, y: 20.1 })).toBeNull();
    expect(index.nearest({ x: 40, y: 20.1 })).toEqual({ x: 40, y: 20.3 });
    expect(nodeSnapIndex(m, { source: 99 })).toBeNull();
  });
});

const ptr = (x: number, y: number, extra: Partial<ToolPointer> = {}): ToolPointer => ({ pt: { x, y }, target: null, shift: false, mmPerPx: 0.1, ...extra });
const flush = () => new Promise((r) => setTimeout(r, 0));
const OPEN: MapNodeRing = { vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], closed: false };
const HOLE: MapNodeRing = { vertices: [{ x: 50, y: 50 }, { x: 60, y: 50 }, { x: 60, y: 60, hIn: { x: 0, y: -2 }, hOut: { x: 0, y: 2 } }], closed: true };

function context(over: Partial<MapNodesContext> = {}): MapNodesContext {
  return {
    hit: vi.fn(async () => [{ ref: { source: 4 } as MapObjectRef }]),
    clickSeq: { current: 0 },
    onSelect: vi.fn(),
    rings: [OPEN, HOLE],
    canPress: true,
    focus: null,
    gesture: { current: null },
    snap: null,
    onDraft: vi.fn(),
    onCommit: vi.fn(),
    onCancel: vi.fn(),
    onFocus: vi.fn(),
    ...over,
  };
}
const byTest = (shapes: readonly ToolShape[] | undefined, id: string) =>
  (shapes ?? []).filter((s) => s.testId === id) as (ToolShape & { data?: Record<string, string> })[];

describe("Map mode's N (docs/course-editor.md §13 \"Nodes\")", () => {
  it("is exclusive and draws a node per vertex over every ring, the focused one marked, a grip per handle", () => {
    const b = mapNodesBinding(context({ focus: { ring: 1, index: 2 } }));
    expect(b.exclusive).toBe(true);
    const nodes = byTest(b.shapes, "editor-map-node");
    expect(nodes.map((s) => s.data)).toEqual([
      { index: "0", ring: "0", focused: "false" }, { index: "1", ring: "0", focused: "false" }, { index: "2", ring: "0", focused: "false" },
      { index: "0", ring: "1", focused: "false" }, { index: "1", ring: "1", focused: "false" }, { index: "2", ring: "1", focused: "true" },
    ]);
    expect(byTest(b.shapes, "editor-map-node-grip").map((s) => s.data)).toEqual([
      { index: "2", which: "in", ring: "1" }, { index: "2", which: "out", ring: "1" },
    ]);
    expect(mapNodesBinding(context({ rings: null })).shapes).toEqual([]);
  });

  it("a node drag past 3 px drafts its ring and writes once on release, the node focused; the placed point returned", () => {
    const c = context();
    const b = mapNodesBinding(c);
    expect(b.onPointerDown!(ptr(10.2, 0))).toBe(true);
    expect(b.onPointerDrag!({ x: 10.3, y: 0.1 })).toBeUndefined(); // within 3 px
    expect(c.onDraft).not.toHaveBeenCalled();
    expect(b.onPointerDrag!({ x: 11.2, y: 1 })).toEqual({ x: 11, y: 1 });
    expect(c.onDraft).toHaveBeenLastCalledWith(0, [{ x: 0, y: 0 }, { x: 11, y: 1 }, { x: 20, y: 0 }]);
    b.onPointerUp!({ x: 12.2, y: 1 });
    expect(c.onCommit).toHaveBeenCalledTimes(1);
    expect(c.onCommit).toHaveBeenCalledWith(0, [{ x: 0, y: 0 }, { x: 12, y: 1 }, { x: 20, y: 0 }], 1);
    expect(c.gesture.current).toBeNull();
  });

  it("snapping moves the dragged node onto the candidate, its handles with it", () => {
    const c = context({ snap: (p) => (Math.hypot(p.x - 61, p.y - 61) < 0.5 ? { x: 61, y: 61 } : p) });
    const b = mapNodesBinding(c);
    b.onPointerDown!(ptr(60, 60));
    expect(b.onPointerDrag!({ x: 61.2, y: 60.9 })).toEqual({ x: 61, y: 61 });
    b.onPointerUp!({ x: 61.2, y: 60.9 });
    expect(c.onCommit).toHaveBeenCalledWith(1, [{ x: 50, y: 50 }, { x: 60, y: 50 }, { x: 61, y: 61, hIn: { x: 0, y: -2 }, hOut: { x: 0, y: 2 } }], 2);
  });

  it("a grip drag moves the handle by the pointer's offset, its mirror kept, Alt live breaks it; never snapped", () => {
    const c = context({ snap: () => ({ x: 0, y: 0 }) });
    const b = mapNodesBinding(c);
    expect(b.onPointerDown!(ptr(60, 62.3))).toBe(true);
    b.onPointerDrag!({ x: 61, y: 62.3 });
    expect(c.onDraft).toHaveBeenLastCalledWith(1, [HOLE.vertices[0], HOLE.vertices[1], { x: 60, y: 60, hIn: { x: -1, y: -2 }, hOut: { x: 1, y: 2 } }]);
    b.onPointerDrag!({ x: 61, y: 62.3 }, { shift: false, alt: true });
    expect(c.onDraft).toHaveBeenLastCalledWith(1, [HOLE.vertices[0], HOLE.vertices[1], { x: 60, y: 60, hIn: { x: 0, y: -2 }, hOut: { x: 1, y: 2 } }]);
    b.onPointerUp!({ x: 61, y: 62.3 });
    expect(c.onCommit).toHaveBeenCalledWith(1, expect.any(Array), 2);
  });

  it("a node press comes before a grip, over every ring; a press elsewhere, on touch or while a write is in flight is not taken", () => {
    const b = mapNodesBinding(context());
    expect(b.onPointerDown!(ptr(30, 30))).toBe(false); // off every node and grip: the map pans
    expect(b.onPointerDown!(ptr(5, 0))).toBe(false); // on the edge: still not the tool's press
    expect(mapNodesBinding(context()).onPointerDown!(ptr(10, 0, { touch: true }))).toBe(false);
    expect(mapNodesBinding(context({ canPress: false })).onPointerDown!(ptr(10, 0))).toBe(false);
    const c = context();
    mapNodesBinding(c).onPointerDown!(ptr(60, 60.5));
    expect(c.gesture.current?.drag).toMatchObject({ kind: "object", vertex: 2 });
  });

  it("a click on a node focuses it; Alt-click toggles corner / smooth with one write; a click on a grip does nothing", () => {
    const c = context();
    const b = mapNodesBinding(c);
    b.onPointerDown!(ptr(10, 0));
    b.onPointerUp!({ x: 10.05, y: 0 });
    expect(c.onFocus).toHaveBeenCalledWith({ ring: 0, index: 1 });
    expect(c.onCommit).not.toHaveBeenCalled();
    b.onPointerDown!(ptr(10, 0, { alt: true }));
    b.onPointerUp!({ x: 10, y: 0 });
    expect(c.onCommit).toHaveBeenCalledWith(0, [{ x: 0, y: 0 }, { x: 10, y: 0, hIn: { x: -20 / 6, y: -0 }, hOut: { x: 20 / 6, y: 0 } }, { x: 20, y: 0 }], 1);
    b.onPointerDown!(ptr(20, 0, { alt: true })); // an open end corner has no smooth form
    b.onPointerUp!({ x: 20, y: 0 });
    expect(c.onCommit).toHaveBeenCalledTimes(1);
    b.onPointerDown!(ptr(60, 62));
    b.onPointerUp!({ x: 60, y: 62 });
    expect(c.onCommit).toHaveBeenCalledTimes(1);
    expect(c.onFocus).toHaveBeenCalledTimes(1);
  });

  it("a cancelled drag drops the draft and writes nothing", () => {
    const c = context();
    const b = mapNodesBinding(c);
    b.onPointerDown!(ptr(10, 0));
    b.onPointerDrag!({ x: 12, y: 0 });
    b.onPointerUp!(null);
    expect(c.onCancel).toHaveBeenCalledTimes(1);
    expect(c.onCommit).not.toHaveBeenCalled();
  });

  it("a click within reach of the edge keeps the selection and drops the focus; elsewhere it selects as V", async () => {
    const c = context();
    const b = mapNodesBinding(c);
    b.onClick!(ptr(5, HANDLE_PX * 0.1 * 0.9));
    await flush();
    expect(c.onFocus).toHaveBeenCalledWith(null);
    expect(c.hit).not.toHaveBeenCalled();
    b.onClick!(ptr(30, 30));
    expect(c.hit).toHaveBeenCalledWith({ x: 30, y: 30 }, MAP_HIT_PX * 0.1);
    await flush();
    expect(c.onSelect).toHaveBeenCalledWith({ source: 4 }, [{ source: 4 }]);
  });

  it("a double-click on an edge inserts a smooth node (Alt a corner) on the nearest ring and focuses it; on a node nothing", () => {
    const c = context();
    const b = mapNodesBinding(c);
    b.onDoubleClick!(ptr(5, 0.2));
    expect(c.onCommit).toHaveBeenLastCalledWith(0, [
      { x: 0, y: 0 }, { x: 5, y: 0, hIn: { x: -10 / 6, y: -0 }, hOut: { x: 10 / 6, y: 0 } }, { x: 10, y: 0 }, { x: 20, y: 0 },
    ], 1);
    b.onDoubleClick!(ptr(55, 50, { alt: true }));
    expect(c.onCommit).toHaveBeenLastCalledWith(1, [{ x: 50, y: 50 }, { x: 55, y: 50 }, ...HOLE.vertices.slice(1)], 1);
    b.onDoubleClick!(ptr(10, 0));
    b.onDoubleClick!(ptr(30, 30));
    expect(c.onCommit).toHaveBeenCalledTimes(2);
    mapNodesBinding(context({ canPress: false, onCommit: c.onCommit })).onDoubleClick!(ptr(5, 0));
    expect(c.onCommit).toHaveBeenCalledTimes(2);
  });

  it("under withTrackLayer the tracks stay below the nodes", () => {
    const track: ToolShape = { kind: "line", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], testId: "map-track" };
    const b = withTrackLayer(mapNodesBinding(context()), { shapes: [track], onScale: vi.fn() });
    expect(b.shapes![0]).toBe(track);
    expect(byTest(b.shapes, "editor-map-node")).toHaveLength(6);
  });
});
