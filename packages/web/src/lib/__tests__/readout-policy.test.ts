import { describe, it, expect } from "vitest";
import { canApplyResults, findDuplicate, readoutsMatch, withTimeout, nextCurrentCard, isLatestCard } from "../offline/readout-policy";
import { isAuthRefusal } from "../offline/sync";
import type { SICardReadout } from "../si-protocol";

const readout = (over: Partial<SICardReadout> = {}): SICardReadout =>
  ({
    cardNumber: 4711,
    cardType: "SI8",
    startTime: 100,
    finishTime: 900,
    checkTime: 50,
    punches: [{ controlCode: 31, time: 300 }],
    ...over,
  }) as SICardReadout;

describe("findDuplicate", () => {
  const stored = { readout: readout(), competitionId: "a", persisted: true };

  it("a persisted re-read in the same event is a duplicate", () => {
    expect(findDuplicate([stored], readout(), "a")).toBe(stored);
  });

  it("a read that was never stored or queued is not a duplicate (SI-16, SYNC-03)", () => {
    expect(findDuplicate([{ ...stored, persisted: false }], readout(), "a")).toBeUndefined();
  });

  it("the same card data in another event is not a duplicate (MC-05)", () => {
    expect(findDuplicate([stored], readout(), "b")).toBeUndefined();
    expect(findDuplicate([stored], readout(), null)).toBeUndefined();
  });

  it("a read still being saved counts as a duplicate (no double queueing)", () => {
    expect(
      findDuplicate([{ ...stored, persisted: false, saveState: "saving" as const }], readout(), "a"),
    ).toBeDefined();
  });

  it("different punch data is not a duplicate", () => {
    expect(
      findDuplicate([stored], readout({ punches: [{ controlCode: 32, time: 300 }] as never }), "a"),
    ).toBeUndefined();
    expect(readoutsMatch(readout(), readout({ finishTime: 901 }))).toBe(false);
  });
});

describe("canApplyResults (D11)", () => {
  it("auth off (venue box): always", () => expect(canApplyResults(false, false)).toBe(true));
  it("auth on, signed in: yes", () => expect(canApplyResults(true, true)).toBe(true));
  it("auth on, kiosk key only: no, it queues card.read alone", () =>
    expect(canApplyResults(true, false)).toBe(false));
});

describe("withTimeout (SI-29)", () => {
  it("rejects a call that hangs", async () => {
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toThrow("timeout");
  });
  it("passes a result through", async () => {
    await expect(withTimeout(Promise.resolve(5), 50)).resolves.toBe(5);
  });
});

describe("isAuthRefusal", () => {
  it("tells a refusal from a network error", () => {
    expect(isAuthRefusal({ data: { code: "UNAUTHORIZED" } })).toBe(true);
    expect(isAuthRefusal({ data: { code: "FORBIDDEN" } })).toBe(true);
    expect(isAuthRefusal(new TypeError("Failed to fetch"))).toBe(false);
    expect(isAuthRefusal(null)).toBe(false);
  });
});

describe("SI-17: a slow earlier card never overwrites the current one", () => {
  type C = { id: string; name: string };
  const a: C = { id: "A", name: "Runner A" };
  const b: C = { id: "B", name: "Runner B" };

  it("keeps card B on screen when card A's pipeline finishes afterwards", () => {
    // B was read after A: the screen holds B. A's late update must not win.
    expect(nextCurrentCard<C>(b, "A", { ...a, name: "A resolved" })).toBe(b);
  });

  it("lets a card update itself while it is current", () => {
    expect(nextCurrentCard<C>(b, "B", { ...b, name: "B resolved" })).toEqual({ id: "B", name: "B resolved" });
  });

  it("broadcasts to the kiosk only for the latest card", () => {
    // Interleaved: A read, then B read; A finishes last.
    let latest: string | null = "A";
    latest = "B";
    expect(isLatestCard(latest, "A")).toBe(false);
    expect(isLatestCard(latest, "B")).toBe(true);
  });
});
