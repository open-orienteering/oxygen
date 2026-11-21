import { describe, expect, it, vi } from "vitest";
import { createHoverDotStore } from "../hover-dot";

describe("the hover dot's store (docs/course-elevation.md §5)", () => {
  it("tells its listeners of a new place, not of the same one; an unsubscribed listener hears nothing", () => {
    const store = createHoverDotStore();
    const heard = vi.fn();
    const off = store.subscribe(heard);
    expect(store.get()).toBeNull();
    store.set({ x: 1, y: 2, leg: 0 });
    store.set({ x: 1, y: 2, leg: 0 });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ x: 1, y: 2, leg: 0 });
    store.set(null);
    store.set(null);
    expect(heard).toHaveBeenCalledTimes(2);
    off();
    store.set({ x: 3, y: 4, leg: 1 });
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
