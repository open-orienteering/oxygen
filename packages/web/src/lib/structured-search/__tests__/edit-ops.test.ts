import { describe, it, expect } from "vitest";
import {
  appendAtom,
  popLastEntry,
  removeChildFromGroup,
} from "../edit-ops";
import type { Atom, FilterNode, OrGroup } from "../types";
import { isOrGroup } from "../types";

let n = 0;
const idGen = (prefix = "x"): string => `${prefix}_${++n}`;

function atom(value: string, anchor = "class", id = idGen("a")): Atom {
  return { kind: "atom", id, anchor, operator: "eq", value };
}
function group(children: Atom[], id = idGen("g"), negated = false): OrGroup {
  return { kind: "or", id, children, negated };
}

describe("appendAtom", () => {
  it("plain AND append when target is null", () => {
    const a = atom("H21");
    const b = atom("D21");
    const out = appendAtom([a], b, null, idGen);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });

  it("auto-folds two adjacent atoms into an OR group", () => {
    const a = atom("H21");
    const b = atom("D21");
    const out = appendAtom([a], b, "auto", idGen);
    expect(out).toHaveLength(1);
    expect(isOrGroup(out[0])).toBe(true);
    if (isOrGroup(out[0])) {
      expect(out[0].children.map((c) => c.value)).toEqual(["H21", "D21"]);
    }
  });

  it("auto-extends an existing OR group", () => {
    const g = group([atom("H21"), atom("D21")]);
    const c = atom("H35");
    const out = appendAtom([g], c, "auto", idGen);
    expect(out).toHaveLength(1);
    if (isOrGroup(out[0])) {
      expect(out[0].children.map((x) => x.value)).toEqual([
        "H21",
        "D21",
        "H35",
      ]);
    }
  });

  it("auto-fold across an AND boundary keeps the prior atom intact", () => {
    // [a, b] + auto-append c → [a, OR(b, c)]
    const a = atom("status:ok", "status");
    const b = atom("H21");
    const c = atom("D21");
    const out = appendAtom([a, b], c, "auto", idGen);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(a);
    if (isOrGroup(out[1])) {
      expect(out[1].children.map((x) => x.value)).toEqual(["H21", "D21"]);
    } else {
      throw new Error("expected OR group at index 1");
    }
  });

  it("auto append when no previous root just appends", () => {
    const a = atom("H21");
    const out = appendAtom([], a, "auto", idGen);
    expect(out).toEqual([a]);
  });

  it("auto append when previous root is a NEGATED group falls back to AND", () => {
    const g = group([atom("H21"), atom("D21")], idGen("g"), true);
    const c = atom("status:ok", "status");
    const out = appendAtom([g], c, "auto", idGen);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(g);
    expect(out[1]).toBe(c);
  });

  it("appends to a specific group by id", () => {
    const g = group([atom("H21"), atom("D21")], "g_target");
    const a = atom("status:ok", "status");
    const c = atom("H35");
    const out = appendAtom([a, g], c, "g_target", idGen);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(a);
    if (isOrGroup(out[1])) {
      expect(out[1].children.map((x) => x.value)).toEqual([
        "H21",
        "D21",
        "H35",
      ]);
    }
  });

  it("promotes a plain atom into an OR group when targeted by id", () => {
    const a = atom("H21", "class", "a_target");
    const c = atom("D21");
    const out = appendAtom([a], c, "a_target", idGen);
    expect(out).toHaveLength(1);
    if (isOrGroup(out[0])) {
      expect(out[0].children.map((x) => x.value)).toEqual(["H21", "D21"]);
    }
  });

  it("falls back to AND append when target id is missing", () => {
    const a = atom("H21");
    const c = atom("D21");
    const out = appendAtom([a], c, "no_such_id", idGen);
    expect(out).toEqual([a, c]);
  });

  it("preserves negation flag on the appended atom", () => {
    const a = atom("H21");
    const b: Atom = { ...atom("dns", "status"), negated: true };
    const out = appendAtom([a], b, "auto", idGen);
    if (isOrGroup(out[0])) {
      expect(out[0].children[1].negated).toBe(true);
    }
  });
});

describe("removeChildFromGroup", () => {
  it("removes a single child and keeps the group when ≥2 remain", () => {
    const g = group(
      [atom("H21", "class", "c1"), atom("D21", "class", "c2"), atom("H35", "class", "c3")],
      "g1",
    );
    const out = removeChildFromGroup([g], "g1", "c2");
    expect(out).toHaveLength(1);
    if (isOrGroup(out[0])) {
      expect(out[0].children.map((c) => c.id)).toEqual(["c1", "c3"]);
    }
  });

  it("auto-unwraps the group when only one child remains", () => {
    const g = group(
      [atom("H21", "class", "c1"), atom("D21", "class", "c2")],
      "g1",
    );
    const out = removeChildFromGroup([g], "g1", "c2");
    expect(out).toHaveLength(1);
    expect(isOrGroup(out[0])).toBe(false);
    expect((out[0] as Atom).id).toBe("c1");
  });

  it("drops the group entirely when no children remain", () => {
    const g = group([atom("H21", "class", "c1")], "g1");
    // Single-child group is degenerate but possible; remove its only child.
    const out = removeChildFromGroup([g], "g1", "c1");
    expect(out).toEqual([]);
  });

  it("propagates negation onto the unwrapped atom", () => {
    const g = group(
      [atom("H21", "class", "c1"), atom("D21", "class", "c2")],
      "g1",
      true,
    );
    const out = removeChildFromGroup([g], "g1", "c2");
    expect(out).toHaveLength(1);
    expect((out[0] as Atom).negated).toBe(true);
  });

  it("leaves other root nodes untouched", () => {
    const a = atom("status:ok", "status", "a1");
    const g = group(
      [atom("H21", "class", "c1"), atom("D21", "class", "c2")],
      "g1",
    );
    const out = removeChildFromGroup([a, g], "g1", "c2");
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(a);
  });
});

describe("popLastEntry", () => {
  it("removes the entire trailing atom", () => {
    const a = atom("H21", "class", "a1");
    const b = atom("status:ok", "status", "b1");
    const out = popLastEntry([a, b]);
    expect(out).toEqual([a]);
  });

  it("pops the last child of a trailing OR group", () => {
    const g = group(
      [atom("H21", "class", "c1"), atom("D21", "class", "c2"), atom("H35", "class", "c3")],
      "g1",
    );
    const out = popLastEntry([g]);
    if (isOrGroup(out[0])) {
      expect(out[0].children.map((c) => c.id)).toEqual(["c1", "c2"]);
    } else {
      throw new Error("expected group");
    }
  });

  it("auto-unwraps when popping leaves a single child", () => {
    const g = group(
      [atom("H21", "class", "c1"), atom("D21", "class", "c2")],
      "g1",
    );
    const out = popLastEntry([g]);
    expect(out).toHaveLength(1);
    expect(isOrGroup(out[0])).toBe(false);
    expect((out[0] as Atom).id).toBe("c1");
  });

  it("returns an empty list when nothing to pop", () => {
    const out = popLastEntry([] as FilterNode[]);
    expect(out).toEqual([]);
  });
});
