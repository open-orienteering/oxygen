import { useTranslation } from "react-i18next";
import type { RunnerEventorDiff } from "@oxygen/shared";

/**
 * "Eventor: X" with a one-click "Use Eventor's value", under a field whose
 * value differs from what Eventor last said (docs/system/eventor-sync.md).
 */
export function EventorMarker({
  diff,
  onUse,
  pending,
  error,
}: {
  diff: RunnerEventorDiff;
  onUse: () => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation("runners");
  return (
    <div
      data-testid={`eventor-marker-${diff.field}`}
      className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-sky-700"
    >
      <span>{t("eventorValue", { value: String(diff.eventor ?? "") })}</span>
      <button
        type="button"
        onClick={onUse}
        disabled={pending}
        data-testid={`eventor-use-${diff.field}`}
        className="underline hover:text-sky-900 disabled:opacity-50 cursor-pointer"
      >
        {t("useEventorValue")}
      </button>
      {error && <span className="text-red-600">{t("eventorUseFailed", { message: error })}</span>}
    </div>
  );
}
