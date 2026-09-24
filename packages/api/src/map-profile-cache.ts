/**
 * In-process memo of what the `auto` colour profile resolved to for a
 * given render key.
 *
 * `course.mapMetadata` reports which IOF profile an `auto` map ended up
 * with, and finding out means reading the OCAD blob and classifying its
 * colour table (`applyIofColorStack`). The answer is a pure function of
 * the file, the overrides and the scale — all of which are folded into
 * the render key — so once one request has paid for it there is no reason
 * for the next page load to pull 10 MB through the database again.
 */

import type { ResolvedColorProfile } from "@oxygen/shared";
import type { ColorStackResolvedBy } from "./map-color-stack.js";
import { evictForInsert } from "./map-render-limits.js";

export type ProfileResolvedBy = ColorStackResolvedBy;

export interface ProfileResolution {
  resolvedProfile: ResolvedColorProfile;
  resolvedBy: ProfileResolvedBy;
}

/** Plenty for every map a single instance realistically serves. */
const CAP = 64;

const cache = new Map<string, ProfileResolution>();

export function cachedProfileResolution(
  renderKey: string,
): ProfileResolution | undefined {
  return cache.get(renderKey);
}

export function rememberProfileResolution(
  renderKey: string,
  resolution: ProfileResolution,
): void {
  if (cache.has(renderKey)) {
    cache.set(renderKey, resolution);
    return;
  }
  evictForInsert(cache, CAP);
  cache.set(renderKey, resolution);
}

/** Test hook. */
export function clearProfileResolutionCache(): void {
  cache.clear();
}
