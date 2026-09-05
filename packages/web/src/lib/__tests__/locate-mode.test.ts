import { describe, it, expect } from "vitest";
import { accuracyRadiusPx, nextLocateMode } from "../locate-mode";

describe("nextLocateMode", () => {
  it("toggles off → following → off", () => {
    expect(nextLocateMode("off", "toggle")).toBe("following");
    expect(nextLocateMode("following", "toggle")).toBe("off");
  });

  it("re-enables follow from located on toggle", () => {
    expect(nextLocateMode("located", "toggle")).toBe("following");
  });

  it("user gestures only break follow", () => {
    expect(nextLocateMode("following", "userGesture")).toBe("located");
    expect(nextLocateMode("located", "userGesture")).toBe("located");
    expect(nextLocateMode("off", "userGesture")).toBe("off");
  });

  it("errors always return to off", () => {
    expect(nextLocateMode("following", "error")).toBe("off");
    expect(nextLocateMode("located", "error")).toBe("off");
    expect(nextLocateMode("off", "error")).toBe("off");
  });
});

describe("accuracyRadiusPx", () => {
  it("converts meters to pixels", () => {
    expect(accuracyRadiusPx(20, 2)).toBe(10);
    expect(accuracyRadiusPx(5, 1)).toBe(5);
  });

  it("returns 0 for non-positive or non-finite inputs", () => {
    expect(accuracyRadiusPx(0, 2)).toBe(0);
    expect(accuracyRadiusPx(-1, 2)).toBe(0);
    expect(accuracyRadiusPx(10, 0)).toBe(0);
    expect(accuracyRadiusPx(Number.NaN, 2)).toBe(0);
    expect(accuracyRadiusPx(10, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
