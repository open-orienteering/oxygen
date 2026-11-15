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

const NO_DATA = -32768;

/**
 * `contours` bytes → a field of `source` (`ground.<id>` or `contours.<id>`). Ground's heights are
 * three ridges across the sheet (data cells only); the anchored field keeps the contour heights.
 */
export function demFieldBytes(contours: Uint8Array, source: string): Buffer {
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
  const out = { ...header, source, datum: "absolute", zOffsetM: 120, zMin, zMax, provider: DEM_PROVIDER };
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
export function readyDem(plainUrl: string, anchoredDecided: number | null) {
  return {
    state: "ready",
    reason: null,
    provider: DEM_PROVIDER,
    ground: { url: `${plainUrl}&source=ground.${DEM_PROVIDER.id}` },
    anchored: { url: `${plainUrl}&source=contours.${DEM_PROVIDER.id}`, decided: anchoredDecided },
  };
}
