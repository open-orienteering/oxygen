import { describe, expect, it } from "vitest";
import { escapeCancels } from "../mouse-drag";

// F24 (docs/course-editor.md §3, §10 "Loupe"; user 2026-11-11): Escape cancels any mouse drag in flight before the cascade.
describe("Escape during a mouse drag (F24)", () => {
  const mouse = { touch: false }, finger = { touch: true };

  it("cancels the tool's gesture, a control's drag or a number's drag", () => {
    expect(escapeCancels({ tool: true, control: null, number: null })).toBe("tool");
    expect(escapeCancels({ tool: false, control: mouse, number: null })).toBe("control");
    expect(escapeCancels({ tool: false, control: null, number: mouse })).toBe("number");
  });

  it("the tool's gesture first: it took the press before the viewer's targets", () => {
    expect(escapeCancels({ tool: true, control: mouse, number: mouse })).toBe("tool");
    expect(escapeCancels({ tool: false, control: mouse, number: mouse })).toBe("control");
  });

  it("nothing without a drag, and never a touch drag (the cascade alone)", () => {
    expect(escapeCancels({ tool: false, control: null, number: null })).toBeNull();
    expect(escapeCancels({ tool: false, control: finger, number: null })).toBeNull();
    expect(escapeCancels({ tool: false, control: null, number: finger })).toBeNull();
  });
});
