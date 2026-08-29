import type { ContentSignals } from "@oxygen/shared";

export type ShellTabId =
  | "dashboard"
  | "event"
  | "runners"
  | "startlist"
  | "results"
  | "classes"
  | "courses"
  | "course-editor"
  | "controls"
  | "clubs"
  | "start-station"
  | "finish-station"
  | "card-readout"
  | "cards"
  | "backup-punches"
  | "test-lab"
  | "tracks"
  | "registration-trends";

export type TabRelevance =
  | "always"
  | "never"
  | "whenPlanning"
  | "whenRunners"
  | "whenResults";

export interface TabDef {
  id: ShellTabId;
  path: string;
  group?: string;
  countKey?: string;
  relevantWhen: TabRelevance;
}

export const ALL_TABS: TabDef[] = [
  { id: "dashboard", path: "", relevantWhen: "always" },
  { id: "runners", path: "runners", countKey: "runners", relevantWhen: "whenRunners" },
  { id: "startlist", path: "startlist", countKey: "startlist", relevantWhen: "whenRunners" },
  { id: "results", path: "results", countKey: "results", relevantWhen: "whenResults" },
  { id: "classes", path: "classes", countKey: "classes", relevantWhen: "always" },
  { id: "courses", path: "courses", countKey: "courses", relevantWhen: "always" },
  { id: "controls", path: "controls", countKey: "controls", relevantWhen: "always" },
  { id: "cards", path: "cards", countKey: "cards", relevantWhen: "whenRunners" },
  { id: "tracks", path: "tracks", relevantWhen: "whenResults" },
  { id: "event", path: "event", relevantWhen: "never" },
  { id: "course-editor", path: "course-editor", relevantWhen: "whenPlanning" },
  { id: "registration-trends", path: "registration-trends", relevantWhen: "never" },
  { id: "clubs", path: "clubs", countKey: "clubs", relevantWhen: "never" },
  { id: "start-station", path: "start-station", group: "race", relevantWhen: "never" },
  { id: "finish-station", path: "finish-station", group: "race", relevantWhen: "never" },
  { id: "card-readout", path: "card-readout", group: "race", relevantWhen: "never" },
  { id: "backup-punches", path: "backup-punches", group: "race", relevantWhen: "never" },
  { id: "test-lab", path: "test-lab", group: "dev", relevantWhen: "never" },
];

function isPrimary(tab: TabDef, signals: ContentSignals): boolean {
  switch (tab.relevantWhen) {
    case "always":
      return true;
    case "never":
      return false;
    case "whenPlanning":
      return !signals.hasRunners;
    case "whenRunners":
      return signals.hasRunners;
    case "whenResults":
      return signals.hasResults;
  }
}

/**
 * Split tabs into the top bar vs More overflow.
 * `signals === null` (dashboard not loaded) uses the pre-progressive layout
 * so mature events do not flash a planning-only bar on every mount.
 */
export function computeTabLayout(signals: ContentSignals | null): {
  primary: TabDef[];
  overflow: TabDef[];
} {
  if (signals === null) {
    const primary: TabDef[] = [];
    const overflow: TabDef[] = [];
    for (const tab of ALL_TABS) {
      const legacyOverflow =
        tab.relevantWhen === "never" || tab.relevantWhen === "whenPlanning";
      (legacyOverflow ? overflow : primary).push(tab);
    }
    return { primary, overflow };
  }

  const primary: TabDef[] = [];
  const overflow: TabDef[] = [];
  for (const tab of ALL_TABS) {
    (isPrimary(tab, signals) ? primary : overflow).push(tab);
  }
  return { primary, overflow };
}

/** Hint in More when race-day primary tabs are still tucked away. */
export function shouldShowProgressiveHint(overflow: TabDef[]): boolean {
  return overflow.some(
    (tab) => tab.relevantWhen === "whenRunners" || tab.relevantWhen === "whenResults",
  );
}
