/**
 * Map document codec — encode a normalised document to bytes and decode
 * bytes into typed arrays (docs/map-document-format.md §3–5).
 *
 * File layout (all integers little-endian):
 *
 *   "OXVM"  u32 version  u32 headerLength
 *   header JSON (UTF-8, headerLength bytes)
 *   padding to a 4-byte boundary                 ← bodyOffset
 *   attrs    : 24 bytes per object (fixed width)
 *   bboxes   : 16 bytes per object (i32 minX minY maxX maxY)
 *   geometry : per object, coordCount × (varint zz(Δx), varint zz(Δy), u8 flags)
 *
 * The first coordinate of an object is a delta from its bbox minimum,
 * the rest from the previous coordinate, so any object can be decoded
 * on its own from `attrs.geomOffset` + its bbox. Objects are written in
 * Hilbert order over the document bounds; `sourceIndex` keeps the
 * source order.
 *
 * Pure TypeScript over `Uint8Array`/`DataView`; no Node APIs.
 */

import {
  MAP_DOCUMENT_MAGIC,
  MAP_DOCUMENT_VERSION,
  parseMapDocumentHeader,
  type DocumentBounds,
  type MapDocumentHeader,
  type MapDocumentHeaderInput,
} from "./header.js";

export const ATTR_BYTES = 24;
export const BBOX_BYTES = 16;
const PREAMBLE_BYTES = 12;
/** Hilbert grid resolution per axis. */
const HILBERT_ORDER = 16;

export interface MapObjectInput {
  symbolIdx: number;
  /** `OBJECT_TYPE` value, 1–7. */
  type: number;
  /** Rotation in 0.1°, as the source wrote it. */
  angleDeciDeg?: number;
  text?: string;
  /** Position in the source file's object list. */
  sourceIndex: number;
  /** x, y pairs in native units. At least one coordinate. */
  coords: ArrayLike<number>;
  /** One `COORD_FLAG` byte per coordinate. */
  flags: ArrayLike<number>;
}

/** Header fields the encoder does not compute itself. */
export type MapDocumentInputHeader = Omit<MapDocumentHeaderInput, "bounds" | "strings" | "objects">;

export interface MapDocumentInput {
  header: MapDocumentInputHeader;
  objects: MapObjectInput[];
}

/** Structure-of-arrays view of the attrs section. */
export interface ObjectAttrs {
  symbolIdx: Uint16Array;
  type: Uint8Array;
  /** 0.1° */
  angle: Int16Array;
  /** 1-based into `header.strings`, 0 = none. */
  stringIdx: Uint32Array;
  /** Byte offset into the geometry section. */
  geomOffset: Uint32Array;
  coordCount: Uint32Array;
  sourceIndex: Uint32Array;
}

export interface MapDocument {
  header: MapDocumentHeader;
  attrs: ObjectAttrs;
  /** 4 per object: minX minY maxX maxY, native units. */
  bboxes: Int32Array;
  /** All coordinates, x,y pairs, in object order. */
  coords: Int32Array;
  flags: Uint8Array;
  /** `count + 1` entries: first coordinate index of each object. */
  coordStart: Uint32Array;
  /** Text of object `i`, if any. */
  text(i: number): string | undefined;
}

// ---- varints ---------------------------------------------------------------

const zigzag = (v: number): number => ((v << 1) ^ (v >> 31)) >>> 0;
const unzigzag = (v: number): number => (v >>> 1) ^ -(v & 1);

class ByteWriter {
  private buf = new Uint8Array(1 << 16);
  length = 0;

  private grow(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  varint(v: number): void {
    this.grow(5);
    v >>>= 0;
    while (v >= 0x80) {
      this.buf[this.length++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    this.buf[this.length++] = v;
  }

  byte(v: number): void {
    this.grow(1);
    this.buf[this.length++] = v & 0xff;
  }

  bytes(): Uint8Array {
    return this.buf.subarray(0, this.length);
  }
}

// ---- Hilbert order ---------------------------------------------------------

/** Hilbert index of (x, y) on a 2^order grid. */
export function hilbertIndex(x: number, y: number, order = HILBERT_ORDER): number {
  let d = 0;
  for (let s = 1 << (order - 1); s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const t = x;
      x = y;
      y = t;
    }
  }
  return d;
}

// ---- encode ----------------------------------------------------------------

function objectBounds(coords: ArrayLike<number>): DocumentBounds {
  let minX = coords[0], minY = coords[1], maxX = coords[0], maxY = coords[1];
  for (let i = 2; i < coords.length; i += 2) {
    const x = coords[i], y = coords[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function encodeMapDocument(input: MapDocumentInput): Uint8Array {
  const { objects } = input;
  const symbolCount = input.header.symbols.length;

  // Validate and measure.
  const boxes: DocumentBounds[] = new Array(objects.length);
  let docBounds: DocumentBounds | undefined;
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    if (o.coords.length < 2 || o.coords.length % 2 !== 0) throw new Error(`object ${i}: coords must hold at least one x,y pair`);
    if (o.flags.length !== o.coords.length / 2) throw new Error(`object ${i}: flags length ${o.flags.length} ≠ coordinate count ${o.coords.length / 2}`);
    if (!Number.isInteger(o.symbolIdx) || o.symbolIdx < 0 || o.symbolIdx >= symbolCount || o.symbolIdx > 0xffff) throw new Error(`object ${i}: symbolIdx ${o.symbolIdx} out of range`);
    if (!Number.isInteger(o.type) || o.type < 1 || o.type > 7) throw new Error(`object ${i}: type ${o.type} out of range`);
    const a = o.angleDeciDeg ?? 0;
    if (!Number.isInteger(a) || a < -32768 || a > 32767) throw new Error(`object ${i}: angle ${a} out of i16 range`);
    if (!Number.isInteger(o.sourceIndex) || o.sourceIndex < 0) throw new Error(`object ${i}: sourceIndex must be a non-negative integer`);
    const b = objectBounds(o.coords);
    boxes[i] = b;
    if (!docBounds) docBounds = { ...b };
    else {
      if (b.minX < docBounds.minX) docBounds.minX = b.minX;
      if (b.minY < docBounds.minY) docBounds.minY = b.minY;
      if (b.maxX > docBounds.maxX) docBounds.maxX = b.maxX;
      if (b.maxY > docBounds.maxY) docBounds.maxY = b.maxY;
    }
  }
  const bounds = docBounds ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  // Hilbert order by bbox centre; ties by sourceIndex, then input order.
  const n = 1 << HILBERT_ORDER;
  const sx = (n - 1) / Math.max(1, bounds.maxX - bounds.minX);
  const sy = (n - 1) / Math.max(1, bounds.maxY - bounds.minY);
  const order = objects.map((_, i) => i);
  const keys = new Float64Array(objects.length);
  for (let i = 0; i < objects.length; i++) {
    const b = boxes[i];
    const cx = Math.floor(((b.minX + b.maxX) / 2 - bounds.minX) * sx);
    const cy = Math.floor(((b.minY + b.maxY) / 2 - bounds.minY) * sy);
    keys[i] = hilbertIndex(cx, cy);
  }
  order.sort((i, j) => keys[i] - keys[j] || objects[i].sourceIndex - objects[j].sourceIndex || i - j);

  // Strings, deduplicated, in output order.
  const strings: string[] = [];
  const stringIdx = new Map<string, number>();

  // Sections.
  const attrs = new Uint8Array(objects.length * ATTR_BYTES);
  const attrsView = new DataView(attrs.buffer);
  const bboxes = new Int32Array(objects.length * 4);
  const geom = new ByteWriter();
  for (let k = 0; k < order.length; k++) {
    const o = objects[order[k]];
    const b = boxes[order[k]];
    let sIdx = 0;
    if (o.text !== undefined && o.text !== "") {
      let idx = stringIdx.get(o.text);
      if (idx === undefined) {
        idx = strings.push(o.text);
        stringIdx.set(o.text, idx);
      }
      sIdx = idx;
    }
    const count = o.coords.length / 2;
    const base = k * ATTR_BYTES;
    attrsView.setUint16(base, o.symbolIdx, true);
    attrsView.setUint8(base + 2, o.type);
    attrsView.setUint8(base + 3, 0);
    attrsView.setInt16(base + 4, o.angleDeciDeg ?? 0, true);
    attrsView.setUint16(base + 6, 0, true);
    attrsView.setUint32(base + 8, sIdx, true);
    attrsView.setUint32(base + 12, geom.length, true);
    attrsView.setUint32(base + 16, count, true);
    attrsView.setUint32(base + 20, o.sourceIndex, true);
    bboxes[k * 4] = b.minX;
    bboxes[k * 4 + 1] = b.minY;
    bboxes[k * 4 + 2] = b.maxX;
    bboxes[k * 4 + 3] = b.maxY;

    let px = b.minX, py = b.minY;
    for (let i = 0; i < count; i++) {
      const x = o.coords[i * 2], y = o.coords[i * 2 + 1];
      geom.varint(zigzag(x - px));
      geom.varint(zigzag(y - py));
      geom.byte(o.flags[i]);
      px = x;
      py = y;
    }
  }
  const geomBytes = geom.bytes();

  const header: MapDocumentHeaderInput = {
    ...input.header,
    bounds,
    strings,
    objects: {
      count: objects.length,
      sections: {
        attrs: { offset: 0, length: attrs.byteLength },
        bboxes: { offset: attrs.byteLength, length: bboxes.byteLength },
        geometry: { offset: attrs.byteLength + bboxes.byteLength, length: geomBytes.byteLength },
      },
    },
  };
  // Parse once so defaults are applied and invalid input fails here, not in a reader.
  const headerJson = new TextEncoder().encode(JSON.stringify(parseMapDocumentHeader(header)));

  const bodyOffset = align4(PREAMBLE_BYTES + headerJson.byteLength);
  const out = new Uint8Array(bodyOffset + attrs.byteLength + bboxes.byteLength + geomBytes.byteLength);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = MAP_DOCUMENT_MAGIC.charCodeAt(i);
  dv.setUint32(4, MAP_DOCUMENT_VERSION, true);
  dv.setUint32(8, headerJson.byteLength, true);
  out.set(headerJson, PREAMBLE_BYTES);
  out.set(attrs, bodyOffset);
  out.set(new Uint8Array(bboxes.buffer), bodyOffset + attrs.byteLength);
  out.set(geomBytes, bodyOffset + attrs.byteLength + bboxes.byteLength);
  return out;
}

const align4 = (n: number): number => (n + 3) & ~3;

// ---- decode ----------------------------------------------------------------

export class MapDocumentFormatError extends Error {}

/** Reads magic, version and header without touching the binary sections. */
export function readMapDocumentHeader(bytes: Uint8Array): { header: MapDocumentHeader; bodyOffset: number } {
  if (bytes.byteLength < PREAMBLE_BYTES) throw new MapDocumentFormatError("not a map document: too short");
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAP_DOCUMENT_MAGIC.charCodeAt(i)) throw new MapDocumentFormatError("not a map document: bad magic");
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(4, true);
  if (version !== MAP_DOCUMENT_VERSION) throw new MapDocumentFormatError(`unsupported map document version ${version} (reader supports ${MAP_DOCUMENT_VERSION})`);
  const headerLength = dv.getUint32(8, true);
  if (PREAMBLE_BYTES + headerLength > bytes.byteLength) throw new MapDocumentFormatError("truncated map document header");
  const json = new TextDecoder().decode(bytes.subarray(PREAMBLE_BYTES, PREAMBLE_BYTES + headerLength));
  const header = parseMapDocumentHeader(JSON.parse(json));
  return { header, bodyOffset: align4(PREAMBLE_BYTES + headerLength) };
}

/**
 * Where the attrs section of a document lies, from its header and the
 * header's byte length (preamble bytes 8–11), so a reader can count
 * objects per symbol with one range read instead of the whole body.
 */
export function attrsSectionRange(header: Pick<MapDocumentHeader, "objects">, headerByteLength: number): { offset: number; length: number } {
  return { offset: align4(PREAMBLE_BYTES + headerByteLength) + header.objects.sections.attrs.offset, length: header.objects.sections.attrs.length };
}

/** Objects per symbol index from the attrs section (`symbolIdx` is its first field). */
export function objectsPerSymbol(attrs: Uint8Array, symbolCount: number): number[] {
  if (attrs.byteLength % ATTR_BYTES !== 0) throw new MapDocumentFormatError("attrs section is not a whole number of records");
  const counts = new Array<number>(symbolCount).fill(0);
  const dv = new DataView(attrs.buffer, attrs.byteOffset, attrs.byteLength);
  for (let base = 0; base < attrs.byteLength; base += ATTR_BYTES) {
    const idx = dv.getUint16(base, true);
    if (idx < symbolCount) counts[idx]++;
  }
  return counts;
}

export function decodeMapDocument(bytes: Uint8Array): MapDocument {
  const { header, bodyOffset } = readMapDocumentHeader(bytes);
  const { count, sections } = header.objects;
  const end = bodyOffset + sections.geometry.offset + sections.geometry.length;
  if (end > bytes.byteLength) throw new MapDocumentFormatError("truncated map document body");
  if (sections.attrs.length !== count * ATTR_BYTES) throw new MapDocumentFormatError("attrs section size does not match object count");
  if (sections.bboxes.length !== count * BBOX_BYTES) throw new MapDocumentFormatError("bboxes section size does not match object count");

  const attrsStart = bytes.byteOffset + bodyOffset + sections.attrs.offset;
  const av = new DataView(bytes.buffer, attrsStart, sections.attrs.length);
  const attrs: ObjectAttrs = {
    symbolIdx: new Uint16Array(count),
    type: new Uint8Array(count),
    angle: new Int16Array(count),
    stringIdx: new Uint32Array(count),
    geomOffset: new Uint32Array(count),
    coordCount: new Uint32Array(count),
    sourceIndex: new Uint32Array(count),
  };
  const coordStart = new Uint32Array(count + 1);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const base = i * ATTR_BYTES;
    attrs.symbolIdx[i] = av.getUint16(base, true);
    attrs.type[i] = av.getUint8(base + 2);
    attrs.angle[i] = av.getInt16(base + 4, true);
    attrs.stringIdx[i] = av.getUint32(base + 8, true);
    attrs.geomOffset[i] = av.getUint32(base + 12, true);
    attrs.coordCount[i] = av.getUint32(base + 16, true);
    attrs.sourceIndex[i] = av.getUint32(base + 20, true);
    coordStart[i] = total;
    total += attrs.coordCount[i];
  }
  coordStart[count] = total;

  const bboxStart = bytes.byteOffset + bodyOffset + sections.bboxes.offset;
  const bboxes = bboxStart % 4 === 0
    ? new Int32Array(bytes.buffer, bboxStart, count * 4)
    : new Int32Array(bytes.buffer.slice(bboxStart, bboxStart + sections.bboxes.length));

  const coords = new Int32Array(total * 2);
  const flags = new Uint8Array(total);
  const g = bytes.subarray(bodyOffset + sections.geometry.offset, bodyOffset + sections.geometry.offset + sections.geometry.length);
  let p = 0;
  let k = 0;
  for (let i = 0; i < count; i++) {
    if (p !== attrs.geomOffset[i]) throw new MapDocumentFormatError(`geometry offset mismatch at object ${i}`);
    let px = bboxes[i * 4], py = bboxes[i * 4 + 1];
    const n = attrs.coordCount[i];
    for (let j = 0; j < n; j++) {
      // inline varint reads
      let v = 0, s = 0, c: number;
      do {
        c = g[p++];
        v |= (c & 0x7f) << s;
        s += 7;
      } while (c & 0x80);
      px += unzigzag(v >>> 0);
      v = 0;
      s = 0;
      do {
        c = g[p++];
        v |= (c & 0x7f) << s;
        s += 7;
      } while (c & 0x80);
      py += unzigzag(v >>> 0);
      coords[k * 2] = px;
      coords[k * 2 + 1] = py;
      flags[k] = g[p++];
      k++;
    }
  }
  if (p !== g.byteLength) throw new MapDocumentFormatError("geometry section has trailing bytes");

  const strings = header.strings;
  return {
    header,
    attrs,
    bboxes,
    coords,
    flags,
    coordStart,
    text: (i) => (attrs.stringIdx[i] ? strings[attrs.stringIdx[i] - 1] : undefined),
  };
}

/** SHA-256 hex of the document bytes — the document's identity (§6). Uses WebCrypto (Node ≥ 20 and browsers). */
export async function mapDocumentHash(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
