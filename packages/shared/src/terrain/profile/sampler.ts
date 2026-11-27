/**
 * A height field as a terrain sampler (docs/course-elevation.md §1).
 */

import { sampleConfident, sampleHeight } from "../field/sample.js";
import type { HeightField } from "../field/types.js";
import type { TerrainSampler } from "./types.js";

/**
 * `intervalM`: the contour interval to read a relative field at. A relative contour field holds `level × interval`
 * (offset 0), so reading it at another interval scales its heights by the ratio; an absolute field ignores it.
 */
export function fieldSampler(field: HeightField, opts: { intervalM?: number } = {}): TerrainSampler {
  const h = field.header;
  const k = h.datum === "relative" && opts.intervalM !== undefined && opts.intervalM > 0 && opts.intervalM !== h.intervalM ? opts.intervalM / h.intervalM : 1;
  return {
    heightAt: k === 1 ? (p) => sampleHeight(field, p) : (p) => {
      const z = sampleHeight(field, p);
      return z === null ? null : z * k;
    },
    confidentAt: (p) => sampleConfident(field, p),
    groundMPerMm: h.groundMPerMm,
    cellM: h.cellMm * h.groundMPerMm,
    datum: h.datum,
    source: h.source,
    ...(h.provider ? { provider: h.provider } : {}),
  };
}
