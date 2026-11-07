/**
 * Content-keyed map tile / print cache identity of v0.5.0.
 *
 * Tiles were shared across events that use the same OCAD blob with the
 * same colour-stack settings and rotation correction. The tile renderer
 * went in E4a; the upload still stores the key on `map_files.render_key`
 * / `club_map_files.render_key` so a rollback to v0.5.0 finds its tiles,
 * until E5 drops the column (docs/map-storage.md §4.6).
 */

import { createHash } from "node:crypto";
import type { ColorProfile, ColorStackOverrides } from "@oxygen/shared";

/** v0.5.0's tile format (`TILE_FORMAT` in its map-tiles.ts / kiosk-key.ts); must not change while the key is written for rollback. */
export const RENDER_TILE_FORMAT = 2;

export interface RenderKeyInput {
  fileHash: string;
  rotationCorrection: number;
  colorProfile: ColorProfile;
  colorOverrides?: ColorStackOverrides | null;
  northLinesBelow: boolean;
  /** Defaults to `RENDER_TILE_FORMAT`. */
  tileFormat?: number;
}

function stableOverridesJson(
  overrides: ColorStackOverrides | null | undefined,
): string {
  if (!overrides) return "{}";
  const above = [...(overrides.above ?? [])].sort((a, b) => a - b);
  const below = [...(overrides.below ?? [])].sort((a, b) => a - b);
  return JSON.stringify({ above, below });
}

/**
 * SHA-256 of the render inputs, truncated to 32 hex chars (128 bits).
 * Stable across processes; any input change yields a new key.
 */
export function computeRenderKey(input: RenderKeyInput): string {
  const payload = [
    input.fileHash,
    String(input.rotationCorrection ?? 0),
    input.colorProfile,
    stableOverridesJson(input.colorOverrides),
    input.northLinesBelow ? "1" : "0",
    String(input.tileFormat ?? RENDER_TILE_FORMAT),
  ].join("|");
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/** SHA-256 hex of an OCAD blob — stored as `file_hash`. */
export function hashMapFileData(fileData: Buffer | Uint8Array): string {
  return createHash("sha256").update(fileData).digest("hex");
}
