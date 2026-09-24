/**
 * Kiosk/start-screen pages authenticate with a `?k=` key instead of a
 * signed-in user. tRPC calls forward it as `x-kiosk-key` (see main.tsx),
 * but plain resource requests — tile `<img>` src, progress fetches — must
 * carry it themselves. This reads the key from the current URL.
 */
export function kioskKeyFromUrl(
  search: string = window.location.search,
): string | null {
  const k = new URLSearchParams(search).get("k")?.trim();
  return k || null;
}

/**
 * Query string for a map-tile `<img>` src. Image requests can't carry the
 * `x-kiosk-key` header, so key-only devices (kiosk, start screen) must
 * pass the key as `?k=` — the REST guard accepts either.
 *
 * `f=2` marks the stacked 256×512 tile format (composite + ink) so a
 * browser that still holds a week-old 256×256 PNG from before the
 * format change cannot feed it into the half-slicer.
 */
export const TILE_FORMAT = 2;

export function tileQueryString(
  tileVersion: number | string | undefined,
  kioskKey: string | null,
): string {
  const parts: string[] = [`f=${TILE_FORMAT}`];
  if (tileVersion) parts.push(`v=${tileVersion}`);
  if (kioskKey) parts.push(`k=${encodeURIComponent(kioskKey)}`);
  return `?${parts.join("&")}`;
}
