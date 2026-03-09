/**
 * Club logo URL resolver.
 *
 * Clubs can provide high-quality SVG logos in /public/clubs/{eventorId}.svg.
 * When an SVG override exists we serve it directly from the static folder;
 * otherwise we fall back to the Eventor-imported PNG via the API.
 */

const API_BASE = import.meta.env.VITE_API_URL ?? "";

/** Eventor IDs that have a local SVG override in public/clubs/ */
const SVG_OVERRIDES: ReadonlySet<number> = new Set([
  340, // Skogsluffarna
]);

/**
 * Returns the best available logo URL for a club.
 *
 * - If a local SVG override exists → `/clubs/{eventorId}.svg`
 * - Otherwise → API PNG endpoint
 */
export function getClubLogoUrl(
  eventorId: number,
  variant: "small" | "large" = "large",
): string {
  if (SVG_OVERRIDES.has(eventorId)) {
    return `/clubs/${eventorId}.svg`;
  }
  return `${API_BASE}/api/club-logo/${eventorId}?variant=${variant}`;
}

/** Check whether a club has a local SVG override */
export function hasLocalSvg(eventorId: number): boolean {
  return SVG_OVERRIDES.has(eventorId);
}
