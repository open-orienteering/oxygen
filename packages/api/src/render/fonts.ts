/**
 * Loads the fonts bundled with `@oxygen/shared` (`packages/shared/fonts/`)
 * for the server-side backends: outlines for the reference raster, and
 * later embedding in the PDF backend. Parsed once per process.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { render } from "@oxygen/shared";

interface BundledFace { family: render.FontFamily; bold: boolean; file: string; /** The `name` table's family, as resvg sees it. */ resvgFamily: string }

/** The bundled faces, regular first; a family's bold face follows the regular ones. */
const FACES: BundledFace[] = [
  { family: "liberation-sans", bold: false, file: "LiberationSans-Regular.ttf", resvgFamily: "Liberation Sans" },
  { family: "liberation-sans-narrow", bold: false, file: "LiberationSansNarrow-Regular.ttf", resvgFamily: "Liberation Sans Narrow" },
  { family: "liberation-sans", bold: true, file: "LiberationSans-Bold.ttf", resvgFamily: "Liberation Sans" },
];

const fontsDir = fileURLToPath(new URL("../../../shared/fonts/", import.meta.url));
const cache = new Map<BundledFace, Promise<render.TrueTypeFont>>();

/** The bundled families as resvg sees them: file path and the `name` table's family (the regular faces). */
export const BUNDLED_FONT_FILES: Record<"liberation-sans" | "liberation-sans-narrow", { path: string; family: string }> = {
  "liberation-sans": { path: fontsDir + "LiberationSans-Regular.ttf", family: "Liberation Sans" },
  "liberation-sans-narrow": { path: fontsDir + "LiberationSansNarrow-Regular.ttf", family: "Liberation Sans Narrow" },
};

/** Every bundled face's file, for the PDF writer's `faces` and resvg's `fontFiles`. */
export const BUNDLED_FACE_FILES: readonly { family: render.FontFamily; bold: boolean; path: string }[] = FACES.map((f) => ({ family: f.family, bold: f.bold, path: fontsDir + f.file }));

function loadFace(face: BundledFace): Promise<render.TrueTypeFont> {
  let p = cache.get(face);
  if (!p) {
    p = readFile(fontsDir + face.file).then((buf) => {
      const copy = new ArrayBuffer(buf.byteLength);
      new Uint8Array(copy).set(buf);
      return render.parseTrueType(copy, face.family);
    });
    cache.set(face, p);
  }
  return p;
}

/** One bundled face (the regular one unless `bold`); rejects when the family has no such face. */
export function loadBundledFont(family: render.FontFamily, bold = false): Promise<render.TrueTypeFont> {
  const face = FACES.find((f) => f.family === family && f.bold === bold);
  return face ? loadFace(face) : Promise.reject(new Error(`no bundled ${bold ? "bold " : ""}font for ${family}`));
}

/** All bundled faces, in the order `symbolise` prefers them (regular before bold). */
export function loadBundledFonts(): Promise<render.TrueTypeFont[]> {
  return Promise.all(FACES.map(loadFace));
}

/** The PDF writer's `faces` option: every bundled face's bytes. */
export async function bundledPdfFaces(): Promise<{ family: render.FontFamily; data: Uint8Array }[]> {
  return Promise.all(BUNDLED_FACE_FILES.map(async (f) => ({ family: f.family, data: new Uint8Array(await readFile(f.path)) })));
}

/** Glyph-outline callback for `passStreamToSvg`, over a set of loaded fonts. */
export function glyphOutlineFrom(fonts: render.TrueTypeFont[]): NonNullable<render.ReferenceSvgOptions["glyphOutline"]> {
  return (ref, glyphId) => {
    const font = fonts.find((f) => f.family === ref.family && !!f.bold === ref.bold && !!f.italic === ref.italic) ?? fonts.find((f) => f.family === ref.family);
    const path = font?.outline(glyphId);
    return font && path ? { path, unitsPerEm: font.unitsPerEm } : undefined;
  };
}
