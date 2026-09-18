import type { ControlDescription } from "../types.js";
import { escapeSvgText } from "./text.js";

export type IofSymbolResolver = (iofKey: string) => string | null | undefined;

export interface DescriptionRow {
  sequence?: number;
  code: string;
  description?: ControlDescription | null;
}

export interface RenderDescriptionBlockOptions {
  x: number;
  y: number;
  cellSizeMm: number;
  title: string;
  rows: DescriptionRow[];
  symbolResolver: IofSymbolResolver;
  color?: string;
}

const COMPASS = ["", "N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
const CARDINAL = new Set(["N", "E", "S", "W"]);

export function ocadDescriptionCodeToIof(
  column: "c" | "d" | "f" | "g",
  code: string,
): string | null {
  const [group, rawSub] = code.split(".");
  if (!rawSub) return null;
  const sub = Number.parseInt(rawSub, 10);
  if (!Number.isFinite(sub)) return null;
  if (column === "d") return `${Number.parseInt(group, 10)}.${sub}`;
  if (column === "f") {
    const mapped: Record<string, string> = {
      "10.001": "10.1",
      "10.002": "10.2",
      "11.001": "11.7",
    };
    return mapped[code] ?? `${Number.parseInt(group, 10)}.${sub}`;
  }
  if (column === "c") {
    if (sub === 3 || sub === 300) return "0.3";
    if (sub === 4 || sub === 400) return "0.4";
    if (sub === 5 || sub === 500) return "0.5";
    const direction = COMPASS[sub >= 100 ? sub % 10 : sub];
    if (!direction) return null;
    return `${CARDINAL.has(direction) ? "0.1" : "0.2"}${direction}`;
  }

  const nonDirectional: Record<number, string> = {
    8: "11.9",
    9: "11.10",
    10: "11.11",
    11: "11.13",
    13: "11.12",
    14: "11.15",
  };
  if (sub < 100) return nonDirectional[sub] ?? null;
  const direction = COMPASS[sub % 10];
  if (!direction) return null;
  const rangeBase: Record<number, string> = {
    12: "11.14",
    14: "11.14",
    15: "11.5",
    16: "11.6",
    17: "11.8",
  };
  const typeBase: Record<number, string> = {
    1: "11.1",
    2: "11.2",
    3: "11.3",
    4: "11.4",
    5: "11.5",
    6: "11.6",
    7: "11.8",
  };
  const base = rangeBase[Math.floor(sub / 10)] ?? typeBase[Math.floor(sub / 100)];
  return base ? `${base}${direction}` : null;
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
): { width: number; height: number } {
  return { width: cellSizeMm * 8, height: cellSizeMm * (rowCount + 1) };
}

export function renderDescriptionBlockSvg(
  options: RenderDescriptionBlockOptions,
): string {
  const { x, y, cellSizeMm: cell, rows } = options;
  const color = options.color ?? "#000000";
  const size = descriptionBlockSize(rows.length, cell);
  const parts = [
    `<g data-map-layer="description-block" font-family="DejaVu Sans, Liberation Sans, Arial, sans-serif" fill="${color}">`,
    `<rect x="${x}" y="${y}" width="${size.width}" height="${size.height}" fill="#ffffff" stroke="${color}" stroke-width="0.2"/>`,
    `<line x1="${x}" y1="${y + cell}" x2="${x + size.width}" y2="${y + cell}" stroke="${color}" stroke-width="0.2"/>`,
    `<text x="${x + size.width / 2}" y="${y + cell * 0.68}" font-size="${cell * 0.48}" text-anchor="middle">${escapeSvgText(options.title)}</text>`,
  ];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const top = y + cell * (rowIndex + 1);
    for (let column = 1; column < 8; column += 1) {
      const lineX = x + cell * column;
      parts.push(
        `<line x1="${lineX}" y1="${top}" x2="${lineX}" y2="${top + cell}" stroke="${color}" stroke-width="0.15"/>`,
      );
    }
    if (rowIndex < rows.length - 1) {
      parts.push(
        `<line x1="${x}" y1="${top + cell}" x2="${x + size.width}" y2="${top + cell}" stroke="${color}" stroke-width="0.15"/>`,
      );
    }
    const textY = top + cell * 0.67;
    const textSize = cell * 0.43;
    parts.push(
      `<text x="${x + cell * 0.5}" y="${textY}" font-size="${textSize}" text-anchor="middle">${row.sequence ?? ""}</text>`,
      `<text x="${x + cell * 1.5}" y="${textY}" font-size="${textSize}" text-anchor="middle">${escapeSvgText(row.code)}</text>`,
    );

    const description = row.description;
    if (!description) continue;
    const symbolColumns: Array<["c" | "d" | "f" | "g", number]> = [
      ["c", 2],
      ["d", 3],
      ["f", 5],
      ["g", 6],
    ];
    for (const [key, column] of symbolColumns) {
      const value = description[key];
      parts.push(
        renderCellSymbol(
          x + cell * column,
          top,
          cell,
          value ? ocadDescriptionCodeToIof(key, value) : null,
          options.symbolResolver,
          color,
        ),
      );
    }
    if (description.s) {
      parts.push(
        `<text x="${x + cell * 4.5}" y="${textY}" font-size="${cell * 0.34}" text-anchor="middle">${escapeSvgText(description.s.replace(",", ".") + "m")}</text>`,
      );
    }
  }
  parts.push("</g>");
  return parts.join("");
}
