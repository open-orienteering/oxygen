/**
 * The graphics picker's pure parts (J2, docs/course-layout.md §2): the
 * groups (event, then club), a tile's size label, the thumbnail URL and the
 * client-side upload check, which mirrors the server's 16 MiB cap so a too
 * large file fails before it is read.
 */

/** The server's `MAX_GRAPHIC_UPLOAD_BYTES` (packages/api/src/course-maps/graphics.ts). */
export const GRAPHIC_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;

export interface PickerGraphic {
  id: number;
  name: string;
  mime: string;
  sizeBytes: number;
  widthPx: number | null;
  heightPx: number | null;
  club: boolean;
  /** `graphics.list`'s content version: the thumbnail URL is keyed by it (its cache is immutable). */
  version: string;
}

/** Event graphics, then club graphics, each in the server's (name) order. */
export function graphicGroups<G extends PickerGraphic>(rows: readonly G[]): { event: G[]; club: G[] } {
  return { event: rows.filter((g) => !g.club), club: rows.filter((g) => g.club) };
}

/** `4096 × 2048 px`, or null without a size. */
export function graphicSizeLabel(g: Pick<PickerGraphic, "widthPx" | "heightPx">): string | null {
  return g.widthPx && g.heightPx ? `${g.widthPx} × ${g.heightPx} px` : null;
}

/** The thumbnail, keyed by the bytes' version: an id's bytes can be replaced, and the answer is cached as immutable. */
export function graphicThumbUrl(nameId: string, id: number, version: string): string {
  return `/api/maps/${encodeURIComponent(nameId)}/graphics/${id}/thumb.png?v=${encodeURIComponent(version)}`;
}

/** The picker's message key for an upload the server refused (its messages are English), or null for the generic one. */
export function uploadErrorKey(message: string): "graphicsTooManyPixels" | "graphicsTooLargeResampled" | "graphicsSvgTooLarge" | "graphicsTooLarge" | "graphicsUnsafeSvg" | null {
  if (/megapixels/i.test(message)) return "graphicsTooManyPixels";
  if (/even at \d+ px/i.test(message)) return "graphicsTooLargeResampled";
  if (/SVG graphic is limited/i.test(message)) return "graphicsSvgTooLarge";
  if (/Graphics are limited to/i.test(message)) return "graphicsTooLarge";
  if (/The SVG (must not|needs|file|viewBox)/i.test(message)) return "graphicsUnsafeSvg";
  return null;
}

/** Why a file cannot be uploaded, or null: PNG or SVG by name or type, at most 16 MiB. */
export function uploadProblem(file: { name: string; type: string; size: number }): "type" | "size" | null {
  const typeOk = /\.(png|svg)$/i.test(file.name) || file.type === "image/png" || file.type === "image/svg+xml";
  if (!typeOk) return "type";
  if (file.size > GRAPHIC_UPLOAD_MAX_BYTES) return "size";
  return null;
}
