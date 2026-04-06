/**
 * Canvas-based map image renderer for the replay viewer.
 *
 * Loads map tiles (positioned by pixel offset, not slippy-map z/x/y) from
 * the ReplayMap definition and composites them onto a canvas. Supports
 * zoom, pan, and rotation.
 */

import {
  useRef,
  useEffect,
  useCallback,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";
import type { ReplayMap, ReplayProjection } from "@oxygen/shared";
import { latLngToMapPx, mapPxToLatLng } from "./projection-utils";

export interface ViewportState {
  /** Centre of the viewport in map-pixel coordinates. */
  cx: number;
  cy: number;
  /** Pixels on screen per map pixel. */
  scale: number;
  /** Map rotation in radians (applied around the viewport centre). */
  rotation: number;
}

export interface ReplayMapLayerHandle {
  getViewport: () => ViewportState;
  /** Programmatically update the viewport (for auto-panning). */
  setViewport: (vp: ViewportState) => void;
  /** Convert map pixel → screen pixel. */
  mapToScreen: (mx: number, my: number) => { sx: number; sy: number };
  /** Convert screen pixel → map pixel. */
  screenToMap: (sx: number, sy: number) => { mx: number; my: number };
}

interface Props {
  map: ReplayMap;
  className?: string;
  style?: React.CSSProperties;
  /** Called after every viewport change. */
  onViewportChange?: (vp: ViewportState) => void;
  children?: React.ReactNode;
  /**
   * If provided, use native OCAD tiles from this base URL instead of the
   * Livelox map image. Example: "/api/map-tile/my_competition"
   */
  nativeTileBase?: string;
}

// ─── Native tile helpers (module-level, no React deps) ────────

/** Convert Web Mercator tile-y index to latitude. */
function tileYToLat(y: number, n: number): number {
  const t = Math.PI - (2 * Math.PI * y) / n;
  return (180 / Math.PI) * Math.atan((Math.exp(t) - Math.exp(-t)) / 2);
}

/**
 * Choose a slippy-map zoom level so that one tile ≈ 256 screen pixels.
 * `scale` is "screen pixels per Livelox map pixel".
 */
function pickNativeZoom(scale: number, proj: ReplayProjection): number {
  const [a] = proj.matrix;
  const cosLat = Math.cos((proj.originLat * Math.PI) / 180);
  // Livelox px per degree lng = |a| * DEG_TO_M_LNG
  // A tile at zoom z spans 360/2^z degrees → tile_livelox_px = |a| * 111320 * cosLat * 360 / 2^z
  // Want tile_livelox_px * scale ≈ 256
  const ideal = Math.log2((Math.abs(a) * 111320 * cosLat * 360 * scale) / 256);
  return Math.max(10, Math.min(17, Math.round(ideal)));
}

/**
 * Draw native slippy-map tiles on the canvas.
 * Must be called with the DPR-scaled context active (but outside any
 * viewport save/restore block).  Tiles are projected from lat/lng → Livelox
 * map pixels → CSS screen pixels using the existing affine projection.
 */
function drawNativeTilesOnCanvas(
  ctx: CanvasRenderingContext2D,
  vp: ViewportState,
  cw: number,
  ch: number,
  proj: ReplayProjection,
  tileBase: string,
  tileImages: Map<string, HTMLImageElement>,
  requestLoad: (url: string) => void,
) {
  const z = pickNativeZoom(vp.scale, proj);
  const n = Math.pow(2, z);

  // Project screen corners → map pixels → lat/lng to find the visible bbox
  const cos_r = Math.cos(-vp.rotation);
  const sin_r = Math.sin(-vp.rotation);
  const latLngs = (
    [{ sx: 0, sy: 0 }, { sx: cw, sy: 0 }, { sx: 0, sy: ch }, { sx: cw, sy: ch }] as const
  ).map(({ sx, sy }) => {
    const dx = sx - cw / 2, dy = sy - ch / 2;
    const mx = (cos_r * dx - sin_r * dy) / vp.scale + vp.cx;
    const my = (sin_r * dx + cos_r * dy) / vp.scale + vp.cy;
    return mapPxToLatLng(mx, my, proj);
  });

  const minLat = Math.min(...latLngs.map((c) => c.lat));
  const maxLat = Math.max(...latLngs.map((c) => c.lat));
  const minLng = Math.min(...latLngs.map((c) => c.lng));
  const maxLng = Math.max(...latLngs.map((c) => c.lng));

  // Tile index range (with 1-tile border for smooth panning)
  const x0 = Math.max(0, Math.floor(((minLng + 180) / 360) * n) - 1);
  const x1 = Math.min(n - 1, Math.floor(((maxLng + 180) / 360) * n) + 1);
  const toTileY = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };
  const y0 = Math.max(0, toTileY(maxLat) - 1);
  const y1 = Math.min(n - 1, toTileY(minLat) + 1);

  if (x1 - x0 > 30 || y1 - y0 > 30) return; // sanity guard

  // Helper: Livelox map pixel → CSS screen pixel
  const cos_v = Math.cos(vp.rotation);
  const sin_v = Math.sin(vp.rotation);
  const mts = (mx: number, my: number) => {
    const dx = (mx - vp.cx) * vp.scale;
    const dy = (my - vp.cy) * vp.scale;
    return { sx: cos_v * dx - sin_v * dy + cw / 2, sy: sin_v * dx + cos_v * dy + ch / 2 };
  };

  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      const lng0 = (tx / n) * 360 - 180;
      const lng1 = ((tx + 1) / n) * 360 - 180;
      const lat0 = tileYToLat(ty, n);
      const lat1 = tileYToLat(ty + 1, n);

      // 3 tile corners: lat/lng → Livelox px → CSS screen px
      const tl_mp = latLngToMapPx(lat0, lng0, proj);
      const tr_mp = latLngToMapPx(lat0, lng1, proj);
      const bl_mp = latLngToMapPx(lat1, lng0, proj);
      const tl = mts(tl_mp.px, tl_mp.py);
      const tr = mts(tr_mp.px, tr_mp.py);
      const bl = mts(bl_mp.px, bl_mp.py);

      // Affine from tile pixel (0..256) to CSS screen pixel
      // (ctx already has DPR scale, so ctx.transform composes correctly)
      const a = (tr.sx - tl.sx) / 256;
      const b = (tr.sy - tl.sy) / 256;
      const c = (bl.sx - tl.sx) / 256;
      const d = (bl.sy - tl.sy) / 256;

      const url = `${tileBase}/${z}/${tx}/${ty}`;
      const img = tileImages.get(url);
      if (!img) {
        requestLoad(url);
        continue;
      }
      if (!img.complete || img.naturalWidth === 0) continue;

      ctx.save();
      ctx.transform(a, b, c, d, tl.sx, tl.sy);
      ctx.drawImage(img, 0, 0, 256, 256);
      ctx.restore();
    }
  }
}

export const ReplayMapLayer = forwardRef<ReplayMapLayerHandle, Props>(
  function ReplayMapLayer({ map, className, style, onViewportChange, children, nativeTileBase }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

    // Viewport state (mutable ref for perf — re-renders via onViewportChange)
    // The projection matrix already encodes any geographic rotation, so tiles are
    // drawn unrotated (rotation: 0). map.rotation is metadata only.
    const vpRef = useRef<ViewportState>({
      cx: map.widthPx / 2,
      cy: map.heightPx / 2,
      scale: 1,
      rotation: 0,
    });

    // Livelox tile images cache
    const tileImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const [tilesLoaded, setTilesLoaded] = useState(0);

    // Native (OCAD) tile images cache + load counter for redraw triggering
    const nativeTileImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const [nativeTilesVersion, setNativeTilesVersion] = useState(0);

    // ─── Resize observer ──────────────────────────────────────
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const ro = new ResizeObserver((entries) => {
        const { width, height } = entries[0].contentRect;
        setContainerSize({ w: width, h: height });
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    // Fit map to container on first render or when container resizes
    useEffect(() => {
      if (containerSize.w === 0 || containerSize.h === 0) return;
      const scaleX = containerSize.w / map.widthPx;
      const scaleY = containerSize.h / map.heightPx;
      const fitScale = Math.min(scaleX, scaleY) * 0.95;
      vpRef.current = {
        cx: map.widthPx / 2,
        cy: map.heightPx / 2,
        scale: fitScale,
        rotation: 0,
      };
      drawMap();
      onViewportChange?.(vpRef.current);
    }, [containerSize.w, containerSize.h, map.widthPx, map.heightPx]);

    // ─── Load Livelox tiles (skipped when using native tiles) ─
    useEffect(() => {
      if (nativeTileBase) return; // native tiles loaded on demand in drawMap

      const tiles = map.tiles ?? [];
      if (tiles.length === 0 && map.imageUrl) {
        // Single image fallback
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          tileImagesRef.current.set("full", img);
          setTilesLoaded((n) => n + 1);
        };
        img.src = map.imageUrl;
        return;
      }

      for (const tile of tiles) {
        const key = `${tile.x}-${tile.y}`;
        if (tileImagesRef.current.has(key)) continue;
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          tileImagesRef.current.set(key, img);
          setTilesLoaded((n) => n + 1);
        };
        img.onerror = () => {
          setTilesLoaded((n) => n + 1);
        };
        img.src = tile.url;
      }
    }, [map.tiles, map.imageUrl, nativeTileBase]);

    // Redraw when Livelox tiles or native tiles load
    useEffect(() => { drawMap(); }, [tilesLoaded]);
    useEffect(() => { drawMap(); }, [nativeTilesVersion]);

    // ─── Transform helpers ────────────────────────────────────
    const mapToScreen = useCallback(
      (mx: number, my: number): { sx: number; sy: number } => {
        const vp = vpRef.current;
        const cos = Math.cos(vp.rotation);
        const sin = Math.sin(vp.rotation);
        const dx = (mx - vp.cx) * vp.scale;
        const dy = (my - vp.cy) * vp.scale;
        return {
          sx: cos * dx - sin * dy + containerSize.w / 2,
          sy: sin * dx + cos * dy + containerSize.h / 2,
        };
      },
      [containerSize],
    );

    const screenToMap = useCallback(
      (sx: number, sy: number): { mx: number; my: number } => {
        const vp = vpRef.current;
        const cos = Math.cos(-vp.rotation);
        const sin = Math.sin(-vp.rotation);
        const dx = sx - containerSize.w / 2;
        const dy = sy - containerSize.h / 2;
        const rx = cos * dx - sin * dy;
        const ry = sin * dx + cos * dy;
        return {
          mx: rx / vp.scale + vp.cx,
          my: ry / vp.scale + vp.cy,
        };
      },
      [containerSize],
    );

    // drawMap is defined below — use a ref to avoid ordering issues
    const drawMapRef = useRef<() => void>(() => {});

    useImperativeHandle(
      ref,
      () => ({
        getViewport: () => vpRef.current,
        setViewport: (vp: ViewportState) => {
          vpRef.current = vp;
          drawMapRef.current();
          onViewportChange?.(vp);
        },
        mapToScreen,
        screenToMap,
      }),
      [mapToScreen, screenToMap, onViewportChange],
    );

    // ─── Request a native tile load (called from drawMap) ─────
    const requestNativeTileLoad = useCallback((url: string) => {
      if (nativeTileImagesRef.current.has(url)) return;
      const img = new Image();
      img.crossOrigin = "anonymous";
      nativeTileImagesRef.current.set(url, img); // prevent duplicate loads
      img.onload = () => setNativeTilesVersion((v) => v + 1);
      img.src = url;
    }, []);

    // ─── Canvas draw ──────────────────────────────────────────
    const drawMap = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = containerSize.w * dpr;
      canvas.height = containerSize.h * dpr;
      ctx.scale(dpr, dpr);

      ctx.clearRect(0, 0, containerSize.w, containerSize.h);

      const vp = vpRef.current;

      if (nativeTileBase) {
        // Draw native OCAD tiles using the Livelox affine projection
        drawNativeTilesOnCanvas(
          ctx, vp, containerSize.w, containerSize.h,
          map.projection, nativeTileBase,
          nativeTileImagesRef.current, requestNativeTileLoad,
        );
      } else {
        // Draw Livelox map tiles / image
        ctx.save();
        ctx.translate(containerSize.w / 2, containerSize.h / 2);
        ctx.rotate(vp.rotation);
        ctx.scale(vp.scale, vp.scale);
        ctx.translate(-vp.cx, -vp.cy);

        const tiles = map.tiles ?? [];
        if (tiles.length > 0) {
          for (const tile of tiles) {
            const key = `${tile.x}-${tile.y}`;
            const img = tileImagesRef.current.get(key);
            if (img) ctx.drawImage(img, tile.x, tile.y, tile.width, tile.height);
          }
        } else {
          const img = tileImagesRef.current.get("full");
          if (img) ctx.drawImage(img, 0, 0, map.widthPx, map.heightPx);
        }

        ctx.restore();
      }
    }, [containerSize, map, nativeTileBase, requestNativeTileLoad]);

    // Keep ref in sync so imperative setViewport can call drawMap
    drawMapRef.current = drawMap;

    // ─── Smooth zoom via spring-damper ───────────────────────
    // targetScaleRef: desired scale; zoomVelRef: current zoom velocity (scale/frame).
    // Using a second-order model: velocity is itself smoothed each frame, giving
    // smooth acceleration AND deceleration (no abrupt start/stop).
    const targetScaleRef = useRef<number | null>(null);
    const zoomVelRef = useRef(0);
    const zoomAnchorRef = useRef<{ sx: number; sy: number; mx: number; my: number } | null>(null);
    const zoomRafRef = useRef<number>(0);

    // Helper: given a new scale, adjust cx/cy so that the anchor map point keeps its
    // relative position on screen. Uses the current cx/cy (which may have been moved
    // by the follow-pan loop) rather than recomputing from a fixed screen coordinate,
    // so zoom and pan compose without fighting each other.
    const applyScaleWithAnchor = useCallback(
      (newScale: number, anchor: { sx: number; sy: number; mx: number; my: number }) => {
        const vp = vpRef.current;
        const ratio = vp.scale / newScale;
        const newCx = anchor.mx - (anchor.mx - vp.cx) * ratio;
        const newCy = anchor.my - (anchor.my - vp.cy) * ratio;
        vpRef.current = { ...vp, scale: newScale, cx: newCx, cy: newCy };
      },
      [],
    );

    const animateZoom = useCallback(() => {
      const target = targetScaleRef.current;
      const anchor = zoomAnchorRef.current;
      if (target === null || anchor === null) return;
      const vp = vpRef.current;

      // Spring: desired velocity proportional to distance from target.
      // Smooth the velocity itself so acceleration/deceleration are gradual.
      const desiredVel = (target - vp.scale) * 0.045;
      zoomVelRef.current += (desiredVel - zoomVelRef.current) * 0.5;

      if (Math.abs(zoomVelRef.current) < vp.scale * 0.0003 && Math.abs(target - vp.scale) < vp.scale * 0.001) {
        applyScaleWithAnchor(target, anchor);
        targetScaleRef.current = null;
        zoomAnchorRef.current = null;
        zoomVelRef.current = 0;
        drawMap();
        onViewportChange?.(vpRef.current);
        return;
      }

      applyScaleWithAnchor(vp.scale + zoomVelRef.current, anchor);
      drawMap();
      onViewportChange?.(vpRef.current);
      zoomRafRef.current = requestAnimationFrame(animateZoom);
    }, [applyScaleWithAnchor, drawMap, onViewportChange]);

    // ─── Interaction: pan + zoom ──────────────────────────────
    const dragRef = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);

    const onPointerDown = useCallback((e: React.PointerEvent) => {
      if (e.button !== 0) return;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        sx: e.clientX,
        sy: e.clientY,
        cx: vpRef.current.cx,
        cy: vpRef.current.cy,
      };
    }, []);

    const onPointerMove = useCallback(
      (e: React.PointerEvent) => {
        if (!dragRef.current) return;
        const vp = vpRef.current;
        const dx = e.clientX - dragRef.current.sx;
        const dy = e.clientY - dragRef.current.sy;

        // Rotate the drag delta by the inverse of the viewport rotation
        const cos = Math.cos(-vp.rotation);
        const sin = Math.sin(-vp.rotation);
        const rdx = cos * dx - sin * dy;
        const rdy = sin * dx + cos * dy;

        vpRef.current = {
          ...vp,
          cx: dragRef.current.cx - rdx / vp.scale,
          cy: dragRef.current.cy - rdy / vp.scale,
        };
        drawMap();
        onViewportChange?.(vpRef.current);
      },
      [drawMap, onViewportChange],
    );

    const onPointerUp = useCallback(() => {
      dragRef.current = null;
    }, []);

    const onWheel = useCallback(
      (e: React.WheelEvent) => {
        e.preventDefault();
        const vp = vpRef.current;
        const currentTarget = targetScaleRef.current ?? vp.scale;
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newTarget = Math.max(0.05, Math.min(20, currentTarget * factor));
        targetScaleRef.current = newTarget;

        // Anchor: keep the map point under the cursor fixed during zoom
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect && !zoomAnchorRef.current) {
          const sx = e.clientX - rect.left;
          const sy = e.clientY - rect.top;
          const { mx, my } = screenToMap(sx, sy);
          zoomAnchorRef.current = { sx, sy, mx, my };
        }

        cancelAnimationFrame(zoomRafRef.current);
        zoomRafRef.current = requestAnimationFrame(animateZoom);
      },
      [animateZoom, screenToMap],
    );

    // Touch pinch zoom
    const touchRef = useRef<{ d: number; scale: number } | null>(null);

    const onTouchStart = useCallback((e: React.TouchEvent) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        touchRef.current = { d: Math.hypot(dx, dy), scale: vpRef.current.scale };
      }
    }, []);

    const onTouchMove = useCallback(
      (e: React.TouchEvent) => {
        if (e.touches.length === 2 && touchRef.current) {
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          const d = Math.hypot(dx, dy);
          const newScale = Math.max(0.05, Math.min(20, touchRef.current.scale * (d / touchRef.current.d)));
          vpRef.current = { ...vpRef.current, scale: newScale };
          drawMap();
          onViewportChange?.(vpRef.current);
        }
      },
      [drawMap, onViewportChange],
    );

    const onTouchEnd = useCallback(() => {
      touchRef.current = null;
    }, []);

    return (
      <div
        ref={containerRef}
        className={className}
        style={{ position: "relative", overflow: "hidden", ...style }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            touchAction: "none",
          }}
        />
        {children}
      </div>
    );
  },
);
