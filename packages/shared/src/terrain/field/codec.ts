/**
 * The height field's bytes (docs/map-terrain.md §5.2): magic `OXHF`, u32
 * container version, u32 header length, the header as UTF-8 JSON padded
 * to 4 bytes, the int16 grid, the confidence bits. Little-endian.
 */

import { confidenceBytes, heightFieldHeaderSchema, type HeightField } from "./types.js";

export const HEIGHT_FIELD_MAGIC = "OXHF";
/** The container layout's version (the derivation's is `TERRAIN_VERSION`, in the header). */
export const HEIGHT_FIELD_CONTAINER_VERSION = 1;
const PREAMBLE_BYTES = 12;

export class HeightFieldFormatError extends Error {}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function checkPlanes(f: HeightField): void {
  const cells = f.header.width * f.header.height;
  if (f.z.length !== cells) throw new HeightFieldFormatError(`height plane holds ${f.z.length} cells, header says ${cells}`);
  if (f.confident.length !== confidenceBytes(cells)) throw new HeightFieldFormatError(`confidence plane holds ${f.confident.length} bytes, ${confidenceBytes(cells)} expected`);
}

export function encodeHeightField(f: HeightField): Uint8Array {
  checkPlanes(f);
  const parsed = heightFieldHeaderSchema.safeParse(f.header);
  if (!parsed.success) throw new HeightFieldFormatError(`bad height field header: ${parsed.error.message}`);
  const json = new TextEncoder().encode(JSON.stringify(parsed.data));
  const headerBytes = (json.byteLength + 3) & ~3;
  const zAt = PREAMBLE_BYTES + headerBytes;
  const out = new Uint8Array(zAt + f.z.length * 2 + f.confident.length);
  for (let i = 0; i < 4; i++) out[i] = HEIGHT_FIELD_MAGIC.charCodeAt(i);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, HEIGHT_FIELD_CONTAINER_VERSION, true);
  dv.setUint32(8, headerBytes, true);
  out.set(json, PREAMBLE_BYTES);
  if (LITTLE_ENDIAN) out.set(new Uint8Array(f.z.buffer, f.z.byteOffset, f.z.byteLength), zAt);
  else for (let i = 0; i < f.z.length; i++) dv.setInt16(zAt + i * 2, f.z[i], true);
  out.set(f.confident, zAt + f.z.length * 2);
  return out;
}

export function decodeHeightField(bytes: Uint8Array): HeightField {
  if (bytes.byteLength < PREAMBLE_BYTES) throw new HeightFieldFormatError("not a height field: too short");
  for (let i = 0; i < 4; i++) if (bytes[i] !== HEIGHT_FIELD_MAGIC.charCodeAt(i)) throw new HeightFieldFormatError("not a height field: bad magic");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(4, true);
  if (version !== HEIGHT_FIELD_CONTAINER_VERSION) throw new HeightFieldFormatError(`unsupported height field version ${version} (reader supports ${HEIGHT_FIELD_CONTAINER_VERSION})`);
  const headerBytes = dv.getUint32(8, true);
  if (headerBytes & 3) throw new HeightFieldFormatError(`height field header length ${headerBytes} is not a multiple of 4`);
  if (PREAMBLE_BYTES + headerBytes > bytes.byteLength) throw new HeightFieldFormatError("height field length: truncated header");
  let jsonEnd = PREAMBLE_BYTES + headerBytes;
  while (jsonEnd > PREAMBLE_BYTES && bytes[jsonEnd - 1] === 0) jsonEnd--;
  let header;
  try {
    header = heightFieldHeaderSchema.parse(JSON.parse(new TextDecoder().decode(bytes.subarray(PREAMBLE_BYTES, jsonEnd))));
  } catch (e) {
    throw new HeightFieldFormatError(`bad height field header: ${e instanceof Error ? e.message : String(e)}`);
  }
  const cells = header.width * header.height;
  const zAt = PREAMBLE_BYTES + headerBytes;
  const expected = zAt + cells * 2 + confidenceBytes(cells);
  if (bytes.byteLength !== expected) throw new HeightFieldFormatError(`height field length ${bytes.byteLength}, header implies ${expected}`);
  const z = new Int16Array(cells);
  if (LITTLE_ENDIAN) new Uint8Array(z.buffer).set(bytes.subarray(zAt, zAt + cells * 2));
  else for (let i = 0; i < cells; i++) z[i] = dv.getInt16(zAt + i * 2, true);
  const confident = bytes.slice(zAt + cells * 2, expected);
  return { header, z, confident };
}
