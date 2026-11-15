import { describe, expect, it, vi } from "vitest";
import { MAP_HIT_PX, mapSelectBinding, type MapGestureRef, type MapSelectContext } from "../tools/bindings";
import { mapKeyAction } from "../modes/map/keys";
import { MAP_RAIL } from "../tools/rail";
import type { ToolPointer } from "../../../components/MapViewer";
import type { MapObjectRef } from "../../../map-gl/worker";

const ptr = (x: number, y: number, extra: Partial<ToolPointer> = {}): ToolPointer => ({ pt: { x, y }, target: null, shift: false, mmPerPx: 0.1, ...extra });
const flush = () => new Promise((r) => setTimeout(r, 0));

function context(over: Partial<MapSelectContext> = {}) {
  const gesture: MapGestureRef = { current: null };
  const c: MapSelectContext = {
    hit: vi.fn(async () => [{ ref: { source: 7 } as MapObjectRef }, { ref: null }, { ref: { source: 3 } as MapObjectRef }]),
    canMove: true,
    pressOn: vi.fn(() => true),
    gesture,
    clickSeq: { current: 0 },
    onSelect: vi.fn(),
    onDrag: vi.fn(),
    onDrop: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  return c;
}

describe("Map mode's V (docs/course-editor.md §13)", () => {
  it("is exclusive: a click asks the hit-test at 6 px and selects the topmost object, the stack for Tab", async () => {
    const c = context();
    const b = mapSelectBinding(c);
    expect(b.exclusive).toBe(true);
    b.onClick!(ptr(10, 20));
    expect(c.hit).toHaveBeenCalledWith({ x: 10, y: 20 }, MAP_HIT_PX * 0.1);
    await flush();
    expect(c.onSelect).toHaveBeenCalledWith({ source: 7 }, [{ source: 7 }, { source: 3 }]);
  });

  it("a click on empty map deselects; an answer to an older click is dropped", async () => {
    let first: (v: readonly { ref: MapObjectRef | null }[]) => void = () => undefined;
    const answers = [new Promise<readonly { ref: MapObjectRef | null }[]>((r) => { first = r; }), Promise.resolve([])];
    const c = context({ hit: vi.fn(() => answers.shift()!) });
    const b = mapSelectBinding(c);
    b.onClick!(ptr(1, 1));
    b.onClick!(ptr(2, 2));
    await flush();
    expect(c.onSelect).toHaveBeenCalledWith(null, []);
    first([{ ref: { source: 9 } }]);
    await flush();
    expect(c.onSelect).toHaveBeenCalledTimes(1);
  });

  it("a press off the selected object, or when it cannot move, is not taken (the map pans)", () => {
    expect(mapSelectBinding(context({ pressOn: () => false })).onPointerDown!(ptr(1, 1))).toBe(false);
    expect(mapSelectBinding(context({ canMove: false })).onPointerDown!(ptr(1, 1))).toBe(false);
    expect(mapSelectBinding(context()).onPointerDown!(ptr(1, 1, { touch: true }))).toBe(false);
  });

  it("a drag of the selected object draws its draft and writes once on release", () => {
    const c = context();
    const b = mapSelectBinding(c);
    expect(b.onPointerDown!(ptr(10, 20))).toBe(true);
    b.onPointerDrag!({ x: 10.1, y: 20 }); // within 3 px: not yet a move
    expect(c.onDrag).not.toHaveBeenCalled();
    b.onPointerDrag!({ x: 11, y: 21 });
    expect(c.onDrag).toHaveBeenLastCalledWith(1, 1);
    b.onPointerUp!({ x: 12, y: 21 });
    expect(c.onDrop).toHaveBeenCalledTimes(1);
    expect(c.onDrop).toHaveBeenCalledWith(2, 1);
    expect(c.gesture.current).toBeNull();
  });

  it("a release without movement writes nothing and is a click; a cancelled drag drops its draft", async () => {
    const c = context();
    const b = mapSelectBinding(c);
    b.onPointerDown!(ptr(10, 20));
    b.onPointerUp!({ x: 10, y: 20 });
    expect(c.onDrop).not.toHaveBeenCalled();
    expect(c.onCancel).toHaveBeenCalledTimes(1);
    await flush();
    expect(c.onSelect).toHaveBeenCalledWith({ source: 7 }, expect.any(Array));
    b.onPointerDown!(ptr(10, 20));
    b.onPointerDrag!({ x: 12, y: 20 });
    b.onPointerUp!(null);
    expect(c.onDrop).not.toHaveBeenCalled();
    expect(c.onCancel).toHaveBeenCalledTimes(2);
  });
});

describe("Map mode's keys (§13)", () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
    mapKeyAction({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  it("V, H, F, Tab, Shift+Tab, Delete, Backspace, Escape", () => {
    expect(k("v")).toEqual({ kind: "select-tool" });
    expect(k("H")).toEqual({ kind: "toggle-overprint" });
    expect(k("f")).toEqual({ kind: "fit" });
    expect(k("Tab")).toEqual({ kind: "step", dir: 1 });
    expect(k("Tab", { shiftKey: true })).toEqual({ kind: "step", dir: -1 });
    expect(k("Delete")).toEqual({ kind: "hide" });
    expect(k("Backspace")).toEqual({ kind: "hide" });
    expect(k("Escape")).toEqual({ kind: "escape" });
  });

  it("a held Delete hides once: its auto-repeat is no gesture", () => {
    expect(mapKeyAction({ key: "Delete", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: true })).toBeNull();
  });

  it("Course mode's tool keys and modified keys are not Map mode's (course edits locked)", () => {
    for (const key of ["S", "K", "M", "X", "C", "A", "T", "G", "L", "1"]) expect(k(key)).toBeNull();
    expect(k("z", { ctrlKey: true })).toBeNull();
    expect(k("f", { metaKey: true })).toBeNull();
  });

  it("the rail is V alone", () => {
    expect(MAP_RAIL).toEqual(["V"]);
  });
});
