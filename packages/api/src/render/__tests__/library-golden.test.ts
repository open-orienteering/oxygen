/**
 * The library contact sheet (`e2e/__golden__/library/`, docs/map-symbols.md
 * §6 (d)) must be what the swatch renderer draws today: one PNG per entry
 * of each library, nothing else, and an index page equal to the
 * generator's. A change to an entry or to the symbolisation stage fails
 * here until `pnpm --filter @oxygen/api golden:render` is re-run, so the
 * PR shows the change as image diffs.
 */

import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { symbolLibrary } from "@oxygen/shared";
import { LIBRARY_GOLDEN_IDS, libraryGoldenDir, libraryGoldenFile, librarySheetMarkdown, renderLibraryGoldens } from "../golden.js";
import { renderSwatchPng, stackColour } from "../previews.js";
import { diffImages } from "../reference-raster.js";

async function decode(png: Buffer): Promise<{ width: number; height: number; pixels: Uint8Array }> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

const STALE = "run pnpm --filter @oxygen/api golden:render";

describe("library contact sheet", () => {
  it("covers both libraries", () => {
    expect(LIBRARY_GOLDEN_IDS).toEqual(symbolLibrary.listSymbolLibraries().map((l) => l.id));
  });

  it("file names are the entry id after the library prefix, unique per library", () => {
    expect(libraryGoldenFile({ id: "ISOM2017-2:302.b" })).toBe("302.b.png");
    expect(libraryGoldenFile({ id: "ISSprOM2019-2:501.1" })).toBe("501.1.png");
    for (const id of LIBRARY_GOLDEN_IDS) {
      const files = symbolLibrary.getSymbolLibrary(id).entries.map(libraryGoldenFile);
      expect(new Set(files).size).toBe(files.length);
    }
  });

  for (const id of LIBRARY_GOLDEN_IDS) {
    describe(id, () => {
      const dir = new URL(`${id}/`, libraryGoldenDir);

      it("has exactly one committed PNG per entry", async () => {
        const committed = (await readdir(fileURLToPath(dir))).filter((f) => f.endsWith(".png")).sort();
        const expected = symbolLibrary.getSymbolLibrary(id).entries.map(libraryGoldenFile).sort();
        expect(committed, STALE).toEqual(expected);
      });

      it("every committed PNG equals a fresh swatch render", async () => {
        const stale: string[] = [];
        for (const g of await renderLibraryGoldens(id)) {
          const committed = await decode(await readFile(new URL(g.file, dir)).catch(() => Buffer.alloc(0))).catch(() => null);
          const current = await decode(g.png);
          if (!committed || committed.width !== current.width || committed.height !== current.height) {
            stale.push(`${g.file} (size)`);
            continue;
          }
          // Lossless PNG: allow nothing beyond rounding (the golden-files.test.ts rule).
          const d = diffImages(committed, current, 1);
          if (d.differing > 0) stale.push(`${g.file} (${d.differing} px)`);
        }
        expect(stale, `stale library goldens — ${STALE}`).toEqual([]);
      }, 60_000);

      it("the index page equals the generator's", async () => {
        const committed = await readFile(new URL(`${id}.md`, libraryGoldenDir), "utf8");
        expect(committed, STALE).toBe(librarySheetMarkdown(id));
      });

      it("the index lists every entry once, with its swatch path", () => {
        const md = librarySheetMarkdown(id);
        for (const e of symbolLibrary.getSymbolLibrary(id).entries) {
          expect(md.split(`](${id}/${libraryGoldenFile(e)})`).length - 1, e.id).toBe(1);
        }
      });
    });
  }

  it("rendering is deterministic: the same entry twice gives the same bytes", async () => {
    // One entry of each IR type: point, line (dashes + glyphs), area (pattern), text.
    const pick = ["ISOM2017-2:204", "ISOM2017-2:516", "ISOM2017-2:409", "ISOM2017-2:704", "ISSprOM2019-2:532", "ISSprOM2019-2:520"];
    for (const entryId of pick) {
      const libId = entryId.slice(0, entryId.indexOf(":")) as symbolLibrary.SymbolLibraryId;
      const { library, colours, symbols } = symbolLibrary.materialiseLibrary(libId);
      const i = library.entries.findIndex((e) => e.id === entryId);
      expect(i, entryId).toBeGreaterThanOrEqual(0);
      const a = await renderSwatchPng(symbols[i], stackColour(colours));
      const b = await renderSwatchPng(symbols[i], stackColour(colours));
      expect(Buffer.compare(a, b), entryId).toBe(0);
    }
  });
});
