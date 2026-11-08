/**
 * Reference fixture for the corridor geometry (docs/course-layer.md §10.2,
 * F20b): seeded corridor courses — straight and curved legs, narrow and
 * wide corridors, edged and not, with and without a band, starts turned,
 * a second course crossing or sharing legs, with and without the mouths —
 * run through `corridorGeometry` and compared with the result recorded on
 * the geometry before F20b's speed-ups. Every speed-up must reproduce it
 * bit for bit: the same inside and band rings, the same edge pieces and
 * the same openings, to the last floating-point digit. Each case is kept
 * as a SHA-256 of its canonical JSON plus a few counts (the counts say
 * where a mismatch lies; the hash is the proof).
 *
 * The cases are generated here (a seeded generator and a fixed-step cubic
 * sampler, independent of `course/bends.ts`), so a change to leg
 * flattening does not move them. Re-record only for an intended change
 * of the geometry:
 * `UPDATE_CORRIDOR_REFERENCE=1 pnpm --filter @oxygen/shared exec vitest run src/course/__tests__/corridor-reference.test.ts`
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { corridorGeometry, type CorridorGeometry, type CorridorMouths, type CorridorSite } from "../corridor.js";
import type { DerivedCourse, DerivedLeg } from "../types.js";
import type { MapPoint } from "../../course-maps/schema.js";
import { seeded } from "./drag-course.js";

const FILE = fileURLToPath(new URL("./__fixtures__/corridor-reference.json", import.meta.url));

/** ISOM 1:15 000 extents (§3.1): 703 R 2.5 mm, 706 outer ring 3.0 mm, 701 circumradius 6 / √3 mm. */
const EXTENTS = { circleUm: 2500, finishUm: 3000, startUm: 6000 / Math.sqrt(3) };

/** A cubic from a to b through two control points, sampled at `steps` equal parameter steps. */
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

interface Case { name: string; courses: DerivedCourse[]; mouths?: CorridorMouths }

const WIDTHS = [2, 10 / 3, 4, 5, 6, 8];
const WHITES = [0, 0, 3, 5];

/** A course of `n` legs through seeded sites; its legs curved or straight, each with or without a corridor. */
function courseOf(r: () => number, id: string, sites: CorridorSite[], order: number[], uniform: boolean): DerivedCourse {
  const width = WIDTHS[Math.floor(r() * WIDTHS.length)], white = WHITES[Math.floor(r() * WHITES.length)], edge = r() < 0.7;
  const legs: DerivedLeg[] = [];
  for (let i = 1; i < order.length; i++) {
    const a = sites[order[i - 1]], b = sites[order[i]];
    const dx = b.x - a.x, dy = b.y - a.y;
    const bow = (r() - 0.5) * 0.8;
    const points = r() < 0.7
      ? cubic(a, { x: a.x + dx / 3 - dy * bow, y: a.y + dy / 3 + dx * bow }, { x: a.x + (2 * dx) / 3 - dy * bow, y: a.y + (2 * dy) / 3 + dx * bow }, b, 6 + Math.floor(r() * 50))
      : r() < 0.5 ? [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] : [{ x: a.x, y: a.y }, { x: a.x + dx / 2 + dy * bow, y: a.y + dy / 2 - dx * bow }, { x: b.x, y: b.y }];
    const has = uniform || r() < 0.8;
    const corridor = !has ? undefined : uniform ? { widthMm: width, whiteMm: white, edge } : { widthMm: WIDTHS[Math.floor(r() * WIDTHS.length)], whiteMm: WHITES[Math.floor(r() * WHITES.length)], edge: r() < 0.7 };
    legs.push({ from: a.id, to: b.id, points, style: "line", gaps: [], pieces: [points], ...(corridor ? { corridor } : {}) });
  }
  return { id, orderMode: "ordered", sequence: [], legs };
}

function caseOf(seed: number): Case {
  const r = seeded(seed);
  const n = 3 + Math.floor(r() * 14);
  const span = 40 + r() * 120;
  const sites: CorridorSite[] = [];
  for (let i = 0; i < n; i++) {
    const role: CorridorSite["role"] = i === 0 ? "start" : i === n - 1 ? "finish" : "control";
    sites.push({ id: `s${i}`, role, x: Math.round(r() * span * 100) / 100, y: Math.round(r() * span * 100) / 100, ...(i === 0 && r() < 0.6 ? { angleDeg: Math.round(r() * 3600) / 10 } : {}) });
  }
  const order = sites.map((_, i) => i);
  const courses = [courseOf(r, "a", sites, order, r() < 0.5)];
  // A second course: the same sites in another order (crossing corridors), or the first legs again (shared, other width).
  const k = r();
  if (k < 0.3) {
    const shuffled = [...order];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    courses.push(courseOf(r, "b", sites, shuffled, r() < 0.5));
  }
  else if (k < 0.45) courses.push(courseOf(r, "b", sites, order.slice(0, Math.max(2, Math.floor(n / 2))), true));
  // A site no leg ends at (a passing corridor leaves it whole).
  if (r() < 0.3) sites.push({ id: "pass", role: "control", x: courses[0].legs[0].points[1]?.x ?? 0, y: courses[0].legs[0].points[1]?.y ?? 0 });
  const mouths = r() < 0.85 ? { sites, ...EXTENTS } : undefined;
  return { name: `seed ${seed}`, courses, ...(mouths ? { mouths } : {}) };
}

/** Hand-made cases on the decision boundaries of §10.2: h = R, a lone leg, a one-point run, a 701 corridor wider than the triangle. */
function edgeCases(): Case[] {
  const P = (x: number, y: number): MapPoint => ({ x, y });
  const leg = (from: string, to: string, points: MapPoint[], widthMm: number, whiteMm: number, edge: boolean): DerivedLeg => ({ from, to, points, style: "line", gaps: [], pieces: [points], corridor: { widthMm, whiteMm, edge } });
  const sites = (pts: MapPoint[], roles: CorridorSite["role"][], angleDeg?: number): CorridorSite[] => pts.map((p, i) => ({ id: `${i}`, role: roles[i], ...p, ...(i === 0 && angleDeg !== undefined ? { angleDeg } : {}) }));
  const A = P(0, 0), B = P(20, 0), C = P(30, 15);
  const course = (legs: DerivedLeg[]): DerivedCourse => ({ id: "c", orderMode: "ordered", sequence: [], legs });
  return [
    { name: "h = R", courses: [course([leg("0", "1", [A, B], 5, 3, true)])], mouths: { sites: sites([A, B], ["control", "control"]), ...EXTENTS } },
    { name: "lone wide leg, closed edge", courses: [course([leg("0", "1", [A, B], 8, 0, true)])], mouths: { sites: sites([A, B], ["control", "control"]), ...EXTENTS } },
    { name: "one-point run", courses: [course([leg("0", "1", [A, A], 4, 3, true)])], mouths: { sites: sites([A, A], ["control", "control"]), ...EXTENTS } },
    { name: "701 wider than the triangle", courses: [course([leg("0", "1", [A, B], 9, 2, true), leg("1", "2", [B, C], 4, 2, true)])], mouths: { sites: sites([A, B, C], ["start", "control", "finish"], 30), ...EXTENTS } },
    { name: "edged meets unedged at a turn", courses: [course([leg("0", "1", [A, B], 4, 3, true), leg("1", "2", [B, C], 4, 3, false)])], mouths: { sites: sites([A, B, C], ["start", "control", "finish"]), ...EXTENTS } },
    { name: "reversal", courses: [course([leg("0", "1", [A, B], 3, 3, true), leg("1", "2", [B, A], 3, 3, true)])], mouths: { sites: sites([A, B, A], ["control", "control", "control"]), ...EXTENTS } },
  ];
}

const CASES: Case[] = [...edgeCases(), ...Array.from({ length: 60 }, (_, i) => caseOf(1000 + i))];

interface Recorded { name: string; sha256: string; inside: number; band: number; edges: number; openings: number }

/** The geometry as canonical JSON: rings, edges in order, openings by site id. */
function canonical(g: CorridorGeometry | null): string {
  if (!g) return "null";
  return JSON.stringify({ inside: g.inside, band: g.band, edges: g.edges, openings: [...g.openings.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) });
}

function record(c: Case): Recorded {
  const g = corridorGeometry(c.courses, c.mouths);
  const count = (rings: readonly { length: number }[] | null | undefined) => (rings ?? []).reduce((s, r) => s + r.length, 0);
  return {
    name: c.name,
    sha256: createHash("sha256").update(canonical(g)).digest("hex"),
    inside: count(g?.inside),
    band: count(g?.band),
    edges: (g?.edges ?? []).reduce((s, e) => s + e.points.length, 0),
    openings: [...(g?.openings.values() ?? [])].reduce((s, l) => s + l.length, 0),
  };
}

describe("corridor geometry reference (F20b): bit-identical to the pre-F20b result", () => {
  if (process.env.UPDATE_CORRIDOR_REFERENCE) {
    it("records the reference", () => {
      mkdirSync(dirname(FILE), { recursive: true });
      writeFileSync(FILE, JSON.stringify(CASES.map(record), null, 1) + "\n");
    });
    return;
  }

  it("the fixture exists and covers the shapes: openings, bands, edges, two courses", () => {
    expect(existsSync(FILE)).toBe(true);
    const ref = JSON.parse(readFileSync(FILE, "utf8")) as Recorded[];
    expect(ref).toHaveLength(CASES.length);
    expect(ref.filter((r) => r.openings > 0).length).toBeGreaterThan(10);
    expect(ref.filter((r) => r.band > 0).length).toBeGreaterThan(10);
    expect(ref.filter((r) => r.edges > 0).length).toBeGreaterThan(10);
    expect(CASES.filter((c) => c.courses.length > 1).length).toBeGreaterThan(10);
  });

  const ref = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Recorded[]) : [];
  it.each(CASES.map((c, i) => [c.name, i] as const))("%s", (_, i) => {
    expect(record(CASES[i])).toEqual(ref[i]);
  });
});
