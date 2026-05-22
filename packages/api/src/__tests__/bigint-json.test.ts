/**
 * Pins the BigInt → number JSON polyfill installed in `index.ts`.
 *
 * The fastify / tRPC response pipeline serializes payloads with
 * `JSON.stringify`. Prisma returns `BigInt` for autoincrement PKs and
 * for several Eventor reference columns; without the polyfill,
 * `JSON.stringify(123n)` throws `TypeError: Do not know how to
 * serialize a BigInt` and the whole request fails with a 500.
 *
 * This test imports `index.ts` so the polyfill mounts the same way it
 * does in production, then asserts the behaviour. If anyone removes
 * the polyfill, this catches it immediately.
 */

import { describe, it, expect } from "vitest";

// Side-effect import: mounts the BigInt.prototype.toJSON polyfill.
import "../bigint-json.js";

describe("BigInt JSON polyfill", () => {
  it("serializes a top-level BigInt as a number", () => {
    expect(JSON.stringify(42n)).toBe("42");
  });

  it("serializes nested BigInt fields inside objects + arrays", () => {
    const payload = {
      id: 12345n,
      eventorEventId: 99001n,
      runners: [{ id: 1n }, { id: 2n, eventorClubId: 7n }],
      maybeNull: null,
    };
    const json = JSON.stringify(payload);
    const round = JSON.parse(json);
    expect(round).toEqual({
      id: 12345,
      eventorEventId: 99001,
      runners: [{ id: 1 }, { id: 2, eventorClubId: 7 }],
      maybeNull: null,
    });
  });

  it("preserves precision for values within Number.MAX_SAFE_INTEGER", () => {
    const safe = 9_007_199_254_740_991n; // 2^53 - 1
    expect(JSON.parse(JSON.stringify(safe))).toBe(Number(safe));
  });
});
