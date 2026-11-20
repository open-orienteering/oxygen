/**
 * Proxy symbols: one generic `RenderSymbol` per kind (thin line, flat
 * fill, small disc, plain text) for objects whose symbol has no render
 * definition, so every object of a document is drawn
 * (`map-document/render-bridge.ts`, `unmatched: "proxy"`; the S1
 * "envelope"). Normative: docs/map-rendering.md §5.2, docs/map-document-format.md §8.
 */

import { parseRenderSymbol, type RenderSymbol } from "./symbol.js";

/** Colour indices the proxies draw with (defaults: 0). */
export interface ProxyColours {
  line?: number;
  area?: number;
  point?: number;
  text?: number;
}

/**
 * The proxies' colours on a stack, by ink rather than by row (docs/map-rendering.md §5.2, row I5): lines, points
 * and text in the darkest row, areas in the lightest row that is not white; ties to the lowest row. The render
 * bridge's default, so print, thumbnails and the viewer draw proxies alike, and in the same ink on the layered
 * stack and the source order (row 0 is a different colour on each).
 */
export function stackProxyColours(colours: readonly { cmyk: readonly number[] }[]): Required<ProxyColours> {
  if (!colours.length) return { line: 0, area: 0, point: 0, text: 0 };
  const lum = (i: number) => {
    const [c, m, y, k] = colours[i].cmyk;
    return (1 - Math.min(1, k)) * (3 - Math.min(1, c) - Math.min(1, m) - Math.min(1, y));
  };
  // Areas: the lightest row that is not white (row 0 only when every row is white — a white row 0 must not win).
  let dark = 0, light = -1;
  for (let i = 0; i < colours.length; i++) {
    if (lum(i) < lum(dark)) dark = i;
    if (lum(i) < 2.9 && (light < 0 || lum(i) > lum(light))) light = i;
  }
  return { line: dark, area: Math.max(light, 0), point: dark, text: dark };
}

export function proxySymbols(colours: ProxyColours = {}): RenderSymbol[] {
  return [
    { type: "line", id: "proxy:line", code: "proxy-line", name: "Proxy line", main: { colour: colours.line ?? 0, widthUm: 140 } },
    { type: "area", id: "proxy:area", code: "proxy-area", name: "Proxy area", fill: colours.area ?? 0 },
    {
      type: "point", id: "proxy:point", code: "proxy-point", name: "Proxy point", orientation: "north",
      glyph: { rotatable: false, parts: [{ kind: "disc", colour: colours.point ?? 0, diameterUm: 500 }] },
    },
    { type: "text", id: "proxy:text", code: "proxy-text", name: "Proxy text", fontFamily: "liberation-sans", fontSizeUm: 3000, colour: colours.text ?? 0 },
  ].map(parseRenderSymbol);
}
