/**
 * The review page's **Colour layers** panel (docs/map-symbols.md §8.7
 * "Colour layers", §9.3 answers 1–3): the switch between the IOF order and
 * the map's own order, a before / after picture of the map in both, the
 * layers top first with the map's colour, the IOF layer, the object count
 * and flags, and every deviation kept or dropped with its default. Each
 * deviation row can be kept or dropped for this map, or reset to its
 * default (row I7, §9.3 "Overrides (row I7)"). **Compare** opens the
 * live compare view (row I8a, §8.7 "Compare").
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@oxygen/api";
import { scopePreviewUrl } from "../../lib/map-review";
import { canSwitchOrder, chosenOrder, deviationControls, deviationSummary, layerLabel, layersTopFirst, orderedFlags, retryUrl, type ColourOrder, type DeviationChoice } from "../../lib/map-review-colours";

type ColourReview = inferRouterOutputs<AppRouter>["mapImport"]["review"]["colour"];

const ORDERS: ColourOrder[] = ["iof", "source"];

/** A picture answers 503 while the other order is imported: try again every few seconds, for a while. */
const PICTURE_RETRY_MS = 5_000;
const PICTURE_RETRIES = 36;

function Picture({ url, order, current }: { url: string; order: ColourOrder; current: boolean }) {
  const { t } = useTranslation("mapReview");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  const onError = () => {
    if (attempt >= PICTURE_RETRIES) {
      setState("failed");
      return;
    }
    window.setTimeout(() => setAttempt((a) => a + 1), PICTURE_RETRY_MS);
  };
  return (
    <figure className="flex-1 min-w-[12rem] max-w-[30rem]">
      <figcaption className="text-xs text-slate-600 mb-1">
        {t(`colours.picture.${order}`)}
        {current && <span className="text-slate-400"> · {t("colours.picture.current")}</span>}
      </figcaption>
      <div className="border border-slate-200 rounded bg-white min-h-[6rem] flex items-center justify-center">
        {state === "failed" ? (
          <span className="text-xs text-red-700">{t("colours.picture.failed")}</span>
        ) : (
          <>
            <img
              key={attempt}
              data-testid={`colour-picture-${order}`}
              data-loaded={state === "loaded" ? "true" : "false"}
              src={retryUrl(url, attempt)}
              alt={t(`colours.picture.${order}`)}
              className={`w-full h-auto ${state === "loaded" ? "" : "hidden"}`}
              onLoad={() => setState("loaded")}
              onError={onError}
            />
            {state !== "loaded" && <span className="text-xs text-slate-500 py-8">{t("colours.picture.loading")}</span>}
          </>
        )}
      </div>
    </figure>
  );
}

const FLAG_STYLE: Record<string, string> = {
  split: "bg-indigo-50 text-indigo-800",
  "deviation-kept": "bg-amber-50 text-amber-800",
  "deviation-dropped": "bg-slate-100 text-slate-700",
  "source-ordered": "bg-slate-100 text-slate-700",
  "no-role": "bg-orange-50 text-orange-800",
  "own-order": "bg-slate-100 text-slate-700",
  "above-lower-purple": "bg-red-50 text-red-800",
  "draws-nothing": "bg-slate-50 text-slate-500",
};

export function ColourLayersPanel({
  colour,
  nameId,
  canEdit,
  busy,
  hasTarget,
  onSwitch,
  onDeviation,
  onCompare,
}: {
  colour: ColourReview;
  /** The event's name id on the event route: picture URLs are scoped with `?event=`. */
  nameId: string | null;
  canEdit: boolean;
  busy: boolean;
  /** The review is for a map (an event, or a club route with its series). */
  hasTarget: boolean;
  onSwitch: (order: ColourOrder) => void;
  /** Keep or drop a deviation for this map, or `default` to reset it (row I7). */
  onDeviation: (key: string, choice: DeviationChoice | "default") => void;
  /** Open the compare view (row I8a, §8.7 "Compare"). */
  onCompare?: () => void;
}) {
  const { t } = useTranslation("mapReview");
  const chosen = chosenOrder(colour);
  const enabled = canSwitchOrder({ canEdit, busy, hasTarget });
  const layers = colour.layers ? layersTopFirst(colour.layers) : null;
  const summary = deviationSummary(colour.deviations);

  return (
    <section
      data-testid="review-colours"
      data-order={colour.order}
      data-setting={colour.setting?.order ?? ""}
      className="bg-white rounded-xl border border-slate-200 p-4 mb-4 space-y-4 text-sm"
    >
      <div>
        <h2 className="font-semibold text-slate-900">{t("colours.title")}</h2>
        <p className="text-slate-600 mt-1">{t("colours.hint")}</p>
      </div>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-slate-700">{t("colours.order.label")}</span>
          <div role="group" aria-label={t("colours.order.label")} className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
            {ORDERS.map((o) => (
              <button
                key={o}
                type="button"
                data-testid={`colour-order-${o}`}
                aria-pressed={chosen === o}
                // The chosen order stays pressable while this version is drawn in the other one: it builds that version.
                disabled={!enabled || (chosen === o && colour.order === o)}
                className={`px-3 py-1 text-sm cursor-pointer disabled:cursor-default ${
                  chosen === o ? "bg-blue-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                }`}
                onClick={() => onSwitch(o)}
              >
                {t(`colours.order.${o}`)}
              </button>
            ))}
          </div>
        </div>
        {canEdit && hasTarget && <p className="text-xs text-slate-500">{t("colours.orderHint")}</p>}
        {canEdit && !hasTarget && <p className="text-xs text-slate-500">{t("colours.orderClubOnly")}</p>}
        {colour.setting && colour.setting.order !== colour.order && !colour.fallback && (
          <p data-testid="colour-setting-differs" className="text-amber-800">
            {t(`colours.settingDiffers_${colour.setting.order}`)}
          </p>
        )}
        {colour.fallback && <p className="text-amber-800">{t("colours.fallback")}</p>}
      </div>

      <div>
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <h3 className="font-medium text-slate-800">{t("colours.picture.title")}</h3>
          {onCompare && (
            <button
              type="button"
              data-testid="colour-compare"
              title={t("colours.compare.openHint")}
              className="rounded border border-blue-600 px-2 py-0.5 text-xs font-medium text-blue-700 cursor-pointer hover:bg-blue-50"
              onClick={onCompare}
            >
              {t("colours.compare.open")}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-3">
          {ORDERS.map((o) => (
            // Keyed by the URL: a new document starts the picture over (its retry count and state).
            <Picture key={colour.pictures[o]} order={o} current={colour.order === o} url={scopePreviewUrl(colour.pictures[o], nameId) ?? colour.pictures[o]} />
          ))}
        </div>
      </div>

      <div>
        <h3 className="font-medium text-slate-800 mb-1">{t("colours.layers.title")}</h3>
        {layers ? (
          <table data-testid="colour-layers" className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1 pr-2 font-normal">{t("colours.layers.colour")}</th>
                <th className="py-1 pr-2 font-normal">{t("colours.layers.role")}</th>
                <th className="py-1 pr-2 font-normal text-right">{t("colours.layers.objects")}</th>
                <th className="py-1 font-normal">{t("colours.layers.flags")}</th>
              </tr>
            </thead>
            <tbody>
              {layers.map((l) => {
                const label = layerLabel(l);
                return (
                  <tr
                    key={l.row}
                    data-testid="colour-layer-row"
                    data-row={l.row}
                    data-role={l.role ?? ""}
                    data-place={l.place ?? ""}
                    data-flags={l.flags.join(" ")}
                    className="border-t border-slate-100 align-top"
                  >
                    <td className="py-1 pr-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block w-4 h-4 rounded border border-slate-300 shrink-0" style={{ backgroundColor: l.hex }} />
                        <span className="text-slate-800">{l.name}</span>
                        {l.sourceNumber !== null ? <span className="text-slate-400">#{l.sourceNumber}</span> : <span className="text-slate-400">({t("colours.layers.inserted")})</span>}
                      </span>
                    </td>
                    <td className="py-1 pr-2 text-slate-700">{label.kind === "role" ? label.name : <span className="italic">{t(label.key)}</span>}</td>
                    <td className="py-1 pr-2 text-right tabular-nums text-slate-700">{l.objects}</td>
                    <td className="py-1">
                      <span className="flex flex-wrap gap-1">
                        {orderedFlags(l.flags).map((f) => (
                          <span key={f} data-flag={f} className={`px-1.5 py-0.5 rounded ${FLAG_STYLE[f] ?? "bg-slate-100 text-slate-700"}`}>
                            {t(`colours.flag.${f}`)}
                          </span>
                        ))}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p data-testid="colour-layers-none" className="text-slate-600">{t("colours.layers.noLayers")}</p>
        )}
      </div>

      {layers && (
        <div>
          <h3 className="font-medium text-slate-800">
            {t("colours.deviations.title")}{" "}
            <span data-testid="colour-deviations-summary" className="font-normal text-slate-500">
              ({t("colours.deviations.summary", { count: summary.count, kept: summary.kept })})
            </span>
          </h3>
          <p className="text-xs text-slate-500 mb-1">{t("colours.deviations.hint")}</p>
          {colour.deviations.length === 0 ? (
            <p className="text-slate-600">{t("colours.deviations.none")}</p>
          ) : (
            <ul className="space-y-1">
              {colour.deviations.map((d) => {
                const controls = deviationControls(d, { canEdit, busy, hasTarget });
                return (
                <li
                  key={d.key}
                  data-testid="colour-deviation"
                  data-key={d.key}
                  data-kept={d.kept ? "true" : "false"}
                  data-default={d.default}
                  data-why={d.why}
                  data-choice={d.choice ?? ""}
                  data-overridden={d.overridden ? "true" : "false"}
                  className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-1"
                >
                  <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${d.kept ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"}`}>
                    {d.kept ? t("colours.deviations.kept") : t("colours.deviations.dropped")}
                  </span>
                  <span className="text-slate-800">{t("colours.deviations.pair", { upper: d.upperName, lower: d.lowerName })}</span>
                  <span className="text-xs text-slate-500">
                    {t(`colours.deviations.why.${d.why}`)} · {t(`colours.deviations.default.${d.default}`)} · {t("colours.deviations.objects", { upper: d.objects.upper, lower: d.objects.lower })}
                  </span>
                  {d.overridden && (
                    <span data-testid="colour-deviation-overridden" className="px-1.5 py-0.5 rounded text-xs bg-blue-50 text-blue-800">
                      {t(`colours.deviations.overridden.${d.choice ?? d.default}`)}
                    </span>
                  )}
                  {canEdit && hasTarget && (
                    <span className="ml-auto inline-flex items-center gap-2">
                      <span role="group" aria-label={t("colours.deviations.choose", { upper: d.upperName, lower: d.lowerName })} className="inline-flex rounded border border-slate-300 overflow-hidden text-xs">
                        {(["keep", "drop"] as const).map((c) => (
                          <button
                            key={c}
                            type="button"
                            data-testid={`colour-deviation-${c}`}
                            aria-pressed={controls[c].pressed}
                            disabled={controls[c].disabled}
                            className={`px-2 py-0.5 cursor-pointer disabled:cursor-default ${
                              controls[c].pressed ? "bg-blue-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                            }`}
                            onClick={() => onDeviation(d.key, c)}
                          >
                            {t(`colours.deviations.${c}`)}
                          </button>
                        ))}
                      </span>
                      {controls.reset.shown && (
                        <button
                          type="button"
                          data-testid="colour-deviation-reset"
                          disabled={controls.reset.disabled}
                          className="text-xs underline text-slate-600 cursor-pointer disabled:opacity-50 disabled:cursor-default"
                          onClick={() => onDeviation(d.key, "default")}
                        >
                          {t("colours.deviations.reset")}
                        </button>
                      )}
                    </span>
                  )}
                </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
