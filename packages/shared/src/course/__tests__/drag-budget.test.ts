/**
 * Loose time budgets for the control-drag path (docs/bugfix-course-drag-redraw.md,
 * docs/course-layer.md §10.2): every pointer move of a drag re-derives the
 * course in the worker, so the derivation of a 25-control course with smooth
 * bends must stay well under a second. Before F20 the number placer alone took
 * 350–380 ms here (each candidate box against all ~860 leg segments
 * left after the cuts); culled it
 * takes tens. The budgets are loose on purpose — they catch the quadratic
 * coming back, not a slow machine.
 */

import { describe, expect, it } from "vitest";
import { placeControlLabels } from "../../course-maps/control-label-placement.js";
import { corridorGeometry } from "../corridor.js";
import { polylineLegGaps } from "../cuts.js";
import { deriveCourse } from "../derive.js";
import { courseLayer } from "../layer.js";
import { DRAG_METRICS, dragCourse, dragMouths, placementInput } from "./drag-course.js";

/** Median of `reps` timed runs after one warm-up. */
function medianMs(fn: () => unknown, reps = 3): number {
  fn();
  const ts: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return ts.sort((a, b) => a - b)[Math.floor(reps / 2)];
}

describe("drag budgets (F20): 25 controls, one smooth bend per leg, 3000 cut features", () => {
  const input = dragCourse();
  const derivation = deriveCourse(input, DRAG_METRICS);
  const { circles, lines } = placementInput(derivation);

  it("the fixture has the shape that regressed: over 800 leg segments after the cuts", () => {
    expect(circles.filter((c) => c.label)).toHaveLength(25);
    expect(lines.length).toBeGreaterThan(800);
  });

  it("placeControlLabels < 400 ms", () => {
    const opts = { radius: DRAG_METRICS.circleRadiusMm, labelSize: DRAG_METRICS.numberEmMm };
    expect(medianMs(() => placeControlLabels(circles, lines, opts))).toBeLessThan(400);
  });

  it("deriveCourse < 500 ms", () => {
    expect(medianMs(() => deriveCourse(input, DRAG_METRICS))).toBeLessThan(500);
  });
});

describe("drag budgets on a corridor course (F20b): the same course, a 50 m edged corridor with a 5 mm band on every leg", () => {
  const input = dragCourse({ corridor: { widthM: 50, edge: true, whiteMm: 5 } });
  const derivation = deriveCourse(input, DRAG_METRICS);
  const mouths = dragMouths(derivation);
  const legs = derivation.courses[0].legs.map((l) => l.points);

  it("the fixture is one run with mouths and openings", () => {
    const g = corridorGeometry(derivation.courses, mouths)!;
    expect(g.inside).toHaveLength(1);
    expect(g.band).not.toBeNull();
    expect(g.openings.size).toBe(25);
  });

  it("polylineLegGaps over every leg at 3000 features < 15 ms (25 ms before the prefilter)", () => {
    expect(medianMs(() => legs.forEach((p) => polylineLegGaps(p, input.cutFeatures!, DRAG_METRICS.circleRadiusMm, DRAG_METRICS.lineWidthMm)))).toBeLessThan(15);
  });

  it("corridorGeometry < 600 ms, each call a new course (a control drag)", () => {
    // Moving one site by a hair each run defeats the kept result: what a control drag pays per move.
    let k = 0;
    const moved = () => {
      const d = structuredClone(derivation);
      d.courses[0].legs[3].points[0].x += ++k * 1e-6;
      return d;
    };
    expect(medianMs(() => corridorGeometry(moved().courses, mouths))).toBeLessThan(600);
  });

  it("corridorGeometry again on the same course (a number or object drag) < 20 ms: the kept result", () => {
    corridorGeometry(derivation.courses, mouths);
    expect(medianMs(() => corridorGeometry(derivation.courses, mouths))).toBeLessThan(20);
  });

  it("courseLayer < 1000 ms", () => {
    let k = 0;
    expect(medianMs(() => {
      const i = structuredClone(input);
      i.sites[5].x += ++k * 1e-4;
      return courseLayer(i);
    })).toBeLessThan(1000);
  });
});
