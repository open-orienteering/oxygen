import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  /** Forwarded ref callback so the parent can grab the portal target div. */
  setPortalTarget: (el: HTMLDivElement | null) => void;
  /** Set to false when no slot is currently active (pane visually hides). */
  visible: boolean;
  /** Hide-pane callback wired to the collapse button. */
  onCollapse: () => void;
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
 * Right-side pane that holds a portal target for `<MapSlot>`-wrapped maps.
 *
 * The pane:
 * - Renders a small chrome row with a collapse button.
 * - Exposes a 4px drag handle on its left edge that updates the
 *   `--map-pane-width` CSS variable on the shell container during drag
 *   (no React re-renders), then persists the final value via
 *   `onWidthCommit` on pointer-up.
 * - Is always rendered while wide+not-collapsed even when no slot is
 *   active, so the portal target ref stays stable. The `visible` prop
 *   controls CSS visibility only — keeping the DOM target alive lets
 *   `<MapSlot>` portal without remounting children when the count
 *   transitions 0 → 1.
 */
export function MapPane({
  setPortalTarget,
  visible,
  onCollapse,
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

      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 bg-slate-50">
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
          {t("mapPaneLabel")}
        </span>
        <button
          type="button"
          onClick={onCollapse}
          title={t("hideMapPaneTitle")}
          data-testid="map-pane-collapse"
          className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors cursor-pointer"
        >
          <span className="sr-only">{t("hideMapPane")}</span>
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13 5l7 7-7 7M5 5l7 7-7 7"
            />
          </svg>
        </button>
      </div>

      <div
        ref={setPortalTarget}
        data-testid="map-pane-target"
        className="h-[calc(100%-2.5rem)] overflow-hidden"
      />
    </aside>
  );
}
