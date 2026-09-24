/**
 * Magnifier loupe shown while dragging a control in the course editor.
 * Reuses the shared TileBlobCache (passive TileLayers) so it never
 * fights the main map's fetch queue — it just scales whatever tiles
 * are already loaded around the drag point.
 */

import type { TileViewport } from "../lib/geo-utils";
import { TileLayer } from "./TileLayer";

interface Props {
  /** Screen position of the drag point inside the map container. */
  anchorX: number;
  anchorY: number;
  /** Container size (same as the main map). */
  containerWidth: number;
  containerHeight: number;
  viewport: TileViewport;
  tileUrlBase?: string;
  tileVersion?: number | string;
  /** Map north-offset rotation in degrees (matches the main map). */
  rotDeg?: number;
  /** Control-circle radius in screen px at the current zoom. */
  controlRadiusPx: number;
  /** Prefer a larger loupe on touch. */
  touch?: boolean;
}

const SCALE = 2.5;

export function MapLoupe({
  anchorX,
  anchorY,
  containerWidth,
  containerHeight,
  viewport,
  tileUrlBase,
  tileVersion,
  rotDeg = 0,
  controlRadiusPx,
  touch = false,
}: Props) {
  const size = touch ? 170 : 150;
  const half = size / 2;

  // Prefer above the finger/cursor; flip below near the top edge.
  // On mouse, nudge up-right so the loupe doesn't cover the target.
  const offsetY = anchorY < size + 24 ? half + 28 : -(half + 28);
  const offsetX = touch ? 0 : half * 0.35;
  let left = anchorX + offsetX - half;
  let top = anchorY + offsetY - half;
  left = Math.max(4, Math.min(containerWidth - size - 4, left));
  top = Math.max(4, Math.min(containerHeight - size - 4, top));

  // Translate so the drag point sits at the loupe centre after scale.
  const tx = half - anchorX * SCALE;
  const ty = half - anchorY * SCALE;

  return (
    <div
      data-testid="editor-loupe"
      className="pointer-events-none absolute z-20 overflow-hidden rounded-full border-2 border-slate-700 shadow-lg bg-white"
      style={{
        left,
        top,
        width: size,
        height: size,
      }}
    >
      <div
        style={{
          position: "absolute",
          width: containerWidth,
          height: containerHeight,
          transform: `translate(${tx}px, ${ty}px) scale(${SCALE})`,
          transformOrigin: "0 0",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            transform: rotDeg !== 0 ? `rotate(${rotDeg}deg)` : undefined,
            transformOrigin: "center center",
          }}
        >
          <TileLayer
            viewport={viewport}
            containerWidth={containerWidth}
            containerHeight={containerHeight}
            tileUrlBase={tileUrlBase}
            tileVersion={tileVersion}
            half="top"
            zIndex={1}
            passive
          />
          <TileLayer
            viewport={viewport}
            containerWidth={containerWidth}
            containerHeight={containerHeight}
            tileUrlBase={tileUrlBase}
            tileVersion={tileVersion}
            half="bottom"
            zIndex={2}
            passive
          />
        </div>
      </div>
      {/* Crosshair + control circle at loupe centre */}
      <svg
        width={size}
        height={size}
        className="absolute inset-0"
        style={{ pointerEvents: "none" }}
      >
        <line
          x1={half - 14}
          y1={half}
          x2={half + 14}
          y2={half}
          stroke="#1e293b"
          strokeWidth={1.5}
        />
        <line
          x1={half}
          y1={half - 14}
          x2={half}
          y2={half + 14}
          stroke="#1e293b"
          strokeWidth={1.5}
        />
        <circle
          cx={half}
          cy={half}
          r={Math.max(6, controlRadiusPx * SCALE)}
          fill="none"
          stroke="#c026d3"
          strokeWidth={2}
        />
      </svg>
    </div>
  );
}
