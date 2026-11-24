/**
 * The inspector's *Leg* section (docs/course-editor.md §6.7; 08 §5.2
 * "leg: style, gaps, corridor, crossing"): the selected leg's style, its
 * bends, its corridor and the crossing point it runs through (§6.8). Every change is one patch of the item's
 * `LegProps` (`setLegProps`), one `setStructure`, one undo entry; the page
 * writes. Invalid numbers are not written. On a phone the section is
 * read-only and says so (08 §5.5 "desktop-only by design").
 */

import { useTranslation } from "react-i18next";
import type { course } from "@oxygen/shared";
import type { LegElevation } from "../../../lib/editor/elevation";
import type { RouteItem } from "../../../lib/editor/leg-routes";
import type { CostModelNote } from "@oxygen/shared/src/route/index.js";
import { alternativeColor, formatClock, type AlternativeItem } from "../../../lib/editor/leg-alternatives";
import { DEFAULT_CORRIDOR, type LegPatch } from "../../../lib/editor/structure-edit";

/** The wire form's leg: `crossing.controlId` is a public id (course-layer.md §6.1). */
type LegProps = course.WireLegProps;
type Corridor = NonNullable<LegProps["corridor"]>;


const FIELD = "mt-0.5 w-full px-1.5 py-1 rounded-md border border-slate-200 bg-white text-xs disabled:bg-slate-50 disabled:text-slate-400";
const BUTTON = "px-2 py-0.5 rounded-md border text-xs cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";

export interface LegSectionProps {
  /** "31 → 32": the leg's ends by code. */
  title: string;
  leg: LegProps;
  /** The crossing point's code (`leg.crossing`), or null without one. */
  crossingCode?: string | null;
  /** The leg's length and heights along its line (docs/course-elevation.md §4.5); null or absent: not shown. */
  elevation?: LegElevation | null;
  /** The leg's routes (docs/course-elevation.md §7.4); null or absent: no Routes block. */
  routes?: LegRoutesProps | null;
  focusedBend: number | null;
  /** What can be done with the leg (docs/course-editor.md §6.7): in the section, never over the map; null: none (a phone). */
  actions?: { onAddBend: (corner: boolean) => void; onInsert: () => void; onVariation: (() => void) | null } | null;
  /** A phone: everything shown, nothing editable. */
  readOnly: boolean;
  onPatch: (patch: LegPatch) => void;
  onFocusBend: (index: number | null) => void;
  /** The focused bend's **Smooth** / **Corner** (F16; the tablet's Alt-click): one write. */
  onBendKind: (index: number, kind: "smooth" | "corner") => void;
}

/** The Routes block (docs/course-elevation.md §7.4): the drawn line and the pair's routes, one of them chosen. */
export interface LegRoutesProps {
  items: readonly RouteItem[];
  /** A route is being drawn: its vertices so far. */
  drawing: { points: number } | null;
  /** A write is under way. */
  busy: boolean;
  /** The pair's automatic route is the drawn line itself (§7.5). */
  lineIsShortest: boolean;
  onDraw: () => void;
  onDone: () => void;
  onCancel: () => void;
  /** `id` null: the drawn line (no route chosen). */
  onChoose: (id: string | null) => void;
  onDelete: (id: string) => void;
  /** Computed alternatives (§7.8); null: the map cannot be searched (no document loaded). */
  alternatives: LegAlternativesProps | null;
}

export interface LegAlternativesProps {
  status: "idle" | "running" | "done" | "error";
  items: readonly AlternativeItem[];
  /** Search again (the search itself starts when the leg is selected, §7.8). */
  onFind: () => void;
  /** Store the alternative as the pair's chosen route. */
  onUse: (index: number) => void;
  onPoint: (index: number | null) => void;
  /** The alternative lit on the map (pointed at, or picked by a press). */
  active: number | null;
  onPick: (index: number) => void;
  /** How much of the speed model is measured from tracks (§7.9), and on which terrain. */
  measured: Pick<CostModelNote, "state" | "classes">;
}

function LegAlternatives({ a, locked }: { a: LegAlternativesProps; locked: boolean }) {
  const { t } = useTranslation("editor");
  return (
    <div data-testid="editor-leg-alternatives" data-status={a.status} className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-slate-500">{t("legAlternatives")}</span>
        {a.status === "running" && <span data-testid="editor-leg-alternatives-searching" className="text-[10px] text-slate-400">{t("legAlternativesSearching")}</span>}
        <button type="button" data-testid="editor-leg-alternatives-find" aria-label={t("legAlternativesFind")} title={t("legAlternativesFind")} disabled={locked || a.status === "running"} onClick={a.onFind}
          className="ml-auto px-1 text-slate-400 hover:text-orange-700 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">↻</button>
      </div>
      {a.status === "error" && <p data-testid="editor-leg-alternatives-error" className="text-[10px] text-red-600">{t("legAlternativesError")}</p>}
      {a.status === "done" && a.items.length === 0 && <p data-testid="editor-leg-alternatives-none" className="text-[10px] text-amber-700">{t("legAlternativesNone")}</p>}
      {a.status === "done" && a.items.length > 0 && (
          <ul className="space-y-0.5">
            {a.items.map((item) => (
              <li key={item.index} data-testid="editor-leg-alternative" data-kind={item.kind} data-m={item.lengthM} data-climb={item.climbM ?? ""} data-time={item.timeS ?? ""}
                data-active={a.active === item.index ? "true" : "false"}
                onMouseEnter={() => a.onPoint(item.index)} onMouseLeave={() => a.onPoint(null)} onClick={() => a.onPick(item.index)}
                className={`flex items-center gap-1.5 rounded px-1 text-[11px] text-slate-600 cursor-pointer ${a.active === item.index ? "bg-slate-100" : "hover:bg-slate-50"}`}>
                <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: alternativeColor(item.index) }} />
                <span className="flex-1">{t(`legAlternativeKind.${item.kind}`)}</span>
                <span className="font-mono text-slate-700">{item.lengthM} m{item.climbM !== null && <> · {item.approx ? "≈ " : ""}{t("legRouteClimb", { m: item.climbM })}</>} {item.timeS !== null && <> · ~{formatClock(item.timeS)}</>}</span>
                <button type="button" data-testid="editor-leg-alternative-use" disabled={locked || item.interior.length === 0} onClick={(e) => { e.stopPropagation(); a.onUse(item.index); }}
                  title={item.interior.length === 0 ? t("legAlternativeIsLine") : undefined}
                  className={`${BUTTON} border-orange-200 text-orange-700 hover:bg-orange-50`}>{t("legAlternativeUse")}</button>
              </li>
            ))}
          </ul>
      )}
    </div>
  );
}

function LegRoutes({ r, readOnly }: { r: LegRoutesProps; readOnly: boolean }) {
  const { t } = useTranslation("editor");
  const locked = readOnly || r.busy || !!r.drawing;
  return (
    <div data-testid="editor-leg-routes" data-drawing={r.drawing ? "true" : "false"} className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-slate-500">{t("legRoutes")}</span>
        {!r.drawing && (
          <button type="button" data-testid="editor-leg-route-draw" disabled={readOnly || r.busy} onClick={r.onDraw}
            className={`${BUTTON} ml-auto border-cyan-200 text-cyan-700 hover:bg-cyan-50`}>{t("legRouteDraw")}</button>
        )}
      </div>
      <ul className="space-y-0.5">
        {r.items.map((item) => (
          <li key={item.id ?? "line"} data-testid="editor-leg-route" data-id={item.id ?? "line"} data-source={item.source} data-chosen={item.chosen ? "true" : "false"}
            data-m={item.lengthM} data-climb={item.climbM ?? ""} className={`flex items-center gap-1.5 rounded px-1 ${item.chosen ? "bg-cyan-50" : ""}`}>
            <label className="flex flex-1 items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer">
              <input type="radio" name="editor-leg-route" data-testid="editor-leg-route-choose" checked={item.chosen} disabled={locked} onChange={() => r.onChoose(item.id)} />
              <span className="flex-1">{t(item.source === "line" ? (r.lineIsShortest ? "legRouteLineShortest" : "legRouteLine") : item.source === "auto" ? "legRouteAuto" : item.source === "computed" ? "legRouteComputed" : "legRouteDrawn")}</span>
              <span className="font-mono text-slate-700">{item.lengthM} m{item.climbM !== null && <> · {item.approx ? "≈ " : ""}{t("legRouteClimb", { m: item.climbM })}</>}</span>
            </label>
            {item.id !== null && item.source !== "auto" && (
              <button type="button" data-testid="editor-leg-route-remove" aria-label={t("legRouteRemove")} title={t("legRouteRemove")} disabled={locked}
                onClick={() => r.onDelete(item.id!)} className="px-1 text-slate-400 hover:text-red-600 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">✕</button>
            )}
          </li>
        ))}
      </ul>
      {r.drawing ? (
        <div className="space-y-1">
          <p data-testid="editor-leg-route-drawing" data-points={r.drawing.points} className="text-[10px] text-cyan-700">{t("legRouteDrawing", { count: r.drawing.points })}</p>
          <div className="flex gap-1.5">
            <button type="button" data-testid="editor-leg-route-done" disabled={r.drawing.points === 0 || r.busy} onClick={r.onDone}
              className={`${BUTTON} border-cyan-200 bg-cyan-600 text-white hover:bg-cyan-700`}>{t("legRouteDone")}</button>
            <button type="button" data-testid="editor-leg-route-cancel" onClick={r.onCancel} className={`${BUTTON} border-slate-200 text-slate-600 hover:bg-slate-50`}>{t("legRouteCancel")}</button>
          </div>
        </div>
      ) : null}
      {r.alternatives && !r.drawing && !readOnly && <LegAlternatives a={r.alternatives} locked={r.busy} />}
    </div>
  );
}

/** A number field committed on blur (or Enter) when `valid`; otherwise the stored value comes back. */
function NumberField(p: { testId: string; label: string; value: number; step: number; min?: number; max?: number; disabled: boolean; valid: (v: number) => boolean; onCommit: (v: number) => void }) {
  return (
    <label className="block text-[11px] text-slate-500">{p.label}
      <input data-testid={p.testId} type="number" step={p.step} min={p.min} max={p.max} className={FIELD} disabled={p.disabled}
        defaultValue={p.value} key={p.value}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(v) && p.valid(v)) { if (v !== p.value) p.onCommit(v); }
          else e.target.value = String(p.value);
        }} />
    </label>
  );
}

/** The leg's numbers (docs/course-elevation.md §4.5): read-only; a dash where the leg has no data. */
function LegNumbers({ e }: { e: LegElevation }) {
  const { t } = useTranslation("editor");
  const approx = e.approx ? "≈ " : "";
  const cell = (testId: string, label: string, m: number | null, text: string) => (
    <div data-testid={testId} data-m={m ?? ""}>
      <dt className="text-[10px] text-slate-400">{label}</dt>
      <dd className="font-mono text-[11px] text-slate-700">{m === null ? "–" : text}</dd>
    </div>
  );
  const signed = (m: number) => `${m > 0 ? "+" : m < 0 ? "−" : ""}${Math.abs(m)} m`;
  return (
    <div data-testid="editor-leg-elevation" data-basis={e.basis} data-approx={e.approx ? "true" : "false"} data-routed={e.routed ? "true" : "false"}>
      <dl className="grid grid-cols-4 gap-x-2">
        {cell("editor-leg-length", t(e.routed ? "legRouteLength" : "legLength"), e.lengthM, `${e.lengthM} m`)}
        {cell("editor-leg-climb", t("legClimb"), e.climbM, `${approx}${e.climbM} m`)}
        {cell("editor-leg-descent", t("legDescent"), e.descentM, `${approx}${e.descentM} m`)}
        {cell("editor-leg-net", t("legNet"), e.netM, e.netM === null ? "" : signed(e.netM))}
      </dl>
    </div>
  );
}

export function LegSection(p: LegSectionProps) {
  const { t } = useTranslation("editor");
  const { leg, readOnly } = p;
  const bends = leg.bends ?? [];
  const corridor = leg.corridor;
  const routesShown = !!p.routes && (leg.style ?? "line") !== "marked_route";
  const setCorridor = (next: Partial<Corridor>) => { if (corridor) p.onPatch({ corridor: { ...corridor, ...next } }); };
  return (
    <div data-testid="editor-leg" data-readonly={readOnly ? "true" : "false"} className="px-2.5 py-1.5 space-y-2">
      <div className="font-medium text-slate-700">{t("legTitle", { leg: p.title })}</div>
      {readOnly && <p data-testid="editor-leg-readonly" className="text-[11px] text-amber-700">{t("legReadOnly")}</p>}
      {p.actions && (
        <div data-testid="editor-leg-actions" className="flex flex-wrap gap-1.5">
          <button type="button" data-testid="editor-leg-add-bend" title={t("legAddBendTitle")} onClick={(e) => p.actions!.onAddBend(e.altKey)} className={`${BUTTON} border-purple-200 text-purple-700 hover:bg-purple-50`}>{t("legAddBend")}</button>
          <button type="button" data-testid="editor-leg-insert" title={t("legInsertTitle")} onClick={p.actions.onInsert} className={`${BUTTON} border-purple-200 text-purple-700 hover:bg-purple-50`}>{t("legInsert")}</button>
          {p.actions.onVariation && (
            <button type="button" data-testid="editor-leg-variation" onClick={p.actions.onVariation} className={`${BUTTON} border-purple-200 text-purple-700 hover:bg-purple-50`}>{t("actionCreateVariation")}</button>
          )}
        </div>
      )}
      {p.elevation && <LegNumbers e={p.elevation} />}
      {routesShown && <LegRoutes r={p.routes!} readOnly={readOnly} />}

      <label className="block text-[11px] text-slate-500">{t("legStyle")}
        <select data-testid="editor-leg-style" className={FIELD} disabled={readOnly} value={leg.style ?? "line"}
          onChange={(e) => p.onPatch({ style: e.target.value as NonNullable<LegProps["style"]> })}>
          <option value="line">{t("legStyleLine")}</option>
          <option value="marked_route">{t("legStyleMarkedRoute")}</option>
          <option value="none">{t("legStyleNone")}</option>
        </select>
      </label>

      <div>
        <div className="text-[11px] text-slate-500">{t("legBends")}</div>
        {bends.length === 0 ? (
          <p data-testid="editor-leg-bends-empty" className="text-[11px] text-slate-400">{t("legBendsNone")}</p>
        ) : (
          <ul className="space-y-0.5">
            {bends.map((b, i) => {
              const curve = b.hIn || b.hOut ? "smooth" : "corner";
              const focused = p.focusedBend === i;
              return (
              <li key={i} data-testid="editor-leg-bend" data-index={i} data-x={b.x} data-y={b.y} data-curve={curve} data-focused={focused ? "true" : "false"}
                className={`flex items-center gap-1.5 rounded px-1 ${focused ? "bg-purple-50" : ""}`}>
                <button type="button" className="flex-1 text-left font-mono text-[11px] text-slate-600 cursor-pointer" onClick={() => p.onFocusBend(i)}>
                  {i + 1}. {b.x.toFixed(1)}, {b.y.toFixed(1)} mm <span className="text-slate-400">{t(curve === "smooth" ? "legBendSmooth" : "legBendCorner")}</span>
                </button>
                {focused && (
                  <>
                    <button type="button" data-testid="editor-leg-bend-smooth" disabled={readOnly || curve === "smooth"} onClick={() => p.onBendKind(i, "smooth")}
                      className={`${BUTTON} border-purple-200 text-purple-700 hover:bg-purple-50`}>{t("legBendSmooth")}</button>
                    <button type="button" data-testid="editor-leg-bend-corner" disabled={readOnly || curve === "corner"} onClick={() => p.onBendKind(i, "corner")}
                      className={`${BUTTON} border-purple-200 text-purple-700 hover:bg-purple-50`}>{t("legBendCorner")}</button>
                  </>
                )}
                <button type="button" data-testid="editor-leg-bend-remove" aria-label={t("legBendRemove")} title={t("legBendRemove")} disabled={readOnly}
                  onClick={() => p.onPatch({ bends: bends.filter((_, k) => k !== i) })}
                  className="px-1 text-slate-400 hover:text-red-600 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">✕</button>
              </li>
              );
            })}
          </ul>
        )}
      </div>

      <div data-testid="editor-leg-corridor" className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500">{t("legCorridor")}</span>
          {corridor ? (
            <button type="button" data-testid="editor-leg-corridor-remove" disabled={readOnly} onClick={() => p.onPatch({ corridor: undefined })}
              className={`${BUTTON} ml-auto border-red-200 text-red-600 hover:bg-red-50`}>{t("legCorridorRemove")}</button>
          ) : (
            <button type="button" data-testid="editor-leg-corridor-add" disabled={readOnly} onClick={() => p.onPatch({ corridor: DEFAULT_CORRIDOR })}
              className={`${BUTTON} ml-auto border-purple-200 text-purple-700 hover:bg-purple-50`}>{t("legCorridorAdd")}</button>
          )}
        </div>
        {corridor && (
          <div className="grid grid-cols-2 gap-x-2 gap-y-1">
            <NumberField testId="editor-leg-corridor-width" label={t("legCorridorWidth")} value={corridor.widthM} step={5} min={0} disabled={readOnly}
              valid={(v) => v > 0} onCommit={(widthM) => setCorridor({ widthM })} />
            <NumberField testId="editor-leg-corridor-white" label={t("legCorridorWhite")} value={corridor.whiteMm} step={0.5} min={0} disabled={readOnly}
              valid={(v) => v >= 0} onCommit={(whiteMm) => setCorridor({ whiteMm })} />
            {/* J13 (§6.7, course-layer.md §10.2): stored 0–1, shown in %; the most transparent band in view sets every band. */}
            <NumberField testId="editor-leg-corridor-opacity" label={t("legCorridorOpacity")} value={Math.round(corridor.whiteOpacity * 100)} step={5} min={0} max={100} disabled={readOnly}
              valid={(v) => v >= 0 && v <= 100} onCommit={(pct) => setCorridor({ whiteOpacity: Math.round(pct) / 100 })} />
            <label className="flex items-end gap-1.5 pb-1 text-[11px] text-slate-500">
              <input data-testid="editor-leg-corridor-edge" type="checkbox" checked={corridor.edge} disabled={readOnly}
                onChange={(e) => setCorridor({ edge: e.target.checked })} />
              {t("legCorridorEdge")}
            </label>
          </div>
        )}
      </div>

      <div data-testid="editor-leg-crossing" data-site-id={leg.crossing?.controlId ?? ""} className="space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500">{t("legCrossing")}</span>
          {leg.crossing ? (
            <>
              <span data-testid="editor-leg-crossing-code" className="font-mono text-[11px] text-slate-700">{p.crossingCode ?? leg.crossing.controlId}</span>
              <button type="button" data-testid="editor-leg-crossing-remove" disabled={readOnly} onClick={() => p.onPatch({ crossing: undefined })}
                className={`${BUTTON} ml-auto border-red-200 text-red-600 hover:bg-red-50`}>{t("legCrossingRemove")}</button>
            </>
          ) : (
            <span data-testid="editor-leg-crossing-none" className="text-[11px] text-slate-400">{t("legCrossingNone")}</span>
          )}
        </div>
        {leg.crossing && (
          <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <input data-testid="editor-leg-crossing-section" type="checkbox" checked={!!leg.crossing.section} disabled={readOnly}
              onChange={(e) => p.onPatch({ crossing: { controlId: leg.crossing!.controlId, ...(e.target.checked ? { section: true } : {}) } })} />
            {t("legCrossingSection")}
          </label>
        )}
      </div>

      {/* Everything that only explains (docs/course-editor.md §6.7 "Inspector"): one closed disclosure, so the panel is numbers and controls. */}
      <details data-testid="editor-leg-info" className="text-[10px] text-slate-400">
        <summary className="cursor-pointer select-none text-[11px] text-slate-500 hover:text-slate-700">{t("legInfo")}</summary>
        <div className="mt-1 space-y-1">
          {p.elevation?.basis === "contours" && <p data-testid="editor-leg-elevation-note">{t("elevationContoursNote")}</p>}
          {routesShown && <p data-testid="editor-leg-routes-hint">{t("legRoutesHint")}</p>}
          {routesShown && p.routes?.alternatives && (
            <p data-testid="editor-leg-alternatives-note" data-calibrated={p.routes.alternatives.measured.state}>
              {p.routes.alternatives.measured.state === "none" ? t("legAlternativesNote")
                : t(p.routes.alternatives.measured.state === "full" ? "legAlternativesNoteFull" : "legAlternativesNotePartial", { classes: p.routes.alternatives.measured.classes.map((c) => t(`costClass.${c}`)).join(", ") })}
            </p>
          )}
          {!readOnly && <p data-testid="editor-leg-bends-hint">{t(bends.length === 0 ? "legBendsHint" : "legBendsEditHint")}</p>}
          {corridor && (leg.style ?? "line") === "line" && <p data-testid="editor-leg-style-corridor-note">{t("legStyleCorridorNote")}</p>}
          {corridor && !readOnly && <p data-testid="editor-leg-corridor-opacity-hint">{t("legCorridorOpacityHint")}</p>}
        </div>
      </details>
    </div>
  );
}
