import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTrueType } from "../../render/truetype.js";
import { cidWidths, fontDescriptorValues, glyphHex, subsetTag, subsetTrueType, toUnicodeCMap } from "../fonts.js";

const fontsDir = fileURLToPath(new URL("../../../fonts/", import.meta.url));
const bytes = (f: string) => {
  const b = readFileSync(fontsDir + f);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const sansBytes = bytes("LiberationSans-Regular.ttf");
const sans = parseTrueType(sansBytes, "liberation-sans");
const gid = (ch: string) => sans.glyphId(ch.codePointAt(0)!);

function tableSum(u: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < u.length; i += 4) s = (s + (((u[i] << 24) | (u[i + 1] << 16) | (u[i + 2] << 8) | u[i + 3]) >>> 0)) >>> 0;
  return s;
}

/** Raw glyph records, advances and glyph count of a TrueType file (the subset has no cmap to parse it by). */
function rawFont(u: Uint8Array) {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const t = new Map<string, number>();
  for (let i = 0; i < dv.getUint16(4); i++) {
    t.set(String.fromCharCode(...u.subarray(12 + i * 16, 16 + i * 16)), dv.getUint32(12 + i * 16 + 8));
  }
  const numGlyphs = dv.getUint16(t.get("maxp")! + 4);
  const long = dv.getInt16(t.get("head")! + 50) !== 0;
  const loca = (g: number) => (long ? dv.getUint32(t.get("loca")! + g * 4) : dv.getUint16(t.get("loca")! + g * 2) * 2);
  const nH = dv.getUint16(t.get("hhea")! + 34);
  return {
    numGlyphs,
    tags: [...t.keys()],
    glyph: (g: number) => {
      const s = loca(g), e = loca(g + 1);
      const raw = u.subarray(t.get("glyf")! + s, t.get("glyf")! + e);
      // strip the 4-byte alignment padding the subset adds
      return Array.from(raw);
    },
    advance: (g: number) => dv.getUint16(t.get("hmtx")! + Math.min(g, nH - 1) * 4),
  };
}

describe("subsetTrueType", () => {
  const used = ["3", "1", "Å", "x"].map(gid);
  const sub = subsetTrueType(sansBytes, used);
  const src = rawFont(new Uint8Array(sansBytes));
  const out = rawFont(sub);
  const same = (g: number) => {
    const a = src.glyph(g), b = out.glyph(g);
    expect(b.slice(0, a.length)).toEqual(a);
    expect(b.length - a.length).toBeLessThan(4);
  };

  it("keeps glyph ids: the kept glyphs' records and advances are unchanged", () => {
    for (const g of used) {
      expect(src.glyph(g).length).toBeGreaterThan(0);
      same(g);
      expect(out.advance(g)).toBe(sans.advance(g));
    }
  });

  it("keeps the components of a composite glyph (Å = A + ring)", () => {
    const g = gid("A");
    expect(used).not.toContain(g);
    same(g);
  });

  it("drops every other glyph and cuts the font after the highest id", () => {
    const other = gid("Q");
    expect(used).not.toContain(other);
    if (other < out.numGlyphs) expect(out.glyph(other)).toEqual([]);
    expect(out.numGlyphs).toBeGreaterThan(Math.max(...used));
    expect(out.numGlyphs).toBeLessThan(src.numGlyphs);
    expect(sub.length).toBeLessThan(sansBytes.byteLength / 4);
  });

  it("writes valid checksums and is byte-identical across runs", () => {
    expect(tableSum(sub)).toBe(0xb1b0afba);
    expect(subsetTrueType(sansBytes, [...used].reverse())).toEqual(sub);
  });

  it("drops cmap and layout tables", () => {
    expect(out.tags).toEqual(["OS/2", "cvt ", "fpgm", "glyf", "head", "hhea", "hmtx", "loca", "maxp", "name", "post", "prep"]);
  });
});

describe("CIDFont pieces", () => {
  it("groups consecutive glyph ids in the W array, widths per 1000 em", () => {
    const w = cidWidths({ unitsPerEm: 2048, advance: (g) => g * 100 }, [5, 3, 4, 9]);
    expect(w).toEqual([3, [146, 195, 244], 9, [439]]);
  });

  it("maps glyph ids back to text in the ToUnicode CMap", () => {
    const cmap = toUnicodeCMap(sans, [gid("A"), gid("Å")]);
    expect(cmap).toContain(`<${gid("A").toString(16).toUpperCase().padStart(4, "0")}> <0041>`);
    expect(cmap).toContain("<00C5>");
    expect(cmap).toContain("2 beginbfchar");
  });

  it("writes glyph runs as 2-byte hex", () => {
    expect(glyphHex([1, 255, 4096])).toBe("<000100FF1000>");
  });

  it("derives a deterministic six-letter subset tag", () => {
    const t = subsetTag("liberation-sans", [3, 1, 2]);
    expect(t).toMatch(/^[A-Z]{6}$/);
    expect(subsetTag("liberation-sans", [1, 2, 3])).toBe(t);
    expect(subsetTag("liberation-sans-narrow", [1, 2, 3])).not.toBe(t);
  });

  it("reads descriptor metrics in 1000 units", () => {
    const d = fontDescriptorValues(sansBytes);
    expect(d.ascent).toBeGreaterThan(800);
    expect(d.descent).toBeLessThan(-150);
    expect(d.capHeight).toBeGreaterThan(600);
    expect(d.flags & 4).toBe(4);
    expect(d.italicAngle).toBe(0);
  });
});
