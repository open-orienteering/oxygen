import { describe, it, expect, beforeEach } from "vitest";
import {
  parseQuery,
  parseExpression,
  serializeTokens,
  serializeExpression,
  resetIdCounter,
} from "../parser";
import type { AnchorDef, FilterNode, OrGroup } from "../types";
import { isOrGroup } from "../types";

// Minimal anchor definitions for testing
const testAnchors: AnchorDef<never>[] = [
  {
    key: "class",
    label: "Class",
    type: "string",
    operators: ["eq", "wildcard", "in"],
    defaultOperator: "eq",
    color: "purple",
    match: () => false,
  },
  {
    key: "club",
    label: "Club",
    type: "string",
    operators: ["eq", "wildcard", "in"],
    defaultOperator: "eq",
    color: "teal",
    match: () => false,
  },
  {
    key: "status",
    label: "Status",
    type: "enum",
    operators: ["eq", "in"],
    defaultOperator: "eq",
    color: "green",
    match: () => false,
  },
  {
    key: "age",
    label: "Age",
    type: "number",
    operators: ["eq", "gt", "lt", "gte", "lte"],
    defaultOperator: "eq",
    color: "indigo",
    match: () => false,
  },
  {
    key: "card",
    label: "Card",
    type: "number",
    operators: ["eq", "in"],
    defaultOperator: "eq",
    color: "amber",
    match: () => false,
  },
  {
    key: "name",
    label: "Name",
    type: "string",
    operators: ["contains", "wildcard"],
    defaultOperator: "contains",
    color: "slate",
    match: () => false,
  },
];

beforeEach(() => resetIdCounter());

describe("parseQuery", () => {
  it("returns empty array for empty string", () => {
    expect(parseQuery("", testAnchors)).toEqual([]);
    expect(parseQuery("   ", testAnchors)).toEqual([]);
  });

  it("parses simple anchor:value token", () => {
    const tokens = parseQuery("class:H21", testAnchors);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      anchor: "class",
      operator: "eq",
      value: "H21",
    });
  });

  it("parses multiple tokens", () => {
    const tokens = parseQuery("class:H21 status:ok", testAnchors);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatchObject({ anchor: "class", value: "H21" });
    expect(tokens[1]).toMatchObject({ anchor: "status", value: "ok" });
  });

  it("parses free text as contains token", () => {
    const tokens = parseQuery("Anna", testAnchors);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      anchor: "",
      operator: "contains",
      value: "Anna",
    });
  });

  it("mixes free text and anchored tokens", () => {
    const tokens = parseQuery("Anna class:H21", testAnchors);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toMatchObject({ anchor: "", value: "Anna" });
    expect(tokens[1]).toMatchObject({ anchor: "class", value: "H21" });
  });

  it("detects > operator", () => {
    const tokens = parseQuery("age:>25", testAnchors);
    expect(tokens[0]).toMatchObject({
      anchor: "age",
      operator: "gt",
      value: "25",
    });
  });

  it("detects < operator", () => {
    const tokens = parseQuery("age:<18", testAnchors);
    expect(tokens[0]).toMatchObject({
      anchor: "age",
      operator: "lt",
      value: "18",
    });
  });

  it("detects >= operator", () => {
    const tokens = parseQuery("age:>=20", testAnchors);
    expect(tokens[0]).toMatchObject({
      anchor: "age",
      operator: "gte",
      value: "20",
    });
  });

  it("detects <= operator", () => {
    const tokens = parseQuery("age:<=30", testAnchors);
    expect(tokens[0]).toMatchObject({
      anchor: "age",
      operator: "lte",
      value: "30",
    });
  });

  it("detects comma as in operator", () => {
    const tokens = parseQuery("card:si8,siac", testAnchors);
    expect(tokens[0]).toMatchObject({
      anchor: "card",
      operator: "in",
      value: "si8,siac",
    });
  });

  it("detects wildcard operator", () => {
    const tokens = parseQuery("club:Skogs*", testAnchors);
    expect(tokens[0]).toMatchObject({
      anchor: "club",
      operator: "wildcard",
      value: "Skogs*",
    });
  });

  it("handles quoted values with spaces", () => {
    const tokens = parseQuery('name:"Anna Svensson"', testAnchors);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      anchor: "name",
      operator: "contains",
      value: "Anna Svensson",
    });
  });

  it("handles quoted free text", () => {
    const tokens = parseQuery('"Anna Svensson"', testAnchors);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      anchor: "",
      operator: "contains",
      value: "Anna Svensson",
    });
  });

  it("is case-insensitive for anchor keys", () => {
    const tokens = parseQuery("Class:H21 STATUS:ok", testAnchors);
    expect(tokens[0]).toMatchObject({ anchor: "class", value: "H21" });
    expect(tokens[1]).toMatchObject({ anchor: "status", value: "ok" });
  });

  it("treats unknown anchors as free text", () => {
    const tokens = parseQuery("unknown:value", testAnchors);
    expect(tokens[0]).toMatchObject({
      anchor: "",
      operator: "contains",
      value: "unknown:value",
    });
  });

  it("handles complex multi-token query", () => {
    const tokens = parseQuery(
      'class:H21,D21 age:<25 club:Skogs* name:"Anna Svensson" status:ok',
      testAnchors,
    );
    expect(tokens).toHaveLength(5);
    expect(tokens[0]).toMatchObject({
      anchor: "class",
      operator: "in",
      value: "H21,D21",
    });
    expect(tokens[1]).toMatchObject({
      anchor: "age",
      operator: "lt",
      value: "25",
    });
    expect(tokens[2]).toMatchObject({
      anchor: "club",
      operator: "wildcard",
      value: "Skogs*",
    });
    expect(tokens[3]).toMatchObject({
      anchor: "name",
      operator: "contains",
      value: "Anna Svensson",
    });
    expect(tokens[4]).toMatchObject({
      anchor: "status",
      operator: "eq",
      value: "ok",
    });
  });

  it("assigns unique IDs to each token", () => {
    const tokens = parseQuery("class:H21 status:ok Anna", testAnchors);
    const ids = tokens.map((t) => t.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("serializeTokens", () => {
  it("serializes empty array to empty string", () => {
    expect(serializeTokens([])).toBe("");
  });

  it("serializes a simple anchor token", () => {
    const result = serializeTokens([
      { id: "1", anchor: "class", operator: "eq", value: "H21" },
    ]);
    expect(result).toBe("class:H21");
  });

  it("serializes free text token", () => {
    const result = serializeTokens([
      { id: "1", anchor: "", operator: "contains", value: "Anna" },
    ]);
    expect(result).toBe("Anna");
  });

  it("serializes operator prefixes", () => {
    expect(
      serializeTokens([
        { id: "1", anchor: "age", operator: "gt", value: "25" },
      ]),
    ).toBe("age:>25");
    expect(
      serializeTokens([
        { id: "1", anchor: "age", operator: "lt", value: "18" },
      ]),
    ).toBe("age:<18");
    expect(
      serializeTokens([
        { id: "1", anchor: "age", operator: "gte", value: "20" },
      ]),
    ).toBe("age:>=20");
    expect(
      serializeTokens([
        { id: "1", anchor: "age", operator: "lte", value: "30" },
      ]),
    ).toBe("age:<=30");
  });

  it("serializes comma values (in operator)", () => {
    expect(
      serializeTokens([
        { id: "1", anchor: "class", operator: "in", value: "H21,D21" },
      ]),
    ).toBe("class:H21,D21");
  });

  it("serializes wildcard values", () => {
    expect(
      serializeTokens([
        { id: "1", anchor: "club", operator: "wildcard", value: "Skogs*" },
      ]),
    ).toBe("club:Skogs*");
  });

  it("quotes values with spaces", () => {
    expect(
      serializeTokens([
        {
          id: "1",
          anchor: "name",
          operator: "contains",
          value: "Anna Svensson",
        },
      ]),
    ).toBe('name:"Anna Svensson"');
  });

  it("quotes free text with spaces", () => {
    expect(
      serializeTokens([
        { id: "1", anchor: "", operator: "contains", value: "Anna Svensson" },
      ]),
    ).toBe('"Anna Svensson"');
  });

  it("round-trips a complex query", () => {
    const original =
      'class:H21,D21 age:<25 club:Skogs* name:"Anna Svensson" status:ok';
    const tokens = parseQuery(original, testAnchors);
    const serialized = serializeTokens(tokens);
    expect(serialized).toBe(original);
  });
});

// ─── parseExpression: OR / NOT / parens ─────────────────────────────────

describe("parseExpression", () => {
  function asGroup(node: FilterNode): OrGroup {
    if (!isOrGroup(node)) throw new Error("expected OR group");
    return node;
  }

  it("returns empty roots for empty string", () => {
    expect(parseExpression("", testAnchors)).toEqual({ roots: [] });
    expect(parseExpression("   ", testAnchors)).toEqual({ roots: [] });
  });

  it("parses a flat AND expression", () => {
    const expr = parseExpression("class:H21 status:ok", testAnchors);
    expect(expr.roots).toHaveLength(2);
    expect(isOrGroup(expr.roots[0])).toBe(false);
    expect(isOrGroup(expr.roots[1])).toBe(false);
  });

  it("treats explicit & the same as whitespace", () => {
    const a = parseExpression("class:H21 & status:ok", testAnchors);
    const b = parseExpression("class:H21 status:ok", testAnchors);
    expect(a.roots).toHaveLength(b.roots.length);
    expect((a.roots[0] as { anchor: string }).anchor).toBe("class");
    expect((a.roots[1] as { anchor: string }).anchor).toBe("status");
  });

  it("folds bare | into an OR group", () => {
    const expr = parseExpression("class:H21|class:D21", testAnchors);
    expect(expr.roots).toHaveLength(1);
    const g = asGroup(expr.roots[0]);
    expect(g.children).toHaveLength(2);
    expect(g.children[0]).toMatchObject({ anchor: "class", value: "H21" });
    expect(g.children[1]).toMatchObject({ anchor: "class", value: "D21" });
  });

  it("treats spaces around | as one OR group", () => {
    const expr = parseExpression("class:H21 | class:D21", testAnchors);
    const g = asGroup(expr.roots[0]);
    expect(g.children.map((c) => c.value)).toEqual(["H21", "D21"]);
  });

  it("parses parenthesised OR group followed by AND atom", () => {
    const expr = parseExpression(
      "(class:H21|class:D21) status:ok",
      testAnchors,
    );
    expect(expr.roots).toHaveLength(2);
    const g = asGroup(expr.roots[0]);
    expect(g.children.map((c) => c.value)).toEqual(["H21", "D21"]);
    expect((expr.roots[1] as { anchor: string }).anchor).toBe("status");
  });

  it("flattens nested OR groups inside parens", () => {
    const expr = parseExpression(
      "((class:H21|class:D21)|class:H35)",
      testAnchors,
    );
    expect(expr.roots).toHaveLength(1);
    const g = asGroup(expr.roots[0]);
    expect(g.children.map((c) => c.value)).toEqual(["H21", "D21", "H35"]);
  });

  it("flattens AND inside parens to siblings of the OR group", () => {
    // `(class:H21 status:ok)` — AND inside parens is folded into the OR
    // group's children since UI is depth-1. This is intentionally lossy
    // and documented.
    const expr = parseExpression("(class:H21 status:ok)", testAnchors);
    expect(expr.roots).toHaveLength(1);
    const g = asGroup(expr.roots[0]);
    expect(g.children).toHaveLength(2);
  });

  it("unwraps a single-child paren group to a plain atom", () => {
    const expr = parseExpression("(class:H21)", testAnchors);
    expect(expr.roots).toHaveLength(1);
    expect(isOrGroup(expr.roots[0])).toBe(false);
    expect((expr.roots[0] as { anchor: string; value: string }).anchor).toBe(
      "class",
    );
  });

  it("parses leading ! as negation on the next atom", () => {
    const expr = parseExpression("!status:dns", testAnchors);
    const a = expr.roots[0] as { anchor: string; negated: boolean };
    expect(a.anchor).toBe("status");
    expect(a.negated).toBe(true);
  });

  it("parses ! with a space before the atom", () => {
    const expr = parseExpression("! status:dns", testAnchors);
    const a = expr.roots[0] as { anchor: string; negated: boolean };
    expect(a.negated).toBe(true);
    expect(a.anchor).toBe("status");
  });

  it("parses !( ... ) as a negated OR group", () => {
    const expr = parseExpression("!(class:H21|class:D21)", testAnchors);
    const g = asGroup(expr.roots[0]);
    expect(g.negated).toBe(true);
    expect(g.children).toHaveLength(2);
  });

  it("handles a complex mixed query", () => {
    const expr = parseExpression(
      'class:H21 (club:Linné|club:"OK Tyr") !status:dns',
      testAnchors,
    );
    expect(expr.roots).toHaveLength(3);
    expect((expr.roots[0] as { anchor: string }).anchor).toBe("class");
    const g = asGroup(expr.roots[1]);
    expect(g.children.map((c) => c.value)).toEqual(["Linné", "OK Tyr"]);
    const last = expr.roots[2] as { anchor: string; negated: boolean };
    expect(last.anchor).toBe("status");
    expect(last.negated).toBe(true);
  });

  it("preserves quoted values inside OR groups", () => {
    const expr = parseExpression(
      'club:"OK Tyr"|club:"OK Linné"',
      testAnchors,
    );
    const g = asGroup(expr.roots[0]);
    expect(g.children.map((c) => c.value)).toEqual(["OK Tyr", "OK Linné"]);
  });

  it("ignores stray closing parens", () => {
    const expr = parseExpression("class:H21 ) status:ok", testAnchors);
    expect(expr.roots).toHaveLength(2);
    expect((expr.roots[0] as { anchor: string }).anchor).toBe("class");
    expect((expr.roots[1] as { anchor: string }).anchor).toBe("status");
  });
});

describe("serializeExpression", () => {
  it("serializes a plain atom", () => {
    expect(
      serializeExpression({
        roots: [
          { kind: "atom", id: "1", anchor: "class", operator: "eq", value: "H21" },
        ],
      }),
    ).toBe("class:H21");
  });

  it("serializes negation as !prefix", () => {
    expect(
      serializeExpression({
        roots: [
          {
            kind: "atom",
            id: "1",
            anchor: "status",
            operator: "eq",
            value: "dns",
            negated: true,
          },
        ],
      }),
    ).toBe("!status:dns");
  });

  it("serializes an OR group with parens and pipes", () => {
    expect(
      serializeExpression({
        roots: [
          {
            kind: "or",
            id: "g",
            children: [
              { kind: "atom", id: "1", anchor: "class", operator: "eq", value: "H21" },
              { kind: "atom", id: "2", anchor: "class", operator: "eq", value: "D21" },
            ],
          },
        ],
      }),
    ).toBe("(class:H21|class:D21)");
  });

  it("serializes a negated OR group as !(...)", () => {
    expect(
      serializeExpression({
        roots: [
          {
            kind: "or",
            id: "g",
            negated: true,
            children: [
              { kind: "atom", id: "1", anchor: "class", operator: "eq", value: "H21" },
              { kind: "atom", id: "2", anchor: "class", operator: "eq", value: "D21" },
            ],
          },
        ],
      }),
    ).toBe("!(class:H21|class:D21)");
  });

  it("quotes values containing | inside OR groups", () => {
    const out = serializeExpression({
      roots: [
        {
          kind: "or",
          id: "g",
          children: [
            { kind: "atom", id: "1", anchor: "name", operator: "contains", value: "a|b" },
            { kind: "atom", id: "2", anchor: "name", operator: "contains", value: "c" },
          ],
        },
      ],
    });
    expect(out).toBe('(name:"a|b"|name:c)');
    // and round-trips
    const expr = parseExpression(out, testAnchors);
    const g = expr.roots[0];
    expect(isOrGroup(g)).toBe(true);
    if (isOrGroup(g)) {
      expect(g.children.map((c) => c.value)).toEqual(["a|b", "c"]);
    }
  });

  it("round-trips a mixed AND/OR/NOT query", () => {
    const original =
      'class:H21 (club:Linné|club:"OK Tyr") !status:dns';
    const expr = parseExpression(original, testAnchors);
    const out = serializeExpression(expr);
    expect(out).toBe(original);
  });
});
