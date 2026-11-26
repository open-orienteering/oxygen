import { describe, expect, it } from "vitest";
import { pickRunnerCard } from "../cardLink.js";

// API-11: the linked card is used only while it has the runner's number.
const at = (s: number) => new Date(s * 1000);
const old = { id: "old", cardNo: 100, removed: false, updatedAt: at(1) };
const fresh = { id: "new", cardNo: 200, removed: false, updatedAt: at(2) };
const newer = { id: "newer", cardNo: 200, removed: false, updatedAt: at(3) };

describe("pickRunnerCard", () => {
  it("uses the linked card while it matches the runner's number", () => {
    expect(pickRunnerCard({ cardId: "old", cardNo: 100 }, old, [])).toBe(old);
  });
  it("ignores a stale link after the card number changed", () => {
    expect(pickRunnerCard({ cardId: "old", cardNo: 200 }, old, [fresh])).toBe(fresh);
  });
  it("is null when the new number has no card row yet", () => {
    expect(pickRunnerCard({ cardId: "old", cardNo: 200 }, old, [])).toBeNull();
  });
  it("is null for a cardless runner", () => {
    expect(pickRunnerCard({ cardId: "old", cardNo: null }, old, [old])).toBeNull();
  });
  it("ignores a removed linked card and picks the newest live row", () => {
    expect(
      pickRunnerCard({ cardId: "new", cardNo: 200 }, { ...fresh, removed: true }, [fresh, newer]),
    ).toBe(newer);
  });
});
