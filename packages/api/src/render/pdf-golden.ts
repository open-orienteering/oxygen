/**
 * The PDF golden tier (docs/course-print.md §9; research 05 §7 tier 3):
 * every golden scene and every page scene written as a PDF page by the
 * print backend, rasterised by `pdftoppm` at the golden density and
 * compared against the reference raster's committed goldens — the third
 * backend after the oracle and WebGL2.
 *
 * Scenes become one page each, the size of their golden frame, the pass
 * stream at 1:1 under the frame's origin. Page scenes go through the
 * composer exactly as the `maps.pdf` route writes them.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { render } from "@oxygen/shared";
import {
  type ColourMode,
  type PageSceneName,
  PdfWriter,
  UM_TO_PT,
  layerMatrix,
  mapLayerOperators,
  rgbToCmykNaive,
  writePage,
} from "@oxygen/shared/print";
import { BUNDLED_FONT_FILES } from "./fonts.js";
import { goldenFonts } from "./golden.js";
import { composePageScene } from "./page-raster.js";

const run = promisify(execFile);

async function faces() {
  return Promise.all(
    (["liberation-sans", "liberation-sans-narrow"] as const).map(async (family) => ({ family, data: new Uint8Array(await readFile(BUNDLED_FONT_FILES[family].path)) })),
  );
}

/** The scene's colours as a stack: the scene's own CMYK where it has one, else its hex back through the naive conversion. */
function sceneStack(stream: render.PassStream, colour: (i: number) => string): { cmyk: [number, number, number, number] }[] {
  let max = -1;
  for (const p of stream.passes) max = Math.max(max, p.colour);
  return Array.from({ length: max + 1 }, (_, i) => ({ cmyk: rgbToCmykNaive(colour(i)) }));
}

export interface GoldenPdf {
  bytes: Uint8Array;
  /** Pixel size of the golden the page is compared against. */
  width: number;
  height: number;
}

/** A golden scene as a one-page PDF covering its golden frame. */
export async function goldenScenePdf(
  name: render.GoldenSceneName,
  mode: ColourMode,
  opts: { text?: "font" | "outline" } = {},
): Promise<GoldenPdf> {
  const scene = render.goldenScene(name, await goldenFonts());
  const { bounds, width, height } = render.goldenFrame(scene.stream);
  const writer = await PdfWriter.create({ faces: await faces(), deterministic: true, info: { title: name }, text: opts.text });
  const page = writer.addPage({ widthPt: (bounds.maxX - bounds.minX) * UM_TO_PT, heightPt: (bounds.maxY - bounds.minY) * UM_TO_PT });
  page.addContent(
    mapLayerOperators(scene.stream, {
      colours: sceneStack(scene.stream, scene.colour),
      mode,
      resources: page.resources,
      matrix: layerMatrix({ scaleRatio: 1, atPt: [-bounds.minX * UM_TO_PT, -bounds.minY * UM_TO_PT] }),
    }),
  );
  return { bytes: await writer.save(), width, height };
}

/** A page scene as the route writes it: composer → `writePage`. */
export async function pageScenePdf(name: PageSceneName, mode: ColourMode): Promise<GoldenPdf> {
  const page = await composePageScene(name);
  const writer = await PdfWriter.create({ faces: await faces(), deterministic: true, info: { title: name } });
  await writePage(writer, page, { mode });
  return {
    bytes: await writer.save(),
    width: Math.round(page.paper.widthMm * render.GOLDEN_PX_PER_MM),
    height: Math.round(page.paper.heightMm * render.GOLDEN_PX_PER_MM),
  };
}

/** Is a command-line tool on the PATH? */
export async function hasTool(cmd: "pdftoppm" | "qpdf"): Promise<boolean> {
  try {
    await run(cmd, ["--version"]);
    return true;
  } catch (err) {
    // pdftoppm -v exits non-zero on some versions but prints its version.
    return (err as { code?: unknown }).code !== "ENOENT";
  }
}

/** `qpdf --check`; resolves with its output, rejects with it when the file is damaged (exit 2) or warns (exit 3). */
export async function qpdfCheck(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oxygen-qpdf-"));
  try {
    const file = join(dir, "in.pdf");
    await writeFile(file, bytes);
    const { stdout } = await run("qpdf", ["--check", file]);
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface PdftoppmOptions {
  /** Poppler's Splash rasteriser (`pdftoppm`, default) or its Cairo one (`pdftocairo`). */
  backend?: "splash" | "cairo";
  /** `pdftocairo -antialias`. */
  /** Rasterise at this multiple and box-filter down (as the oracle's `supersample`). */
  supersample?: number;
  antialias?: "default" | "none" | "gray" | "subpixel" | "fast" | "good" | "best";
  /** `-aaVector no`: poppler's vector anti-aliasing off. */
  aaVector?: boolean;
  /** `-thinlinemode`. */
  thinLineMode?: "none" | "solid" | "shape";
}

/** First page of a PDF as RGBA at exactly `width × height` px (`pdftoppm -scale-to-x/-y`). */
export async function rasterisePdf(
  bytes: Uint8Array,
  width: number,
  height: number,
  opts: PdftoppmOptions = {},
): Promise<{ width: number; height: number; pixels: Uint8Array }> {
  const k = opts.supersample ?? 1;
  if (k > 1) return boxDown(await rasterisePdf(bytes, width * k, height * k, { ...opts, supersample: 1 }), k);
  const dir = await mkdtemp(join(tmpdir(), "oxygen-pdftoppm-"));
  try {
    const file = join(dir, "in.pdf");
    await writeFile(file, bytes);
    const cairo = opts.backend === "cairo";
    const args = ["-png", "-singlefile", "-f", "1", "-l", "1", "-scale-to-x", String(width), "-scale-to-y", String(height)];
    if (cairo && opts.antialias) args.push("-antialias", opts.antialias);
    if (!cairo && opts.aaVector === false) args.push("-aaVector", "no");
    if (!cairo && opts.thinLineMode) args.push("-thinlinemode", opts.thinLineMode);
    await run(cairo ? "pdftocairo" : "pdftoppm", [...args, file, join(dir, "out")], { maxBuffer: 1 << 26 });
    const sharp = (await import("sharp")).default;
    // Cairo sizes the raster with ceil(): a page of 200.000001 px comes out 201 wide. The extra column is page-less margin.
    const meta = await sharp(join(dir, "out.png")).metadata();
    const img = sharp(join(dir, "out.png"));
    if ((meta.width ?? 0) > width || (meta.height ?? 0) > height) img.extract({ left: 0, top: 0, width, height });
    const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function boxDown(img: { width: number; height: number; pixels: Uint8Array }, k: number) {
  const width = img.width / k, height = img.height / k;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) sum += img.pixels[((y * k + dy) * img.width + x * k + dx) * 4 + c];
        pixels[(y * width + x) * 4 + c] = Math.round(sum / (k * k));
      }
  return { width, height, pixels };
}
