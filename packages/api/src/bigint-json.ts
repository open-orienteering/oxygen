/**
 * BigInt JSON polyfill.
 *
 * Every Prisma model uses `BigInt` for autoincrement primary keys
 * (and several Eventor reference columns), but the default
 * `JSON.stringify` throws on BigInt. Adding `toJSON` on the prototype
 * makes the whole tRPC response pipeline serialize them as plain
 * numbers without each router needing a per-field cast.
 *
 * All our BigInt values fit comfortably inside
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1):
 *   - bigserial PKs grow at ~1/event/runner/punch/etc., we're nowhere
 *     near 9×10^15.
 *   - Eventor IDs are 6-7 digit decimals.
 *
 * Revisit if/when we approach 2^53; at that point we should switch to
 * a transformer like superjson on both ends of the tRPC pipeline.
 *
 * Importing this file mounts the polyfill once, idempotently.
 */

const proto = BigInt.prototype as unknown as { toJSON?: () => number };
if (!proto.toJSON) {
  proto.toJSON = function (this: bigint) {
    return Number(this);
  };
}

export {};
