import { EVENT_KINDS, type EventInfo, type EventKind } from "@oxygen/shared";

/** i18n keys in the `event` namespace for editable Oxygen event kinds. */
export const EVENT_KIND_LABEL_KEYS: Record<EventKind,
  | "eventKindCompetition"
  | "eventKindChampionship"
  | "eventKindInternational"
  | "eventKindNational"
  | "eventKindDistrict"
  | "eventKindLocal"
  | "eventKindClub"
  | "eventKindClubTraining"
  | "eventKindWeeklyCourse"
  | "eventKindTraining"
  | "eventKindOther"
> = {
  competition: "eventKindCompetition",
  championship: "eventKindChampionship",
  international: "eventKindInternational",
  national: "eventKindNational",
  district: "eventKindDistrict",
  local: "eventKindLocal",
  club: "eventKindClub",
  club_training: "eventKindClubTraining",
  weekly_course: "eventKindWeeklyCourse",
  training: "eventKindTraining",
  other: "eventKindOther",
} as const;

export function eventKindLabelKey(kind: EventKind) {
  return EVENT_KIND_LABEL_KEYS[kind];
}

export function eventKindDisplayLabel(
  event: Pick<EventInfo, "kind" | "kindCustom">,
  translate: (key: (typeof EVENT_KIND_LABEL_KEYS)[EventKind]) => string,
): string {
  return event.kind === "other"
    ? event.kindCustom
    : translate(eventKindLabelKey(event.kind));
}

export const EVENT_KIND_OPTIONS = EVENT_KINDS;
export type EventKindFilter = "all" | EventKind;

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
  opts: { query: string; kind?: EventKindFilter },
): EventInfo[] {
  const query = opts.query.trim().toLowerCase();
  const kind = opts.kind ?? "all";
  return events.filter((event) => {
    if (query) {
      const haystack =
        `${event.name} ${event.nameId} ${event.annotation} ${event.kind} ${event.kindCustom}`
          .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return kind === "all" || event.kind === kind;
  });
}
