import { describe, it, expect } from "vitest";
import type { EventInfo } from "@oxygen/shared";
import {
  EVENT_KIND_LABEL_KEYS,
  eventKindDisplayLabel,
  filterEvents,
  groupEvents,
} from "../event-list";

function ev(over: Partial<EventInfo> & Pick<EventInfo, "name" | "date" | "nameId">): EventInfo {
  return {
    id: over.id ?? 1,
    annotation: over.annotation ?? "",
    kind: over.kind ?? "competition",
    kindCustom: over.kindCustom ?? "",
    ...over,
  };
}

describe("groupEvents", () => {
  it("treats today as upcoming", () => {
    const { upcoming, past } = groupEvents(
      [ev({ name: "Today", date: "2026-08-29", nameId: "today" })],
      "2026-08-29",
    );
    expect(upcoming.map((e) => e.nameId)).toEqual(["today"]);
    expect(past).toEqual([]);
  });

  it("splits past and upcoming on the today boundary", () => {
    const { upcoming, past } = groupEvents(
      [
        ev({ name: "Yesterday", date: "2026-08-28", nameId: "y" }),
        ev({ name: "Tomorrow", date: "2026-08-30", nameId: "t" }),
      ],
      "2026-08-29",
    );
    expect(upcoming.map((e) => e.nameId)).toEqual(["t"]);
    expect(past.map((e) => e.nameId)).toEqual(["y"]);
  });

  it("sorts upcoming ascending and past descending", () => {
    const { upcoming, past } = groupEvents(
      [
        ev({ name: "Far", date: "2026-12-01", nameId: "far" }),
        ev({ name: "Soon", date: "2026-09-01", nameId: "soon" }),
        ev({ name: "Old", date: "2025-01-01", nameId: "old" }),
        ev({ name: "Recent", date: "2026-08-01", nameId: "recent" }),
      ],
      "2026-08-29",
    );
    expect(upcoming.map((e) => e.nameId)).toEqual(["soon", "far"]);
    expect(past.map((e) => e.nameId)).toEqual(["recent", "old"]);
  });
});

describe("filterEvents", () => {
  const list = [
    ev({
      id: 1,
      name: "Klubbmästerskap",
      nameId: "km_2026",
      date: "2026-09-01",
      annotation: "Night-O",
      kind: "club",
    }),
    ev({
      id: 2,
      name: "District Champs",
      nameId: "dm_h21",
      date: "2026-05-01",
      kind: "district",
    }),
    ev({
      id: 3,
      name: "Training",
      nameId: "train",
      date: "2026-06-01",
    }),
  ];

  it("matches name, nameId, and annotation case-insensitively", () => {
    expect(filterEvents(list, { query: "KLUBB" }).map((e) => e.nameId)).toEqual(["km_2026"]);
    expect(filterEvents(list, { query: "dm_h" }).map((e) => e.nameId)).toEqual(["dm_h21"]);
    expect(filterEvents(list, { query: "night" }).map((e) => e.nameId)).toEqual(["km_2026"]);
  });

  it("filters by editable Oxygen event type", () => {
    expect(filterEvents(list, { query: "", kind: "district" }).map((e) => e.nameId)).toEqual([
      "dm_h21",
    ]);
    expect(filterEvents(list, { query: "", kind: "competition" }).map((e) => e.nameId))
      .toEqual(["train"]);
  });

  it("combines query and event type", () => {
    expect(
      filterEvents(list, { query: "champs", kind: "district" }).map((e) => e.nameId),
    ).toEqual(["dm_h21"]);
    expect(filterEvents(list, { query: "champs", kind: "club" })).toEqual([]);
  });

  it("treats missing event type filter as all", () => {
    expect(filterEvents(list, { query: "" })).toHaveLength(3);
    expect(filterEvents(list, { query: "", kind: "all" })).toHaveLength(3);
  });

  it("includes custom labels in search and filters them by the stable other code", () => {
    const custom = ev({
      name: "Tuesday run",
      date: "2026-09-08",
      nameId: "tuesday",
      kind: "other",
      kindCustom: "Night cup",
    });
    expect(filterEvents([custom], { query: "night" })).toEqual([custom]);
    expect(filterEvents([custom], { query: "", kind: "other" })).toEqual([custom]);
    expect(eventKindDisplayLabel(custom, (key) => key)).toBe("Night cup");
  });

  it("has a label for every curated kind", () => {
    expect(Object.keys(EVENT_KIND_LABEL_KEYS)).toHaveLength(11);
  });
});
