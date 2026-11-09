import { describe, it, expect } from "vitest";
import type { course } from "@oxygen/shared";
import { allVariationDraws, branchName, courseDrawOf, shownLegDraftOf, withCourseOverride, withLegDraft, type HeldLegDraft } from "../variation-view";

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

describe("the editor's leg draft (docs/course-editor.md §6.7, F21)", () => {
  const corridor = { widthM: 60, edge: true, whiteMm: 3, whiteOpacity: 1 };
  type Overlay = { name: string; controls: string[]; labelOffsets?: Record<string, { dx: number; dy: number }>; legs: Record<string, course.CourseLegProps> };
  const overlays: Overlay[] = [
    { name: "Lång", controls: ["1", "31", "32", "9"], labelOffsets: { 31: { dx: 1, dy: 1 } }, legs: { "31>32": { style: "marked_route", gaps: [{ from: 0.2, to: 0.3 }], corridor, bends: [{ x: 1, y: 1 }] }, "1>31": { style: "none" } } },
    { name: "Kort", controls: ["1", "31", "32", "9"], legs: { "31>32": { bends: [{ x: 5, y: 5 }] } } },
  ];

  it("patches only that leg's bends on the course of its name: style, gaps, corridor and the other legs and courses kept", () => {
    const out = withLegDraft(overlays, { course: "Lång", key: "31>32", bends: [{ x: 2, y: 3, hIn: { x: -1, y: 0 }, hOut: { x: 1, y: 0 } }] });
    expect(out[0].legs!["31>32"]).toEqual({ style: "marked_route", gaps: [{ from: 0.2, to: 0.3 }], corridor, bends: [{ x: 2, y: 3, hIn: { x: -1, y: 0 }, hOut: { x: 1, y: 0 } }] });
    expect(out[0].legs!["1>31"]).toBe(overlays[0].legs["1>31"]);
    expect(out[0]).toMatchObject({ controls: overlays[0].controls, labelOffsets: overlays[0].labelOffsets });
    expect(out[1]).toBe(overlays[1]);
    // The input is not mutated.
    expect(overlays[0].legs["31>32"].bends).toEqual([{ x: 1, y: 1 }]);
  });

  it("a leg without stored props gets one; an empty draft removes the bends (an empty leg drops out)", () => {
    expect(withLegDraft(overlays, { course: "Lång", key: "32>9", bends: [{ x: 4, y: 4 }] })[0].legs!["32>9"]).toEqual({ bends: [{ x: 4, y: 4 }] });
    const bare: { name: string; controls: string[]; legs?: Record<string, course.CourseLegProps> }[] = [{ name: "A", controls: ["1", "2"] }];
    expect(withLegDraft(bare, { course: "A", key: "1>2", bends: [{ x: 4, y: 4 }] })[0]).toEqual({ name: "A", controls: ["1", "2"], legs: { "1>2": { bends: [{ x: 4, y: 4 }] } } });
    expect(withLegDraft(overlays, { course: "Lång", key: "31>32", bends: [] })[0].legs!["31>32"]).toEqual({ style: "marked_route", gaps: [{ from: 0.2, to: 0.3 }], corridor });
    expect(withLegDraft(overlays, { course: "Kort", key: "31>32", bends: [] })[1].legs).toEqual({});
  });

  it("no draft, or a course not drawn: the overlays as given", () => {
    expect(withLegDraft(overlays, null)).toBe(overlays);
    expect(withLegDraft(overlays, { course: "Mellan", key: "31>32", bends: [] })).toBe(overlays);
  });

  it("applies after the override: the displayed path's leg of a course with groups", () => {
    const draws = [courseDrawOf("Lång", [{ siteId: 1 }, { siteId: 41 }, { siteId: 9, leg: { corridor } }])];
    const out = withLegDraft(withCourseOverride(overlays, draws), { course: "Lång", key: "41>9", bends: [{ x: 7, y: 7 }] });
    expect(out[0]).toMatchObject({ controls: ["1", "41", "9"], legs: { "41>9": { corridor, bends: [{ x: 7, y: 7 }] } } });
  });
});

describe("the shown leg draft (docs/course-editor.md §6.7 \"Live redraw\", F21)", () => {
  const OLD = [{ x: 1, y: 1 }], NEW = [{ x: 5, y: 5, hIn: { x: -1, y: 0 }, hOut: { x: 1, y: 0 } }], OTHER = [{ x: 9, y: 9 }];
  const live: HeldLegDraft = { course: "A", key: "31>32", bends: NEW, leg: "7/1/31>32", epoch: 3, phase: "live" };
  const held: HeldLegDraft = { ...live, phase: "held", from: OLD };
  const at = (drawn: readonly { x: number; y: number }[] | undefined, over: { epoch?: number; leg?: string | null } = {}) => ({
    epoch: over.epoch ?? 3, leg: over.leg === undefined ? "7/1/31>32" : over.leg, drawn: (course: string, key: string) => (course === "A" && key === "31>32" ? drawn : undefined),
  });

  it("a live draft shows while its leg is selected, whatever is drawn", () => {
    expect(shownLegDraftOf(live, at(OLD))).toBe(live);
    expect(shownLegDraftOf(live, at(NEW))).toBe(live);
    expect(shownLegDraftOf(live, at(OLD, { leg: "7/2/32>33" }))).toBeNull();
    expect(shownLegDraftOf(live, at(OLD, { leg: null }))).toBeNull();
  });

  it("a held draft shows until the drawn leg carries the written bends, or leaves the ones drawn at the release (pendingMoves)", () => {
    expect(shownLegDraftOf(held, at(OLD))).toBe(held);
    expect(shownLegDraftOf(held, at(NEW.map((b) => ({ ...b }))))).toBeNull();
    // Another write landed: neither the old nor the written bends.
    expect(shownLegDraftOf(held, at(OTHER))).toBeNull();
    // A held draft outlives a leg change (the band must not jump back while the list catches up).
    expect(shownLegDraftOf(held, at(OLD, { leg: null }))).toBe(held);
    // A leg without bends before: absent and empty alike.
    const fromNone: HeldLegDraft = { ...held, from: undefined };
    expect(shownLegDraftOf(fromNone, at([]))).toBe(fromNone);
    expect(shownLegDraftOf(fromNone, at(undefined))).toBe(fromNone);
  });

  it("undo / redo (another epoch) end any draft; none shows nothing", () => {
    expect(shownLegDraftOf(live, at(OLD, { epoch: 4 }))).toBeNull();
    expect(shownLegDraftOf(held, at(OLD, { epoch: 4 }))).toBeNull();
    expect(shownLegDraftOf(null, at(OLD))).toBeNull();
  });
});
