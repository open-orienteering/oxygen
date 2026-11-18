/**
 * The review page's compare view (docs/map-symbols.md §8.7 "Compare", row
 * I8a): two versions of a map as live vector maps over one paper camera —
 * side by side, or stacked in one pane with a swipe divider and a flip.
 * Read-only: nothing is pinned or rebuilt from it. A full-viewport overlay
 * owned by the review page; its state is in the page's query
 * (`lib/map-compare.ts`).
 *
 * Each side is a document hash, or the other order's document asked of
 * `GET …/colour-order/:order.json` (docs/map-storage.md §4.5), retried
 * while it answers 503. Documents load through `useMapDocument` (§4.2);
 * each is drawn by its own `VectorMapLayer` on the `club` budget, without
 * a course or a patch.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { VectorMapLayer, MapLayerMessage } from "../VectorMapLayer";
import { useMapDocument, type MapDocumentState } from "../../lib/map-document-cache";
import { glView, type PaperViewport } from "../../lib/map-viewport";
import { boundsMm } from "../../lib/vector-map";
import { scopePreviewUrl } from "../../lib/map-review";
import {
  compareFit,
  compareLayout,
  compareReducer,
  initialCompareState,
  paneGesture,
  type CompareMode,
  type ComparePair,
  type ComparePairKind,
  type CompareQuery,
  type CompareSide,
  type PaneGesture,
} from "../../lib/map-compare";

/** The other order's route answers 503 while it imports: ask again every few seconds, for a while (as the picture). */
const ORDER_RETRY_MS = 5_000;
const ORDER_RETRIES = 36;

type SideHash = { status: "ready"; hash: string } | { status: "importing" } | { status: "failed" };

/** The hash of one side: given, or asked of the other order's route. */
function useSideHash(side: CompareSide, nameId: string | null): SideHash {
  const url = "url" in side ? scopePreviewUrl(side.url, nameId) ?? side.url : null;
  const given = "hash" in side ? side.hash : null;
  // The answer for the URL it was asked for: a new URL is importing until its own answer comes.
  const [answer, setAnswer] = useState<{ url: string; state: SideHash } | null>(null);
  useEffect(() => {
    if (given || !url) return;
    let cancelled = false;
    let timer: number | undefined;
    const setState = (state: SideHash) => setAnswer({ url, state });
    const ask = async (attempt: number): Promise<void> => {
      try {
        const res = await fetch(url, { credentials: "same-origin", headers: nameId ? { "x-event-id": nameId } : {} });
        if (cancelled) return;
        if (res.ok) {
          const body = (await res.json()) as { documentHash?: unknown };
          if (!cancelled) setState(typeof body.documentHash === "string" ? { status: "ready", hash: body.documentHash } : { status: "failed" });
          return;
        }
        if (res.status === 503 && attempt < ORDER_RETRIES) {
          timer = window.setTimeout(() => void ask(attempt + 1), ORDER_RETRY_MS);
          return;
        }
      } catch {
        if (cancelled) return;
      }
      if (!cancelled) setState({ status: "failed" });
    };
    void ask(0);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [given, url, nameId]);
  if (given) return { status: "ready", hash: given };
  return answer && answer.url === url ? answer.state : { status: "importing" };
}

interface LoadedSide {
  side: CompareSide;
  hash: string | null;
  doc: MapDocumentState;
  importing: boolean;
  failed: boolean;
  retry: () => void;
}

function useSide(side: CompareSide, nameId: string | null): LoadedSide {
  const h = useSideHash(side, nameId);
  const hash = h.status === "ready" ? h.hash : null;
  const { state, retry } = useMapDocument(hash, nameId);
  return { side, hash, doc: state, importing: h.status === "importing", failed: h.status === "failed" || state.status === "error", retry };
}

/** The pane's size, CSS px. */
function useSize(): [React.RefObject<HTMLDivElement | null>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** Wheel, drag and pinch over a pane, as camera gestures in its coordinates. */
function usePaneGestures(ref: React.RefObject<HTMLDivElement | null>, onGesture: (g: PaneGesture) => void) {
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef(onGesture);
  useLayoutEffect(() => {
    gesture.current = onGesture;
  }, [onGesture]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const local = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      gesture.current({ type: "wheel", ...local(e), deltaY: e.deltaY });
    };
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest("[data-compare-control]")) return;
      el.setPointerCapture(e.pointerId);
      pointers.current.set(e.pointerId, local(e));
    };
    const onMove = (e: PointerEvent) => {
      const ps = pointers.current;
      const prev = ps.get(e.pointerId);
      if (!prev) return;
      const next = local(e);
      if (ps.size === 1) {
        ps.set(e.pointerId, next);
        gesture.current({ type: "drag", dx: next.x - prev.x, dy: next.y - prev.y });
        return;
      }
      const [other] = [...ps.entries()].filter(([id]) => id !== e.pointerId).map(([, p]) => p);
      if (!other) return;
      ps.set(e.pointerId, next);
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y), d1 = Math.hypot(next.x - other.x, next.y - other.y);
      gesture.current({ type: "pinch", x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2, scale: d0 > 0 ? d1 / d0 : 1, tx: (next.x + other.x) / 2, ty: (next.y + other.y) / 2 });
    };
    const onUp = (e: PointerEvent) => {
      pointers.current.delete(e.pointerId);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, [ref]);
}

const viewAttr = (vp: PaperViewport | null) => (vp ? `${vp.centreX.toFixed(1)},${vp.centreY.toFixed(1)},${vp.pxPerUm.toPrecision(6)}` : "");

/** One side's layer, or what stands in its place while it loads. */
function SideLayer({ s, vp, w, h, zIndex }: { s: LoadedSide; vp: PaperViewport | null; w: number; h: number; zIndex?: number }) {
  const { t } = useTranslation("mapReview");
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const view = useMemo(() => (vp && w > 0 && h > 0 ? glView(vp, w, h, dpr, 0) : null), [vp, w, h, dpr]);
  if (s.failed) return <MapLayerMessage message={t("colours.compare.failed")} onRetry={s.doc.status === "error" ? s.retry : undefined} retryLabel={t("colours.compare.retry")} />;
  if (s.doc.status !== "ready") {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500" style={{ zIndex }}>
        {t(s.importing ? "colours.compare.importing" : "colours.compare.loading")}
      </div>
    );
  }
  return <VectorMapLayer doc={s.doc.doc} view={view} width={w} height={h} budget="club" zIndex={zIndex} />;
}

export function CompareView({
  pairs,
  query,
  nameId,
  onChange,
}: {
  pairs: { use: ComparePair | null; order: ComparePair };
  query: CompareQuery;
  /** The event's name id on the event route: documents and the order route are claimed through it. */
  nameId: string | null;
  /** A new pair or mode; `null` closes the view. */
  onChange: (q: CompareQuery | null) => void;
}) {
  const { t } = useTranslation("mapReview");
  const label = (s: CompareSide) => t(`colours.compare.side.${s.label}`);
  const pairKind: ComparePairKind = query.pair === "use" && pairs.use ? "use" : "order";
  const pair = pairKind === "use" ? pairs.use! : pairs.order;
  const a = useSide(pair.a, nameId);
  const b = useSide(pair.b, nameId);
  const [bodyRef, size] = useSize();
  const layout = compareLayout(size.w, size.h, query.mode);
  const [state, dispatch] = useReducer(compareReducer, undefined, initialCompareState);
  const [vp, setVp] = useState<PaperViewport | null>(null);
  const aDoc = a.doc.status === "ready" ? a.doc.doc : null;
  const bDoc = b.doc.status === "ready" ? b.doc.doc : null;

  const fit = useCallback(() => {
    if (!aDoc && !bDoc) return;
    if (layout.paneW <= 0 || layout.paneH <= 0) return;
    setVp(compareFit(aDoc ? boundsMm(aDoc.header) : null, bDoc ? boundsMm(bDoc.header) : null, layout.paneW, layout.paneH));
  }, [aDoc, bDoc, layout.paneW, layout.paneH]);

  // Opened (and on a new pair) fitted to the union of the two bounds, once both are known; then the camera is the user's.
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    const key = `${pairKind}:${aDoc?.hash ?? ""}:${bDoc?.hash ?? ""}`;
    if (!aDoc || !bDoc || layout.paneW <= 0 || fittedFor.current === key) return;
    fittedFor.current = key;
    fit();
  }, [pairKind, aDoc, bDoc, layout.paneW, fit]);

  const onGesture = useCallback(
    (g: PaneGesture) => setVp((v) => (v ? paneGesture(v, { w: layout.paneW, h: layout.paneH }, g) : v)),
    [layout.paneW, layout.paneH],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onChange(null);
      } else if (e.key === " " && query.mode === "swipe" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        dispatch({ type: "flip" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onChange, query.mode]);

  const same = a.hash !== null && a.hash === b.hash;
  const setMode = (mode: CompareMode) => onChange({ pair: pairKind, mode });
  const showing = state.divider <= 0 ? "b" : state.divider >= 1 ? "a" : "split";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("colours.compare.title")}
      data-testid="compare-view"
      data-pair={pairKind}
      data-mode={query.mode}
      className="fixed inset-0 z-50 flex flex-col bg-white"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-2 text-sm">
        <h2 className="font-semibold text-slate-900">{t("colours.compare.title")}</h2>
        <div role="group" aria-label={t("colours.compare.pair.label")} className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
          {(["use", "order"] as const).map((k) =>
            k === "use" && !pairs.use ? null : (
              <button
                key={k}
                type="button"
                data-testid={`compare-pair-${k}`}
                aria-pressed={pairKind === k}
                className={`px-3 py-1 cursor-pointer ${pairKind === k ? "bg-blue-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50"}`}
                onClick={() => onChange({ pair: k, mode: query.mode })}
              >
                {t(`colours.compare.pair.${k}`)}
              </button>
            ),
          )}
        </div>
        <div role="group" aria-label={t("colours.compare.mode.label")} className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
          {(["side", "swipe"] as const).map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`compare-mode-${m}`}
              aria-pressed={query.mode === m}
              className={`px-3 py-1 cursor-pointer ${query.mode === m ? "bg-blue-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50"}`}
              onClick={() => setMode(m)}
            >
              {t(`colours.compare.mode.${m}`)}
            </button>
          ))}
        </div>
        {query.mode === "swipe" && (
          <button type="button" data-testid="compare-flip" title={t("colours.compare.flipHint")} className="rounded border border-slate-300 px-3 py-1 cursor-pointer hover:bg-slate-50" onClick={() => dispatch({ type: "flip" })}>
            {t("colours.compare.flip")}
          </button>
        )}
        <button type="button" data-testid="compare-fit" className="rounded border border-slate-300 px-3 py-1 cursor-pointer hover:bg-slate-50" onClick={fit}>
          {t("colours.compare.fit")}
        </button>
        {same && (
          <span data-testid="compare-same" className="text-amber-800">
            {t("colours.compare.same")}
          </span>
        )}
        <button type="button" data-testid="compare-close" className="ml-auto rounded bg-slate-800 px-3 py-1 text-white cursor-pointer hover:bg-slate-700" onClick={() => onChange(null)}>
          {t("colours.compare.close")}
        </button>
      </div>

      <div ref={bodyRef} className={`relative flex-1 min-h-0 flex ${layout.direction === "column" ? "flex-col" : "flex-row"}`}>
        {size.w > 0 &&
          (query.mode === "side" ? (
            <>
              <Pane testSide="a" s={a} vp={vp} w={layout.paneW} h={layout.paneH} onGesture={onGesture} labelText={label(pair.a)} border={layout.direction} />
              <Pane testSide="b" s={b} vp={vp} w={layout.paneW} h={layout.paneH} onGesture={onGesture} labelText={label(pair.b)} />
            </>
          ) : (
            <SwipePane a={a} b={b} vp={vp} w={layout.paneW} h={layout.paneH} onGesture={onGesture} divider={state.divider} showing={showing} onDivider={(at) => dispatch({ type: "divider", at })} labels={[label(pair.a), label(pair.b)]} />
          ))}
      </div>
    </div>
  );
}

function Pane({ testSide, s, vp, w, h, onGesture, labelText, border }: { testSide: "a" | "b"; s: LoadedSide; vp: PaperViewport | null; w: number; h: number; onGesture: (g: PaneGesture) => void; labelText: string; border?: "row" | "column" | "single" }) {
  const ref = useRef<HTMLDivElement>(null);
  usePaneGestures(ref, onGesture);
  return (
    <div
      ref={ref}
      data-testid="compare-pane"
      data-side={testSide}
      data-document-hash={s.hash ?? ""}
      data-view={viewAttr(vp)}
      className={`relative overflow-hidden bg-white cursor-grab ${border === "row" ? "border-r border-slate-300" : border === "column" ? "border-b border-slate-300" : ""}`}
      style={{ width: w, height: h, touchAction: "none" }}
    >
      <SideLayer s={s} vp={vp} w={w} h={h} />
      <span className="absolute left-2 top-2 z-10 rounded bg-white/90 px-2 py-0.5 text-xs font-medium text-slate-800 shadow pointer-events-none">{labelText}</span>
    </div>
  );
}

function SwipePane({ a, b, vp, w, h, onGesture, divider, showing, onDivider, labels }: { a: LoadedSide; b: LoadedSide; vp: PaperViewport | null; w: number; h: number; onGesture: (g: PaneGesture) => void; divider: number; showing: "a" | "b" | "split"; onDivider: (at: number) => void; labels: [string, string] }) {
  const { t } = useTranslation("mapReview");
  const ref = useRef<HTMLDivElement>(null);
  usePaneGestures(ref, onGesture);
  const dragging = useRef(false);
  const at = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    return r && r.width > 0 ? (clientX - r.left) / r.width : divider;
  };
  return (
    <div
      ref={ref}
      data-testid="compare-pane"
      data-side="swipe"
      data-showing={showing}
      data-divider={divider.toFixed(3)}
      data-view={viewAttr(vp)}
      className="relative overflow-hidden bg-white cursor-grab"
      style={{ width: w, height: h, touchAction: "none" }}
    >
      <div data-testid="compare-layer-b" data-document-hash={b.hash ?? ""} className="absolute inset-0" style={{ zIndex: 1 }}>
        <SideLayer s={b} vp={vp} w={w} h={h} />
      </div>
      {/* A is drawn left of the divider: the right of its layer is clipped away. */}
      <div data-testid="compare-layer-a" data-document-hash={a.hash ?? ""} className="absolute inset-0" style={{ zIndex: 2, clipPath: `inset(0 ${((1 - divider) * 100).toFixed(3)}% 0 0)` }}>
        <SideLayer s={a} vp={vp} w={w} h={h} />
      </div>
      <div
        data-compare-control
        data-testid="compare-divider"
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(divider * 100)}
        aria-label={t("colours.compare.divider")}
        className="absolute top-0 bottom-0 z-20 -ml-3 w-6 cursor-ew-resize flex justify-center"
        style={{ left: divider * w, touchAction: "none" }}
        onPointerDown={(e) => {
          e.stopPropagation();
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (dragging.current) onDivider(at(e.clientX));
        }}
        onPointerUp={() => { dragging.current = false; }}
        onPointerCancel={() => { dragging.current = false; }}
      >
        <span className="h-full w-0.5 bg-blue-600 shadow" />
      </div>
      {showing !== "b" && <span className="absolute left-2 top-2 z-30 rounded bg-white/90 px-2 py-0.5 text-xs font-medium text-slate-800 shadow pointer-events-none">{labels[0]}</span>}
      {showing !== "a" && <span className="absolute right-2 top-2 z-30 rounded bg-white/90 px-2 py-0.5 text-xs font-medium text-slate-800 shadow pointer-events-none">{labels[1]}</span>}
    </div>
  );
}
