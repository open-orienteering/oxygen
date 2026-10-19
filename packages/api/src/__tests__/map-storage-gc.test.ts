import { describe, it, expect, vi } from "vitest";
import { GC_GRACE_DAYS, gcCutoff, isForeignKeyViolation, isGcDue, parseGraceDays } from "../map-store/gc.js";

const H = 3_600_000;
const now = new Date("2026-10-19T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("gcCutoff", () => {
  it("is now minus the grace in whole days", () => {
    expect(gcCutoff(now, 30).toISOString()).toBe("2026-09-19T12:00:00.000Z");
    expect(gcCutoff(now, 1).toISOString()).toBe("2026-10-18T12:00:00.000Z");
  });
});

describe("parseGraceDays", () => {
  it("defaults to 30 and accepts a positive integer override", () => {
    expect(GC_GRACE_DAYS).toBe(30);
    expect(parseGraceDays(null)).toBe(30);
    expect(parseGraceDays("45")).toBe(45);
    expect(parseGraceDays(" 7 ")).toBe(7);
    expect(parseGraceDays("1")).toBe(1);
  });
  it("ignores anything else with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of ["0", "-3", "1.5", "abc", ""]) expect(parseGraceDays(bad)).toBe(30);
    expect(warn).toHaveBeenCalledTimes(5);
    warn.mockRestore();
  });
});

describe("isGcDue", () => {
  it("is due when it never ran, or the last finish is a day old", () => {
    expect(isGcDue({ startedAt: null, finishedAt: null }, now)).toBe(true);
    expect(isGcDue({ startedAt: ago(25 * H), finishedAt: ago(24 * H) }, now)).toBe(true);
    expect(isGcDue({ startedAt: ago(24 * H), finishedAt: ago(23 * H) }, now)).toBe(false);
  });
  it("waits while a run started under an hour ago has not finished", () => {
    expect(isGcDue({ startedAt: ago(10 * 60_000), finishedAt: null }, now)).toBe(false);
    expect(isGcDue({ startedAt: ago(10 * 60_000), finishedAt: ago(30 * H) }, now)).toBe(false);
  });
  it("retries a run that started over an hour ago and never finished (crash)", () => {
    expect(isGcDue({ startedAt: ago(2 * H), finishedAt: null }, now)).toBe(true);
    expect(isGcDue({ startedAt: ago(2 * H), finishedAt: ago(30 * H) }, now)).toBe(true);
  });
});

describe("isForeignKeyViolation", () => {
  it("recognises Postgres 23503 however Prisma wraps it", () => {
    expect(isForeignKeyViolation({ code: "P2003" })).toBe(true);
    expect(isForeignKeyViolation({ code: "P2010", meta: { code: "23503" } })).toBe(true);
    expect(isForeignKeyViolation({ code: "23503" })).toBe(true);
    expect(isForeignKeyViolation({ cause: { code: "23503" } })).toBe(true);
    expect(isForeignKeyViolation(new Error('update or delete on table "map_documents" violates foreign key constraint'))).toBe(true);
    expect(isForeignKeyViolation(new Error("connection reset"))).toBe(false);
    expect(isForeignKeyViolation({ code: "P2010", meta: { code: "40001" } })).toBe(false);
    expect(isForeignKeyViolation(null)).toBe(false);
  });
});
