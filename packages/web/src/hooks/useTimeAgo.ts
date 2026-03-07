import { useTranslation } from "react-i18next";
import { timeAgoParts } from "../lib/format";

/** i18n-aware relative time formatter. Returns a function like timeAgo() but translated. */
export function useTimeAgo() {
  const { t } = useTranslation();
  return (input: Date | string | number): string => {
    const { key, count } = timeAgoParts(input);
    return t(`timeAgo_${key}` as any, { count });
  };
}
