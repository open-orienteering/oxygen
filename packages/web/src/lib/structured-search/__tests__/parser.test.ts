import { describe, it, expect, beforeEach } from "vitest";
import { parseQuery, serializeTokens, resetIdCounter } from "../parser";
import type { AnchorDef } from "../types";

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
