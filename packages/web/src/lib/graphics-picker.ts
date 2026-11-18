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
}

/** Event graphics, then club graphics, each in the server's (name) order. */
export function graphicGroups<G extends PickerGraphic>(rows: readonly G[]): { event: G[]; club: G[] } {
  return { event: rows.filter((g) => !g.club), club: rows.filter((g) => g.club) };
}

/** `4096 × 2048 px`, or null without a size. */
export function graphicSizeLabel(g: Pick<PickerGraphic, "widthPx" | "heightPx">): string | null {
  return g.widthPx && g.heightPx ? `${g.widthPx} × ${g.heightPx} px` : null;
}

export function graphicThumbUrl(nameId: string, id: number): string {
  return `/api/maps/${encodeURIComponent(nameId)}/graphics/${id}/thumb.png`;
}

/** Why a file cannot be uploaded, or null: PNG or SVG by name or type, at most 16 MiB. */
export function uploadProblem(file: { name: string; type: string; size: number }): "type" | "size" | null {
  const typeOk = /\.(png|svg)$/i.test(file.name) || file.type === "image/png" || file.type === "image/svg+xml";
  if (!typeOk) return "type";
  if (file.size > GRAPHIC_UPLOAD_MAX_BYTES) return "size";
  return null;
}
