/**
 * Upload validation and embedding helpers for course-map graphics
 * (club logos, sponsor art). Only SVG and PNG are accepted; SVG uploads
 * are restricted to self-contained documents so the PDF composer can
 * embed them (docs/course-print.md §6.3).
 */

import { render } from "@oxygen/shared";
import { type ImageWindow, SVG_RASTER_MAX_PX, type PrintSheet } from "@oxygen/shared/print";
import { PrintWorkerReplyError, printGate, rasteriseSvgInWorker, trimSvgInWorker } from "./print-worker-host.js";

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

/**
 * What an uploaded SVG may not contain. Nothing is stripped before the
 * check: a script in a comment, in `<metadata>` or behind a character
 * reference is refused too (docs/course-maps.md "Graphics", CRS-003), so
 * the validator and a browser or rasteriser cannot read different documents.
 * Every pattern runs on the raw text and on the text with character
 * references and the five predefined entities expanded.
 */
const SVG_FORBIDDEN_ELEMENT =
  /<\s*(?:[\w.-]+:)?(script|foreignObject|iframe|object|embed|audio|video|link|meta|base)\b/i;
const SVG_FORBIDDEN: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /javascript:/i, reason: "javascript: URLs" },
  { pattern: /\son\w+\s*=/i, reason: "event handler attributes" },
  { pattern: /@import/i, reason: "@import rules" },
];
/** An embedded raster; the only non-local href an SVG graphic may carry. */
const SVG_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,/i;

/** Character references and the five predefined entities expanded, tabs and line breaks removed. */
function decodeSvgText(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => codePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_m, d: string) => codePoint(Number.parseInt(d, 10)))
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[\t\r\n]/g, "");
}

function codePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/** The DOCTYPE's internal subset may declare plain-text entities only. */
function assertSafeDoctype(raw: string): void {
  const subset = /<!DOCTYPE[^[>]*\[([\s\S]*?)\]\s*>/i.exec(raw)?.[1];
  if (subset === undefined) return;
  const refuse = () => {
    throw new Error("The SVG must not contain entity declarations that expand to markup or load files");
  };
  if (/<!ENTITY\s+%/i.test(subset)) refuse();
  if (/<!ENTITY\s+\S+\s+(?:SYSTEM|PUBLIC)\b/i.test(subset)) refuse();
  for (const m of subset.matchAll(/<!ENTITY\s+\S+\s+(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = decodeSvgText(m[1] ?? m[2] ?? "");
    if (value.includes("<") || value.includes("&")) refuse();
  }
}

/** Throws unless every reference in the document stays inside it (`#id`) or is an embedded raster. */
function assertLocalReferences(raw: string, decoded: string): void {
  const external = () => {
    throw new Error("The SVG must not contain external references");
  };
  if (/(?:^|[\s"'/])(?:[\w.-]+:)?(?:href|src)\s*=\s*(?!["'])/i.test(raw)) external();
  for (const m of raw.matchAll(/(?:^|[\s"'/])(?:[\w.-]+:)?(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = decodeSvgText(m[1] ?? m[2] ?? "").trim();
    if (!value.startsWith("#") && !SVG_DATA_IMAGE.test(value)) external();
  }
  for (const text of [raw, decoded]) {
    for (const m of text.matchAll(/url\(\s*(["']?)\s*([^)]*?)\1\s*\)/gi)) {
      if (!decodeSvgText(m[2] ?? "").trim().startsWith("#")) external();
    }
  }
}

function assertSafeSvg(raw: string): void {
  assertSafeDoctype(raw);
  const decoded = decodeSvgText(raw);
  for (const text of [raw, decoded]) {
    const element = SVG_FORBIDDEN_ELEMENT.exec(text);
    if (element) throw new Error(`The SVG must not contain ${element[1]} elements`);
    for (const { pattern, reason } of SVG_FORBIDDEN) {
      if (pattern.test(text)) throw new Error(`The SVG must not contain ${reason}`);
    }
  }
  assertLocalReferences(raw, decoded);
}

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
  const raw = data.toString("utf8");
  // The checks read the document as uploaded; the stripped copy only locates
  // the root and its inner markup.
  const text = sanitizeSvgMarkup(raw);
  const rootStart = text.search(/<svg[\s>]/i);
  if (rootStart < 0) throw new Error("The SVG file has no <svg> root element");
  // The start tag's end, past `>` inside quoted attribute values.
  const tag = /<svg(?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>/y;
  tag.lastIndex = rootStart;
  const rootEnd = tag.exec(text) ? tag.lastIndex - 1 : text.indexOf(">", rootStart);
  const closing = text.lastIndexOf("</svg>");
  if (rootEnd < 0 || closing <= rootEnd) {
    throw new Error("The SVG file is malformed");
  }
  assertSafeSvg(raw);
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

/**
 * Headers for bytes an upload decided (a graphic's raw SVG, the PNGs
 * rendered from it): even if a script slipped past the validator, a browser
 * that opens the URL runs none of it and does not sniff another type.
 */
export function untrustedImageHeaders(reply: { header(name: string, value: string): unknown }): void {
  reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  reply.header("X-Content-Type-Options", "nosniff");
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
 * that fits is stored byte for byte. An SVG over the stored cap is refused;
 * one whose canvas is much larger than its drawing is stored trimmed to it
 * (`trimSvgUpload`, user 2026-11-19), else byte for byte.
 */
export async function prepareGraphicUpload(input: Buffer): Promise<PreparedGraphic> {
  const mime = validateGraphicUpload(input);
  if (mime === "image/svg+xml") {
    if (input.byteLength > MAX_GRAPHIC_STORED_BYTES) throw new Error(`An SVG graphic is limited to ${MAX_GRAPHIC_STORED_BYTES / MIB} MB`);
    // Bounds much larger than the drawing are trimmed to it (user 2026-11-19), in a print worker (callers hold
    // `printGate`); an SVG resvg cannot read, or a trim that would not render, is stored as validated.
    let data = input;
    try {
      const trimmed = await trimSvgInWorker(input);
      if (trimmed && trimmed.byteLength <= MAX_GRAPHIC_STORED_BYTES) data = trimmed;
    } catch {
      // Not readable by resvg: kept as uploaded (its print reports SVG_RASTER, as before).
    }
    const size = graphicPixelSize(data, mime);
    return { mime, data, widthPx: size?.widthPx ?? null, heightPx: size?.heightPx ?? null };
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

/**
 * A graphic's outline (J19, `render.traceOutline`): its alpha at `OUTLINE_RASTER_PX` on the longer side, traced. An
 * SVG is rasterised in a print worker under the print gate (a PNG needs only `sharp`); a worker failure or timeout
 * throws `GraphicRasterError` (worth another try), bytes that cannot be decoded throw anything else. `[]` for a
 * whole-box silhouette or an SVG without a size.
 */
/** The print worker could not rasterise an SVG this time (a timeout, a worker that failed): the outline is not stored. */
export class GraphicRasterError extends Error {}

export async function graphicOutline(data: Uint8Array, mime: string, widthPx: number | null, heightPx: number | null): Promise<render.GraphicOutline> {
  let png: Uint8Array = data;
  if (mime === "image/svg+xml") {
    if (!widthPx || !heightPx) return [];
    const [w, h] = thumbBox(widthPx, heightPx, render.OUTLINE_RASTER_PX);
    try {
      png = await printGate(() => rasteriseSvgInWorker(data, w, h));
    } catch (error) {
      // resvg could not read it: as undecodable bytes. A timeout or a failed worker: worth another try.
      if (error instanceof PrintWorkerReplyError) throw error;
      throw new GraphicRasterError(error instanceof Error ? error.message : String(error));
    }
  }
  const sharp = (await import("sharp")).default;
  const { data: alpha, info } = await sharp(png, { limitInputPixels: GRAPHIC_MAX_INPUT_PIXELS })
    .resize({ width: render.OUTLINE_RASTER_PX, height: render.OUTLINE_RASTER_PX, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return render.traceOutline(new Uint8Array(alpha.buffer, alpha.byteOffset, alpha.byteLength), info.width, info.height);
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
 * `print.png`'s `crop` (docs/course-print.md §8.5): the window of an SVG to
 * rasterise, `x,y,w,h` as fractions of its canvas (top-left origin), inside
 * 0…1 with a positive size. Absent = the whole graphic. The window, or the
 * 400 message.
 */
export function parseRasterWindow(raw: string | undefined): ImageWindow | undefined | string {
  if (raw === undefined || raw === "") return undefined;
  const parts = raw.split(",");
  const v = parts.map((p) => (/^\d+(?:\.\d+)?$/.test(p.trim()) ? Number(p) : NaN));
  const bad = "crop must be x,y,w,h: fractions of the graphic, inside 0–1 with a positive size";
  if (v.length !== 4 || v.some((n) => !Number.isFinite(n))) return bad;
  const [x, y, w, h] = v;
  const eps = 1e-9;
  if (!(w > 0) || !(h > 0) || x + w > 1 + eps || y + h > 1 + eps) return bad;
  return { x, y, width: w, height: h };
}

/**
 * Every graphic an image object of a sheet references (docs/course-print.md
 * §8.5), ascending: the page objects (template + sheet) and the image course
 * objects in scope. Before G15 only the rows' and templates' objects were
 * read, so an `image` course object printed as `IMAGE_MISSING`
 * (docs/bugfixes/course-object-image-print.md).
 */
export function sheetGraphicIds(sheets: readonly PrintSheet[]): number[] {
  const ids = new Set<number>();
  for (const sheet of sheets) {
    for (const object of sheet.objects) if (object.kind === "image") ids.add(object.graphicId);
    for (const object of sheet.course?.objects ?? []) if (object.kind === "image") ids.add(object.props.graphicId);
  }
  return [...ids].sort((a, b) => a - b);
}
