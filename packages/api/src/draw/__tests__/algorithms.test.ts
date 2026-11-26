import { describe, it, expect } from "vitest";
import {
  randomDraw,
  clubSeparationDraw,
  seededDraw,
  simultaneousDraw,
  type DrawRunner,
} from "../algorithms.js";
import { mulberry32, classRng } from "../rng.js";

function runners(n: number): DrawRunner[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    name: `Runner ${i}`,
    clubId: (i % 5) + 1,
    clubName: `Club ${(i % 5) + 1}`,
    startNo: 0,
    rank: i % 3 === 0 ? i : 0,
  }));
}

const ids = (rs: DrawRunner[]) => rs.map((r) => r.id);

const algorithms = {
  random: (rs: DrawRunner[], seed: number) => randomDraw(rs, mulberry32(seed)),
  clubSeparation: (rs: DrawRunner[], seed: number) => clubSeparationDraw(rs, mulberry32(seed)),
  seeded: (rs: DrawRunner[], seed: number) =>
    seededDraw(rs, mulberry32(seed), { clubSeparation: true }),
  simultaneous: (rs: DrawRunner[], seed: number) => simultaneousDraw(rs, mulberry32(seed)),
};

describe("draw algorithms are reproducible from a seed (RES-15)", () => {
  for (const [name, draw] of Object.entries(algorithms)) {
    it(`${name}: same seed, same order`, () => {
      const input = runners(30);
      expect(ids(draw(input, 1234))).toEqual(ids(draw(input, 1234)));
    });

    it(`${name}: the result is a permutation of the input`, () => {
      const input = runners(30);
      expect([...ids(draw(input, 99))].sort()).toEqual([...ids(input)].sort());
    });

    if (name !== "seeded") {
      it(`${name}: a different seed gives a different order`, () => {
        const input = runners(30);
        expect(ids(draw(input, 1))).not.toEqual(ids(draw(input, 2)));
      });
    }
  }
});

describe("rng", () => {
  it("mulberry32 returns floats in [0, 1)", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("classRng gives each class its own stream", () => {
    const a = classRng(7, 1);
    const b = classRng(7, 2);
    const a2 = classRng(7, 1);
    const seqA = [a(), a(), a()];
    expect([b(), b(), b()]).not.toEqual(seqA);
    expect([a2(), a2(), a2()]).toEqual(seqA);
  });
});
