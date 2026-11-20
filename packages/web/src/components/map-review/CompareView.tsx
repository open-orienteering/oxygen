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
import type { FrameReader } from "../../map-gl/readback";
import { binCells, changedMask, overlayPixels, regionsOf, scanGrid, stepIndex, stepViewport, type CellCounts, type DiffRegion } from "../../lib/map-compare-diff";
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
function useSideHash(side: CompareSide, nameId: string | null): SideHash & { retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const url = "url" in side ? scopePreviewUrl(side.url, nameId) ?? side.url : null;
  const given = "hash" in side ? side.hash : null;
  // The answer for the URL it was asked for: a new URL is importing until its own answer comes.
  const [answer, setAnswer] = useState<{ url: string; attempt: number; state: SideHash } | null>(null);
  useEffect(() => {
    if (given || !url) return;
    let cancelled = false;
    let timer: number | undefined;
    const setState = (state: SideHash) => setAnswer({ url, attempt, state });
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
  }, [given, url, nameId, attempt]);
  if (given) return { status: "ready", hash: given, retry };
  return { ...(answer && answer.url === url && answer.attempt === attempt ? answer.state : { status: "importing" as const }), retry };
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
  return { side, hash, doc: state, importing: h.status === "importing", failed: h.status === "failed" || state.status === "error", retry: h.status === "failed" ? h.retry : retry };
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
function SideLayer({ s, vp, w, h, zIndex, onFrameReader, maxDpr, hidden }: { s: LoadedSide; vp: PaperViewport | null; w: number; h: number; zIndex?: number; onFrameReader?: (read: FrameReader | null) => void; maxDpr?: number; hidden?: boolean }) {
  const { t } = useTranslation("mapReview");
  const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, maxDpr ?? Infinity);
  const view = useMemo(() => (vp && w > 0 && h > 0 ? glView(vp, w, h, dpr, 0) : null), [vp, w, h, dpr]);
  if (s.failed) return <MapLayerMessage message={t("colours.compare.failed")} onRetry={s.retry} retryLabel={t("colours.compare.retry")} />;
  if (s.doc.status !== "ready") {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500" style={{ zIndex }}>
        {t(s.importing ? "colours.compare.importing" : "colours.compare.loading")}
      </div>
    );
  }
  return <VectorMapLayer doc={s.doc.doc} view={view} width={w} height={h} budget="club" zIndex={zIndex} onFrameReader={onFrameReader} hidden={hidden} />;
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

  // Opened (and on a new pair) fitted to the union of the two bounds, once both are known — or to the one, when the
  // other has failed; then the camera is the user's.
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    const key = `${pairKind}:${aDoc?.hash ?? ""}:${bDoc?.hash ?? ""}`;
    const known = (aDoc || a.failed) && (bDoc || b.failed) && (aDoc || bDoc);
    if (!known || layout.paneW <= 0 || fittedFor.current === key) return;
    fittedFor.current = key;
    fit();
  }, [pairKind, aDoc, bDoc, a.failed, b.failed, layout.paneW, fit]);

  // Diff (row I8b): the two layers' frame readers while the diff pane is up; the scan per pair, kept across modes.
  const [readers, setReaders] = useState<{ a: FrameReader | null; b: FrameReader | null }>({ a: null, b: null });
  const union = useMemo(() => unionBounds(aDoc ? boundsMm(aDoc.header) : null, bDoc ? boundsMm(bDoc.header) : null), [aDoc, bDoc]);
  const moved = useRef(0);
  const { scan, retry: retryScan } = useDiffScan(query.mode === "diff" && a.hash && b.hash ? `${a.hash}:${b.hash}` : null, readers, union, moved);
  // Any camera change counts as movement for the scan's stillness (gestures, Fit, a step, a resize).
  useEffect(() => {
    moved.current = Date.now();
  }, [vp, layout.paneW, layout.paneH]);
  const [region, setRegion] = useState<{ key: string; index: number } | null>(null);
  const regionIndex = region && scan && region.key === scan.key ? region.index : null;
  const step = (dir: 1 | -1) => {
    if (!scan || scan.state !== "done" || !union) return;
    const index = stepIndex(regionIndex, scan.regions.length, dir);
    if (index === null) return;
    setRegion({ key: scan.key, index });
    setVp(stepViewport(scan.regions[index]!, union, layout.paneW, layout.paneH));
  };

  const onGesture = useCallback(
    (g: PaneGesture) => {
      moved.current = Date.now();
      setVp((v) => (v ? paneGesture(v, { w: layout.paneW, h: layout.paneH }, g) : v));
    },
    [layout.paneW, layout.paneH],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onChange(null);
      } else if (isFlipKey(e)) {
        // Whatever has focus: a focused toolbar button's own Space activation is cancelled (keydown and keyup).
        e.preventDefault();
        if (!e.repeat) dispatch({ type: "flip" });
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isFlipKey(e)) e.preventDefault();
    };
    const isFlipKey = (e: KeyboardEvent) => e.key === " " && query.mode === "swipe" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
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
          {(["side", "swipe", "diff"] as const).map((m) => (
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
        {query.mode === "diff" && <DiffSteps scan={scan} region={regionIndex} onStep={step} onRetry={retryScan} />}
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
          ) : query.mode === "diff" ? (
            <DiffPane a={a} b={b} vp={vp} w={layout.paneW} h={layout.paneH} onGesture={onGesture} onReaders={setReaders} label={label(pair.b)} />
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

// ─── Diff (row I8b) ──────────────────────────────────────────

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (!a || !b) return a ?? b;
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

/** The camera must have been still this long before a diff is drawn or a scan tile read. */
const STILL_MS = 150;
/** The pane's diff is read at device px, the ratio capped (the 4× MSAA target's memory). */
const DIFF_MAX_DPR = 2;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

type DiffScan =
  | { key: string; state: "scanning"; done: number; total: number }
  | { key: string; state: "done"; regions: DiffRegion[] }
  | { key: string; state: "failed" };

/** Two animation frames: the layers draw the frame a read made them skip before the next tile starts. */
const yieldFrames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/**
 * The whole-map scan of a pair, once on first entry (§8.7 "Compare — diff"): both documents read over the union
 * bounds in tiles, without the screen-only skips (user 2026-11-18), changed pixels binned into cells, the regions.
 * A tile waits until the camera has been still 150 ms, and the layers get their own frames between tiles. A scan
 * that stops part way (a mode switch, a reader that goes) is dropped and starts over when both readers are back; a
 * failed one says so and is tried again on `retry`. Kept per pair across modes.
 */
function useDiffScan(key: string | null, readers: { a: FrameReader | null; b: FrameReader | null }, bounds: Bounds | null, moved: React.RefObject<number>): { scan: DiffScan | null; retry: () => void } {
  const [scans, setScans] = useState<Record<string, DiffScan>>({});
  const { a, b } = readers;
  const current = key ? scans[key] : undefined;
  const needed = !!key && !!a && !!b && !!bounds && current?.state !== "done" && current?.state !== "failed";
  useEffect(() => {
    if (!needed || !key || !a || !b || !bounds) return;
    let cancelled = false;
    let finished = false;
    const grid = scanGrid(bounds);
    const cells: CellCounts = new Map();
    const put = (scan: DiffScan) => setScans((m) => ({ ...m, [key]: scan }));
    void (async () => {
      put({ key, state: "scanning", done: 0, total: grid.tiles.length });
      for (const [i, tile] of grid.tiles.entries()) {
        while (!cancelled && Date.now() - moved.current < STILL_MS) await sleep(STILL_MS);
        if (cancelled) return;
        const [fa, fb] = await Promise.all([a(tile.view, { lod: false }), b(tile.view, { lod: false })]);
        if (cancelled) return;
        const m = changedMask(fa, fb);
        if (!m) throw new Error(`scan tile ${tile.col},${tile.row}: frames of different sizes`);
        binCells(cells, m.mask, fa.width, tile, grid.pxPerMm, bounds);
        put({ key, state: "scanning", done: i + 1, total: grid.tiles.length });
        await yieldFrames();
      }
      if (cancelled) return;
      finished = true;
      put({ key, state: "done", regions: regionsOf(cells) });
    })().catch((err: unknown) => {
      if (cancelled) return;
      console.warn("[compare] difference scan failed:", err);
      finished = true;
      put({ key, state: "failed" });
    });
    return () => {
      cancelled = true;
      // Stopped part way: no "scanning" row is left behind; the next entry scans again.
      if (!finished) setScans((m) => {
        if (m[key]?.state !== "scanning") return m;
        const next = { ...m };
        delete next[key];
        return next;
      });
    };
  }, [needed, key, a, b, bounds, moved]);
  const retry = useCallback(() => {
    if (!key) return;
    setScans((m) => {
      const next = { ...m };
      delete next[key];
      return next;
    });
  }, [key]);
  return { scan: current ?? null, retry };
}

function DiffSteps({ scan, region, onStep, onRetry }: { scan: DiffScan | null; region: number | null; onStep: (dir: 1 | -1) => void; onRetry: () => void }) {
  const { t } = useTranslation("mapReview");
  const n = scan?.state === "done" ? scan.regions.length : 0;
  const enabled = scan?.state === "done" && n > 0;
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" data-testid="compare-diff-prev" disabled={!enabled} className="rounded border border-slate-300 px-2 py-1 cursor-pointer hover:bg-slate-50 disabled:opacity-50 disabled:cursor-default" onClick={() => onStep(-1)}>
        {t("colours.compare.diff.previous")}
      </button>
      <button type="button" data-testid="compare-diff-next" disabled={!enabled} className="rounded border border-slate-300 px-2 py-1 cursor-pointer hover:bg-slate-50 disabled:opacity-50 disabled:cursor-default" onClick={() => onStep(1)}>
        {t("colours.compare.diff.next")}
      </button>
      <span
        data-testid="compare-diff-status"
        data-scan={scan?.state ?? "waiting"}
        data-regions={scan?.state === "done" ? n : ""}
        data-region={region === null ? 0 : region + 1}
        className="text-slate-600 tabular-nums"
      >
        {!scan
          ? t("colours.compare.diff.waiting")
          : scan.state === "failed"
            ? (
              <span className="text-red-700">
                {t("colours.compare.diff.scanFailed")}{" "}
                <button type="button" data-testid="compare-diff-retry" className="underline cursor-pointer" onClick={onRetry}>
                  {t("colours.compare.diff.retry")}
                </button>
              </span>
            )
          : scan.state === "scanning"
            ? t("colours.compare.diff.scanning", { done: scan.done, total: scan.total })
            : n === 0
              ? <span data-testid="compare-diff-none">{t("colours.compare.diff.none")}</span>
              : t("colours.compare.diff.position", { n: region === null ? 0 : region + 1, count: n })}
      </span>
    </span>
  );
}

/**
 * One pane: the first document beneath (not shown, read only), the second drawn, and over them a 2D overlay of the
 * pixels that differ — unchanged veiled white, changed red — computed once the camera has been still for 150 ms and
 * hidden while it moves.
 */
function DiffPane({ a, b, vp, w, h, onGesture, onReaders, label }: { a: LoadedSide; b: LoadedSide; vp: PaperViewport | null; w: number; h: number; onGesture: (g: PaneGesture) => void; onReaders: (r: { a: FrameReader | null; b: FrameReader | null }) => void; label: string }) {
  const { t } = useTranslation("mapReview");
  const ref = useRef<HTMLDivElement>(null);
  usePaneGestures(ref, onGesture);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ra, setRa] = useState<FrameReader | null>(null);
  const [rb, setRb] = useState<FrameReader | null>(null);
  // A reader is a function: kept as the state itself, not called as an updater.
  const takeA = useCallback((r: FrameReader | null) => setRa(() => r), []);
  const takeB = useCallback((r: FrameReader | null) => setRb(() => r), []);
  const [overlay, setOverlay] = useState<{ state: "hidden" | "computing" | "ready" | "failed"; changed: number | null; view: string }>({ state: "hidden", changed: null, view: "" });
  useEffect(() => {
    onReaders({ a: ra, b: rb });
  }, [ra, rb, onReaders]);
  useEffect(() => () => onReaders({ a: null, b: null }), [onReaders]);

  useEffect(() => {
    if (!vp || !ra || !rb || w <= 0 || h <= 0) return;
    let cancelled = false;
    const dpr = Math.min(window.devicePixelRatio || 1, DIFF_MAX_DPR);
    const view = glView(vp, w, h, dpr, 0);
    const forView = viewAttr(vp);
    // A superseded read (the camera moved again) is dropped before it draws.
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      setOverlay((o) => ({ ...o, state: "computing" }));
      Promise.all([ra(view, { signal: ac.signal }), rb(view, { signal: ac.signal })]).then(
        ([fa, fb]) => {
          if (cancelled) return;
          const m = changedMask(fa, fb);
          const c = canvasRef.current;
          if (!m || !c) {
            setOverlay({ state: "failed", changed: null, view: forView });
            return;
          }
          c.width = fa.width;
          c.height = fa.height;
          c.getContext("2d")?.putImageData(new ImageData(overlayPixels(m.mask), fa.width, fa.height), 0, 0);
          setOverlay({ state: "ready", changed: m.changed, view: forView });
        },
        (err: unknown) => {
          if (cancelled) return;
          console.warn("[compare] diff read failed:", err);
          setOverlay({ state: "failed", changed: null, view: forView });
        },
      );
    }, STILL_MS);
    return () => {
      cancelled = true;
      ac.abort();
      window.clearTimeout(timer);
      // The camera moves (or the pane goes): the overlay hides until the next still.
      setOverlay((o) => (o.state === "hidden" ? o : { ...o, state: "hidden" }));
    };
  }, [vp, ra, rb, w, h]);

  return (
    <div ref={ref} data-testid="compare-pane" data-side="diff" data-view={viewAttr(vp)} className="relative overflow-hidden bg-white cursor-grab" style={{ width: w, height: h, touchAction: "none" }}>
      <div data-testid="compare-layer-b" data-document-hash={b.hash ?? ""} className="absolute inset-0" style={{ zIndex: 1 }}>
        <SideLayer s={b} vp={vp} w={w} h={h} onFrameReader={takeB} maxDpr={DIFF_MAX_DPR} />
      </div>
      {/* A is read, not shown: its canvas is hidden, its loading, import and failure messages are not. */}
      <div data-testid="compare-layer-a" data-document-hash={a.hash ?? ""} className="absolute inset-0 pointer-events-none" style={{ zIndex: 2 }}>
        <SideLayer s={a} vp={vp} w={w} h={h} onFrameReader={takeA} maxDpr={DIFF_MAX_DPR} hidden />
      </div>
      <canvas
        ref={canvasRef}
        data-testid="compare-diff-overlay"
        data-state={overlay.state}
        data-changed={overlay.changed ?? ""}
        data-for-view={overlay.view}
        className="absolute left-0 top-0 pointer-events-none"
        style={{ zIndex: 3, width: w, height: h, visibility: overlay.state === "ready" ? "visible" : "hidden" }}
      />
      <span className="absolute left-2 top-2 z-10 rounded bg-white/90 px-2 py-0.5 text-xs font-medium text-slate-800 shadow pointer-events-none">{label}</span>
      {overlay.state === "failed" && (
        <span data-testid="compare-diff-failed" className="absolute bottom-2 left-2 z-10 rounded bg-white/95 px-2 py-1 text-xs text-red-700 shadow pointer-events-none">
          {t("colours.compare.diff.failed")}
        </span>
      )}
    </div>
  );
}
