/**
 * Loads the fonts bundled with `@oxygen/shared` (`packages/shared/fonts/`)
 * for the server-side backends: outlines for the reference raster, and
 * later embedding in the PDF backend. Parsed once per process.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { render } from "@oxygen/shared";

const FILES: Record<render.FontFamily, string | undefined> = {
  "liberation-sans": "LiberationSans-Regular.ttf",
  "liberation-sans-narrow": "LiberationSansNarrow-Regular.ttf",
  "liberation-serif": undefined,
  "liberation-mono": undefined,
};

const fontsDir = fileURLToPath(new URL("../../../shared/fonts/", import.meta.url));
const cache = new Map<render.FontFamily, Promise<render.TrueTypeFont>>();

/** The bundled families as resvg sees them: file path and the `name` table's family. */
export const BUNDLED_FONT_FILES: Record<"liberation-sans" | "liberation-sans-narrow", { path: string; family: string }> = {
  "liberation-sans": { path: fontsDir + "LiberationSans-Regular.ttf", family: "Liberation Sans" },
  "liberation-sans-narrow": { path: fontsDir + "LiberationSansNarrow-Regular.ttf", family: "Liberation Sans Narrow" },
};

export function loadBundledFont(family: render.FontFamily): Promise<render.TrueTypeFont> {
  let p = cache.get(family);
  if (!p) {
    const file = FILES[family];
    if (!file) return Promise.reject(new Error(`no bundled font for ${family}`));
    p = readFile(fontsDir + file).then((buf) => {
      const copy = new ArrayBuffer(buf.byteLength);
      new Uint8Array(copy).set(buf);
      return render.parseTrueType(copy, family);
    });
    cache.set(family, p);
  }
  return p;
}

/** Glyph-outline callback for `passStreamToSvg`, over a set of loaded fonts. */
export function glyphOutlineFrom(fonts: render.TrueTypeFont[]): NonNullable<render.ReferenceSvgOptions["glyphOutline"]> {
  return (ref, glyphId) => {
    const font = fonts.find((f) => f.family === ref.family);
    const path = font?.outline(glyphId);
    return font && path ? { path, unitsPerEm: font.unitsPerEm } : undefined;
  };
}
