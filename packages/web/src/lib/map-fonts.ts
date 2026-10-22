/**
 * The fonts the shared stage lays map text out with (docs/map-rendering.md
 * §4.10), fetched once per session for the vector viewer's worker, and the
 * MSDF text atlas pages the renderer draws text from (§5.2 "Text atlas"),
 * fetched once per session per page. The service worker caches both on
 * first use (`map-fonts`, vite.config.ts).
 */

import type { render } from "@oxygen/shared";
import liberationSansUrl from "../../../shared/fonts/LiberationSans-Regular.ttf?url";
import liberationSansNarrowUrl from "../../../shared/fonts/LiberationSansNarrow-Regular.ttf?url";
import latinJsonUrl from "../../../shared/fonts/msdf/text-atlas.latin.json?url";
import latinPngUrl from "../../../shared/fonts/msdf/text-atlas.latin.png?url";
import cyrillicJsonUrl from "../../../shared/fonts/msdf/text-atlas.cyrillic.json?url";
import cyrillicPngUrl from "../../../shared/fonts/msdf/text-atlas.cyrillic.png?url";
import type { TextAtlasImage } from "../map-gl/renderer";
import { parseTextAtlasPage, type TextAtlasPageName } from "../map-gl/text-atlas";

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

const PAGE_FILES: Record<TextAtlasPageName, { json: string; png: string }> = {
  latin: { json: latinJsonUrl, png: latinPngUrl },
  cyrillic: { json: cyrillicJsonUrl, png: cyrillicPngUrl },
};

const pages = new Map<TextAtlasPageName, Promise<TextAtlasImage>>();

async function fetchOk(url: string, what: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${what}: ${res.status}`);
  return res;
}

/**
 * The given text atlas pages (`textAtlasPagesFor(header.strings)`), in that
 * order, the image decoded as data: no premultiplied alpha, no colour-space
 * conversion. Each page is fetched once per session; a failed page is
 * retried on the next call.
 */
export function loadTextAtlas(names: readonly TextAtlasPageName[]): Promise<TextAtlasImage[]> {
  return Promise.all(
    names.map((name) => {
      let p = pages.get(name);
      if (!p) {
        const f = PAGE_FILES[name];
        p = Promise.all([
          fetchOk(f.json, `text atlas ${name}`).then(async (r) => parseTextAtlasPage(await r.json())),
          fetchOk(f.png, `text atlas ${name}`).then(async (r) => createImageBitmap(await r.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" })),
        ]).then(([page, image]) => {
          if (page.page !== name || image.width !== page.width || image.height !== page.height) throw new Error(`text atlas ${name}: image does not match its table`);
          return { page, image };
        });
        p.catch(() => pages.delete(name));
        pages.set(name, p);
      }
      return p;
    }),
  );
}
