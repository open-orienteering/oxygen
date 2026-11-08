/**
 * Reference fixture for the automatic leg cuts (docs/course-layer.md
 * §3.4, F20b): seeded legs — straight, bent and curved, short and long —
 * over seeded cut features (sparse and in clusters, with and without a
 * radius, on the line, near its ends, at a bend) through
 * `polylineLegGaps`, and the same features round seeded circles through
 * `circleCuts`, compared with the result recorded before F20b's feature
 * prefilter. The prefilter must reproduce it bit for bit.
 *
 * The cases are generated here (a seeded generator and a fixed-step cubic
 * sampler, independent of `course/bends.ts`). Re-record only for an
 * intended change of the cuts:
 * `UPDATE_CUTS_REFERENCE=1 pnpm --filter @oxygen/shared exec vitest run src/course/__tests__/cuts-reference.test.ts`
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { circleCuts, polylineLegGaps } from "../cuts.js";
import type { CutFeature } from "../types.js";
import type { MapPoint } from "../../course-maps/schema.js";
import { seeded } from "./drag-course.js";

const FILE = fileURLToPath(new URL("./__fixtures__/cuts-reference.json", import.meta.url));

function cubic(a: MapPoint, c1: MapPoint, c2: MapPoint, b: MapPoint, steps: number): MapPoint[] {
  const out: MapPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    out.push({
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    });
  }
  return out;
}

interface Case { name: string; legs: MapPoint[][]; features: CutFeature[]; radiusMm: number; lineWidthMm: number }

function caseOf(seed: number): Case {
  const r = seeded(seed);
  const span = 20 + r() * 200;
  const legs: MapPoint[][] = [];
  for (let i = 0; i < 12; i++) {
    const a = { x: r() * span, y: r() * span }, b = { x: r() * span, y: r() * span };
    const dx = b.x - a.x, dy = b.y - a.y, bow = (r() - 0.5) * 0.8;
    const k = r();
    legs.push(k < 0.3 ? [a, b]
      : k < 0.5 ? [a, { x: a.x + dx / 2 + dy * bow, y: a.y + dy / 2 - dx * bow }, b]
      : cubic(a, { x: a.x + dx / 3 - dy * bow, y: a.y + dy / 3 + dx * bow }, { x: a.x + (2 * dx) / 3 - dy * bow, y: a.y + (2 * dy) / 3 + dx * bow }, b, 4 + Math.floor(r() * 80)));
  }
  const features: CutFeature[] = [];
  const count = Math.floor(r() * 2000);
  for (let i = 0; i < count; i++) features.push({ x: r() * span, y: r() * span, ...(r() < 0.8 ? { r: 0.1 + r() * 0.6 } : {}) });
  // Features on the legs themselves: on a vertex, beside a segment, in a cluster that hits the 70 % cap.
  for (const leg of legs) {
    for (let j = 0; j < 4; j++) {
      const p = leg[Math.floor(r() * leg.length)];
      const n = r() < 0.2 ? 30 : 1;
      for (let m = 0; m < n; m++) features.push({ x: p.x + (r() - 0.5) * (n > 1 ? 20 : 1.5), y: p.y + (r() - 0.5) * (n > 1 ? 20 : 1.5), ...(r() < 0.5 ? { r: 0.25 } : {}) });
    }
  }
  return { name: `seed ${seed}`, legs, features, radiusMm: r() < 0.5 ? 2.5 : 2.5 + r() * 3, lineWidthMm: r() < 0.5 ? 0.35 : 0.2 + r() * 0.6 };
}

const CASES: Case[] = Array.from({ length: 40 }, (_, i) => caseOf(500 + i));

interface Recorded { name: string; legs: ReturnType<typeof polylineLegGaps>[]; circles: ReturnType<typeof circleCuts>[] }

function record(c: Case): Recorded {
  return {
    name: c.name,
    legs: c.legs.map((pts) => polylineLegGaps(pts, c.features, c.radiusMm, c.lineWidthMm)),
    circles: c.legs.map((pts) => circleCuts(c.features, pts[0].x, pts[0].y, c.radiusMm, c.lineWidthMm)),
  };
}

describe("cuts reference (F20b): bit-identical to the pre-F20b result", () => {
  if (process.env.UPDATE_CUTS_REFERENCE) {
    it("records the reference", () => {
      mkdirSync(dirname(FILE), { recursive: true });
      writeFileSync(FILE, JSON.stringify(CASES.map(record)) + "\n");
    });
    return;
  }

  const ref = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Recorded[]) : [];

  it("the fixture exists and has gaps on most cases", () => {
    expect(ref).toHaveLength(CASES.length);
    expect(ref.flatMap((r) => r.legs).filter((g) => g.length > 0).length).toBeGreaterThan(100);
    expect(ref.flatMap((r) => r.circles).filter((g) => g.length > 0).length).toBeGreaterThan(20);
  });

  it.each(CASES.map((c, i) => [c.name, i] as const))("%s", (_, i) => {
    expect(record(CASES[i])).toEqual(ref[i]);
  });
});
