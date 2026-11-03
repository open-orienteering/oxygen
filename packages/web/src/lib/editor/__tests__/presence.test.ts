import { describe, expect, it } from "vitest";
import { courseChangedElsewhere, newClientId, presenceEntries, type PresenceOther } from "../presence";

const mode = (m: string) => ({ course: "Course", layout: "Layout", field: "Field" })[m]!;
const o = (name: string, courseId: number, courseName: string, m: PresenceOther["mode"]): PresenceOther => ({ name, courseId, courseName, mode: m });

describe("presenceEntries", () => {
  it("labels 'name · course · mode', the open course first", () => {
    const list = presenceEntries([o("Bo", 2, "Kort", "course"), o("Anna", 1, "Lång", "field")], 1, mode, "Someone");
    expect(list.map((e) => e.label)).toEqual(["Anna · Lång · Field", "Bo · Kort · Course"]);
    expect(list.map((e) => e.here)).toEqual([true, false]);
  });
  it("names an unnamed user", () => {
    expect(presenceEntries([o("", 1, "Lång", "layout")], null, mode, "Someone")[0].label).toBe("Someone · Lång · Layout");
  });
  it("keeps two entries for one name (two tabs) under distinct keys", () => {
    const keys = presenceEntries([o("Anna", 1, "L", "course"), o("Anna", 1, "L", "course")], 1, mode, "?").map((e) => e.key);
    expect(new Set(keys).size).toBe(2);
  });
  it("is empty with nobody else", () => expect(presenceEntries([], 1, mode, "?")).toEqual([]));
});

describe("courseChangedElsewhere", () => {
  const own = new Set(["20"]);
  it("is a token that moved and is not ours", () => expect(courseChangedElsewhere("10", "30", own)).toBe(true));
  it("is not our own write", () => expect(courseChangedElsewhere("10", "20", own)).toBe(false));
  it("is not the first sight or an unchanged token", () => {
    expect(courseChangedElsewhere(undefined, "30", own)).toBe(false);
    expect(courseChangedElsewhere("30", "30", own)).toBe(false);
    expect(courseChangedElsewhere("30", undefined, own)).toBe(false);
  });
});

describe("newClientId", () => {
  it("differs per call", () => expect(newClientId()).not.toBe(newClientId()));
});
