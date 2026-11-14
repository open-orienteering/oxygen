import { HEIGHT_NO_DATA, TERRAIN_VERSION, Z_PER_INTERVAL, confidenceBytes, type HeightField } from "../types.js";

/** A field from `fn(cx, cy)` in height units at each cell's grid position; NaN gives no-data. */
export function gridField(width: number, height: number, fn: (cx: number, cy: number) => number, over: { cellMm?: number; x0?: number; y0?: number; groundMPerMm?: number; intervalM?: number } = {}): HeightField {
  const z = new Int16Array(width * height);
  let zMin = 32767, zMax = -32767;
  for (let cy = 0; cy < height; cy++)
    for (let cx = 0; cx < width; cx++) {
      const v = fn(cx, cy);
      const q = Number.isNaN(v) ? HEIGHT_NO_DATA : Math.round(v);
      z[cy * width + cx] = q;
      if (q !== HEIGHT_NO_DATA) {
        zMin = Math.min(zMin, q);
        zMax = Math.max(zMax, q);
      }
    }
  if (zMin > zMax) zMin = zMax = 0;
  const intervalM = over.intervalM ?? 5;
  return {
    header: {
      version: TERRAIN_VERSION,
      source: "contours",
      cellMm: over.cellMm ?? 0.2,
      x0: over.x0 ?? 0,
      y0: over.y0 ?? 0,
      width,
      height,
      groundMPerMm: over.groundMPerMm ?? 15,
      intervalM,
      zScaleM: intervalM / Z_PER_INTERVAL,
      zOffsetM: 0,
      datum: "relative",
      zMin,
      zMax,
    },
    z,
    confident: new Uint8Array(confidenceBytes(width * height)).fill(0xff),
  };
}
