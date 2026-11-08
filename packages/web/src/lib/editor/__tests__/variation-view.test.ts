import { describe, it, expect } from "vitest";
import type { course } from "@oxygen/shared";
import { allVariationDraws, branchName, courseDrawOf, withCourseOverride } from "../variation-view";

type S = course.WireCourseStructure;
type Item = S["items"][number];
const g = (id: string, alts: number[][], loop = false): Item => ({
  kind: "variation", id, alternatives: alts.map((l, i) => ({ label: String.fromCharCode(65 + i), items: l.map((siteId) => ({ siteId })) })), ...(loop ? { loop: true } : {}),
});
const mk = (...items: (number | Item)[]): S => ({ version: 1, id: "c", orderMode: "ordered", items: items.map((i) => (typeof i === "number" ? { siteId: i } : i)) });

describe("the drawn course of a structure with groups (docs/course-editor.md §12, F7)", () => {
  it("a displayed path draws as one course: its legs by drawn neighbours, the crossing as a string, hidden numbers", () => {
    const d = courseDrawOf("Lång", [{ siteId: 1 }, { siteId: 31, numberHidden: true }, { siteId: 41, leg: { style: "marked_route", crossing: { controlId: 70 } } }, { siteId: 9 }]);
    expect(d).toEqual({ name: "Lång", controls: ["1", "31", "41", "9"], legs: { "31>41": { style: "marked_route", crossing: { controlId: "70" } } }, hiddenNumbers: [31] });
  });

  it("All variations: the spine with a none leg across a plain group, one tinted branch per alternative", () => {
    const draws = allVariationDraws("Lång", mk(1, 31, g("v1", [[41, 42], []]), { siteId: 32, leg: { bends: [{ x: 1, y: 1 }] } } as Item, 9));
    expect(draws.map((d) => [d.name, d.controls.join(" "), d.tint ?? null])).toEqual([
      ["Lång", "1 31 32 9", null],
      [branchName("Lång", "v1", "A"), "31 41 42 32", "A"],
      [branchName("Lång", "v1", "B"), "31 32", "B"],
    ]);
    expect(draws[0].legs["31>32"]).toEqual({ bends: [{ x: 1, y: 1 }], style: "none" });
    // The exit leg's props are every alternative's.
    expect(draws[1].legs["42>32"]).toEqual({ bends: [{ x: 1, y: 1 }] });
  });

  it("the override replaces the overlay of its name, keeping its other fields, and adds the rest highlighted", () => {
    const overlays = [{ name: "Lång", controls: ["1", "9"], labelOffsets: { 1: { dx: 1, dy: 1 } } }, { name: "Kort", controls: ["1", "9"] }];
    const out = withCourseOverride(overlays, allVariationDraws("Lång", mk(1, 31, g("v1", [[41], []]), 32, 9)));
    expect(out.map((c) => c.name)).toEqual(["Lång", "Kort", branchName("Lång", "v1", "A"), branchName("Lång", "v1", "B")]);
    expect(out[0]).toMatchObject({ controls: ["1", "31", "32", "9"], labelOffsets: { 1: { dx: 1, dy: 1 } } });
    expect(out[2]).toMatchObject({ highlight: true, tint: "A" });
    expect(withCourseOverride(overlays, null)).toBe(overlays);
  });

  it("All variations numbers (F15): the spine carries the shared numbers when the variants number alike, never otherwise", () => {
    const isNumbered = (item: { siteId: number }) => item.siteId >= 30;
    const equal = allVariationDraws("Lång", mk(1, 31, g("v1", [[41], [42]]), 32, 9), isNumbered);
    expect(equal[0].labels).toEqual({ "31": "1", "41": "2", "42": "2", "32": "3" });
    expect(equal[1].labels).toBeUndefined();
    expect(allVariationDraws("Lång", mk(1, 31, g("v1", [[41], [42, 43]]), 32, 9), isNumbered)[0].labels).toBeUndefined();
    expect(allVariationDraws("B", mk(1, 31, g("b", [[41], [42]], true), 32, 9), isNumbered)[0].labels).toBeUndefined();
    // Without a predicate (the caller does not know the sites) the draws are as before.
    expect(allVariationDraws("Lång", mk(1, 31, g("v1", [[41], [42]]), 32, 9))[0].labels).toBeUndefined();
  });

  it("the override carries labels with the controls (F15)", () => {
    const out = withCourseOverride([{ name: "Lång", controls: ["1", "9"] }], allVariationDraws("Lång", mk(1, 31, g("v1", [[41], [42]]), 32, 9), (i) => i.siteId >= 30));
    expect(out[0]).toMatchObject({ labels: { "41": "2" } });
  });

  it("a loop: petals back to the anchor, an empty petal draws nothing, the spine keeps its leg", () => {
    const draws = allVariationDraws("B", mk(1, 31, g("b", [[41], [42], []], true), 31, 9));
    expect(draws.map((d) => d.controls.join(" "))).toEqual(["1 31 31 9", "31 41 31", "31 42 31"]);
    expect(draws[0].legs).toEqual({});
  });
});
