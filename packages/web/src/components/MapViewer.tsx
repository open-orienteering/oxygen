import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Buffer } from "buffer";
import { getDescriptionSymbols } from "../iof-symbols";

// Make Buffer available globally for ocad2geojson (it uses Buffer.isBuffer)
if (typeof globalThis.Buffer === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Buffer = Buffer;
}

// ocad2geojson is a CommonJS module
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let readOcadFn: (buf: Buffer, opts?: any) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ocadToSvgFn: (ocadFile: any, opts?: any) => any;

const ocadReady = import("ocad2geojson").then((mod) => {
  readOcadFn = mod.readOcad;
  ocadToSvgFn = mod.ocadToSvg;
});

// ─── Types ──────────────────────────────────────────────────

export interface ControlOverlay {
  id: string;
  code: string;
  x: number; // map position x (mm on map)
  y: number; // map position y (mm on map)
  type: "Start" | "Control" | "Finish";
  highlight?: boolean;
  visible?: boolean;
  punchCount?: number;
  /** Completion percentage 0–1 (undefined = no data / not enabled) */
  completionPct?: number;
  /** Punch status for mispunch visualization */
  punchStatus?: "ok" | "missing" | "extra";
}

/** A manual or automatic slit in a control circle. */
interface SlitGap {
  start: number; // degrees CW from North
  end: number;   // degrees CW from North
}

export interface CourseOverlay {
  name: string;
  controls: string[]; // ordered control IDs (including start/finish)
  highlight?: boolean;
}

interface Props {
  ocdData?: ArrayBuffer | null;
  controls?: ControlOverlay[];
  courses?: CourseOverlay[];
  highlightControlId?: string;
  highlightCourseName?: string;
  onControlClick?: (controlId: string) => void;
  className?: string;
  style?: React.CSSProperties;
  initialFitControls?: boolean;
  focusControlIds?: string[] | null;
  courseGeometry?: any; // the GeoJSON from the API
  showDescriptions?: boolean;
  onToggleFullscreen?: () => void;
  isFullscreen?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────

function mmToOcad(mm: number): number {
  return mm * 100;
}

interface Pt { x: number; y: number }

/**
 * Clip a line segment (a→b) around ALL nearby control circles.
 * Returns visible sub-segments that don't pass through any clearance zone.
 */
function clipLine(
  a: Pt, b: Pt,
  obstacles: Pt[],
  clearance: number,
): { x1: number; y1: number; x2: number; y2: number }[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return [];
  const ux = dx / len, uy = dy / len;

  // Collect blocked intervals along the line (parametric t ∈ [0, len])
  const blocks: [number, number][] = [];
  for (const obs of obstacles) {
    const vx = obs.x - a.x, vy = obs.y - a.y;
    const t = vx * ux + vy * uy; // projection along line
    const px = a.x + t * ux - obs.x;
    const py = a.y + t * uy - obs.y;
    const perpDist = Math.sqrt(px * px + py * py);
    if (perpDist < clearance) {
      const half = Math.sqrt(clearance * clearance - perpDist * perpDist);
      blocks.push([t - half, t + half]);
    }
  }

  // Merge overlapping blocks
  blocks.sort((ba, bb) => ba[0] - bb[0]);
  const merged: [number, number][] = [];
  for (const bl of blocks) {
    if (merged.length > 0 && bl[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], bl[1]);
    } else {
      merged.push([bl[0], bl[1]]);
    }
  }

  // Build sub-segments between blocked intervals, clamped to [0, len]
  const segs: { x1: number; y1: number; x2: number; y2: number }[] = [];
  let cursor = 0;
  for (const [bs, be] of merged) {
    const s0 = Math.max(cursor, 0);
    const s1 = Math.min(bs, len);
    if (s1 - s0 > 1) {
      segs.push({ x1: a.x + s0 * ux, y1: a.y + s0 * uy, x2: a.x + s1 * ux, y2: a.y + s1 * uy });
    }
    cursor = be;
  }
  const s0 = Math.max(cursor, 0);
  if (len - s0 > 1) {
    segs.push({ x1: a.x + s0 * ux, y1: a.y + s0 * uy, x2: a.x + len * ux, y2: a.y + len * uy });
  }
  return segs;
}

/** Distance from point (px,py) to line segment (ax,ay)-(bx,by), plus closest point. */
function ptSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  const ddx = px - cx, ddy = py - cy;
  return { dist: Math.sqrt(ddx * ddx + ddy * ddy), cx, cy };
}

function computeFitTransform(
  viewBox: { x: number; y: number; w: number; h: number },
  cw: number,
  ch: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
) {
  const mapScaleX = cw / viewBox.w;
  const mapScaleY = ch / viewBox.h;
  const mapScale = Math.min(mapScaleX, mapScaleY);
  const renderedW = viewBox.w * mapScale;
  const renderedH = viewBox.h * mapScale;
  const offsetX = (cw - renderedW) / 2;
  const offsetY = (ch - renderedH) / 2;

  // Guard against zero or near-zero extent (single point)
  const fitW = Math.max(maxX - minX, viewBox.w * 0.001);
  const fitH = Math.max(maxY - minY, viewBox.h * 0.001);

  const fitScaleX = cw / (fitW * mapScale);
  const fitScaleY = ch / (fitH * mapScale);
  const fitScale = Math.max(0.1, Math.min(50, Math.min(fitScaleX, fitScaleY)));

  const centerVbX = (minX + maxX) / 2;
  const centerVbY = (minY + maxY) / 2;
  const ctrlScreenX = offsetX + ((centerVbX - viewBox.x) / viewBox.w) * renderedW;
  const ctrlScreenY = offsetY + ((centerVbY - viewBox.y) / viewBox.h) * renderedH;

  return {
    x: cw / 2 - ctrlScreenX * fitScale,
    y: ch / 2 - ctrlScreenY * fitScale,
    scale: fitScale,
  };
}

// ─── Component ──────────────────────────────────────────────

export function MapViewer({
  ocdData,
  controls = [],
  courses = [],
  highlightControlId,
  highlightCourseName,
  onControlClick,
  className = "",
  style,
  initialFitControls = false,
  focusControlIds = null,
  courseGeometry,
  showDescriptions = false,
  onToggleFullscreen,
  isFullscreen = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [svgElement, setSvgElement] = useState<SVGElement | null>(null);
  const [viewBox, setViewBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [mapScale, setMapScale] = useState<number | null>(null);
  const isPanningRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });
  const hasInitialFitRef = useRef(false);
  const lastFocusKeyRef = useRef<string>("");

  // ─── Measure tool state ──────────────────────────────────
  const [measuring, setMeasuring] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<Pt[]>([]);
  const [measureCursor, setMeasureCursor] = useState<Pt | null>(null);
  const mouseDownPosRef = useRef<Pt | null>(null);
  const lastClickTimeRef = useRef(0);

  // Track container size for correct overlay calculations after resize / fullscreen
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const prevSizeRef = useRef({ w: 0, h: 0 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      const rw = Math.round(width);
      const rh = Math.round(height);
      if (rw !== prevSizeRef.current.w || rh !== prevSizeRef.current.h) {
        prevSizeRef.current = { w: rw, h: rh };
        setContainerSize({ w: rw, h: rh });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-fit when container size changes (e.g. fullscreen toggle)
  useEffect(() => {
    if (!viewBox || containerSize.w === 0 || containerSize.h === 0) return;
    // Skip the very first size report — that's handled by the initial fit
    if (!hasInitialFitRef.current) return;
    const cw = containerSize.w;
    const ch = containerSize.h;
    const visibleControls = controls.filter((c) => c.visible !== false && c.type === "Control");
    if (visibleControls.length < 2) {
      setTransform({ x: 0, y: 0, scale: 1 });
      return;
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of visibleControls) {
      const ox = mmToOcad(c.x);
      const oy = 2 * viewBox.y + viewBox.h - mmToOcad(c.y);
      minX = Math.min(minX, ox); maxX = Math.max(maxX, ox);
      minY = Math.min(minY, oy); maxY = Math.max(maxY, oy);
    }
    const m = 0.15;
    const bw = (maxX - minX) || viewBox.w * 0.1;
    const bh = (maxY - minY) || viewBox.h * 0.1;
    setTransform(computeFitTransform(viewBox, cw, ch,
      minX - bw * m, minY - bh * m, maxX + bw * m, maxY + bh * m));
  }, [containerSize]); // eslint-disable-line react-hooks/exhaustive-deps

  // Parse OCD file
  useEffect(() => {
    if (!ocdData || ocdData.byteLength === 0) {
      setSvgElement(null);
      setViewBox(null);
      return;
    }
    let cancelled = false;
    async function parse() {
      setLoading(true);
      setError(null);
      try {
        await ocadReady;
        const buffer = Buffer.from(ocdData!);
        const ocadFile = await readOcadFn(buffer, { quietWarnings: true });
        if (cancelled) return;
        // Extract map scale from OCD CRS (e.g. 10000 for 1:10000)
        try {
          const crsScale = ocadFile?.getCrs?.()?.scale;
          if (crsScale && typeof crsScale === "number" && crsScale > 0) setMapScale(crsScale);
        } catch { /* ignore */ }
        const svg = ocadToSvgFn(ocadFile, {
          document: window.document,
          generateSymbolElements: true,
          exportHidden: false,
        });
        if (cancelled) return;
        const vb = svg.getAttribute("viewBox");
        if (vb) {
          const parts = vb.split(/[\s,]+/).map(Number);
          setViewBox({ x: parts[0], y: parts[1], w: parts[2], h: parts[3] });
        }
        setSvgElement(svg);
        hasInitialFitRef.current = false;
        lastFocusKeyRef.current = "";
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to parse OCD file");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    parse();
    return () => { cancelled = true; };
  }, [ocdData]);

  // Mount SVG into DOM
  useEffect(() => {
    const container = svgContainerRef.current;
    if (!container || !svgElement) return;
    container.innerHTML = "";
    svgElement.style.width = "100%";
    svgElement.style.height = "100%";
    container.appendChild(svgElement);
    return () => { container.innerHTML = ""; };
  }, [svgElement]);

  // ─── Initial fit ──────────────────────────────────────────

  useEffect(() => {
    if (!viewBox || !containerRef.current || hasInitialFitRef.current) return;
    if (!initialFitControls) { hasInitialFitRef.current = true; return; }
    const visibleControls = controls.filter((c) => c.visible !== false && c.type === "Control");
    if (visibleControls.length < 2) { hasInitialFitRef.current = true; return; }
    const cw = containerRef.current.clientWidth;
    const ch = containerRef.current.clientHeight;
    if (cw === 0 || ch === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of visibleControls) {
      const ox = mmToOcad(c.x);
      const oy = 2 * viewBox.y + viewBox.h - mmToOcad(c.y);
      minX = Math.min(minX, ox); maxX = Math.max(maxX, ox);
      minY = Math.min(minY, oy); maxY = Math.max(maxY, oy);
    }
    const m = 0.15;
    const bw = (maxX - minX) || viewBox.w * 0.1;
    const bh = (maxY - minY) || viewBox.h * 0.1;
    setTransform(computeFitTransform(viewBox, cw, ch,
      minX - bw * m, minY - bh * m, maxX + bw * m, maxY + bh * m));
    hasInitialFitRef.current = true;
  }, [viewBox, controls, initialFitControls]);

  // ─── Focus on selection change ────────────────────────────

  useEffect(() => {
    if (!viewBox || !containerRef.current || !focusControlIds || focusControlIds.length === 0) return;
    const key = [...focusControlIds].sort().join(",");
    if (key === lastFocusKeyRef.current) return;
    lastFocusKeyRef.current = key;
    const focusSet = new Set(focusControlIds);
    const focusControls = controls.filter((c) => focusSet.has(c.id));
    if (focusControls.length === 0) return;
    const cw = containerRef.current.clientWidth;
    const ch = containerRef.current.clientHeight;
    if (cw === 0 || ch === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of focusControls) {
      const ox = mmToOcad(c.x);
      const oy = 2 * viewBox.y + viewBox.h - mmToOcad(c.y);
      minX = Math.min(minX, ox); maxX = Math.max(maxX, ox);
      minY = Math.min(minY, oy); maxY = Math.max(maxY, oy);
    }
    if (focusControls.length === 1) {
      // Use ALL controls (including hidden ones) for extent reference
      const allControls = controls.filter((c) => c.type === "Control");
      if (allControls.length >= 2) {
        let aX0 = Infinity, aX1 = -Infinity, aY0 = Infinity, aY1 = -Infinity;
        for (const c of allControls) {
          const ox = mmToOcad(c.x);
          const oy = 2 * viewBox.y + viewBox.h - mmToOcad(c.y);
          aX0 = Math.min(aX0, ox); aX1 = Math.max(aX1, ox);
          aY0 = Math.min(aY0, oy); aY1 = Math.max(aY1, oy);
        }
        const ext = Math.max(aX1 - aX0, aY1 - aY0) || viewBox.w * 0.1;
        const h = ext * 0.167;
        minX -= h; maxX += h; minY -= h; maxY += h;
      } else {
        // Fallback: use a fraction of the map extent
        const ext = Math.max(viewBox.w, viewBox.h) * 0.1;
        minX -= ext; maxX += ext; minY -= ext; maxY += ext;
      }
    } else {
      const bw = (maxX - minX) || viewBox.w * 0.1;
      const bh = (maxY - minY) || viewBox.h * 0.1;
      minX -= bw * 0.2; maxX += bw * 0.2;
      minY -= bh * 0.2; maxY += bh * 0.2;
    }

    // Enforce minimum visible area (50mm × 50mm in OCAD units = 5000 × 5000)
    const MIN_BOX = 5000;
    const boxW = maxX - minX;
    const boxH = maxY - minY;
    if (boxW < MIN_BOX) { const extra = (MIN_BOX - boxW) / 2; minX -= extra; maxX += extra; }
    if (boxH < MIN_BOX) { const extra = (MIN_BOX - boxH) / 2; minY -= extra; maxY += extra; }

    setTransform(computeFitTransform(viewBox, cw, ch, minX, minY, maxX, maxY));
  }, [viewBox, focusControlIds, controls]);

  // Build control lookup by ID
  const controlMap = useMemo(() => {
    const map = new Map<string, ControlOverlay>();
    for (const c of controls) map.set(c.id, c);
    return map;
  }, [controls]);

  // ─── Measure helpers ────────────────────────────────────

  const screenToOcad = useCallback((clientX: number, clientY: number): Pt | null => {
    if (!viewBox || !containerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const cw = containerSize.w || containerRef.current.clientWidth || 1;
    const ch = containerSize.h || containerRef.current.clientHeight || 1;
    const base = Math.min(cw / viewBox.w, ch / viewBox.h);
    const padX = (cw - viewBox.w * base) / 2;
    const padY = (ch - viewBox.h * base) / 2;
    return {
      x: viewBox.x + ((sx - transform.x) / transform.scale - padX) / base,
      y: viewBox.y + ((sy - transform.y) / transform.scale - padY) / base,
    };
  }, [viewBox, transform, containerSize]);

  function ocadDistPx(a: Pt, b: Pt) {
    const dx = b.x - a.x, dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function ocadToMeters(d: number) {
    return mapScale ? d * mapScale / 100000 : 0;
  }
  function formatDist(m: number) {
    return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
  }

  // ─── Event Handlers ─────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      setTransform((prev) => {
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = Math.max(0.1, Math.min(50, prev.scale * zoomFactor));
        const r = newScale / prev.scale;
        return { scale: newScale, x: mouseX - (mouseX - prev.x) * r, y: mouseY - (mouseY - prev.y) * r };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [svgElement]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    isPanningRef.current = true;
    lastPosRef.current = { x: e.clientX, y: e.clientY };
    mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
  }, []);
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isPanningRef.current) {
      const dx = e.clientX - lastPosRef.current.x;
      const dy = e.clientY - lastPosRef.current.y;
      lastPosRef.current = { x: e.clientX, y: e.clientY };
      setTransform((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
    }
    if (measuring) {
      const pt = screenToOcad(e.clientX, e.clientY);
      if (pt) setMeasureCursor(pt);
    }
  }, [measuring, screenToOcad]);
  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    isPanningRef.current = false;
    if (measuring && mouseDownPosRef.current) {
      const dx = Math.abs(e.clientX - mouseDownPosRef.current.x);
      const dy = Math.abs(e.clientY - mouseDownPosRef.current.y);
      if (dx + dy < 5) {
        const now = Date.now();
        if (now - lastClickTimeRef.current < 300) {
          // Double-click: finish measurement
          lastClickTimeRef.current = 0;
          setMeasureCursor(null);
        } else {
          lastClickTimeRef.current = now;
          const pt = screenToOcad(e.clientX, e.clientY);
          if (pt) setMeasurePoints((prev) => [...prev, pt]);
        }
      }
    }
    mouseDownPosRef.current = null;
  }, [measuring, screenToOcad]);

  const lastTouchRef = useRef<{ x: number; y: number; dist?: number } | null>(null);
  const touchStartPosRef = useRef<Pt | null>(null);
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      lastTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      touchStartPosRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchRef.current = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2, dist: Math.sqrt(dx * dx + dy * dy) };
      touchStartPosRef.current = null;
    }
  }, []);
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 1 && lastTouchRef.current) {
      const dx = e.touches[0].clientX - lastTouchRef.current.x;
      const dy = e.touches[0].clientY - lastTouchRef.current.y;
      lastTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      setTransform((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
    } else if (e.touches.length === 2 && lastTouchRef.current?.dist) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const mx = cx - rect.left, my = cy - rect.top;
        const z = dist / lastTouchRef.current.dist;
        setTransform((prev) => { const ns = Math.max(0.1, Math.min(50, prev.scale * z)); const r = ns / prev.scale; return { scale: ns, x: mx - (mx - prev.x) * r, y: my - (my - prev.y) * r }; });
      }
      lastTouchRef.current = { x: cx, y: cy, dist };
    }
  }, []);
  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (measuring && touchStartPosRef.current && e.changedTouches.length === 1) {
      const t = e.changedTouches[0];
      const dx = Math.abs(t.clientX - touchStartPosRef.current.x);
      const dy = Math.abs(t.clientY - touchStartPosRef.current.y);
      if (dx + dy < 10) {
        const pt = screenToOcad(t.clientX, t.clientY);
        if (pt) setMeasurePoints((prev) => [...prev, pt]);
      }
    }
    touchStartPosRef.current = null;
    lastTouchRef.current = null;
  }, [measuring, screenToOcad]);

  // ─── Measure keyboard shortcuts ──────────────────────────
  useEffect(() => {
    if (!measuring) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (measurePoints.length > 0) { setMeasurePoints([]); setMeasureCursor(null); }
        else setMeasuring(false);
      } else if (e.key === "Backspace") {
        setMeasurePoints((prev) => prev.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [measuring, measurePoints.length]);

  // ─── Dynamic overlay viewBox (tracks pan/zoom for crisp vector rendering) ──

  const overlayViewBox = useMemo(() => {
    if (!viewBox || !containerRef.current) return null;
    // Use tracked containerSize for correct dimensions after resize/fullscreen
    const cw = (containerSize.w > 0 ? containerSize.w : containerRef.current.clientWidth) || 1;
    const ch = (containerSize.h > 0 ? containerSize.h : containerRef.current.clientHeight) || 1;

    const mapScaleX = cw / viewBox.w;
    const mapScaleY = ch / viewBox.h;
    const mapScale = Math.min(mapScaleX, mapScaleY);
    const renderedW = viewBox.w * mapScale;
    const renderedH = viewBox.h * mapScale;
    const padX = (cw - renderedW) / 2;
    const padY = (ch - renderedH) / 2;

    const s = transform.scale;
    const tx = transform.x;
    const ty = transform.y;

    const ux0 = (0 - tx) / s;
    const uy0 = (0 - ty) / s;
    const ux1 = (cw - tx) / s;
    const uy1 = (ch - ty) / s;

    const vx0 = viewBox.x + viewBox.w * (ux0 - padX) / renderedW;
    const vy0 = viewBox.y + viewBox.h * (uy0 - padY) / renderedH;
    const vx1 = viewBox.x + viewBox.w * (ux1 - padX) / renderedW;
    const vy1 = viewBox.y + viewBox.h * (uy1 - padY) / renderedH;

    return `${vx0} ${vy0} ${vx1 - vx0} ${vy1 - vy0}`;
  }, [viewBox, transform, containerSize]);

  // ─── Control / Course overlay SVG ──────────────────────

  const overlayContent = useMemo(() => {
    if (!viewBox || !overlayViewBox) return null;
    const visibleControls = controls.filter((c) => c.visible !== false);
    if (visibleControls.length === 0 && courses.length === 0) return null;

    // ─── Sizes (typical IOF standard) ────────────
    const radiusMm = 2.5;             // 5mm diameter circle
    const radius = mmToOcad(radiusMm);
    const strokeW = mmToOcad(0.35);   // IOF line width
    const fontSize = radius * 1.1;
    const clearance = radius * 1.35;  // line-to-center clearance (tight to circle)

    // ─── Convert all controls to OCAD coords ─────────────
    // OCAD Y goes up, SVG Y goes down.  ocad2geojson negates Y in path data,
    // then applies translate(0, minY+maxY) on the root <g>.
    // Overlay sits OUTSIDE that <g>, so we replicate the full transform:
    //   rendered_y = (minY + maxY) - ocadY = (2·viewBox.y + viewBox.h) - mmToOcad(mm)
    const toY = (my: number) => 2 * viewBox.y + viewBox.h - mmToOcad(my);

    // ─── Extract Slits/Cuts from Course Geometry ─────────
    const cutMap = new Map<string, SlitGap[]>();
    // Handle both cases: courseGeometry as direct FeatureCollection or record
    const geomCollection = (courseGeometry?.type === "FeatureCollection" || Array.isArray(courseGeometry?.features))
      ? courseGeometry
      : (highlightCourseName ? courseGeometry?.[highlightCourseName] : null);

    if (geomCollection?.features) {
      for (const f of geomCollection.features) {
        if (f.geometry?.type === "Point") {
          const cutId = f.properties?.code || f.properties?.id;
          if (cutId && Array.isArray(f.properties.cuts)) {
            cutMap.set(String(cutId), f.properties.cuts);
          }
        }
      }
    }

    // Build code -> sequential number map from the highlighted course.
    // Use the courses prop's highlight flag (set by MapPanel from effectiveCourseNames)
    // since highlightCourseName may be undefined when highlightCourseNames (plural) is used.
    const codeToSeqNum = new Map<string, number>();
    if (showDescriptions) {
      const highlightedCourse = courses.find(c => c.highlight)
        || (highlightCourseName ? courses.find(c => c.name === highlightCourseName) : null);
      if (highlightedCourse) {
        let seq = 0;
        for (const cid of highlightedCourse.controls) {
          const ctrl = controls.find(c => c.id === cid);
          if (ctrl && ctrl.type === "Control") {
            codeToSeqNum.set(cid, ++seq);
          }
        }
      }
    }

    // Extract description properties from geometry features
    const descriptionMap = new Map<string, any>();
    if (showDescriptions && geomCollection?.features) {
      for (const f of geomCollection.features) {
        if (f.geometry?.type === "Point" && f.properties?.description) {
          const code = f.properties?.code || f.properties?.id;
          if (code) descriptionMap.set(String(code), f.properties.description);
        }
      }
    }

    // Visible controls with OCAD positions
    const ctrlPts = visibleControls.map((c) => ({
      ...c,
      cx: mmToOcad(c.x),
      cy: toY(c.y),
      cuts: cutMap.get(c.code) || cutMap.get(c.id),
    }));

    // ─── Course geometry (legs, restricted areas, etc.) ──────────────────
    type Seg = { x1: number; y1: number; x2: number; y2: number };
    const lineSegments: Seg[] = [];
    const graphicalObjects: React.ReactNode[] = [];
    const legLines: React.ReactNode[] = [];
    const cutMasks: React.ReactNode[] = [];

    // Track unique IDs for masks per course to avoid collisions (slugify for safe IDs)
    const maskId = `leg-mask-${(highlightCourseName || "all").replace(/[^a-zA-Z0-9\-]/g, "_")}`;

    const activeCourseGeom = geomCollection;

    if (activeCourseGeom) {
      activeCourseGeom.features.forEach((f: any, i: number) => {
        if (f.geometry?.type === "LineString") {
          const coords = f.geometry.coordinates;
          const d = coords.map((c: number[], j: number) => `${j === 0 ? "M" : "L"} ${mmToOcad(c[0])},${toY(c[1])}`).join(" ");

          if (f.properties?.symbolType === "leg") {
            legLines.push(
              <path key={`leg-${i}`} d={d} fill="none" stroke="#c026d3" strokeWidth={strokeW} opacity={0.8}
                // Pre-clipped legs from OCAD already have correct gaps; no mask needed
                mask={f.properties?.preclipped ? undefined : `url(#${maskId})`}
              />
            );
            for (let j = 0; j < coords.length - 1; j++) {
              lineSegments.push({
                x1: mmToOcad(coords[j][0]), y1: toY(coords[j][1]),
                x2: mmToOcad(coords[j + 1][0]), y2: toY(coords[j + 1][1])
              });
            }
          } else if (f.properties?.symbolType === "marked_route") {
            graphicalObjects.push(
              <path key={`go-${i}`} d={d} fill="none" stroke="#c026d3" strokeWidth={strokeW} opacity={0.8} />
            );
          } else if (f.properties?.symbolType === "forbidden_route" || f.properties?.symbolType === "restricted_line") {
            const isForbidden = f.properties.symbolType === "forbidden_route";
            graphicalObjects.push(
              <path key={`go-${i}`} d={d} fill="none"
                stroke="#c026d3"
                strokeWidth={isForbidden ? strokeW * 1.5 : strokeW}
                strokeDasharray={isForbidden ? `${strokeW * 4},${strokeW * 2}` : undefined}
                opacity={0.8}
              />
            );
          }
        } else if (f.geometry?.type === "Polygon") {
          if (f.properties?.symbolType === "description_box") return;
          const coords = f.geometry.coordinates[0];
          const pts = coords.map((c: number[]) => `${mmToOcad(c[0])},${toY(c[1])}`).join(" ");

          if (f.properties?.symbolType === "leg_cut") {
            cutMasks.push(<polygon key={`mask-poly-${i}`} points={pts} fill="black" />);
          } else {
            graphicalObjects.push(
              <polygon key={`go-${i}`} points={pts} fill="url(#restricted-crosshatch)" stroke="#c026d3" strokeWidth={strokeW} opacity={0.65} />
            );
          }
        }
      });
    }

    // Add black circles to mask out leg lines inside the symbols
    ctrlPts.forEach((ctrl) => {
      // Use slightly smaller radius for mask to ensure it doesn't leave stray line fragments
      // and feels tighter.
      const maskR = radius * 0.98;
      cutMasks.push(
        <circle
          key={`mask-sym-${ctrl.id}`}
          cx={ctrl.cx}
          cy={ctrl.cy}
          r={maskR}
          fill="black"
        />
      );
    });

    // ─── Smart label placement ───────────────────────────
    // Try 12 candidate positions around each control and pick the one
    // with the least overlap with other circles, course lines, and
    // already-placed labels (greedy: first-placed labels have priority).
    interface LabelInfo { x: number; y: number; anchor: string }
    const labelMap = new Map<string, LabelInfo>();
    const placedLabelCenters: Pt[] = []; // centers of already-placed labels
    const labelDist = radius * 2.0;
    const CANDIDATES = 12;

    for (const ctrl of ctrlPts) {
      if (ctrl.type === "Start" || ctrl.type === "Finish") continue;

      let bestScore = -Infinity;
      let bestLx = ctrl.cx + labelDist;
      let bestLy = ctrl.cy - labelDist * 0.3;
      let bestAnchor = "start";

      for (let ci = 0; ci < CANDIDATES; ci++) {
        const angle = (ci / CANDIDATES) * 2 * Math.PI - Math.PI / 6; // start upper-right
        const dirX = Math.cos(angle);
        const dirY = Math.sin(angle);
        const lx = ctrl.cx + dirX * labelDist;
        const ly = ctrl.cy + dirY * labelDist;

        // Score = minimum distance to any obstacle (higher is better)
        let minDist = Infinity;

        // Distance from other control circles
        for (const other of ctrlPts) {
          if (other.id === ctrl.id) continue;
          const dx = lx - other.cx, dy = ly - other.cy;
          minDist = Math.min(minDist, Math.sqrt(dx * dx + dy * dy));
        }

        // Distance from course line segments
        for (const seg of lineSegments) {
          const { dist } = ptSegDist(lx, ly, seg.x1, seg.y1, seg.x2, seg.y2);
          minDist = Math.min(minDist, dist);
        }

        // Distance from already-placed label centers
        for (const pl of placedLabelCenters) {
          const dx = lx - pl.x, dy = ly - pl.y;
          minDist = Math.min(minDist, Math.sqrt(dx * dx + dy * dy));
        }

        if (minDist > bestScore) {
          bestScore = minDist;
          bestLx = lx;
          bestLy = ly;
          const absDirX = Math.abs(dirX);
          bestAnchor = absDirX < 0.35 ? "middle" : dirX >= 0 ? "start" : "end";
        }
      }

      placedLabelCenters.push({ x: bestLx, y: bestLy });
      labelMap.set(ctrl.id, { x: bestLx, y: bestLy, anchor: bestAnchor });
    }

    // ─── Render control symbols ──────────────────────────
    const controlElements = ctrlPts.map((ctrl) => {
      const isHighlighted = ctrl.highlight || ctrl.id === highlightControlId;
      const color =
        ctrl.punchStatus === "missing" ? "#ef4444" :
        ctrl.punchStatus === "extra"   ? "#f97316" :
        ctrl.punchStatus === "ok"      ? "#059669" :
        isHighlighted ? "#ef4444" : "#c026d3";

      if (ctrl.type === "Start") {
        const s = radius * 1.1;
        return (
          <g key={ctrl.id} className="cursor-pointer" onClick={() => onControlClick?.(ctrl.id)}>
            <polygon
              points={`${ctrl.cx},${ctrl.cy - s} ${ctrl.cx - s * 0.87},${ctrl.cy + s * 0.5} ${ctrl.cx + s * 0.87},${ctrl.cy + s * 0.5}`}
              fill="none" stroke={color} strokeWidth={strokeW}
            />
          </g>
        );
      }

      // Helper to generate a broken circle path for cut gaps
      const drawBrokenCircle = (cx: number, cy: number, r: number, cuts: SlitGap[] | undefined, strokeClr: string, sw: number) => {
        if (!cuts || cuts.length === 0) {
          return <circle cx={cx} cy={cy} r={r} fill="none" stroke={strokeClr} strokeWidth={sw} />;
        }

        // 1. Normalize and merge overlapping gaps
        const ranges = cuts.map(c => {
          let s = (c.start + 720) % 360;
          let e = (c.end + 720) % 360;
          if (e < s) e += 360;
          return { s, e };
        }).sort((a, b) => a.s - b.s);

        const merged: { s: number, e: number }[] = [];
        if (ranges.length > 0) {
          let curr = ranges[0];
          for (let i = 1; i < ranges.length; i++) {
            if (ranges[i].s <= curr.e) curr.e = Math.max(curr.e, ranges[i].e);
            else { merged.push(curr); curr = ranges[i]; }
          }
          merged.push(curr);
        }

        // 2. Handle wrap-around merge and split back to [0, 360]
        const finalGaps: { s: number, e: number }[] = [];
        merged.forEach(m => {
          if (m.e > 360) {
            finalGaps.push({ s: m.s, e: 360 });
            finalGaps.push({ s: 0, e: m.e - 360 });
          } else finalGaps.push(m);
        });
        finalGaps.sort((a, b) => a.s - b.s);

        const results: { s: number, e: number }[] = [];
        if (finalGaps.length > 0) {
          let curr = finalGaps[0];
          for (let i = 1; i < finalGaps.length; i++) {
            if (finalGaps[i].s <= curr.e) curr.e = Math.max(curr.e, finalGaps[i].e);
            else { results.push(curr); curr = finalGaps[i]; }
          }
          results.push(curr);
        }

        // Merge end-to-start wrap
        if (results.length > 1 && results[results.length - 1].e === 360 && results[0].s === 0) {
          const last = results.pop()!;
          results[0].s = last.s - 360;
        }

        // 3. Generate arcs for the DRAWN segments (between gaps)
        const getPt = (deg: number) => {
          const rad = (deg * Math.PI) / 180;
          return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
        };

        const arcs: string[] = [];
        for (let i = 0; i < results.length; i++) {
          const curr = results[i];
          const next = results[(i + 1) % results.length];
          const s = curr.e;
          let e = next.s;
          if (e <= s) e += 360;
          if (e - s < 0.5) continue;
          const p1 = getPt(s), p2 = getPt(e);
          const largeArc = (e - s > 180) ? 1 : 0;
          arcs.push(`M ${p1.x},${p1.y} A ${r},${r} 0 ${largeArc},1 ${p2.x},${p2.y}`);
        }

        if (arcs.length === 0 && results.length > 0) return null;

        return <path d={arcs.join(" ")} fill="none" stroke={strokeClr} strokeWidth={sw} />;
      };

      if (ctrl.type === "Finish") {
        const outerR = radius;
        const innerR = radius * 0.75;
        return (
          <g key={ctrl.id} className="cursor-pointer" onClick={() => onControlClick?.(ctrl.id)}>
            {drawBrokenCircle(ctrl.cx, ctrl.cy, outerR, ctrl.cuts, color, strokeW)}
            {drawBrokenCircle(ctrl.cx, ctrl.cy, innerR, ctrl.cuts, color, strokeW)}
          </g>
        );
      }

      // Regular control with smart label and optional completion ring
      const label = labelMap.get(ctrl.id);
      const pct = ctrl.completionPct;
      const hasCompletion = pct !== undefined;
      const isComplete = pct !== undefined && pct >= 1;

      // Progress arc: sweeps clockwise from 12 o'clock
      let progressArc: React.ReactNode = null;
      if (hasCompletion && pct > 0) {
        const r = radius;
        if (isComplete) {
          // 100%: filled green ring (semi-transparent fill so map is visible)
          progressArc = (
            <circle cx={ctrl.cx} cy={ctrl.cy} r={r}
              fill="rgba(16, 185, 129, 0.15)" stroke="#059669" strokeWidth={strokeW * 1.5}
            />
          );
        } else {
          // Partial: green arc from 12 o'clock
          const angle = pct * 2 * Math.PI;
          const startX = ctrl.cx;
          const startY = ctrl.cy - r;
          const endX = ctrl.cx + r * Math.sin(angle);
          const endY = ctrl.cy - r * Math.cos(angle);
          const largeArc = angle > Math.PI ? 1 : 0;
          progressArc = (
            <path
              d={`M ${startX} ${startY} A ${r} ${r} 0 ${largeArc} 1 ${endX} ${endY}`}
              fill="none" stroke="#10b981" strokeWidth={strokeW * 1.5}
              strokeLinecap="round"
            />
          );
        }
      }

      const xOff = radius * 0.6;
      return (
        <g key={ctrl.id} className="cursor-pointer" onClick={() => onControlClick?.(ctrl.id)}>
          {/* Base circle: dimmed if completion is active and not complete */}
          <g opacity={hasCompletion && !isComplete ? 0.35 : 1}>
            {drawBrokenCircle(ctrl.cx, ctrl.cy, radius, ctrl.cuts, isComplete ? "#059669" : color, strokeW)}
          </g>
          {/* X overlay for missing controls */}
          {ctrl.punchStatus === "missing" && (
            <>
              <line x1={ctrl.cx - xOff} y1={ctrl.cy - xOff} x2={ctrl.cx + xOff} y2={ctrl.cy + xOff} stroke="#ef4444" strokeWidth={strokeW} strokeLinecap="round" />
              <line x1={ctrl.cx + xOff} y1={ctrl.cy - xOff} x2={ctrl.cx - xOff} y2={ctrl.cy + xOff} stroke="#ef4444" strokeWidth={strokeW} strokeLinecap="round" />
            </>
          )}
          {/* Completion progress arc */}
          {progressArc}
          {label && (
            <text
              x={label.x} y={label.y}
              fontSize={fontSize} fill={isComplete ? "#059669" : color} fontWeight="bold"
              textAnchor={label.anchor as any} dominantBaseline="central"
            >{showDescriptions && codeToSeqNum.has(ctrl.id) ? codeToSeqNum.get(ctrl.id) : ctrl.code}</text>
          )}
          {!hasCompletion && ctrl.punchCount !== undefined && (
            <text
              x={ctrl.cx} y={ctrl.cy}
              fontSize={fontSize * 0.7} fill="#1d4ed8"
              textAnchor="middle" dominantBaseline="central" fontWeight="bold"
            >{ctrl.punchCount}</text>
          )}
        </g>
      );
    });

    // ─── Description sheet rendering (8-column IOF grid with pictographic symbols) ─
    let descriptionSheet: React.ReactNode = null;
    if (showDescriptions && geomCollection?.features) {
      const boxFeature = geomCollection.features.find(
        (f: any) => f.properties?.symbolType === "description_box" && f.geometry?.type === "Polygon"
      );
      if (boxFeature && codeToSeqNum.size > 0) {
        const coords: number[][] = boxFeature.geometry.coordinates[0];
        const xs = coords.map(c => mmToOcad(c[0]));
        const ys = coords.map(c => toY(c[1]));
        const boxX = Math.min(...xs);
        const boxY = Math.min(...ys);
        const boxW = Math.max(...xs) - boxX;
        const boxH = Math.max(...ys) - boxY;

        const hlCourse = courses.find(c => c.highlight)
          || (highlightCourseName ? courses.find(c => c.name === highlightCourseName) : null);
        const orderedCodes: string[] = [];
        if (hlCourse) {
          for (const cid of hlCourse.controls) {
            const ctrl = controls.find(c => c.id === cid);
            if (ctrl && ctrl.type === "Control") orderedCodes.push(cid);
          }
        }

        const numRows = orderedCodes.length + 1;
        const rowH = boxH / numRows;
        // 8 IOF columns: A(seq#), B(code), C(which), D(feature), E(appearance), F(combo), G(position), H(other)
        const numCols = 8;
        const colW = boxW / numCols;
        const descStrokeW = strokeW * 0.6;
        const txtFontSize = rowH * 0.50;
        const headerFontSize = rowH * 0.45;
        const symPad = rowH * 0.08;

        const renderSymbolCell = (svgContent: string | null, cellX: number, cellY: number) => {
          if (!svgContent) return null;
          return (
            <svg
              x={cellX + symPad} y={cellY + symPad}
              width={colW - 2 * symPad} height={rowH - 2 * symPad}
              viewBox="-100 -100 200 200"
              dangerouslySetInnerHTML={{ __html: svgContent }}
            />
          );
        };

        const gridLines: React.ReactNode[] = [];
        // Horizontal row dividers
        for (let r = 0; r <= numRows; r++) {
          const y = boxY + r * rowH;
          gridLines.push(
            <line key={`hr-${r}`} x1={boxX} y1={y} x2={boxX + boxW} y2={y}
              stroke="#c026d3" strokeWidth={r <= 1 ? descStrokeW : descStrokeW * 0.4} />
          );
        }
        // Vertical column dividers (start below the header row)
        const gridTop = boxY + rowH;
        for (let c = 0; c <= numCols; c++) {
          const x = boxX + c * colW;
          gridLines.push(
            <line key={`vc-${c}`} x1={x} y1={c === 0 || c === numCols ? boxY : gridTop} x2={x} y2={boxY + boxH}
              stroke="#c026d3" strokeWidth={c === 0 || c === numCols ? descStrokeW : descStrokeW * 0.4} />
          );
        }

        descriptionSheet = (
          <g key="desc-sheet">
            <rect x={boxX} y={boxY} width={boxW} height={boxH}
              fill="white" stroke="#c026d3" strokeWidth={descStrokeW} />
            {gridLines}
            {/* Header row spanning all columns */}
            <text x={boxX + boxW * 0.5} y={boxY + rowH * 0.55}
              fontSize={headerFontSize} fill="#c026d3" fontWeight="bold"
              textAnchor="middle" dominantBaseline="central"
            >{hlCourse?.name || highlightCourseName || ""}</text>
            {/* Control rows with IOF symbols */}
            {orderedCodes.map((code, idx) => {
              const rowY = boxY + rowH * (idx + 1);
              const seqNum = codeToSeqNum.get(code) ?? idx + 1;
              const desc = descriptionMap.get(code);
              const syms = desc ? getDescriptionSymbols(desc) : null;

              return (
                <g key={`row-${code}`}>
                  {/* Col A: sequential number */}
                  <text x={boxX + colW * 0.5} y={rowY + rowH * 0.55}
                    fontSize={txtFontSize} fill="#c026d3" fontWeight="bold"
                    textAnchor="middle" dominantBaseline="central"
                  >{seqNum}</text>
                  {/* Col B: control code */}
                  <text x={boxX + colW * 1.5} y={rowY + rowH * 0.55}
                    fontSize={txtFontSize} fill="#c026d3"
                    textAnchor="middle" dominantBaseline="central"
                  >{code}</text>
                  {/* Col C: which of similar features */}
                  {renderSymbolCell(syms?.colC ?? null, boxX + colW * 2, rowY)}
                  {/* Col D: control feature */}
                  {renderSymbolCell(syms?.colD ?? null, boxX + colW * 3, rowY)}
                  {/* Col E: appearance/dimensions */}
                  {syms?.colE ? (
                    <text x={boxX + colW * 4.5} y={rowY + rowH * 0.55}
                      fontSize={txtFontSize * 0.85} fill="#c026d3"
                      textAnchor="middle" dominantBaseline="central"
                    >{syms.colE}</text>
                  ) : null}
                  {/* Col F: combinations */}
                  {renderSymbolCell(syms?.colF ?? null, boxX + colW * 5, rowY)}
                  {/* Col G: location of flag */}
                  {renderSymbolCell(syms?.colG ?? null, boxX + colW * 6, rowY)}
                  {/* Col H: other (reserved for future use) */}
                </g>
              );
            })}
          </g>
        );
      }
    }

    return (
      <svg
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}
        viewBox={overlayViewBox}
        preserveAspectRatio="none"
      >
        <defs>
          <pattern id="restricted-crosshatch" width={strokeW * 3} height={strokeW * 3} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line stroke="#c026d3" strokeWidth={strokeW * 0.4} y2={strokeW * 3} />
            <line stroke="#c026d3" strokeWidth={strokeW * 0.4} x2={strokeW * 3} />
          </pattern>
          <mask id={maskId} maskUnits="userSpaceOnUse" x={-1e6} y={-1e6} width={2e6} height={2e6}>
            <rect x={-1e6} y={-1e6} width={2e6} height={2e6} fill="white" />
            {cutMasks}
          </mask>
        </defs>
        <g style={{ pointerEvents: "auto" }}>
          {graphicalObjects}
          {legLines}
          {controlElements}
          {descriptionSheet}
        </g>
      </svg>
    );
  }, [viewBox, overlayViewBox, controls, courses, highlightControlId, highlightCourseName, controlMap, onControlClick, courseGeometry, showDescriptions]);

  // ─── Measure overlay SVG ────────────────────────────────

  const measureOverlay = useMemo(() => {
    if (!overlayViewBox || !viewBox) return null;
    const pts = measurePoints;
    const cursor = measureCursor;
    const allPts = cursor && pts.length > 0 ? [...pts, cursor] : pts;
    if (allPts.length === 0) return null;

    // Compute a stroke width that stays constant on screen (~2px)
    const vbParts = overlayViewBox.split(" ").map(Number);
    const vbW = vbParts[2];
    const cw = containerSize.w || 1;
    const unit = vbW / cw; // OCAD units per screen pixel
    const sw = unit * 2;
    const dotR = unit * 4;
    const fontSize = unit * 12;

    const lineD = allPts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x},${p.y}`).join(" ");
    const rubberD = cursor && pts.length > 0
      ? `M ${pts[pts.length - 1].x},${pts[pts.length - 1].y} L ${cursor.x},${cursor.y}`
      : null;

    // Segment labels
    const labels: React.ReactNode[] = [];
    for (let i = 1; i < allPts.length; i++) {
      const a = allPts[i - 1], b = allPts[i];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const d = ocadToMeters(ocadDistPx(a, b));
      const isRubber = cursor && i === allPts.length - 1;
      labels.push(
        <text key={i} x={mx} y={my - unit * 5} textAnchor="middle" fontSize={fontSize}
          fill={isRubber ? "#6366f1" : "#1d4ed8"} fontWeight="bold" fontFamily="sans-serif"
          stroke="white" strokeWidth={unit * 3} paintOrder="stroke"
        >{formatDist(d)}</text>
      );
    }

    return (
      <svg
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}
        viewBox={overlayViewBox} preserveAspectRatio="none"
      >
        {/* Placed segments */}
        {pts.length > 1 && (
          <path d={pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x},${p.y}`).join(" ")}
            fill="none" stroke="#1d4ed8" strokeWidth={sw} strokeDasharray={`${unit * 6},${unit * 3}`} />
        )}
        {/* Rubber-band line */}
        {rubberD && (
          <path d={rubberD} fill="none" stroke="#6366f1" strokeWidth={sw * 0.7}
            strokeDasharray={`${unit * 4},${unit * 3}`} opacity={0.7} />
        )}
        {/* Dots at waypoints */}
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={dotR} fill="#1d4ed8" stroke="white" strokeWidth={sw} />
        ))}
        {labels}
      </svg>
    );
  }, [overlayViewBox, viewBox, measurePoints, measureCursor, containerSize, mapScale]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Render ─────────────────────────────────────────────

  if (!ocdData) {
    return (
      <div className={`flex items-center justify-center bg-slate-100 rounded-lg border border-slate-200 ${className}`} style={style}>
        <div className="text-center p-8">
          <svg className="mx-auto w-12 h-12 text-slate-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
          </svg>
          <p className="text-sm text-slate-400">No map loaded</p>
          <p className="text-xs text-slate-400 mt-1">Upload an OCAD (.ocd) file</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={`flex items-center justify-center bg-slate-50 rounded-lg border border-slate-200 ${className}`} style={style}>
        <div className="text-center">
          <div className="w-8 h-8 border-3 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-slate-500">Rendering map...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`flex items-center justify-center bg-red-50 rounded-lg border border-red-200 ${className}`} style={style}>
        <div className="text-center p-4">
          <p className="text-sm text-red-600 font-medium">Failed to render map</p>
          <p className="text-xs text-red-500 mt-1">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden bg-white rounded-lg border border-slate-200 select-none ${className}`}
      style={{ cursor: measuring ? "crosshair" : isPanningRef.current ? "grabbing" : "grab", ...style }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Base map — inside CSS transform container */}
      <div
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          transformOrigin: "0 0",
          position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
        }}
      >
        <div ref={svgContainerRef} style={{ width: "100%", height: "100%" }} />
      </div>

      {/* Overlay — OUTSIDE transform container, using dynamic viewBox for
          crisp vector rendering at any zoom level while scaling with map */}
      {overlayContent}
      {measureOverlay}

      {/* Measure total distance HUD */}
      {measuring && measurePoints.length >= 2 && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 bg-white/90 rounded-lg px-3 py-1.5 border border-slate-200 shadow-sm pointer-events-none">
          <span className="text-sm font-semibold text-blue-700">
            {formatDist(measurePoints.reduce((sum, p, i) => i === 0 ? 0 : sum + ocadToMeters(ocadDistPx(measurePoints[i - 1], p)), 0))}
          </span>
          <span className="text-xs text-slate-400 ml-2">{measurePoints.length - 1} segment{measurePoints.length > 2 ? "s" : ""}</span>
        </div>
      )}

      {/* Scale bar */}
      {(() => {
        if (!mapScale || !viewBox || containerSize.w === 0) return null;
        const basePixPerOcad = Math.min(containerSize.w / viewBox.w, containerSize.h / viewBox.h);
        const pixPerOcad = transform.scale * basePixPerOcad;
        // 1 OCAD unit = 0.01 mm paper; pixPerMeter = pixPerOcad * 100 * 1000 / mapScale
        const pixPerMeter = pixPerOcad * 100 * 1000 / mapScale;
        if (pixPerMeter <= 0) return null;
        const niceSteps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
        const targetPx = 90;
        const metersForTarget = targetPx / pixPerMeter;
        const niceM = niceSteps.reduce((best, v) =>
          Math.abs(v - metersForTarget) < Math.abs(best - metersForTarget) ? v : best
        );
        const barPx = Math.round(niceM * pixPerMeter);
        const label = niceM >= 1000 ? `${niceM / 1000} km` : `${niceM} m`;
        const svgW = barPx + 4;
        return (
          <div className="absolute bottom-3 left-3 z-10 bg-white/90 rounded px-2 py-1.5 border border-slate-200 shadow-sm pointer-events-none">
            <svg width={svgW} height={22} style={{ display: "block" }}>
              {/* Left tick pointing up */}
              <line x1={2} y1={0} x2={2} y2={8} stroke="#475569" strokeWidth={1.5} />
              {/* Right tick pointing up */}
              <line x1={svgW - 2} y1={0} x2={svgW - 2} y2={8} stroke="#475569" strokeWidth={1.5} />
              {/* Horizontal bar */}
              <line x1={2} y1={8} x2={svgW - 2} y2={8} stroke="#475569" strokeWidth={1.5} />
              {/* Label */}
              <text x={svgW / 2} y={20} textAnchor="middle" fontSize={10} fill="#64748b" fontFamily="sans-serif">{label}</text>
            </svg>
          </div>
        );
      })()}

      {/* Zoom & measure controls */}
      <div className="absolute bottom-3 right-3 flex flex-col gap-1 z-10">
        {mapScale && (
          <button
            onClick={() => {
              setMeasuring((m) => {
                if (m) { setMeasurePoints([]); setMeasureCursor(null); }
                return !m;
              });
            }}
            className={`w-8 h-8 border rounded-lg flex items-center justify-center shadow-sm cursor-pointer mb-1 ${
              measuring ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
            title={measuring ? "Stop measuring (Esc)" : "Measure distance"}
          >
            {/* Ruler icon */}
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18v12H3zM7 12v-3M11 12v-3M15 12v-3M19 12v-3" />
            </svg>
          </button>
        )}
        <button
          onClick={() => { const el = containerRef.current; if (!el) return; const cx = el.clientWidth / 2, cy = el.clientHeight / 2; setTransform(p => { const ns = Math.min(50, p.scale * 1.3); const ratio = ns / p.scale; return { scale: ns, x: cx - (cx - p.x) * ratio, y: cy - (cy - p.y) * ratio }; }); }}
          className="w-8 h-8 bg-white border border-slate-200 rounded-lg flex items-center justify-center text-slate-600 hover:bg-slate-50 shadow-sm cursor-pointer"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
        </button>
        <button
          onClick={() => { const el = containerRef.current; if (!el) return; const cx = el.clientWidth / 2, cy = el.clientHeight / 2; setTransform(p => { const ns = Math.max(0.1, p.scale / 1.3); const ratio = ns / p.scale; return { scale: ns, x: cx - (cx - p.x) * ratio, y: cy - (cy - p.y) * ratio }; }); }}
          className="w-8 h-8 bg-white border border-slate-200 rounded-lg flex items-center justify-center text-slate-600 hover:bg-slate-50 shadow-sm cursor-pointer"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" /></svg>
        </button>
        <button
          onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}
          className="w-8 h-8 bg-white border border-slate-200 rounded-lg flex items-center justify-center text-slate-600 hover:bg-slate-50 shadow-sm cursor-pointer"
          title="Reset view"
        >
          {/* Circular arrow — clearly distinct from the fullscreen icon */}
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
        </button>
        {onToggleFullscreen && (
          <button
            onClick={onToggleFullscreen}
            className="w-8 h-8 bg-white border border-slate-200 rounded-lg flex items-center justify-center text-slate-600 hover:bg-slate-50 shadow-sm cursor-pointer"
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" /></svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
