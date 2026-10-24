/**
 * The PDF golden tier (docs/course-print.md §9; research 05 §7 tier 3):
 * every golden scene and every page scene written as a PDF page by the
 * print backend, rasterised by poppler at the golden density and compared
 * against the reference raster — the third backend after the oracle and
 * WebGL2.
 *
 * Scenes become one page each, the size of their golden frame, the pass
 * stream at 1:1 under the frame's origin. Page scenes go through the
 * composer exactly as the `maps.pdf` route writes them.
 *
 * The rasteriser is `pdftocairo` (poppler-utils), supersampled like the
 * oracle and box-filtered down: poppler's Splash rasteriser (`pdftoppm`)
 * snaps fills and hairlines to the pixel grid (stroke adjustment) and
 * puts 0.4–5 % of the pixels of geometry-exact streams beyond the
 * channel tolerance; Cairo agrees with the oracle to ≤ 0.036 % on every
 * non-text scene (measured C3, 2026-10-24).
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { render } from "@oxygen/shared";
import {
  type ColourMode,
  type ComposedPage,
  type PageSceneName,
  PdfWriter,
  UM_TO_PT,
  layerMatrix,
  mapLayerOperators,
  rgbToCmykNaive,
  writePage,
} from "@oxygen/shared/print";
import { bundledPdfFaces } from "./fonts.js";
import { GOLDEN_SUPERSAMPLE, goldenFonts } from "./golden.js";
import { PAGE_GOLDEN_SUPERSAMPLE, type PageRaster, composePageScene, rasterisePage } from "./page-raster.js";
import { rasterisePassStream } from "./reference-raster.js";

/** RGBA, top row first — what `diffImages` compares. */
export type Pixels = PageRaster;

const run = promisify(execFile);

type Cmyk = [number, number, number, number];

async function faces() {
  return bundledPdfFaces();
}

/**
 * A scene's colours as a stack: the scene's hex back through the naive
 * conversion — exact for the library and course scenes (their hex is
 * `cmykToHex` of the stack) and the only CMYK the hex-only fixtures have.
 */
function sceneStack(stream: render.PassStream, colour: (i: number) => string): { cmyk: Cmyk }[] {
  let max = -1;
  for (const p of stream.passes) max = Math.max(max, p.colour);
  return Array.from({ length: max + 1 }, (_, i) => ({ cmyk: rgbToCmykNaive(colour(i)) }));
}

export interface GoldenPdf {
  bytes: Uint8Array;
  /** Pixel size of the golden the page is compared against. */
  width: number;
  height: number;
  /** The stack the page was written with, by pass colour index. */
  colours: { cmyk: Cmyk }[];
  /** Whether the page draws text passes (embedded fonts unless `text: "outline"`). */
  hasText: boolean;
}

/** A golden scene as a one-page PDF covering its golden frame. */
export async function goldenScenePdf(
  name: render.GoldenSceneName,
  mode: ColourMode,
  opts: { text?: "font" | "outline" } = {},
): Promise<GoldenPdf> {
  const scene = render.goldenScene(name, await goldenFonts());
  const { bounds, width, height } = render.goldenFrame(scene.stream);
  const colours = sceneStack(scene.stream, scene.colour);
  const writer = await PdfWriter.create({ faces: await faces(), deterministic: true, info: { title: name }, text: opts.text });
  const page = writer.addPage({ widthPt: (bounds.maxX - bounds.minX) * UM_TO_PT, heightPt: (bounds.maxY - bounds.minY) * UM_TO_PT });
  page.addContent(
    mapLayerOperators(scene.stream, {
      colours,
      mode,
      resources: page.resources,
      matrix: layerMatrix({ scaleRatio: 1, atPt: [-bounds.minX * UM_TO_PT, -bounds.minY * UM_TO_PT] }),
    }),
  );
  return { bytes: await writer.save(), width, height, colours, hasText: scene.stream.passes.some((p) => p.kind === "text") };
}

/** A page scene as the route writes it: composer → `writePage`. */
export async function pageScenePdf(name: PageSceneName, mode: ColourMode, page?: ComposedPage): Promise<GoldenPdf> {
  const composed = page ?? (await composePageScene(name));
  const writer = await PdfWriter.create({ faces: await faces(), deterministic: true, info: { title: name } });
  await writePage(writer, composed, { mode });
  return {
    bytes: await writer.save(),
    width: Math.round(composed.paper.widthMm * render.GOLDEN_PX_PER_MM),
    height: Math.round(composed.paper.heightMm * render.GOLDEN_PX_PER_MM),
    colours: composed.colours.map((c) => ({ cmyk: c.cmyk })),
    hasText: [composed.mapLayer.stream, composed.pageLayer.stream].some((s) => s.passes.some((p) => p.kind === "text")),
  };
}

/** Is a command-line tool on the PATH? */
export async function hasTool(cmd: "pdftocairo" | "qpdf"): Promise<boolean> {
  try {
    await run(cmd, ["-v"]);
    return true;
  } catch (err) {
    // `pdftocairo -v` exits non-zero on older poppler but still runs.
    return (err as { code?: unknown }).code !== "ENOENT";
  }
}

/** `qpdf --check`; resolves with its report, rejects when the file is damaged (exit 2) or has warnings (exit 3). */
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

/**
 * First page of a PDF as RGBA at exactly `width × height` px:
 * `pdftocairo` at `supersample ×` that size, box-filtered down as the
 * oracle's own supersampling is.
 */
export async function rasterisePdf(bytes: Uint8Array, width: number, height: number, supersample = 1): Promise<Pixels> {
  const k = Math.max(1, Math.round(supersample));
  const dir = await mkdtemp(join(tmpdir(), "oxygen-pdfraster-"));
  try {
    const file = join(dir, "in.pdf");
    await writeFile(file, bytes);
    const [w, h] = [width * k, height * k];
    await run("pdftocairo", ["-png", "-singlefile", "-f", "1", "-l", "1", "-scale-to-x", String(w), "-scale-to-y", String(h), file, join(dir, "out")], { maxBuffer: 1 << 26 });
    const sharp = (await import("sharp")).default;
    // Cairo sizes the raster with ceil(): a page of 200.000001 px comes out
    // 201 wide. The extra row / column is beyond the page edge.
    const out = sharp(join(dir, "out.png"));
    const meta = await out.metadata();
    if ((meta.width ?? 0) > w || (meta.height ?? 0) > h) out.extract({ left: 0, top: 0, width: w, height: h });
    const { data, info } = await out.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const img = { width: info.width, height: info.height, pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    return k === 1 ? img : boxDown(img, k);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Average every `k × k` block (the oracle's supersample filter). */
export function boxDown(img: Pixels, k: number): Pixels {
  const width = img.width / k, height = img.height / k;
  const pixels = new Uint8Array(width * height * 4);
  const n = k * k;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) sum += img.pixels[((y * k + dy) * img.width + x * k + dx) * 4 + c];
        pixels[(y * width + x) * 4 + c] = Math.round(sum / n);
      }
  return { width, height, pixels };
}

const hex2 = (v: number) => v.toString(16).padStart(2, "0");

/**
 * How the rasteriser turns each DeviceCMYK colour into RGB: one 5 mm
 * swatch per colour, read back at its centre. Poppler's conversion is not
 * the shared naive one (purple, brown and green differ by up to ~100
 * levels per channel), so the `cmyk` tier compares against the oracle
 * drawn in these colours — the naive-conversion comparison of 05 §7 with
 * the conversion made explicit instead of a loose channel tolerance.
 */
export async function rasteriserCmykColours(cmyks: Cmyk[]): Promise<string[]> {
  if (cmyks.length === 0) return [];
  const MM = 72 / 25.4;
  const writer = await PdfWriter.create({ deterministic: true });
  const page = writer.addPage({ widthPt: cmyks.length * 5 * MM, heightPt: 5 * MM });
  page.addContent(cmyks.map(([c, m, y, k], i) => `${c} ${m} ${y} ${k} k ${(i * 5 * MM).toFixed(4)} 0 ${(5 * MM).toFixed(4)} ${(5 * MM).toFixed(4)} re f`).join("\n"));
  const img = await rasterisePdf(await writer.save(), cmyks.length * 50, 50);
  return cmyks.map((_, i) => {
    const o = (25 * img.width + i * 50 + 25) * 4;
    return `#${hex2(img.pixels[o])}${hex2(img.pixels[o + 1])}${hex2(img.pixels[o + 2])}`;
  });
}

/** The scene oracle drawn in other colours (the golden is the same call with the scene's own). */
export async function goldenOracle(name: render.GoldenSceneName, colour: (i: number) => string): Promise<Pixels> {
  const fonts = await goldenFonts();
  const scene = render.goldenScene(name, fonts);
  const { bounds } = render.goldenFrame(scene.stream);
  const { glyphOutlineFrom } = await import("./fonts.js");
  return rasterisePassStream(scene.stream, { colour, bounds, pxPerMm: render.GOLDEN_PX_PER_MM, glyphOutline: glyphOutlineFrom(fonts), supersample: GOLDEN_SUPERSAMPLE });
}

/** The page oracle drawn in other colours. */
export async function pageOracle(page: ComposedPage, colour: (i: number) => string): Promise<Pixels> {
  return rasterisePage(page, { supersample: PAGE_GOLDEN_SUPERSAMPLE, colour });
}
