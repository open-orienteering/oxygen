import { describe, it, expect } from "vitest";
import type { EventInfo } from "@oxygen/shared";
import {
  CLASSIFICATION_LABEL_KEYS,
  filterEvents,
  groupEvents,
  hasClassificationData,
} from "../event-list";

function ev(over: Partial<EventInfo> & Pick<EventInfo, "name" | "date" | "nameId">): EventInfo {
  return {
    id: over.id ?? 1,
    annotation: over.annotation ?? "",
    kind: over.kind ?? "competition",
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
      classificationId: 5,
    }),
    ev({
      id: 2,
      name: "District Champs",
      nameId: "dm_h21",
      date: "2026-05-01",
      classificationId: 3,
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

  it("filters by classification id and the unclassified bucket", () => {
    expect(filterEvents(list, { query: "", classificationId: 3 }).map((e) => e.nameId)).toEqual([
      "dm_h21",
    ]);
    expect(
      filterEvents(list, { query: "", classificationId: "unclassified" }).map((e) => e.nameId),
    ).toEqual(["train"]);
  });

  it("combines query and classification", () => {
    expect(
      filterEvents(list, { query: "champs", classificationId: 3 }).map((e) => e.nameId),
    ).toEqual(["dm_h21"]);
    expect(filterEvents(list, { query: "champs", classificationId: 5 })).toEqual([]);
  });

  it("treats missing classification filter as all", () => {
    expect(filterEvents(list, { query: "" })).toHaveLength(3);
    expect(filterEvents(list, { query: "", classificationId: "all" })).toHaveLength(3);
  });
});

describe("hasClassificationData / label keys", () => {
  it("is false when no event has a classification", () => {
    expect(hasClassificationData([ev({ name: "A", date: "2026-01-01", nameId: "a" })])).toBe(
      false,
    );
  });

  it("is true when any event is classified", () => {
    expect(
      hasClassificationData([
        ev({ name: "A", date: "2026-01-01", nameId: "a", classificationId: 1 }),
      ]),
    ).toBe(true);
  });

  it("maps Eventor classification ids 1–6", () => {
    expect(Object.keys(CLASSIFICATION_LABEL_KEYS).map(Number).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
