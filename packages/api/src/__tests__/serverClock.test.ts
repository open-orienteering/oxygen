import { describe, it, expect, beforeEach } from "vitest";
import {
  nextServerHlc,
  foldServerHlc,
  _resetServerClock,
} from "../serverClock.js";
import { compareHlc, encodeHlc } from "@oxygen/shared";

beforeEach(() => {
  _resetServerClock();
});

describe("serverClock", () => {
  it("mints strictly increasing stamps", () => {
    const a = nextServerHlc();
    const b = nextServerHlc();
    const c = nextServerHlc();
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, c)).toBe(-1);
  });

  it("stays monotonic when the wall clock steps backwards", () => {
    const a = nextServerHlc(1_700_000_000_000);
    const b = nextServerHlc(1_699_999_999_000); // clock stepped back 1s
    expect(compareHlc(a, b)).toBe(-1);
    expect(b.physical).toBe(a.physical); // held at the high-water mark
    expect(b.logical).toBe(a.logical + 1);
  });

  it("bumps the logical counter within the same millisecond", () => {
    const a = nextServerHlc(1_700_000_000_000);
    const b = nextServerHlc(1_700_000_000_000);
    expect(b.physical).toBe(a.physical);
    expect(b.logical).toBe(a.logical + 1);
  });

  it("folding a received stamp pushes the next emit past it", () => {
    const now = 1_700_000_000_000;
    nextServerHlc(now);
    // A station with a fast clock sends an entry from 30s in the future.
    const incoming = { physical: now + 30_000, logical: 5 };
    foldServerHlc(incoming);
    const next = nextServerHlc(now);
    expect(compareHlc(incoming, next)).toBe(-1);
    expect(encodeHlc(next)).toBeGreaterThan(encodeHlc(incoming));
  });

  it("folding an older stamp is a no-op", () => {
    const a = nextServerHlc(1_700_000_000_000);
    foldServerHlc({ physical: 1_600_000_000_000, logical: 9999 });
    const b = nextServerHlc(1_700_000_000_000);
    expect(compareHlc(a, b)).toBe(-1);
    expect(b.physical).toBe(a.physical);
  });
});
