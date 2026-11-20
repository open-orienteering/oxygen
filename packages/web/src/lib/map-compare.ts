/**
 * The review page's compare view (docs/map-symbols.md §8.7 "Compare", row
 * I8a): which two documents a pair compares, the view's query state, the
 * swipe divider and the flip, and the one paper camera both panes share
 * (`map-viewport.ts`'s `zoomAt` / `panBy` / `fitMm`).
 */

import { fitMm, panBy, zoomAt, type PaperViewport } from "./map-viewport";

export type ComparePairKind = "use" | "order";
export type CompareMode = "side" | "swipe" | "diff";
export type ColourOrder = "iof" | "source";

/** One side of a pair: a document known by its hash, or the other order's document, asked of its route. */
export type CompareSide =
  | { hash: string; label: "inUse" | "thisVersion" | ColourOrder }
  | { url: string; label: ColourOrder };

export interface ComparePair {
  kind: ComparePairKind;
  /** Drawn left (or on top, or left of the divider). */
  a: CompareSide;
  b: CompareSide;
}

/** The picture URL of an order (`…/colour-order/<order>.png[?…]`) → its document's (`….json[?…]`), the query kept. */
export function orderDocumentUrl(pictureUrl: string): string {
  return pictureUrl.replace(/\.png(?=\?|$)/, ".json");
}

/**
 * The pairs the panel offers: `use` — the document in use against the
 * reviewed one, when a pin exists; `order` — the reviewed document's IOF
 * order against the map's own order, always. The reviewed document is its
 * own order's side; the other order's side is asked of its route, with the
 * picture's query (the map's overrides on a `source` document's IOF side).
 */
export function comparePairs(input: {
  documentHash: string;
  pinnedHash: string | null | undefined;
  colour: { order: ColourOrder; pictures: Record<ColourOrder, string> };
}): { use: ComparePair | null; order: ComparePair } {
  const { documentHash, pinnedHash, colour } = input;
  const side = (o: ColourOrder): CompareSide => (colour.order === o ? { hash: documentHash, label: o } : { url: orderDocumentUrl(colour.pictures[o]), label: o });
  return {
    use: pinnedHash ? { kind: "use", a: { hash: pinnedHash, label: "inUse" }, b: { hash: documentHash, label: "thisVersion" } } : null,
    order: { kind: "order", a: side("iof"), b: side("source") },
  };
}

/** The pair the Compare button opens: `use` when something else is in use, else `order`. */
export function defaultComparePair(input: { documentHash: string; pinnedHash: string | null | undefined }): ComparePairKind {
  return input.pinnedHash && input.pinnedHash !== input.documentHash ? "use" : "order";
}

// ─── Query state (`?compare=use|order&mode=side|swipe|diff`) ─

export interface CompareQuery {
  pair: ComparePairKind;
  mode: CompareMode;
}

export function parseCompareQuery(params: URLSearchParams): CompareQuery | null {
  const pair = params.get("compare");
  if (pair !== "use" && pair !== "order") return null;
  const mode = params.get("mode");
  return { pair, mode: mode === "swipe" || mode === "diff" ? mode : "side" };
}

/** A copy of `params` with the view's state written (`side` is the default and not written), or removed for `null`. */
export function withCompareQuery(params: URLSearchParams, q: CompareQuery | null): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("compare");
  next.delete("mode");
  if (q) {
    next.set("compare", q.pair);
    if (q.mode !== "side") next.set("mode", q.mode);
  }
  return next;
}

// ─── The divider and the flip ────────────────────────────────

export interface CompareState {
  /** Swipe: the divider's place across the pane, 0–1; A is drawn left of it, B right. */
  divider: number;
}

export type CompareAction = { type: "divider"; at: number } | { type: "flip" };

export const initialCompareState = (): CompareState => ({ divider: 0.5 });

/** A flip (Space or **Flip**) shows whole the document the divider hides more — B from the middle — and the next flip the other. */
export function compareReducer(s: CompareState, a: CompareAction): CompareState {
  switch (a.type) {
    case "divider":
      return Number.isFinite(a.at) ? { ...s, divider: Math.max(0, Math.min(1, a.at)) } : s;
    case "flip":
      return { ...s, divider: s.divider >= 0.5 ? 0 : 1 };
  }
}

// ─── One camera ──────────────────────────────────────────────

/** The panes: two side by side on a wide view, stacked on a tall one; one in swipe and in diff. CSS px. */
export function compareLayout(w: number, h: number, mode: CompareMode): { direction: "row" | "column" | "single"; paneW: number; paneH: number } {
  if (mode !== "side") return { direction: "single", paneW: w, paneH: h };
  return w >= h ? { direction: "row", paneW: Math.floor(w / 2), paneH: h } : { direction: "column", paneW: w, paneH: Math.floor(h / 2) };
}

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/** The camera the view opens on: the union of the two documents' bounds (paper mm) fitted into one pane. */
export function compareFit(a: Bounds | null, b: Bounds | null, paneW: number, paneH: number): PaperViewport {
  const all = [a, b].filter((x): x is Bounds => x !== null);
  const u = all.length
    ? { minX: Math.min(...all.map((x) => x.minX)), minY: Math.min(...all.map((x) => x.minY)), maxX: Math.max(...all.map((x) => x.maxX)), maxY: Math.max(...all.map((x) => x.maxY)) }
    : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return fitMm(u, paneW, paneH, 0.04);
}

/** log2 of the zoom per wheel tick, as the map viewer's. */
const WHEEL_STEP = 0.15;

export type PaneGesture =
  | { type: "drag"; dx: number; dy: number }
  | { type: "wheel"; x: number; y: number; deltaY: number }
  /** Two fingers: the midpoint was (x, y) and is now (tx, ty); the distance grew by `scale`. */
  | { type: "pinch"; x: number; y: number; scale: number; tx: number; ty: number };

/** The camera after a gesture in a pane of `ctx` CSS px (pane coordinates): either pane moves both. */
export function paneGesture(vp: PaperViewport, ctx: { w: number; h: number }, g: PaneGesture): PaperViewport {
  const vctx = { w: ctx.w, h: ctx.h, frame: null };
  switch (g.type) {
    case "drag":
      return panBy(vp, g.dx, g.dy);
    case "wheel":
      return g.deltaY === 0 ? vp : zoomAt(vp, vctx, g.x, g.y, g.deltaY > 0 ? -WHEEL_STEP : WHEEL_STEP);
    case "pinch":
      return zoomAt(vp, vctx, g.x, g.y, Math.log2(g.scale > 0 ? g.scale : 1), g.tx, g.ty);
  }
}
