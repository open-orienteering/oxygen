import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  CLOCK_SKEW_THRESHOLD_MS,
  getClockSkewMs,
  subscribeClockSkew,
} from "../lib/offline/clock-skew";

/**
 * Persistent warning shown when this device's clock is more than 30s off the
 * server's (detected on each successful sync). Times recorded here may be
 * inaccurate.
 */
export function ClockSkewBanner() {
  const { t } = useTranslation("common");
  const skewMs = useSyncExternalStore(
    subscribeClockSkew,
    getClockSkewMs,
    () => 0,
  );

  if (Math.abs(skewMs) < CLOCK_SKEW_THRESHOLD_MS) return null;
  const seconds = Math.round(Math.abs(skewMs) / 1000);

  return (
    <div
      role="alert"
      className="bg-amber-100 border-b border-amber-300 px-4 py-2 text-center text-sm text-amber-900"
    >
      {t("clockSkewWarning", { seconds })}
    </div>
  );
}
