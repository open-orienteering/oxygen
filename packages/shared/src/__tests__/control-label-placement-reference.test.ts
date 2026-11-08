/**
 * Reference fixture for the control-number placer (docs/course-layer.md
 * §3.5, F20): seeded clusters of circles and curved legs, placed by
 * `placeControlLabels` and compared with the result recorded on the
 * pre-F20 placer (every segment tested against every candidate). The
 * F20 cull — each circle tests only the segments within reach of its
 * candidate boxes — must reproduce it bit for bit: same boxes, same
 * leaders, same `collides`, to the last floating-point digit.
 *
 * The cases are generated here (a seeded generator and a fixed-step
 * cubic sampler, independent of `course/bends.ts`), so a change to leg
 * flattening does not move them. Re-record only for an intended change
 * of the placer's result:
 * `UPDATE_PLACEMENT_REFERENCE=1 pnpm --filter @oxygen/shared exec vitest run src/__tests__/control-label-placement-reference.test.ts`
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  placeControlLabels,
  type PlacedControlLabel,
  type PlacementCircle,
  type PlacementOpts,
  type PlacementSeg,
} from "../course-maps/control-label-placement.js";
import { seeded } from "../course/__tests__/drag-course.js";

const FILE = fileURLToPath(new URL("./__fixtures__/control-label-placement-reference.json", import.meta.url));

interface Pt { x: number; y: number }

/** A cubic from a to b through two control points, sampled at `steps` equal parameter steps. */
function cubic(a: Pt, c1: Pt, c2: Pt, b: Pt, steps: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    out.push({
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    });
  }
  return out;
}

interface Case { name: string; circles: PlacementCircle[]; lines: PlacementSeg[]; opts: PlacementOpts }

/** One course through `n` circles: dense to sparse, curved and straight legs, finish rings, manual numbers, slash labels. */
function course(seed: number, scale = 1): Case {
  const r = seeded(seed);
  const n = 6 + Math.floor(r() * 28);
  const span = 40 + r() * 220;
  const circles: PlacementCircle[] = [];
  for (let i = 0; i < n; i++) {
    const c: PlacementCircle = { id: `c${i}`, x: r() * span * scale, y: r() * span * scale };
    if (i === 0 || i === n - 1) c.radius = (i === 0 ? 3.46 : 3.5) * scale;
    else {
      const k = r();
      c.label = k < 0.25 ? String(31 + i) : k < 0.35 ? `${1 + i}/${12 + i}` : k < 0.4 ? "" : String(1 + i);
      if (c.label && r() < 0.1) c.fixedLabel = { x: c.x + 4 * scale, y: c.y - 4 * scale };
    }
    circles.push(c);
  }
  const lines: PlacementSeg[] = [];
  for (let i = 1; i < n; i++) {
    const a = circles[i - 1], b = circles[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const bow = (r() - 0.5) * 0.8;
    const pts = r() < 0.75
      ? cubic(a, { x: a.x + dx / 3 - dy * bow, y: a.y + dy / 3 + dx * bow }, { x: a.x + (2 * dx) / 3 - dy * bow, y: a.y + (2 * dy) / 3 + dx * bow }, b, 8 + Math.floor(r() * 60))
      : [a, b];
    for (let k = 1; k < pts.length; k++) lines.push({ x1: pts[k - 1].x, y1: pts[k - 1].y, x2: pts[k].x, y2: pts[k].y });
  }
  // A few legs of another course on the same screen (MapViewer's "all courses").
  if (r() < 0.3) {
    for (let j = 0; j < 4; j++) {
      const x = r() * span * scale, y = r() * span * scale;
      lines.push({ x1: x, y1: y, x2: x + (r() - 0.5) * 60 * scale, y2: y + (r() - 0.5) * 60 * scale });
    }
  }
  return { name: `course ${seed}${scale === 1 ? "" : ` ×${scale}`}`, circles, lines, opts: { radius: (2 + r() * 1.5) * scale, labelSize: (2.5 + r() * 3) * scale } };
}

/** A tight cluster under a hatch of lines: every candidate near a segment, the soft line cost and the hard line test both decide. */
function hatch(seed: number): Case {
  const r = seeded(seed);
  const circles: PlacementCircle[] = Array.from({ length: 9 }, (_, i) => ({ id: `h${i}`, x: 20 + r() * 25, y: 20 + r() * 25, label: String(40 + i) }));
  const lines: PlacementSeg[] = [];
  for (let k = 0; k < 40; k++) {
    const y = 5 + k * 1.6 + r();
    lines.push({ x1: 0, y1: y, x2: 70, y2: y + (r() - 0.5) * 6 });
  }
  return { name: `hatch ${seed}`, circles, lines, opts: { radius: 2.5, labelSize: 3.5 } };
}

/** Segments far off the cluster (all culled) and one degenerate, zero-length segment on a candidate. */
function farAndDegenerate(): Case {
  const circles: PlacementCircle[] = [
    { id: "a", x: 0, y: 0, label: "31" },
    { id: "b", x: 9, y: 2, label: "32" },
  ];
  const lines: PlacementSeg[] = [
    { x1: 1000, y1: 1000, x2: 1100, y2: 1000 },
    { x1: -500, y1: 40, x2: 500, y2: 40 },
    { x1: 7.2, y1: -3.1, x2: 7.2, y2: -3.1 },
    { x1: 0, y1: 0, x2: 9, y2: 2 },
  ];
  return { name: "far and degenerate", circles, lines, opts: { radius: 2.5, labelSize: 3.5 } };
}

function cases(): Case[] {
  const out: Case[] = [];
  for (let seed = 1; seed <= 64; seed++) out.push(course(seed));
  for (const seed of [3, 17, 29]) out.push(course(seed, 1000), course(seed, 0.01));
  for (let seed = 101; seed <= 106; seed++) out.push(hatch(seed));
  out.push(farAndDegenerate());
  return out;
}

const result = (m: Map<string, PlacedControlLabel>) => [...m.entries()];

describe("placeControlLabels reference (F20: the cull keeps the result bit-identical)", () => {
  const all = cases().map((c) => ({ name: c.name, placed: result(placeControlLabels(c.circles, c.lines, c.opts)) }));

  if (process.env.UPDATE_PLACEMENT_REFERENCE) {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, `[\n${all.map((c) => JSON.stringify(c)).join(",\n")}\n]\n`);
  }

  it("the fixture exists and holds every case", () => {
    expect(existsSync(FILE), "missing fixture — see the header of this file").toBe(true);
    const ref = JSON.parse(readFileSync(FILE, "utf8")) as { name: string }[];
    expect(ref.map((c) => c.name)).toEqual(all.map((c) => c.name));
  });

  it("the cases exercise the line tests: some numbers collide, some carry leaders", () => {
    const placed = all.flatMap((c) => c.placed.map(([, p]) => p));
    expect(placed.length).toBeGreaterThan(800);
    expect(placed.some((p) => p.collides)).toBe(true);
    expect(placed.some((p) => p.leader)).toBe(true);
  });

  it("every case equals the recorded result exactly", () => {
    const ref = JSON.parse(readFileSync(FILE, "utf8")) as { name: string; placed: unknown }[];
    // JSON writes a double in its shortest round-trip form, so equal strings are equal bits (the sign of a zero aside).
    for (let i = 0; i < all.length; i++) expect(JSON.stringify(all[i].placed), all[i].name).toBe(JSON.stringify(ref[i].placed));
  });
});
