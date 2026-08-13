/**
 * Unit tests for the Eventor card-number normalization used by the
 * import/sync paths in routers/eventor.ts.
 *
 * The `runners` table stores NULL (not 0) for "no card" and enforces a
 * partial unique index on (event_id, card_no) WHERE removed = false, so
 * the import must never write 0 and must never assign the same card to
 * two runners in the same event.
 */

import { describe, it, expect } from "vitest";
import { normalizeCardNo, makeCardNoClaimer } from "../routers/eventor.js";

describe("normalizeCardNo", () => {
  it("maps 0 / negative / undefined / non-finite to null", () => {
    expect(normalizeCardNo(0)).toBeNull();
    expect(normalizeCardNo(-5)).toBeNull();
    expect(normalizeCardNo(undefined)).toBeNull();
    expect(normalizeCardNo(null)).toBeNull();
    expect(normalizeCardNo(NaN)).toBeNull();
  });

  it("passes positive card numbers through, clamped to int32", () => {
    expect(normalizeCardNo(812345)).toBe(812345);
    expect(normalizeCardNo(2_147_483_647 + 5)).toBe(2_147_483_647);
  });
});

describe("makeCardNoClaimer", () => {
  it("lets the first owner claim a card and nulls later claims", () => {
    const claim = makeCardNoClaimer();
    expect(claim(500, "a")).toBe(500);
    expect(claim(500, "b")).toBeNull();
    // Re-claim by the same owner is idempotent.
    expect(claim(500, "a")).toBe(500);
  });

  it("returns null for cardless claims without reserving anything", () => {
    const claim = makeCardNoClaimer();
    expect(claim(0, "a")).toBeNull();
    expect(claim(0, "b")).toBeNull();
    expect(claim(700, "c")).toBe(700);
  });

  it("respects pre-existing card assignments", () => {
    const claim = makeCardNoClaimer([
      { ownerKey: "existing", cardNo: 900 },
      { ownerKey: "cardless", cardNo: null },
    ]);
    expect(claim(900, "newcomer")).toBeNull();
    expect(claim(900, "existing")).toBe(900);
  });

  it("returns the fallback on conflict so sync updates keep the current card", () => {
    const claim = makeCardNoClaimer([{ ownerKey: "other", cardNo: 900 }]);
    expect(claim(900, "me", 123)).toBe(123);
    // Cardless input ignores the fallback — no card in Eventor means no card.
    expect(claim(0, "me", 123)).toBeNull();
  });
});
