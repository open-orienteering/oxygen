import type { ControlDescription } from "../types.js";
import { escapeSvgText } from "./text.js";
import {
  descriptionCells,
  ocadDescriptionCodeToIof,
  type DescriptionCell,
} from "./iof-symbols.js";
import {
  DESCRIPTION_THICK_COLUMNS,
  hasThickRuleBelow,
  type DescriptionSheetRow,
} from "./description-rows.js";

export type IofSymbolResolver = (iofKey: string) => string | null | undefined;

export interface DescriptionRow {
  sequence?: number;
  code: string;
  description?: ControlDescription | null;
  /**
   * Row kind from `description-rows.ts`. Absent / "control" draws a
   * normal A–H row; "start" draws the triangle in A; "special" and
   * "finish" draw `symbolKey` across the full width with `lengthM`.
   */
  kind?: "start" | "control" | "special" | "finish";
  symbolKey?: string;
  lengthM?: number;
}

export interface RenderDescriptionBlockOptions {
  x: number;
  y: number;
  cellSizeMm: number;
  title: string;
  rows: DescriptionRow[];
  symbolResolver: IofSymbolResolver;
  color?: string;
  /**
   * When set, draw the full IOF header (event / classes / course·length·climb)
   * instead of a single title row. `title` is ignored in that mode; use
   * `header` fields instead. Special / finish rows can be mixed into
   * `rows` via `kind: "special" | "finish" | "start"` on an extended row
   * type — see `description-rows.ts`.
   */
  header?: {
    eventName: string;
    classNames: string;
    courseName: string;
    lengthKm: string;
    climbM: string;
  };
}

export { ocadDescriptionCodeToIof };

function renderCellContent(
  x: number,
  y: number,
  size: number,
  cell: DescriptionCell | null,
  color: string,
): string {
  if (!cell) return "";
  if (cell.kind === "text") {
    return `<text x="${x + size / 2}" y="${y + size * 0.67}" font-size="${size * 0.34}" text-anchor="middle" fill="${color}">${escapeSvgText(cell.text)}</text>`;
  }
  const inset = size * 0.1;
  const colored = cell.svg.replace(/ stroke-width="null"/g, "");
  return `<svg x="${x + inset}" y="${y + inset}" width="${size - inset * 2}" height="${size - inset * 2}" viewBox="-100 -100 200 200" preserveAspectRatio="xMidYMid meet">${colored}</svg>`;
}

function renderCellSymbol(
  x: number,
  y: number,
  size: number,
  key: string | null,
  resolver: IofSymbolResolver,
  color: string,
): string {
  if (!key) return "";
  const fragment = resolver(key);
  if (!fragment) return "";
  const colored = fragment
    .replace(/stroke="black"/g, `stroke="${color}"`)
    .replace(/fill="black"/g, `fill="${color}"`)
    .replace(/ stroke-width="null"/g, "");
  const inset = size * 0.1;
  return `<svg x="${x + inset}" y="${y + inset}" width="${size - inset * 2}" height="${size - inset * 2}" viewBox="-100 -100 200 200" preserveAspectRatio="xMidYMid meet">${colored}</svg>`;
}

export function descriptionBlockSize(
  rowCount: number,
  cellSizeMm: number,
  headerRows = 1,
): { width: number; height: number } {
  return {
    width: cellSizeMm * 8,
    height: cellSizeMm * (rowCount + headerRows),
  };
}

export function renderDescriptionBlockSvg(
  options: RenderDescriptionBlockOptions,
): string {
  const { x, y, cellSizeMm: cell, rows } = options;
  const color = options.color ?? "#000000";
  const headerRows = options.header ? 3 : 1;
  const size = descriptionBlockSize(rows.length, cell, headerRows);
  // IOF sheet rules: thick outer border and header cells, thick rule
  // under the start row and above the finish row (so the control rows
  // are boxed in), thick verticals after columns C and F (A B C | D E F
  // | G H). Everything else thin. Header text is bold throughout.
  const THIN = 0.15;
  const THICK = 0.35;
  const parts = [
    `<g data-map-layer="description-block" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" fill="${color}">`,
    `<rect x="${x}" y="${y}" width="${size.width}" height="${size.height}" fill="#ffffff" stroke="${color}" stroke-width="${THICK}"/>`,
  ];
  if (options.header) {
    const { eventName, classNames, courseName, lengthKm, climbM } = options.header;
    // Row 1: event name (full width)
    parts.push(
      `<line x1="${x}" y1="${y + cell}" x2="${x + size.width}" y2="${y + cell}" stroke="${color}" stroke-width="${THICK}"/>`,
      `<text x="${x + size.width / 2}" y="${y + cell * 0.68}" font-size="${cell * 0.42}" font-weight="bold" text-anchor="middle">${escapeSvgText(eventName)}</text>`,
    );
    // Row 2: class names (full width)
    parts.push(
      `<line x1="${x}" y1="${y + cell * 2}" x2="${x + size.width}" y2="${y + cell * 2}" stroke="${color}" stroke-width="${THICK}"/>`,
      `<text x="${x + size.width / 2}" y="${y + cell * 1.68}" font-size="${cell * 0.4}" font-weight="bold" text-anchor="middle">${escapeSvgText(classNames)}</text>`,
    );
    // Row 3: course (3) · length (3) · climb (2)
    parts.push(
      `<line x1="${x}" y1="${y + cell * 3}" x2="${x + size.width}" y2="${y + cell * 3}" stroke="${color}" stroke-width="${THICK}"/>`,
      `<line x1="${x + cell * 3}" y1="${y + cell * 2}" x2="${x + cell * 3}" y2="${y + cell * 3}" stroke="${color}" stroke-width="${THICK}"/>`,
      `<line x1="${x + cell * 6}" y1="${y + cell * 2}" x2="${x + cell * 6}" y2="${y + cell * 3}" stroke="${color}" stroke-width="${THICK}"/>`,
      `<text x="${x + cell * 1.5}" y="${y + cell * 2.68}" font-size="${cell * 0.4}" font-weight="bold" text-anchor="middle">${escapeSvgText(courseName)}</text>`,
      `<text x="${x + cell * 4.5}" y="${y + cell * 2.68}" font-size="${cell * 0.4}" font-weight="bold" text-anchor="middle">${escapeSvgText(lengthKm)}</text>`,
      `<text x="${x + cell * 7}" y="${y + cell * 2.68}" font-size="${cell * 0.4}" font-weight="bold" text-anchor="middle">${escapeSvgText(climbM)}</text>`,
    );
  } else {
    parts.push(
      `<line x1="${x}" y1="${y + cell}" x2="${x + size.width}" y2="${y + cell}" stroke="${color}" stroke-width="${THICK}"/>`,
      `<text x="${x + size.width / 2}" y="${y + cell * 0.68}" font-size="${cell * 0.48}" font-weight="bold" text-anchor="middle">${escapeSvgText(options.title)}</text>`,
    );
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const top = y + cell * (rowIndex + headerRows);
    const wide = row.kind === "special" || row.kind === "finish";
    if (!wide) {
      for (let column = 1; column < 8; column += 1) {
        const lineX = x + cell * column;
        const thick = DESCRIPTION_THICK_COLUMNS.includes(column);
        parts.push(
          `<line x1="${lineX}" y1="${top}" x2="${lineX}" y2="${top + cell}" stroke="${color}" stroke-width="${thick ? THICK : THIN}"/>`,
        );
      }
    }
    if (rowIndex < rows.length - 1) {
      const thick = hasThickRuleBelow(rows as DescriptionSheetRow[], rowIndex);
      parts.push(
        `<line x1="${x}" y1="${top + cell}" x2="${x + size.width}" y2="${top + cell}" stroke="${color}" stroke-width="${thick ? THICK : THIN}"/>`,
      );
    }
    const textY = top + cell * 0.67;
    const textSize = cell * 0.43;

    if (wide) {
      // Full-width 13.x / 14.x symbol with the optional length centred.
      const key = row.symbolKey;
      const fragment = key ? options.symbolResolver(key) : null;
      if (fragment) {
        const colored = fragment
          .replace(/stroke="black"/g, `stroke="${color}"`)
          .replace(/fill="black"/g, `fill="${color}"`)
          .replace(/ stroke-width="null"/g, "");
        const inset = cell * 0.1;
        parts.push(
          `<svg x="${x + inset}" y="${top + inset}" width="${size.width - inset * 2}" height="${cell - inset * 2}" viewBox="-800 -100 1600 200" preserveAspectRatio="xMidYMid meet">${colored}</svg>`,
        );
      }
      if (row.lengthM != null && row.lengthM > 0) {
        parts.push(
          `<text x="${x + size.width / 2}" y="${textY}" font-size="${textSize * 0.9}" font-weight="bold" text-anchor="middle">${Math.round(row.lengthM)} m</text>`,
        );
      }
      continue;
    }

    if (row.kind === "start") {
      parts.push(renderCellSymbol(x, top, cell, "start", options.symbolResolver, color));
    } else {
      parts.push(
        `<text x="${x + cell * 0.5}" y="${textY}" font-size="${textSize}" text-anchor="middle">${row.sequence ?? ""}</text>`,
        `<text x="${x + cell * 1.5}" y="${textY}" font-size="${textSize}" text-anchor="middle">${escapeSvgText(row.code)}</text>`,
      );
    }

    const description = row.description;
    if (!description) continue;
    const cells = descriptionCells(description, color);
    const order: Array<[keyof typeof cells, number]> = [
      ["C", 2],
      ["D", 3],
      ["E", 4],
      ["F", 5],
      ["G", 6],
      ["H", 7],
    ];
    for (const [key, column] of order) {
      parts.push(renderCellContent(x + cell * column, top, cell, cells[key], color));
    }
  }
  parts.push("</g>");
  return parts.join("");
}

/** @deprecated Kept for callers that still resolve a single key via a resolver. */
export function renderLegacyCellSymbol(
  x: number,
  y: number,
  size: number,
  key: string | null,
  resolver: IofSymbolResolver,
  color: string,
): string {
  return renderCellSymbol(x, y, size, key, resolver, color);
}
