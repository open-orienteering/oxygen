import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { useCapabilities } from "../context/CapabilitiesContext";
import type { MapPipeline } from "../lib/map-pipeline";

/**
 * **Use new map engine** — the event's map pipeline switch in the course
 * editor's map-info row (docs/map-pipeline-switch.md §4). Flips
 * `events.map_pipeline`; gates reads only. While `allowLegacy` it carries a
 * one-line note on where to report problems; once legacy is withdrawn a
 * `vector` event has nothing to switch back to and the toggle is gone.
 */
export function MapEngineToggle({ pipeline, allowLegacy }: { pipeline: MapPipeline; allowLegacy: boolean }) {
  const { t } = useTranslation("dashboard");
  const { has } = useCapabilities();
  const utils = trpc.useUtils();
  // Optimistic: every map of the event follows the switch at once; a refusal puts it back.
  const setPipeline = trpc.event.setMapPipeline.useMutation({
    onMutate: ({ pipeline: next }) => {
      const previous = utils.event.mapPipeline.getData();
      utils.event.mapPipeline.setData(undefined, { pipeline: next, allowLegacy });
      return { previous };
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.previous) utils.event.mapPipeline.setData(undefined, ctx.previous);
    },
    onSuccess: (data) => utils.event.mapPipeline.setData(undefined, data),
  });
  if (!has("courses.edit")) return null;
  if (!allowLegacy && pipeline === "vector") return null;

  return (
    <div data-testid="map-engine-toggle" className="flex flex-col text-xs text-slate-500">
      <label className="flex items-center gap-1.5 cursor-pointer" title={t("mapEngineHelp")}>
        <input
          type="checkbox"
          checked={pipeline === "vector"}
          disabled={setPipeline.isPending}
          onChange={(e) => setPipeline.mutate({ pipeline: e.target.checked ? "vector" : "legacy" })}
        />
        <span className="text-slate-700">{t("mapEngineToggle")}</span>
      </label>
      <span>{t("mapEngineHelp")}</span>
      {allowLegacy && <span data-testid="map-engine-report">{t("mapEngineReport")}</span>}
      {setPipeline.isError && (
        <span data-testid="map-engine-error" className="text-red-600">
          {t("mapEngineSwitchFailed")} {setPipeline.error.message}
        </span>
      )}
    </div>
  );
}
