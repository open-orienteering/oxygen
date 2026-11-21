/**
 * A height field as a terrain sampler (docs/course-elevation.md §1).
 */

import { sampleConfident, sampleHeight } from "../field/sample.js";
import type { HeightField } from "../field/types.js";
import type { TerrainSampler } from "./types.js";

export function fieldSampler(field: HeightField): TerrainSampler {
  const h = field.header;
  return {
    heightAt: (p) => sampleHeight(field, p),
    confidentAt: (p) => sampleConfident(field, p),
    groundMPerMm: h.groundMPerMm,
    cellM: h.cellMm * h.groundMPerMm,
    datum: h.datum,
    source: h.source,
    ...(h.provider ? { provider: h.provider } : {}),
  };
}
