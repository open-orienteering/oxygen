import { describe, it, expect } from "vitest";
import { applyFilters } from "../filter";
import { createRunnerAnchors, parseTimeValue } from "../anchors/runner-anchors";
import type { RunnerInfo } from "@oxygen/shared";
import { RunnerStatus } from "@oxygen/shared";
import type { AnchorDef } from "../types";

const anchors = createRunnerAnchors((k) => k) as AnchorDef<RunnerInfo>[];

const runners: RunnerInfo[] = [
  {
    id: 1, name: "Anna Svensson", cardNo: 2345678, clubId: 1, clubName: "Skogslansen",
    classId: 1, className: "H21", startNo: 1, startTime: 36000, finishTime: 39600,
    status: RunnerStatus.OK, fee: 100, paid: 100, birthYear: 2000, sex: "F",
    bib: "101", nationality: "SWE",
    punchControlCodes: [31, 42, 55], courseControlCodes: [31, 42, 55], rank: 1,
    cardStartTime: 35990,
  },
  {
    id: 2, name: "Erik Johansson", cardNo: 4123456, clubId: 2, clubName: "OK Linné",
    classId: 2, className: "D21", startNo: 2, startTime: 36600, finishTime: 0,
    status: RunnerStatus.Unknown, fee: 100, paid: 50, birthYear: 1990, sex: "M",
    bib: "102", nationality: "NOR",
    punchControlCodes: [31, 42], courseControlCodes: [31, 42, 60],
    cardStartTime: 36590,
  },
  {
    id: 3, name: "Lisa Karlsson", cardNo: 1234567, clubId: 1, clubName: "Skogslansen",
    classId: 1, className: "H21", startNo: 3, startTime: 0, finishTime: 0,
    status: RunnerStatus.DNS, fee: 100, paid: 0, birthYear: 2005, sex: "F",
    bib: "103", nationality: "SWE",
    courseControlCodes: [31, 42, 55],
  },
  {
    id: 4, name: "Olof Berg", cardNo: 7654321, clubId: 3, clubName: "Skogslansen IF",
    classId: 3, className: "H35", startNo: 4, startTime: 37200, finishTime: 40800,
    status: RunnerStatus.MissingPunch, fee: 80, paid: 80, birthYear: 1988, sex: "M",
    bib: "104", nationality: "FIN",
    punchControlCodes: [31, 55], courseControlCodes: [31, 42, 55], rank: 0,
    cardStartTime: 37190,
  },
];

describe("applyFilters", () => {
  it("returns all items when no tokens", () => {
    expect(applyFilters(runners, [], anchors)).toHaveLength(4);
  });

  it("filters by class (eq)", () => {
    const tokens = [{ id: "1", anchor: "class", operator: "eq" as const, value: "H21" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([1, 3]);
  });

  it("filters by class (in)", () => {
    const tokens = [{ id: "1", anchor: "class", operator: "in" as const, value: "H21,D21" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([1, 2, 3]);
  });

  it("filters by club with wildcard", () => {
    const tokens = [{ id: "1", anchor: "club", operator: "wildcard" as const, value: "Skogslansen*" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([1, 3, 4]);
  });

  it("filters by club exact", () => {
    const tokens = [{ id: "1", anchor: "club", operator: "eq" as const, value: "Skogslansen" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([1, 3]);
  });

  it("filters by card type si8", () => {
    const tokens = [{ id: "1", anchor: "card", operator: "eq" as const, value: "si8" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([1]); // cardNo 2345678
  });

  it("filters by card type pcard", () => {
    const tokens = [{ id: "1", anchor: "card", operator: "eq" as const, value: "pcard" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([2]); // cardNo 4123456 = pCard range
  });

  it("filters by card type si10", () => {
    const tokens = [{ id: "1", anchor: "card", operator: "eq" as const, value: "si10" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([4]); // cardNo 7654321 = SI10 range
  });

  it("filters by card type in (si8,pcard)", () => {
    const tokens = [{ id: "1", anchor: "card", operator: "in" as const, value: "si8,pcard" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([1, 2]);
  });

  it("filters by status ok", () => {
    const tokens = [{ id: "1", anchor: "status", operator: "eq" as const, value: "ok" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([1]);
  });

  it("filters by status mp", () => {
    const tokens = [{ id: "1", anchor: "status", operator: "eq" as const, value: "mp" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([4]);
  });

  it("filters by status dns", () => {
    const tokens = [{ id: "1", anchor: "status", operator: "eq" as const, value: "dns" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([3]);
  });

  it("filters by logical status 'finished'", () => {
    const tokens = [{ id: "1", anchor: "status", operator: "eq" as const, value: "finished" }];
    const result = applyFilters(runners, tokens, anchors);
    // Runners with status>0 or finishTime>0: Anna (OK), Lisa (DNS), Olof (MP)
    expect(result.map(r => r.id)).toEqual([1, 3, 4]);
  });

  it("filters by age < 25", () => {
    const tokens = [{ id: "1", anchor: "age", operator: "lt" as const, value: "25" }];
    const result = applyFilters(runners, tokens, anchors);
    // birthYear 2005 → age 21, birthYear 2000 → age 26
    expect(result.map(r => r.id)).toEqual([3]);
  });

  it("filters by age > 30", () => {
    const tokens = [{ id: "1", anchor: "age", operator: "gt" as const, value: "30" }];
    const result = applyFilters(runners, tokens, anchors);
    // 1990 → 36, 1988 → 38
    expect(result.map(r => r.id)).toEqual([2, 4]);
  });

  it("filters by sex", () => {
    const tokens = [{ id: "1", anchor: "sex", operator: "eq" as const, value: "f" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([1, 3]);
  });

  it("filters by paid:yes", () => {
    const tokens = [{ id: "1", anchor: "paid", operator: "eq" as const, value: "yes" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([1, 4]); // paid >= fee
  });

  it("filters by paid:no", () => {
    const tokens = [{ id: "1", anchor: "paid", operator: "eq" as const, value: "no" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([3]); // paid === 0
  });

  it("filters by paid:partial", () => {
    const tokens = [{ id: "1", anchor: "paid", operator: "eq" as const, value: "partial" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([2]); // 0 < 50 < 100
  });

  it("filters by start:assigned", () => {
    const tokens = [{ id: "1", anchor: "start", operator: "eq" as const, value: "assigned" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([1, 2, 4]);
  });

  it("filters by nation", () => {
    const tokens = [{ id: "1", anchor: "nation", operator: "eq" as const, value: "SWE" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([1, 3]);
  });

  it("ANDs multiple tokens", () => {
    const tokens = [
      { id: "1", anchor: "class", operator: "eq" as const, value: "H21" },
      { id: "2", anchor: "sex", operator: "eq" as const, value: "f" },
    ];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([1, 3]);
  });

  it("handles free text search", () => {
    const tokens = [{ id: "1", anchor: "", operator: "contains" as const, value: "anna" }];
    const result = applyFilters(runners, tokens, anchors, ["name", "clubName"]);
    expect(result.map(r => r.id)).toEqual([1]);
  });

  it("handles free text matching card number", () => {
    const tokens = [{ id: "1", anchor: "", operator: "contains" as const, value: "234" }];
    const result = applyFilters(runners, tokens, anchors, ["name", "clubName", "cardNo" as keyof RunnerInfo]);
    // cardNo 2345678, 4123456, 1234567 all contain "234"
    expect(result.map(r => r.id)).toEqual([1, 2, 3]);
  });

  it("handles name with contains", () => {
    const tokens = [{ id: "1", anchor: "name", operator: "contains" as const, value: "sson" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([1, 2, 3]);
  });

  it("complex compound filter", () => {
    const tokens = [
      { id: "1", anchor: "class", operator: "in" as const, value: "H21,H35" },
      { id: "2", anchor: "status", operator: "eq" as const, value: "ok" },
      { id: "3", anchor: "sex", operator: "eq" as const, value: "f" },
    ];
    const result = applyFilters(runners, tokens, anchors);
    // H21 or H35, status OK, female → only Anna
    expect(result.map(r => r.id)).toEqual([1]);
  });

  // ── New anchors ──

  it("filters by punched control code", () => {
    const tokens = [{ id: "1", anchor: "punched", operator: "eq" as const, value: "42" }];
    const result = applyFilters(runners, tokens, anchors);
    // Anna [31,42,55], Erik [31,42] — Lisa has none, Olof [31,55]
    expect(result.map(r => r.id)).toEqual([1, 2]);
  });

  it("filters by visited (alias for punched)", () => {
    const tokens = [{ id: "1", anchor: "visited", operator: "eq" as const, value: "55" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([1, 4]);
  });

  it("filters by punched with in operator", () => {
    const tokens = [{ id: "1", anchor: "punched", operator: "in" as const, value: "42,60" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([1, 2]);
  });

  it("filters by course control code", () => {
    const tokens = [{ id: "1", anchor: "control", operator: "eq" as const, value: "60" }];
    const result = applyFilters(runners, tokens, anchors);
    // Only Erik has 60 in courseControlCodes
    expect(result.map(r => r.id)).toEqual([2]);
  });

  it("filters by rank", () => {
    const tokens = [{ id: "1", anchor: "rank", operator: "eq" as const, value: "1" }];
    const result = applyFilters(runners, tokens, anchors);
    expect(result.map(r => r.id)).toEqual([1]);
  });

  it("filters by rank with comparison", () => {
    const tokens = [{ id: "1", anchor: "rank", operator: "lte" as const, value: "3" }];
    const result = applyFilters(runners, tokens, anchors);
    // Only Anna has rank=1, others have no rank or rank=0
    expect(result.map(r => r.id)).toEqual([1]);
  });

  it("filters by scheduled start time", () => {
    // 36600 deciseconds = 1:01:00
    const tokens = [{ id: "1", anchor: "scheduled", operator: "gte" as const, value: "1:01:00" }];
    const result = applyFilters(runners, tokens, anchors);
    // Erik 36600 (1:01:00), Olof 37200 (1:02:00) — Anna 36000 (1:00:00) excluded, Lisa 0 excluded
    expect(result.map(r => r.id)).toEqual([2, 4]);
  });

  it("filters by actual card start time", () => {
    // 36590 = Erik's card start
    const tokens = [{ id: "1", anchor: "started", operator: "lt" as const, value: "1:00:00" }];
    const result = applyFilters(runners, tokens, anchors);
    // Anna 35990 < 36000 ✓, Erik 36590 > 36000 ✗, Olof 37190 > 36000 ✗
    expect(result.map(r => r.id)).toEqual([1]);
  });

  it("filters by forest time (finished runner)", () => {
    // Anna: 39600 - 36000 = 3600ds = 6:00, Olof: 40800 - 37200 = 3600ds = 6:00
    // Use a high threshold to only match finished runners with known times
    const tokens = [{ id: "1", anchor: "forest", operator: "lt" as const, value: "0:07:00" }];
    const result = applyFilters(runners, tokens, anchors);
    // Anna 3600ds(6:00) < 4200ds(7:00) ✓, Olof 3600ds(6:00) < 4200ds(7:00) ✓
    // Erik has finishTime=0, startTime=36600 → in-forest using meosNow (varies), excluded by lt
    // Lisa has startTime=0, excluded
    expect(result.map(r => r.id)).toEqual([1, 4]);
  });
});

describe("parseTimeValue", () => {
  it("parses HH:MM:SS", () => {
    expect(parseTimeValue("1:30:00")).toBe(54000); // (1*3600+30*60)*10
  });

  it("parses MM:SS", () => {
    expect(parseTimeValue("45:00")).toBe(27000); // (45*60)*10
  });

  it("parses H:MM:SS", () => {
    expect(parseTimeValue("10:30:00")).toBe(378000); // (10*3600+30*60)*10
  });

  it("returns null for invalid", () => {
    expect(parseTimeValue("abc")).toBeNull();
    expect(parseTimeValue("")).toBeNull();
    expect(parseTimeValue("1:2:3:4")).toBeNull();
  });
});
