import { describe, expect, it } from "vitest";
import { makePath } from "../pass-stream.js";
import { flattenRings, pointInRings, ringArea, strokeOutline } from "../geometry.js";
import { pathRings } from "../path.js";

/** Non-zero coverage of an outline: inside any of its (all counter-clockwise) rings. */
function covered(outline: ReturnType<typeof strokeOutline>, x: number, y: number): boolean {
  return flattenRings(outline).some((r) => pointInRings([r], x, y));
}

describe("strokeOutline", () => {
  const line = makePath([0, 0, 10000, 0]);

  it("has the full width between the tapers and none at the tips", () => {
    const o = strokeOutline(line, { widthUm: 400, join: "round", taper: { startUm: 1000, endUm: 1000 } });
    // middle: ±200
    expect(covered(o, 5000, 190)).toBe(true);
    expect(covered(o, 5000, -190)).toBe(true);
    expect(covered(o, 5000, 210)).toBe(false);
    // halfway through the start taper: ±100
    expect(covered(o, 500, 90)).toBe(true);
    expect(covered(o, 500, 110)).toBe(false);
    // halfway through the end taper
    expect(covered(o, 9500, -90)).toBe(true);
    expect(covered(o, 9500, -110)).toBe(false);
    // the taper ends exactly at its length (a vertex there, not a chord over the whole line)
    expect(covered(o, 1000, 195)).toBe(true);
    // butt: nothing past the ends
    expect(covered(o, -10, 0)).toBe(false);
    expect(covered(o, 10010, 0)).toBe(false);
  });

  it("returns counter-clockwise rings only, so non-zero filling is their union", () => {
    const zig = makePath([0, 0, 3000, 2000, 6000, 0, 9000, 2000]);
    const o = strokeOutline(zig, { widthUm: 500, join: "miter", taper: { endUm: 2000 } });
    for (const r of flattenRings(o)) expect(ringArea(r)).toBeGreaterThan(0);
    expect(pathRings(o).length).toBeGreaterThan(3);
    expect(o.closed).toBe(true);
  });

  it("covers the outside of a corner with the join (round, miter, bevel)", () => {
    const corner = makePath([0, 0, 5000, 0, 5000, 5000]);
    const opts = (join: "round" | "miter" | "bevel") => ({ widthUm: 1000, join, taper: { startUm: 1 } });
    // outer corner region at (5000 + 400, -400): inside the round join (r 500) and the mitre, outside the bevel
    expect(covered(strokeOutline(corner, opts("round")), 5300, -300)).toBe(true);
    expect(covered(strokeOutline(corner, opts("miter")), 5450, -450)).toBe(true);
    expect(covered(strokeOutline(corner, opts("bevel")), 5450, -450)).toBe(false);
    expect(covered(strokeOutline(corner, opts("bevel")), 5200, -200)).toBe(true);
  });

  it("keeps a Bézier a curve to the flattening tolerance", () => {
    const arc = makePath([0, 0, 0, 5523, 4477, 10000, 10000, 10000], [0, 1, 2, 0]);
    const o = strokeOutline(arc, { widthUm: 300, join: "round", taper: { startUm: 100, endUm: 100 } });
    // point on the curve at t = 0.5 is (2928.9, 7071.1) for this quarter circle approximation
    expect(covered(o, 2929, 7071)).toBe(true);
    expect(covered(o, 2929 - 300, 7071 + 300)).toBe(false);
  });

  it("measures the taper along the whole path, not per slice", () => {
    const o = strokeOutline(line, {
      widthUm: 400,
      join: "round",
      taper: { startUm: 4000 },
      slices: [
        { seg0: 0, t0: 0, seg1: 0, t1: 0.1 },
        { seg0: 0, t0: 0.2, seg1: 0, t1: 0.3 },
        { seg0: 0, t0: 0.5, seg1: 0, t1: 0.6 },
      ],
    });
    // gap between slices is empty
    expect(covered(o, 1500, 0)).toBe(false);
    // second slice at s = 2500 has width 400·2500/4000 = 250 → ±125
    expect(covered(o, 2500, 120)).toBe(true);
    expect(covered(o, 2500, 130)).toBe(false);
    // third slice is past the taper: full width
    expect(covered(o, 5500, 195)).toBe(true);
  });

  it("is deterministic integer µm", () => {
    const a = strokeOutline(line, { widthUm: 333, join: "round", taper: { startUm: 700, endUm: 300 } });
    const b = strokeOutline(line, { widthUm: 333, join: "round", taper: { startUm: 700, endUm: 300 } });
    expect(Array.from(a.coords)).toEqual(Array.from(b.coords));
    expect(a.coords).toBeInstanceOf(Int32Array);
  });
});
