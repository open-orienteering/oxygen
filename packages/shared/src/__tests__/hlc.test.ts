import { describe, it, expect } from "vitest";
import {
  type Hlc,
  HLC_ZERO,
  HLC_MAX_LOGICAL,
  encodeHlc,
  decodeHlc,
  compareHlc,
  tickHlc,
  receiveHlc,
} from "../hlc.js";

// ─── encode / decode round-trip ──────────────────────────────

describe("encodeHlc / decodeHlc", () => {
  it("round-trips a realistic stamp", () => {
    const h: Hlc = { physical: 1_780_000_000_000, logical: 1234 };
    expect(decodeHlc(encodeHlc(h))).toEqual(h);
  });

  it("round-trips the zero clock", () => {
    expect(decodeHlc(encodeHlc(HLC_ZERO))).toEqual(HLC_ZERO);
    expect(encodeHlc(HLC_ZERO)).toBe(0n);
  });

  it("round-trips the maximum logical value", () => {
    const h: Hlc = { physical: 1_780_000_000_000, logical: HLC_MAX_LOGICAL };
    expect(decodeHlc(encodeHlc(h))).toEqual(h);
  });

  it("packs logical into the low 16 bits and physical above", () => {
    expect(encodeHlc({ physical: 1, logical: 0 })).toBe(65536n);
    expect(encodeHlc({ physical: 1, logical: 5 })).toBe(65541n);
  });

  it("stays within signed BIGINT range for realistic clocks", () => {
    // ~year 2026 → encoded well below 2^63.
    const encoded = encodeHlc({ physical: 1_780_000_000_000, logical: 65535 });
    expect(encoded).toBeLessThan(1n << 63n);
  });
});

// ─── compareHlc ──────────────────────────────────────────────

describe("compareHlc", () => {
  it("orders by physical first", () => {
    expect(compareHlc({ physical: 1, logical: 9 }, { physical: 2, logical: 0 })).toBe(-1);
    expect(compareHlc({ physical: 3, logical: 0 }, { physical: 2, logical: 9 })).toBe(1);
  });

  it("orders by logical when physical is equal", () => {
    expect(compareHlc({ physical: 5, logical: 1 }, { physical: 5, logical: 2 })).toBe(-1);
    expect(compareHlc({ physical: 5, logical: 3 }, { physical: 5, logical: 2 })).toBe(1);
  });

  it("returns 0 for identical clocks", () => {
    expect(compareHlc({ physical: 5, logical: 2 }, { physical: 5, logical: 2 })).toBe(0);
  });

  it("sorts a shuffled set deterministically", () => {
    const set: Hlc[] = [
      { physical: 5, logical: 2 },
      { physical: 1, logical: 0 },
      { physical: 5, logical: 0 },
      { physical: 3, logical: 9 },
    ];
    const sorted = [...set].sort(compareHlc);
    expect(sorted).toEqual([
      { physical: 1, logical: 0 },
      { physical: 3, logical: 9 },
      { physical: 5, logical: 0 },
      { physical: 5, logical: 2 },
    ]);
  });
});

// ─── tickHlc ─────────────────────────────────────────────────

describe("tickHlc", () => {
  it("resets logical when wall clock advances", () => {
    expect(tickHlc({ physical: 100, logical: 7 }, 200)).toEqual({ physical: 200, logical: 0 });
  });

  it("bumps logical when wall clock has not advanced", () => {
    expect(tickHlc({ physical: 200, logical: 0 }, 200)).toEqual({ physical: 200, logical: 1 });
    expect(tickHlc({ physical: 200, logical: 1 }, 150)).toEqual({ physical: 200, logical: 2 });
  });

  it("is strictly monotonic across successive ticks at a frozen clock", () => {
    const now = 1_000_000;
    let h = HLC_ZERO;
    let prev = h;
    for (let i = 0; i < 1000; i++) {
      h = tickHlc(h, now);
      expect(compareHlc(prev, h)).toBe(-1);
      prev = h;
    }
  });

  it("overflows logical into the next physical ms", () => {
    const h: Hlc = { physical: 500, logical: HLC_MAX_LOGICAL };
    expect(tickHlc(h, 500)).toEqual({ physical: 501, logical: 0 });
    // ...and the overflowed stamp is still strictly greater than its predecessor.
    expect(compareHlc(h, tickHlc(h, 500))).toBe(-1);
  });

  it("never goes backwards even if the wall clock jumps back", () => {
    const h: Hlc = { physical: 1000, logical: 3 };
    const next = tickHlc(h, 1); // clock jumped backwards
    expect(compareHlc(h, next)).toBe(-1);
    expect(next.physical).toBe(1000);
  });
});

// ─── receiveHlc ──────────────────────────────────────────────

describe("receiveHlc", () => {
  it("takes the larger of local and incoming", () => {
    expect(receiveHlc({ physical: 10, logical: 0 }, { physical: 20, logical: 0 })).toEqual({
      physical: 20,
      logical: 0,
    });
    expect(receiveHlc({ physical: 30, logical: 0 }, { physical: 20, logical: 9 })).toEqual({
      physical: 30,
      logical: 0,
    });
  });

  it("makes the next emit strictly greater than a faster peer's stamp", () => {
    const local: Hlc = { physical: 100, logical: 0 };
    const remote: Hlc = { physical: 5000, logical: 4 };
    const merged = receiveHlc(local, remote);
    const next = tickHlc(merged, 100); // our wall clock is still behind
    expect(compareHlc(remote, next)).toBe(-1);
  });

  it("keeps local when it is already ahead", () => {
    const local: Hlc = { physical: 5000, logical: 2 };
    expect(receiveHlc(local, { physical: 5000, logical: 1 })).toBe(local);
  });
});
