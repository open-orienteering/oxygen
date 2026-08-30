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
 */
export function tileQueryString(
  tileVersion: number | undefined,
  kioskKey: string | null,
): string {
  const parts: string[] = [];
  if (tileVersion) parts.push(`v=${tileVersion}`);
  if (kioskKey) parts.push(`k=${encodeURIComponent(kioskKey)}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}
