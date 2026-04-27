import { describe, it, expect } from "vitest";
import type { ClassInfo } from "@oxygen/shared";
import {
  filterRegistrationClasses,
  competitionYearFromDate,
} from "../registration-class-filter.js";

function cls(partial: Partial<ClassInfo> & { id: number; name: string }): ClassInfo {
  return {
    courseId: 0,
    sortIndex: 0,
    sex: "",
    lowAge: 0,
    highAge: 0,
    ...partial,
  };
}

describe("filterRegistrationClasses", () => {
  it("only returns classes flagged allowQuickEntry", () => {
    const classes = [
      cls({ id: 1, name: "Open", allowQuickEntry: true }),
      cls({ id: 2, name: "Elite", allowQuickEntry: false }),
      cls({ id: 3, name: "Beginners" }), // undefined ≠ true
    ];
    const result = filterRegistrationClasses(classes);
    expect(result.map((c) => c.id)).toEqual([1]);
  });

  it("hides classes restricted to the opposite sex but keeps open classes", () => {
    const classes = [
      cls({ id: 1, name: "Open", allowQuickEntry: true, sex: "" }),
      cls({ id: 2, name: "Men", allowQuickEntry: true, sex: "M" }),
      cls({ id: 3, name: "Women F", allowQuickEntry: true, sex: "F" }),
      cls({ id: 4, name: "Women W", allowQuickEntry: true, sex: "W" }),
    ];

    const forMen = filterRegistrationClasses(classes, { sex: "M" });
    expect(forMen.map((c) => c.id)).toEqual([1, 2]);

    const forWomen = filterRegistrationClasses(classes, { sex: "F" });
    expect(forWomen.map((c) => c.id)).toEqual([1, 3, 4]);
  });

  it("treats unknown / blank sex as no sex filter", () => {
    const classes = [
      cls({ id: 1, name: "Open", allowQuickEntry: true, sex: "" }),
      cls({ id: 2, name: "Men", allowQuickEntry: true, sex: "M" }),
    ];
    expect(filterRegistrationClasses(classes, { sex: "" }).map((c) => c.id)).toEqual([1, 2]);
    expect(filterRegistrationClasses(classes).map((c) => c.id)).toEqual([1, 2]);
  });

  it("excludes classes whose age range does not include the runner", () => {
    const classes = [
      cls({ id: 1, name: "Any", allowQuickEntry: true }),
      cls({ id: 2, name: "H10", allowQuickEntry: true, lowAge: 0, highAge: 10 }),
      cls({ id: 3, name: "H35+", allowQuickEntry: true, lowAge: 35, highAge: 0 }),
      cls({ id: 4, name: "H21", allowQuickEntry: true, lowAge: 21, highAge: 21 }),
    ];

    // 1990 birth year, competition 2026 -> age 36
    const a = filterRegistrationClasses(classes, { birthYear: 1990, competitionYear: 2026 });
    expect(a.map((c) => c.id)).toEqual([1, 3]);

    // 2018 birth year, competition 2026 -> age 8
    const child = filterRegistrationClasses(classes, { birthYear: 2018, competitionYear: 2026 });
    expect(child.map((c) => c.id)).toEqual([1, 2]);

    // 2005 birth year, competition 2026 -> age 21
    const adult = filterRegistrationClasses(classes, { birthYear: 2005, competitionYear: 2026 });
    expect(adult.map((c) => c.id)).toEqual([1, 4]);
  });

  it("ignores age filter when birth year is missing or zero", () => {
    const classes = [
      cls({ id: 1, name: "Any", allowQuickEntry: true }),
      cls({ id: 2, name: "H10", allowQuickEntry: true, highAge: 10 }),
    ];
    expect(filterRegistrationClasses(classes).map((c) => c.id)).toEqual([1, 2]);
    expect(
      filterRegistrationClasses(classes, { birthYear: 0 }).map((c) => c.id),
    ).toEqual([1, 2]);
  });

  it("combines sex and age filters", () => {
    const classes = [
      cls({ id: 1, name: "H35", allowQuickEntry: true, sex: "M", lowAge: 35 }),
      cls({ id: 2, name: "D35", allowQuickEntry: true, sex: "F", lowAge: 35 }),
      cls({ id: 3, name: "Open", allowQuickEntry: true }),
    ];
    const r = filterRegistrationClasses(classes, {
      sex: "M",
      birthYear: 1990,
      competitionYear: 2026,
    });
    expect(r.map((c) => c.id)).toEqual([1, 3]);
  });
});

describe("competitionYearFromDate", () => {
  it("parses the leading 4-digit year", () => {
    expect(competitionYearFromDate("2026-04-27")).toBe(2026);
    expect(competitionYearFromDate("2026")).toBe(2026);
  });

  it("falls back to current year when missing or invalid", () => {
    const current = new Date().getFullYear();
    expect(competitionYearFromDate(undefined)).toBe(current);
    expect(competitionYearFromDate("")).toBe(current);
    expect(competitionYearFromDate("not-a-date")).toBe(current);
  });
});
