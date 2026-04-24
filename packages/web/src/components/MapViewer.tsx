import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useParams } from "react-router-dom";
import { getDescriptionSymbols } from "../iof-symbols";
import { TileLayer } from "./TileLayer";
import {
  type TileViewport,
  type WGS84Bounds,
  type AffineTransform,
  latlngToPixel,
  pixelToLatlng,
  fitBounds,
  metersPerPixel,
  buildAffineTransform,
} from "../lib/geo-utils";

// ─── Types ──────────────────────────────────────────────────

export interface ControlOverlay {
  id: string;
  code: string;
  x: number; // map position x (mm on map)
  y: number; // map position y (mm on map)
  lat: number;
  lng: number;
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
  mapBounds?: WGS84Bounds | null;
  mapScale?: number | null;
  /** Map north offset in degrees (bearing from true north to map north). Applied as CSS rotation. */
  northOffset?: number | null;
  /** Map upload timestamp for cache busting tile URLs */
  mapVersion?: number;
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
  /**
   * Names of highlighted courses for which high-fidelity geometry is already
   * included in `courseGeometry` (i.e. imported as OCD/XML). Any highlighted
   * course NOT in this set gets fallback straight-line legs between its
   * controls so the user still sees a route for it. When omitted, falls back
   * to the legacy "draw legs only when no geometry at all" behaviour.
   */
  coursesWithGeometry?: Set<string>;
  showDescriptions?: boolean;
  onToggleFullscreen?: () => void;
  isFullscreen?: boolean;
  /** Hide all interactive controls (zoom, measure, reset, fullscreen) */
  hideControls?: boolean;
  /** GPS route traces to overlay on the map (lat/lng points, already in WGS84). */
  gpsRoutes?: Array<{ color: string; points: Array<{ lat: number; lng: number }> }>;
}

// ─── Helpers ────────────────────────────────────────────────

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

  const blocks: [number, number][] = [];
  for (const obs of obstacles) {
    const vx = obs.x - a.x, vy = obs.y - a.y;
    const t = vx * ux + vy * uy;
    const px = a.x + t * ux - obs.x;
    const py = a.y + t * uy - obs.y;
    const perpDist = Math.sqrt(px * px + py * py);
    if (perpDist < clearance) {
      const half = Math.sqrt(clearance * clearance - perpDist * perpDist);
      blocks.push([t - half, t + half]);
    }
  }

  blocks.sort((ba, bb) => ba[0] - bb[0]);
  const merged: [number, number][] = [];
  for (const bl of blocks) {
    if (merged.length > 0 && bl[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], bl[1]);
    } else {
      merged.push([bl[0], bl[1]]);
    }
  }

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

// ─── Component ──────────────────────────────────────────────

export function MapViewer({
  mapBounds,
  mapScale,
  northOffset,
  mapVersion,
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
  coursesWithGeometry,
  showDescriptions = false,
  onToggleFullscreen,
  isFullscreen = false,
  hideControls = false,
  gpsRoutes,
}: Props) {
  const { nameId } = useParams<{ nameId: string }>();
  const tileUrlBase = nameId ? `/api/map-tile/${nameId}` : "/api/map-tile";

  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<TileViewport | null>(null);

  const isPanningRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });
  const hasInitialFitRef = useRef(false);
  const lastFocusKeyRef = useRef<string>("");

  // ─── Tile progress polling (while loading) ────────────────
  const [tileProgress, setTileProgress] = useState<{ total: number; done: number; rendering: boolean } | null>(null);
  useEffect(() => {
    if (viewport) return; // already loaded, stop polling
    if (!mapBounds) return; // no map
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/map-tile-progress", nameId ? { headers: { "x-competition-id": nameId } } : {});
        if (res.ok) setTileProgress(await res.json());
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [viewport, mapBounds]);

  // ─── Measure tool state ──────────────────────────────────
  const [measuring, setMeasuring] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<Pt[]>([]);
  const [measureCursor, setMeasureCursor] = useState<Pt | null>(null);
  const mouseDownPosRef = useRef<Pt | null>(null);
  const lastClickTimeRef = useRef(0);

  // Track container size
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

  // Map rotation: negate northOffset so map north points up on screen
  const rotDeg = northOffset ? -northOffset : 0;
  const rotRad = (rotDeg * Math.PI) / 180;
  // Overscan factor: scale the inner rotated container so corners don't clip
  const overscan = rotDeg !== 0
    ? Math.abs(Math.cos(rotRad)) + Math.abs(Math.sin(rotRad)) // ≈ 1.12 for 7°
    : 1;

  // Effective render dimensions (larger when rotated to cover corners)
  const renderW = rotDeg !== 0 ? Math.round(containerSize.w * overscan) : containerSize.w;
  const renderH = rotDeg !== 0 ? Math.round(containerSize.h * overscan) : containerSize.h;

  // Build affine transform from control points (mm ↔ lat/lng)
  const affine: AffineTransform | null = useMemo(() => {
    const pts = controls
      .filter((c) => c.lat !== 0 && c.lng !== 0 && c.x !== 0 && c.y !== 0)
      .map((c) => ({ mapX: c.x, mapY: c.y, lat: c.lat, lng: c.lng }));
    return buildAffineTransform(pts);
  }, [controls]);

  // ─── Viewport initialization from map bounds ────────────

  useEffect(() => {
    if (viewport) return; // already initialized
    if (!mapBounds || containerSize.w === 0 || containerSize.h === 0) return;
    setViewport(fitBounds(mapBounds, containerSize.w, containerSize.h, 0.05));
    hasInitialFitRef.current = false;
    lastFocusKeyRef.current = "";
  }, [mapBounds, containerSize, viewport]);

  // ─── Helper: compute bounds from controls in lat/lng ─────

  const fitToControlBounds = useCallback(
    (ctrls: ControlOverlay[], padding: number) => {
      if (ctrls.length === 0 || containerSize.w === 0 || containerSize.h === 0) return;
      let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
      for (const c of ctrls) {
        if (c.lat === 0 && c.lng === 0) continue;
        minLat = Math.min(minLat, c.lat); maxLat = Math.max(maxLat, c.lat);
        minLng = Math.min(minLng, c.lng); maxLng = Math.max(maxLng, c.lng);
      }
      if (minLat === Infinity) return;
      // Expand bounds by ring radius so control rings aren't clipped at the edge.
      // Ring radius = 2.5 mm on map × mapScale/1000 metres/mm.
      if (mapScale) {
        const ringM = 2.5 * mapScale / 1000;
        const midLat = (minLat + maxLat) / 2;
        const latMargin = ringM / 111320;
        const lngMargin = ringM / (111320 * Math.cos(midLat * Math.PI / 180));
        minLat -= latMargin; maxLat += latMargin;
        minLng -= lngMargin; maxLng += lngMargin;
      }
      const bounds: WGS84Bounds = { north: maxLat, south: minLat, east: maxLng, west: minLng };
      setViewport(fitBounds(bounds, containerSize.w, containerSize.h, padding));
    },
    [containerSize, mapScale],
  );

  // Re-fit when container size changes (e.g. fullscreen toggle)
  useEffect(() => {
    if (!viewport || containerSize.w === 0 || containerSize.h === 0) return;
    if (!hasInitialFitRef.current) return;
    const visibleControls = controls.filter((c) => c.visible !== false);
    if (visibleControls.length < 2) {
      if (mapBounds) setViewport(fitBounds(mapBounds, containerSize.w, containerSize.h, 0.05));
      return;
    }
    fitToControlBounds(visibleControls, hideControls ? 0.02 : 0.05);
  }, [containerSize]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Initial fit ──────────────────────────────────────────

  useEffect(() => {
    if (!viewport || !containerRef.current || hasInitialFitRef.current) return;
    if (!initialFitControls) { hasInitialFitRef.current = true; return; }
    const visibleControls = controls.filter((c) => c.visible !== false);
    if (visibleControls.length < 2) return;
    fitToControlBounds(visibleControls, hideControls ? 0.02 : 0.05);
    hasInitialFitRef.current = true;
  }, [viewport, controls, initialFitControls, hideControls, fitToControlBounds]);

  // ─── Focus on selection change ────────────────────────────

  useEffect(() => {
    if (!viewport || !containerRef.current || !focusControlIds || focusControlIds.length === 0) return;
    const key = [...focusControlIds].sort().join(",");
    if (key === lastFocusKeyRef.current) return;
    lastFocusKeyRef.current = key;
    const focusSet = new Set(focusControlIds);
    const focusControls = controls.filter((c) => focusSet.has(c.id));
    if (focusControls.length === 0) return;
    const cw = containerSize.w || containerRef.current.clientWidth;
    const ch = containerSize.h || containerRef.current.clientHeight;
    if (cw === 0 || ch === 0) return;

    if (focusControls.length === 1) {
      const fc = focusControls[0];
      const allCtrls = controls.filter((c) => c.type === "Control" && c.lat !== 0);
      if (allCtrls.length >= 2) {
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        for (const c of allCtrls) {
          minLat = Math.min(minLat, c.lat); maxLat = Math.max(maxLat, c.lat);
          minLng = Math.min(minLng, c.lng); maxLng = Math.max(maxLng, c.lng);
        }
        const ext = Math.max(maxLat - minLat, maxLng - minLng) * 0.167;
        const bounds: WGS84Bounds = {
          north: fc.lat + ext, south: fc.lat - ext,
          east: fc.lng + ext, west: fc.lng - ext,
        };
        setViewport(fitBounds(bounds, cw, ch, 0.05));
      } else {
        setViewport((prev) => prev ? { ...prev, centerLat: fc.lat, centerLng: fc.lng } : prev);
      }
    } else {
      fitToControlBounds(focusControls, hideControls ? 0.02 : 0.05);
    }
  }, [viewport, focusControlIds, controls, containerSize, hideControls, fitToControlBounds]);

  // Build control lookup by ID
  const controlMap = useMemo(() => {
    const map = new Map<string, ControlOverlay>();
    for (const c of controls) map.set(c.id, c);
    return map;
  }, [controls]);

  // ─── Coordinate helpers ───────────────────────────────────

  /** Rotate a screen-relative point to the rotated inner coordinate system. */
  const screenToInner = useCallback(
    (sx: number, sy: number): { ix: number; iy: number } => {
      if (rotRad === 0) return { ix: sx, iy: sy };
      // Rotate around container center by -rotDeg to undo visual rotation
      const cx = containerSize.w / 2;
      const cy = containerSize.h / 2;
      const dx = sx - cx;
      const dy = sy - cy;
      const cos = Math.cos(-rotRad);
      const sin = Math.sin(-rotRad);
      return {
        ix: dx * cos - dy * sin + renderW / 2,
        iy: dx * sin + dy * cos + renderH / 2,
      };
    },
    [rotRad, containerSize, renderW, renderH],
  );

  /** Convert screen pixel to map mm via affine. */
  const screenToMapMm = useCallback(
    (clientX: number, clientY: number): Pt | null => {
      if (!viewport || !affine || !containerRef.current) return null;
      const rect = containerRef.current.getBoundingClientRect();
      const { ix, iy } = screenToInner(clientX - rect.left, clientY - rect.top);
      const { lat, lng } = pixelToLatlng(ix, iy, viewport, renderW, renderH);
      const mm = affine.toMapMm(lat, lng);
      return { x: mm.mapX, y: mm.mapY };
    },
    [viewport, affine, renderW, renderH, screenToInner],
  );

  /** Convert map mm coords to screen pixel (in the rotated inner space). */
  const mapMmToScreen = useCallback(
    (mapX: number, mapY: number): Pt | null => {
      if (!viewport || !affine || containerSize.w === 0) return null;
      const { lat, lng } = affine.toLatLng(mapX, mapY);
      const { px, py } = latlngToPixel(lat, lng, viewport, renderW, renderH);
      return { x: px, y: py };
    },
    [viewport, affine, renderW, renderH, containerSize],
  );

  // Symbol size in pixels based on zoom and map scale
  const symbolScale = useMemo(() => {
    if (!viewport || !mapScale) return 1;
    const mpp = metersPerPixel(viewport.centerLat, viewport.zoom);
    // 1mm on map = mapScale/1000 meters on ground
    return (mapScale / 1000) / mpp;
  }, [viewport, mapScale]);

  // ─── Measure helpers ────────────────────────────────────

  function mapMmDist(a: Pt, b: Pt) {
    const dx = b.x - a.x, dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function mmToMeters(d: number) {
    return mapScale ? d * mapScale / 1000 : 0;
  }
  function formatDist(m: number) {
    return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
  }

  // ─── Event Handlers ─────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !viewport) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      // Transform screen cursor to inner (rotated) coords
      let ix = sx, iy = sy;
      if (rotRad !== 0) {
        const cx = containerSize.w / 2, cy = containerSize.h / 2;
        const dx = sx - cx, dy = sy - cy;
        const cos = Math.cos(-rotRad), sin = Math.sin(-rotRad);
        ix = dx * cos - dy * sin + renderW / 2;
        iy = dx * sin + dy * cos + renderH / 2;
      }
      const rw = renderW || el.clientWidth;
      const rh = renderH || el.clientHeight;

      const cursorGeo = pixelToLatlng(ix, iy, viewport, rw, rh);
      const zoomDelta = e.deltaY > 0 ? -0.15 : 0.15;
      const newZoom = Math.max(1, Math.min(22, viewport.zoom + zoomDelta));

      setViewport((prev) => {
        if (!prev) return prev;
        const newVp = { ...prev, zoom: newZoom };
        const afterCursor = latlngToPixel(cursorGeo.lat, cursorGeo.lng, newVp, rw, rh);
        const dxPx = ix - afterCursor.px;
        const dyPx = iy - afterCursor.py;
        const newCenter = pixelToLatlng(rw / 2 - dxPx, rh / 2 - dyPx, newVp, rw, rh);
        return { centerLat: newCenter.lat, centerLng: newCenter.lng, zoom: newZoom };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [viewport, containerSize, rotRad, renderW, renderH]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (!measuring) isPanningRef.current = true;
    lastPosRef.current = { x: e.clientX, y: e.clientY };
    mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
  }, [measuring]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isPanningRef.current && viewport) {
      let dx = e.clientX - lastPosRef.current.x;
      let dy = e.clientY - lastPosRef.current.y;
      lastPosRef.current = { x: e.clientX, y: e.clientY };
      // Rotate pixel delta to account for map rotation
      if (rotRad !== 0) {
        const cos = Math.cos(-rotRad);
        const sin = Math.sin(-rotRad);
        const rdx = dx * cos - dy * sin;
        const rdy = dx * sin + dy * cos;
        dx = rdx; dy = rdy;
      }
      const rw = renderW || 1;
      const rh = renderH || 1;
      const center = latlngToPixel(viewport.centerLat, viewport.centerLng, viewport, rw, rh);
      const newCenter = pixelToLatlng(center.px - dx, center.py - dy, viewport, rw, rh);
      setViewport((prev) => prev ? { ...prev, centerLat: newCenter.lat, centerLng: newCenter.lng } : prev);
    }
    if (measuring) {
      const pt = screenToMapMm(e.clientX, e.clientY);
      if (pt) setMeasureCursor(pt);
    }
  }, [measuring, viewport, renderW, renderH, rotRad, screenToMapMm]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    isPanningRef.current = false;
    if (measuring && mouseDownPosRef.current) {
      const dx = Math.abs(e.clientX - mouseDownPosRef.current.x);
      const dy = Math.abs(e.clientY - mouseDownPosRef.current.y);
      if (dx + dy < 5) {
        const now = Date.now();
        if (now - lastClickTimeRef.current < 300) {
          lastClickTimeRef.current = 0;
          setMeasureCursor(null);
        } else {
          lastClickTimeRef.current = now;
          const pt = screenToMapMm(e.clientX, e.clientY);
          if (pt) setMeasurePoints((prev) => [...prev, pt]);
        }
      }
    }
    mouseDownPosRef.current = null;
  }, [measuring, screenToMapMm]);

  const lastTouchRef = useRef<{ x: number; y: number; dist?: number } | null>(null);
  const touchStartPosRef = useRef<Pt | null>(null);
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      lastTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      touchStartPosRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastTouchRef.current = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        dist: Math.sqrt(dx * dx + dy * dy),
      };
      touchStartPosRef.current = null;
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    if (!viewport) return;
    const rw = renderW || 1;
    const rh = renderH || 1;

    if (e.touches.length === 1 && lastTouchRef.current) {
      let dx = e.touches[0].clientX - lastTouchRef.current.x;
      let dy = e.touches[0].clientY - lastTouchRef.current.y;
      lastTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      // Rotate pixel delta to account for map rotation
      if (rotRad !== 0) {
        const cos = Math.cos(-rotRad);
        const sin = Math.sin(-rotRad);
        const rdx = dx * cos - dy * sin;
        const rdy = dx * sin + dy * cos;
        dx = rdx; dy = rdy;
      }
      const center = latlngToPixel(viewport.centerLat, viewport.centerLng, viewport, rw, rh);
      const newCenter = pixelToLatlng(center.px - dx, center.py - dy, viewport, rw, rh);
      setViewport((prev) => prev ? { ...prev, centerLat: newCenter.lat, centerLng: newCenter.lng } : prev);
    } else if (e.touches.length === 2 && lastTouchRef.current?.dist) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const prevDist = lastTouchRef.current.dist;

      const rect = containerRef.current?.getBoundingClientRect();
      const sx = rect ? midX - rect.left : containerSize.w / 2;
      const sy = rect ? midY - rect.top : containerSize.h / 2;
      // Transform screen pinch point to inner (rotated) coords
      let ix = sx, iy = sy;
      if (rotRad !== 0) {
        const cx = containerSize.w / 2, cy = containerSize.h / 2;
        const ddx = sx - cx, ddy = sy - cy;
        const cos = Math.cos(-rotRad), sin = Math.sin(-rotRad);
        ix = ddx * cos - ddy * sin + rw / 2;
        iy = ddx * sin + ddy * cos + rh / 2;
      }

      const pinchGeo = pixelToLatlng(ix, iy, viewport, rw, rh);
      const zoomDelta = Math.log2(dist / prevDist);
      const newZoom = Math.max(1, Math.min(22, viewport.zoom + zoomDelta));

      const newVp: TileViewport = { ...viewport, zoom: newZoom };
      const afterPinch = latlngToPixel(pinchGeo.lat, pinchGeo.lng, newVp, rw, rh);
      const dxPx = ix - afterPinch.px;
      const dyPx = iy - afterPinch.py;
      const newCenter = pixelToLatlng(rw / 2 - dxPx, rh / 2 - dyPx, newVp, rw, rh);

      lastTouchRef.current = { x: midX, y: midY, dist };
      setViewport({ centerLat: newCenter.lat, centerLng: newCenter.lng, zoom: newZoom });
    }
  }, [viewport, containerSize, renderW, renderH, rotRad]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 0) {
      if (measuring && touchStartPosRef.current) {
        const pt = screenToMapMm(touchStartPosRef.current.x, touchStartPosRef.current.y);
        if (pt) setMeasurePoints((prev) => [...prev, pt]);
      }
      lastTouchRef.current = null;
      touchStartPosRef.current = null;
    } else if (e.touches.length === 1) {
      lastTouchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  }, [measuring, screenToMapMm]);

  // Escape / Backspace to cancel / undo measure
  useEffect(() => {
    if (!measuring) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMeasuring(false);
        setMeasurePoints([]);
        setMeasureCursor(null);
      } else if (e.key === "Backspace") {
        setMeasurePoints((prev) => prev.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [measuring]);

  // Helper: get slit cuts from course geometry for a given control code
  function getCourseGeomCuts(code: string): SlitGap[] | null {
    if (!courseGeometry) return null;
    const features = courseGeometry.features || [];
    for (const f of features) {
      if (f.properties?.symbolType === "control" && f.properties?.code === code && f.properties?.cuts) {
        return f.properties.cuts;
      }
    }
    return null;
  }

  // ─── Overlay rendering ─────────────────────────────────

  const overlayContent = useMemo(() => {
    if (!viewport || containerSize.w === 0 || containerSize.h === 0) return null;
    const cw = renderW;
    const ch = renderH;

    const radius = 2.5 * symbolScale;
    const stroke = Math.max(0.5, 0.35 * symbolScale);
    const labelSize = 3.5 * symbolScale;
    const startSize = 3.5 * symbolScale;
    const finishInner = 2.0 * symbolScale;
    const finishOuter = 3.0 * symbolScale;
    const legStroke = Math.max(0.5, 0.35 * symbolScale);

    // Build pixel positions for all controls (fallback from lat/lng)
    const ctrlPixels = new Map<string, Pt>();
    for (const c of controls) {
      if (c.lat === 0 && c.lng === 0) continue;
      const { px, py } = latlngToPixel(c.lat, c.lng, viewport, cw, ch);
      ctrlPixels.set(c.id, { x: px, y: py });
    }

    // Override with precise OCAD positions from courseGeometry when available
    if (courseGeometry && affine) {
      for (const f of (courseGeometry.features || [])) {
        const p = f.properties;
        if (!p?.code || !f.geometry || f.geometry.type !== "Point") continue;
        if (p.symbolType !== "control" && p.symbolType !== "start" && p.symbolType !== "finish") continue;
        const [mx, my] = f.geometry.coordinates as [number, number];
        const { lat, lng } = affine.toLatLng(mx, my);
        const { px, py } = latlngToPixel(lat, lng, viewport, cw, ch);
        const ctrl = controls.find(c => c.code === p.code);
        if (ctrl) ctrlPixels.set(ctrl.id, { x: px, y: py });
      }
    }

    const elements: React.ReactNode[] = [];

    // ─── Course geometry (GeoJSON) ───────────────────────

    if (courseGeometry && affine) {
      const features = courseGeometry.features || [];
      for (let fi = 0; fi < features.length; fi++) {
        const feature = features[fi];
        const props = feature.properties || {};
        const geom = feature.geometry;
        if (!geom) continue;

        if (props.symbolType === "leg" && geom.type === "LineString") {
          const coords = geom.coordinates as [number, number][];
          if (coords.length < 2) continue;

          const screenPts: Pt[] = [];
          for (const [mx, my] of coords) {
            const { lat, lng } = affine.toLatLng(mx, my);
            const { px, py } = latlngToPixel(lat, lng, viewport, cw, ch);
            screenPts.push({ x: px, y: py });
          }

          if (props.preclipped) {
            const d = screenPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
            elements.push(
              <path key={`leg-${fi}`} d={d} stroke="#c026d3" strokeWidth={legStroke} fill="none" opacity={0.85} />
            );
          } else {
            const obstacles: Pt[] = [];
            for (const c of controls) {
              const p = ctrlPixels.get(c.id);
              if (p) obstacles.push(p);
            }
            for (let si = 0; si < screenPts.length - 1; si++) {
              const segs = clipLine(screenPts[si], screenPts[si + 1], obstacles, radius * 1.2);
              for (let segi = 0; segi < segs.length; segi++) {
                const seg = segs[segi];
                elements.push(
                  <line key={`leg-${fi}-${si}-${segi}`}
                    x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2}
                    stroke="#c026d3" strokeWidth={legStroke} opacity={0.85} />
                );
              }
            }
          }
        } else if (props.symbolType === "marked_route" && geom.type === "LineString") {
          const coords = geom.coordinates as [number, number][];
          const screenPts = coords.map(([mx, my]) => {
            const { lat, lng } = affine.toLatLng(mx, my);
            return latlngToPixel(lat, lng, viewport, cw, ch);
          });
          const d = screenPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.px.toFixed(1)},${p.py.toFixed(1)}`).join(" ");
          elements.push(
            <path key={`route-${fi}`} d={d} stroke="#c026d3" strokeWidth={legStroke * 1.5}
              fill="none" opacity={0.7} strokeDasharray={`${legStroke * 4} ${legStroke * 2}`} />
          );
        } else if ((props.symbolType === "forbidden_route" || props.symbolType === "restricted_line") && geom.type === "LineString") {
          const coords = geom.coordinates as [number, number][];
          const screenPts = coords.map(([mx, my]) => {
            const { lat, lng } = affine.toLatLng(mx, my);
            return latlngToPixel(lat, lng, viewport, cw, ch);
          });
          const d = screenPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.px.toFixed(1)},${p.py.toFixed(1)}`).join(" ");
          elements.push(
            <path key={`restrict-${fi}`} d={d} stroke="#c026d3" strokeWidth={legStroke * 2}
              fill="none" opacity={0.6}
              strokeDasharray={props.symbolType === "forbidden_route" ? `${legStroke * 6} ${legStroke * 3}` : "none"} />
          );
        }
        // Note: start/finish/control symbols are rendered by the "Control symbols"
        // section below (with click handlers, badges, highlights, etc.).
        // Rendering them here from courseGeometry would produce duplicate rings.
      }
    }

    // ─── GPS route traces ─────────────────────────────────

    if (gpsRoutes && gpsRoutes.length > 0 && viewport) {
      for (let ri = 0; ri < gpsRoutes.length; ri++) {
        const route = gpsRoutes[ri];
        if (route.points.length < 2) continue;
        const screenPts = route.points.map(({ lat, lng }) =>
          latlngToPixel(lat, lng, viewport, cw, ch),
        );
        const d = screenPts
          .map((p, i) => `${i === 0 ? "M" : "L"}${p.px.toFixed(1)},${p.py.toFixed(1)}`)
          .join(" ");
        elements.push(
          <path
            key={`gps-${ri}`}
            d={d}
            stroke={route.color}
            strokeWidth={4.5}
            fill="none"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.8}
          />,
        );
      }
    }

    // ─── Fallback legs for every highlighted course ───────
    //
    // Draw straight-line legs (clipped around control circles) for every
    // highlighted course that isn't already covered by `courseGeometry`.
    // When `coursesWithGeometry` is provided, it lists the courses whose
    // routes are already drawn from precise OCD/XML geometry — those we
    // skip. Anything else highlighted (selection without imported routes,
    // or selection alongside geometry-only courses) gets legs here so
    // the user always sees *every* selected course connected.
    //
    // Back-compat: when neither `coursesWithGeometry` nor `courseGeometry`
    // is provided, fall back to the legacy behaviour of drawing just one
    // highlighted course.
    const highlightedCourses = courses.filter(
      (c) => c.highlight || c.name === highlightCourseName,
    );
    let coursesToDraw: typeof courses;
    if (coursesWithGeometry) {
      coursesToDraw = highlightedCourses.filter((c) => !coursesWithGeometry.has(c.name));
    } else if (!courseGeometry) {
      coursesToDraw = highlightedCourses.slice(0, 1);
    } else {
      coursesToDraw = [];
    }

    for (const course of coursesToDraw) {
      const obstacles: Pt[] = [];
      for (const cid of course.controls) {
        const p = ctrlPixels.get(cid);
        if (p) obstacles.push(p);
      }

      for (let i = 0; i < course.controls.length - 1; i++) {
        const fromPt = ctrlPixels.get(course.controls[i]);
        const toPt = ctrlPixels.get(course.controls[i + 1]);
        if (!fromPt || !toPt) continue;
        const segs = clipLine(fromPt, toPt, obstacles, radius * 1.2);
        for (let segi = 0; segi < segs.length; segi++) {
          const seg = segs[segi];
          elements.push(
            <line key={`fleg-${course.name}-${i}-${segi}`}
              x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2}
              stroke="#c026d3" strokeWidth={legStroke} opacity={0.85} />
          );
        }
      }
    }

    // ─── Control symbols ─────────────────────────────────

    const labelPositions: { x: number; y: number; w: number; h: number }[] = [];
    const allCirclePts: Pt[] = [];
    const allLineSegs: { x1: number; y1: number; x2: number; y2: number }[] = [];

    for (const course of courses) {
      for (let i = 0; i < course.controls.length - 1; i++) {
        const a = ctrlPixels.get(course.controls[i]);
        const b = ctrlPixels.get(course.controls[i + 1]);
        if (a && b) allLineSegs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
    }

    // Sort controls deterministically so label placement is stable across renders
    const sortedControls = [...controls].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

    // In description mode, map control IDs to sequence numbers (1, 2, 3, ...)
    const sequenceMap = new Map<string, number>();
    if (showDescriptions) {
      const activeCourse = courses.find(c => c.highlight || c.name === highlightCourseName);
      if (activeCourse) {
        let seq = 0;
        for (const cid of activeCourse.controls) {
          const ctrl = controls.find(c => c.id === cid);
          if (ctrl && ctrl.type === "Control") {
            seq++;
            sequenceMap.set(cid, seq);
          }
        }
      }
    }

    for (const c of sortedControls) {
      if (c.visible === false) continue;
      const pos = ctrlPixels.get(c.id);
      if (!pos) continue;
      allCirclePts.push(pos);
    }

    for (const c of sortedControls) {
      if (c.visible === false) continue;
      const pos = ctrlPixels.get(c.id);
      if (!pos) continue;

      const isHighlighted = c.highlight || c.id === highlightControlId;
      const baseColor =
        c.punchStatus === "missing" ? "#ef4444" :
        c.punchStatus === "extra" ? "#f59e0b" :
        c.punchStatus === "ok" ? "#059669" :
        isHighlighted ? "#ef4444" :
        "#c026d3";

      if (c.type === "Start") {
        const s = startSize;
        const triPath = `M${pos.x},${pos.y - s} L${pos.x - s * 0.866},${pos.y + s * 0.5} L${pos.x + s * 0.866},${pos.y + s * 0.5} Z`;
        elements.push(
          <path key={`start-${c.id}`} d={triPath} stroke={baseColor} strokeWidth={stroke} fill="none"
            style={{ cursor: onControlClick ? "pointer" : undefined }}
            onClick={onControlClick ? () => onControlClick(c.id) : undefined} />
        );
      } else if (c.type === "Finish") {
        elements.push(
          <g key={`finish-${c.id}`} style={{ cursor: onControlClick ? "pointer" : undefined }}
            onClick={onControlClick ? () => onControlClick(c.id) : undefined}>
            <circle cx={pos.x} cy={pos.y} r={finishOuter} stroke={baseColor} strokeWidth={stroke} fill="none" />
            <circle cx={pos.x} cy={pos.y} r={finishInner} stroke={baseColor} strokeWidth={stroke} fill="none" />
          </g>
        );
      } else {
        const cuts = getCourseGeomCuts(c.code);

        if (cuts && cuts.length > 0) {
          const adj = cuts.map(g => ({ start: g.start + (northOffset || 0), end: g.end + (northOffset || 0) }));
          const arcs = drawBrokenCircle(pos.x, pos.y, radius, adj);
          elements.push(
            <path key={`ctrl-${c.id}`} d={arcs} stroke={baseColor} strokeWidth={stroke} fill="none"
              style={{ cursor: onControlClick ? "pointer" : undefined }}
              onClick={onControlClick ? () => onControlClick(c.id) : undefined} />
          );
        } else {
          elements.push(
            <circle key={`ctrl-${c.id}`} cx={pos.x} cy={pos.y} r={radius} stroke={baseColor} strokeWidth={stroke} fill="none"
              style={{ cursor: onControlClick ? "pointer" : undefined }}
              onClick={onControlClick ? () => onControlClick(c.id) : undefined} />
          );
        }

        // Completion ring (overlaps control circle at same radius)
        if (c.completionPct !== undefined && c.completionPct > 0) {
          const ringR = radius;
          const pct = Math.min(c.completionPct, 1);
          if (pct >= 1) {
            elements.push(
              <circle key={`comp-${c.id}`} cx={pos.x} cy={pos.y} r={ringR}
                stroke="#059669" strokeWidth={stroke * 2.5} fill="none" opacity={0.8} />
            );
          } else {
            const angle = pct * 2 * Math.PI;
            const startAngle = -Math.PI / 2;
            const endAngle = startAngle + angle;
            const x1 = pos.x + ringR * Math.cos(startAngle);
            const y1 = pos.y + ringR * Math.sin(startAngle);
            const x2 = pos.x + ringR * Math.cos(endAngle);
            const y2 = pos.y + ringR * Math.sin(endAngle);
            const largeArc = angle > Math.PI ? 1 : 0;
            elements.push(
              <path key={`comp-${c.id}`}
                d={`M${x1},${y1} A${ringR},${ringR} 0 ${largeArc} 1 ${x2},${y2}`}
                stroke="#059669" strokeWidth={stroke * 2.5} fill="none" opacity={0.8} />
            );
          }
        }

        // Punch count badge
        if (c.punchCount !== undefined && c.punchCount > 0) {
          const badgeR = Math.max(6, labelSize * 0.5);
          elements.push(
            <g key={`badge-${c.id}`}
              transform={rotDeg !== 0 ? `rotate(${-rotDeg}, ${pos.x}, ${pos.y})` : undefined}>
              <circle cx={pos.x} cy={pos.y} r={badgeR} fill="#2563eb" opacity={0.85} />
              <text x={pos.x} y={pos.y} textAnchor="middle" dominantBaseline="central"
                fontSize={badgeR * 1.2} fill="white" fontWeight="bold">
                {c.punchCount}
              </text>
            </g>
          );
        }

        // Control code label (or sequence number in description mode)
        if (!hideControls) {
          const label = showDescriptions && sequenceMap.has(c.id)
            ? String(sequenceMap.get(c.id))
            : c.code;
          const estW = label.length * labelSize * 0.65;
          const estH = labelSize * 1.2;

          const offsets = [
            { dx: 1, dy: -1 }, { dx: 1, dy: 0 }, { dx: 1, dy: 1 },
            { dx: 0, dy: -1 }, { dx: -1, dy: -1 }, { dx: -1, dy: 0 },
            { dx: -1, dy: 1 }, { dx: 0, dy: 1 },
            { dx: 1.3, dy: -0.7 }, { dx: -1.3, dy: -0.7 },
            { dx: 1.3, dy: 0.7 }, { dx: -1.3, dy: 0.7 },
          ];

          let bestPos = { x: pos.x + radius * 1.3, y: pos.y - radius * 0.5 };
          let bestCost = Infinity;

          for (const off of offsets) {
            const candX = pos.x + off.dx * (radius + estW * 0.55);
            const candY = pos.y + off.dy * (radius + estH * 0.55);
            const candRect = { x: candX - estW / 2, y: candY - estH / 2, w: estW, h: estH };

            let cost = 0;
            for (const cp of allCirclePts) {
              if (cp === pos) continue;
              const dx = candX - cp.x, dy = candY - cp.y;
              const d = Math.sqrt(dx * dx + dy * dy);
              if (d < radius * 2) cost += 100;
              else if (d < radius * 3) cost += 20;
            }
            for (const lp of labelPositions) {
              if (candRect.x < lp.x + lp.w && candRect.x + candRect.w > lp.x &&
                  candRect.y < lp.y + lp.h && candRect.y + candRect.h > lp.y) {
                cost += 50;
              }
            }
            for (const seg of allLineSegs) {
              const { dist } = ptSegDist(candX, candY, seg.x1, seg.y1, seg.x2, seg.y2);
              if (dist < estH) cost += 30;
            }
            if (off.dx < 0) cost += 2;
            if (off.dy > 0) cost += 1;

            if (cost < bestCost) { bestCost = cost; bestPos = { x: candX, y: candY }; }
          }

          labelPositions.push({ x: bestPos.x - estW / 2, y: bestPos.y - estH / 2, w: estW, h: estH });

          const labelColor = (c.completionPct !== undefined && c.completionPct >= 1) ? "#059669" : baseColor;
          elements.push(
            <text key={`label-${c.id}`} x={bestPos.x} y={bestPos.y}
              textAnchor="middle" dominantBaseline="central"
              fontSize={labelSize} fill={labelColor} fontWeight="bold"
              transform={rotDeg !== 0 ? `rotate(${-rotDeg}, ${bestPos.x}, ${bestPos.y})` : undefined}
              style={{ cursor: onControlClick ? "pointer" : undefined }}
              onClick={onControlClick ? () => onControlClick(c.id) : undefined}>
              {label}
            </text>
          );
        }
      }
    }

    // Description sheet rendered separately (outside rotated div)

    // ─── Measure overlay ────────────────────────────────

    if (measuring && measurePoints.length > 0) {
      const screenMeasurePts = measurePoints.map((p) => mapMmToScreen(p.x, p.y)).filter(Boolean) as Pt[];
      let cursorScreen: Pt | null = null;
      if (measureCursor) cursorScreen = mapMmToScreen(measureCursor.x, measureCursor.y);

      const allPts = cursorScreen ? [...screenMeasurePts, cursorScreen] : screenMeasurePts;

      if (allPts.length >= 2) {
        const d = allPts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
        elements.push(
          <path key="measure-line" d={d} stroke="#2563eb" strokeWidth={3} fill="none" strokeDasharray="10 5" />
        );

        // Per-leg distance labels
        let cumDist = 0;
        for (let i = 1; i < allPts.length; i++) {
          const p1 = allPts[i - 1], p2 = allPts[i];
          const midX = (p1.x + p2.x) / 2;
          const midY = (p1.y + p2.y) / 2;
          const srcPt1 = measurePoints[i - 1];
          const srcPt2 = i < measurePoints.length ? measurePoints[i] : measureCursor;
          if (srcPt1 && srcPt2) {
            const legM = mmToMeters(mapMmDist(srcPt1, srcPt2));
            cumDist += legM;
            const label = formatDist(legM);
            const halfW = label.length * 3.5 + 6;
            elements.push(
              <g key={`mleg-${i}`}>
                <rect x={midX - halfW} y={midY - 9} width={halfW * 2} height={16} rx={3}
                  fill="rgba(255,255,255,0.85)" stroke="#93c5fd" strokeWidth={0.5} />
                <text x={midX} y={midY} textAnchor="middle" dominantBaseline="central"
                  fontSize={11} fill="#1e3a8a" fontWeight="600">{label}</text>
              </g>
            );
          }
        }
      }

      for (let i = 0; i < screenMeasurePts.length; i++) {
        elements.push(
          <circle key={`mpt-${i}`} cx={screenMeasurePts[i].x} cy={screenMeasurePts[i].y}
            r={5} fill="#2563eb" stroke="white" strokeWidth={2} />
        );
      }
    }

    return elements;

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, containerSize, renderW, renderH, controls, courses, courseGeometry, coursesWithGeometry, highlightControlId, highlightCourseName,
      symbolScale, affine, measuring, measurePoints, measureCursor, showDescriptions, hideControls, onControlClick,
      mapMmToScreen, rotDeg, gpsRoutes]);

  // ─── Description sheet (outside rotation) ──────────────

  const descriptionSheet = useMemo(() => {
    if (!showDescriptions || !courseGeometry || containerSize.w === 0 || containerSize.h === 0) return null;
    const activeCourse = courses.find(c => c.highlight || c.name === highlightCourseName);
    return renderDescriptionSheet(courseGeometry, symbolScale, containerSize.w, containerSize.h, activeCourse?.name);
  }, [showDescriptions, courseGeometry, symbolScale, containerSize, courses, highlightCourseName]);

  // ─── Scale bar ─────────────────────────────────────────

  const scaleBar = useMemo(() => {
    if (!viewport || !mapScale || containerSize.w === 0) return null;
    const mpp = metersPerPixel(viewport.centerLat, viewport.zoom);
    const targetPx = 120;
    const targetM = targetPx * mpp;

    const niceSteps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    let barM = niceSteps[0];
    for (const s of niceSteps) {
      if (s <= targetM * 2) barM = s;
    }
    const barPx = barM / mpp;
    const label = barM >= 1000 ? `${barM / 1000} km` : `${barM} m`;

    return (
      <div style={{ position: "absolute", bottom: 12, left: 12, pointerEvents: "none", zIndex: 10 }}>
        <div style={{ fontSize: 11, color: "#334155", fontWeight: 600, marginBottom: 2 }}>{label}</div>
        <div style={{ width: barPx, height: 4, background: "#334155", borderRadius: 1, opacity: 0.8 }} />
      </div>
    );
  }, [viewport, mapScale, containerSize]);

  // ─── Measure HUD ──────────────────────────────────────

  const measureHud = useMemo(() => {
    if (!measuring || measurePoints.length === 0) return null;
    let total = 0;
    for (let i = 1; i < measurePoints.length; i++) {
      total += mmToMeters(mapMmDist(measurePoints[i - 1], measurePoints[i]));
    }
    if (measureCursor && measurePoints.length > 0) {
      total += mmToMeters(mapMmDist(measurePoints[measurePoints.length - 1], measureCursor));
    }
    return (
      <div style={{
        position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
        background: "rgba(255,255,255,0.9)", borderRadius: 6, padding: "4px 12px",
        fontSize: 13, fontWeight: 600, color: "#1e3a8a", boxShadow: "0 1px 4px rgba(0,0,0,0.15)", zIndex: 10,
      }}>
        {formatDist(total)} · {measurePoints.length} pt{measurePoints.length > 1 ? "s" : ""}
      </div>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measuring, measurePoints, measureCursor, mapScale]);

  // ─── Render ───────────────────────────────────────────

  if (!mapBounds) {
    return (
      <div className={`flex items-center justify-center bg-slate-50 rounded-lg border border-slate-200 ${className}`} style={style}>
        <div className="text-center p-4">
          <p className="text-sm text-slate-500">No map uploaded</p>
        </div>
      </div>
    );
  }

  if (!viewport) {
    return (
      <div ref={containerRef} className={`flex items-center justify-center bg-slate-50 rounded-lg border border-slate-200 ${className}`} style={style}>
        <div className="text-center">
          <div className="w-8 h-8 border-3 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-slate-500">Loading map...</p>
          {tileProgress && tileProgress.rendering && tileProgress.total > 0 && (
            <>
              <div className="w-32 h-1.5 bg-slate-200 rounded-full mt-2 mx-auto">
                <div className="h-full bg-blue-500 rounded-full transition-all"
                  style={{ width: `${Math.round((tileProgress.done / tileProgress.total) * 100)}%` }} />
              </div>
              <p className="text-xs text-slate-400 mt-1">
                Generating tiles... {tileProgress.done}/{tileProgress.total}
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`relative overflow-hidden select-none bg-white ${hideControls ? "" : "rounded-lg border border-slate-200"} ${className}`}
      style={{ cursor: hideControls ? "default" : measuring ? "crosshair" : isPanningRef.current ? "grabbing" : "grab", ...style }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Rotated map layer (tiles + overlay) — corrects map north offset */}
      <div style={{
        position: "absolute",
        inset: 0,
        transform: rotDeg !== 0 ? `rotate(${rotDeg}deg)` : undefined,
        transformOrigin: "center center",
        ...(rotDeg !== 0 ? { width: renderW, height: renderH, left: (containerSize.w - renderW) / 2, top: (containerSize.h - renderH) / 2 } : {}),
      }}>
        {/* Base map tiles */}
        <TileLayer
          viewport={viewport}
          containerWidth={renderW}
          containerHeight={renderH}
          tileUrlBase={tileUrlBase}
          tileVersion={mapVersion}
        />

        {/* Overlay SVG */}
        <svg
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 2 }}
          viewBox={`0 0 ${renderW} ${renderH}`}
        >
          <g style={{ pointerEvents: "auto" }}>
            {overlayContent}
          </g>
        </svg>
      </div>

      {/* Description sheet (not rotated) */}
      {descriptionSheet && (
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 3 }}
          viewBox={`0 0 ${containerSize.w} ${containerSize.h}`}>
          {descriptionSheet}
        </svg>
      )}

      {/* Scale bar */}
      {scaleBar}

      {/* Measure HUD */}
      {measureHud}

      {/* Control buttons */}
      {!hideControls && (
        <div style={{
          position: "absolute", bottom: 12, right: 12, display: "flex", flexDirection: "column", gap: 4, zIndex: 10,
        }}>
          <button
            onClick={() => setViewport((prev) => prev ? { ...prev, zoom: Math.min(22, prev.zoom + 0.5) } : prev)}
            className="w-8 h-8 bg-white rounded shadow hover:bg-slate-50 flex items-center justify-center text-slate-600 font-bold text-lg"
            title="Zoom in"
          >+</button>
          <button
            onClick={() => setViewport((prev) => prev ? { ...prev, zoom: Math.max(1, prev.zoom - 0.5) } : prev)}
            className="w-8 h-8 bg-white rounded shadow hover:bg-slate-50 flex items-center justify-center text-slate-600 font-bold text-lg"
            title="Zoom out"
          >−</button>
          <button
            onClick={() => {
              if (mapBounds) setViewport(fitBounds(mapBounds, containerSize.w, containerSize.h, 0.05));
            }}
            className="w-8 h-8 bg-white rounded shadow hover:bg-slate-50 flex items-center justify-center"
            title="Reset view"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} className="w-4 h-4 text-slate-600">
              <path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="7" y="7" width="6" height="6" rx="0.5" fill="currentColor" opacity="0.3" />
            </svg>
          </button>
          <button
            onClick={() => {
              setMeasuring((prev) => {
                if (prev) { setMeasurePoints([]); setMeasureCursor(null); }
                return !prev;
              });
            }}
            className={`w-8 h-8 rounded shadow flex items-center justify-center ${measuring ? "bg-blue-500 text-white" : "bg-white hover:bg-slate-50 text-slate-600"}`}
            title="Measure distance"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-4 h-4">
              <path d="M3 17L17 3" strokeLinecap="round" />
              <path d="M6 14l1.5-1.5M9 11l1.5-1.5M12 8l1.5-1.5" strokeLinecap="round" />
            </svg>
          </button>
          {onToggleFullscreen && (
            <button
              onClick={onToggleFullscreen}
              className="w-8 h-8 bg-white rounded shadow hover:bg-slate-50 flex items-center justify-center text-slate-600"
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                {isFullscreen ? (
                  <path fillRule="evenodd" d="M3.28 2.22a.75.75 0 00-1.06 1.06L5.44 6.5H2.75a.75.75 0 000 1.5h4.5a.75.75 0 00.75-.75v-4.5a.75.75 0 00-1.5 0v2.69L3.28 2.22zm13.44 0a.75.75 0 10-1.06 1.06L18.88 6.5h-2.69a.75.75 0 000 1.5h4.5a.75.75 0 00.75-.75v-4.5a.75.75 0 00-1.5 0v2.69L16.72 2.22zM3.28 17.78a.75.75 0 001.06 1.06L7.56 15.5h-2.69a.75.75 0 010-1.5h4.5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-2.69L3.28 17.78zm13.44 0a.75.75 0 11-1.06 1.06L12.44 15.5h2.69a.75.75 0 010-1.5h-4.5a.75.75 0 01-.75.75v4.5a.75.75 0 011.5 0v-2.69l3.22 3.22z" clipRule="evenodd" />
                ) : (
                  <path fillRule="evenodd" d="M4.25 2A2.25 2.25 0 002 4.25v2a.75.75 0 001.5 0v-2a.75.75 0 01.75-.75h2a.75.75 0 000-1.5h-2zm9.5 0a.75.75 0 000 1.5h2a.75.75 0 01.75.75v2a.75.75 0 001.5 0v-2A2.25 2.25 0 0015.75 2h-2zM3.5 13.75a.75.75 0 00-1.5 0v2A2.25 2.25 0 004.25 18h2a.75.75 0 000-1.5h-2a.75.75 0 01-.75-.75v-2zm15 0a.75.75 0 00-1.5 0v2a.75.75 0 01-.75.75h-2a.75.75 0 000 1.5h2A2.25 2.25 0 0018.5 15.75v-2z" clipRule="evenodd" />
                )}
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Draw broken circle with slit gaps ─────────────────────

function drawBrokenCircle(cx: number, cy: number, r: number, gaps: SlitGap[]): string {
  const normalized: { start: number; end: number }[] = [];
  for (const g of gaps) {
    const s = ((g.start % 360) + 360) % 360;
    const e = ((g.end % 360) + 360) % 360;
    if (Math.abs(s - e) < 0.5) continue;
    normalized.push({ start: s, end: e });
  }

  if (normalized.length === 0) {
    return `M${cx + r},${cy} A${r},${r} 0 1 1 ${cx - r},${cy} A${r},${r} 0 1 1 ${cx + r},${cy}`;
  }

  const gapAngles: [number, number][] = [];
  for (const g of normalized) {
    if (g.start < g.end) {
      gapAngles.push([g.start, g.end]);
    } else {
      gapAngles.push([g.start, 360]);
      gapAngles.push([0, g.end]);
    }
  }
  gapAngles.sort((a, b) => a[0] - b[0]);

  const merged: [number, number][] = [];
  for (const g of gapAngles) {
    if (merged.length > 0 && g[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], g[1]);
    } else {
      merged.push([g[0], g[1]]);
    }
  }

  const arcs: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const [gs, ge] of merged) {
    if (gs > cursor) arcs.push({ start: cursor, end: gs });
    cursor = ge;
  }
  if (cursor < 360) arcs.push({ start: cursor, end: 360 });

  let d = "";
  for (const arc of arcs) {
    const sweep = arc.end - arc.start;
    if (sweep < 0.5) continue;
    const startRad = ((90 - arc.start) * Math.PI) / 180;
    const endRad = ((90 - arc.end) * Math.PI) / 180;
    const x1 = cx + r * Math.cos(startRad);
    const y1 = cy - r * Math.sin(startRad);
    const x2 = cx + r * Math.cos(endRad);
    const y2 = cy - r * Math.sin(endRad);
    const largeArc = sweep > 180 ? 1 : 0;
    d += `M${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${largeArc} 1 ${x2.toFixed(1)},${y2.toFixed(1)} `;
  }

  return d;
}

// ─── Description sheet renderer ────────────────────────────

function renderDescriptionSheet(
  courseGeometry: any,
  symbolScale: number,
  cw: number,
  ch: number,
  courseName?: string,
): React.ReactNode | null {
  if (!courseGeometry?.features) return null;

  const features = courseGeometry.features || [];
  const controlFeatures = features.filter(
    (f: any) => f.properties?.symbolType === "control" && f.properties?.code && f.properties?.description,
  );

  if (controlFeatures.length === 0) return null;

  // IOF standard: 8 columns (A=seq, B=code, C-G=description symbols, H=dimensions)
  const cellSize = Math.max(20, Math.min(36, 7 * symbolScale));
  const cols = 8;
  const headerRows = 1; // course name header
  const totalRows = headerRows + controlFeatures.length;
  const sheetW = cols * cellSize;
  const sheetH = totalRows * cellSize;

  // Position: top-right corner, clear of controls
  const sheetX = cw - sheetW - 12;
  const sheetY = 12;

  const elements: React.ReactNode[] = [];

  // Background with shadow effect
  elements.push(
    <rect key="desc-shadow" x={sheetX + 2} y={sheetY + 2} width={sheetW} height={sheetH}
      fill="rgba(0,0,0,0.1)" rx={2} />
  );
  elements.push(
    <rect key="desc-bg" x={sheetX} y={sheetY} width={sheetW} height={sheetH}
      fill="white" stroke="#94a3b8" strokeWidth={1} rx={2} />
  );

  // Header row: course name
  elements.push(
    <rect key="desc-header" x={sheetX} y={sheetY} width={sheetW} height={cellSize}
      fill="#e2e8f0" stroke="#94a3b8" strokeWidth={0.5} rx={2} />
  );
  if (courseName) {
    elements.push(
      <text key="desc-title" x={sheetX + sheetW / 2} y={sheetY + cellSize * 0.5}
        textAnchor="middle" dominantBaseline="central"
        fontSize={cellSize * 0.5} fill="#1e293b" fontWeight="bold">
        {courseName}
      </text>
    );
  }

  // Grid lines
  for (let r = 0; r <= totalRows; r++) {
    elements.push(
      <line key={`desc-hr-${r}`} x1={sheetX} y1={sheetY + r * cellSize}
        x2={sheetX + sheetW} y2={sheetY + r * cellSize} stroke="#cbd5e1" strokeWidth={0.5} />
    );
  }
  for (let c = 0; c <= cols; c++) {
    elements.push(
      <line key={`desc-vr-${c}`} x1={sheetX + c * cellSize} y1={sheetY + cellSize}
        x2={sheetX + c * cellSize} y2={sheetY + sheetH} stroke="#cbd5e1" strokeWidth={0.5} />
    );
  }

  // Control rows
  for (let i = 0; i < controlFeatures.length; i++) {
    const f = controlFeatures[i];
    const code = f.properties.code;
    const desc = f.properties.description;
    const ry = sheetY + (i + headerRows) * cellSize;
    const fs = cellSize * 0.45;

    // Column A: sequence number
    elements.push(
      <text key={`desc-seq-${i}`} x={sheetX + cellSize * 0.5} y={ry + cellSize * 0.5}
        textAnchor="middle" dominantBaseline="central" fontSize={fs} fill="#475569">
        {i + 1}
      </text>
    );
    // Column B: control code
    elements.push(
      <text key={`desc-code-${i}`} x={sheetX + cellSize * 1.5} y={ry + cellSize * 0.5}
        textAnchor="middle" dominantBaseline="central" fontSize={fs} fill="#1e293b" fontWeight="bold">
        {code}
      </text>
    );

    // Columns C-G: IOF description symbols
    const symbols = getDescriptionSymbols(desc, "#c026d3");
    const colKeys = ["colC", "colD", "colE", "colF", "colG"] as const;
    for (let ci = 0; ci < colKeys.length; ci++) {
      const content = symbols[colKeys[ci]];
      if (content) {
        const sx = sheetX + (ci + 2) * cellSize;
        if (colKeys[ci] === "colE") {
          // colE is dimensions text (e.g. "3m"), render as SVG text
          elements.push(
            <text key={`desc-sym-${i}-${ci}`} x={sx + cellSize * 0.5} y={ry + cellSize * 0.5}
              textAnchor="middle" dominantBaseline="central" fontSize={fs * 0.85} fill="#475569">
              {content}
            </text>
          );
        } else {
          // IOF symbol SVG — render as nested <svg> (foreignObject + HTML can't render raw SVG paths)
          elements.push(
            <svg key={`desc-sym-${i}-${ci}`} x={sx + 1} y={ry + 1}
              width={cellSize - 2} height={cellSize - 2}
              viewBox="-100 -100 200 200"
              dangerouslySetInnerHTML={{ __html: content }} />
          );
        }
      }
    }

    // Alternate row shading for readability
    if (i % 2 === 1) {
      elements.splice(elements.length - colKeys.length - 2, 0,
        <rect key={`desc-row-bg-${i}`} x={sheetX + 0.5} y={ry + 0.5}
          width={sheetW - 1} height={cellSize - 1} fill="#f8fafc" />
      );
    }
  }

  return <g key="desc-sheet">{elements}</g>;
}
