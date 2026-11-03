/**
 * The phone editor's bottom sheet (docs/course-editor.md §10; 08 §5.5):
 * three detents — peek (the `peek` row: KPIs, the selection, the action
 * bar), half and full (the `children`, scrolling) — moved by dragging the
 * grab handle or tapping it (peek ↔ half). It spans its positioned parent
 * (the map box) and reports its height so the page can keep the selection
 * in the band above it.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { detentHeights, nearestDetent, type Detent } from "../../lib/editor/field";

/** A handle drag shorter than this is a tap. */
const TAP_PX = 6;

export function BottomSheet({ detent, onDetent, onHeight, peek, children, label }: {
  detent: Detent;
  onDetent: (d: Detent) => void;
  /** The sheet's settled height, CSS px (0 until measured). */
  onHeight?: (px: number) => void;
  peek: ReactNode;
  children: ReactNode;
  label: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [panelPx, setPanelPx] = useState(0);
  const [dragPx, setDragPx] = useState<number | null>(null);
  const drag = useRef<{ y0: number; h0: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    const measure = () => setPanelPx(parent.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  const heights = detentHeights(panelPx);
  const height = dragPx ?? heights[detent];
  useEffect(() => {
    if (panelPx > 0 && dragPx === null) onHeight?.(heights[detent]);
  }, [panelPx, detent, dragPx]); // eslint-disable-line react-hooks/exhaustive-deps -- heights derive from panelPx

  return (
    <div ref={rootRef} data-testid="editor-sheet" data-detent={detent} role="region" aria-label={label}
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex flex-col bg-white/95 backdrop-blur-sm border-t border-slate-200 rounded-t-2xl shadow-[0_-4px_16px_rgba(0,0,0,0.08)] text-sm"
      style={{ height: panelPx > 0 ? height : undefined, transition: dragPx === null ? "height 160ms ease-out" : undefined }}>
      <button type="button" data-testid="editor-sheet-handle" aria-label={label}
        className="shrink-0 h-6 w-full flex items-center justify-center touch-none cursor-grab"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { y0: e.clientY, h0: heights[detent], moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dy = d.y0 - e.clientY;
          if (Math.abs(dy) > TAP_PX) d.moved = true;
          if (d.moved) setDragPx(Math.max(heights.peek, Math.min(heights.full, d.h0 + dy)));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          setDragPx(null);
          if (!d) return;
          if (!d.moved) onDetent(detent === "peek" ? "half" : "peek");
          else onDetent(nearestDetent(Math.max(heights.peek, Math.min(heights.full, d.h0 + d.y0 - e.clientY)), heights));
        }}
        onPointerCancel={() => { drag.current = null; setDragPx(null); }}>
        <span className="block w-10 h-1.5 rounded-full bg-slate-300" />
      </button>
      <div className="shrink-0 px-3">{peek}</div>
      <div data-testid="editor-sheet-body" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-2" hidden={detent === "peek" && dragPx === null}>
        {children}
      </div>
    </div>
  );
}
