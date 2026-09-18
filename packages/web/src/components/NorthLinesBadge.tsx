import { useTranslation } from "react-i18next";
import { northLinesState } from "../lib/north-lines";

type Props = {
  stalenessDeg: number | null | undefined;
  /** Render the compact pill (lists) instead of the sentence (panels). */
  compact?: boolean;
  /** Hide the "matches" state — lists only need to see problems. */
  hideCurrent?: boolean;
  className?: string;
};

/**
 * Status of the OCAD file's drawn magnetic-north lines relative to
 * today's declination. Informational: the georeference itself is never
 * in question, only whether the compass lines on paper have aged.
 */
export function NorthLinesBadge({
  stalenessDeg,
  compact = false,
  hideCurrent = false,
  className = "",
}: Props) {
  const { t } = useTranslation("library");
  const state = northLinesState(stalenessDeg);
  if (state.kind === "none") return null;
  if (state.kind === "current" && hideCurrent) return null;

  const stale = state.kind === "stale";
  const tone = stale
    ? "bg-amber-50 text-amber-800 border-amber-200"
    : "bg-emerald-50 text-emerald-800 border-emerald-200";
  const label = stale
    ? compact
      ? t("northLinesStaleShort", { degrees: state.degrees })
      : t("northLinesStale", { degrees: state.degrees })
    : compact
      ? t("northLines", { degrees: state.degrees })
      : t("northLinesCurrent");

  return (
    <span
      data-testid="north-lines-badge"
      data-north-lines={state.kind}
      data-north-lines-degrees={state.degrees}
      title={t("northLines", { degrees: state.degrees })}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${tone} ${className}`}
    >
      {stale && (
        <svg
          aria-hidden="true"
          className="h-3 w-3"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
            clipRule="evenodd"
          />
        </svg>
      )}
      {label}
    </span>
  );
}
