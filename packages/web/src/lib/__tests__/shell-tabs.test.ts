import { describe, it, expect } from "vitest";
import type { ContentSignals } from "@oxygen/shared";
import {
  ALL_TABS,
  computeTabLayout,
  shouldShowProgressiveHint,
  type ShellTabId,
} from "../shell-tabs";

const empty: ContentSignals = {
  hasMap: false,
  hasClasses: false,
  hasCourses: false,
  hasRunners: false,
  hasResults: false,
};

function ids(tabs: { id: ShellTabId }[]): ShellTabId[] {
  return tabs.map((t) => t.id);
}

function assertPartition(signals: ContentSignals | null) {
  const { primary, overflow } = computeTabLayout(signals);
  const combined = [...ids(primary), ...ids(overflow)].sort();
  const all = ids(ALL_TABS).sort();
  expect(combined).toEqual(all);
  const overlap = ids(primary).filter((id) => ids(overflow).includes(id));
  expect(overlap).toEqual([]);
}

describe("computeTabLayout", () => {
  it("keeps never-primary tabs in overflow for every signal combination", () => {
    const combos: ContentSignals[] = [
      empty,
      { ...empty, hasRunners: true },
      { ...empty, hasResults: true },
      { ...empty, hasRunners: true, hasResults: true },
      { ...empty, hasMap: true, hasClasses: true, hasCourses: true },
    ];
    const neverPrimary: ShellTabId[] = [
      "event",
      "registration-trends",
      "clubs",
      "start-station",
      "finish-station",
      "card-readout",
      "backup-punches",
      "test-lab",
    ];
    for (const signals of combos) {
      assertPartition(signals);
      const { overflow } = computeTabLayout(signals);
      for (const id of neverPrimary) {
        expect(ids(overflow)).toContain(id);
      }
    }
    assertPartition(null);
  });

  it("uses a planning bar for an empty event", () => {
    const { primary, overflow } = computeTabLayout(empty);
    expect(ids(primary)).toEqual([
      "dashboard",
      "classes",
      "courses",
      "controls",
      "course-editor",
    ]);
    expect(ids(overflow)).toContain("runners");
    expect(ids(overflow)).toContain("startlist");
    expect(ids(overflow)).toContain("results");
    expect(ids(overflow)).toContain("cards");
    expect(ids(overflow)).toContain("tracks");
    expect(shouldShowProgressiveHint(overflow)).toBe(true);
  });

  it("promotes runners/startlist/cards and demotes course-editor once there are entries", () => {
    const { primary, overflow } = computeTabLayout({ ...empty, hasRunners: true });
    expect(ids(primary)).toEqual([
      "dashboard",
      "runners",
      "startlist",
      "classes",
      "courses",
      "controls",
      "cards",
    ]);
    expect(ids(overflow)).toContain("course-editor");
    expect(ids(overflow)).toContain("results");
    expect(ids(overflow)).toContain("tracks");
  });

  it("promotes results and tracks when there are results", () => {
    const { primary, overflow } = computeTabLayout({
      ...empty,
      hasRunners: true,
      hasResults: true,
    });
    expect(ids(primary)).toContain("results");
    expect(ids(primary)).toContain("tracks");
    expect(ids(overflow)).not.toContain("results");
    expect(ids(overflow)).toContain("course-editor");
  });

  it("uses the legacy layout while dashboard signals are unknown", () => {
    const { primary, overflow } = computeTabLayout(null);
    expect(ids(primary)).toEqual([
      "dashboard",
      "runners",
      "startlist",
      "results",
      "classes",
      "courses",
      "controls",
      "cards",
      "tracks",
    ]);
    expect(ids(overflow)).toEqual([
      "event",
      "course-editor",
      "registration-trends",
      "clubs",
      "start-station",
      "finish-station",
      "card-readout",
      "backup-punches",
      "test-lab",
    ]);
    expect(shouldShowProgressiveHint(overflow)).toBe(false);
  });
});
