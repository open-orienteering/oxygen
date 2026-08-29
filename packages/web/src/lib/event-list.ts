import type { EventInfo } from "@oxygen/shared";

/** i18n keys in the `event` namespace for Eventor classification ids 1–6. */
export const CLASSIFICATION_LABEL_KEYS = {
  1: "classification1",
  2: "classification2",
  3: "classification3",
  4: "classification4",
  5: "classification5",
  6: "classification6",
} as const;

export function classificationLabelKey(
  id: number,
): (typeof CLASSIFICATION_LABEL_KEYS)[keyof typeof CLASSIFICATION_LABEL_KEYS] | undefined {
  if (id === 1 || id === 2 || id === 3 || id === 4 || id === 5 || id === 6) {
    return CLASSIFICATION_LABEL_KEYS[id];
  }
  return undefined;
}

export type ClassificationFilter = "all" | "unclassified" | number;

export function groupEvents(
  events: EventInfo[],
  todayIso: string,
): { upcoming: EventInfo[]; past: EventInfo[] } {
  const upcoming: EventInfo[] = [];
  const past: EventInfo[] = [];
  for (const event of events) {
    if (event.date >= todayIso) upcoming.push(event);
    else past.push(event);
  }
  upcoming.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  past.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  return { upcoming, past };
}

export function filterEvents(
  events: EventInfo[],
  opts: { query: string; classificationId?: ClassificationFilter },
): EventInfo[] {
  const query = opts.query.trim().toLowerCase();
  const classification = opts.classificationId ?? "all";
  return events.filter((event) => {
    if (query) {
      const haystack = `${event.name} ${event.nameId} ${event.annotation}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (classification === "all") return true;
    if (classification === "unclassified") return event.classificationId == null;
    return event.classificationId === classification;
  });
}

export function hasClassificationData(events: EventInfo[]): boolean {
  return events.some((event) => event.classificationId != null);
}
