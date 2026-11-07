/**
 * Description sheets (docs/course-print.md §6.4; research 08 §4.6
 * "Control-description sheets"): the map page's description block
 * (`descriptionBlock()`, §6.2) tiled on A4 portrait, so many copies print
 * on one sheet and are cut apart for the start.
 *
 * - `tileDescriptionSheets` is pure: blocks per class (or course), copies
 *   by the mode, a grid from the block's size, the margin and the gap;
 *   pages never mix two classes, so each page is labelled by one.
 * - `composeDescriptionPage` / `writeDescriptionPage` draw one page: the
 *   blocks through one `symbolise` in page µm (y-up), then the white
 *   sheet and the page-layer operators on a writer page — `writePage`'s
 *   page-layer lines without a frame or map layer. One `PdfWriter` for
 *   the document shares the pictogram forms and font subsets (05 §5.10).
 *
 * Isomorphic like the rest of `@oxygen/shared/print`.
 */

import { withObjectColours } from "../course/colour-stack.js";
import { type DescriptionRow, type DescriptionSheetHeader, descriptionBlockSize } from "../course-maps/description-rows.js";
import type { DocumentColour } from "../map-document/header.js";
import type { PassStream } from "../render/pass-stream.js";
import type { RenderSymbol } from "../render/symbol.js";
import type { RenderObject } from "../render/symbolise.js";
import { symbolise } from "../render/symbolise.js";
import type { FontMetrics } from "../render/truetype.js";
import { type ColourMode, colourOperator, pageColour } from "./colour.js";
import { type DescriptionBlockInput, descriptionBlock } from "./description.js";
import { UM_TO_PT, fmtMm, mapLayerOperators } from "./operators.js";
import type { PageWarning } from "./page.js";
import type { PdfWriter } from "./writer.js";

/** A4 portrait, mm. */
export const DESCRIPTION_SHEET_PAPER = { widthMm: 210, heightMm: 297 } as const;
/** The sheet's margin on every side, mm. */
export const DESCRIPTION_SHEET_MARGIN_MM = 10;
/** The cell sizes offered (08 §4.6: 5–7 mm). */
export const DESCRIPTION_SHEET_CELLS = [5, 6, 7] as const;
export type DescriptionSheetCell = (typeof DESCRIPTION_SHEET_CELLS)[number];
/** Default space between two blocks, mm. */
export const DESCRIPTION_SHEET_DEFAULT_GAP_MM = 5;

/** `count`: the class's runners + vacancies; `fill`: one sheet's worth; a number: that many. */
export type DescriptionCopies = "count" | "fill" | number;

/** One class's (or course's) block and how many runners it is for. */
export interface DescriptionSheetBlock {
  /** Page label and outline title of this block's pages (class or course name). */
  label: string;
  rows: DescriptionRow[];
  /** Three-row IOF header; null → one title row. */
  header: DescriptionSheetHeader | null;
  title: string;
  /** Runners + vacancies (the `count` mode's copies). */
  count: number;
}

export interface DescriptionSheetOptions {
  cellSizeMm: number;
  gapMm: number;
  copies: DescriptionCopies;
  /** Default A4 portrait. */
  paper?: { widthMm: number; heightMm: number };
  /** Default 10 mm. */
  marginMm?: number;
}

export interface DescriptionSheetPage {
  paper: { widthMm: number; heightMm: number };
  label: string;
  /** Block inputs with their top-left corner in page mm (y-down), in reading order. */
  blocks: DescriptionBlockInput[];
}

/** A block that does not fit the usable page at this cell size. */
export class DescriptionTooTallError extends Error {
  constructor(
    readonly label: string,
    readonly cellSizeMm: number,
  ) {
    super(`DESCRIPTION_TOO_TALL: the description of ${label} does not fit an A4 page at ${cellSizeMm} mm cells`);
    this.name = "DescriptionTooTallError";
  }
}

/** The block's size in mm (8 cells wide; rows plus the header's 3 or the title's 1). */
const blockSize = (block: DescriptionSheetBlock, cellSizeMm: number) => {
  const { width, height } = descriptionBlockSize(block.rows.length, cellSizeMm, block.header ? 3 : 1);
  return { widthMm: width, heightMm: height };
};

/** Columns and rows of blocks on the usable page; 0 when the block does not fit. */
export function descriptionGrid(
  block: { widthMm: number; heightMm: number },
  opts: { paper?: { widthMm: number; heightMm: number }; marginMm?: number; gapMm: number },
): { columns: number; rows: number; perPage: number } {
  const paper = opts.paper ?? DESCRIPTION_SHEET_PAPER;
  const margin = opts.marginMm ?? DESCRIPTION_SHEET_MARGIN_MM;
  const fit = (usable: number, size: number) => Math.max(0, Math.floor((usable + opts.gapMm + 1e-9) / (size + opts.gapMm)));
  const columns = fit(paper.widthMm - 2 * margin, block.widthMm);
  const rows = fit(paper.heightMm - 2 * margin, block.heightMm);
  return { columns, rows, perPage: columns * rows };
}

/** Copies of one block under the mode: `count` floors at 1 (a class with nobody still prints a proof). */
export function descriptionCopies(copies: DescriptionCopies, count: number, perPage: number): number {
  if (copies === "count") return Math.max(1, count);
  if (copies === "fill") return perPage;
  return copies;
}

/**
 * The pages of a description-sheet document: per block, in the order
 * given, its copies placed row-major from the top-left inside the margin;
 * a new block starts a new page. Throws `DescriptionTooTallError` when a
 * block does not fit at all.
 */
export function tileDescriptionSheets(blocks: readonly DescriptionSheetBlock[], opts: DescriptionSheetOptions): DescriptionSheetPage[] {
  const paper = opts.paper ?? DESCRIPTION_SHEET_PAPER;
  const margin = opts.marginMm ?? DESCRIPTION_SHEET_MARGIN_MM;
  const pages: DescriptionSheetPage[] = [];
  for (const block of blocks) {
    const size = blockSize(block, opts.cellSizeMm);
    const grid = descriptionGrid(size, { paper, marginMm: margin, gapMm: opts.gapMm });
    if (grid.perPage === 0) throw new DescriptionTooTallError(block.label, opts.cellSizeMm);
    const n = descriptionCopies(opts.copies, block.count, grid.perPage);
    let page: DescriptionSheetPage | null = null;
    for (let i = 0; i < n; i++) {
      const slot = i % grid.perPage;
      if (slot === 0) {
        page = { paper: { ...paper }, label: block.label, blocks: [] };
        pages.push(page);
      }
      const col = slot % grid.columns, row = Math.floor(slot / grid.columns);
      page!.blocks.push({
        x: margin + col * (size.widthMm + opts.gapMm),
        y: margin + row * (size.heightMm + opts.gapMm),
        cellSizeMm: opts.cellSizeMm,
        rows: block.rows,
        header: block.header,
        title: block.title,
      });
    }
  }
  return pages;
}

/** Pages a request would produce, without placing blocks (the route's page cap). */
export function countDescriptionPages(blocks: readonly DescriptionSheetBlock[], opts: DescriptionSheetOptions): number {
  let total = 0;
  for (const block of blocks) {
    const size = blockSize(block, opts.cellSizeMm);
    const grid = descriptionGrid(size, { ...(opts.paper ? { paper: opts.paper } : {}), ...(opts.marginMm !== undefined ? { marginMm: opts.marginMm } : {}), gapMm: opts.gapMm });
    if (grid.perPage === 0) throw new DescriptionTooTallError(block.label, opts.cellSizeMm);
    total += Math.ceil(descriptionCopies(opts.copies, block.count, grid.perPage) / grid.perPage);
  }
  return total;
}

export interface ComposedDescriptionPage {
  paper: { widthMm: number; heightMm: number };
  label: string;
  /** White, then the ink: the stream indexes it. */
  colours: DocumentColour[];
  /** Page µm, y-up. */
  stream: PassStream;
  warnings: PageWarning[];
}

/** One page's blocks as one pass stream (page µm, y-up), as `pageLayer` draws a sheet's block. */
export function composeDescriptionPage(page: DescriptionSheetPage, fonts: FontMetrics[]): ComposedDescriptionPage {
  const palette = withObjectColours([], ["#ffffff", ...new Set(page.blocks.map((b) => b.colour ?? "#000000"))]);
  const symbols: RenderSymbol[] = [];
  const objects: RenderObject[] = [];
  for (const input of page.blocks) {
    const block = descriptionBlock(input, page.paper.heightMm, palette.indexOf);
    const offset = symbols.length;
    symbols.push(...block.symbols);
    for (const o of block.objects) objects.push({ ...o, symbolIdx: o.symbolIdx + offset });
  }
  const out = symbolise({ objects, symbols, fonts });
  return {
    paper: page.paper,
    label: page.label,
    colours: palette.colours,
    stream: out.stream,
    warnings: out.warnings.map((w) => ({ code: w.code, message: `description sheet: ${w.message}` })),
  };
}

/**
 * One composed page onto a new writer page: the white sheet, then the
 * blocks under µm → pt (`writePage`'s page layer), labelled and in the
 * outline by its class.
 */
export function writeDescriptionPage(writer: PdfWriter, page: ComposedDescriptionPage, opts: { mode: ColourMode }): void {
  const W = page.paper.widthMm * (72 / 25.4), H = page.paper.heightMm * (72 / 25.4);
  const wp = writer.addPage({ widthPt: W, heightPt: H, label: page.label, outlineTitle: page.label });
  wp.addContent(
    [
      `${colourOperator(pageColour("#ffffff", opts.mode), "fill")} 0 0 ${fmtMm(W)} ${fmtMm(H)} re f`,
      mapLayerOperators(page.stream, { colours: page.colours, mode: opts.mode, resources: wp.resources, matrix: [UM_TO_PT, 0, 0, UM_TO_PT, 0, 0] }),
    ].join("\n"),
  );
}
