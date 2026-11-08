import { describe, it, expect } from "vitest";
import type { course } from "@oxygen/shared";
import { addAlternative, appendSite, canCreateGroup, controlSequence, createGroup, insertSite, itemAtPath, moveToAlternative, moveVisit, removeAlternative, removeSite, removeVisit, renameAlternative, setLoop, setRole, setLegGaps, setLegProps, setNumberHidden } from "../structure-edit";

type S = course.WireCourseStructure;
const KIND: Record<number, "start" | "finish" | "control"> = { 1: "start", 2: "start", 9: "finish", 8: "finish" };
const kindOf = (id: number) => KIND[id] ?? "control";
const st = (...ids: number[]): S => ({ version: 1, id: "c", orderMode: "ordered", items: ids.map((siteId) => ({ siteId })) });
const ids = (s: S) => s.items.map((i) => (i.kind === "variation" ? -1 : i.siteId));

describe("structure edits (docs/course-editor.md §4)", () => {
  it("the control sequence leaves out a leading start and a trailing finish", () => {
    expect(controlSequence(st(1, 31, 32, 9), kindOf)).toEqual([31, 32]);
    expect(controlSequence(st(31, 32), kindOf)).toEqual([31, 32]);
    expect(controlSequence(st(31, 32, 31), kindOf)).toEqual([31, 32, 31]);
  });

  it("insert and append work in sequence positions, keeping start and finish where they are", () => {
    expect(ids(insertSite(st(1, 31, 32, 9), 1, 40, kindOf))).toEqual([1, 31, 40, 32, 9]);
    expect(ids(insertSite(st(1, 31, 32, 9), 0, 40, kindOf))).toEqual([1, 40, 31, 32, 9]);
    expect(ids(appendSite(st(1, 31, 32, 9), 40, kindOf))).toEqual([1, 31, 32, 40, 9]);
    expect(ids(appendSite(st(), 40, kindOf))).toEqual([40]);
    expect(ids(insertSite(st(31), 99, 40, kindOf))).toEqual([31, 40]);
  });

  it("remove takes out every visit of a control, never the structure's start / finish slot by accident", () => {
    expect(ids(removeSite(st(1, 31, 32, 31, 9), 31))).toEqual([1, 32, 9]);
    expect(ids(removeSite(st(1, 31, 9), 77))).toEqual([1, 31, 9]);
  });

  it("removeVisit drops one visit by position", () => {
    expect(ids(removeVisit(st(1, 31, 32, 31, 9), 2, kindOf))).toEqual([1, 31, 32, 9]);
    expect(ids(removeVisit(st(1, 31, 9), 5, kindOf))).toEqual([1, 31, 9]);
  });

  it("move reorders within the control sequence", () => {
    expect(ids(moveVisit(st(1, 31, 32, 33, 9), 0, 2, kindOf))).toEqual([1, 32, 33, 31, 9]);
    expect(ids(moveVisit(st(1, 31, 32, 33, 9), 2, 0, kindOf))).toEqual([1, 33, 31, 32, 9]);
    expect(ids(moveVisit(st(31, 32), 0, 5, kindOf))).toEqual([32, 31]);
  });

  it("setRole replaces the explicit start or finish, or adds one", () => {
    expect(ids(setRole(st(1, 31, 9), "start", 2, kindOf))).toEqual([2, 31, 9]);
    expect(ids(setRole(st(31, 9), "start", 2, kindOf))).toEqual([2, 31, 9]);
    expect(ids(setRole(st(1, 31, 9), "finish", 8, kindOf))).toEqual([1, 31, 8]);
    expect(ids(setRole(st(1, 31), "finish", 8, kindOf))).toEqual([1, 31, 8]);
  });

  it("keeps everything else of the structure; a leg's props go when the leg into the item changed", () => {
    const s: S = { version: 1, id: "c", orderMode: "free_order", items: [{ siteId: 31, numberHidden: true }, { siteId: 32, leg: { gaps: [{ from: 0.2, to: 0.3 }] } }] };
    const out = insertSite(s, 1, 40, kindOf);
    expect(out.orderMode).toBe("free_order");
    expect(out.items[0]).toEqual({ siteId: 31, numberHidden: true });
    // 32's leg now comes from 40: the 31 → 32 gaps no longer describe it.
    expect(out.items[2]).toEqual({ siteId: 32 });
    expect(s.items).toHaveLength(2);
    // An edit elsewhere keeps the leg.
    const kept = appendSite(s, 40, kindOf);
    expect(kept.items[1]).toEqual({ siteId: 32, leg: { gaps: [{ from: 0.2, to: 0.3 }] } });
  });
});

describe("numberHidden and leg gaps (docs/course-editor.md §6)", () => {
  const base = { version: 1 as const, id: "c", orderMode: "ordered" as const, items: [{ siteId: 1 }, { siteId: 31 }, { siteId: 32 }, { siteId: 31 }, { siteId: 2 }] };

  it("hides every visit's number and shows it again", () => {
    const hidden = setNumberHidden(base, 31, true);
    expect(hidden.items.filter((i) => "numberHidden" in i && i.numberHidden)).toHaveLength(2);
    expect(setNumberHidden(hidden, 31, false)).toEqual(base);
  });

  it("sets and clears the gaps of the leg into an item, keeping its other leg props", () => {
    const g = setLegGaps(base, 2, [{ from: 0.4, to: 0.5 }]);
    expect(g.items[2]).toEqual({ siteId: 32, leg: { gaps: [{ from: 0.4, to: 0.5 }] } });
    const styled = { ...base, items: base.items.map((i, k) => (k === 2 ? { ...i, leg: { style: "line" as const, gaps: [{ from: 0, to: 0.1 }] } } : i)) };
    expect(setLegGaps(styled, 2, []).items[2]).toEqual({ siteId: 32, leg: { style: "line" } });
    expect(setLegGaps(g, 2, []).items[2]).toEqual({ siteId: 32 });
    expect(setLegGaps(base, 0, [{ from: 0, to: 1 }])).toBe(base);
  });
});

describe("leg props (docs/course-editor.md §6.7)", () => {
  const corridor = { widthM: 50, edge: true, whiteMm: 5, whiteOpacity: 1 };
  const base: S = {
    version: 1, id: "c", orderMode: "ordered",
    items: [{ siteId: 1 }, { siteId: 31 }, { siteId: 32, leg: { gaps: [{ from: 0.2, to: 0.3 }], bends: [{ x: 5, y: 5 }] } }, { siteId: 9 }],
  };

  it("merges a patch into the item's leg and keeps its other props", () => {
    const next = setLegProps(base, 2, { style: "marked_route", corridor });
    expect(next.items[2]).toEqual({ siteId: 32, leg: { gaps: [{ from: 0.2, to: 0.3 }], bends: [{ x: 5, y: 5 }], style: "marked_route", corridor } });
    expect(next.items.filter((_, i) => i !== 2)).toEqual(base.items.filter((_, i) => i !== 2));
    expect(base.items[2]).toEqual({ siteId: 32, leg: { gaps: [{ from: 0.2, to: 0.3 }], bends: [{ x: 5, y: 5 }] } });
  });

  it("drops a key set to undefined, the default style and an empty bends list", () => {
    const styled = setLegProps(base, 2, { style: "none", corridor });
    expect(setLegProps(styled, 2, { corridor: undefined }).items[2]).toEqual({ siteId: 32, leg: { gaps: [{ from: 0.2, to: 0.3 }], bends: [{ x: 5, y: 5 }], style: "none" } });
    expect(setLegProps(styled, 2, { style: "line" }).items[2]).toEqual({ siteId: 32, leg: { gaps: [{ from: 0.2, to: 0.3 }], bends: [{ x: 5, y: 5 }], corridor } });
    expect(setLegProps(base, 2, { bends: [] }).items[2]).toEqual({ siteId: 32, leg: { gaps: [{ from: 0.2, to: 0.3 }] } });
  });

  it("drops a leg left empty, and gives a leg to an item that had none", () => {
    expect(setLegProps(base, 2, { gaps: undefined, bends: [] }).items[2]).toEqual({ siteId: 32 });
    expect(setLegProps(base, 1, { bends: [{ x: 1, y: 2 }] }).items[1]).toEqual({ siteId: 31, leg: { bends: [{ x: 1, y: 2 }] } });
  });

  it("is a no-op on the first item, past the end and on a variation", () => {
    expect(setLegProps(base, 0, { style: "none" })).toBe(base);
    expect(setLegProps(base, 9, { style: "none" })).toBe(base);
  });

  it("an item whose predecessor changes still loses its leg (bends and corridor with it)", () => {
    const withLeg = setLegProps(base, 2, { corridor });
    const moved = removeVisit(withLeg, 0, kindOf);
    expect(moved.items.map((i) => (i.kind === "variation" ? null : i.siteId))).toEqual([1, 32, 9]);
    expect(moved.items[1]).toEqual({ siteId: 32 });
  });
});

describe("variation groups (docs/course-editor.md §12, F7)", () => {
  type Item = S["items"][number];
  const g = (id: string, alts: number[][], loop = false): Item => ({
    kind: "variation", id,
    alternatives: alts.map((list, i) => ({ label: String.fromCharCode(65 + i), items: list.map((siteId) => ({ siteId })) })),
    ...(loop ? { loop: true } : {}),
  });
  const mk = (...items: (number | Item)[]): S => ({ version: 1, id: "c", orderMode: "ordered", items: items.map((i) => (typeof i === "number" ? { siteId: i } : i)) });
  /** Top-level ids, a group as `[A ids | B ids …]`. */
  const show = (s: S) => s.items.map((i) => (i.kind === "variation" ? `[${i.alternatives.map((a) => a.items.map((c) => c.siteId).join(" ")).join("|")}]` : String(i.siteId))).join(" ");
  // S 31 [41 | –] 32 F: Course view on A shows 31 41 32, on B 31 32.
  const s = mk(1, 31, g("v1", [[41], []]), 32, 9);
  const onB = { v1: ["B"] };

  it("the control sequence is the displayed path's", () => {
    expect(controlSequence(s, kindOf)).toEqual([31, 41, 32]);
    expect(controlSequence(s, kindOf, onB)).toEqual([31, 32]);
  });

  it("a position after a group lands after it at the top level (the off-by-group positions before F7)", () => {
    expect(show(insertSite(s, 3, 40, kindOf))).toBe("1 31 [41|] 32 40 9");
    expect(show(insertSite(s, 0, 40, kindOf))).toBe("1 40 31 [41|] 32 9");
    expect(show(removeVisit(s, 2, kindOf))).toBe("1 31 [41|] 9");
    expect(show(moveVisit(mk(1, 31, g("v1", [[41], []]), 32, 33, 9), 3, 2, kindOf))).toBe("1 31 [41|] 33 32 9");
    // ↑ / ↓ keep a row's level: a top-level row never enters a group, an alternative's row moves inside it.
    expect(show(moveVisit(mk(1, 31, g("v1", [[], []]), 32, 33, 9), 2, 1, kindOf))).toBe("1 31 [|] 33 32 9");
    expect(show(moveVisit(mk(1, 31, g("v1", [[41, 42], []]), 32, 9), 2, 1, kindOf))).toBe("1 31 [42 41|] 32 9");
  });

  it("the legs of a group insert into it: into the alternative, out of its last control, the straight leg of an empty active one", () => {
    expect(show(insertSite(s, 1, 40, kindOf))).toBe("1 31 [40 41|] 32 9");
    expect(show(insertSite(s, 2, 40, kindOf))).toBe("1 31 [41 40|] 32 9");
    expect(show(insertSite(s, 1, 40, kindOf, onB))).toBe("1 31 [41|40] 32 9");
    // The leg into the anchor stays top-level.
    expect(show(insertSite(s, 0, 40, kindOf, onB))).toBe("1 40 31 [41|] 32 9");
  });

  it("a loop: the anchor visit row takes no ✕, no move and no leg; the legs around it belong to the alternatives", () => {
    const loop = mk(1, 31, g("b", [[41], [42]], true), 31, 9);
    expect(controlSequence(loop, kindOf)).toEqual([31, 41, 31, 42, 31]);
    expect(removeVisit(loop, 2, kindOf)).toBe(loop);
    expect(moveVisit(loop, 2, 0, kindOf)).toBe(loop);
    expect(setLegProps(loop, { itemIndex: 2, anchorVisit: true }, { style: "none" })).toBe(loop);
    expect(show(insertSite(loop, 2, 40, kindOf))).toBe("1 31 [41 40|42] 31 9");
    expect(show(insertSite(loop, 3, 40, kindOf))).toBe("1 31 [41|40 42] 31 9");
    // Course view with B active shows B first.
    expect(controlSequence(loop, kindOf, { b: ["B", "A"] })).toEqual([31, 42, 31, 41, 31]);
  });

  it("removing every visit reaches the alternatives; a group left unanchored dissolves, an all-empty one stays", () => {
    expect(show(removeSite(s, 41))).toBe("1 31 [|] 32 9");
    expect(show(removeSite(mk(31, g("v1", [[41], [42]]), 32, 9), 31))).toBe("41 32 9");
  });

  it("the item after a group keeps its leg while the group changes; an alternative's first item keeps its leg from the anchor", () => {
    const legged = mk(1, 31, { kind: "variation", id: "v1", alternatives: [{ label: "A", items: [{ siteId: 41, leg: { style: "none" } }] }, { label: "B", items: [] }] }, { siteId: 32, leg: { style: "marked_route" } }, 9);
    const out = insertSite(legged, 2, 40, kindOf);
    expect(out.items[3]).toEqual({ siteId: 32, leg: { style: "marked_route" } });
    expect((out.items[2] as Extract<Item, { kind: "variation" }>).alternatives[0].items[0]).toEqual({ siteId: 41, leg: { style: "none" } });
    // A control inserted before 41 changes its predecessor: 41's leg goes.
    const before = insertSite(legged, 1, 40, kindOf);
    expect((before.items[2] as Extract<Item, { kind: "variation" }>).alternatives[0].items[1]).toEqual({ siteId: 41 });
  });

  it("leg props by path: an alternative's item", () => {
    const out = setLegProps(s, { itemIndex: 2, alt: { label: "A", index: 0 } }, { style: "marked_route" });
    expect(itemAtPath(out, { itemIndex: 2, alt: { label: "A", index: 0 } })).toEqual({ siteId: 41, leg: { style: "marked_route" } });
    expect(setLegProps(s, 2, { style: "none" })).toBe(s);
  });

  it("number hiding reaches the alternatives", () => {
    expect(itemAtPath(setNumberHidden(s, 41, true), { itemIndex: 2, alt: { label: "A", index: 0 } })).toEqual({ siteId: 41, numberHidden: true });
  });

  it("Create variation here: a top-level leg becomes a group of empty A and B, nowhere else", () => {
    const plain = mk(1, 31, 32, 9);
    const made = createGroup(plain, 1, kindOf)!;
    expect(show(made.structure)).toBe("1 31 [|] 32 9");
    expect(made.groupId).toBe("v1");
    expect(createGroup(made.structure, 1, kindOf, {})).toBeNull();
    expect(canCreateGroup(plain, 0, kindOf)).toBe(true);
    expect(canCreateGroup(plain, 2, kindOf)).toBe(true);
    // Inside or across a group: no.
    expect(canCreateGroup(s, 1, kindOf)).toBe(false);
    expect(canCreateGroup(s, 2, kindOf)).toBe(false);
    expect(canCreateGroup(s, 3, kindOf)).toBe(true);
    expect(createGroup(s, 3, kindOf)!.groupId).toBe("v2");
    // The leg's props stay on its end item: they are the group's exit leg, every alternative's.
    const legged: S = { ...plain, items: [{ siteId: 1 }, { siteId: 31 }, { siteId: 32, leg: { style: "marked_route", bends: [{ x: 1, y: 1 }] } }, { siteId: 9 }] };
    expect(createGroup(legged, 1, kindOf)!.structure.items[3]).toEqual({ siteId: 32, leg: { style: "marked_route", bends: [{ x: 1, y: 1 }] } });
  });

  it("a loop with an empty active petal: the drawn petal's legs stay that petal's; with every petal empty the active one fills", () => {
    const loop = mk(1, 31, g("b", [[], [42]], true), 31, 9);
    // Displayed: 31 42 31 — the leg 31 → 42 is petal B's.
    expect(show(insertSite(loop, 1, 40, kindOf))).toBe("1 31 [|40 42] 31 9");
    expect(show(insertSite(mk(1, 31, g("b", [[], []], true), 31, 9), 1, 40, kindOf, { b: ["B", "A"] }))).toBe("1 31 [|40] 31 9");
  });

  it("add, remove, rename an alternative; the loop flag", () => {
    const added = addAlternative(s, "v1")!;
    expect(added.label).toBe("C");
    expect(show(added.structure)).toBe("1 31 [41||] 32 9");
    expect(show(removeAlternative(added.structure, "v1", "B"))).toBe("1 31 [41|] 32 9");
    // Two left: the group dissolves into the other's controls.
    expect(show(removeAlternative(s, "v1", "B"))).toBe("1 31 41 32 9");
    expect(show(removeAlternative(s, "v1", "A"))).toBe("1 31 32 9");
    const renamed = renameAlternative(s, "v1", "B", " Z ");
    expect((renamed.items[2] as Extract<Item, { kind: "variation" }>).alternatives.map((a) => a.label)).toEqual(["A", "Z"]);
    expect(renameAlternative(s, "v1", "B", "A")).toBe(s);
    expect(renameAlternative(s, "v1", "B", "  ")).toBe(s);
    expect((setLoop(s, "v1", true).items[2] as { loop?: boolean }).loop).toBe(true);
    expect(setLoop(setLoop(s, "v1", true), "v1", false).items[2]).toEqual(s.items[2]);
  });

  it("drag a row into an alternative: it goes to the end of that alternative's controls", () => {
    expect(show(moveToAlternative(s, 2, "v1", "B", kindOf))).toBe("1 31 [41|32] 9");
    expect(show(moveToAlternative(s, 1, "v1", "B", kindOf))).toBe("1 31 [|41] 32 9");
    expect(moveToAlternative(s, 1, "v9", "B", kindOf)).toBe(s);
  });
});
