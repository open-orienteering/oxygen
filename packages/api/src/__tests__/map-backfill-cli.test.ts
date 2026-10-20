import { describe, it, expect } from "vitest";
import { parseBackfillArgs, formatItemLine, formatSummary } from "../cli/map-backfill-args.js";
import type { BackfillItemResult, BackfillRun } from "../map-store/backfill.js";

describe("map-backfill argument parsing", () => {
  it("defaults to everything, no limit, live run", () => {
    expect(parseBackfillArgs([])).toEqual({ ok: true, value: { event: null, limit: undefined, dryRun: false } });
  });

  it("accepts flags in either spelling and any order", () => {
    expect(parseBackfillArgs(["--dry-run", "--event", "itest", "--limit=3"])).toEqual({
      ok: true,
      value: { event: "itest", limit: 3, dryRun: true },
    });
    expect(parseBackfillArgs(["--limit", "10", "--event=itest"])).toEqual({
      ok: true,
      value: { event: "itest", limit: 10, dryRun: false },
    });
  });

  it("rejects missing values, bad limits and unknown flags", () => {
    expect(parseBackfillArgs(["--event"])).toMatchObject({ ok: false, error: expect.stringContaining("--event") });
    expect(parseBackfillArgs(["--limit", "0"])).toMatchObject({ ok: false });
    expect(parseBackfillArgs(["--limit", "x"])).toMatchObject({ ok: false });
    expect(parseBackfillArgs(["--limit"])).toMatchObject({ ok: false });
    expect(parseBackfillArgs(["--nope"])).toMatchObject({ ok: false, error: "unknown argument: --nope" });
    expect(parseBackfillArgs(["itest"])).toMatchObject({ ok: false });
  });
});

describe("map-backfill output", () => {
  const base: BackfillItemResult = {
    kind: "club", id: "7", name: "Skogen", eventId: null,
    outcome: "done", jobId: "j", documentHash: "abcdef0123456789ff", deduplicated: false, error: null,
  };
  const run = (over: Partial<BackfillRun>): BackfillRun => ({
    state: "done", startedAt: new Date(1000), finishedAt: new Date(3500), dryRun: false,
    total: 4, processed: 4, done: 3, failed: 1, current: null, failures: [], error: null, ...over,
  });

  it("formats item lines for done, dedup and failed", () => {
    expect(formatItemLine(base, { processed: 1, total: 4 })).toBe("[1/4] club #7 Skogen → done abcdef012345");
    expect(formatItemLine({ ...base, deduplicated: true }, { processed: 2, total: 4 })).toContain("(already imported)");
    expect(formatItemLine({ ...base, kind: "event", eventId: "3", outcome: "failed", documentHash: null, error: "boom" }, { processed: 3, total: 4 }))
      .toBe("[3/4] event #7 Skogen → FAILED: boom");
  });

  it("summarises finished, aborted and dry runs", () => {
    expect(formatSummary(run({}))).toBe("backfill done: 3 imported, 1 failed, 4 total in 2.5 s");
    expect(formatSummary(run({ state: "failed", processed: 2, error: "db gone" }))).toBe("backfill aborted after 2/4: db gone");
    expect(formatSummary(run({ dryRun: true }))).toBe("dry run: 4 map(s) would be imported");
  });
});
