import { useTranslation } from "react-i18next";
import { timeAgoParts } from "../lib/format";

/** i18n-aware relative time formatter. Returns a function like timeAgo() but translated. */
export function useTimeAgo() {
  const { t } = useTranslation();
  return (input: Date | string | number): string => {
    const { key, count } = timeAgoParts(input);
    return (t as (k: string, opts: { count: number }) => string)(
      `timeAgo_${key}`,
      { count },
    );
  };
}
