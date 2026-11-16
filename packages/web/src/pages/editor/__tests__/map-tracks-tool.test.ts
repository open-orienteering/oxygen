import { describe, expect, it, vi } from "vitest";
import { gpsTrack } from "@oxygen/shared";
import { IDLE, liveTrim, trackToolStep, type TrackToolState, type TrackToolTarget } from "../tools/tracks";
import { mapTracksBinding } from "../tools/bindings";
import type { ToolPointer } from "../../../components/MapViewer";

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
    const on = trackToolStep(IDLE, { type: "down", pt: { x: 8.1, y: 0.1 }, handleMm: 0.35, dragMm: 0.15, target });
    expect(on.taken).toBe(true);
    expect(on.state).toMatchObject({ kind: "drag", end: "end", from: 8, index: 8, moved: false });
    const start = trackToolStep(IDLE, { type: "down", pt: { x: 1, y: -0.2 }, handleMm: 0.35, dragMm: 0.15, target });
    expect(start.state).toMatchObject({ kind: "drag", end: "start", index: 1 });
    const off = trackToolStep(IDLE, { type: "down", pt: { x: 5, y: 0 }, handleMm: 0.35, dragMm: 0.15, target });
    expect(off).toEqual({ state: IDLE, taken: false, effect: null });
    expect(trackToolStep(IDLE, { type: "down", pt: { x: 8, y: 0 }, handleMm: 0.35, dragMm: 0.15, target: null }).taken).toBe(false);
  });

  it("a drag moves the handle along the stored points; within the threshold it stays", () => {
    let s: TrackToolState = trackToolStep(IDLE, { type: "down", pt: { x: 8, y: 0 }, handleMm: 0.35, dragMm: 0.15, target }).state;
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
    let s = trackToolStep(IDLE, { type: "down", pt: { x: 1, y: 0 }, handleMm: 0.35, dragMm: 0.15, target }).state;
    s = trackToolStep(s, { type: "drag", pt: { x: 3, y: 0 } }).state;
    const up = trackToolStep(s, { type: "up", pt: { x: 3, y: 0 } });
    expect(up.state).toBe(IDLE);
    expect(up.effect).toEqual({ kind: "trim", id: "t", trim: { start: 3, end: 9 }, before: { start: 1, end: 9 } });
    // Back where it was: no write.
    s = trackToolStep(IDLE, { type: "down", pt: { x: 1, y: 0 }, handleMm: 0.35, dragMm: 0.15, target }).state;
    s = trackToolStep(s, { type: "drag", pt: { x: 3, y: 0 } }).state;
    s = trackToolStep(s, { type: "drag", pt: { x: 1, y: 0 } }).state;
    expect(trackToolStep(s, { type: "up", pt: { x: 1, y: 0 } }).effect).toBeNull();
    // Cancelled (Escape, the pointer left): nothing.
    s = trackToolStep(IDLE, { type: "down", pt: { x: 1, y: 0 }, handleMm: 0.35, dragMm: 0.15, target }).state;
    s = trackToolStep(s, { type: "drag", pt: { x: 4, y: 0 } }).state;
    expect(trackToolStep(s, { type: "up", pt: null })).toEqual({ state: IDLE, taken: false, effect: null });
    // Up without a gesture.
    expect(trackToolStep(IDLE, { type: "up", pt: { x: 0, y: 0 } }).effect).toBeNull();
  });

  it("a click on the tool's track splits at the nearest stored point; on another track it selects that one; else nothing", () => {
    expect(trackToolStep(IDLE, { type: "click", pt: { x: 4.2, y: 0.1 }, reachMm: 0.3, target, lines }).effect).toEqual({ kind: "split", id: "t", index: 4 });
    // Next to a handle: fewer than two points on a side, no split.
    expect(trackToolStep(IDLE, { type: "click", pt: { x: 1.2, y: 0 }, reachMm: 0.3, target, lines }).effect).toBeNull();
    expect(trackToolStep(IDLE, { type: "click", pt: { x: 4, y: 2.9 }, reachMm: 0.3, target, lines }).effect).toEqual({ kind: "select", id: "o" });
    expect(trackToolStep(IDLE, { type: "click", pt: { x: 4, y: 1.5 }, reachMm: 0.3, target, lines }).effect).toBeNull();
    // No tool track yet (none or several selected): a click on a track selects it alone.
    expect(trackToolStep(IDLE, { type: "click", pt: { x: 4, y: 0 }, reachMm: 0.3, target: null, lines }).effect).toEqual({ kind: "select", id: "t" });
  });
});

describe("mapTracksBinding (tools/bindings.ts)", () => {
  const ptr = (x: number, y: number): ToolPointer => ({ pt: { x, y }, target: null, shift: false, mmPerPx: MM });
  it("exclusive; the handles drawn at the live trim; a drag drafts, the release commits", () => {
    const gesture = { current: IDLE as TrackToolState };
    const onDraft = vi.fn(), onTrim = vi.fn(), onSplit = vi.fn(), onSelect = vi.fn();
    const make = () => mapTracksBinding({ target, lines, gesture, onDraft, onTrim, onSplit, onSelect });
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
  it("without a tool track: no handles, presses not taken", () => {
    const b = mapTracksBinding({ target: null, lines, gesture: { current: IDLE }, onDraft: vi.fn(), onTrim: vi.fn(), onSplit: vi.fn(), onSelect: vi.fn() });
    expect(b.shapes ?? []).toEqual([]);
    expect(b.onPointerDown!(ptr(8, 0))).toBe(false);
  });
});
