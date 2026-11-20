/**
 * A minimal PNG encoder for fixtures (J5): 8-bit RGBA, filter 0, the zlib
 * stream in stored (uncompressed) blocks — enough for the page scenes'
 * generated graphics, so no binary fixture is committed. Not for
 * production: the bytes are as large as the pixels.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (const v of bytes) {
    a = (a + v) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

function chunk(type: string, data: Uint8Array): number[] {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
  body.set(data, 4);
  return [...be32(data.length), ...body, ...be32(crc32(body))];
}

/** RGBA (or, with `channels` 3, RGB) pixels, row-major, top row first → PNG bytes. */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array, channels: 3 | 4 = 4): Uint8Array {
  const n = channels;
  if (rgba.length !== width * height * n) throw new Error(`pixels must be width × height × ${n} bytes`);
  const raw = new Uint8Array(height * (1 + width * n));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * n, (y + 1) * width * n), y * (1 + width * n) + 1);
  const z: number[] = [0x78, 0x01];
  for (let at = 0; at < raw.length || at === 0; at += 65535) {
    const block = raw.subarray(at, Math.min(raw.length, at + 65535));
    const last = at + 65535 >= raw.length ? 1 : 0;
    z.push(last, block.length & 255, block.length >>> 8, ~block.length & 255, (~block.length >>> 8) & 255, ...block);
    if (last) break;
  }
  z.push(...be32(adler32(raw)));
  const ihdr = new Uint8Array([...be32(width), ...be32(height), 8, n === 4 ? 6 : 2, 0, 0, 0]);
  return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...chunk("IHDR", ihdr), ...chunk("IDAT", Uint8Array.from(z)), ...chunk("IEND", new Uint8Array(0))]);
}

/**
 * The scenes' "lucka" (J5): a square window frame — an opaque red band
 * on the outside, a half-opaque gold band inside it, a transparent middle
 * — `size` px on a side, bands `size / 8` wide.
 */
export function luckaPng(size = 64): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const band = size / 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.min(x, y, size - 1 - x, size - 1 - y);
      const o = (y * size + x) * 4;
      if (d < band) px.set([200, 16, 46, 255], o);
      else if (d < 2 * band) px.set([255, 196, 0, 128], o);
      else px.set([0, 0, 0, 0], o);
    }
  }
  return encodeRgbaPng(size, size, px);
}

/** 32 × 16 px RGB: four vertical bands (blue, green, orange, black) over a white bottom band, so a crop, a flip and a turn all show. */
export function stripesPng(): Uint8Array {
  const w = 32, h = 16;
  const px = new Uint8Array(w * h * 3);
  const bands = [[31, 111, 178], [0, 150, 60], [240, 140, 0], [0, 0, 0]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(y >= 12 ? [255, 255, 255] : bands[Math.floor(x / 8)], (y * w + x) * 3);
  return encodeRgbaPng(w, h, px, 3);
}
