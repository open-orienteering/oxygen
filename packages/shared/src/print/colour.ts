/**
 * PDF colour: the document's colour stack (03 §6.3) is the source of
 * truth; the output mode decides the operators (docs/course-print.md §2,
 * research 05 §5.4). Slice C ships `cmyk` and `rgb`; `cmyk-offset` and
 * print profiles are a later row (user decision 2026-10-23).
 */

import { type ColourEntry, cmykToHex } from "../render/symbol.js";

export type ColourMode = "cmyk" | "rgb";

export type PdfColour =
  | { space: "cmyk"; c: number; m: number; y: number; k: number }
  | { space: "rgb"; r: number; g: number; b: number };

function parseHex(hex: string): [number, number, number] {
  let h = hex.replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not an RGB hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * The inverse of the shared naive CMYK → sRGB conversion (`cmykToHex`,
 * 03 §2.3): maximal K, then C/M/Y from what is left, so
 * `cmykToHex(rgbToCmykNaive(hex)) === hex`. Pure black and white are
 * special-cased (and come out single-plate anyway): text and white-outs
 * must never be four-colour.
 */
export function rgbToCmykNaive(hex: string): [number, number, number, number] {
  const [r, g, b] = parseHex(hex);
  if (r === 0 && g === 0 && b === 0) return [0, 0, 0, 1];
  if (r === 255 && g === 255 && b === 255) return [0, 0, 0, 0];
  const max = Math.max(r, g, b) / 255;
  const k = 1 - max;
  const ch = (v: number) => (max - v / 255) / max;
  return [ch(r), ch(g), ch(b), k];
}

/** A colour-stack entry in the output mode: its CMYK, or its naive sRGB. */
export function stackColour(entry: Pick<ColourEntry, "cmyk">, mode: ColourMode): PdfColour {
  if (mode === "cmyk") {
    const [c, m, y, k] = entry.cmyk;
    return { space: "cmyk", c, m, y, k };
  }
  const [r, g, b] = parseHex(cmykToHex(entry.cmyk));
  return { space: "rgb", r: r / 255, g: g / 255, b: b / 255 };
}

/** A user-picked RGB colour of a page object (text, line, rectangle) in the output mode. */
export function pageColour(hex: string, mode: ColourMode): PdfColour {
  if (mode === "cmyk") {
    const [c, m, y, k] = rgbToCmykNaive(hex);
    return { space: "cmyk", c, m, y, k };
  }
  const [r, g, b] = parseHex(hex);
  return { space: "rgb", r: r / 255, g: g / 255, b: b / 255 };
}

/** A colour component: clamped to 0..1, at most four decimals, no trailing zeros. */
export function fmtComponent(v: number): string {
  const r = Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
  return String(r);
}

/** The colour-setting operator: `k` / `K` (DeviceCMYK) or `rg` / `RG` (DeviceRGB). */
export function colourOperator(colour: PdfColour, target: "fill" | "stroke"): string {
  if (colour.space === "cmyk") {
    const v = [colour.c, colour.m, colour.y, colour.k].map(fmtComponent).join(" ");
    return `${v} ${target === "fill" ? "k" : "K"}`;
  }
  const v = [colour.r, colour.g, colour.b].map(fmtComponent).join(" ");
  return `${v} ${target === "fill" ? "rg" : "RG"}`;
}
