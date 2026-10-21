import { describe, expect, it } from "vitest";
import {
  candidateIsCurrent,
  jobProgressPercent,
  isJobPending,
  orderReviewRows,
  pendingToDecisions,
  rowOutcome,
  scopePreviewUrl,
  setPending,
  summariseOutcomes,
  type PendingDecisions,
  type ReviewRowLike,
} from "../map-review";

function row(over: Partial<ReviewRowLike> & { symbolIdx: number; code: string }): ReviewRowLike {
  return { objects: 1, flags: [], match: null, ...over };
}

const match = (
  state: "auto" | "suggested" | "unmatched",
  method: string,
  canonicalId: string | null,
) => ({ state, method, canonicalId, reviewed: method === "explicit" });

describe("rowOutcome", () => {
  it("reads the stored match as the reviewer sees it", () => {
    expect(rowOutcome(null)).toBe("none");
    expect(rowOutcome(match("auto", "code+geometry", "ISOM2017-2:706"))).toBe("auto");
    expect(rowOutcome(match("suggested", "description", "ISOM2017-2:703"))).toBe("suggested");
    expect(rowOutcome(match("unmatched", "none", null))).toBe("unmatched");
    expect(rowOutcome(match("unmatched", "variant", null))).toBe("variant");
    expect(rowOutcome(match("auto", "explicit", "ISOM2017-2:703"))).toBe("accepted");
    expect(rowOutcome(match("unmatched", "explicit", null))).toBe("kept");
  });
});

describe("orderReviewRows", () => {
  it("sorts used rows by usage, then code, and collapses unused rows (06 §5.1)", () => {
    const rows = [
      row({ symbolIdx: 0, code: "701.0", objects: 1 }),
      row({ symbolIdx: 1, code: "505.0", objects: 40 }),
      row({ symbolIdx: 2, code: "112.0", objects: 0, flags: ["unused"] }),
      row({ symbolIdx: 3, code: "403.0", objects: 40 }),
      row({ symbolIdx: 4, code: "1010.0", objects: 1 }),
      row({ symbolIdx: 5, code: "101.0", objects: 0, flags: ["unused", "hidden"] }),
    ];
    const { used, unused } = orderReviewRows(rows);
    expect(used.map((r) => r.code)).toEqual(["403.0", "505.0", "701.0", "1010.0"]);
    expect(unused.map((r) => r.code)).toEqual(["101.0", "112.0"]);
  });
});

describe("pending decisions", () => {
  const suggested = row({ symbolIdx: 9, code: "850.1", match: match("suggested", "geometry", "ISOM2017-2:202") });
  const accepted = row({ symbolIdx: 1, code: "702.0", match: match("auto", "explicit", "ISOM2017-2:703") });
  const kept = row({ symbolIdx: 2, code: "999.0", match: match("unmatched", "explicit", null) });

  it("keeps one decision per row, the later one winning", () => {
    let p: PendingDecisions = new Map();
    p = setPending(p, suggested, { accept: "ISOM2017-2:202" });
    p = setPending(p, suggested, { unmatch: true });
    expect(pendingToDecisions(p)).toEqual([{ symbolIdx: 9, unmatch: true }]);
  });

  it("accepting a suggested match is a decision (it makes the row reviewed)", () => {
    const p = setPending(new Map(), suggested, { accept: "ISOM2017-2:202" });
    expect(pendingToDecisions(p)).toEqual([{ symbolIdx: 9, accept: "ISOM2017-2:202" }]);
  });

  it("drops a decision that restates the row's explicit decision", () => {
    let p: PendingDecisions = new Map();
    p = setPending(p, accepted, { accept: "ISOM2017-2:703" });
    p = setPending(p, kept, { unmatch: true });
    expect(p.size).toBe(0);
    p = setPending(p, accepted, { accept: "ISOM2017-2:704" });
    expect(p.size).toBe(1);
    p = setPending(p, accepted, { accept: "ISOM2017-2:703" });
    expect(p.size).toBe(0);
  });

  it("offers reset only on rows with an explicit decision", () => {
    expect(setPending(new Map(), suggested, { reset: true }).size).toBe(0);
    expect(pendingToDecisions(setPending(new Map(), kept, { reset: true }))).toEqual([{ symbolIdx: 2, reset: true }]);
  });

  it("null clears the row; decisions come out in symbol order", () => {
    let p: PendingDecisions = new Map();
    p = setPending(p, suggested, { unmatch: true });
    p = setPending(p, kept, { reset: true });
    p = setPending(p, accepted, { unmatch: true });
    expect(pendingToDecisions(p).map((d) => d.symbolIdx)).toEqual([1, 2, 9]);
    p = setPending(p, kept, null);
    expect(pendingToDecisions(p).map((d) => d.symbolIdx)).toEqual([1, 9]);
  });

  it("marks the candidate the row draws", () => {
    expect(candidateIsCurrent(suggested, "ISOM2017-2:202")).toBe(true);
    expect(candidateIsCurrent(suggested, "ISOM2017-2:203")).toBe(false);
    expect(candidateIsCurrent(row({ symbolIdx: 0, code: "1" }), "ISOM2017-2:202")).toBe(false);
  });
});

describe("summariseOutcomes", () => {
  it("counts used and unused rows by outcome", () => {
    const counts = summariseOutcomes([
      row({ symbolIdx: 0, code: "a", match: match("suggested", "geometry", "x") }),
      row({ symbolIdx: 1, code: "b", match: match("suggested", "geometry", "x"), objects: 0, flags: ["unused"] }),
      row({ symbolIdx: 2, code: "c", match: match("auto", "explicit", "x") }),
      row({ symbolIdx: 3, code: "d", match: match("auto", "code+geometry", "x") }),
    ]);
    expect(counts).toEqual({ suggested: 2, accepted: 1, kept: 0, auto: 1, unmatched: 0, variant: 0, none: 0 });
  });
});

describe("scopePreviewUrl", () => {
  it("scopes document previews to the event, never library previews (map-import.md §2.2)", () => {
    const doc = `/api/map-documents/${"a".repeat(64)}/symbols/3.png`;
    expect(scopePreviewUrl(doc, "Club_2026")).toBe(`${doc}?event=Club_2026`);
    expect(scopePreviewUrl(doc, null)).toBe(doc);
    expect(scopePreviewUrl("/api/library/ISOM2017-2/2026.10.1/703.png", "Club_2026")).toBe(
      "/api/library/ISOM2017-2/2026.10.1/703.png",
    );
    expect(scopePreviewUrl(null, "x")).toBeNull();
    expect(scopePreviewUrl(doc, "å b")).toBe(`${doc}?event=%C3%A5%20b`);
  });
});

describe("job progress", () => {
  it("knows pending states and maps progress to a percentage", () => {
    expect(isJobPending("queued")).toBe(true);
    expect(isJobPending("running")).toBe(true);
    expect(isJobPending("done")).toBe(false);
    expect(isJobPending("failed")).toBe(false);
    expect(jobProgressPercent(0.55)).toBe(55);
    expect(jobProgressPercent(1.2)).toBe(100);
    expect(jobProgressPercent(-1)).toBe(0);
  });
});
