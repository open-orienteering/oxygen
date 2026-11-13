import { Trans, useTranslation } from "react-i18next";
import type { OtherVariantMatch } from "@oxygen/shared";
import { trpc } from "../lib/trpc";
import { useOnlineStatus } from "../hooks/useOnlineStatus";

/**
 * Red exit (F6c, docs/registration-and-readout.md §4f): the punches of a
 * mispunched run validate fully against another variant of the runner's
 * class. One line and one **Accept variant XX** button per match; the
 * accept is a manual desk action (`cardReadout.acceptVariant`), disabled
 * offline because it needs the server.
 */
export function OtherVariantBanner({
  matches,
  runnerId,
  onAccepted,
}: {
  matches: readonly OtherVariantMatch[];
  runnerId: number;
  onAccepted?: () => void;
}) {
  const { t } = useTranslation("race");
  const online = useOnlineStatus();
  const accept = trpc.cardReadout.acceptVariant.useMutation({ onSuccess: () => onAccepted?.() });
  if (matches.length === 0) return null;

  return (
    <div
      data-testid="readout-other-variant"
      className="rounded-xl px-5 py-4 border-2 bg-amber-50 border-amber-300 space-y-2"
    >
      {matches.map((m) => (
        <div key={m.courseId} className="flex items-center justify-between gap-4 flex-wrap">
          <span className="text-sm text-amber-900">
            <Trans
              t={t}
              i18nKey="otherVariantMatch"
              values={{ key: m.variantKey, course: m.courseName }}
              components={{ b: <strong /> }}
            />
          </span>
          <button
            type="button"
            data-testid="readout-accept-variant"
            data-course-id={m.courseId}
            disabled={!online || accept.isPending}
            title={online ? undefined : t("acceptVariantOffline")}
            onClick={() => accept.mutate({ runnerId, courseId: m.courseId })}
            className="shrink-0 px-4 py-1.5 rounded-lg text-sm font-medium bg-amber-600 text-white hover:bg-amber-700 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t("acceptVariant", { key: m.variantKey })}
          </button>
        </div>
      ))}
      {!online && <div className="text-xs text-amber-800">{t("acceptVariantOffline")}</div>}
      {accept.error && (
        <div className="text-xs text-red-700" role="alert">
          {accept.error.message}
        </div>
      )}
    </div>
  );
}
