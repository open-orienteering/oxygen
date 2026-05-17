import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  /** Hosted content (the shell-owned persistent `<MapPanel>`). */
  children?: ReactNode;
  /** Set to false when no slot is currently active (pane visually hides). */
  visible: boolean;
  /** Lower bound for the pane width (px). */
  minWidth?: number;
  /**
   * Hard upper bound for the pane width (px). Defaults to "no static cap";
   * the effective ceiling is then driven by `minContentWidth` (the pane is
   * never allowed to leave less than this many pixels for the page
   * content). This keeps the drag from making the table column unusable
   * while letting users on ultra-wide monitors size the map as big as
   * makes sense for them.
   */
  maxWidth?: number;
  /** Minimum width (px) the left content column must retain. */
  minContentWidth?: number;
  /**
   * Called continuously during drag with the clamped target width in px.
   * The parent applies this imperatively (e.g. via `style.setProperty`) so
   * the drag doesn't re-render React on every pointer move.
   */
  onLiveResize: (px: number) => void;
  /** Persist a new width when the user releases the drag handle. */
  onWidthCommit: (next: number) => void;
}

/**
 * Right-side pane that hosts the persistent `<MapPanel>`.
 *
 * The pane:
 * - Has no chrome of its own — the collapse button and "MAP" label
 *   live inside the hosted MapPanel's toolbar (one unified header
 *   across all pages, instead of the previous two stacked headers).
 * - Exposes a 4px drag handle on its left edge that updates the
 *   `--map-pane-width` CSS variable on the shell container during drag
 *   (no React re-renders), then persists the final value via
 *   `onWidthCommit` on pointer-up.
 * - Is always mounted while wide+not-collapsed; the `visible` prop just
 *   toggles `display: none` so the underlying MapPanel React fibre
 *   stays alive when no page is currently driving content (avoids
 *   remounting the MapViewer on transient empty states).
 */
export function MapPane({
  children,
  visible,
  minWidth = 600,
  maxWidth = Number.POSITIVE_INFINITY,
  minContentWidth = 480,
  onLiveResize,
  onWidthCommit,
}: Props) {
  const { t } = useTranslation("nav");
  // Ref holding the active drag's listener cleanup, so we can detach
  // listeners on unmount without leaking. Document-level mousemove/mouseup
  // listeners (instead of pointer capture) keep the drag responsive even
  // when the pointer briefly leaves the handle's small hit-box, and play
  // nicely with Playwright's `page.mouse.*` API.
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      let lastWidth: number | null = null;

      const onMove = (ev: MouseEvent) => {
        const proposed = window.innerWidth - ev.clientX;
        // Upper bound: smaller of the explicit `maxWidth` (typically unset
        // → +Infinity) and "leave at least `minContentWidth` px for the
        // page content column". On a 3600px monitor with the defaults
        // that resolves to ~3120px, letting users on ultra-wide monitors
        // grow the map far past the legacy 1600px cap.
        const upperBound = Math.max(
          minWidth,
          Math.min(maxWidth, window.innerWidth - minContentWidth),
        );
        const clamped = Math.max(minWidth, Math.min(upperBound, proposed));
        lastWidth = clamped;
        onLiveResize(clamped);
      };

      const onUp = () => {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        cleanupRef.current = null;
        if (lastWidth != null) onWidthCommit(lastWidth);
      };

      cleanupRef.current?.();
      cleanupRef.current = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [minWidth, maxWidth, minContentWidth, onLiveResize, onWidthCommit],
  );

  return (
    <aside
      data-testid="map-pane"
      data-visible={visible ? "true" : "false"}
      className={`relative bg-white border-l border-slate-200 sticky top-24 self-start ${
        visible ? "block" : "hidden"
      }`}
      style={{
        height: "calc(100vh - 6rem)",
      }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("resizeMapPane")}
        data-testid="map-pane-resize-handle"
        onMouseDown={onMouseDown}
        className="absolute top-0 bottom-0 -left-1 w-2 cursor-col-resize z-20 group"
      >
        {/* Visible affordance — narrower than the hit zone for comfort. */}
        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-transparent group-hover:bg-blue-400 transition-colors" />
      </div>

      <div
        data-testid="map-pane-content"
        className="h-full overflow-hidden"
      >
        {children}
      </div>
    </aside>
  );
}
