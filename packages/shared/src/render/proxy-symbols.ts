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
