/**
 * The viewer's 3D mode controls (docs/map-rendering.md §5.4 "3D mode"): the
 * 2D / 3D toggle with the exaggeration control, the fallback notice, and the
 * pointer surface that takes the map's gestures while 3D is drawn. The
 * state lives in `MapViewer`; the rules in `lib/map-3d.ts`.
 */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { EXAGGERATION, GESTURE_IDLE, reduceGesture3d, type Gesture3dEvent, type Gesture3dState, type Scene3d, type Terrain3dReason, type View3d } from "../lib/map-3d";
import { TERRAIN_3D_MIN_DECIDED } from "../lib/map-review";

export type Map3dToggleState = "off" | "loading" | "on" | "unavailable";

/** The reason's line (`map-3d-notice`, the toggle's title). */
function useReasonText(): (reason: Terrain3dReason, percent?: number) => string {
  const { t } = useTranslation("dashboard");
  return (reason, percent) => t(`map3dReason.${reason}`, { percent: percent ?? 0, min: Math.round(TERRAIN_3D_MIN_DECIDED * 100) });
}

export function Map3dToggle({ state, reason, exaggeration, onToggle, onExaggeration }: {
  state: Map3dToggleState;
  /** An unavailable toggle's reason (its title). */
  reason: { reason: Terrain3dReason; percent?: number } | null;
  exaggeration: number;
  onToggle: () => void;
  onExaggeration: (e: number) => void;
}) {
  const { t } = useTranslation("dashboard");
  const reasonText = useReasonText();
  const on = state === "on", unavailable = state === "unavailable";
  const label = unavailable && reason ? reasonText(reason.reason, reason.percent) : on ? t("map3dExit") : state === "loading" ? t("map3dLoading") : t("map3dEnter");
  return (
    <div className="relative flex items-center">
      {on && (
        <label
          className="absolute right-10 flex items-center gap-1.5 whitespace-nowrap rounded bg-white px-2 py-1 text-xs text-slate-600 shadow"
          title={t("map3dExaggeration")}
        >
          <span className="sr-only">{t("map3dExaggeration")}</span>
          <span aria-hidden="true">⛰</span>
          <input
            type="range"
            data-testid="map-3d-exaggeration"
            min={EXAGGERATION.min}
            max={EXAGGERATION.max}
            step={EXAGGERATION.step}
            value={exaggeration}
            onChange={(e) => onExaggeration(Number(e.target.value))}
            className="w-20 accent-blue-600"
            aria-label={t("map3dExaggeration")}
          />
          <span className="w-7 tabular-nums">{exaggeration}×</span>
        </label>
      )}
      <button
        type="button"
        data-testid="map-3d-toggle"
        data-state={state}
        onClick={onToggle}
        aria-pressed={on}
        aria-disabled={unavailable || undefined}
        title={label}
        aria-label={label}
        className={`w-8 h-8 rounded shadow flex items-center justify-center text-[11px] font-bold ${
          on ? "bg-blue-500 text-white" : unavailable ? "bg-white text-slate-300" : "bg-white hover:bg-slate-50 text-slate-600"
        } ${state === "loading" ? "animate-pulse" : ""}`}
      >
        3D
      </button>
    </div>
  );
}

/** The fallback's one line over the map (`map-3d-notice`). */
export function Map3dNotice({ reason, percent }: { reason: Terrain3dReason; percent?: number }) {
  const text = useReasonText()(reason, percent);
  return (
    <div data-testid="map-3d-notice" data-reason={reason} className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-4">
      <div className="rounded-md bg-slate-900/85 px-3 py-1 text-xs text-white shadow">{text}</div>
    </div>
  );
}

/**
 * Takes the pointer, touch and wheel events over the map in 3D and runs them through
 * `reduceGesture3d`; the 2D handlers on the viewer never see them (they are stopped here, natively,
 * before they bubble to the viewer's own listeners).
 */
export function Map3dSurface({ view, scene, oneFingerPans, onView }: {
  view: View3d;
  scene: Scene3d;
  /** 2D's one-finger rule: false on a coarse pointer outside fullscreen (the page scrolls). */
  oneFingerPans: boolean;
  onView: (v: View3d) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef({ view, scene, oneFingerPans, onView });
  live.current = { view, scene, oneFingerPans, onView };
  const gesture = useRef<Gesture3dState>(GESTURE_IDLE);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const local = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const step = (ev: Gesture3dEvent) => {
      const l = live.current;
      const r = reduceGesture3d(l.view, gesture.current, ev, l.scene);
      gesture.current = r.state;
      if (r.changed) {
        // the next event of the same gesture builds on this view, before React re-renders
        l.view = r.view;
        l.onView(r.view);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 2) return;
      const touch = e.pointerType === "touch";
      el.setPointerCapture?.(e.pointerId);
      const orbit = !touch && (e.button === 2 || e.ctrlKey || e.metaKey);
      step({ type: "down", id: e.pointerId, ...local(e), orbit, pan: !touch || live.current.oneFingerPans });
      if (!touch || live.current.oneFingerPans || gesture.current.pointers.length > 1) e.preventDefault();
    };
    const onMove = (e: PointerEvent) => step({ type: "move", id: e.pointerId, ...local(e) });
    const onUp = (e: PointerEvent) => {
      el.releasePointerCapture?.(e.pointerId);
      step({ type: "up", id: e.pointerId });
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      step({ type: "wheel", ...local(e), deltaY: e.deltaY });
    };
    const stop = (e: Event) => e.stopPropagation();
    // Two fingers are the map's even where one finger scrolls the page.
    const onTouch = (e: TouchEvent) => {
      e.stopPropagation();
      if (e.touches.length > 1 || live.current.oneFingerPans) e.preventDefault();
    };
    const noMenu = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouch, { passive: false });
    el.addEventListener("touchmove", onTouch, { passive: false });
    el.addEventListener("touchend", stop);
    el.addEventListener("contextmenu", noMenu);
    for (const t of ["mousedown", "mousemove", "mouseup", "click", "dblclick"]) el.addEventListener(t, stop);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouch);
      el.removeEventListener("touchmove", onTouch);
      el.removeEventListener("touchend", stop);
      el.removeEventListener("contextmenu", noMenu);
      for (const t of ["mousedown", "mousemove", "mouseup", "click", "dblclick"]) el.removeEventListener(t, stop);
      gesture.current = GESTURE_IDLE;
    };
  }, []);

  return (
    <div
      ref={ref}
      data-testid="map-3d-surface"
      style={{ position: "absolute", inset: 0, zIndex: 1, touchAction: oneFingerPans ? "none" : "pan-y", cursor: "grab" }}
    />
  );
}
