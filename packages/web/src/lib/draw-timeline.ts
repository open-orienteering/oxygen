import type { DrawPreviewResult } from "@oxygen/shared";

export interface TimelineBar {
  classId: number;
  className: string;
  courseName: string;
  corridor: number;
  startTime: number;
  /** End of the last runner's start slot (last start + interval). */
  endTime: number;
  /** Start time of the last runner in the class. */
  lastStartTime: number;
  runnerCount: number;
}

/**
 * Turn a draw preview into corridor bars.
 *
 * A bar spans the class's whole start window: from the first runner's start
 * to the end of the last runner's slot. Since the optimizer stacks the next
 * class in a corridor at exactly that slot end, consecutive bars abut instead
 * of leaving a hole the width of one interval.
 *
 * Classes with a negative corridor are pinned to a fixed first start and are
 * not part of the corridor layout.
 */
export function buildTimelineBars(preview: DrawPreviewResult): TimelineBar[] {
  return preview.classes
    .filter((c) => c.corridor >= 0)
    .map((cls) => {
      const lastEntry = cls.entries[cls.entries.length - 1];
      return {
        classId: cls.classId,
        className: cls.className,
        courseName: cls.courseName,
        corridor: cls.corridor,
        startTime: cls.computedFirstStart,
        endTime: lastEntry
          ? lastEntry.startTime + cls.interval
          : cls.computedFirstStart,
        lastStartTime: lastEntry ? lastEntry.startTime : cls.computedFirstStart,
        runnerCount: cls.entries.length,
      };
    });
}
