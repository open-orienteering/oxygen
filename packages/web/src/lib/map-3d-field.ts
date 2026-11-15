/**
 * The field the viewer's 3D mode draws (docs/map-rendering.md §5.4 "3D
 * mode", decisions 2 and 3): the stored height field padded with no-data
 * cells out to the document's bounds — so the sheet beyond the contours
 * (title, legend, margins) is drawn, at the edge's heights — and
 * coarsened by whole factors until its textures take at most a third of
 * the residency budget.
 */

import { HEIGHT_NO_DATA, confidenceBytes, isConfident, type HeightField } from "@oxygen/shared/src/terrain/field/read.js";
import { DRAPE_MAX_SIDE } from "../map-gl/terrain/footprint";
import { fieldTextureBytes } from "../map-gl/terrain/program";

/** The field's share of the budget (decision 3); the drape has its own third (§5.6 decision 5). */
export const FIELD_BUDGET_SHARE = 1 / 3;

export interface BoundsMm {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const setBit = (bits: Uint8Array, i: number) => {
  bits[i >> 3] |= 1 << (i & 7);
};

/**
 * The field grown by whole no-data cells, on its own grid, until it covers `bounds` (paper mm). The
 * original cells keep their values, so `sampleHeight` inside the original extent is unchanged.
 */
export function padFieldToBounds(field: HeightField, bounds: BoundsMm): HeightField {
  const h = field.header;
  const left = Math.max(0, Math.ceil((h.x0 - bounds.minX) / h.cellMm - 1e-9));
  const bottom = Math.max(0, Math.ceil((h.y0 - bounds.minY) / h.cellMm - 1e-9));
  const right = Math.max(0, Math.ceil((bounds.maxX - (h.x0 + h.width * h.cellMm)) / h.cellMm - 1e-9));
  const top = Math.max(0, Math.ceil((bounds.maxY - (h.y0 + h.height * h.cellMm)) / h.cellMm - 1e-9));
  if (left + bottom + right + top === 0) return field;
  const W = h.width + left + right, H = h.height + bottom + top;
  const z = new Int16Array(W * H).fill(HEIGHT_NO_DATA);
  const confident = new Uint8Array(confidenceBytes(W * H));
  for (let cy = 0; cy < h.height; cy++)
    for (let cx = 0; cx < h.width; cx++) {
      const i = cy * h.width + cx, j = (cy + bottom) * W + cx + left;
      z[j] = field.z[i];
      if (isConfident(field, i)) setBit(confident, j);
    }
  return { header: { ...h, x0: h.x0 - left * h.cellMm, y0: h.y0 - bottom * h.cellMm, width: W, height: H }, z, confident };
}

/**
 * Every `factor × factor` block as one cell: the mean of its data cells, no-data when more than half
 * of the block is no-data (the edge blocks count the cells they have), confident when most of its
 * data cells are. The grid keeps its lower-left corner.
 */
export function coarsenField(field: HeightField, factor: number): HeightField {
  const f = Math.floor(factor);
  if (f <= 1) return field;
  const h = field.header;
  const W = Math.ceil(h.width / f), H = Math.ceil(h.height / f);
  const z = new Int16Array(W * H);
  const confident = new Uint8Array(confidenceBytes(W * H));
  let zMin = 32767, zMax = -32767;
  for (let by = 0; by < H; by++)
    for (let bx = 0; bx < W; bx++) {
      let sum = 0, data = 0, cells = 0, conf = 0;
      for (let cy = by * f; cy < Math.min((by + 1) * f, h.height); cy++)
        for (let cx = bx * f; cx < Math.min((bx + 1) * f, h.width); cx++) {
          const i = cy * h.width + cx;
          cells++;
          const v = field.z[i];
          if (v === HEIGHT_NO_DATA) continue;
          sum += v;
          data++;
          if (isConfident(field, i)) conf++;
        }
      const j = by * W + bx;
      if (data * 2 < cells) {
        z[j] = HEIGHT_NO_DATA;
        continue;
      }
      const v = Math.round(sum / data);
      z[j] = v;
      zMin = Math.min(zMin, v);
      zMax = Math.max(zMax, v);
      if (conf * 2 > data) setBit(confident, j);
    }
  if (zMin > zMax) zMin = zMax = 0;
  return { header: { ...h, cellMm: h.cellMm * f, width: W, height: H, zMin, zMax }, z, confident };
}

/** The smallest whole factor that brings a W × H field within the texel bytes and side limit. */
export function coarsenFactor(width: number, height: number, maxBytes: number, maxSide: number): number {
  for (let f = 1; ; f++) {
    const w = Math.ceil(width / f), h = Math.ceil(height / f);
    if ((fieldTextureBytes(w, h) <= maxBytes && Math.max(w, h) <= maxSide) || (w === 1 && h === 1)) return f;
  }
}

/** The field the viewer hands the engine: padded to the document's bounds, then coarsened to fit. */
export function viewerField(field: HeightField, bounds: BoundsMm | null, budgetBytes: number, maxTextureSize: number): HeightField {
  const padded = bounds ? padFieldToBounds(field, bounds) : field;
  const f = coarsenFactor(padded.header.width, padded.header.height, budgetBytes * FIELD_BUDGET_SHARE, Math.min(DRAPE_MAX_SIDE, maxTextureSize));
  return coarsenField(padded, f);
}
