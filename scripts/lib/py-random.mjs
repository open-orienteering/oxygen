/**
 * CPython's `random.Random` for an integer seed: MT19937 seeded with
 * `init_by_array`, and the `random`, `uniform`, `randint` and `choice`
 * methods drawn the way CPython 3.10 draws them. The demo map's injected
 * features (scripts/lib/inject-demo-points.mjs) were first placed by a
 * Python script; matching its generator keeps the approved placement
 * byte-identical (docs/demo.md, "The map").
 */

const N = 624;
const M = 397;

export class PyRandom {
  /** @param {number} seed a non-negative integer below 2^32 */
  constructor(seed) {
    if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) throw new Error(`PyRandom: unsupported seed ${seed}`);
    this.mt = new Uint32Array(N);
    this.mti = N + 1;
    this.#initByArray([seed]);
  }

  #initGenrand(s) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = N;
  }

  #initByArray(key) {
    const mt = this.mt;
    this.#initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  /** One 32-bit output word. */
  genrand() {
    const mt = this.mt;
    if (this.mti >= N) {
      let kk = 0;
      for (; kk < N - M; kk++) {
        const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      for (; kk < N - 1; kk++) {
        const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      const y = (mt[N - 1] & 0x80000000) | (mt[0] & 0x7fffffff);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      this.mti = 0;
    }
    let y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** `random.random()`: a 53-bit float in [0, 1). */
  random() {
    const a = this.genrand() >>> 5;
    const b = this.genrand() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** `random.uniform(a, b)`. */
  uniform(a, b) {
    return a + (b - a) * this.random();
  }

  /** `random.getrandbits(k)` for 0 < k <= 32. */
  getrandbits(k) {
    if (k <= 0 || k > 32) throw new Error(`PyRandom.getrandbits: unsupported k ${k}`);
    return this.genrand() >>> (32 - k);
  }

  /** CPython's `_randbelow_with_getrandbits(n)`, for 0 < n < 2^32. */
  randbelow(n) {
    if (!Number.isInteger(n) || n <= 0 || n >= 2 ** 32) throw new Error(`PyRandom.randbelow: unsupported n ${n}`);
    const k = 32 - Math.clz32(n); // n.bit_length()
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  /** `random.randint(a, b)`, both ends included. */
  randint(a, b) {
    return a + this.randbelow(b - a + 1);
  }

  /** `random.choice(seq)`. */
  choice(seq) {
    return seq[this.randbelow(seq.length)];
  }
}
