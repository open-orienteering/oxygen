/**
 * Minimal TrueType reader: enough of `head`, `hhea`, `hmtx`, `maxp`,
 * `cmap` (formats 4 and 12), `kern` (format 0), `loca`/`glyf` and `OS/2`
 * to shape Latin text and extract outlines. Pure; takes an ArrayBuffer.
 *
 * Both backends and the shaper read fonts through this so advances,
 * kerning and outlines are the same numbers everywhere (04 §4.4).
 */

import { COORD_FLAG, type RenderPath, makePath } from "./pass-stream.js";
import type { FontFamily } from "./pass-stream.js";

export interface FontMetrics {
  family: FontFamily;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  /** Height of the digit "0" above the baseline, font units. */
  digitHeight: number;
  glyphId(codepoint: number): number;
  advance(glyphId: number): number;
  kerning(left: number, right: number): number;
  /** Outline in font units, y-up, origin at the glyph's baseline origin; undefined for empty glyphs. */
  outline?(glyphId: number): RenderPath | undefined;
}

interface Table { offset: number; length: number }

export class TrueTypeFont implements FontMetrics {
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  readonly numGlyphs: number;
  readonly digitHeight: number;
  private readonly dv: DataView;
  private readonly tables = new Map<string, Table>();
  private readonly cmap = new Map<number, number>();
  private readonly advances: Uint16Array;
  private readonly kern = new Map<number, number>();
  private readonly loca: Uint32Array | null;
  private readonly glyf: Table | null;
  private readonly outlineCache = new Map<number, RenderPath | null>();
  readonly family: FontFamily;

  constructor(buffer: ArrayBuffer, family: FontFamily) {
    this.family = family;
    this.dv = new DataView(buffer);
    const numTables = this.dv.getUint16(4);
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      const tag = String.fromCharCode(
        this.dv.getUint8(o), this.dv.getUint8(o + 1), this.dv.getUint8(o + 2), this.dv.getUint8(o + 3),
      );
      this.tables.set(tag, { offset: this.dv.getUint32(o + 8), length: this.dv.getUint32(o + 12) });
    }
    const head = this.need("head");
    this.unitsPerEm = this.dv.getUint16(head.offset + 18);
    const indexToLocFormat = this.dv.getInt16(head.offset + 50);
    const hhea = this.need("hhea");
    this.ascender = this.dv.getInt16(hhea.offset + 4);
    this.descender = this.dv.getInt16(hhea.offset + 6);
    const numberOfHMetrics = this.dv.getUint16(hhea.offset + 34);
    const maxp = this.need("maxp");
    this.numGlyphs = this.dv.getUint16(maxp.offset + 4);
    const hmtx = this.need("hmtx");
    this.advances = new Uint16Array(this.numGlyphs);
    let last = 0;
    for (let g = 0; g < this.numGlyphs; g++) {
      if (g < numberOfHMetrics) last = this.dv.getUint16(hmtx.offset + g * 4);
      this.advances[g] = last;
    }
    this.readCmap();
    this.readKern();
    const locaT = this.tables.get("loca");
    this.glyf = this.tables.get("glyf") ?? null;
    if (locaT && this.glyf) {
      this.loca = new Uint32Array(this.numGlyphs + 1);
      for (let g = 0; g <= this.numGlyphs; g++) {
        this.loca[g] = indexToLocFormat === 0 ? this.dv.getUint16(locaT.offset + g * 2) * 2 : this.dv.getUint32(locaT.offset + g * 4);
      }
    } else {
      this.loca = null;
    }
    this.digitHeight = this.measureDigitHeight();
  }

  private need(tag: string): Table {
    const t = this.tables.get(tag);
    if (!t) throw new Error(`font lacks ${tag} table`);
    return t;
  }

  private readCmap(): void {
    const cmap = this.need("cmap");
    const n = this.dv.getUint16(cmap.offset + 2);
    let best: { offset: number; score: number } | null = null;
    for (let i = 0; i < n; i++) {
      const o = cmap.offset + 4 + i * 8;
      const platform = this.dv.getUint16(o), encoding = this.dv.getUint16(o + 2);
      const sub = cmap.offset + this.dv.getUint32(o + 4);
      const format = this.dv.getUint16(sub);
      let score = 0;
      if (platform === 3 && encoding === 10 && format === 12) score = 4;
      else if (platform === 3 && encoding === 1 && format === 4) score = 3;
      else if (platform === 0 && format === 12) score = 2;
      else if (platform === 0 && format === 4) score = 1;
      if (score && (!best || score > best.score)) best = { offset: sub, score };
    }
    if (!best) throw new Error("font has no usable Unicode cmap");
    const sub = best.offset;
    const format = this.dv.getUint16(sub);
    if (format === 4) {
      const segX2 = this.dv.getUint16(sub + 6);
      const ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = this.dv.getUint16(ends + s * 2), start = this.dv.getUint16(starts + s * 2);
        const delta = this.dv.getInt16(deltas + s * 2), ro = this.dv.getUint16(ranges + s * 2);
        if (start === 0xffff) continue;
        for (let c = start; c <= end; c++) {
          let g: number;
          if (ro === 0) g = (c + delta) & 0xffff;
          else {
            const addr = ranges + s * 2 + ro + (c - start) * 2;
            g = this.dv.getUint16(addr);
            if (g !== 0) g = (g + delta) & 0xffff;
          }
          if (g !== 0) this.cmap.set(c, g);
        }
      }
    } else {
      const nGroups = this.dv.getUint32(sub + 12);
      for (let i = 0; i < nGroups; i++) {
        const o = sub + 16 + i * 12;
        const start = this.dv.getUint32(o), end = this.dv.getUint32(o + 4), g0 = this.dv.getUint32(o + 8);
        for (let c = start; c <= end && c - start < 65536; c++) this.cmap.set(c, g0 + (c - start));
      }
    }
  }

  private readKern(): void {
    const kern = this.tables.get("kern");
    if (!kern) return;
    const version = this.dv.getUint16(kern.offset);
    if (version !== 0) return;
    const nTables = this.dv.getUint16(kern.offset + 2);
    let o = kern.offset + 4;
    for (let i = 0; i < nTables; i++) {
      const length = this.dv.getUint16(o + 2);
      const coverage = this.dv.getUint16(o + 4);
      const format = coverage >> 8;
      const horizontal = (coverage & 1) === 1;
      if (format === 0 && horizontal) {
        const nPairs = this.dv.getUint16(o + 6);
        let p = o + 14;
        for (let k = 0; k < nPairs; k++, p += 6) {
          const l = this.dv.getUint16(p), r = this.dv.getUint16(p + 2), v = this.dv.getInt16(p + 4);
          this.kern.set(l * 65536 + r, v);
        }
      }
      o += length;
    }
  }

  private measureDigitHeight(): number {
    const g = this.glyphId(0x30);
    const o = g ? this.outline(g) : undefined;
    if (!o) return Math.round(this.unitsPerEm * 0.716); // Arial-like fallback
    let maxY = -Infinity;
    for (let i = 1; i < o.coords.length; i += 2) maxY = Math.max(maxY, o.coords[i]);
    return maxY;
  }

  glyphId(codepoint: number): number {
    return this.cmap.get(codepoint) ?? 0;
  }

  advance(glyphId: number): number {
    return this.advances[glyphId] ?? 0;
  }

  kerning(left: number, right: number): number {
    return this.kern.get(left * 65536 + right) ?? 0;
  }

  outline(glyphId: number): RenderPath | undefined {
    const hit = this.outlineCache.get(glyphId);
    if (hit !== undefined) return hit ?? undefined;
    const coords: number[] = [];
    const flags: number[] = [];
    this.appendGlyph(glyphId, coords, flags, [1, 0, 0, 1, 0, 0], 0);
    const path = coords.length ? makePath(coords.map(Math.round), flags, true) : null;
    this.outlineCache.set(glyphId, path);
    return path ?? undefined;
  }

  private appendGlyph(glyphId: number, coords: number[], flags: number[], m: number[], depth: number): void {
    if (!this.loca || !this.glyf || glyphId >= this.numGlyphs || depth > 8) return;
    const start = this.glyf.offset + this.loca[glyphId];
    const end = this.glyf.offset + this.loca[glyphId + 1];
    if (end <= start) return;
    const nContours = this.dv.getInt16(start);
    if (nContours >= 0) this.appendSimple(start, nContours, coords, flags, m);
    else this.appendComposite(start, coords, flags, m, depth);
  }

  private appendSimple(start: number, nContours: number, coords: number[], flags: number[], m: number[]): void {
    let o = start + 10;
    const endPts: number[] = [];
    for (let i = 0; i < nContours; i++, o += 2) endPts.push(this.dv.getUint16(o));
    const nPts = nContours ? endPts[nContours - 1] + 1 : 0;
    const instrLen = this.dv.getUint16(o);
    o += 2 + instrLen;
    const f = new Uint8Array(nPts);
    for (let i = 0; i < nPts; ) {
      const b = this.dv.getUint8(o++);
      f[i++] = b;
      if (b & 8) {
        let rep = this.dv.getUint8(o++);
        while (rep-- > 0 && i < nPts) f[i++] = b;
      }
    }
    const xs = new Int16Array(nPts), ys = new Int16Array(nPts);
    let v = 0;
    for (let i = 0; i < nPts; i++) {
      const b = f[i];
      if (b & 2) { const d = this.dv.getUint8(o++); v += b & 16 ? d : -d; }
      else if (!(b & 16)) { v += this.dv.getInt16(o); o += 2; }
      xs[i] = v;
    }
    v = 0;
    for (let i = 0; i < nPts; i++) {
      const b = f[i];
      if (b & 4) { const d = this.dv.getUint8(o++); v += b & 32 ? d : -d; }
      else if (!(b & 32)) { v += this.dv.getInt16(o); o += 2; }
      ys[i] = v;
    }
    const tx = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    let s = 0;
    for (let c = 0; c < nContours; c++) {
      const e = endPts[c];
      const n = e - s + 1;
      if (n <= 0) { s = e + 1; continue; }
      const on = (i: number) => (f[s + ((i % n) + n) % n] & 1) !== 0;
      const pt = (i: number) => tx(xs[s + ((i % n) + n) % n], ys[s + ((i % n) + n) % n]);
      // Find a starting on-curve point (or synthesise the midpoint of two off-curve points).
      let startIdx = 0;
      while (startIdx < n && !on(startIdx)) startIdx++;
      let startPt: [number, number];
      if (startIdx === n) {
        startIdx = 0;
        const [ax, ay] = pt(0), [bx, by] = pt(1);
        startPt = [(ax + bx) / 2, (ay + by) / 2];
      } else startPt = pt(startIdx);
      const firstOfContour = coords.length;
      coords.push(startPt[0], startPt[1]);
      flags.push(firstOfContour === 0 ? 0 : COORD_FLAG.hole);
      let cur = startPt;
      let i = startIdx + 1;
      let pendingCtrl: [number, number] | null = null;
      const emitQuad = (ctrl: [number, number], to: [number, number]) => {
        coords.push(
          cur[0] + (2 / 3) * (ctrl[0] - cur[0]), cur[1] + (2 / 3) * (ctrl[1] - cur[1]),
          to[0] + (2 / 3) * (ctrl[0] - to[0]), to[1] + (2 / 3) * (ctrl[1] - to[1]),
          to[0], to[1],
        );
        flags.push(COORD_FLAG.bezierFirst, COORD_FLAG.bezierSecond, 0);
        cur = to;
      };
      for (let k = 0; k < n; k++, i++) {
        const p = pt(i);
        if (on(i)) {
          if (pendingCtrl) { emitQuad(pendingCtrl, p); pendingCtrl = null; }
          else { coords.push(p[0], p[1]); flags.push(0); cur = p; }
        } else if (pendingCtrl) {
          const mid: [number, number] = [(pendingCtrl[0] + p[0]) / 2, (pendingCtrl[1] + p[1]) / 2];
          emitQuad(pendingCtrl, mid);
          pendingCtrl = p;
        } else pendingCtrl = p;
      }
      if (pendingCtrl) emitQuad(pendingCtrl, startPt);
      // Drop a final point that duplicates the contour start (the ring closes implicitly).
      const L = coords.length;
      if (L - firstOfContour >= 4 && flags[flags.length - 1] === 0 && coords[L - 2] === coords[firstOfContour] && coords[L - 1] === coords[firstOfContour + 1]) {
        coords.length = L - 2;
        flags.length = flags.length - 1;
      }
      s = e + 1;
    }
  }

  private appendComposite(start: number, coords: number[], flags: number[], m: number[], depth: number): void {
    let o = start + 10;
    for (;;) {
      const cf = this.dv.getUint16(o), gi = this.dv.getUint16(o + 2);
      o += 4;
      let dx: number, dy: number;
      if (cf & 1) { dx = this.dv.getInt16(o); dy = this.dv.getInt16(o + 2); o += 4; }
      else { dx = this.dv.getInt8(o); dy = this.dv.getInt8(o + 1); o += 2; }
      let a = 1, b = 0, c = 0, d = 1;
      const f2 = (p: number) => this.dv.getInt16(p) / 16384;
      if (cf & 8) { a = d = f2(o); o += 2; }
      else if (cf & 0x40) { a = f2(o); d = f2(o + 2); o += 4; }
      else if (cf & 0x80) { a = f2(o); b = f2(o + 2); c = f2(o + 4); d = f2(o + 6); o += 8; }
      if (!(cf & 2)) { dx = 0; dy = 0; } // point-matching placement unsupported: place at origin
      const sub = [a, b, c, d, dx, dy];
      const mm = [
        m[0] * sub[0] + m[2] * sub[1], m[1] * sub[0] + m[3] * sub[1],
        m[0] * sub[2] + m[2] * sub[3], m[1] * sub[2] + m[3] * sub[3],
        m[0] * sub[4] + m[2] * sub[5] + m[4], m[1] * sub[4] + m[3] * sub[5] + m[5],
      ];
      this.appendGlyph(gi, coords, flags, mm, depth + 1);
      if (!(cf & 0x20)) break;
    }
  }
}

export function parseTrueType(buffer: ArrayBuffer, family: FontFamily): TrueTypeFont {
  return new TrueTypeFont(buffer, family);
}
