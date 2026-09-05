import { describe, expect, it } from "vitest";
import {
  EVENT_KINDS,
  eventKindFromClassification,
} from "../types.js";

describe("event kinds", () => {
  it("maps every Eventor classification to an Oxygen kind", () => {
    expect([
      eventKindFromClassification(1),
      eventKindFromClassification(2),
      eventKindFromClassification(3),
      eventKindFromClassification(4),
      eventKindFromClassification(5),
      eventKindFromClassification(6),
    ]).toEqual([
      "championship",
      "national",
      "district",
      "local",
      "club",
      "international",
    ]);
  });

  it("falls back to generic competition for unknown Eventor values", () => {
    expect(eventKindFromClassification(0)).toBe("competition");
    expect(EVENT_KINDS).toContain("other");
  });
});
