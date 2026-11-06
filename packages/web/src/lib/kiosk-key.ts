/**
 * Kiosk/start-screen pages authenticate with a `?k=` key instead of a
 * signed-in user. tRPC calls forward it as `x-kiosk-key` (see main.tsx);
 * plain `fetch`es (the map document, `lib/map-document-cache.ts`) send the
 * same header themselves. This reads the key from the current URL.
 */
export function kioskKeyFromUrl(
  search: string = window.location.search,
): string | null {
  const k = new URLSearchParams(search).get("k")?.trim();
  return k || null;
}
