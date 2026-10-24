/**
 * Font programs for the PDF backend (docs/course-print.md §3, research
 * 05 §5.6): the bundled TrueType faces subset to the glyphs a document
 * uses, **keeping glyph ids** — the shaper (`render/text.ts`) already
 * works in glyph ids, so the content stream writes them unchanged as
 * Identity-H codes and the CIDFontType2 maps CID = GID (`/CIDToGIDMap
 * /Identity`). No renumbering, no second shaper, no fontkit. Plus the
 * pieces the CIDFont dictionaries need: widths, descriptor metrics, a
 * deterministic subset tag and the ToUnicode CMap.
 *
 * Writer-independent: `writer.ts` turns these into PDF objects.
 */

import type { FontMetrics } from "../render/truetype.js";

interface Table {
  tag: string;
  offset: number;
  length: number;
}

function tablesOf(dv: DataView): Map<string, Table> {
  const n = dv.getUint16(4);
  const out = new Map<string, Table>();
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    const tag = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    out.set(tag, { tag, offset: dv.getUint32(o + 8), length: dv.getUint32(o + 12) });
  }
  return out;
}

function need(tables: Map<string, Table>, tag: string): Table {
  const t = tables.get(tag);
  if (!t) throw new Error(`font lacks ${tag} table`);
  return t;
}

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  const padded = bytes.length + ((4 - (bytes.length % 4)) % 4);
  for (let i = 0; i < padded; i += 4) {
    const v = ((bytes[i] ?? 0) << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    sum = (sum + (v >>> 0)) >>> 0;
  }
  return sum;
}

/** Composite-glyph components (recursively), so a kept accent keeps its base. */
function componentsOf(dv: DataView, glyf: Table, loca: (g: number) => [number, number], gid: number, out: Set<number>, depth = 0): void {
  if (depth > 8) return;
  const [s, e] = loca(gid);
  if (e <= s) return;
  const start = glyf.offset + s;
  if (dv.getInt16(start) >= 0) return;
  let o = start + 10;
  for (;;) {
    const flags = dv.getUint16(o);
    const comp = dv.getUint16(o + 2);
    o += 4 + (flags & 1 ? 4 : 2);
    if (flags & 8) o += 2;
    else if (flags & 0x40) o += 4;
    else if (flags & 0x80) o += 8;
    if (!out.has(comp)) {
      out.add(comp);
      componentsOf(dv, glyf, loca, comp, out, depth + 1);
    }
    if (!(flags & 0x20)) break;
  }
}

/** Tables a CIDFontType2 program needs (ISO 32000-1 §9.9), plus OS/2, name and a format-3 post. */
const KEEP = ["OS/2", "cvt ", "fpgm", "glyf", "head", "hhea", "hmtx", "loca", "maxp", "name", "post", "prep"];

/**
 * Subsets a TrueType font to `glyphIds` (glyph 0 and composite
 * components always included) **without renumbering**: unused glyphs
 * stay as empty `glyf` entries, `maxp.numGlyphs` is cut after the
 * highest kept id. `cmap`, kerning and layout tables are dropped — the
 * PDF addresses glyphs by id. Deterministic: same input, same bytes.
 */
export function subsetTrueType(data: ArrayBuffer | Uint8Array, glyphIds: Iterable<number>): Uint8Array {
  const src = data instanceof Uint8Array ? data : new Uint8Array(data);
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const tables = tablesOf(dv);
  const head = need(tables, "head");
  const maxp = need(tables, "maxp");
  const hhea = need(tables, "hhea");
  const hmtx = need(tables, "hmtx");
  const locaT = need(tables, "loca");
  const glyf = need(tables, "glyf");
  const numGlyphs = dv.getUint16(maxp.offset + 4);
  const longLoca = dv.getInt16(head.offset + 50) !== 0;
  const loca = (g: number): [number, number] =>
    longLoca
      ? [dv.getUint32(locaT.offset + g * 4), dv.getUint32(locaT.offset + g * 4 + 4)]
      : [dv.getUint16(locaT.offset + g * 2) * 2, dv.getUint16(locaT.offset + g * 2 + 2) * 2];

  const keep = new Set<number>([0]);
  for (const g of glyphIds) if (g >= 0 && g < numGlyphs) keep.add(g);
  for (const g of [...keep]) componentsOf(dv, glyf, loca, g, keep);
  const n = Math.max(...keep) + 1;

  // glyf + long loca
  const glyfParts: Uint8Array[] = [];
  const newLoca = new DataView(new ArrayBuffer((n + 1) * 4));
  let pos = 0;
  for (let g = 0; g < n; g++) {
    newLoca.setUint32(g * 4, pos);
    if (!keep.has(g)) continue;
    const [s, e] = loca(g);
    if (e <= s) continue;
    const len = e - s;
    const padded = len + ((4 - (len % 4)) % 4);
    const part = new Uint8Array(padded);
    part.set(src.subarray(glyf.offset + s, glyf.offset + e));
    glyfParts.push(part);
    pos += padded;
  }
  newLoca.setUint32(n * 4, pos);
  const newGlyf = new Uint8Array(pos);
  let w = 0;
  for (const p of glyfParts) {
    newGlyf.set(p, w);
    w += p.length;
  }

  // hmtx: one long metric per kept glyph slot
  const nHMetrics = dv.getUint16(hhea.offset + 34);
  const newHmtx = new DataView(new ArrayBuffer(n * 4));
  for (let g = 0; g < n; g++) {
    const adv = dv.getUint16(hmtx.offset + Math.min(g, nHMetrics - 1) * 4);
    const lsb = g < nHMetrics ? dv.getInt16(hmtx.offset + g * 4 + 2) : dv.getInt16(hmtx.offset + nHMetrics * 4 + (g - nHMetrics) * 2);
    newHmtx.setUint16(g * 4, adv);
    newHmtx.setInt16(g * 4 + 2, lsb);
  }

  const copy = (t: Table) => src.slice(t.offset, t.offset + t.length);
  const out = new Map<string, Uint8Array>();
  for (const tag of KEEP) {
    const t = tables.get(tag);
    if (!t) continue;
    switch (tag) {
      case "glyf": out.set(tag, newGlyf); break;
      case "loca": out.set(tag, new Uint8Array(newLoca.buffer)); break;
      case "hmtx": out.set(tag, new Uint8Array(newHmtx.buffer)); break;
      case "head": {
        const b = copy(t);
        const v = new DataView(b.buffer);
        v.setUint32(8, 0); // checkSumAdjustment, set below
        v.setInt16(50, 1); // long loca
        out.set(tag, b);
        break;
      }
      case "maxp": {
        const b = copy(t);
        new DataView(b.buffer).setUint16(4, n);
        out.set(tag, b);
        break;
      }
      case "hhea": {
        const b = copy(t);
        new DataView(b.buffer).setUint16(34, n);
        out.set(tag, b);
        break;
      }
      case "post": {
        const b = src.slice(t.offset, t.offset + 32);
        new DataView(b.buffer).setUint32(0, 0x00030000);
        out.set(tag, b);
        break;
      }
      default:
        out.set(tag, copy(t));
    }
  }

  // Assemble: directory sorted by tag, tables 4-byte aligned.
  const tags = [...out.keys()].sort();
  const numTables = tags.length;
  let size = 12 + numTables * 16;
  for (const tag of tags) size += out.get(tag)!.length + ((4 - (out.get(tag)!.length % 4)) % 4);
  const font = new Uint8Array(size);
  const fv = new DataView(font.buffer);
  fv.setUint32(0, 0x00010000);
  fv.setUint16(4, numTables);
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 2 ** entrySelector * 16;
  fv.setUint16(6, searchRange);
  fv.setUint16(8, entrySelector);
  fv.setUint16(10, numTables * 16 - searchRange);
  let off = 12 + numTables * 16;
  let headOffset = 0;
  tags.forEach((tag, i) => {
    const bytes = out.get(tag)!;
    const d = 12 + i * 16;
    for (let k = 0; k < 4; k++) fv.setUint8(d + k, tag.charCodeAt(k));
    fv.setUint32(d + 4, checksum(bytes));
    fv.setUint32(d + 8, off);
    fv.setUint32(d + 12, bytes.length);
    font.set(bytes, off);
    if (tag === "head") headOffset = off;
    off += bytes.length + ((4 - (bytes.length % 4)) % 4);
  });
  fv.setUint32(headOffset + 8, (0xb1b0afba - checksum(font)) >>> 0);
  return font;
}

/** Values of the `FontDescriptor`, in PDF glyph space (1000 units per em). */
export interface FontDescriptorValues {
  bbox: [number, number, number, number];
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
  /** Symbolic (bit 3): the font is addressed by glyph id, not a standard encoding. */
  flags: number;
  stemV: number;
}

export function fontDescriptorValues(data: ArrayBuffer | Uint8Array): FontDescriptorValues {
  const src = data instanceof Uint8Array ? data : new Uint8Array(data);
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const tables = tablesOf(dv);
  const head = need(tables, "head");
  const hhea = need(tables, "hhea");
  const upm = dv.getUint16(head.offset + 18);
  const k = (v: number) => Math.round((v * 1000) / upm);
  const bbox: [number, number, number, number] = [
    k(dv.getInt16(head.offset + 36)), k(dv.getInt16(head.offset + 38)),
    k(dv.getInt16(head.offset + 40)), k(dv.getInt16(head.offset + 42)),
  ];
  const os2 = tables.get("OS/2");
  const capHeight = os2 && dv.getUint16(os2.offset) >= 2 ? k(dv.getInt16(os2.offset + 88)) : bbox[3];
  const post = tables.get("post");
  const italicAngle = post ? dv.getInt32(post.offset + 4) / 65536 : 0;
  const macStyle = dv.getUint16(head.offset + 44);
  return {
    bbox,
    ascent: k(dv.getInt16(hhea.offset + 4)),
    descent: k(dv.getInt16(hhea.offset + 6)),
    capHeight,
    italicAngle,
    flags: 4 | (macStyle & 2 ? 64 : 0),
    stemV: macStyle & 1 ? 120 : 80,
  };
}

/**
 * The `W` array of a CIDFont for the used glyphs: `[c [w1 w2 …] …]`
 * with runs of consecutive ids grouped, widths in 1000 units per em.
 */
export function cidWidths(font: Pick<FontMetrics, "advance" | "unitsPerEm">, glyphIds: Iterable<number>): (number | number[])[] {
  const ids = [...new Set(glyphIds)].sort((a, b) => a - b);
  const out: (number | number[])[] = [];
  let run: number[] | null = null;
  let prev = -2;
  for (const g of ids) {
    const w = Math.round((font.advance(g) * 1000) / font.unitsPerEm);
    if (run && g === prev + 1) run.push(w);
    else {
      run = [w];
      out.push(g, run);
    }
    prev = g;
  }
  return out;
}

/** Deterministic six-letter subset tag (ISO 32000-1 §9.6.4) from the glyph set and face. */
export function subsetTag(family: string, glyphIds: Iterable<number>): string {
  let h = 0x811c9dc5;
  const feed = (v: number) => {
    h ^= v & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (const ch of family) feed(ch.charCodeAt(0));
  for (const g of [...new Set(glyphIds)].sort((a, b) => a - b)) {
    feed(g >> 8);
    feed(g);
  }
  let tag = "";
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (h % 26));
    h = (Math.floor(h / 26) ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  }
  return tag;
}

const reverseCmaps = new WeakMap<object, Map<number, number>>();

/** Glyph id → the lowest code point that maps to it (BMP), for ToUnicode. */
export function reverseCmap(font: Pick<FontMetrics, "glyphId">): Map<number, number> {
  let m = reverseCmaps.get(font);
  if (!m) {
    m = new Map();
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const g = font.glyphId(cp);
      if (g !== 0 && !m.has(g)) m.set(g, cp);
    }
    reverseCmaps.set(font, m);
  }
  return m;
}

const hex4 = (v: number) => v.toString(16).toUpperCase().padStart(4, "0");

/** A ToUnicode CMap for 2-byte Identity-H codes (= glyph ids). */
export function toUnicodeCMap(font: Pick<FontMetrics, "glyphId">, glyphIds: Iterable<number>): string {
  const rev = reverseCmap(font);
  const pairs = [...new Set(glyphIds)]
    .sort((a, b) => a - b)
    .filter((g) => rev.has(g))
    .map((g) => `<${hex4(g)}> <${hex4(rev.get(g)!)}>`);
  const chunks: string[] = [];
  for (let i = 0; i < pairs.length; i += 100) {
    const c = pairs.slice(i, i + 100);
    chunks.push(`${c.length} beginbfchar\n${c.join("\n")}\nendbfchar`);
  }
  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    ...chunks,
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
}

/** A glyph run as an Identity-H hex string. */
export function glyphHex(glyphIds: ArrayLike<number>): string {
  let s = "<";
  for (let i = 0; i < glyphIds.length; i++) s += hex4(glyphIds[i]);
  return s + ">";
}
