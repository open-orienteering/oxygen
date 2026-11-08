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
import { deriveCourse } from "../derive.js";
import { DRAG_METRICS, dragCourse, placementInput } from "./drag-course.js";

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
