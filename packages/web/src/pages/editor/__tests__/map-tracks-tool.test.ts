import { describe, expect, it, vi } from "vitest";
import { gpsTrack } from "@oxygen/shared";
import { clickHitsTrack, hoverCandidate, IDLE, liveTrim, trackToolStep, type TrackToolState, type TrackToolTarget } from "../tools/tracks";
import { mapSplitBinding, mapTBinding, mapTracksBinding, splitNodes } from "../tools/bindings";
import type { ToolPointer } from "../../../components/MapViewer";
import { nodePoints, TRACK_NODES_MAX } from "../../../lib/editor/track-nodes";

const line = (pts: [number, number][]): gpsTrack.ProjectedTrack => ({
  x: Float64Array.from(pts, (p) => p[0]),
  y: Float64Array.from(pts, (p) => p[1]),
  metresPerMm: 7.5,
});
const full = line(Array.from({ length: 10 }, (_, i) => [i, 0] as [number, number]));
const target: TrackToolTarget = { id: "t", full, trim: { start: 1, end: 9 } };
const other = { id: "o", line: line([[0, 3], [9, 3]]) };
const lines = [{ id: "t", line: { ...full, x: full.x.subarray(1, 9), y: full.y.subarray(1, 9) } }, other];
const MM = 0.05; // mm per CSS px: 7 px reach = 0.35 mm

describe("the Tracks tool's reducer (docs/map-gps-tracks.md §5.2; tools/tracks.ts)", () => {
  it("a press on a handle takes the gesture; elsewhere it is not taken (the map pans)", () => {
    const on = trackToolStep(IDLE, { type: "down", pt: { x: 8.1, y: 0.1 }, handleMm: 0.35, dragMm: 0.15, targets: [target] });
    expect(on.taken).toBe(true);
    expect(on.state).toMatchObject({ kind: "drag", end: "end", from: 8, index: 8, moved: false });
    const start = trackToolStep(IDLE, { type: "down", pt: { x: 1, y: -0.2 }, handleMm: 0.35, dragMm: 0.15, targets: [target] });
    expect(start.state).toMatchObject({ kind: "drag", end: "start", index: 1 });
    const off = trackToolStep(IDLE, { type: "down", pt: { x: 5, y: 0 }, handleMm: 0.35, dragMm: 0.15, targets: [target] });
    expect(off).toEqual({ state: IDLE, taken: false, effect: null });
    expect(trackToolStep(IDLE, { type: "down", pt: { x: 8, y: 0 }, handleMm: 0.35, dragMm: 0.15, targets: [] }).taken).toBe(false);
  });

  it("a drag moves the handle along the stored points; within the threshold it stays", () => {
    let s: TrackToolState = trackToolStep(IDLE, { type: "down", pt: { x: 8, y: 0 }, handleMm: 0.35, dragMm: 0.15, targets: [target] }).state;
    s = trackToolStep(s, { type: "drag", pt: { x: 7.9, y: 0 } }).state;
    expect(s).toMatchObject({ index: 8, moved: false });
    s = trackToolStep(s, { type: "drag", pt: { x: 5.2, y: 0.4 } }).state;
    expect(s).toMatchObject({ index: 5, moved: true });
    expect(liveTrim(s)).toEqual({ id: "t", trim: { start: 1, end: 6 } });
    // Outward past the trimmed end restores it: the whole stored track is in reach.
    s = trackToolStep(s, { type: "drag", pt: { x: 12, y: 0 } }).state;
    expect(liveTrim(s)).toEqual({ id: "t", trim: { start: 1, end: 10 } });
    // Never closer than two points to the other handle.
    s = trackToolStep(s, { type: "drag", pt: { x: -3, y: 0 } }).state;
    expect(liveTrim(s)).toEqual({ id: "t", trim: { start: 1, end: 3 } });
  });

  it("the release writes the trim once, with the trim before; at the same index, or cancelled, nothing", () => {
    let s = trackToolStep(IDLE, { type: "down", pt: { x: 1, y: 0 }, handleMm: 0.35, dragMm: 0.15, targets: [target] }).state;
    s = trackToolStep(s, { type: "drag", pt: { x: 3, y: 0 } }).state;
    const up = trackToolStep(s, { type: "up", pt: { x: 3, y: 0 } });
    expect(up.state).toBe(IDLE);
    expect(up.effect).toEqual({ kind: "trim", id: "t", trim: { start: 3, end: 9 }, before: { start: 1, end: 9 } });
    // Back where it was: no write.
    s = trackToolStep(IDLE, { type: "down", pt: { x: 1, y: 0 }, handleMm: 0.35, dragMm: 0.15, targets: [target] }).state;
    s = trackToolStep(s, { type: "drag", pt: { x: 3, y: 0 } }).state;
    s = trackToolStep(s, { type: "drag", pt: { x: 1, y: 0 } }).state;
    expect(trackToolStep(s, { type: "up", pt: { x: 1, y: 0 } }).effect).toBeNull();
    // Cancelled (Escape, the pointer left): nothing.
    s = trackToolStep(IDLE, { type: "down", pt: { x: 1, y: 0 }, handleMm: 0.35, dragMm: 0.15, targets: [target] }).state;
    s = trackToolStep(s, { type: "drag", pt: { x: 4, y: 0 } }).state;
    expect(trackToolStep(s, { type: "up", pt: null })).toEqual({ state: IDLE, taken: false, effect: null });
    // Up without a gesture.
    expect(trackToolStep(IDLE, { type: "up", pt: { x: 0, y: 0 } }).effect).toBeNull();
  });

  it("a click on the tool's track splits at the nearest stored point; on another track it selects that one; else nothing", () => {
    expect(trackToolStep(IDLE, { type: "click", pt: { x: 4.2, y: 0.1 }, reachMm: 0.3, targets: [target], lines }).effect).toEqual({ kind: "split", id: "t", index: 4 });
    // Next to a handle: fewer than two points on a side, no split.
    expect(trackToolStep(IDLE, { type: "click", pt: { x: 1.2, y: 0 }, reachMm: 0.3, targets: [target], lines }).effect).toBeNull();
    expect(trackToolStep(IDLE, { type: "click", pt: { x: 4, y: 2.9 }, reachMm: 0.3, targets: [target], lines }).effect).toEqual({ kind: "select", id: "o" });
    expect(trackToolStep(IDLE, { type: "click", pt: { x: 4, y: 1.5 }, reachMm: 0.3, targets: [target], lines }).effect).toBeNull();
    // In reach of both: the nearer one wins; on a tie the tool's own track.
    const near = [lines[0], { id: "n", line: line([[0, 0.4], [9, 0.4]]) }];
    expect(trackToolStep(IDLE, { type: "click", pt: { x: 4, y: 0.3 }, reachMm: 0.5, targets: [target], lines: near }).effect).toEqual({ kind: "select", id: "n" });
    expect(trackToolStep(IDLE, { type: "click", pt: { x: 4, y: 0.1 }, reachMm: 0.5, targets: [target], lines: near }).effect).toEqual({ kind: "split", id: "t", index: 4 });
    expect(trackToolStep(IDLE, { type: "click", pt: { x: 4, y: 0.2 }, reachMm: 0.5, targets: [target], lines: near }).effect).toEqual({ kind: "split", id: "t", index: 4 });
    // No tool track yet (none or several selected): a click on a track selects it alone.
    expect(trackToolStep(IDLE, { type: "click", pt: { x: 4, y: 0 }, reachMm: 0.3, targets: [], lines }).effect).toEqual({ kind: "select", id: "t" });
  });
});

describe("mapTracksBinding (tools/bindings.ts)", () => {
  const ptr = (x: number, y: number): ToolPointer => ({ pt: { x, y }, target: null, shift: false, mmPerPx: MM });
  it("exclusive; the handles drawn at the live trim; a drag drafts, the release commits", () => {
    const gesture = { current: IDLE as TrackToolState };
    const onDraft = vi.fn(), onTrim = vi.fn(), onSplit = vi.fn(), onSelect = vi.fn();
    const make = () => mapTracksBinding({ targets: [target], lines, gesture, onDraft, onTrim, onSplit, onSelect });
    const b = make();
    expect(b.exclusive).toBe(true);
    const handles = (b.shapes ?? []).filter((s) => s.kind === "handle");
    expect(handles.map((h) => h.kind === "handle" && [h.x, h.data?.end, h.data?.index])).toEqual([[1, "start", "1"], [8, "end", "8"]]);
    expect(b.onPointerDown!(ptr(8, 0))).toBe(true);
    b.onPointerDrag!({ x: 6, y: 0 });
    expect(onDraft).toHaveBeenLastCalledWith({ id: "t", trim: { start: 1, end: 7 } });
    const live = (make().shapes ?? []).filter((s) => s.kind === "handle");
    expect(live.map((h) => h.kind === "handle" && h.x)).toEqual([1, 6]);
    b.onPointerUp!({ x: 6, y: 0 });
    expect(onDraft).toHaveBeenLastCalledWith(null);
    expect(onTrim).toHaveBeenCalledWith("t", { start: 1, end: 7 }, { start: 1, end: 9 });
    b.onClick!(ptr(4, 0));
    expect(onSplit).toHaveBeenCalledWith("t", 4);
    b.onClick!(ptr(4, 3));
    expect(onSelect).toHaveBeenCalledWith("o");
  });
  it("while a write is in flight (canPress false) a press on a handle is not taken", () => {
    const gesture = { current: IDLE as TrackToolState };
    const b = mapTracksBinding({ targets: [target], lines, gesture, canPress: false, onDraft: vi.fn(), onTrim: vi.fn(), onSplit: vi.fn(), onSelect: vi.fn() });
    expect((b.shapes ?? []).filter((s) => s.kind === "handle")).toHaveLength(2);
    expect(b.onPointerDown!(ptr(8, 0))).toBe(false);
    expect(gesture.current).toBe(IDLE);
  });

  it("without a tool track: no handles, presses not taken", () => {
    const b = mapTracksBinding({ targets: [], lines, gesture: { current: IDLE }, onDraft: vi.fn(), onTrim: vi.fn(), onSplit: vi.fn(), onSelect: vi.fn() });
    expect(b.shapes ?? []).toEqual([]);
    expect(b.onPointerDown!(ptr(8, 0))).toBe(false);
  });
});

describe("T's nodes and hovered node (G30; docs/map-gps-tracks.md §5.2)", () => {
  const ptr = (x: number, y: number): ToolPointer => ({ pt: { x, y }, target: null, shift: false, mmPerPx: MM });
  const cb = () => ({ onDraft: vi.fn(), onTrim: vi.fn(), onSplit: vi.fn(), onSelect: vi.fn() });

  it("hoverCandidate is the split a click makes there; none off the track, next to a handle or without a tool track", () => {
    expect(hoverCandidate({ x: 4.2, y: 0.1 }, 0.3, [target], lines)).toEqual({ id: "t", index: 4 });
    expect(trackToolStep(IDLE, { type: "click", pt: { x: 4.2, y: 0.1 }, reachMm: 0.3, targets: [target], lines }).effect).toEqual({ kind: "split", id: "t", index: 4 });
    expect(hoverCandidate({ x: 1.2, y: 0 }, 0.3, [target], lines)).toBeNull();
    expect(hoverCandidate({ x: 4, y: 1.5 }, 0.3, [target], lines)).toBeNull();
    expect(hoverCandidate({ x: 4, y: 2.9 }, 0.3, [target], lines)).toBeNull(); // on the other track: a click selects
    expect(hoverCandidate({ x: 4, y: 0 }, 0.3, [], lines)).toBeNull();
  });

  it("several tool tracks: a click splits the one it is on, a press takes the nearest handle of any", () => {
    const second: TrackToolTarget = { id: "s", full: line(Array.from({ length: 10 }, (_, i) => [i, 3] as [number, number])), trim: { start: 0, end: 10 } };
    const both = [target, second];
    expect(trackToolStep(IDLE, { type: "click", pt: { x: 6, y: 3.1 }, reachMm: 0.3, targets: both, lines: [] }).effect).toEqual({ kind: "split", id: "s", index: 6 });
    expect(trackToolStep(IDLE, { type: "click", pt: { x: 6, y: 0.1 }, reachMm: 0.3, targets: both, lines: [] }).effect).toEqual({ kind: "split", id: "t", index: 6 });
    const down = trackToolStep(IDLE, { type: "down", pt: { x: 9, y: 3 }, handleMm: 0.35, dragMm: 0.15, targets: both });
    expect(down.state).toMatchObject({ kind: "drag", end: "end", index: 9, target: { id: "s" } });
  });

  it("the binding draws the splittable range as thinned nodes, the hovered node and every point round it, handles last", () => {
    const b = mapTracksBinding({ targets: [target], lines, gesture: { current: IDLE }, hover: { id: "t", index: 4, mmPerPx: MM }, onHover: vi.fn(), ...cb() });
    const kinds = (b.shapes ?? []).map((s) => s.testId);
    expect(kinds).toEqual(["editor-track-nodes", "editor-track-nodes-near", "editor-track-node-hover", "editor-track-handle", "editor-track-handle"]);
    const [nodes, near, hov] = b.shapes!;
    expect(nodes).toMatchObject({ kind: "nodes", from: 2, to: 7, gapPx: 10 });
    // 60 px at 0.05 mm/px = 3 mm round point 4, inside 2 … 7.
    expect(near).toMatchObject({ kind: "nodes", indices: [2, 3, 4, 5, 6, 7] });
    expect(hov).toMatchObject({ kind: "nodes", indices: [4], active: true, data: { "track-id": "t", index: "4" } });
    expect(b.cursor).toBe("pointer");
  });

  it("hover reports the candidate with the zoom, null off it; a split clears it", () => {
    const onHover = vi.fn(), c = cb();
    const b = mapTracksBinding({ targets: [target], lines, gesture: { current: IDLE }, onHover, ...c });
    b.onHover!(ptr(5, 0.05));
    expect(onHover).toHaveBeenLastCalledWith({ id: "t", index: 5, mmPerPx: MM });
    b.onHover!(ptr(5, 2));
    expect(onHover).toHaveBeenLastCalledWith(null);
    b.onHover!(ptr(5, 0));
    b.onClick!(ptr(5, 0));
    expect(onHover).toHaveBeenLastCalledWith(null);
    expect(c.onSplit).toHaveBeenCalledWith("t", 5);
  });

  it("no nodes while a handle is held, nor on a track too short to split", () => {
    const gesture = { current: IDLE as TrackToolState };
    const b = mapTracksBinding({ targets: [target], lines, gesture, ...cb() });
    b.onPointerDown!(ptr(8, 0));
    b.onPointerDrag!({ x: 6, y: 0 });
    const held = mapTracksBinding({ targets: [target], lines, gesture, ...cb() });
    expect((held.shapes ?? []).map((s) => s.kind)).toEqual(["handle", "handle"]);
    const short: TrackToolTarget = { id: "x", full, trim: { start: 2, end: 5 } };
    expect((mapTracksBinding({ targets: [short], lines: [], gesture: { current: IDLE }, ...cb() }).shapes ?? []).map((s) => s.kind)).toEqual(["handle", "handle"]);
  });
});

describe("nodePoints (MapViewer, the `nodes` shape)", () => {
  const xs = Float64Array.from({ length: 101 }, (_, i) => i * 0.1), ys = new Float64Array(101);
  const project = (x: number, y: number) => ({ x: x * 10, y: y * 10 }); // 1 px per 0.1 mm
  it("thins in screen space to the gap, in index order; indices are drawn as given", () => {
    const pts = nodePoints({ kind: "nodes", x: xs, y: ys, from: 0, to: 100, gapPx: 10 }, project);
    expect(pts.map((p) => Math.round(p.x))).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(nodePoints({ kind: "nodes", x: xs, y: ys, indices: [3, 7] }, project).map((p) => Math.round(p.x))).toEqual([3, 7]);
  });
  it("over the budget the spacing doubles until it fits", () => {
    const n = TRACK_NODES_MAX * 3;
    const bx = Float64Array.from({ length: n }, (_, i) => i), by = new Float64Array(n);
    const pts = nodePoints({ kind: "nodes", x: bx, y: by, from: 0, to: n - 1, gapPx: 1 }, (x, y) => ({ x, y }));
    expect(pts.length).toBeLessThanOrEqual(TRACK_NODES_MAX);
    expect(pts.length).toBeGreaterThan(TRACK_NODES_MAX / 2);
  });
});

describe("after a split: the parts' handles on the shared point, a stale hover (G30)", () => {
  const cb = () => ({ onDraft: vi.fn(), onTrim: vi.fn(), onSplit: vi.fn(), onSelect: vi.fn() });
  const left: TrackToolTarget = { id: "l", full: line(Array.from({ length: 6 }, (_, i) => [i, 0] as [number, number])), trim: { start: 0, end: 6 } };
  const right: TrackToolTarget = { id: "r", full: line(Array.from({ length: 6 }, (_, i) => [i + 5, 0] as [number, number])), trim: { start: 0, end: 6 } };
  it("a press on the shared point drags whichever handle follows the pointer: forward the right part's start, back the left's end", () => {
    let s = trackToolStep(IDLE, { type: "down", pt: { x: 5, y: 0 }, handleMm: 0.35, dragMm: 0.15, targets: [left, right] }).state;
    s = trackToolStep(s, { type: "drag", pt: { x: 7, y: 0 } }).state;
    expect(liveTrim(s)).toEqual({ id: "r", trim: { start: 2, end: 6 } });
    s = trackToolStep(IDLE, { type: "down", pt: { x: 5, y: 0 }, handleMm: 0.35, dragMm: 0.15, targets: [left, right] }).state;
    s = trackToolStep(s, { type: "drag", pt: { x: 3, y: 0 } }).state;
    expect(liveTrim(s)).toEqual({ id: "l", trim: { start: 0, end: 4 } });
  });
  it("a hovered index outside the splittable range (a redo trimmed it away) draws no hover and no pointer cursor", () => {
    const b = mapTracksBinding({ targets: [target], lines, gesture: { current: IDLE }, hover: { id: "t", index: 8, mmPerPx: MM }, ...cb() });
    expect((b.shapes ?? []).map((s) => s.testId)).toEqual(["editor-track-nodes", "editor-track-handle", "editor-track-handle"]);
    expect(b.cursor).toBeUndefined();
  });
});

describe("T on map lines (G32): mapSplitBinding, splitNodes, mapTBinding", () => {
  const v = (pts: [number, number][]) => pts.map(([x, y]) => ({ x, y }));
  const ptr = (x: number, y: number): ToolPointer => ({ pt: { x, y }, target: null, shift: false, mmPerPx: MM });
  const hitStub = (refs: { added: string }[]) => vi.fn(async () => refs.map((ref) => ({ ref })));
  it("splitNodes: all but the ends of an open line, every node of a loop", () => {
    expect(splitNodes({ vertices: v([[0, 0], [1, 0], [2, 0], [3, 0]]), closed: false })).toEqual([1, 2]);
    expect(splitNodes({ vertices: v([[0, 0], [1, 0]]), closed: false })).toEqual([]);
    expect(splitNodes({ vertices: v([[0, 0], [1, 0], [1, 1]]), closed: true })).toEqual([0, 1, 2]);
  });
  it("draws the selected line's splittable nodes; a click on one splits, elsewhere it selects the hit", async () => {
    const onSplit = vi.fn(), onSelect = vi.fn();
    const hit = hitStub([{ added: "b" }]);
    const b = mapSplitBinding({ hit: hit as never, clickSeq: { current: 0 }, onSelect, line: { vertices: v([[0, 0], [1, 0], [2, 0]]), closed: false }, onSplit });
    expect((b.shapes ?? []).map((s) => s.kind === "handle" && [s.x, s.data?.index, s.testId])).toEqual([[1, "1", "editor-split-node"]]);
    b.onClick!(ptr(1.1, 0.1));
    expect(onSplit).toHaveBeenCalledWith(1);
    expect(hit).not.toHaveBeenCalled();
    // An end node is no split: the click selects.
    b.onClick!(ptr(0, 0));
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith({ added: "b" }, [{ added: "b" }]));
    expect(onSplit).toHaveBeenCalledTimes(1);
  });
  it("without a selected line, or while a write is in flight, a click selects", async () => {
    const onSplit = vi.fn(), onSelect = vi.fn();
    const none = mapSplitBinding({ hit: hitStub([]) as never, clickSeq: { current: 0 }, onSelect, line: null, onSplit });
    expect(none.shapes).toEqual([]);
    none.onClick!(ptr(1, 0));
    await vi.waitFor(() => expect(onSelect).toHaveBeenCalledWith(null, []));
    const busy = mapSplitBinding({ hit: hitStub([]) as never, clickSeq: { current: 0 }, onSelect, line: { vertices: v([[0, 0], [1, 0], [2, 0]]), closed: false }, canSplit: false, onSplit });
    busy.onClick!(ptr(1, 0));
    expect(onSplit).not.toHaveBeenCalled();
  });
  it("mapTBinding: a click on a GPS track goes to the tracks, any other to the lines; both drawn", () => {
    const tracksClick = vi.fn(), linesClick = vi.fn();
    const t = { exclusive: true, shapes: [{ kind: "handle" as const, x: 0, y: 0, testId: "editor-track-handle" }], onClick: tracksClick };
    const l = { exclusive: true, shapes: [{ kind: "handle" as const, x: 5, y: 5, testId: "editor-split-node" }], onClick: linesClick };
    const b = mapTBinding(t, (pt) => pt.y < 1, l);
    expect((b.shapes ?? []).map((s) => s.testId)).toEqual(["editor-track-handle", "editor-split-node"]);
    b.onClick!(ptr(0, 0));
    expect(tracksClick).toHaveBeenCalledTimes(1);
    b.onClick!(ptr(0, 5));
    expect(linesClick).toHaveBeenCalledTimes(1);
    expect(mapTBinding(null, () => true, l)).toBe(l);
  });
});

describe("G32 review cases", () => {
  const v = (pts: [number, number][]) => pts.map(([x, y]) => ({ x, y }));
  const ptr = (x: number, y: number): ToolPointer => ({ pt: { x, y }, target: null, shift: false, mmPerPx: MM });
  it("clickHitsTrack: on a tool's track or another visible one, not off them", () => {
    expect(clickHitsTrack({ x: 4, y: 0.1 }, 0.3, [target], lines)).toBe(true);
    expect(clickHitsTrack({ x: 4, y: 2.9 }, 0.3, [], lines)).toBe(true);
    expect(clickHitsTrack({ x: 4, y: 1.5 }, 0.3, [target], lines)).toBe(false);
  });
  it("a loop splits at any node, the nearest of two in reach; a split bumps the click sequence", () => {
    const onSplit = vi.fn(), clickSeq = { current: 3 };
    const b = mapSplitBinding({ hit: vi.fn(async () => []) as never, clickSeq, onSelect: vi.fn(), line: { vertices: v([[0, 0], [0.3, 0], [0.3, 0.3]]), closed: true }, onSplit });
    b.onClick!(ptr(0.05, 0));
    expect(onSplit).toHaveBeenLastCalledWith(0);
    b.onClick!(ptr(0.25, 0));
    expect(onSplit).toHaveBeenLastCalledWith(1);
    expect(clickSeq.current).toBe(5);
  });
  it("mapTBinding keeps the tracks' press and hover; a click on a track drops a line hit-test in flight", () => {
    const down = vi.fn(() => true), hover = vi.fn(), clickSeq = { current: 0 };
    const t = { exclusive: true, onPointerDown: down, onHover: hover, onClick: vi.fn() };
    const b = mapTBinding(t, () => true, { exclusive: true, onClick: vi.fn() }, clickSeq);
    expect(b.onPointerDown).toBe(down);
    expect(b.onHover).toBe(hover);
    b.onClick!(ptr(0, 0));
    expect(clickSeq.current).toBe(1);
  });
});
