/**
 * The fonts the shared stage lays map text out with (docs/map-rendering.md
 * §4.10), fetched once per session for the vector viewer's worker. The
 * service worker caches them on first use (`map-fonts`, vite.config.ts).
 */

import type { render } from "@oxygen/shared";
import liberationSansUrl from "../../../shared/fonts/LiberationSans-Regular.ttf?url";
import liberationSansNarrowUrl from "../../../shared/fonts/LiberationSansNarrow-Regular.ttf?url";

export interface MapFontBytes {
  family: render.FontFamily;
  bytes: ArrayBuffer;
}

const FONT_FILES: [render.FontFamily, string][] = [
  ["liberation-sans", liberationSansUrl],
  ["liberation-sans-narrow", liberationSansNarrowUrl],
];

let fonts: Promise<MapFontBytes[]> | undefined;

/** The font bytes; each caller that transfers them to a worker passes copies. A failed load is retried on the next call. */
export function loadMapFonts(): Promise<MapFontBytes[]> {
  fonts ??= Promise.all(
    FONT_FILES.map(async ([family, url]) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`font ${family}: ${res.status}`);
      return { family, bytes: await res.arrayBuffer() };
    }),
  ).catch((err: unknown) => {
    fonts = undefined;
    throw err;
  });
  return fonts;
}
