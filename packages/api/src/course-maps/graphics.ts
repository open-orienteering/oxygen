/**
 * Upload validation and embedding helpers for course-map graphics
 * (club logos, sponsor art). Only SVG and PNG are accepted; SVG uploads
 * are restricted to self-contained documents so they can be inlined into
 * the composed page SVG that librsvg renders to PDF.
 */
import type { ResolvedMapGraphic } from "@oxygen/shared";

export const MAX_GRAPHIC_BYTES = 2 * 1024 * 1024;

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
  if (data.byteLength > MAX_GRAPHIC_BYTES) {
    throw new Error(
      `Graphics are limited to ${Math.round(MAX_GRAPHIC_BYTES / 1024 / 1024)} MB`,
    );
  }
  if (data.subarray(0, 4).equals(PNG_MAGIC)) return "image/png";
  parseSvgGraphic(data);
  return "image/svg+xml";
}

/** Embedding for the PDF composer: inline SVG, data URI for PNG. */
export function graphicToResolved(
  mime: string,
  data: Buffer,
): ResolvedMapGraphic | null {
  if (mime === "image/png") {
    return { kind: "href", href: `data:image/png;base64,${data.toString("base64")}` };
  }
  if (mime === "image/svg+xml") {
    try {
      const parsed = parseSvgGraphic(data);
      return {
        kind: "svg",
        svg: parsed.inner,
        viewBox: parsed.viewBox,
        ...(parsed.rootAttrs ? { rootAttrs: parsed.rootAttrs } : {}),
      };
    } catch {
      return null;
    }
  }
  return null;
}
