/**
 * Seeded pseudo-random numbers for the draw (review RES-15).
 *
 * The preview and the apply must produce the same order, so every random
 * choice in `draw/` comes from a generator seeded by the preview. Each class
 * gets its own stream derived from the seed and the class seq, so changing the
 * class selection or dragging a block does not reshuffle the other classes.
 */

/** A generator returning floats in [0, 1), like `Math.random`. */
export type Rng = () => number;

/** mulberry32: small, fast, good enough for shuffles. `seed` is a uint32. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The generator for one class's draw: independent of the other classes. */
export function classRng(seed: number, classSeq: number): Rng {
  // Mix the class seq into the seed (splitmix-style constant) so adjacent
  // seqs give unrelated streams.
  const mixed = (Math.imul((seed ^ Math.imul(classSeq + 1, 0x9e3779b9)) >>> 0, 0x85ebca6b) ^ seed) >>> 0;
  return mulberry32(mixed);
}

/** Largest seed value; seeds are uint32. */
export const MAX_DRAW_SEED = 0xffffffff;
