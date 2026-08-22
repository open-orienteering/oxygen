import { describe, it, expect } from "vitest";
import type { DrawPreviewClass, DrawPreviewResult } from "@oxygen/shared";
import { buildTimelineBars } from "../draw-timeline";

const MIN = 600;
const FIRST_START = 324_000;

function previewClass(over: Partial<DrawPreviewClass> & { classId: number }): DrawPreviewClass {
  const interval = over.interval ?? 2 * MIN;
  const firstStart = over.computedFirstStart ?? FIRST_START;
  const runnerCount = over.entries ? over.entries.length : 3;
  return {
    className: `C${over.classId}`,
    courseName: "Blue",
    corridor: 0,
    computedFirstStart: firstStart,
    interval,
    entries: Array.from({ length: runnerCount }, (_, i) => ({
      runnerId: i + 1,
      name: `R${i}`,
      clubName: "OK",
      startTime: firstStart + i * interval,
      startNo: i + 1,
    })),
    ...over,
  };
}

function preview(classes: DrawPreviewClass[]): DrawPreviewResult {
  return { classes, warnings: [] };
}

describe("buildTimelineBars", () => {
  it("ends a bar at the last runner's slot end, not the last start", () => {
    const [bar] = buildTimelineBars(
      preview([previewClass({ classId: 1 })]),
    );
    expect(bar.startTime).toBe(FIRST_START);
    // 3 runners * 2 min: last start at +4 min, slot closes at +6 min.
    expect(bar.lastStartTime).toBe(FIRST_START + 4 * MIN);
    expect(bar.endTime).toBe(FIRST_START + 6 * MIN);
  });

  it("makes consecutive bars in a corridor abut", () => {
    const first = previewClass({ classId: 1 });
    const second = previewClass({
      classId: 2,
      computedFirstStart: FIRST_START + 6 * MIN,
    });
    const bars = buildTimelineBars(preview([first, second]));
    expect(bars[0].endTime).toBe(bars[1].startTime);
  });

  it("drops classes without a corridor", () => {
    const bars = buildTimelineBars(
      preview([
        previewClass({ classId: 1 }),
        previewClass({ classId: 2, corridor: -1 }),
      ]),
    );
    expect(bars.map((b) => b.classId)).toEqual([1]);
  });

  it("gives a mass start a zero-width span", () => {
    const massStart = previewClass({ classId: 1, interval: 0 });
    const [bar] = buildTimelineBars(preview([massStart]));
    expect(bar.endTime).toBe(bar.startTime);
  });

  it("handles a class with no entries", () => {
    const empty = previewClass({ classId: 1, entries: [] });
    const [bar] = buildTimelineBars(preview([empty]));
    expect(bar.startTime).toBe(FIRST_START);
    expect(bar.endTime).toBe(FIRST_START);
    expect(bar.runnerCount).toBe(0);
  });
});
