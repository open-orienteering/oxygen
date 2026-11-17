import { describe, expect, it } from "vitest";
import { circularDev, concentration } from "../interval.js";
import { seeded } from "./synthetic-dem.js";

const I = 5;
const f64 = (a: number[]) => new Float64Array(a);
const ones = (n: number) => new Float64Array(n).fill(1);

describe("interval concentration (§6.5)", () => {
  it("one ladder concentrates at I and recovers its phase", () => {
    const m = f64([2.6, 7.6, 12.6, 17.6, 42.6]);
    const r = concentration(m, ones(m.length), I);
    expect(r.r).toBeCloseTo(1, 6);
    expect(r.phase).toBeCloseTo(2.6, 6);
  });

  it("two ladders half an interval apart cancel at I and concentrate at I/2", () => {
    const m = f64([2.6, 7.6, 12.6, 0.1, 5.1, 10.1]);
    expect(concentration(m, ones(6), I).r).toBeLessThan(0.05);
    expect(concentration(m, ones(6), I / 2).r).toBeCloseTo(1, 6);
  });

  it("weights by length and ignores zero weights", () => {
    const m = f64([1, 3.5, 99]);
    const r = concentration(m, f64([3, 1, 0]), I);
    expect(r.r).toBeCloseTo(0.5, 6);
    expect(r.phase).toBeCloseTo(1, 6);
  });

  it("noise lowers R but keeps the phase", () => {
    const rnd = seeded(7);
    const m = new Float64Array(400).map((_, i) => 1.2 + I * (i % 9) + (rnd() - 0.5) * 1.5);
    const r = concentration(m, ones(m.length), I);
    expect(r.r).toBeGreaterThan(0.7);
    expect(r.r).toBeLessThan(1);
    expect(r.phase).toBeCloseTo(1.2, 1);
  });

  it("is zero without weight", () => {
    expect(concentration(f64([]), f64([]), I)).toEqual({ r: 0, phase: 0 });
  });
});

describe("circular deviation", () => {
  it("wraps into (−I/2, I/2]", () => {
    expect(circularDev(10.1, 0.1, I)).toBeCloseTo(0);
    expect(circularDev(0.05, 4.95, I)).toBeCloseTo(0.1);
    expect(circularDev(4.9, 0.1, I)).toBeCloseTo(-0.2);
    expect(circularDev(2.6, 0.1, I)).toBeCloseTo(2.5);
  });
});
