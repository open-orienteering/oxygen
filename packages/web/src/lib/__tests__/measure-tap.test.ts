import { describe, it, expect } from "vitest";
import {
  shouldSuppressSyntheticMouse,
  isMeasureTap,
  SYNTHETIC_MOUSE_SUPPRESS_MS,
  MEASURE_TAP_MAX_PAN_PX,
} from "../measure-tap";

describe("shouldSuppressSyntheticMouse", () => {
  it("does not suppress when there was no recent touch", () => {
    expect(shouldSuppressSyntheticMouse(1000, null)).toBe(false);
  });

  it("suppresses within the window after a touchend", () => {
    expect(
      shouldSuppressSyntheticMouse(1000, 1000 - SYNTHETIC_MOUSE_SUPPRESS_MS + 1),
    ).toBe(true);
  });

  it("allows mouse placement after the suppress window", () => {
    expect(
      shouldSuppressSyntheticMouse(1000, 1000 - SYNTHETIC_MOUSE_SUPPRESS_MS),
    ).toBe(false);
  });
});

describe("isMeasureTap", () => {
  it("accepts a stationary finger and viewport", () => {
    expect(
      isMeasureTap({ fingerMovementPx: 2, viewportCenterDeltaPx: 1 }),
    ).toBe(true);
  });

  it("rejects when the viewport panned", () => {
    expect(
      isMeasureTap({
        fingerMovementPx: 1,
        viewportCenterDeltaPx: MEASURE_TAP_MAX_PAN_PX + 1,
      }),
    ).toBe(false);
  });

  it("rejects when the finger wandered", () => {
    expect(
      isMeasureTap({
        fingerMovementPx: MEASURE_TAP_MAX_PAN_PX + 1,
        viewportCenterDeltaPx: 0,
      }),
    ).toBe(false);
  });
});
