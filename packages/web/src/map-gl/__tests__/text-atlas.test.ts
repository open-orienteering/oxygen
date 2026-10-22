import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@oxygen/shared";
import {
  buildTextGlyphs, GLYPH_TABLE_TEXELS, GLYPH_TABLE_WIDTH, haloEm, parseTextAtlasPage, TEXT_ATLAS_PAGE_NAMES,
  TEXT_ATLAS_PAGE_RANGES, TEXT_GLYPH_STRIDE, textAtlasPagesFor, textGlyphKey, type TextAtlasPage,
} from "../text-atlas";
import { glyphsetFile, pageFromAtlasJson, pageGlyphIds, TEXT_ATLAS_EM_PX, TEXT_ATLAS_RANGE_PX, type RawAtlasJson } from "../text-atlas-build";

const fontsDir = resolve(import.meta.dirname, "../../../../shared/fonts");
const FACES: [render.FontFamily, string][] = [
  ["liberation-sans", "LiberationSans-Regular.ttf"],
  ["liberation-sans-narrow", "LiberationSansNarrow-Regular.ttf"],
];
const fontFile = (file: string) => readFileSync(resolve(fontsDir, file));
const font = (family: render.FontFamily, file: string) => {
  const b = fontFile(file);
  return render.parseTrueType(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, family);
};
const committed = (page: string): TextAtlasPage =>
  parseTextAtlasPage(JSON.parse(readFileSync(resolve(fontsDir, `msdf/text-atlas.${page}.json`), "utf8")));
const pngSize = (page: string) => {
  const b = readFileSync(resolve(fontsDir, `msdf/text-atlas.${page}.png`));
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

describe("committed text atlas pages (map-rendering.md §4.10)", () => {
  const pages = TEXT_ATLAS_PAGE_NAMES.map(committed);

  it("are current: generated from the shipped fonts at 32 px with an 8 px range, image size as recorded", () => {
    for (const p of pages) {
      expect(p.emPx).toBe(TEXT_ATLAS_EM_PX);
      expect(p.distanceRangePx).toBe(TEXT_ATLAS_RANGE_PX);
      expect(pngSize(p.page)).toEqual({ width: p.width, height: p.height });
      expect(p.faces.map((f) => f.family)).toEqual(FACES.map(([f]) => f));
      p.faces.forEach((f, i) => {
        expect(f.sha256, `${p.page}/${f.family}: regenerate with pnpm text-atlas:generate`).toBe(createHash("sha256").update(fontFile(FACES[i][1])).digest("hex"));
      });
    }
  });

  it("hold every non-empty glyph of the page ranges, each once across pages", () => {
    FACES.forEach(([family, file], fi) => {
      const f = font(family, file);
      const seen = new Set<number>();
      for (const p of pages) {
        const ids = new Set<number>();
        const g = p.faces[fi].glyphs;
        for (let i = 0; i < g.length; i += TEXT_GLYPH_STRIDE) ids.add(g[i]);
        for (const id of pageGlyphIds(f, p.page)) {
          if (seen.has(id)) continue;
          if (f.outline?.(id)) expect(ids.has(id), `${p.page}/${family} glyph ${id}`).toBe(true);
        }
        for (const id of ids) {
          expect(seen.has(id), `${family} glyph ${id} on two pages`).toBe(false);
          seen.add(id);
        }
      }
      // Nordic and Baltic letters the corpus uses (S1 §5), and Cyrillic.
      const lookup = buildTextGlyphs(pages).lookup;
      for (const ch of "ÄÅÖäåéöŠšŽžĄąĖėЖжЯя") expect(lookup.has(textGlyphKey(family, f.glyphId(ch.codePointAt(0)!))), ch).toBe(true);
      expect(lookup.get(textGlyphKey(family, f.glyphId(0x416)))?.page).toBe(1);
      expect(lookup.get(textGlyphKey(family, f.glyphId(0xc5)))?.page).toBe(0);
    });
  });

  it("have plane bounds around the glyph origin and atlas bounds inside the image", () => {
    for (const p of pages) {
      for (const f of p.faces) {
        const g = f.glyphs;
        for (let i = 0; i < g.length; i += TEXT_GLYPH_STRIDE) {
          const [l, b, r, t, x0, y0, x1, y1] = g.slice(i + 1, i + 9);
          expect(l).toBeLessThan(r);
          expect(b).toBeLessThan(t);
          for (const v of [l, b, r, t]) expect(Math.abs(v)).toBeLessThan(1.5);
          expect(x0).toBeGreaterThanOrEqual(0);
          expect(y0).toBeGreaterThanOrEqual(0);
          expect(x1).toBeLessThanOrEqual(p.width);
          expect(y1).toBeLessThanOrEqual(p.height);
          // Same scale both ways: plane em × emPx = atlas px.
          expect((r - l) * p.emPx).toBeCloseTo(x1 - x0, 2);
          expect((t - b) * p.emPx).toBeCloseTo(y1 - y0, 2);
        }
      }
    }
  });

  it("put the glyph where the outline is: 'H' plane bounds = outline bounds ± half the range", () => {
    const f = font("liberation-sans", "LiberationSans-Regular.ttf");
    const id = f.glyphId(0x48);
    const ob = render.pathBounds(f.outline!(id)!);
    const g = pages[0].faces[0].glyphs;
    let i = 0;
    while (g[i] !== id) i += TEXT_GLYPH_STRIDE;
    const pad = TEXT_ATLAS_RANGE_PX / TEXT_ATLAS_EM_PX / 2;
    const em = f.unitsPerEm;
    // msdf-atlas-gen rounds the box outward to whole atlas pixels.
    const px = 1 / TEXT_ATLAS_EM_PX;
    expect(g[i + 1]).toBeLessThanOrEqual(ob.minX / em - pad + 1e-6);
    expect(g[i + 1]).toBeGreaterThan(ob.minX / em - pad - px);
    expect(g[i + 2]).toBeLessThanOrEqual(ob.minY / em - pad + 1e-6);
    expect(g[i + 2]).toBeGreaterThan(ob.minY / em - pad - px);
    expect(g[i + 3]).toBeGreaterThanOrEqual(ob.maxX / em + pad - 1e-6);
    expect(g[i + 3]).toBeLessThan(ob.maxX / em + pad + px);
    expect(g[i + 4]).toBeGreaterThanOrEqual(ob.maxY / em + pad - 1e-6);
    expect(g[i + 4]).toBeLessThan(ob.maxY / em + pad + px);
  });
});

describe("text atlas build (generator JSON → page)", () => {
  const raw: RawAtlasJson = {
    atlas: { type: "mtsdf", distanceRange: 8, size: 32, width: 64, height: 32, yOrigin: "top" },
    variants: [
      {
        name: "liberation-sans",
        glyphs: [
          { index: 7, advance: 0.5, planeBounds: { left: -0.1, bottom: 0.2, right: 0.6, top: -0.8 }, atlasBounds: { left: 0.5, top: 0.5, right: 22.9, bottom: 32.5 } },
          { index: 3, advance: 0.27 },
        ],
      },
      { name: "liberation-sans-narrow", glyphs: [{ index: 7, advance: 0.4, planeBounds: { left: -0.1, bottom: 0.2, right: 0.5, top: -0.8 }, atlasBounds: { left: 23.5, top: 0.5, right: 42.7, bottom: 32.5 } }] },
    ],
  };
  const faces = [
    { family: "liberation-sans" as const, sha256: "a", unitsPerEm: 2048 },
    { family: "liberation-sans-narrow" as const, sha256: "b", unitsPerEm: 2048 },
  ];

  it("keys glyphs by id, turns plane bounds y-up, keeps atlas px, drops empty glyphs", () => {
    const p = pageFromAtlasJson(raw, "latin", faces);
    expect(p).toMatchObject({ version: 1, page: "latin", width: 64, height: 32, emPx: 32, distanceRangePx: 8 });
    expect(p.faces[0]).toEqual({ ...faces[0], glyphs: [7, -0.1, -0.2, 0.6, 0.8, 0.5, 0.5, 22.9, 32.5] });
    expect(p.faces[1].glyphs).toEqual([7, -0.1, -0.2, 0.5, 0.8, 23.5, 0.5, 42.7, 32.5]);
  });

  it("refuses MSDF-only output, a bottom origin, a font count mismatch and code-point keys", () => {
    expect(() => pageFromAtlasJson({ ...raw, atlas: { ...raw.atlas, type: "msdf" } }, "latin", faces)).toThrow(/mtsdf/);
    expect(() => pageFromAtlasJson({ ...raw, atlas: { ...raw.atlas, yOrigin: "bottom" } }, "latin", faces)).toThrow(/yOrigin/);
    expect(() => pageFromAtlasJson(raw, "latin", faces.slice(0, 1))).toThrow(/2 fonts/);
    const byUnicode = { ...raw, variants: [{ glyphs: [{ unicode: 65, advance: 0.6, planeBounds: { left: 0, bottom: 0, right: 1, top: -1 }, atlasBounds: { left: 0, top: 0, right: 1, bottom: 1 } }] }] };
    expect(() => pageFromAtlasJson(byUnicode, "latin", faces.slice(0, 1))).toThrow(/glyphset/);
  });

  it("page glyph ids: the font's ids for the ranges, ascending, without .notdef", () => {
    const fake = { glyphId: (cp: number) => (cp === 0x41 ? 36 : cp === 0x42 ? 37 : cp === 0x416 ? 500 : 0) };
    expect(pageGlyphIds(fake, "latin")).toEqual([36, 37]);
    expect(pageGlyphIds(fake, "cyrillic")).toEqual([500]);
    expect(glyphsetFile([36, 37])).toBe("36, 37\n");
    expect(TEXT_ATLAS_PAGE_RANGES.latin[0]).toEqual([0x20, 0x7e]);
  });
});

describe("text atlas runtime", () => {
  const page = (name: "latin" | "cyrillic", ids: number[]): TextAtlasPage => ({
    version: 1, page: name, width: 100, height: 50, emPx: 32, distanceRangePx: 8,
    faces: [{ family: "liberation-sans", sha256: "", unitsPerEm: 2048, glyphs: ids.flatMap((id) => [id, -0.1, -0.2, 0.6, 0.8, 10, 5, 30, 25]) }],
  });

  it("numbers entries across pages in order and writes plane, uv and page per entry", () => {
    const { lookup, table, entries } = buildTextGlyphs([page("latin", [5, 9]), page("cyrillic", [700])]);
    expect(entries).toBe(3);
    expect(lookup.get("liberation-sans/9")).toEqual({ entry: 1, page: 0 });
    expect(lookup.get("liberation-sans/700")).toEqual({ entry: 2, page: 1 });
    expect(lookup.has("liberation-sans-narrow/9")).toBe(false);
    expect(table.length).toBe(GLYPH_TABLE_WIDTH * 4);
    const e = 2 * GLYPH_TABLE_TEXELS * 4;
    expect(table.subarray(e, e + 12)).toEqual(Float32Array.of(
      -0.1, -0.2, 0.6, 0.8,
      0.1, 0.1, 0.3, 0.5,
      1, 0.25, 0, 0,
    ));
  });

  it("first page holding a glyph wins", () => {
    expect(buildTextGlyphs([page("latin", [5]), page("cyrillic", [5])]).lookup.get("liberation-sans/5")).toEqual({ entry: 0, page: 0 });
  });

  it("pages for a document: Latin always, Cyrillic only for Cyrillic strings", () => {
    expect(textAtlasPagesFor([])).toEqual(["latin"]);
    expect(textAtlasPagesFor(["Åsa", "Øvre — 5 €"])).toEqual(["latin"]);
    expect(textAtlasPagesFor(["Ok", "Москва"])).toEqual(["latin", "cyrillic"]);
  });

  it("halo in em, clamped to half the distance range", () => {
    expect(haloEm(140, 5600, 0.25)).toEqual({ em: 0.025, clamped: false });
    expect(haloEm(1000, 5600, 0.25)).toEqual({ em: 0.125, clamped: true });
  });

  it("rejects what is not a page", () => {
    expect(() => parseTextAtlasPage({ version: 2 })).toThrow();
    expect(() => parseTextAtlasPage({ ...page("latin", [1]), faces: [{ family: "x", unitsPerEm: 1, glyphs: [1, 2] }] })).toThrow();
    expect(parseTextAtlasPage(page("latin", [1])).page).toBe("latin");
  });
});
