/**
 * Interval concentration R(J) and circular helpers (docs/map-terrain.md §6.5).
 */

/** `|Σ w·e^{2πi·m/J}| / Σ w` and the phase in [0, J); entries with weight ≤ 0 or NaN medians are skipped. */
export function concentration(medians: ArrayLike<number>, weights: ArrayLike<number>, J: number): { r: number; phase: number } {
  let re = 0, im = 0, w = 0;
  for (let i = 0; i < medians.length; i++) {
    const wi = weights[i];
    const m = medians[i];
    if (!(wi > 0) || Number.isNaN(m)) continue;
    const a = (2 * Math.PI * m) / J;
    re += wi * Math.cos(a);
    im += wi * Math.sin(a);
    w += wi;
  }
  if (w <= 0) return { r: 0, phase: 0 };
  return { r: Math.hypot(re, im) / w, phase: mod((Math.atan2(im, re) / (2 * Math.PI)) * J, J) };
}

/** `a mod J` in [0, J). */
export function mod(a: number, J: number): number {
  const r = a % J;
  const v = r < 0 ? r + J : r;
  return v >= J ? 0 : v;
}

/** `m − phase` wrapped into (−J/2, J/2]. */
export function circularDev(m: number, phase: number, J: number): number {
  const d = mod(m - phase, J);
  return d > J / 2 ? d - J : d;
}

/** Circular distance of `m` and `phase` modulo J, in [0, J/2]. */
export const circularDist = (m: number, phase: number, J: number): number => Math.abs(circularDev(m, phase, J));
