/**
 * Synthetic DEM-based height fields for the surface E2E (docs/map-rendering.md
 * §5.4 "3D mode" "Surface", H11). The E2E stack enables no DEM provider
 * (docs/map-terrain.md §7.1), so the test answers `height.bin?…&source=…`
 * itself with a field made from the document's real `contours` field: the
 * same grid, a DEM source and provider in the header, and — for ground —
 * other heights, so the switch is visible. No DEM data is read anywhere.
 *
 * The container (docs/map-terrain.md §5.2): magic `OXHF`, u32 version, u32
 * header length (a multiple of 4, zero-padded JSON), the int16 grid, the
 * confidence bits; little-endian. Written here without the shared package,
 * which Playwright's transform cannot load.
 */

export const DEM_PROVIDER = {
  id: "lantmateriet-2m",
  resolutionM: 2,
  grade: "anchor",
  licence: "CC BY 4.0",
  attribution: "© Lantmäteriet",
  verticalDatum: "RH 2000",
} as const;

/** Copernicus GLO-30 in its coarse role (answer 13): the label carries its resolution. */
export const GLO30_PROVIDER = {
  id: "glo30-30m",
  resolutionM: 30,
  grade: "coarse",
  licence: "Copernicus DEM licence",
  attribution: "© DLR e.V., © Airbus Defence and Space GmbH, provided under COPERNICUS by the European Union and ESA",
  verticalDatum: "EGM2008",
} as const;

export type DemProvider = typeof DEM_PROVIDER | typeof GLO30_PROVIDER;

const NO_DATA = -32768;

/**
 * `contours` bytes → a field of `source` (`ground.<id>` or `contours.<id>`). Ground's heights are
 * three ridges across the sheet (data cells only); the anchored field keeps the contour heights.
 */
export function demFieldBytes(contours: Uint8Array, source: string, provider: DemProvider = DEM_PROVIDER): Buffer {
  const dv = new DataView(contours.buffer, contours.byteOffset, contours.byteLength);
  const headerBytes = dv.getUint32(8, true);
  let end = 12 + headerBytes;
  while (end > 12 && contours[end - 1] === 0) end--;
  const header = JSON.parse(new TextDecoder().decode(contours.subarray(12, end))) as Record<string, number | string | object>;
  const width = header.width as number, height = header.height as number, cells = width * height;
  const zAt = 12 + headerBytes;
  const z = new Int16Array(cells);
  for (let i = 0; i < cells; i++) z[i] = dv.getInt16(zAt + i * 2, true);
  const confident = contours.subarray(zAt + cells * 2);
  if (source.startsWith("ground.")) {
    const top = Math.max(64, (header.zMax as number) || 0);
    for (let i = 0; i < cells; i++) if (z[i] !== NO_DATA) z[i] = Math.round((top / 2) * (1 + Math.sin(((i % width) / width) * 6 * Math.PI)));
  }
  let zMin = 32767, zMax = -32767;
  for (let i = 0; i < cells; i++) if (z[i] !== NO_DATA) { zMin = Math.min(zMin, z[i]); zMax = Math.max(zMax, z[i]); }
  if (zMin > zMax) zMin = zMax = 0;
  const out = { ...header, source, datum: "absolute", zOffsetM: 120, zMin, zMax, provider };
  const json = new TextEncoder().encode(JSON.stringify(out));
  const padded = (json.byteLength + 3) & ~3;
  const buf = Buffer.alloc(12 + padded + cells * 2 + confident.byteLength);
  buf.write("OXHF", 0, "latin1");
  buf.writeUInt32LE(1, 4);
  buf.writeUInt32LE(padded, 8);
  buf.set(json, 12);
  for (let i = 0; i < cells; i++) buf.writeInt16LE(z[i], 12 + padded + i * 2);
  buf.set(confident, 12 + padded + cells * 2);
  return buf;
}

/** The descriptor's `dem` block as H10 serves it when its job is done (docs/map-storage.md §4.7). */
export function readyDem(plainUrl: string, anchoredDecided: number | null, provider: DemProvider = DEM_PROVIDER) {
  return {
    state: "ready",
    reason: null,
    provider,
    ground: { url: `${plainUrl}&source=ground.${provider.id}` },
    anchored: { url: `${plainUrl}&source=contours.${provider.id}`, decided: anchoredDecided },
  };
}

/** A DEM whose job has not run yet: no ground offered, the routes given (asking one queues the job). */
export function pendingDem(plainUrl: string) {
  return { ...readyDem(plainUrl, null), state: "pending", anchored: { url: `${plainUrl}&source=contours.${DEM_PROVIDER.id}`, decided: null } };
}

/**
 * A field that is one plane rising east (docs/course-elevation.md §4's E2E): `slope` metres of height
 * per ground metre along x, 0 m at x = 0, every cell with data and confident. It covers ±`halfMm` paper mm
 * around the origin, so any course lies inside. `source` and `provider` as in `demFieldBytes`.
 */
export function planeFieldBytes(opts: { groundMPerMm: number; slope: number; source?: string; provider?: DemProvider; halfMm?: number; cellMm?: number }): Buffer {
  const cellMm = opts.cellMm ?? 5, half = opts.halfMm ?? 1000;
  const width = Math.round((2 * half) / cellMm), height = width, cells = width * height;
  const intervalM = 5, zScaleM = intervalM / 64;
  const source = opts.source ?? "contours";
  const z = new Int16Array(cells);
  // Heights at cell centres; the offset keeps the values inside int16.
  const zOffsetM = -half * opts.groundMPerMm * opts.slope;
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) z[r * width + c] = Math.round(((c + 0.5) * cellMm * opts.groundMPerMm * opts.slope) / zScaleM);
  const header = {
    version: 1, source, cellMm, x0: -half, y0: -half, width, height, groundMPerMm: opts.groundMPerMm, intervalM, zScaleM,
    zOffsetM, datum: source === "contours" ? "relative" : "absolute", zMin: z[0], zMax: z[width - 1],
    ...(source === "contours" ? {} : { provider: opts.provider ?? DEM_PROVIDER }),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const padded = (json.byteLength + 3) & ~3;
  const bits = (cells + 7) >> 3;
  const buf = Buffer.alloc(12 + padded + cells * 2 + bits);
  buf.write("OXHF", 0, "latin1");
  buf.writeUInt32LE(1, 4);
  buf.writeUInt32LE(padded, 8);
  buf.set(json, 12);
  for (let i = 0; i < cells; i++) buf.writeInt16LE(z[i], 12 + padded + i * 2);
  buf.fill(0xff, 12 + padded + cells * 2);
  return buf;
}
