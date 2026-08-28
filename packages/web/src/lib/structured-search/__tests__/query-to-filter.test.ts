import { describe, it, expect, beforeEach } from "vitest";
import { parseExpression, serializeExpression, resetIdCounter } from "../parser";
import { applyFilters } from "../filter";
import { createRunnerAnchors } from "../anchors/runner-anchors";
import { createResultAnchors } from "../anchors/result-anchors";
import { createCardAnchors } from "../anchors/card-anchors";
import type { RunnerInfo } from "@oxygen/shared";

/**
 * End-to-end coverage for the search pipeline: raw query string →
 * `parseExpression` → `applyFilters` → matching rows.
 *
 * The pre-existing suites test the two halves in isolation — `parser.test.ts`
 * parses strings but never filters, `filter.test.ts` filters hand-built token
 * objects but never parses. That seam is where operator inference lives, so a
 * query could parse into an operator the matcher couldn't satisfy and both
 * suites would still pass. `name:"Kempe, Hugo"` did exactly that: the comma
 * inside the quotes was read as an `in` list separator, turning a substring
 * search into an exact match against "kempe" or "hugo".
 */

const anchors = createRunnerAnchors((k) => k);

function runner(over: Partial<RunnerInfo> & { id: number; name: string }): RunnerInfo {
  return {
    cardNo: 0,
    className: "",
    clubName: "",
    status: 1,
    startTime: 0,
    finishTime: 0,
    ...over,
  } as RunnerInfo;
}

const runners: RunnerInfo[] = [
  runner({ id: 1, name: "Kempe, Hugo", className: "H12", clubName: "OK Linné" }),
  runner({ id: 2, name: "Kempe, Marcus", className: "H45", clubName: "OK Linné" }),
  runner({ id: 3, name: "Hugo, Karlsson", className: "H12", clubName: "Söders SOL" }),
  runner({ id: 4, name: "Andersson, Anna", className: "D21", clubName: "Öppen klubb, Lund" }),
  runner({ id: 5, name: "Monica Henriksson", className: "Öppen 1", clubName: "Nyköpings OK" }),
  runner({ id: 6, name: "Nils Nilsson", className: "Öppen 2", clubName: "Nyköpings OK" }),
];

function search(query: string): number[] {
  const expr = parseExpression(query, anchors as never);
  return applyFilters(runners, expr, anchors, ["name", "clubName", "className"]).map(
    (r) => r.id,
  );
}

beforeEach(() => resetIdCounter());

describe("query string → filter (runners)", () => {
  it('matches an Eventor "Last, First" name from a quoted deep link', () => {
    // The exact regression: /runners?q=name:"Kempe, Hugo"
    expect(search('name:"Kempe, Hugo"')).toEqual([1]);
  });

  it("keeps the comma literal rather than splitting it into an in-list", () => {
    const expr = parseExpression('name:"Kempe, Hugo"', anchors as never);
    expect(expr.roots[0]).toMatchObject({
      anchor: "name",
      operator: "contains",
      value: "Kempe, Hugo",
    });
  });

  it("still substring-matches a partial quoted name", () => {
    expect(search('name:"Kempe, "')).toEqual([1, 2]);
    expect(search("name:Kempe")).toEqual([1, 2]);
  });

  it("does not match when the comma order is reversed", () => {
    expect(search('name:"Hugo, Kempe"')).toEqual([]);
  });

  it("matches a club name that itself contains a comma", () => {
    expect(search('club:"Öppen klubb, Lund"')).toEqual([4]);
  });

  it("combines a quoted comma name with another anchor", () => {
    expect(search('name:"Kempe, Hugo" class:H12')).toEqual([1]);
    expect(search('name:"Kempe, Hugo" class:D21')).toEqual([]);
  });

  it("negates a quoted comma name", () => {
    expect(search('!name:"Kempe, Hugo"')).toEqual([2, 3, 4, 5, 6]);
  });

  it("ORs two quoted comma names", () => {
    expect(search('name:"Kempe, Hugo"|name:"Andersson, Anna"')).toEqual([1, 4]);
  });

  it("matches a quoted comma name as free text too", () => {
    expect(search('"Kempe, Hugo"')).toEqual([1]);
  });
});

describe("in-lists still work where the anchor supports them", () => {
  it("splits an unquoted comma list", () => {
    expect(search("class:H12,D21")).toEqual([1, 3, 4]);
  });

  it("splits a list whose items are individually quoted", () => {
    expect(search('class:"Öppen 1","Öppen 2"')).toEqual([5, 6]);
  });

  it("treats a fully quoted comma value as one literal class name", () => {
    // Quotes are the escape hatch: this asks for a single class literally
    // named `H12,D21`, which does not exist.
    expect(search('class:"H12,D21"')).toEqual([]);
  });

  it("round-trips a multi-word in-list through serialize → parse", () => {
    const query = 'class:"Öppen 1","Öppen 2"';
    const expr = parseExpression(query, anchors as never);
    const out = serializeExpression(expr);
    expect(out).toBe(query);
    expect(search(out)).toEqual([5, 6]);
  });
});

describe("operator inference respects the anchor's declared operators", () => {
  it("never infers `in` for an anchor without it", () => {
    // `name` declares ["contains", "wildcard"] — a comma must stay literal.
    const expr = parseExpression("name:Kempe,Hugo", anchors as never);
    expect(expr.roots[0]).toMatchObject({ operator: "contains" });
  });

  it("never infers a range operator for an anchor without it", () => {
    // `bib` declares ["eq", "contains"] — `>` is part of the value.
    const expr = parseExpression("bib:>5", anchors as never);
    expect(expr.roots[0]).toMatchObject({ anchor: "bib", operator: "eq", value: ">5" });
  });

  it("still infers ranges where the anchor declares them", () => {
    const expr = parseExpression("age:>=20", anchors as never);
    expect(expr.roots[0]).toMatchObject({ anchor: "age", operator: "gte", value: "20" });
  });

  it("does not infer a wildcard inside a quoted value", () => {
    const expr = parseExpression('name:"a*b"', anchors as never);
    expect(expr.roots[0]).toMatchObject({ operator: "contains", value: "a*b" });
  });

  it("still infers a wildcard for an unquoted value", () => {
    const expr = parseExpression("name:Kempe*", anchors as never);
    expect(expr.roots[0]).toMatchObject({ operator: "wildcard", value: "Kempe*" });
  });
});

describe("other pages that search runner names", () => {
  it("results page name anchor handles a comma name", () => {
    const resultAnchors = createResultAnchors((k) => k);
    const rows = [
      { id: 1, name: "Kempe, Hugo" },
      { id: 2, name: "Nilsson, Nils" },
    ];
    const expr = parseExpression('name:"Kempe, Hugo"', resultAnchors as never);
    const out = applyFilters(rows as never[], expr, resultAnchors as never);
    expect(out.map((r) => (r as { id: number }).id)).toEqual([1]);
  });

  it("cards page runner anchor handles a comma name", () => {
    const cardAnchors = createCardAnchors((k) => k);
    const rows = [
      { cardNo: 1, runner: { name: "Kempe, Hugo" } },
      { cardNo: 2, runner: { name: "Nilsson, Nils" } },
    ];
    const expr = parseExpression('runner:"Kempe, Hugo"', cardAnchors as never);
    const out = applyFilters(rows as never[], expr, cardAnchors as never);
    expect(out.map((r) => (r as { cardNo: number }).cardNo)).toEqual([1]);
  });
});
