/**
 * Map mode's drawing bindings (docs/course-editor.md §13 "Drawing"): `P` places a point (a press-drag turns an
 * orientable one), `L` / `A` draw through the course editor's polygon flow with a closing gesture held back while a
 * write is in flight.
 */

import { describe, expect, it, vi } from "vitest";
import type { ToolPointer } from "../../../components/MapViewer";
import { MAP_DRAG_PX, mapDrawBinding, mapPointBinding, withTrackLayer, type GestureRef, type MapPointContext, type MapPointGestureRef } from "../tools/bindings";
import type { PolygonState } from "../tools/polygon";

const ptr = (x: number, y: number, extra: Partial<ToolPointer> = {}): ToolPointer => ({ pt: { x, y }, target: null, shift: false, mmPerPx: 0.1, ...extra });

function pointContext(over: Partial<MapPointContext> = {}) {
  const gesture: MapPointGestureRef = { current: null };
  const c: MapPointContext = {
    canPlace: true,
    orientable: false,
    snap: (p) => p,
    gesture,
    onPlace: vi.fn(),
    onAim: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  return c;
}

describe("Map mode's P (§13 \"Drawing\")", () => {
  it("is exclusive with a crosshair; a click places a snapped point at angle 0", () => {
    const c = pointContext({ snap: (p) => ({ x: Math.round(p.x), y: Math.round(p.y) }) });
    const b = mapPointBinding(c);
    expect(b.exclusive).toBe(true);
    expect(b.cursor).toBe("crosshair");
    b.onClick!(ptr(10.2, 19.8));
    expect(c.onPlace).toHaveBeenCalledWith({ x: 10, y: 20 }, 0);
  });

  it("places nothing while it cannot (no symbol, a write in flight)", () => {
    const c = pointContext({ canPlace: false, orientable: true });
    const b = mapPointBinding(c);
    b.onClick!(ptr(1, 1));
    expect(b.onPointerDown!(ptr(1, 1))).toBe(false);
    expect(c.onPlace).not.toHaveBeenCalled();
  });

  it("a symbol that does not turn takes no press: a drag pans", () => {
    expect(mapPointBinding(pointContext()).onPointerDown!(ptr(1, 1))).toBe(false);
  });

  it("an orientable symbol: the press-drag aims it from the press, the release places it turned; the direction line shows", () => {
    const c = pointContext({ orientable: true });
    const b = mapPointBinding(c);
    expect(b.onPointerDown!(ptr(10, 10))).toBe(true);
    b.onPointerDrag!({ x: 10 + MAP_DRAG_PX * 0.1 * 0.5, y: 10 }); // within 3 px: not yet aimed
    expect(c.onAim).not.toHaveBeenCalled();
    b.onPointerDrag!({ x: 10, y: 12 });
    expect(c.onAim).toHaveBeenLastCalledWith({ x: 10, y: 10 }, 900);
    const shapes = mapPointBinding(c).shapes ?? [];
    expect(shapes.find((s) => s.testId === "editor-map-point-direction")).toMatchObject({ kind: "line", points: [{ x: 10, y: 10 }, { x: 10, y: 12 }] });
    b.onPointerUp!({ x: 8, y: 10 });
    expect(c.onPlace).toHaveBeenCalledWith({ x: 10, y: 10 }, 1800);
    expect(c.gesture.current).toBeNull();
  });

  it("a press released without movement places at 0; a cancelled aim places nothing", () => {
    const c = pointContext({ orientable: true });
    const b = mapPointBinding(c);
    b.onPointerDown!(ptr(5, 5));
    b.onPointerUp!({ x: 5, y: 5 });
    expect(c.onPlace).toHaveBeenCalledWith({ x: 5, y: 5 }, 0);
    b.onPointerDown!(ptr(5, 5));
    b.onPointerDrag!({ x: 7, y: 5 });
    b.onPointerUp!(null);
    expect(c.onPlace).toHaveBeenCalledTimes(1);
    expect(c.onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps working under the track layer", () => {
    const c = pointContext();
    const onScale = vi.fn();
    const b = withTrackLayer(mapPointBinding(c), { shapes: [], onScale });
    b.onClick!(ptr(3, 4, { mmPerPx: 0.3 }));
    expect(onScale).toHaveBeenCalledWith(0.3);
    expect(c.onPlace).toHaveBeenCalledWith({ x: 3, y: 4 }, 0);
  });
});

describe("Map mode's L and A (§13 \"Drawing\")", () => {
  function drawContext(kind: "map_line" | "map_area", canClose = true) {
    const state = { poly: { kind, vertices: [] } as PolygonState };
    const gesture: GestureRef = { current: null };
    const onDone = vi.fn();
    const make = () => mapDrawBinding({
      gesture, poly: state.poly, hover: null, onHover: vi.fn(), onPoly: (p) => { state.poly = p; }, onDone, onCancel: vi.fn(),
      snap: (p) => p, canClose: () => canClose,
    });
    const click = (x: number, y: number) => make().onClick!(ptr(x, y));
    return { state, onDone, make, click };
  }

  it("a line: a click per node, a double-click ends it with its nodes", () => {
    const d = drawContext("map_line");
    d.click(0, 0);
    d.click(10, 0);
    d.make().onDoubleClick!(ptr(20, 5));
    expect(d.onDone).toHaveBeenCalledTimes(1);
    expect(d.onDone.mock.calls[0][0].map((v: { x: number; y: number }) => [v.x, v.y])).toEqual([[0, 0], [10, 0], [20, 5]]);
  });

  it("an area closes on its first node from three", () => {
    const d = drawContext("map_area");
    d.click(0, 0);
    d.click(10, 0);
    d.click(10, 10);
    expect(d.make().cursor).toBe("crosshair");
    d.click(0, 0);
    expect(d.onDone).toHaveBeenCalledTimes(1);
    expect(d.onDone.mock.calls[0][0]).toHaveLength(3);
  });

  it("while a write is in flight the closing gesture is held back and the drawing kept", () => {
    const d = drawContext("map_area", false);
    d.click(0, 0);
    d.click(10, 0);
    d.click(10, 10);
    d.click(0, 0);
    expect(d.onDone).not.toHaveBeenCalled();
    expect(d.state.poly.vertices).toHaveLength(3);
  });
});
