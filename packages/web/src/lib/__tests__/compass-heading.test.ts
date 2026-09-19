import { describe, it, expect } from "vitest";
import {
  headingFromOrientation,
  nextNeedleAngle,
  normalizeHeading,
} from "../compass-heading";

describe("normalizeHeading", () => {
  it("wraps into [0, 360)", () => {
    expect(normalizeHeading(0)).toBe(0);
    expect(normalizeHeading(360)).toBe(0);
    expect(normalizeHeading(-90)).toBe(270);
    expect(normalizeHeading(725)).toBe(5);
  });
});

describe("headingFromOrientation", () => {
  it("prefers webkitCompassHeading (iOS) when present", () => {
    // iOS reports degrees clockwise from north directly; alpha is
    // relative-only there and must be ignored.
    expect(
      headingFromOrientation({ alpha: 123, absolute: false, webkitCompassHeading: 45 }),
    ).toBe(45);
  });

  it("converts absolute alpha (Android) — alpha is counter-clockwise from north", () => {
    expect(headingFromOrientation({ alpha: 0, absolute: true })).toBe(0);
    expect(headingFromOrientation({ alpha: 90, absolute: true })).toBe(270);
    expect(headingFromOrientation({ alpha: 270, absolute: true })).toBe(90);
  });

  it("returns null for relative alpha with no compass heading", () => {
    // A plain `deviceorientation` event on Android is relative to an
    // arbitrary reference frame; pointing the needle at it would be wrong.
    expect(headingFromOrientation({ alpha: 90, absolute: false })).toBeNull();
    expect(headingFromOrientation({ alpha: 90 })).toBeNull();
  });

  it("returns null when there is no usable value", () => {
    expect(headingFromOrientation({ alpha: null, absolute: true })).toBeNull();
    expect(headingFromOrientation({ alpha: NaN, absolute: true })).toBeNull();
    expect(
      headingFromOrientation({ alpha: null, absolute: false, webkitCompassHeading: NaN }),
    ).toBeNull();
  });

  it("compensates for screen rotation", () => {
    // Device physically points north (alpha 0) but the screen is rotated
    // 90° into landscape: the top of the *screen* now points east.
    expect(headingFromOrientation({ alpha: 0, absolute: true }, 90)).toBe(90);
    expect(headingFromOrientation({ alpha: 0, webkitCompassHeading: 350 }, 90)).toBe(80);
    expect(headingFromOrientation({ alpha: 0, absolute: true }, 270)).toBe(270);
  });
});

describe("nextNeedleAngle", () => {
  it("points the needle at -heading so north stays north on screen", () => {
    expect(nextNeedleAngle(0, 0)).toBe(0);
    expect(nextNeedleAngle(0, 90)).toBe(-90);
  });

  it("takes the short way round across the 0/360 seam", () => {
    // Needle at -350 (≡ +10° on screen, heading 350). Heading ticks to 10:
    // naive target is -10, a 340° swing. The needle should move -20 instead.
    expect(nextNeedleAngle(-350, 10)).toBe(-370);
    // …and back again.
    expect(nextNeedleAngle(-370, 350)).toBe(-350);
  });

  it("accumulates beyond ±360 rather than snapping", () => {
    // Spinning the phone twice clockwise keeps the needle turning smoothly.
    let angle = 0;
    for (let h = 0; h < 720; h += 30) angle = nextNeedleAngle(angle, h % 360);
    expect(angle).toBe(-690);
  });

  it("is a no-op when the heading has not changed", () => {
    expect(nextNeedleAngle(-1000, 280)).toBe(-1000);
  });
});
