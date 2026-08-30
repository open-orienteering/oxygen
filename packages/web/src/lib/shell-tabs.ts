import type { Capability, ContentSignals } from "@oxygen/shared";

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
  requiredCapability: Capability;
}

export const ALL_TABS: TabDef[] = [
  { id: "dashboard", path: "", relevantWhen: "always", requiredCapability: "event.view" },
  { id: "runners", path: "runners", countKey: "runners", relevantWhen: "whenRunners", requiredCapability: "event.view" },
  { id: "startlist", path: "startlist", countKey: "startlist", relevantWhen: "whenRunners", requiredCapability: "event.view" },
  { id: "results", path: "results", countKey: "results", relevantWhen: "whenResults", requiredCapability: "results.view" },
  { id: "classes", path: "classes", countKey: "classes", relevantWhen: "always", requiredCapability: "event.view" },
  { id: "courses", path: "courses", countKey: "courses", relevantWhen: "always", requiredCapability: "courses.view" },
  { id: "controls", path: "controls", countKey: "controls", relevantWhen: "always", requiredCapability: "courses.view" },
  // Card readout data (cardReadout.cardList etc.) is race.operate on the API.
  { id: "cards", path: "cards", countKey: "cards", relevantWhen: "whenRunners", requiredCapability: "race.operate" },
  { id: "tracks", path: "tracks", relevantWhen: "whenResults", requiredCapability: "results.view" },
  { id: "event", path: "event", relevantWhen: "never", requiredCapability: "event.view" },
  { id: "course-editor", path: "course-editor", relevantWhen: "whenPlanning", requiredCapability: "courses.view" },
  { id: "registration-trends", path: "registration-trends", relevantWhen: "never", requiredCapability: "event.view" },
  { id: "clubs", path: "clubs", countKey: "clubs", relevantWhen: "never", requiredCapability: "event.view" },
  { id: "start-station", path: "start-station", group: "race", relevantWhen: "never", requiredCapability: "race.operate" },
  { id: "finish-station", path: "finish-station", group: "race", relevantWhen: "never", requiredCapability: "race.operate" },
  { id: "card-readout", path: "card-readout", group: "race", relevantWhen: "never", requiredCapability: "race.operate" },
  { id: "backup-punches", path: "backup-punches", group: "race", relevantWhen: "never", requiredCapability: "race.operate" },
  { id: "test-lab", path: "test-lab", group: "dev", relevantWhen: "never", requiredCapability: "event.manage" },
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
export function computeTabLayout(
  signals: ContentSignals | null,
  capabilities?: ReadonlySet<Capability> | null,
): {
  primary: TabDef[];
  overflow: TabDef[];
} {
  const allowed = (tab: TabDef) =>
    !capabilities || capabilities.has(tab.requiredCapability);

  if (signals === null) {
    const primary: TabDef[] = [];
    const overflow: TabDef[] = [];
    for (const tab of ALL_TABS) {
      if (!allowed(tab)) continue;
      const legacyOverflow =
        tab.relevantWhen === "never" || tab.relevantWhen === "whenPlanning";
      (legacyOverflow ? overflow : primary).push(tab);
    }
    return { primary, overflow };
  }

  const primary: TabDef[] = [];
  const overflow: TabDef[] = [];
  for (const tab of ALL_TABS) {
    if (!allowed(tab)) continue;
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
