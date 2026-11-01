/** `course:backfill-structure` arguments and output (docs/course-layer.md §6.4). */

import { describe, expect, it } from "vitest";
import { parseCourseBackfillArgs, formatCourseLine, formatCourseSummary } from "../cli/course-backfill-args.js";

describe("parseCourseBackfillArgs", () => {
  it("defaults, flags, inline values", () => {
    expect(parseCourseBackfillArgs([])).toEqual({ ok: true, value: { event: null, dryRun: false, out: null } });
    expect(parseCourseBackfillArgs(["--event", "x", "--dry-run", "--out=.local/r"])).toEqual({ ok: true, value: { event: "x", dryRun: true, out: ".local/r" } });
  });

  it("refuses unknown flags and missing values", () => {
    expect(parseCourseBackfillArgs(["--nope"])).toMatchObject({ ok: false });
    expect(parseCourseBackfillArgs(["--event"])).toMatchObject({ ok: false });
    expect(parseCourseBackfillArgs(["--out"])).toMatchObject({ ok: false });
  });
});

describe("output", () => {
  const head = { courseId: "c", event: "ev", name: "A", source: "ocd" };

  it("one line per outcome, with the comparison", () => {
    expect(formatCourseLine({ ...head, outcome: "failed", error: "boom" }, 1, 3)).toBe("[1/3] ev / A (ocd) → FAILED: boom");
    expect(formatCourseLine({ ...head, outcome: "skipped" }, 2, 3)).toContain("skipped");
    const line = formatCourseLine(
      { ...head, outcome: "filled", items: 5, circleGapControls: 2, legGaps: 1, objects: 3, comparison: { bboxDeltaMm: 0, positionDeltaMm: 0.0004, controls: 3, circles: { compared: 3, same: 3 }, legs: { pieces: 4, withGaps: 1 } } },
      3, 3,
    );
    expect(line).toBe("[3/3] ev / A (ocd) → filled: 5 sites, 2 circle cut(s), 1 leg gap(s), 3 object(s), bbox Δ0.000 mm, positions Δ0.000 mm, circles 3/3 same, legs 1/4 gapped");
  });

  it("summary", () => {
    expect(formatCourseSummary({ total: 3, filled: 2, skipped: 0, failed: 1, results: [] }, false)).toBe("structure backfill: 2 filled, 0 skipped, 1 failed of 3");
    expect(formatCourseSummary({ total: 3, filled: 0, skipped: 0, failed: 0, results: [] }, true)).toBe("dry run: 3 course(s) without a structure");
  });
});
