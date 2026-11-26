import { describe, expect, it } from "vitest";
import { decideShellEntry, shellIsOpen, shellRetries, type SelectState } from "../shell-entry";

const err = (code?: string) => (code ? Object.assign(new Error(code), { data: { code } }) : new TypeError("Failed to fetch"));
const e = (error: unknown): SelectState => ({ status: "error", error });

describe("decideShellEntry (WEB-03)", () => {
  it("opens from the cached dashboard while the first select is in flight", () => {
    expect(decideShellEntry({ cachedName: "Day 1", select: { status: "pending" }, failedBefore: false })).toBe("provisional");
    expect(decideShellEntry({ cachedName: null, select: { status: "pending" }, failedBefore: false })).toBe("loading");
  });

  it("is live once the server confirms", () => {
    expect(decideShellEntry({ cachedName: null, select: { status: "success" }, failedBefore: true })).toBe("live");
  });

  it("keeps the cached shell on any failure that is not a definite answer, online or not", () => {
    for (const error of [err(), err("INTERNAL_SERVER_ERROR"), err("BAD_GATEWAY"), new Error("Unexpected token '<', \"<html>\" is not valid JSON")]) {
      expect(decideShellEntry({ cachedName: "Day 1", select: e(error), failedBefore: false })).toBe("cached");
      expect(decideShellEntry({ cachedName: null, select: e(error), failedBefore: false })).toBe("unreachable");
    }
  });

  it("NOT_FOUND and refusals win over the cache", () => {
    expect(decideShellEntry({ cachedName: "Day 1", select: e(err("NOT_FOUND")), failedBefore: false })).toBe("not-found");
    expect(decideShellEntry({ cachedName: "Day 1", select: e(err("FORBIDDEN")), failedBefore: false })).toBe("refused");
    expect(decideShellEntry({ cachedName: null, select: e(err("UNAUTHORIZED")), failedBefore: false })).toBe("refused");
  });

  it("a retry in flight stays in the offline state it came from", () => {
    expect(decideShellEntry({ cachedName: "Day 1", select: { status: "pending" }, failedBefore: true })).toBe("cached");
    expect(decideShellEntry({ cachedName: null, select: { status: "pending" }, failedBefore: true })).toBe("unreachable");
  });

  it("opens the shell from cache and retries only while offline", () => {
    expect(["loading", "provisional", "live", "cached", "unreachable", "not-found", "refused"].filter((x) => shellIsOpen(x as never)))
      .toEqual(["provisional", "live", "cached"]);
    expect(["loading", "provisional", "live", "cached", "unreachable", "not-found", "refused"].filter((x) => shellRetries(x as never)))
      .toEqual(["cached", "unreachable"]);
  });
});
