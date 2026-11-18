/**
 * Upload validation and embedding helpers for course-map graphics
 * (club logos, sponsor art). Only SVG and PNG are accepted; SVG uploads
 * are restricted to self-contained documents so the PDF composer can
 * embed them (docs/course-print.md §6.3).
 */

import { SVG_RASTER_MAX_PX, type PrintSheet } from "@oxygen/shared/print";

/** The largest upload accepted (J2, docs/course-maps.md "Data model"). */
export const MAX_GRAPHIC_UPLOAD_BYTES = 16 * 1024 * 1024;
/** The largest stored graphic: a PNG over it is resampled further, an SVG over it refused. */
export const MAX_GRAPHIC_STORED_BYTES = 8 * 1024 * 1024;
/** The longer side of a stored PNG, px (`SVG_RASTER_MAX_PX`, a phone's texture limit). */
export const GRAPHIC_MAX_PX = 4096;
/** Longer sides tried, in order, when a PNG at `GRAPHIC_MAX_PX` is still over the stored cap (user 2026-11-18, question 12). */
export const GRAPHIC_FALLBACK_PX = [3072, 2048] as const;
/** Decoded pixels a PNG upload may have (64 MP), so a 16 MiB file cannot exhaust memory. */
export const GRAPHIC_MAX_INPUT_PIXELS = 64 * 1024 * 1024;
/** The longer side of a thumbnail, px. */
export const GRAPHIC_THUMB_PX = 256;

const MIB = 1024 * 1024;

export type GraphicMime = "image/svg+xml" | "image/png";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const SVG_FORBIDDEN: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /<script/i, reason: "script elements" },
  { pattern: /<foreignObject/i, reason: "foreignObject elements" },
  { pattern: /javascript:/i, reason: "javascript: URLs" },
  { pattern: /\son\w+\s*=/i, reason: "event handler attributes" },
  {
    pattern: /(?:href|src)\s*=\s*(["'])\s*https?:/i,
    reason: "external references",
  },
  { pattern: /url\(\s*(["']?)\s*https?:/i, reason: "external references" },
];

interface ParsedSvgGraphic {
  mime: "image/svg+xml";
  /** Inner markup of the root `<svg>` element (metadata/comments stripped). */
  inner: string;
  viewBox: string;
  /** Root xmlns:* attributes, re-emitted on the nested wrapper. */
  rootAttrs: string;
}

/** Strip XML declarations, comments, doctype and metadata blocks. */
function sanitizeSvgMarkup(text: string): string {
  return text
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<metadata\b[^>]*>[\s\S]*?<\/metadata>/gi, "");
}

function parseSvgGraphic(data: Buffer): ParsedSvgGraphic {
  const text = sanitizeSvgMarkup(data.toString("utf8"));
  const rootStart = text.search(/<svg[\s>]/i);
  if (rootStart < 0) throw new Error("The SVG file has no <svg> root element");
  const rootEnd = text.indexOf(">", rootStart);
  const closing = text.lastIndexOf("</svg>");
  if (rootEnd < 0 || closing <= rootEnd) {
    throw new Error("The SVG file is malformed");
  }
  for (const { pattern, reason } of SVG_FORBIDDEN) {
    if (pattern.test(text)) {
      throw new Error(`The SVG must not contain ${reason}`);
    }
  }
  const root = text.slice(rootStart, rootEnd + 1);
  const rootAttrs = [...root.matchAll(/\s(xmlns(?::[\w-]+)?)\s*=\s*(["'])([^"']*)\2/gi)]
    .map((match) => `${match[1]}="${match[3]}"`)
    .join(" ");
  let viewBox = /viewBox\s*=\s*(["'])([^"']+)\1/i.exec(root)?.[2]?.trim();
  if (!viewBox) {
    const width = Number.parseFloat(
      /(?:^|\s)width\s*=\s*(["'])([\d.]+)[a-z%]*\1/i.exec(root)?.[2] ?? "",
    );
    const height = Number.parseFloat(
      /(?:^|\s)height\s*=\s*(["'])([\d.]+)[a-z%]*\1/i.exec(root)?.[2] ?? "",
    );
    if (!(width > 0) || !(height > 0)) {
      throw new Error("The SVG needs a viewBox or numeric width and height");
    }
    viewBox = `0 0 ${width} ${height}`;
  }
  const parts = viewBox.split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    throw new Error("The SVG viewBox is not valid");
  }
  return {
    mime: "image/svg+xml",
    inner: text.slice(rootEnd + 1, closing),
    viewBox: parts.join(" "),
    rootAttrs,
  };
}

/** Validate an uploaded graphic and return its detected mime type. */
export function validateGraphicUpload(data: Buffer): GraphicMime {
  if (data.byteLength === 0) throw new Error("The file is empty");
  if (data.byteLength > MAX_GRAPHIC_UPLOAD_BYTES) {
    throw new Error(`Graphics are limited to ${MAX_GRAPHIC_UPLOAD_BYTES / MIB} MB`);
  }
  if (data.subarray(0, 4).equals(PNG_MAGIC)) return "image/png";
  parseSvgGraphic(data);
  return "image/svg+xml";
}

/**
 * A graphic's pixel size (J2): a PNG's from its IHDR; an SVG's viewBox
 * scaled so its longer side is `GRAPHIC_MAX_PX` (user 2026-11-18,
 * question 14: the largest raster made of it, aspect kept to 1/4096).
 * `null` when unreadable.
 */
export function graphicPixelSize(data: Uint8Array, mime: string): { widthPx: number; heightPx: number } | null {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (mime === "image/png") {
    if (buf.byteLength < 24 || !buf.subarray(0, 4).equals(PNG_MAGIC) || buf.toString("latin1", 12, 16) !== "IHDR") return null;
    const widthPx = buf.readUInt32BE(16), heightPx = buf.readUInt32BE(20);
    return widthPx > 0 && heightPx > 0 ? { widthPx, heightPx } : null;
  }
  if (mime === "image/svg+xml") {
    try {
      const [, , w, h] = parseSvgGraphic(buf).viewBox.split(" ").map(Number);
      if (!(w > 0) || !(h > 0)) return null;
      const k = GRAPHIC_MAX_PX / Math.max(w, h);
      return { widthPx: Math.max(1, Math.round(w * k)), heightPx: Math.max(1, Math.round(h * k)) };
    } catch {
      return null;
    }
  }
  return null;
}

export interface PreparedGraphic {
  mime: GraphicMime;
  data: Buffer;
  widthPx: number | null;
  heightPx: number | null;
}

/**
 * Validates an upload and makes what is stored (J2): a PNG whose longer
 * side is over `GRAPHIC_MAX_PX` is resampled to it with `sharp` (aspect and
 * alpha kept, metadata stripped); a PNG still over `MAX_GRAPHIC_STORED_BYTES`
 * is resampled to 3072, then 2048 px and refused only beyond that. A PNG
 * that fits is stored byte for byte. An SVG over the stored cap is refused.
 */
export async function prepareGraphicUpload(input: Buffer): Promise<PreparedGraphic> {
  const mime = validateGraphicUpload(input);
  if (mime === "image/svg+xml") {
    if (input.byteLength > MAX_GRAPHIC_STORED_BYTES) throw new Error(`An SVG graphic is limited to ${MAX_GRAPHIC_STORED_BYTES / MIB} MB`);
    const size = graphicPixelSize(input, mime);
    return { mime, data: input, widthPx: size?.widthPx ?? null, heightPx: size?.heightPx ?? null };
  }
  const sharp = (await import("sharp")).default;
  let meta: { width?: number; height?: number };
  try {
    meta = await sharp(input, { limitInputPixels: GRAPHIC_MAX_INPUT_PIXELS }).metadata();
  } catch (error) {
    throw new Error(`The PNG could not be read${error instanceof Error && /pixel limit/i.test(error.message) ? ": it has more than 64 megapixels" : ""}`);
  }
  const w = meta.width ?? 0, h = meta.height ?? 0;
  if (!(w > 0) || !(h > 0)) throw new Error("The PNG could not be read");
  if (w * h > GRAPHIC_MAX_INPUT_PIXELS) throw new Error("The PNG has more than 64 megapixels");
  if (Math.max(w, h) <= GRAPHIC_MAX_PX && input.byteLength <= MAX_GRAPHIC_STORED_BYTES) {
    return { mime, data: input, widthPx: w, heightPx: h };
  }
  let tried = 0;
  for (const side of [GRAPHIC_MAX_PX, ...GRAPHIC_FALLBACK_PX]) {
    // A PNG already under a side re-encodes at its own size; do that once.
    const target = Math.min(side, Math.max(w, h));
    if (target === tried) continue;
    tried = target;
    const { data, info } = await sharp(input, { limitInputPixels: GRAPHIC_MAX_INPUT_PIXELS })
      .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    if (data.byteLength <= MAX_GRAPHIC_STORED_BYTES) return { mime, data, widthPx: info.width, heightPx: info.height };
  }
  throw new Error(`The PNG is over ${MAX_GRAPHIC_STORED_BYTES / MIB} MB even at ${GRAPHIC_FALLBACK_PX.at(-1)} px; save it smaller or as SVG`);
}

/** A thumbnail's pixel box: `w × h` fitted inside `max × max`, aspect kept, never enlarged, at least 1 px. */
export function thumbBox(w: number, h: number, max = GRAPHIC_THUMB_PX): [number, number] {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

/**
 * `print.png`'s `w` / `h` (docs/course-print.md §8.5): integers 1–4096
 * (`SVG_RASTER_MAX_PX`, the largest box `svgRasterBox` asks). The box, or
 * the 400 message.
 */
export function parseRasterBox(w: string | undefined, h: string | undefined): [number, number] | string {
  const side = (raw: string | undefined) => (raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN);
  const box: [number, number] = [side(w), side(h)];
  if (box.some((v) => !Number.isInteger(v) || v < 1 || v > SVG_RASTER_MAX_PX)) {
    return `w and h must be integers 1–${SVG_RASTER_MAX_PX} for an SVG graphic`;
  }
  return box;
}

/**
 * Every graphic an image object of a sheet references (docs/course-print.md
 * §8.5), ascending: the page objects (template + sheet) and the image course
 * objects in scope. Before G15 only the rows' and templates' objects were
 * read, so an `image` course object printed as `IMAGE_MISSING`
 * (docs/bugfix-course-object-image-print.md).
 */
export function sheetGraphicIds(sheets: readonly PrintSheet[]): number[] {
  const ids = new Set<number>();
  for (const sheet of sheets) {
    for (const object of sheet.objects) if (object.kind === "image") ids.add(object.graphicId);
    for (const object of sheet.course?.objects ?? []) if (object.kind === "image") ids.add(object.props.graphicId);
  }
  return [...ids].sort((a, b) => a - b);
}
