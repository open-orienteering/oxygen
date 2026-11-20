import { describe, expect, it } from "vitest";
import {
  compareFit,
  compareLayout,
  comparePairs,
  compareReducer,
  defaultComparePair,
  initialCompareState,
  orderDocumentUrl,
  paneGesture,
  parseCompareQuery,
  withCompareQuery,
} from "../map-compare";

const A = "a".repeat(64);
const B = "b".repeat(64);
const pictures = (hash: string) => ({ iof: `/api/map-documents/${hash}/colour-order/iof.png?deviations=x%3Ekeep`, source: `/api/map-documents/${hash}/colour-order/source.png` });

describe("the compare view's pairs (docs/map-symbols.md §8.7 \"Compare\")", () => {
  it("offers `use` only with a pin, `order` always; each side a hash or the other order's document URL", () => {
    const iof = comparePairs({ documentHash: B, pinnedHash: A, colour: { order: "iof", pictures: pictures(B) } });
    expect(iof.use).toEqual({ kind: "use", a: { hash: A, label: "inUse" }, b: { hash: B, label: "thisVersion" } });
    expect(iof.order).toEqual({
      kind: "order",
      a: { hash: B, label: "iof" },
      b: { url: `/api/map-documents/${B}/colour-order/source.json`, label: "source" },
    });
    const source = comparePairs({ documentHash: B, pinnedHash: null, colour: { order: "source", pictures: pictures(B) } });
    expect(source.use).toBeNull();
    // A `source` document's IOF side carries the map's overrides, as its picture does.
    expect(source.order.a).toEqual({ url: `/api/map-documents/${B}/colour-order/iof.json?deviations=x%3Ekeep`, label: "iof" });
    expect(source.order.b).toEqual({ hash: B, label: "source" });
    expect(comparePairs({ documentHash: B, pinnedHash: undefined, colour: { order: "iof", pictures: pictures(B) } }).use).toBeNull();
  });

  it("opens on `use` when the pin differs from the reviewed document, else on `order`", () => {
    expect(defaultComparePair({ documentHash: B, pinnedHash: A })).toBe("use");
    expect(defaultComparePair({ documentHash: B, pinnedHash: B })).toBe("order");
    expect(defaultComparePair({ documentHash: B, pinnedHash: null })).toBe("order");
    expect(defaultComparePair({ documentHash: B, pinnedHash: undefined })).toBe("order");
  });

  it("turns a picture URL into its document URL, keeping the query", () => {
    expect(orderDocumentUrl(`/api/map-documents/${A}/colour-order/iof.png`)).toBe(`/api/map-documents/${A}/colour-order/iof.json`);
    expect(orderDocumentUrl(`/api/map-documents/${A}/colour-order/iof.png?deviations=a%3Ekeep&event=x`)).toBe(`/api/map-documents/${A}/colour-order/iof.json?deviations=a%3Ekeep&event=x`);
  });
});

describe("the compare view's query state", () => {
  it("reads `compare` and `mode`, dropping unknown values", () => {
    expect(parseCompareQuery(new URLSearchParams(""))).toBeNull();
    expect(parseCompareQuery(new URLSearchParams("compare=use"))).toEqual({ pair: "use", mode: "side" });
    expect(parseCompareQuery(new URLSearchParams("compare=order&mode=swipe"))).toEqual({ pair: "order", mode: "swipe" });
    expect(parseCompareQuery(new URLSearchParams("compare=order&mode=nonsense"))).toEqual({ pair: "order", mode: "side" });
    expect(parseCompareQuery(new URLSearchParams("compare=use&mode=diff"))).toEqual({ pair: "use", mode: "diff" });
    expect(parseCompareQuery(new URLSearchParams("compare=nonsense"))).toBeNull();
  });

  it("writes it beside the page's other parameters, and removes it on close", () => {
    const base = new URLSearchParams("clubMap=m1");
    const open = withCompareQuery(base, { pair: "order", mode: "swipe" });
    expect(open.toString()).toBe("clubMap=m1&compare=order&mode=swipe");
    expect(withCompareQuery(open, { pair: "use", mode: "side" }).toString()).toBe("clubMap=m1&compare=use");
    expect(withCompareQuery(open, null).toString()).toBe("clubMap=m1");
    expect(withCompareQuery(base, { pair: "use", mode: "diff" }).toString()).toBe("clubMap=m1&compare=use&mode=diff");
    expect(base.toString()).toBe("clubMap=m1");
  });
});

describe("the divider and the flip", () => {
  it("starts in the middle; the divider stays inside the pane", () => {
    const s = initialCompareState();
    expect(s.divider).toBe(0.5);
    expect(compareReducer(s, { type: "divider", at: 0.3 }).divider).toBe(0.3);
    expect(compareReducer(s, { type: "divider", at: -1 }).divider).toBe(0);
    expect(compareReducer(s, { type: "divider", at: 7 }).divider).toBe(1);
    expect(compareReducer(s, { type: "divider", at: Number.NaN }).divider).toBe(0.5);
  });

  it("a flip shows one document whole, the next the other", () => {
    let s = initialCompareState();
    s = compareReducer(s, { type: "flip" });
    expect(s.divider).toBe(0); // all B
    s = compareReducer(s, { type: "flip" });
    expect(s.divider).toBe(1); // all A
    s = compareReducer(s, { type: "flip" });
    expect(s.divider).toBe(0);
    expect(compareReducer({ divider: 0.8 }, { type: "flip" }).divider).toBe(0);
    expect(compareReducer({ divider: 0.2 }, { type: "flip" }).divider).toBe(1);
  });
});

describe("one camera for both panes", () => {
  it("lays the panes out side by side on a wide view, stacked on a tall one, one pane in swipe", () => {
    expect(compareLayout(1000, 600, "side")).toEqual({ direction: "row", paneW: 500, paneH: 600 });
    expect(compareLayout(400, 800, "side")).toEqual({ direction: "column", paneW: 400, paneH: 400 });
    expect(compareLayout(1000, 600, "swipe")).toEqual({ direction: "single", paneW: 1000, paneH: 600 });
    expect(compareLayout(400, 800, "diff")).toEqual({ direction: "single", paneW: 400, paneH: 800 });
  });

  it("fits the union of the two documents' bounds into a pane", () => {
    const vp = compareFit({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, { minX: 50, minY: -50, maxX: 200, maxY: 0 }, 500, 500);
    expect(vp.centreX).toBe(100_000);
    expect(vp.centreY).toBe(0);
    // 200 mm wide and 100 mm high into 500 px less the padding: the width decides.
    expect(vp.pxPerUm).toBeCloseTo((500 * 0.92) / 200_000, 9);
    expect(compareFit(null, { minX: 0, minY: 0, maxX: 10, maxY: 10 }, 100, 100).centreX).toBe(5_000);
  });

  it("moves the one camera by a drag and keeps the point under the wheel, in any pane", () => {
    const vp = { centreX: 0, centreY: 0, pxPerUm: 0.01 };
    const ctx = { w: 400, h: 300 };
    expect(paneGesture(vp, ctx, { type: "drag", dx: 10, dy: -20 })).toEqual({ centreX: -1000, centreY: -2000, pxPerUm: 0.01 });
    const zoomed = paneGesture(vp, ctx, { type: "wheel", x: 300, y: 150, deltaY: -100 });
    expect(zoomed.pxPerUm).toBeGreaterThan(0.01);
    // The point under (300, 150) — 10 000 µm right of the centre — stays there.
    expect(zoomed.centreX + (300 - 200) / zoomed.pxPerUm).toBeCloseTo(10_000, 6);
    expect(paneGesture(vp, ctx, { type: "wheel", x: 300, y: 150, deltaY: 100 }).pxPerUm).toBeLessThan(0.01);
    const pinched = paneGesture(vp, ctx, { type: "pinch", x: 200, y: 150, scale: 2, tx: 210, ty: 150 });
    expect(pinched.pxPerUm).toBeCloseTo(0.02, 9);
    expect(pinched.centreX).toBeCloseTo(-500, 6);
  });
});
