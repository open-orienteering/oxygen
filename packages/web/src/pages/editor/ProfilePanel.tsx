/**
 * The course's elevation profile under the map (docs/course-elevation.md
 * §5): height against distance along the course, the controls as
 * vertical marks, the selected leg shaded. The pointer reads a place —
 * a crosshair, its distance, height and leg, and a dot on the map
 * (`onHover`) — and a click selects the leg under it. Plain SVG over
 * `lib/editor/profile-graph.ts`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CourseProfile } from "@oxygen/shared/src/terrain/profile/index.js";
import { shownM } from "../../lib/editor/elevation";
import { boundLabels, decimate, graphPaths, graphScale, heightAtDistance, legAt, legBounds, profilePoints } from "../../lib/editor/profile-graph";

export const PROFILE_PANEL_HEIGHT = 144;
const PLOT_HEIGHT = 104;
const BOX = { left: 40, right: 12, top: 18, bottom: 20 };
/** The course overprint's purple (the line is the course's). */
const LINE = "#a21caf";

export interface ProfilePanelProps {
  profile: CourseProfile;
  /** `relative`: heights are shown above the course's lowest point; `absolute`: as the field states them. */
  datum: "relative" | "absolute";
  basis: "ground" | "contours";
  /** Each leg by its ends' codes ("31 → 32"). */
  legLabels: readonly string[];
  /** The control marks' labels, `legs + 1` of them (S, 1, 2 … F). */
  boundLabels: readonly string[];
  selectedLeg: number | null;
  /** The place under the pointer, metres along the course; null when it leaves. */
  onHover: (dM: number | null) => void;
  onSelectLeg: (leg: number, dM: number) => void;
  onClose: () => void;
}

export function ProfilePanel(p: ProfilePanelProps) {
  const { t } = useTranslation("editor");
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const model = useMemo(() => {
    const raw = profilePoints(p.profile);
    let base = 0;
    if (p.datum === "relative") {
      base = Infinity;
      for (const q of raw) if (q.zM !== null) base = Math.min(base, q.zM);
      if (!Number.isFinite(base)) base = 0;
    }
    const points = base === 0 ? raw : raw.map((q) => (q.zM === null ? q : { ...q, zM: q.zM - base }));
    return { points, bounds: legBounds(p.profile) };
  }, [p.profile, p.datum]);

  const drawn = useMemo(() => {
    if (width <= BOX.left + BOX.right + 20) return null;
    const box = { width, height: PLOT_HEIGHT, ...BOX };
    const scale = graphScale(model.points, p.profile.lengthM, box);
    const baseline = PLOT_HEIGHT - BOX.bottom;
    const paths = graphPaths(decimate(model.points, p.profile.lengthM, Math.floor(width - BOX.left - BOX.right)), scale, baseline);
    return { scale, baseline, paths, labels: new Set(boundLabels(model.bounds, scale.x)) };
  }, [model, width, p.profile.lengthM]);

  const onHover = p.onHover;
  useEffect(() => () => onHover(null), [onHover]);

  const at = (e: React.PointerEvent | React.MouseEvent): number | null => {
    if (!drawn || !wrap.current) return null;
    return drawn.scale.dAt(e.clientX - wrap.current.getBoundingClientRect().left);
  };
  const km = (m: number) => (m / 1000).toFixed(2);
  const hoverZ = hover === null ? null : heightAtDistance(model.points, hover);
  const hoverLeg = hover === null ? null : legAt(model.bounds, hover);
  const sel = p.selectedLeg !== null && p.selectedLeg < model.bounds.length - 1 ? p.selectedLeg : null;

  return (
    <section data-testid="editor-profile" data-basis={p.basis} data-datum={p.datum} data-length-m={Math.round(p.profile.lengthM)}
      aria-label={t("profileTitle")} style={{ height: PROFILE_PANEL_HEIGHT }}
      className="relative z-[9] shrink-0 border-t border-slate-200 bg-white text-slate-700 flex flex-col">
      <header className="flex items-baseline gap-3 px-3 pt-1.5 text-xs">
        <h2 className="font-medium text-slate-700">{t("profileTitle")}</h2>
        <span data-testid="editor-profile-summary" className="text-slate-500 tabular-nums">
          {t("profileSummary", { km: (p.profile.lengthM / 1000).toFixed(1), up: shownM(p.profile.climbM), down: shownM(p.profile.descentM) })}
        </span>
        <span className="text-[10px] text-slate-400">{t(p.datum === "relative" ? "profileAxisRelative" : "profileAxisAbsolute")}</span>
        {p.basis === "contours" && <span data-testid="editor-profile-note" className="text-[10px] text-slate-400">{t("elevationContoursNote")}</span>}
        <button type="button" data-testid="editor-profile-close" aria-label={t("profileClose")} title={t("profileClose")} onClick={p.onClose}
          className="ml-auto px-1 text-slate-400 hover:text-slate-700 cursor-pointer">✕</button>
      </header>
      <div ref={wrap} className="relative flex-1 min-h-0 select-none">
        {drawn && (
          <svg data-testid="editor-profile-graph" width={width} height={PLOT_HEIGHT} role="img" aria-label={t("profileTitle")}
            className="block cursor-crosshair"
            onPointerMove={(e) => { const d = at(e); setHover(d); p.onHover(d); }}
            onPointerLeave={() => { setHover(null); p.onHover(null); }}
            onClick={(e) => { const d = at(e); if (d !== null) p.onSelectLeg(legAt(model.bounds, d), d); }}>
            {/* The selected leg. */}
            {sel !== null && (
              <rect data-testid="editor-profile-selected" data-leg={sel} x={drawn.scale.x(model.bounds[sel])} y={BOX.top}
                width={Math.max(1, drawn.scale.x(model.bounds[sel + 1]) - drawn.scale.x(model.bounds[sel]))} height={drawn.baseline - BOX.top} fill={LINE} opacity={0.08} />
            )}
            {/* Grid and the height axis: recessive. */}
            {drawn.scale.zTicks.map((z) => (
              <g key={`z${z}`}>
                <line x1={BOX.left} x2={width - BOX.right} y1={drawn.scale.y(z)} y2={drawn.scale.y(z)} stroke="#e2e8f0" strokeWidth={1} />
                <text x={BOX.left - 6} y={drawn.scale.y(z) + 3} textAnchor="end" fontSize={10} fill="#64748b" className="tabular-nums">{z}</text>
              </g>
            ))}
            {drawn.scale.dTicks.map((d) => (
              <text key={`d${d}`} x={drawn.scale.x(d)} y={PLOT_HEIGHT - 6} textAnchor={d === 0 ? "start" : "middle"} fontSize={10} fill="#64748b" className="tabular-nums">
                {d === 0 ? "0" : t("profileKm", { km: (d / 1000).toFixed(d % 1000 === 0 ? 0 : 1) })}
              </text>
            ))}
            {/* The controls. */}
            {model.bounds.map((d, i) => (
              <g key={`b${i}`} data-testid="editor-profile-control" data-index={i} data-d={Math.round(d)}>
                <line x1={drawn.scale.x(d)} x2={drawn.scale.x(d)} y1={BOX.top} y2={drawn.baseline} stroke="#cbd5e1" strokeWidth={1} strokeDasharray="2 3" />
                {drawn.labels.has(i) && (
                  <text x={drawn.scale.x(d)} y={BOX.top - 6} textAnchor="middle" fontSize={10} fill="#475569">{p.boundLabels[i] ?? ""}</text>
                )}
              </g>
            ))}
            <path d={drawn.paths.area} fill={LINE} opacity={0.12} />
            <path data-testid="editor-profile-line" d={drawn.paths.line} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <line x1={BOX.left} x2={width - BOX.right} y1={drawn.baseline} y2={drawn.baseline} stroke="#94a3b8" strokeWidth={1} />
            {hover !== null && (
              <g pointerEvents="none">
                <line data-testid="editor-profile-crosshair" x1={drawn.scale.x(hover)} x2={drawn.scale.x(hover)} y1={BOX.top} y2={drawn.baseline} stroke="#475569" strokeWidth={1} />
                {hoverZ !== null && <circle cx={drawn.scale.x(hover)} cy={drawn.scale.y(hoverZ)} r={4} fill={LINE} stroke="#fff" strokeWidth={2} />}
              </g>
            )}
          </svg>
        )}
        {drawn && hover !== null && hoverLeg !== null && (
          <div data-testid="editor-profile-tooltip" data-d={Math.round(hover)} data-leg={hoverLeg} data-z={hoverZ === null ? "" : Math.round(hoverZ)}
            className="pointer-events-none absolute top-5 z-10 whitespace-nowrap rounded-md border border-slate-200 bg-white/95 px-2 py-1 text-[11px] text-slate-700 shadow-sm tabular-nums"
            style={drawn.scale.x(hover) > width / 2 ? { right: width - drawn.scale.x(hover) + 10 } : { left: drawn.scale.x(hover) + 10 }}>
            <div className="font-medium">{hoverZ === null ? t("profileNoData") : t("profileHeight", { m: Math.round(hoverZ) + 0 })}</div>
            <div className="text-slate-500">{t("profileAt", { km: km(hover) })} · {t("legTitle", { leg: p.legLabels[hoverLeg] ?? String(hoverLeg + 1) })}</div>
          </div>
        )}
      </div>
    </section>
  );
}
