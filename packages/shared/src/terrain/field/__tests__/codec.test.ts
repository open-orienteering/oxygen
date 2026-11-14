import { describe, expect, it } from "vitest";
import { HEIGHT_NO_DATA, HeightFieldFormatError, TERRAIN_VERSION, Z_PER_INTERVAL, decodeHeightField, encodeHeightField, isConfident, type HeightField } from "../index.js";

function field(width = 5, height = 3): HeightField {
  const z = new Int16Array(width * height);
  for (let i = 0; i < z.length; i++) z[i] = i * 37 - 200;
  z[4] = HEIGHT_NO_DATA;
  const confident = new Uint8Array(Math.ceil(z.length / 8));
  for (const i of [0, 3, 8, 14]) confident[i >> 3] |= 1 << (i & 7);
  return {
    header: {
      version: TERRAIN_VERSION,
      source: "contours",
      cellMm: 0.2,
      x0: -12.5,
      y0: 40.25,
      width,
      height,
      groundMPerMm: 15,
      intervalM: 5,
      zScaleM: 5 / Z_PER_INTERVAL,
      zOffsetM: 0,
      datum: "relative",
      zMin: -200,
      zMax: 14 * 37 - 200,
    },
    z,
    confident,
  };
}

describe("height field codec (map-terrain.md §5.2)", () => {
  it("round-trips every field, no-data and confidence bits included", () => {
    const f = field();
    const back = decodeHeightField(encodeHeightField(f));
    expect(back.header).toEqual(f.header);
    expect([...back.z]).toEqual([...f.z]);
    expect(back.z[4]).toBe(HEIGHT_NO_DATA);
    expect([...back.confident]).toEqual([...f.confident]);
    expect([0, 3, 8, 14].every((i) => isConfident(back, i))).toBe(true);
    expect(isConfident(back, 1)).toBe(false);
  });

  it("writes magic OXHF, a little-endian preamble and a 4-aligned grid", () => {
    const bytes = encodeHeightField(field());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("OXHF");
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(4, true)).toBe(1);
    const headerBytes = dv.getUint32(8, true);
    expect(headerBytes % 4).toBe(0);
    expect(dv.getInt16(12 + headerBytes, true)).toBe(-200);
    expect(bytes.byteLength).toBe(12 + headerBytes + 15 * 2 + 2);
  });

  it("is byte-identical for the same field", () => {
    expect(encodeHeightField(field())).toEqual(encodeHeightField(field()));
  });

  it("decodes from an unaligned view", () => {
    const bytes = encodeHeightField(field());
    const shifted = new Uint8Array(bytes.byteLength + 1);
    shifted.set(bytes, 1);
    expect([...decodeHeightField(shifted.subarray(1)).z]).toEqual([...field().z]);
  });

  it("rejects bad magic, an unknown version, truncated and over-long input", () => {
    const good = encodeHeightField(field());
    const bad = good.slice();
    bad[0] = 0x58;
    expect(() => decodeHeightField(bad)).toThrow(HeightFieldFormatError);
    const v2 = good.slice();
    v2[4] = 2;
    expect(() => decodeHeightField(v2)).toThrow(/version 2/);
    expect(() => decodeHeightField(good.subarray(0, good.byteLength - 1))).toThrow(/length/);
    const long = new Uint8Array(good.byteLength + 1);
    long.set(good);
    expect(() => decodeHeightField(long)).toThrow(/length/);
    expect(() => decodeHeightField(good.subarray(0, 6))).toThrow(/too short/);
  });

  it("rejects a header that does not match the planes", () => {
    const f = field();
    expect(() => encodeHeightField({ ...f, z: new Int16Array(3) })).toThrow(/cells/);
    expect(() => encodeHeightField({ ...f, confident: new Uint8Array(1) })).toThrow(/confidence/);
  });

  it("throws its own error on a header the schema rejects, both ways, and on an unaligned header length", () => {
    const f = field();
    expect(() => encodeHeightField({ ...f, header: { ...f.header, intervalM: -1 } })).toThrow(/bad height field header/);
    const json = new TextEncoder().encode(JSON.stringify({ ...f.header, version: 0 }));
    const n = (json.byteLength + 3) & ~3;
    const bad = new Uint8Array(12 + n + 15 * 2 + 2);
    bad.set(new TextEncoder().encode("OXHF"));
    const dv = new DataView(bad.buffer);
    dv.setUint32(4, 1, true);
    dv.setUint32(8, n, true);
    bad.set(json, 12);
    expect(() => decodeHeightField(bad)).toThrow(HeightFieldFormatError);
    const odd = encodeHeightField(f).slice();
    new DataView(odd.buffer).setUint32(8, new DataView(odd.buffer).getUint32(8, true) - 1, true);
    expect(() => decodeHeightField(odd)).toThrow(/multiple of 4/);
  });
});
